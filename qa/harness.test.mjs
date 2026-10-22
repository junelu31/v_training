import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { confusionMatrix, formatMatrix } from './evaluate.mjs';
import { cueCorpus, measureAll, noiseCorpus, profileCorpus } from './corpus.mjs';
import { referenceCuesMatchContract } from './doubles.mjs';
import { measuredSnrDb, mixAtSnr, rms } from './signals.mjs';

test('synthetic vowels land in the published pitch and formant regions', () => {
  const measured = measureAll(profileCorpus());
  for (const row of measured) {
    assert.ok(row.confidence >= 0.45, `${row.id} confidence ${row.confidence}`);
    if (row.label === 'feminine') {
      assert.ok(row.f0 >= 170, `${row.id} f0 ${row.f0}`);
      assert.ok(row.f2 >= 1650, `${row.id} f2 ${row.f2} f1 ${row.f1}`);
    } else if (row.label === 'masculine') {
      assert.ok(row.f0 <= 140, `${row.id} f0 ${row.f0}`);
      assert.ok(row.f2 <= 1250, `${row.id} f2 ${row.f2} f1 ${row.f1}`);
    } else if (row.id === 'trap-high-dark') {
      assert.ok(row.f0 >= 170, `${row.id} f0 ${row.f0}`);
      assert.ok(row.f2 <= 1250, `${row.id} f2 ${row.f2}`);
    } else if (row.id === 'trap-low-bright') {
      assert.ok(row.f0 <= 140, `${row.id} f0 ${row.f0}`);
      assert.ok(row.f2 >= 1650, `${row.id} f2 ${row.f2}`);
    }
  }
});

test('injected defects are acoustically distinct', () => {
  const measured = Object.fromEntries(measureAll(cueCorpus()).map(row => [row.id, row]));
  assert.ok(measured['defect-pitch-low'].f0 < 145, JSON.stringify(measured['defect-pitch-low']));
  assert.ok(measured['defect-pitch-low'].f2 >= 1650, JSON.stringify(measured['defect-pitch-low']));
  assert.ok(measured['defect-pitch-drop'].dropSemitones >= 6, JSON.stringify(measured['defect-pitch-drop']));
  assert.ok(measured['defect-fry'].f0 < 130 && measured['defect-fry'].f0Variation >= 0.01, JSON.stringify(measured['defect-fry']));
  assert.ok(measured['defect-dark'].f2 <= 1400, JSON.stringify(measured['defect-dark']));
  assert.ok(measured['defect-dark'].f0 >= 170, JSON.stringify(measured['defect-dark']));
  assert.ok(measured.clean.f0 >= 170 && measured.clean.f2 >= 1650, JSON.stringify(measured.clean));
  assert.ok(measured['defect-breath'].f0 >= 160 && measured['defect-breath'].f0 <= 240, JSON.stringify(measured['defect-breath']));
  assert.ok(measured['defect-breath'].confidence < 0.8 && measured['defect-breath'].confidence < measured.clean.confidence, JSON.stringify(measured['defect-breath']));
  assert.ok(measured['defect-breath'].zeroCrossings < 0.12, JSON.stringify(measured['defect-breath']));
});

test('road-noise mixes hit the requested SNR and noise alone is unvoiced', () => {
  for (const clip of noiseCorpus()) {
    if (clip.kind === 'noise-only') {
      const measure = measureAll([clip])[0];
      assert.ok(measure.confidence < 0.45, `${clip.id} looked voiced: ${JSON.stringify(measure)}`);
      continue;
    }
    const achieved = measuredSnrDb(clip.speech, clip.noise, clip.samples, clip.snrDb);
    assert.ok(Math.abs(achieved - clip.snrDb) < 0.75, `${clip.id} SNR ${achieved}`);
    const margin = Math.floor(clip.speech.length * 0.2);
    const speechLevel = rms(clip.speech, margin, clip.speech.length - margin);
    const mixedLevel = rms(clip.samples, margin, clip.samples.length - margin);
    assert.ok(speechLevel > 0.01 && mixedLevel > 0, clip.id);
    assert.equal(mixAtSnr(clip.speech, clip.noise, clip.snrDb).length, clip.speech.length);
  }
});

test('confusion matrix counts abstentions and swaps', () => {
  const matrix = confusionMatrix([
    { actual: 'feminine', predicted: 'feminine' },
    { actual: 'feminine', predicted: 'masculine' },
    { actual: 'masculine', predicted: 'abstain' },
    { actual: 'androgynous', predicted: 'androgynous' }
  ]);
  assert.equal(matrix.feminine.feminine, 1);
  assert.equal(matrix.feminine.masculine, 1);
  assert.equal(matrix.masculine.abstain, 1);
  assert.equal(matrix.androgynous.androgynous, 1);
  assert.match(formatMatrix(matrix), /feminine/);
});

test('reference cue lines satisfy the spoken-copy rules', () => {
  assert.equal(referenceCuesMatchContract(), '');
});

test('voice recordings are not part of the suite', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  const blocked = tracked.split('\n').filter(file => /\.(mp4|m4a|wav|webm|ogg|mp3)$/i.test(file) && file.startsWith('qa/'));
  assert.deepEqual(blocked, []);
  for (const name of ['take1_road_snr20', 'take1_road_snr10', 'take1_road_snr5', 'road_only']) {
    assert.equal(tracked.includes(name), false, `${name} must stay out of git`);
  }
});
