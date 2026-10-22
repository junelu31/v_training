import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cuesMatching } from './contract.mjs';
import { loadCoach } from './load-coach.mjs';
import { decodeAudio, findReferenceClips } from './reference-media.mjs';
import { runClip } from './session.mjs';
import { SAMPLE_RATE, mixAtSnr, roadNoise, synthesizeVowel } from './signals.mjs';

function technique(lines) {
  return lines.flatMap(line => cuesMatching(line));
}

async function coachParts() {
  const coach = await loadCoach();
  if (!coach.ok) return coach;
  const dir = dirname(coach.sourceFile);
  const dsp = await import(pathToFileURL(join(dir, 'drive-dsp.js')).href);
  const live = await import(pathToFileURL(join(dir, 'drive-coach.js')).href);
  const ui = await import(pathToFileURL(join(dir, 'drive-ui.js')).href);
  return { ok: true, factory: coach.createDriveSession, dsp, live, ui };
}

function scale(samples, target) {
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  const level = Math.sqrt(energy / samples.length) || 1;
  const gain = target / level;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

function tone(ms, hz, rmsTarget) {
  const n = Math.floor(SAMPLE_RATE * ms / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE);
  return scale(out, rmsTarget);
}

function addAt(bed, event, atSec) {
  const out = new Float32Array(bed);
  const at = Math.floor(SAMPLE_RATE * atSec);
  for (let i = 0; i < event.length && at + i < out.length; i++) out[at + i] += event[i];
  return out;
}

function clickTrain(seconds) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  const gap = Math.floor(SAMPLE_RATE * 0.7);
  for (let start = Math.floor(SAMPLE_RATE * 0.3); start < n; start += gap) {
    for (let i = 0; i < Math.floor(SAMPLE_RATE * 0.012); i++) {
      const t = i / SAMPLE_RATE;
      out[start + i] = Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 180) * 0.4;
    }
  }
  return out;
}

function thumps(seconds) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  const gap = Math.floor(SAMPLE_RATE * 1.1);
  for (let start = Math.floor(SAMPLE_RATE * 0.4); start < n; start += gap) {
    for (let i = 0; i < Math.floor(SAMPLE_RATE * 0.05); i++) {
      const t = i / SAMPLE_RATE;
      out[start + i] = Math.sin(2 * Math.PI * 78 * t) * Math.exp(-t * 40) * 0.5;
    }
  }
  return out;
}

function music(seconds) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  const notes = [262, 330, 392, 349];
  for (let i = 0; i < n; i++) {
    const note = notes[Math.floor(i / SAMPLE_RATE * 2) % notes.length];
    const t = i / SAMPLE_RATE;
    out[i] = Math.sin(2 * Math.PI * note * t) + 0.4 * Math.sin(2 * Math.PI * note * 2 * t) + 0.2 * Math.sin(2 * Math.PI * note * 3 * t);
  }
  return scale(out, 0.06);
}

function rumble(seconds, rmsTarget) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = 86 + 6 * Math.sin(2 * Math.PI * 2.5 * i / SAMPLE_RATE);
    phase += 2 * Math.PI * f / SAMPLE_RATE;
    out[i] = Math.sin(phase);
  }
  return scale(out, rmsTarget);
}

test('cabin noise and music bleed never get a technique cue', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const bed = roadNoise(Math.floor(SAMPLE_RATE * 4), SAMPLE_RATE, 41, 'moderate');
  const quiet = roadNoise(Math.floor(SAMPLE_RATE * 3), SAMPLE_RATE, 42, 'quiet');
  const loud = roadNoise(Math.floor(SAMPLE_RATE * 3), SAMPLE_RATE, 43, 'loud');
  const cases = [
    ['quiet road', quiet],
    ['moderate road', bed.subarray(0, Math.floor(SAMPLE_RATE * 3))],
    ['loud road', loud],
    ['86 Hz rumble', rumble(2, 0.05)],
    ['86 Hz rumble, loud', rumble(2, 0.2)],
    ['turn-signal clicks', addAt(bed, clickTrain(4), 0)],
    ['40 ms blip on road', addAt(bed, tone(40, 300, 0.12), 1.2)],
    ['80 ms blip on road', addAt(bed, tone(80, 300, 0.12), 1.2)],
    ['horn on road', addAt(bed, tone(220, 420, 0.16), 1.4)],
    ['road-seam thumps', addAt(bed, thumps(4), 0)],
    ['music', music(2.4)],
    ['music under road noise', addAt(bed, music(2.4), 0.8)]
  ];
  const misses = [];
  for (const [label, samples] of cases) {
    const run = await runClip(coach.factory, { id: label, sampleRate: SAMPLE_RATE, samples });
    const ids = technique(run.lines);
    if (ids.length) misses.push(`${label} heard ${run.lines.join(' | ')}`);
  }
  assert.deepEqual(misses, []);
});

test('a clear vowel in road noise is not called breath', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const speech = synthesizeVowel({
    sampleRate: SAMPLE_RATE, f0: 205, f1: 360, f2: 2150, f3: 3000, rmsTarget: 0.08, duration: 1.25, seed: 61
  });
  const noise = roadNoise(speech.length + SAMPLE_RATE, SAMPLE_RATE, 70, 'moderate');
  for (const snrDb of [20, 10]) {
    const mixed = mixAtSnr(speech, noise, snrDb);
    const padded = new Float32Array(mixed.length + Math.floor(SAMPLE_RATE * 0.8));
    padded.set(mixed);
    for (let i = mixed.length; i < padded.length; i++) padded[i] = noise[i] || 0;
    const run = await runClip(coach.factory, { id: `clear-${snrDb}`, sampleRate: SAMPLE_RATE, samples: padded });
    assert.deepEqual(technique(run.lines), [], `${snrDb} dB heard ${run.lines.join(' | ') || '(silence)'}`);
  }
});

test('the recorded road-only clip never gets a technique cue', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const clips = findReferenceClips().filter(clip => clip.expect === 'noise-only');
  if (!clips.length) {
    t.skip('Set QA_REFERENCE_DIR to the folder that holds the road-only clip.');
    return;
  }
  for (const clip of clips) {
    const samples = decodeAudio(clip.file);
    const run = await runClip(coach.factory, { id: clip.id, sampleRate: SAMPLE_RATE, samples });
    assert.deepEqual(technique(run.lines), [], `${clip.file} heard ${run.lines.join(' | ') || '(silence)'}`);
  }
});

test('a noise-heavy soak does not coach or grow the phrase log', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const minutes = Number(process.env.QA_SOAK_MINUTES || 40);
  const bed = roadNoise(Math.floor(SAMPLE_RATE * 3), SAMPLE_RATE, 77, 'moderate');
  const loop = addAt(bed, tone(80, 300, 0.12), 0.6);
  const song = music(1.2);
  const clip = new Float32Array(loop.length + song.length);
  clip.set(loop);
  clip.set(song, loop.length);
  const coachSession = coach.live.createCoachSession({ lines: ['ah'], now: 0, id: 'noise-soak' });
  const heard = [];
  let turns = 0;
  const detector = coach.dsp.createTurnDetector({
    sampleRate: SAMPLE_RATE,
    onTurn(turn) {
      turns += 1;
      const noted = coach.ui.reviewLiveTurn(turn, coachSession, { prompt: 'ah', at: turns * 1000 });
      for (const event of noted.events || []) if (event.text) heard.push(event.text);
    }
  });
  const run = await runClip(coach.factory, { id: 'noise-seed', sampleRate: SAMPLE_RATE, samples: clip });
  assert.deepEqual(technique(run.lines), [], run.lines.join(' | '));
  const total = Math.floor(minutes * 60 * SAMPLE_RATE);
  const chunk = 1600;
  if (globalThis.gc) globalThis.gc();
  const heapAt = () => process.memoryUsage().heapUsed;
  const mark = { 0: heapAt() };
  let pushed = 0;
  while (pushed < total) {
    for (let offset = 0; offset < clip.length && pushed < total; offset += chunk) {
      const slice = clip.subarray(offset, Math.min(clip.length, offset + chunk));
      detector.push(slice);
      pushed += slice.length;
      const minute = pushed / SAMPLE_RATE / 60;
      if (minute >= 20 && mark[20] == null) {
        if (globalThis.gc) globalThis.gc();
        mark[20] = heapAt();
      }
      if (minute >= 40 && mark[40] == null) {
        if (globalThis.gc) globalThis.gc();
        mark[40] = heapAt();
      }
    }
  }
  detector.push(new Float32Array(SAMPLE_RATE));
  if (globalThis.gc) globalThis.gc();
  const end = heapAt();
  const growth = (mark[40] || end) - (mark[20] || mark[0]);
  const phrases = coachSession.status().phrases;
  console.log(JSON.stringify({ minutes, turns, phrases, heap0: mark[0], heap20: mark[20], heap40: mark[40] || end, growth, heard: [...new Set(heard)] }));
  assert.equal(detector.stats().utteranceSamples, 0);
  assert.ok(phrases <= 24, `phrase log held ${phrases}`);
  assert.ok(coachSession.checkpoint(minutes * 60000).phrases <= 30);
  assert.deepEqual(technique(heard), [], heard.join(' | '));
  assert.ok(growth < 32 * 1024 * 1024, `heap grew ${growth} bytes in the second half`);

  const beeps = new Float32Array(Math.floor(SAMPLE_RATE * 1.6));
  beeps.set(tone(70, 300, 0.1), Math.floor(SAMPLE_RATE * 0.2));
  const beepSession = coach.live.createCoachSession({ lines: ['ah'], now: 0, id: 'beep-soak' });
  const beepHeard = [];
  let beepTurns = 0;
  const beepDetector = coach.dsp.createTurnDetector({
    sampleRate: SAMPLE_RATE,
    onTurn(turn) {
      beepTurns += 1;
      const noted = coach.ui.reviewLiveTurn(turn, beepSession, { prompt: 'ah', at: beepTurns * 1000 });
      for (const event of noted.events || []) if (event.text) beepHeard.push(event.text);
    }
  });
  for (let n = 0; n < 40; n++) beepDetector.push(beeps);
  beepDetector.push(new Float32Array(SAMPLE_RATE));
  console.log(JSON.stringify({ beepTurns, beepPhrases: beepSession.status().phrases, beepHeard: [...new Set(beepHeard)] }));
  assert.ok(beepTurns > 24, `short tones opened ${beepTurns} turns`);
  assert.ok(beepSession.status().phrases <= 24, `beep log held ${beepSession.status().phrases}`);
  assert.deepEqual(technique(beepHeard), [], beepHeard.join(' | '));
});

test('a short tone on quiet road does not pile up false turns', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const clip = addAt(roadNoise(Math.floor(SAMPLE_RATE * 1.6), SAMPLE_RATE, 42, 'quiet'), tone(120, 300, 0.12), 0.2);
  const run = await runClip(coach.factory, { id: 'quiet-blip', sampleRate: SAMPLE_RATE, samples: clip });
  const session = coach.live.createCoachSession({ lines: ['ah'], now: 0, id: 'quiet-blip-soak' });
  const heard = [];
  let turns = 0;
  const detector = coach.dsp.createTurnDetector({
    sampleRate: SAMPLE_RATE,
    onTurn(turn) {
      turns += 1;
      const noted = coach.ui.reviewLiveTurn(turn, session, { prompt: 'ah', at: turns * 1000 });
      for (const event of noted.events || []) if (event.text) heard.push(event.text);
    }
  });
  const chunk = 1600;
  for (let n = 0; n < 40; n++) {
    for (let offset = 0; offset < clip.length; offset += chunk) {
      detector.push(clip.subarray(offset, Math.min(clip.length, offset + chunk)));
    }
  }
  detector.push(new Float32Array(SAMPLE_RATE));
  const phrases = session.status().phrases;
  const distinct = [...new Set(heard)];
  console.log(JSON.stringify({ lines: run.lines, turns, phrases, heard: distinct }));
  assert.deepEqual(run.lines, [], run.lines.join(' | '));
  assert.equal(turns, 0, `quiet-road tones opened ${turns} turns and stored ${phrases}: ${distinct.join(' | ')}`);
  assert.equal(phrases, 0, `phrase log held ${phrases}`);
  assert.deepEqual(technique(heard), [], distinct.join(' | '));
});
