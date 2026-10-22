import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnDetector, makeRoadNoise, normalizeRms, synthesizeWords } from '../drive-dsp.js';
import { createCoachSession } from '../drive-coach.js';
import { reviewLiveTurn } from '../drive-ui.js';

const RATE = 16000;

function rms(samples) {
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  return Math.sqrt(energy / Math.max(1, samples.length));
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

function bed(seconds, seed, level) {
  return normalizeRms(makeRoadNoise(seconds, RATE, seed), level);
}

function scale(samples, gain) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

function atSnr(speech, snrDb, seed) {
  const floor = 0.02;
  const pre = bed(0.25, seed, floor);
  const under = bed(speech.length / RATE + 0.05, seed + 1, floor).subarray(0, speech.length);
  const post = bed(0.9, seed + 2, floor);
  const gain = rms(under) > 1e-8 ? (rms(speech) / 10 ** (snrDb / 20)) / rms(under) : 0;
  const mid = new Float32Array(speech.length);
  const noise = scale(under, gain);
  for (let i = 0; i < speech.length; i++) mid[i] = speech[i] + noise[i];
  return concat([scale(pre, gain), mid, scale(post, gain)]);
}

function tone(ms, hz, level) {
  const n = Math.floor(RATE * ms / 1000);
  const out = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(2 * Math.PI * hz * i / RATE);
    energy += out[i] * out[i];
  }
  const gain = level / (Math.sqrt(energy / n) || 1);
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

function pushAll(detector, samples) {
  for (let offset = 0; offset < samples.length; offset += 1600) {
    detector.push(samples.subarray(offset, Math.min(samples.length, offset + 1600)));
  }
}

function isTooNoisy(text) {
  return /\btoo noisy\b/i.test(text || '');
}

function hear(samples, prompt) {
  const session = createCoachSession({ lines: [prompt], now: 0, id: prompt });
  const heard = [];
  let turns = 0;
  const detector = createTurnDetector({
    sampleRate: RATE,
    onTurn(turn) {
      turns += 1;
      const noted = reviewLiveTurn(turn, session, { prompt, at: turns * 1000 });
      for (const event of noted.events || []) if (event.text) heard.push(event.text);
    }
  });
  pushAll(detector, samples);
  detector.flush();
  return { turns, phrases: session.status().phrases, heard };
}

const WORDS = [
  ['hi', [{ text: 'hi', ms: 220, f0: 215, f1: 380, f2: 2300, seed: 11, gapMs: 0 }]],
  ['yes', [{ text: 'yes', ms: 300, f0: 190, f1: 500, f2: 1650, seed: 12, gapMs: 0 }]],
  ['please', [{ text: 'please', ms: 380, f0: 210, f1: 390, f2: 2100, seed: 13, gapMs: 0 }]],
  ['okay', [
    { text: 'o', ms: 160, f0: 185, f1: 520, f2: 1450, seed: 14, gapMs: 50 },
    { text: 'kay', ms: 200, f0: 215, f1: 360, f2: 2200, seed: 15, gapMs: 0 }
  ]]
];

test('short words get no status line, clean and at 20 dB', () => {
  const misses = [];
  for (const [name, spec] of WORDS) {
    const speech = synthesizeWords(spec).samples;
    const clean = concat([speech, new Float32Array(Math.floor(RATE * 0.8))]);
    const noisy = atSnr(speech, 20, 70);
    for (const [label, samples] of [[`${name} clean`, clean], [`${name} 20 dB`, noisy]]) {
      const run = hear(samples, name);
      if (run.turns < 1) misses.push(`${label} opened ${run.turns} turns`);
      if (run.heard.some(isTooNoisy)) misses.push(`${label} status ${run.heard.join(' | ')}`);
    }
  }
  assert.deepEqual(misses, []);
});

test('a short tone in digital silence gets no status line', () => {
  for (const level of [0.1, 0.5]) {
    const beep = new Float32Array(Math.floor(RATE * 1.6));
    beep.set(tone(70, 300, level), Math.floor(RATE * 0.2));
    const run = hear(beep, 'ah');
    assert.ok(run.turns >= 1, `rms ${level} opened ${run.turns} turns`);
    assert.equal(run.phrases, 0, `rms ${level} stored ${run.phrases}`);
    assert.deepEqual(run.heard.filter(isTooNoisy), [], run.heard.join(' | '));
  }
});

test('sustained loud noise still gets the status line', () => {
  const session = createCoachSession({ lines: ['ah'], now: 0, id: 'loud-once' });
  const heard = [];
  let turns = 0;
  const detector = createTurnDetector({
    sampleRate: RATE,
    onTurn(turn) {
      turns += 1;
      const noted = reviewLiveTurn(turn, session, { prompt: 'ah', at: turns * 1000 });
      if (!noted.ignored) {
        for (const event of noted.events || []) if (event.text) heard.push(event.text);
      }
    }
  });
  pushAll(detector, bed(3, 43, 0.3));
  pushAll(detector, bed(2, 44, 0.3));
  const afterFirst = session.status().phrases;
  detector.push(new Float32Array(RATE * 2));
  pushAll(detector, synthesizeWords([{ text: 'ah', ms: 800, f0: 210, f1: 380, f2: 2200, seed: 21, gapMs: 0 }]).samples);
  detector.push(new Float32Array(RATE));
  const afterPhrase = session.status().phrases;
  pushAll(detector, bed(3, 45, 0.3));
  assert.equal(afterFirst, 1);
  assert.ok(afterPhrase > afterFirst, `phrase count stayed ${afterPhrase}`);
  assert.ok(session.status().phrases > afterPhrase);
  assert.ok(heard.some(isTooNoisy));
  assert.equal(turns > 0, true);
});
