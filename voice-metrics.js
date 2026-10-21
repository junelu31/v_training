// A pitch-aware spectral balance measure. This is an acoustic proxy, not a
// direct measurement of vocal-tract size, gender, or perceived resonance.
export function spectralBalance(dbSpectrum, sampleRate, pitchHz) {
  if (!dbSpectrum?.length || !Number.isFinite(sampleRate) || !Number.isFinite(pitchHz) || pitchHz <= 0) return NaN;

  const binHz = sampleRate / (dbSpectrum.length * 2);
  const lowStart = Math.max(650, pitchHz * 2.25);
  const lowEnd = Math.min(2000, sampleRate * 0.45);
  const highStart = Math.max(2200, lowStart + 250);
  const highEnd = Math.min(5000, sampleRate * 0.47);
  let lowPower = 0, lowCount = 0, highPower = 0, highCount = 0;

  for (let i = 1; i < dbSpectrum.length; i++) {
    const hz = i * binHz;
    const db = dbSpectrum[i];
    if (!Number.isFinite(db) || db < -100) continue;
    const power = 10 ** (Math.min(db, 0) / 10);
    if (hz >= lowStart && hz < lowEnd) { lowPower += power; lowCount++; }
    else if (hz >= highStart && hz < highEnd) { highPower += power; highCount++; }
  }

  if (lowCount < 4 || highCount < 4) return NaN;
  const lowMean = lowPower / lowCount, highMean = highPower / highCount;
  if (lowMean < 1e-9 && highMean < 1e-9) return NaN;
  return 10 * Math.log10(Math.max(highMean, 1e-12) / Math.max(lowMean, 1e-12));
}

// In-band is not automatically excellent: a narrow peak near the preset
// center earns a stronger score than merely entering a broad practice band.
export function scoreBand(value, range, softness) {
  if (!Number.isFinite(value)) return 0;
  const [low, high] = range;
  if (value >= low && value <= high) {
    const halfWidth = Math.max((high - low) / 2, 1e-6);
    const centerDistance = Math.abs(value - (low + high) / 2) / halfWidth;
    return 62 + 30 * (1 - centerDistance);
  }
  const distance = value < low ? low - value : value - high;
  return Math.max(0, 62 - distance / Math.max(softness, 1) * 40);
}

export function validatedOverall(acoustic, scores, coverage, clarity, listenerReview) {
  const evidence = Object.values(scores).every(score => score >= 85) &&
    coverage.pitch >= 80 && coverage.spectral >= 80 &&
    (clarity === null || clarity >= 80);
  return listenerReview === 'consistent' && acoustic >= 89 && evidence ? 100 : Math.min(92, acoustic);
}

// No movement from the baseline sits near the in-band floor (62). Closing the
// gap to the preset center approaches 92. Moving farther from that center
// lowers the score. A baseline already on the center stays high until it drifts.
export function approachScore(baseline, current, range) {
  if (!Number.isFinite(baseline) || !Number.isFinite(current) || !Array.isArray(range) || range.length < 2) return null;
  const [low, high] = range;
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return null;
  const center = (low + high) / 2;
  const startGap = Math.abs(baseline - center);
  const nowGap = Math.abs(current - center);
  const halfWidth = Math.max((high - low) / 2, 1e-6);
  if (startGap < halfWidth * 0.02) return Math.max(0, Math.min(92, 92 - (nowGap / halfWidth) * 30));
  return Math.max(0, Math.min(92, 62 + 30 * ((startGap - nowGap) / startGap)));
}

export function baselineRelativeScore(baseline, current, ranges) {
  const scores = ['pitch', 'brightness', 'movement'].map(key => approachScore(baseline?.[key], current?.[key], ranges?.[key]));
  if (scores.some(score => score == null)) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

// Early course weeks credit change from the person's own voice. Later weeks
// put more of the number on the preset band. Open practice uses the middle.
export function baselineBlendWeight(week) {
  if (!Number.isFinite(week)) return 0.5;
  if (week <= 2) return 0.75;
  if (week <= 5) return 0.5;
  return 0.25;
}

export function blendOverall(acousticOverall, relativeScore, week) {
  if (!Number.isFinite(acousticOverall)) return 0;
  const acoustic = Math.min(92, acousticOverall);
  if (!Number.isFinite(relativeScore)) return Math.round(acoustic);
  const weight = baselineBlendWeight(week);
  return Math.min(92, Math.round(acoustic * (1 - weight) + relativeScore * weight));
}

export function describePitchDelta(deltaHz, currentHz, range) {
  const delta = Number(deltaHz);
  const current = Number(currentHz);
  if (!Number.isFinite(delta) || !Number.isFinite(current)) return '';
  const magnitude = Math.abs(Math.round(delta));
  const direction = magnitude === 0
    ? 'about the same pitch as your baseline'
    : delta > 0 ? `${magnitude} Hz above your baseline` : `${magnitude} Hz below your baseline`;
  const low = range?.[0];
  const high = range?.[1];
  const place = Number.isFinite(low) && current < low
    ? "still under this goal's floor"
    : Number.isFinite(high) && current > high
      ? "above this goal's ceiling"
      : "inside this goal's band";
  return `${direction}, ${place}`;
}
