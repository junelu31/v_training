import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cuesMatching } from './contract.mjs';
import { loadCoach } from './load-coach.mjs';
import { runClip } from './session.mjs';
import { SAMPLE_RATE, mixAtSnr, rms, roadNoise, synthesizeVowel } from './signals.mjs';

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
  return { ok: true, factory: coach.createDriveSession, session, dsp, sourceFile: coach.sourceFile };
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

function withRoadTail(speech, noise, snrDb, seconds) {
  const mixed = mixAtSnr(speech, noise, snrDb);
  const margin = Math.floor(speech.length * 0.15);
  const speechLevel = rms(speech, margin, speech.length - margin);
  const noiseLevel = rms(noise, margin, Math.min(noise.length, speech.length) - margin);
  const gain = noiseLevel > 1e-8 ? (speechLevel / 10 ** (snrDb / 20)) / noiseLevel : 0;
  const peak = mixed.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const trim = peak > 0.98 ? 0.98 / peak : 1;
  const tailN = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(mixed.length + tailN);
  out.set(mixed);
  for (let i = 0; i < tailN; i++) out[mixed.length + i] = (noise[speech.length + i] || 0) * gain * trim;
  return out;
}

test('phrase-final fry in 10 to 20 dB road noise is not called breath or a drop', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const phrase = concat([
    vowel({ f0: 205, f1: 380, f2: 2050, duration: 0.95, seed: 84 }),
    vowel({ f0: 92, f1: 400, f2: 1900, fry: true, jitter: 0.035, duration: 0.42, seed: 83 })
  ]);
  const noise = roadNoise(phrase.length + SAMPLE_RATE, SAMPLE_RATE, 97, 'moderate');
  const misses = [];
  for (const snrDb of [20, 18, 15, 12, 10]) {
    const mixed = withRoadTail(phrase, noise, snrDb, 0.8);
    const run = await runClip(coach.factory, { id: `fry-road-${snrDb}`, sampleRate: SAMPLE_RATE, samples: mixed });
    const ids = run.lines.flatMap(line => cuesMatching(line));
    const heard = run.lines.join(' | ') || '(silence)';
    if (ids.includes('breathiness') || ids.includes('pitch-drop-end')) misses.push(`${snrDb} dB road pause heard ${heard}`);
    if (snrDb >= 18 && !ids.includes('vocal-fry')) misses.push(`${snrDb} dB road pause heard ${heard}`);
  }
  for (const snrDb of [12, 10]) {
    const mixed = mixAtSnr(phrase, noise, snrDb);
    const run = await runClip(coach.factory, { id: `fry-flush-${snrDb}`, sampleRate: SAMPLE_RATE, samples: mixed });
    const ids = run.lines.flatMap(line => cuesMatching(line));
    const heard = run.lines.join(' | ') || '(silence)';
    if (ids.includes('breathiness') || ids.includes('pitch-drop-end')) misses.push(`${snrDb} dB flush heard ${heard}`);
  }
  assert.deepEqual(misses, []);
});

test('a steady low voice is not called fry', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  for (const f0 of [105, 110]) {
    const dark = vowel({ f0, f1: 700, f2: 1100, duration: 1.3, seed: 93 });
    const run = await runClip(coach.factory, { id: `steady-${f0}`, sampleRate: SAMPLE_RATE, samples: dark });
    assert.equal(run.snapshot.profile, 'masculine', `${f0} Hz`);
    assert.deepEqual(run.lines, [], `${f0} Hz heard ${run.lines.join(' | ')}`);
  }
});

test('a creak shorter than 8 frames is not called fry', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const samples = concat([
    vowel({ f0: 205, f1: 380, f2: 2050, duration: 1.05, seed: 91 }),
    vowel({ f0: 92, f1: 400, f2: 1900, fry: true, jitter: 0.04, duration: 0.12, seed: 92 })
  ]);
  const fold = doubledFrames(samples, coach.dsp.analyzePcm);
  const lowTail = fold.tail.filter(hz => hz < 130);
  assert.ok(lowTail.length < 8, `low frames ${lowTail.length}`);
  const run = await runClip(coach.factory, { id: 'short-creak', sampleRate: SAMPLE_RATE, samples });
  assert.ok(!run.lines.some(line => cuesMatching(line).includes('vocal-fry')), run.lines.join(' | ') || '(silence)');
});

test('road rumble near 86 Hz is not read as fry', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const n = Math.floor(SAMPLE_RATE * 1.4);
  const tone = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = 86 + 6 * Math.sin(2 * Math.PI * 2.5 * i / SAMPLE_RATE);
    phase += 2 * Math.PI * f / SAMPLE_RATE;
    tone[i] = Math.sin(phase);
  }
  let energy = 0;
  for (let i = 0; i < n; i++) energy += tone[i] * tone[i];
  const level = Math.sqrt(energy / n);
  const moderate = Float32Array.from(tone, value => value * (0.05 / level));
  const loud = Float32Array.from(tone, value => value * (0.2 / level));
  const quietRun = await runClip(coach.factory, { id: 'rumble-86', sampleRate: SAMPLE_RATE, samples: moderate });
  const loudRun = await runClip(coach.factory, { id: 'rumble-86-loud', sampleRate: SAMPLE_RATE, samples: loud });
  assert.deepEqual(quietRun.lines, []);
  for (const line of loudRun.lines) assert.ok(!cuesMatching(line).includes('vocal-fry'), line);
  assert.ok(loudRun.lines.every(line => /too noisy/i.test(line)), loudRun.lines.join(' | ') || '(silence)');
});

test('a fry or drop the segmenter already marked is kept when readTurn is empty', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const ui = await import(pathToFileURL(join(dirname(coach.sourceFile), 'drive-ui.js')).href);
  const live = await import(pathToFileURL(join(dirname(coach.sourceFile), 'drive-coach.js')).href);
  function framesFor(hz, fry, count) {
    const frames = [];
    for (let i = 0; i < count; i++) {
      frames.push({
        t: i * 0.02,
        rms: 0.07,
        hz,
        confidence: fry ? 0.45 : 0.9,
        voiced: true,
        vowel: true,
        fry,
        f2: 1800,
        f2Local: 1800,
        unstable: false,
        h1h2: 1
      });
    }
    return frames;
  }
  const silent = {
    samples: new Float32Array(Math.floor(SAMPLE_RATE * 0.25)),
    sampleRate: SAMPLE_RATE,
    tooNoisy: false,
    reason: 'silence',
    snrDb: 18,
    voicedFraction: 0.7
  };
  const cases = [
    { prompt: 'hello', frames: framesFor(98, 0.9, 30), pattern: /\b(fry|creak)\b/i },
    {
      prompt: 'good morning',
      frames: [...framesFor(200, 0, 40), ...framesFor(96, 0.2, 6).map((frame, index) => ({ ...frame, t: (40 + index) * 0.02 }))],
      pattern: /\b(drop|end of the word|lift)\b/i
    }
  ];
  for (const item of cases) {
    const turn = { ...silent, frames: item.frames };
    assert.equal(coach.session.readTurn(turn).text, '', item.prompt);
    const coachSession = live.createCoachSession({ lines: [item.prompt], now: 0, id: item.prompt });
    const noted = ui.reviewLiveTurn(turn, coachSession, { prompt: item.prompt, at: 5000 });
    const text = (noted.events || []).map(event => event.text).filter(Boolean).join(' ');
    assert.match(text, item.pattern, text || '(silence)');
  }
});

test('pitch, drop, and fry are spoken as a physical action', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const fry = concat([
    vowel({ f0: 205, f1: 380, f2: 2050, duration: 0.95, seed: 84 }),
    vowel({ f0: 92, f1: 400, f2: 1900, fry: true, jitter: 0.035, duration: 0.42, seed: 83 })
  ]);
  const cases = [
    [vowel({ f0: 108, f1: 400, f2: 2000, duration: 1.3, seed: 94 }), 'Hum the next word, and bring the pitch up a little.'],
    [vowel({ f0: 205, f0End: 96, f1: 380, f2: 2000, duration: 1.4, seed: 87 }), 'Lift the end of the word with a small hum.'],
    [fry, 'Keep breath flowing through the last word, and lift the pitch a little so the end does not creak.']
  ];
  for (const [samples, line] of cases) {
    const run = await runClip(coach.factory, { id: line.slice(0, 12), sampleRate: SAMPLE_RATE, samples });
    assert.deepEqual(run.lines, [line]);
  }
});

function fadeOut(samples, seconds) {
  const out = new Float32Array(samples);
  const n = Math.min(out.length, Math.floor(SAMPLE_RATE * seconds));
  const start = out.length - n;
  for (let i = 0; i < n; i++) out[start + i] *= (1 - i / n) ** 2;
  return out;
}

function padSilence(samples, seconds) {
  const out = new Float32Array(samples.length + Math.floor(SAMPLE_RATE * seconds));
  out.set(samples);
  return out;
}

test('a fading breathy phrase is still coached, clean and at 20 dB', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const breath = vowel({ f0: 195, f1: 380, f2: 2050, breath: 0.28, duration: 1.25, seed: 55 });
  const faded = fadeOut(breath, 0.35);
  const noise = roadNoise(faded.length + SAMPLE_RATE, SAMPLE_RATE, 90, 'moderate');
  const cases = [
    ['clean fade', faded],
    ['clean fade plus the pause that closes a turn', padSilence(fadeOut(breath, 0.3), 0.56)],
    ['20 dB fade', mixAtSnr(faded, noise, 20)],
    ['20 dB steady', mixAtSnr(breath, noise, 20)]
  ];
  const misses = [];
  for (const [label, samples] of cases) {
    const run = await runClip(coach.factory, { id: label, sampleRate: SAMPLE_RATE, samples });
    const heard = run.lines.join(' | ') || '(silence)';
    const ids = run.lines.flatMap(line => cuesMatching(line));
    if (!ids.includes('breathiness')) misses.push(`${label} heard ${heard}`);
    if (ids.includes('vocal-fry') || ids.includes('pitch-drop-end')) misses.push(`${label} wrong cue ${heard}`);
  }
  assert.deepEqual(misses, []);
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
