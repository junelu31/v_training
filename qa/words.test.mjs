import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cuesMatching, isTooNoisyText } from './contract.mjs';
import { loadCoach } from './load-coach.mjs';
import { SAMPLE_RATE, mixAtSnr, rms, roadNoise, synthesizeVowel } from './signals.mjs';

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
  return { ok: true, dsp, live, ui };
}

function vowel(spec) {
  return synthesizeVowel({
    sampleRate: SAMPLE_RATE,
    f1: 400,
    f2: 2200,
    f3: 3000,
    rmsTarget: 0.08,
    ...spec
  });
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function scaleDb(samples, db) {
  const gain = 10 ** (db / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

function tone(ms, hz, rmsTarget) {
  const n = Math.floor(SAMPLE_RATE * ms / 1000);
  const out = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE);
    energy += out[i] * out[i];
  }
  const gain = rmsTarget / (Math.sqrt(energy / n) || 1);
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

function pushAll(detector, samples) {
  for (let offset = 0; offset < samples.length; offset += 1600) {
    detector.push(samples.subarray(offset, Math.min(samples.length, offset + 1600)));
  }
}

function fair(speech, snrDb, seed) {
  const preN = Math.floor(SAMPLE_RATE * 0.25);
  const postN = Math.floor(SAMPLE_RATE * 0.9);
  const noise = roadNoise(preN + speech.length + postN, SAMPLE_RATE, seed, 'moderate');
  const under = noise.subarray(preN, preN + speech.length);
  const margin = Math.floor(speech.length * 0.15);
  const speechLevel = rms(speech, margin, Math.max(margin + 1, speech.length - margin));
  const noiseLevel = rms(under, margin, Math.max(margin + 1, under.length - margin));
  const gain = noiseLevel > 1e-8 ? (speechLevel / 10 ** (snrDb / 20)) / noiseLevel : 0;
  const out = new Float32Array(noise.length);
  for (let i = 0; i < noise.length; i++) out[i] = noise[i] * gain;
  for (let i = 0; i < speech.length; i++) out[preN + i] += speech[i];
  return out;
}

function hear(coach, samples, prompt) {
  const session = coach.live.createCoachSession({ lines: [prompt], now: 0, id: prompt });
  const heard = [];
  let turns = 0;
  const detector = coach.dsp.createTurnDetector({
    sampleRate: SAMPLE_RATE,
    onTurn(turn) {
      turns += 1;
      const noted = coach.ui.reviewLiveTurn(turn, session, { prompt, at: turns * 1000 });
      for (const event of noted.events || []) if (event.text) heard.push(event.text);
    }
  });
  pushAll(detector, samples);
  detector.flush();
  return { turns, phrases: session.status().phrases, heard };
}

const WORDS = [
  ['hi', () => vowel({ f0: 215, f1: 380, f2: 2300, duration: 0.22, seed: 11 })],
  ['yes', () => vowel({ f0: 190, f1: 500, f2: 1650, duration: 0.3, seed: 12 })],
  ['please', () => vowel({ f0: 210, f1: 390, f2: 2100, duration: 0.38, seed: 13 })],
  ['okay', () => concat([
    vowel({ f0: 185, f1: 520, f2: 1450, duration: 0.16, seed: 14 }),
    new Float32Array(Math.floor(SAMPLE_RATE * 0.05)),
    vowel({ f0: 215, f1: 360, f2: 2200, duration: 0.2, seed: 15 })
  ])]
];

test('short words still open a turn, clean and at 20 dB', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const misses = [];
  for (const [name, make] of WORDS) {
    const speech = make();
    const clean = concat([speech, new Float32Array(Math.floor(SAMPLE_RATE * 0.8))]);
    const noisy = fair(speech, 20, 70);
    for (const [label, samples] of [[`${name} clean`, clean], [`${name} 20 dB`, noisy]]) {
      const run = hear(coach, samples, name);
      console.log(JSON.stringify({ label, ...run }));
      if (run.turns < 1) misses.push(`${label} opened ${run.turns} turns`);
      if (run.heard.some(isTooNoisyText)) misses.push(`${label} status ${run.heard.join(' | ')}`);
      const ids = technique(run.heard);
      if (ids.length) misses.push(`${label} technique ${ids.join(', ')}: ${run.heard.join(' | ')}`);
    }
  }
  assert.deepEqual(misses, []);
});

test('a 70 ms tone in digital silence gets no status line and no stored phrase', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const beep = new Float32Array(Math.floor(SAMPLE_RATE * 1.6));
  beep.set(tone(70, 300, 0.1), Math.floor(SAMPLE_RATE * 0.2));
  const session = coach.live.createCoachSession({ lines: ['ah'], now: 0, id: 'silence-tone' });
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
  for (let n = 0; n < 6; n++) pushAll(detector, beep);
  detector.flush();
  const distinct = [...new Set(heard)];
  console.log(JSON.stringify({ turns, phrases: session.status().phrases, heard: distinct }));
  assert.equal(session.status().phrases, 0, `phrase log held ${session.status().phrases}`);
  assert.deepEqual(distinct, []);
  assert.deepEqual(technique(heard), []);
});

test('sustained loud noise is logged once until a real phrase', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const session = coach.live.createCoachSession({ lines: ['ah'], now: 0, id: 'loud-once' });
  const heard = [];
  let turns = 0;
  const detector = coach.dsp.createTurnDetector({
    sampleRate: SAMPLE_RATE,
    onTurn(turn) {
      turns += 1;
      const noted = coach.ui.reviewLiveTurn(turn, session, { prompt: 'ah', at: turns * 1000 });
      if (!noted.ignored) {
        for (const event of noted.events || []) if (event.text) heard.push(event.text);
      }
    }
  });
  pushAll(detector, roadNoise(SAMPLE_RATE * 3, SAMPLE_RATE, 43, 'loud'));
  pushAll(detector, roadNoise(SAMPLE_RATE * 2, SAMPLE_RATE, 44, 'loud'));
  const afterFirst = session.status().phrases;
  detector.push(new Float32Array(SAMPLE_RATE * 2));
  pushAll(detector, vowel({ f0: 210, f1: 380, f2: 2200, duration: 0.8, seed: 21 }));
  detector.push(new Float32Array(SAMPLE_RATE));
  const afterPhrase = session.status().phrases;
  pushAll(detector, roadNoise(SAMPLE_RATE * 3, SAMPLE_RATE, 45, 'loud'));
  console.log(JSON.stringify({ turns, afterFirst, afterPhrase, phrases: session.status().phrases, heard }));
  assert.equal(afterFirst, 1);
  assert.ok(afterPhrase > afterFirst, `phrase count stayed ${afterPhrase}`);
  assert.ok(session.status().phrases > afterPhrase);
  assert.deepEqual(technique(heard), []);
  assert.ok(heard.some(isTooNoisyText));
});

test('the same loud road at -12 dB and +6 dB never gets a technique cue', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const scene = roadNoise(SAMPLE_RATE * 3, SAMPLE_RATE, 43, 'loud');
  const misses = [];
  for (const db of [-12, 0, 6]) {
    const run = hear(coach, scaleDb(scene, db), 'ah');
    console.log(JSON.stringify({ db, rms: +rms(scaleDb(scene, db)).toFixed(4), ...run }));
    const ids = technique(run.heard);
    if (ids.length) misses.push(`${db} dB technique ${ids.join(', ')}: ${run.heard.join(' | ')}`);
    if (db >= 0 && !run.heard.some(isTooNoisyText)) misses.push(`${db} dB stayed silent`);
  }
  assert.deepEqual(misses, []);
});

test('speech at 5 and 10 dB on a quiet floor gets no technique cue', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const speech = vowel({ f0: 205, f1: 360, f2: 2150, duration: 1.2, seed: 33 });
  const misses = [];
  for (const snrDb of [5, 10]) {
    for (const floor of [0.04, 0.08]) {
      const preN = Math.floor(SAMPLE_RATE * 0.3);
      const noise = roadNoise(preN + speech.length + Math.floor(SAMPLE_RATE * 0.8), SAMPLE_RATE, 80, 'moderate');
      const noiseLevel = rms(noise) || 1;
      const floorGain = floor / noiseLevel;
      const voiceGain = (floor * 10 ** (snrDb / 20)) / (rms(speech) || 1);
      const out = new Float32Array(noise.length);
      for (let i = 0; i < noise.length; i++) out[i] = noise[i] * floorGain;
      for (let i = 0; i < speech.length; i++) out[preN + i] += speech[i] * voiceGain;
      const run = hear(coach, out, 'ah');
      console.log(JSON.stringify({ snrDb, floor, ...run }));
      const ids = technique(run.heard);
      if (ids.length) misses.push(`${snrDb} dB floor ${floor} technique ${ids.join(', ')}: ${run.heard.join(' | ')}`);
    }
  }
  assert.deepEqual(misses, []);
});

test('a -15 dB mix still gets the status line', async (t) => {
  const coach = await coachParts();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const speech = vowel({ f0: 205, f1: 360, f2: 2150, duration: 1.25, seed: 61 });
  const loud = roadNoise(speech.length + SAMPLE_RATE, SAMPLE_RATE, 71, 'loud');
  const run = hear(coach, mixAtSnr(speech, loud, -15), 'ah');
  console.log(JSON.stringify(run));
  assert.ok(run.heard.some(isTooNoisyText), run.heard.join(' | ') || '(silence)');
  assert.deepEqual(technique(run.heard), []);
});
