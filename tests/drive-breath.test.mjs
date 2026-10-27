import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAMPLE_RATE, createTurnDetector } from '../drive-dsp.js';
import {
  BREATH_SECONDS,
  breathSamples,
  prependBreath,
  readBreathCue,
  shouldCueBreath,
  writeBreathCue
} from '../drive-breath.js';

const REMOVED = [
  'Match how I say this:',
  'Match this lighter practice voice:',
  'and match how I say it',
  'and match this lighter practice voice',
  'That matched this practice voice.',
  'That matched. Next:',
  'Talk in this voice whenever you are ready.',
  'Talk in this lighter practice voice whenever you are ready.',
  'Back to Aurora. Match how I say this:',
  'Back to Aurora. Talk in this voice whenever you are ready.',
  'Match this voice.',
  'That one matched this lighter voice. Keep going.',
  'That stayed with this practice voice.',
  'listen and match',
  'Next. ${',
  'Again. ${'
];

test('phrase prompts no longer carry match-this-voice filler', () => {
  const files = ['drive-coach.js', 'drive-ui.js', 'drive-voice.js', 'drive-cues.js', 'app.js', 'index.html'];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const line of REMOVED) assert.equal(source.includes(line), false, `${file} still has ${line}`);
  }
});

test('the breath cue defaults on and stays on this device', () => {
  const store = new Map();
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value))
  };
  assert.equal(readBreathCue(storage), true);
  assert.equal(readBreathCue(null), true);
  writeBreathCue(storage, false);
  assert.equal(readBreathCue(storage), false);
  writeBreathCue(storage, true);
  assert.equal(readBreathCue(storage), true);
  assert.equal(shouldCueBreath('Mia is here early.', 'Mia is here early.', true), true);
  assert.equal(shouldCueBreath('Nothing to fix there.', 'Mia is here early.', true), false);
  assert.equal(shouldCueBreath('Mia is here early.', 'Mia is here early.', false), false);
  assert.equal(shouldCueBreath('Mia is here early.', '', true), false);
});

test('the inhale is a short shaped noise burst, then silence at the join', () => {
  assert.ok(BREATH_SECONDS >= 0.4 && BREATH_SECONDS <= 0.7);
  const rate = 48000;
  const samples = breathSamples(Math.round(rate * BREATH_SECONDS), rate);
  assert.equal(samples.length / rate, BREATH_SECONDS);
  assert.ok(Math.abs(samples[0]) < 0.02);
  assert.ok(Math.abs(samples[samples.length - 1]) < 0.02);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Number.isFinite(samples[i]));
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  assert.ok(Math.abs(peak - 0.3) < 1e-4, `peak ${peak}`);
  assert.deepEqual(breathSamples(samples.length, rate), samples);
});

test('the inhale is prepended to the phrase as one buffer', () => {
  const rate = 16000;
  const phraseSeconds = 0.4;
  const phraseLength = Math.round(rate * phraseSeconds);
  const data = [new Float32Array(phraseLength).fill(0.5)];
  const phrase = {
    duration: phraseSeconds,
    length: phraseLength,
    numberOfChannels: 1,
    sampleRate: rate,
    getChannelData: channel => data[channel]
  };
  const channels = [];
  const ctx = {
    sampleRate: rate,
    createBuffer(_count, length, sampleRate) {
      const stored = new Float32Array(length);
      channels.push(stored);
      return {
        duration: length / sampleRate,
        length,
        numberOfChannels: 1,
        sampleRate,
        getChannelData: () => stored
      };
    }
  };
  const mixed = prependBreath(ctx, phrase);
  const breathFrames = Math.round(rate * BREATH_SECONDS);
  assert.equal(mixed.length, breathFrames + phraseLength);
  assert.ok(Math.abs(mixed.duration - (BREATH_SECONDS + phraseSeconds)) < 0.001);
  assert.notEqual(mixed.getChannelData(0)[0], 0.5);
  assert.equal(mixed.getChannelData(0)[breathFrames], 0.5);
  assert.equal(mixed.getChannelData(0)[mixed.length - 1], 0.5);
  const bare = { duration: 0.3, length: 4800, numberOfChannels: 1 };
  const extended = prependBreath({ sampleRate: rate }, bare);
  assert.ok(extended.duration > bare.duration);
  assert.equal(extended.duration, BREATH_SECONDS + bare.duration);
});

test('the inhale does not open a turn, and the speaking gate drops it', () => {
  const samples = breathSamples(Math.round(SAMPLE_RATE * BREATH_SECONDS), SAMPLE_RATE);
  const silence = new Float32Array(Math.round(SAMPLE_RATE * 0.9));
  let gatedTurns = 0;
  const gated = createTurnDetector({ sampleRate: SAMPLE_RATE, onTurn() { gatedTurns += 1; } });
  gated.setSpeaking(true);
  gated.push(samples);
  gated.push(silence);
  gated.setSpeaking(false);
  gated.push(samples);
  assert.equal(gatedTurns, 0);
  assert.equal(gated.stats().inSpeech, false);

  let turns = 0;
  const live = createTurnDetector({ sampleRate: SAMPLE_RATE, onTurn() { turns += 1; } });
  live.push(new Float32Array(SAMPLE_RATE));
  live.push(samples);
  live.push(samples);
  live.push(silence);
  assert.equal(turns, 0);
  assert.equal(live.stats().inSpeech, false);
});

test('phrase speech mutes the mic before the inhale is attached to the phrase clip', () => {
  const source = readFileSync(new URL('../drive-ui.js', import.meta.url), 'utf8');
  const speak = source.slice(source.indexOf('function speak(text)'), source.indexOf('async function finishSpeech'));
  const mute = speak.indexOf('detector?.setSpeaking(true)');
  const start = speak.indexOf('finishSpeech(');
  assert.ok(mute > -1 && start > mute);
  assert.match(source, /prependBreath\(ctx, buffer\)/);
  assert.match(source, /shouldCueBreath/);
  assert.match(source, /output\[0\] = 1e-4/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="breathCueToggle" checked/);
});
