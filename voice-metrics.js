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
