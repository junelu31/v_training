import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approachScore, baselineBlendWeight, baselineRelativeScore, blendOverall, describePitchDelta, spectralBalance, scoreBand, validatedOverall } from '../voice-metrics.js';

function harmonicSpectrum({ fundamental = 220, firstDb = -10, upperDb = -40, upperSlope = 1 } = {}) {
  const sampleRate = 48000, bins = 2048, spectrum = new Float32Array(bins).fill(-96), binHz = sampleRate / (bins * 2);
  for (let harmonic = 1; harmonic * fundamental < 5000; harmonic++) {
    const index = Math.round(harmonic * fundamental / binHz);
    const db = harmonic === 1 ? firstDb : upperDb - Math.max(0, harmonic - 4) * upperSlope;
    for (let offset = -1; offset <= 1; offset++) if (index + offset > 0 && index + offset < bins) spectrum[index + offset] = Math.max(spectrum[index + offset], db - Math.abs(offset) * 2);
  }
  return { spectrum, sampleRate };
}

test('pitch-aware spectral balance ignores dominant fundamental energy', () => {
  const quietFundamental = harmonicSpectrum({ firstDb: -55 });
  const loudFundamental = harmonicSpectrum({ firstDb: -5 });
  const quiet = spectralBalance(quietFundamental.spectrum, quietFundamental.sampleRate, 220);
  const loud = spectralBalance(loudFundamental.spectrum, loudFundamental.sampleRate, 220);
  assert.ok(Number.isFinite(quiet) && Number.isFinite(loud));
  assert.ok(Math.abs(quiet - loud) < 0.1, `fundamental changed measure by ${Math.abs(quiet - loud)} dB`);
});

test('stronger upper harmonics produce a brighter spectral balance', () => {
  const dark = harmonicSpectrum({ upperDb: -57, upperSlope: 2 });
  const bright = harmonicSpectrum({ upperDb: -26, upperSlope: 0.2 });
  const darkValue = spectralBalance(dark.spectrum, dark.sampleRate, 220);
  const brightValue = spectralBalance(bright.spectrum, bright.sampleRate, 220);
  assert.ok(brightValue > darkValue + 10, `${brightValue} dB should be above ${darkValue} dB`);
});

test('silent spectra and invalid pitch are not scored', () => {
  const silence = new Float32Array(1024).fill(-120);
  assert.ok(Number.isNaN(spectralBalance(silence, 48000, 220)));
  assert.ok(Number.isNaN(spectralBalance(silence, 48000, 0)));
});

test('a value merely inside its broad practice range cannot score as excellent', () => {
  assert.equal(scoreBand(190, [190, 245], 45), 62);
  assert.equal(scoreBand(217.5, [190, 245], 45), 92);
  assert.equal(scoreBand(400, [190, 245], 45), 0);
});

test('change from a baseline scores the gap to the preset center', () => {
  const band = [190, 245];
  assert.equal(approachScore(140, 140, band), 62);
  assert.equal(approachScore(140, 217.5, band), 92);
  assert.ok(approachScore(140, 100, band) < 62);
  assert.equal(approachScore(217.5, 217.5, band), 92);
  assert.equal(approachScore(217.5, 190, band), 62);
  assert.equal(approachScore(Number.NaN, 140, band), null);
  const relative = baselineRelativeScore(
    { pitch: 140, brightness: -12, movement: 1 },
    { pitch: 140, brightness: -12, movement: 1 },
    { pitch: band, brightness: [-8, -4], movement: [3, 9] }
  );
  assert.equal(relative, 62);
});

test('early weeks weight baseline change more than later weeks', () => {
  assert.equal(baselineBlendWeight(1), 0.75);
  assert.equal(baselineBlendWeight(2), 0.75);
  assert.equal(baselineBlendWeight(3), 0.5);
  assert.equal(baselineBlendWeight(5), 0.5);
  assert.equal(baselineBlendWeight(6), 0.25);
  assert.equal(baselineBlendWeight(8), 0.25);
  assert.equal(baselineBlendWeight(null), 0.5);
  assert.equal(blendOverall(40, null, 1), 40);
  assert.equal(blendOverall(40, 80, 1), 70);
  assert.equal(blendOverall(40, 80, 8), 50);
  assert.equal(blendOverall(40, 80, null), 60);
});

test('pitch delta names the baseline and the goal floor', () => {
  assert.equal(describePitchDelta(8, 148, [190, 245]), "8 Hz above your baseline, still under this goal's floor");
  assert.equal(describePitchDelta(0, 200, [190, 245]), "about the same pitch as your baseline, inside this goal's band");
  assert.equal(describePitchDelta(-4, 250, [190, 245]), "4 Hz below your baseline, above this goal's ceiling");
  assert.equal(describePitchDelta(Number.NaN, 148, [190, 245]), '');
});

test('100 requires strong acoustic evidence and reported outside perception', () => {
  const scores = { pitch: 90, brightness: 88, movement: 87, ease: 91 };
  const coverage = { pitch: 90, spectral: 85 };
  assert.equal(validatedOverall(90, scores, coverage, 90, null), 90);
  assert.equal(validatedOverall(90, scores, coverage, 90, 'consistent'), 100);
  assert.equal(validatedOverall(87, scores, coverage, 90, 'consistent'), 87);
  assert.equal(validatedOverall(90, { ...scores, movement: 84 }, coverage, 90, 'consistent'), 90);
  assert.equal(validatedOverall(90, scores, { ...coverage, spectral: 79 }, 90, 'consistent'), 90);
});
