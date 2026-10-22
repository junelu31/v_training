// Synthetic speech and road noise for the Drive coach suite.
// Clips are generated in memory from published acoustic targets. Nothing here
// is a recording of a person, and nothing here is the product DSP.

export const SAMPLE_RATE = 16000;

export function createRng(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rms(samples, start = 0, end = samples.length) {
  const from = Math.max(0, start);
  const to = Math.min(samples.length, end);
  const n = to - from;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

export function scaleToRms(samples, target) {
  const current = rms(samples);
  if (current < 1e-8) return samples;
  const gain = target / current;
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return samples;
}

function fade(samples, sampleRate, seconds) {
  const n = Math.min(samples.length >> 1, Math.floor(sampleRate * seconds));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    samples[i] *= g;
    samples[samples.length - 1 - i] *= g;
  }
}

function resonator(frequency, bandwidth, sampleRate) {
  const radius = Math.exp((-Math.PI * bandwidth) / sampleRate);
  const theta = (2 * Math.PI * frequency) / sampleRate;
  return {
    a1: 2 * radius * Math.cos(theta),
    a2: -(radius * radius)
  };
}

function tick(filter, input, state) {
  const y = input + filter.a1 * state[0] + filter.a2 * state[1];
  state[1] = state[0];
  state[0] = y;
  return y;
}

function f0At(index, length, spec) {
  if (spec.f0End == null) return spec.f0;
  const t = index / length;
  const u = Math.min(1, Math.max(0, (t - 0.42) / 0.28));
  const shaped = u * u * (3 - 2 * u);
  return spec.f0 + (spec.f0End - spec.f0) * shaped;
}

/**
 * Source-filter vowel. `breath` mixes noise into the source (0–1).
 * `fry` spaces impulses irregularly and with alternating long/short cycles.
 */
export function synthesizeVowel(spec) {
  const sampleRate = spec.sampleRate || SAMPLE_RATE;
  const n = Math.floor(sampleRate * (spec.duration || 1.2));
  const out = new Float32Array(n);
  const random = createRng(spec.seed || 1);
  const filters = [
    resonator(spec.f1, spec.b1 || 90, sampleRate),
    resonator(spec.f2, spec.b2 || 110, sampleRate),
    resonator(spec.f3 || 2900, spec.b3 || 160, sampleRate)
  ];
  const state = filters.map(() => [0, 0]);
  const breath = spec.breath || 0;
  let into = 0;
  let next = 1;
  for (let i = 0; i < n; i++) {
    if (into >= next) {
      into = 0;
      let period = sampleRate / Math.max(60, f0At(i, n, spec));
      if (spec.fry) period *= 1 + (random() * 2 - 1) * (spec.jitter ?? 0.08);
      next = Math.max(8, period);
    }
    let source = into === 0 ? 1 : 0;
    if (breath > 0) source = source * (1 - breath) + (random() * 2 - 1) * breath * 0.55;
    let y = source;
    for (let f = 0; f < filters.length; f++) y = tick(filters[f], y, state[f]);
    if (breath > 0) y += (random() * 2 - 1) * breath * 0.04;
    out[i] = y;
    into += 1;
  }
  scaleToRms(out, spec.rmsTarget || 0.08);
  fade(out, sampleRate, 0.03);
  return out;
}

/** Low rumble, hiss, and a bump every couple of seconds. */
export function roadNoise(length, sampleRate, seed, loudness = 'moderate') {
  const random = createRng(seed);
  const out = new Float32Array(length);
  let brown = 0;
  let pink = 0;
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1;
    brown = 0.995 * brown + 0.005 * white;
    pink = 0.97 * pink + 0.03 * white;
    const t = i / sampleRate;
    const rumble = Math.sin(2 * Math.PI * (28 + 18 * Math.sin(2 * Math.PI * 0.37 * t)) * t);
    const bumpPhase = t % 1.9;
    const bump = bumpPhase < 0.05 ? (random() * 2 - 1) : 0;
    out[i] = brown * 1.1 + pink * 0.55 + rumble * 0.08 + white * 0.35 + bump * 0.45;
  }
  const target = loudness === 'loud' ? 0.3 : loudness === 'quiet' ? 0.01 : 0.045;
  scaleToRms(out, target);
  return out;
}

export function mixAtSnr(speech, noise, snrDb) {
  const margin = Math.floor(speech.length * 0.15);
  const speechLevel = rms(speech, margin, speech.length - margin);
  const noiseLevel = rms(noise, margin, Math.min(noise.length, speech.length) - margin);
  const targetNoise = speechLevel / 10 ** (snrDb / 20);
  const gain = noiseLevel > 1e-8 ? targetNoise / noiseLevel : 0;
  const out = new Float32Array(speech.length);
  const n = Math.min(speech.length, noise.length);
  for (let i = 0; i < n; i++) out[i] = speech[i] + noise[i] * gain;
  const peak = out.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (peak > 0.98) {
    const trim = 0.98 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= trim;
  }
  return out;
}

export function measuredSnrDb(speech, noise, mixed, snrDb) {
  const margin = Math.floor(speech.length * 0.15);
  const end = speech.length - margin;
  const speechLevel = rms(speech, margin, end);
  const noiseLevel = rms(noise, margin, end);
  const mixedSpeech = speechLevel;
  const gain = noiseLevel > 1e-8 ? (mixedSpeech / 10 ** (snrDb / 20)) / noiseLevel : 0;
  const achievedNoise = noiseLevel * gain;
  if (achievedNoise <= 1e-8 || speechLevel <= 1e-8) return NaN;
  return 20 * Math.log10(speechLevel / achievedNoise);
}

export function estimateF0(samples, sampleRate) {
  const n = samples.length;
  if (n < 64) return { hz: 0, confidence: 0, rms: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  let energy = 0;
  const centered = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    centered[i] = samples[i] - mean;
    energy += centered[i] * centered[i];
  }
  const level = Math.sqrt(energy / n);
  if (level < 1e-4) return { hz: 0, confidence: 0, rms: level };
  const minLag = Math.max(2, Math.floor(sampleRate / 500));
  const maxLag = Math.min(Math.floor(sampleRate / 60), n - 2);
  const corr = new Float32Array(maxLag + 1);
  let bestLag = -1;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let cross = 0;
    let left = 0;
    let right = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) {
      const a = centered[i];
      const b = centered[i + lag];
      cross += a * b;
      left += a * a;
      right += b * b;
    }
    const score = left > 0 && right > 0 ? cross / Math.sqrt(left * right) : 0;
    corr[lag] = score;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || best < 0.3) return { hz: 0, confidence: Math.max(0, best), rms: level };
  // Several periods of a clean vowel score almost the same. Prefer the
  // shortest of those peaks, which is the fundamental, and ignore a shorter
  // lag that is not an integer fraction of that period.
  if (best >= 0.75) {
    const floor = best - 0.02;
    for (let lag = minLag + 1; lag < bestLag; lag++) {
      if (corr[lag] < floor || corr[lag] < corr[lag - 1] || corr[lag] < corr[lag + 1]) continue;
      const ratio = bestLag / lag;
      const nearest = Math.round(ratio);
      if (nearest >= 2 && nearest <= 5 && Math.abs(ratio - nearest) < 0.08) {
        bestLag = lag;
        best = corr[lag];
        break;
      }
    }
  }
  const before = corr[bestLag - 1] || best;
  const after = corr[bestLag + 1] || best;
  const denom = before - 2 * best + after;
  const refined = bestLag + (denom ? (0.5 * (before - after)) / denom : 0);
  return { hz: sampleRate / refined, confidence: best, rms: level };
}

function lpcCoefficients(frame, order) {
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = lag; i < frame.length; i++) sum += frame[i] * frame[i - lag];
    r[lag] = sum;
  }
  const a = new Float64Array(order + 1);
  const next = new Float64Array(order + 1);
  a[0] = 1;
  let error = r[0];
  if (error <= 1e-10) return a;
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const reflection = -acc / error;
    for (let j = 1; j < i; j++) next[j] = a[j] + reflection * a[i - j];
    next[i] = reflection;
    next[0] = 1;
    for (let j = 0; j <= i; j++) a[j] = next[j];
    error *= 1 - reflection * reflection;
    if (error <= 1e-12) break;
  }
  return a;
}

function envelopePeaks(coefficients, sampleRate) {
  const bins = 2048;
  const mags = new Float64Array(bins / 2);
  for (let k = 1; k < mags.length; k++) {
    const w = (-2 * Math.PI * k) / bins;
    let re = 1;
    let im = 0;
    for (let i = 1; i < coefficients.length; i++) {
      re += coefficients[i] * Math.cos(w * i);
      im += coefficients[i] * Math.sin(w * i);
    }
    mags[k] = 1 / Math.sqrt(re * re + im * im);
  }
  const peaks = [];
  for (let k = 2; k < mags.length - 2; k++) {
    if (mags[k] > mags[k - 1] && mags[k] >= mags[k + 1] && mags[k] > mags[k - 2]) {
      peaks.push({ hz: (k * sampleRate) / bins, mag: mags[k] });
    }
  }
  return peaks;
}

export function estimateFormants(samples, sampleRate) {
  const width = Math.min(samples.length, 2048);
  const start = Math.max(0, Math.floor((samples.length - width) / 2));
  const frame = new Float64Array(width);
  for (let i = 0; i < width; i++) {
    const previous = i === 0 ? 0 : samples[start + i - 1];
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (width - 1));
    frame[i] = (samples[start + i] - 0.97 * previous) * window;
  }
  const coefficients = lpcCoefficients(frame, 16);
  const peaks = envelopePeaks(coefficients, sampleRate).filter(peak => peak.hz >= 200 && peak.hz <= 3800);
  peaks.sort((a, b) => a.hz - b.hz);
  const f1 = peaks[0]?.hz ?? NaN;
  let f2 = peaks[1]?.hz ?? NaN;
  if (!Number.isFinite(f2)) f2 = f1;
  return { f1, f2, peaks };
}

export function frameF0s(samples, sampleRate, minimumConfidence = 0.8) {
  const win = Math.floor(sampleRate * 0.05);
  const hop = Math.floor(sampleRate * 0.025);
  const values = [];
  for (let i = 0; i + win <= samples.length; i += hop) {
    const estimate = estimateF0(samples.subarray(i, i + win), sampleRate);
    if (estimate.confidence >= minimumConfidence && estimate.hz > 0) values.push(estimate.hz);
  }
  return values;
}

export function zeroCrossingRate(samples) {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) crossings += 1;
  }
  return crossings / samples.length;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function variation(values) {
  if (values.length < 3) return 0;
  const mid = median(values);
  if (!Number.isFinite(mid) || mid <= 0) return 0;
  let sum = 0;
  for (const value of values) sum += Math.abs(value - mid);
  return sum / values.length / mid;
}

/** Acoustic summary used to prove the corpus, not as the coach's analyzer. */
export function measureClip(samples, sampleRate = SAMPLE_RATE) {
  const margin = Math.floor(sampleRate * 0.08);
  const body = samples.subarray(margin, Math.max(margin + 1, samples.length - margin));
  const whole = estimateF0(body, sampleRate);
  const track = frameF0s(body, sampleRate, 0.8);
  const formants = estimateFormants(body, sampleRate);
  const head = estimateF0(body.subarray(0, Math.floor(body.length * 0.35)), sampleRate);
  const tail = estimateF0(body.subarray(Math.floor(body.length * 0.78)), sampleRate);
  const dropSemitones = head.confidence >= 0.55 && tail.confidence >= 0.55 && head.hz > 0 && tail.hz > 0
    ? 12 * Math.log2(head.hz / tail.hz)
    : 0;
  const stable = track.filter(hz => hz > 70 && hz < 450);
  return {
    f0: median(stable) || whole.hz,
    confidence: whole.confidence,
    rms: whole.rms,
    f1: formants.f1,
    f2: formants.f2,
    f0Variation: variation(stable),
    zeroCrossings: zeroCrossingRate(body),
    dropSemitones,
    voicedFrames: stable.length
  };
}
