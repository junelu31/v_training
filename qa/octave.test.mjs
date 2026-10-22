import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cuesMatching } from './contract.mjs';
import { loadCoach } from './load-coach.mjs';
import { runClip } from './session.mjs';
import { SAMPLE_RATE, mixAtSnr, roadNoise, synthesizeVowel } from './signals.mjs';

function vowel(spec) {
  return synthesizeVowel({
    sampleRate: SAMPLE_RATE,
    f1: 380,
    f2: 2050,
    f3: 3000,
    rmsTarget: 0.08,
    ...spec
  });
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function coachParts() {
  const coach = await loadCoach();
  if (!coach.ok) return coach;
  const dir = dirname(coach.sourceFile);
  const session = await import(pathToFileURL(join(dir, 'drive-session.js')).href);
  const dsp = await import(pathToFileURL(join(dir, 'drive-dsp.js')).href);
  return { ok: true, factory: coach.createDriveSession, session, dsp };
}

function doubledFrames(samples, analyzePcm) {
  const raw = analyzePcm(samples, SAMPLE_RATE, { octave: false });
  const fixed = analyzePcm(samples, SAMPLE_RATE, { octave: true });
  const doubled = [];
  for (let i = 0; i < raw.frames.length; i++) {
    const before = raw.frames[i];
    const after = fixed.frames[i];
    if (!before.voiced || !Number.isFinite(before.hz) || !Number.isFinite(after.hz)) continue;
    const ratio = after.hz / before.hz;
    if (ratio > 1.7 && ratio < 2.3) doubled.push({ from: before.hz, to: after.hz });
  }
  const voiced = fixed.frames.filter(frame => frame.voiced && Number.isFinite(frame.hz));
  const sorted = voiced.map(frame => frame.hz).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  const tail = voiced.slice(Math.floor(voiced.length * 0.75)).map(frame => frame.hz);
  return { doubled, median, tail };
}

test('the live module and the session module are the same spoken reader', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  assert.equal(coach.factory, coach.session.createDriveSession);
  assert.equal(typeof coach.session.readTurn, 'function');
});

test('a steady 100 Hz voice is not folded up to 200 Hz', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const samples = vowel({ f0: 100, f1: 700, f2: 1080, duration: 1.3, seed: 85 });
  const fold = doubledFrames(samples, coach.dsp.analyzePcm);
  assert.equal(fold.doubled.length, 0);
  assert.ok(fold.median > 85 && fold.median < 130, `median ${fold.median}`);
  const run = await runClip(coach.factory, { id: 'sit-100', sampleRate: SAMPLE_RATE, samples });
  assert.equal(run.snapshot.profile, 'masculine');
  assert.deepEqual(run.lines, []);
});

test('a real fall from 205 Hz to 96 Hz stays a drop', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const samples = vowel({ f0: 205, f0End: 96, f1: 380, f2: 2000, duration: 1.4, seed: 87 });
  const fold = doubledFrames(samples, coach.dsp.analyzePcm);
  assert.equal(fold.doubled.length, 0);
  assert.ok(fold.tail.every(hz => hz < 140), `tail ${fold.tail.join(',')}`);
  const run = await runClip(coach.factory, { id: 'long-drop', sampleRate: SAMPLE_RATE, samples });
  assert.deepEqual(run.lines.map(line => cuesMatching(line)[0]), ['pitch-drop-end']);
});

test('a genuine drop to 110 Hz shorter than 8 frames is not folded up', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const samples = concat([
    vowel({ f0: 205, f1: 380, f2: 2000, duration: 1.05, seed: 82 }),
    vowel({ f0: 110, f1: 400, f2: 1900, duration: 0.14, seed: 81 })
  ]);
  const fold = doubledFrames(samples, coach.dsp.analyzePcm);
  const lowTail = fold.tail.filter(hz => hz < 150);
  assert.ok(lowTail.length > 0 && lowTail.length < 8, `low tail frames ${lowTail.length}: ${fold.tail.join(',')}`);
  assert.equal(fold.doubled.length, 0);
  const run = await runClip(coach.factory, { id: 'short-drop', sampleRate: SAMPLE_RATE, samples });
  assert.deepEqual(run.lines, []);
  assert.equal(run.snapshot.profile, 'feminine');
});

test('fry at the end of a phrase is coached as fry', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const samples = concat([
    vowel({ f0: 205, f1: 380, f2: 2050, duration: 0.95, seed: 84 }),
    vowel({ f0: 92, f1: 400, f2: 1900, fry: true, jitter: 0.035, duration: 0.42, seed: 83 })
  ]);
  const fold = doubledFrames(samples, coach.dsp.analyzePcm);
  const lowTail = fold.tail.filter(hz => hz < 130);
  assert.ok(lowTail.length >= 8, `fry tail was folded or missed: ${fold.tail.join(',')}`);
  assert.equal(fold.doubled.filter(row => row.from < 130).length, 0);
  const turns = coach.dsp.detectTurns(samples, SAMPLE_RATE);
  const read = turns.map(turn => coach.session.readTurn(turn));
  const run = await runClip(coach.factory, { id: 'fry-end', sampleRate: SAMPLE_RATE, samples });
  assert.deepEqual(run.lines, read.map(take => take.text).filter(Boolean));
  assert.ok(run.lines.some(line => cuesMatching(line).includes('vocal-fry')), `heard ${run.lines.join(' | ') || '(silence)'}`);
});

test('a breathy vowel in moderate road noise is not called a drop or fry', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const breath = vowel({ f0: 195, f1: 380, f2: 2050, breath: 0.28, duration: 1.25, seed: 86 });
  const noise = roadNoise(breath.length, SAMPLE_RATE, 90, 'moderate');
  const clear = mixAtSnr(breath, noise, 25);
  const buried = mixAtSnr(breath, noise, 12);
  const clearRun = await runClip(coach.factory, { id: 'breath-25', sampleRate: SAMPLE_RATE, samples: clear });
  const buriedRun = await runClip(coach.factory, { id: 'breath-12', sampleRate: SAMPLE_RATE, samples: buried });
  assert.ok(clearRun.lines.some(line => cuesMatching(line).includes('breathiness')), `25 dB heard ${clearRun.lines.join(' | ') || '(silence)'}`);
  for (const line of [...clearRun.lines, ...buriedRun.lines]) {
    const ids = cuesMatching(line);
    assert.ok(!ids.includes('pitch-drop-end') && !ids.includes('vocal-fry'), line);
  }
});
