import { spectralBalance } from './voice-metrics.js';

export const SAMPLE_RATE = 16000;
const FRAME = 1024;
const HOP = 320;
const MIN_HZ = 95;
const MAX_HZ = 460;

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function highpass(input, sampleRate, cutoff = 85) {
  const q = Math.SQRT1_2;
  const w0 = 2 * Math.PI * cutoff / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

export function precondition(samples, sampleRate) {
  return highpass(highpass(samples, sampleRate, 85), sampleRate, 85);
}

function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const ang = step * k;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * wr - im[i + k + half] * wi;
        const vi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
      }
    }
  }
}

function magnitudeDb(frame) {
  const n = 512;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const offset = Math.max(0, Math.floor((frame.length - n) / 2));
  for (let i = 0; i < n && offset + i < frame.length; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = frame[offset + i] * w;
  }
  fftRadix2(re, im);
  const bins = n / 2;
  const db = new Float32Array(bins);
  for (let i = 0; i < bins; i++) db[i] = 20 * Math.log10(Math.max(Math.hypot(re[i], im[i]) / n, 1e-10));
  return db;
}

function spectralFlatness(db) {
  let logSum = 0;
  let linSum = 0;
  let count = 0;
  for (let i = 2; i < db.length; i++) {
    const power = 10 ** (Math.min(db[i], 0) / 10);
    if (power <= 0) continue;
    logSum += Math.log(power);
    linSum += power;
    count++;
  }
  if (!count || linSum <= 0) return 1;
  return Math.exp(logSum / count) / (linSum / count);
}

function spectralTilt(db, sampleRate) {
  const binHz = sampleRate / (db.length * 2);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 1; i < db.length; i++) {
    const hz = i * binHz;
    if (hz < 250 || hz > 4000 || !Number.isFinite(db[i]) || db[i] < -80) continue;
    const x = Math.log2(hz);
    const y = db[i];
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  if (n < 8) return NaN;
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-6) return NaN;
  return (n * sxy - sx * sy) / denom;
}

function interpDb(db, sampleRate, hz) {
  if (!Number.isFinite(hz) || hz <= 0) return NaN;
  const binHz = sampleRate / (db.length * 2);
  const pos = hz / binHz;
  const i = Math.floor(pos);
  if (i < 1 || i + 1 >= db.length) return NaN;
  const frac = pos - i;
  return db[i] * (1 - frac) + db[i + 1] * frac;
}

function harmonicScore(db, sampleRate, hz) {
  if (!Number.isFinite(hz) || hz < MIN_HZ) return 0;
  let peaks = 0;
  let valleys = 0;
  for (let h = 1; h <= 4; h++) {
    const at = interpDb(db, sampleRate, hz * h);
    const beside = interpDb(db, sampleRate, hz * h * 1.18);
    if (!Number.isFinite(at) || !Number.isFinite(beside)) continue;
    peaks += at;
    valleys += beside;
  }
  return peaks - valleys;
}

export function estimatePitch(frame, sampleRate) {
  const n = frame.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  const centered = new Float32Array(n);
  let energy = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const emphasized = frame[i] - mean - 0.97 * prev;
    prev = frame[i] - mean;
    centered[i] = emphasized;
    energy += emphasized * emphasized;
  }
  const rms = Math.sqrt(energy / n);
  if (rms < 0.004) return { hz: NaN, confidence: 0, rms: Math.sqrt(frame.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n), subharm: 0 };
  const rawRms = Math.sqrt(frame.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n);
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxLag = Math.min(Math.floor(sampleRate / MIN_HZ), Math.floor(n / 2) - 2);
  let bestLag = -1;
  let best = 0;
  const corr = new Float32Array(maxLag + 3);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let cross = 0, left = 0, right = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i += 2) {
      const a = centered[i];
      const b = centered[i + lag];
      cross += a * b;
      left += a * a;
      right += b * b;
    }
    const score = left && right ? cross / Math.sqrt(left * right) : 0;
    corr[lag] = score;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || best < 0.42) return { hz: NaN, confidence: best, rms: rawRms, subharm: 0 };
  const lag = bestLag;
  const before = corr[lag - 1] || best;
  const after = corr[lag + 1] || best;
  const denom = before - 2 * best + after;
  const refined = lag + (denom ? 0.5 * (before - after) / denom : 0);
  const hz = sampleRate / refined;
  const halfLag = Math.round(refined / 2);
  const subharm = halfLag >= minLag ? (corr[halfLag] || 0) / Math.max(best, 1e-6) : 0;
  return { hz, confidence: best, rms: rawRms, subharm };
}

function lpcCoeffs(frame, order) {
  const n = frame.length;
  const r = new Float64Array(order + 1);
  for (let i = 0; i < n; i++) {
    const x = frame[i];
    r[0] += x * x;
    for (let k = 1; k <= order && i + k < n; k++) r[k] += x * frame[i + k];
  }
  if (r[0] < 1e-8) return null;
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  const tmp = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    for (let j = 1; j < i; j++) tmp[j] = a[j] + k * a[i - j];
    tmp[i] = k;
    for (let j = 1; j <= i; j++) a[j] = tmp[j];
    err *= 1 - k * k;
    if (err <= 1e-9) break;
  }
  return a;
}

function formantPeaks(frame, sampleRate) {
  const pre = new Float32Array(frame.length);
  let prev = 0;
  for (let i = 0; i < frame.length; i++) {
    pre[i] = frame[i] - 0.97 * prev;
    prev = frame[i];
  }
  const a = lpcCoeffs(pre, 12);
  if (!a) return { f1: NaN, f2: NaN, f3: NaN, vtl: NaN };
  const bins = 512;
  const env = new Float64Array(bins);
  for (let i = 1; i < bins; i++) {
    const w = Math.PI * i / bins;
    let re = 0, im = 0;
    for (let k = 0; k < a.length; k++) {
      re += a[k] * Math.cos(w * k);
      im -= a[k] * Math.sin(w * k);
    }
    env[i] = -Math.log(Math.max(Math.hypot(re, im), 1e-8));
  }
  const peaks = [];
  for (let i = 4; i < bins - 4; i++) {
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    const prom = env[i] - Math.min(env[i - 4], env[i + 4]);
    const hz = (i / bins) * (sampleRate / 2);
    if (prom > 0.045 && hz >= 220 && hz <= 4400) peaks.push(hz);
  }
  let f1 = NaN;
  let f2 = NaN;
  let f3 = NaN;
  for (const hz of peaks) {
    if (!Number.isFinite(f1) && hz >= 220 && hz <= 950) {
      f1 = hz;
      continue;
    }
    if (Number.isFinite(f1) && !Number.isFinite(f2) && hz >= Math.max(850, f1 + 280) && hz <= 2700) {
      f2 = hz;
      continue;
    }
    if (Number.isFinite(f2) && !Number.isFinite(f3) && hz >= f2 + 350 && hz <= 4200) {
      f3 = hz;
      break;
    }
  }
  let vtl = NaN;
  if (Number.isFinite(f1) && Number.isFinite(f3) && f3 > f1 + 500) vtl = 35000 / (f3 - f1);
  return { f1, f2, f3, vtl };
}

function bandMeanDb(db, sampleRate, lo, hi) {
  const binHz = sampleRate / (db.length * 2);
  let sum = 0;
  let count = 0;
  for (let i = 1; i < db.length; i++) {
    const hz = i * binHz;
    if (hz < lo || hz >= hi || db[i] < -95) continue;
    sum += db[i];
    count++;
  }
  return count ? sum / count : NaN;
}

function spectralCentroid(db, sampleRate) {
  const binHz = sampleRate / (db.length * 2);
  let weighted = 0;
  let weight = 0;
  for (let i = 1; i < db.length; i++) {
    const hz = i * binHz;
    if (hz < 200 || hz > 4000) continue;
    const power = 10 ** (Math.min(db[i], 0) / 10);
    weighted += hz * power;
    weight += power;
  }
  return weight > 0 ? weighted / weight : NaN;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

export function median(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return NaN;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function analyzePcm(samples, sampleRate = SAMPLE_RATE) {
  const filtered = precondition(samples, sampleRate);
  const rough = [];
  for (let start = 0; start + FRAME <= filtered.length; start += HOP) {
    let energy = 0;
    for (let i = start; i < start + FRAME; i++) energy += filtered[i] * filtered[i];
    rough.push(Math.sqrt(energy / FRAME));
  }
  const noiseFloor = Math.max(percentile(rough, 0.08), 1e-5);
  const frames = [];
  let previousHz = NaN;
  let index = 0;
  for (let start = 0; start + FRAME <= filtered.length; start += HOP, index++) {
    const buf = filtered.subarray(start, start + FRAME);
    const pitch = estimatePitch(buf, sampleRate);
    const db = magnitudeDb(buf);
    const flatness = spectralFlatness(db);
    const tilt = spectralTilt(db, sampleRate);
    const bright = spectralBalance(db, sampleRate, Number.isFinite(pitch.hz) ? pitch.hz : 180);
    const h1 = interpDb(db, sampleRate, pitch.hz);
    const h2 = interpDb(db, sampleRate, pitch.hz * 2);
    const h1h2 = Number.isFinite(h1) && Number.isFinite(h2) ? h1 - h2 : NaN;
    const support = harmonicScore(db, sampleRate, pitch.hz);
    const snr = 20 * Math.log10(Math.max(pitch.rms, 1e-5) / noiseFloor);
    const jitter = Number.isFinite(previousHz) && Number.isFinite(pitch.hz) && previousHz > 0
      ? Math.abs(pitch.hz - previousHz) / previousHz
      : 0;
    const low = bandMeanDb(db, sampleRate, 250, 900);
    const high = bandMeanDb(db, sampleRate, 1300, 3400);
    const resonance = Number.isFinite(low) && Number.isFinite(high) ? high - low : NaN;
    const centroid = spectralCentroid(db, sampleRate);
    const harmonicOk = pitch.confidence >= 0.48 && flatness < 0.62 && support > 1.5 && snr > 2.5;
    const voiced = harmonicOk && Number.isFinite(pitch.hz) && pitch.hz >= MIN_HZ && pitch.hz <= MAX_HZ;
    let fry = 0;
    if (voiced && pitch.hz < 155) {
      if (jitter > 0.04) fry += 0.45;
      if (pitch.subharm > 0.7) fry += 0.35;
      if (pitch.confidence < 0.7) fry += 0.3;
    }
    fry = Math.min(1, fry);
    const formants = voiced ? formantPeaks(buf, sampleRate) : { f1: NaN, f2: NaN, f3: NaN, vtl: NaN };
    if (voiced) previousHz = pitch.hz;
    frames.push({
      t: (start + FRAME / 2) / sampleRate,
      rms: pitch.rms,
      hz: voiced ? pitch.hz : NaN,
      confidence: pitch.confidence,
      flatness,
      brightness: Number.isFinite(bright) ? bright : NaN,
      tilt: Number.isFinite(tilt) ? tilt : NaN,
      h1h2: Number.isFinite(h1h2) ? h1h2 : NaN,
      f1: formants.f1,
      f2: formants.f2,
      f3: formants.f3,
      vtl: formants.vtl,
      resonance: Number.isFinite(resonance) ? resonance : NaN,
      centroid: Number.isFinite(centroid) ? centroid : NaN,
      fry,
      snr,
      voiced,
      support,
      unstable: !voiced && pitch.rms > 0.025 && pitch.confidence > 0.12 && pitch.confidence < 0.42 && flatness < 0.08 && snr > 8 && snr < 32
    });
  }
  const speechRms = frames.filter(frame => frame.voiced).map(frame => frame.rms);
  const speechLevel = median(speechRms);
  const snrDb = Number.isFinite(speechLevel) ? 20 * Math.log10(Math.max(speechLevel, 1e-5) / noiseFloor) : -20;
  const voicedFraction = frames.length ? frames.filter(frame => frame.voiced).length / frames.length : 0;
  return { frames, noiseFloor, snrDb, voicedFraction, filtered };
}

export const TURN = {
  minVoicedMs: 100,
  endSilenceMs: 560,
  minTurnMs: 450,
  maxTurnSec: 12,
  snrCoachMin: 5.15,
  preRollMs: 180
};

export function createTurnDetector({ sampleRate = SAMPLE_RATE, onTurn } = {}) {
  const filteredRing = new Float32Array(FRAME);
  let ringCount = 0;
  const utterance = new Float32Array(sampleRate * TURN.maxTurnSec);
  let uttLen = 0;
  const preRoll = new Float32Array(Math.floor(sampleRate * TURN.preRollMs / 1000));
  let prePos = 0;
  let preFilled = 0;
  const biquads = [biquad(sampleRate, 85), biquad(sampleRate, 85)];
  const hopA = new Float32Array(HOP);
  const hopB = new Float32Array(HOP);
  let pending = hopA;
  let pendingN = 0;
  const frame = new Float32Array(FRAME);
  const filteredHop = new Float32Array(HOP);
  let voicedMs = 0;
  let quietMs = 0;
  let inSpeech = false;
  let speaking = false;
  let guardSamples = 0;
  let noise = 0.004;
  let rawNoise = 0.004;
  let rawAmbient = 0.004;
  const hopRms = new Float32Array(Math.ceil(sampleRate * TURN.maxTurnSec / HOP));
  let hopCount = 0;
  let turns = 0;
  const hopMs = (HOP / sampleRate) * 1000;

  function classifyHop(hopSamples) {
    for (let i = 0; i < hopSamples.length; i++) {
      filteredRing[ringCount % FRAME] = hopSamples[i];
      ringCount++;
    }
    if (ringCount < FRAME) return { voiced: false, rms: 0 };
    const start = ringCount % FRAME;
    for (let i = 0; i < FRAME; i++) frame[i] = filteredRing[(start + i) % FRAME];
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += frame[i] * frame[i];
    const rms = Math.sqrt(energy / FRAME);
    if (rms < noise * 1.45) {
      noise = noise * 0.96 + rms * 0.04;
      return { voiced: false, rms };
    }
    const pitch = estimatePitch(frame, sampleRate);
    const db = magnitudeDb(frame);
    const flatness = spectralFlatness(db);
    const support = harmonicScore(db, sampleRate, pitch.hz);
    const snr = 20 * Math.log10(Math.max(rms, 1e-5) / Math.max(noise, 1e-4));
    const voiced = pitch.confidence >= 0.48 && flatness < 0.62 && support > 1.5 && snr > 2.5 &&
      Number.isFinite(pitch.hz) && pitch.hz >= MIN_HZ && pitch.hz <= MAX_HZ;
    if (!voiced) noise = noise * 0.985 + rms * 0.015;
    else noise = noise * 0.998 + rms * 0.002;
    return { voiced, rms };
  }

  function appendUtterance(hopSamples) {
    const room = utterance.length - uttLen;
    const n = Math.min(room, hopSamples.length);
    utterance.set(hopSamples.subarray(0, n), uttLen);
    uttLen += n;
  }

  function finish(reason) {
    if (!inSpeech) return;
    inSpeech = false;
    const samples = utterance.slice(0, uttLen);
    const duration = uttLen / sampleRate;
    const levels = hopRms.slice(0, hopCount);
    hopCount = 0;
    uttLen = 0;
    voicedMs = 0;
    quietMs = 0;
    if (duration < TURN.minTurnMs / 1000) return;
    const analysis = analyzePcm(samples, sampleRate);
    const speechLevel = percentile(Array.from(levels), 0.62);
    const trackerSnr = speechLevel > 0 ? 20 * Math.log10(Math.max(speechLevel, 1e-5) / Math.max(rawAmbient, 1e-5)) : -20;
    const snrDb = trackerSnr;
    const tooNoisy = !(snrDb >= TURN.snrCoachMin) || analysis.voicedFraction < 0.12;
    const speechLike = analysis.frames.some(frame => frame.voiced) && analysis.voicedFraction >= 0.08 && duration >= TURN.minTurnMs / 1000;
    if (!speechLike) return;
    turns++;
    onTurn?.({ samples, sampleRate, duration, reason, ...analysis, snrDb, trackerSnr, tooNoisy });
  }

  return {
    push(chunk) {
      if (!chunk?.length) return;
      if (speaking || guardSamples > 0) {
        guardSamples = Math.max(0, guardSamples - chunk.length);
        if (inSpeech) finish('muted');
        return;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(HOP - pendingN, chunk.length - offset);
        pending.set(chunk.subarray(offset, offset + take), pendingN);
        pendingN += take;
        offset += take;
        if (pendingN < HOP) break;
        const raw = pending;
        pending = pending === hopA ? hopB : hopA;
        pendingN = 0;
        for (let i = 0; i < HOP; i++) {
          let y = raw[i];
          for (const filter of biquads) y = filter.step(y);
          filteredHop[i] = y;
          preRoll[prePos] = raw[i];
          prePos = (prePos + 1) % preRoll.length;
          preFilled = Math.min(preRoll.length, preFilled + 1);
        }
        let rawEnergy = 0;
        for (let i = 0; i < HOP; i++) rawEnergy += raw[i] * raw[i];
        const rawRms = Math.sqrt(rawEnergy / HOP);
        if (!inSpeech) rawNoise = rawRms < rawNoise * 1.8 ? rawNoise * 0.9 + rawRms * 0.1 : rawNoise * 0.98 + rawRms * 0.02;
        const decision = classifyHop(filteredHop);
        if (!inSpeech) {
          if (decision.voiced) {
            voicedMs += hopMs;
            if (voicedMs >= TURN.minVoicedMs) {
              inSpeech = true;
              quietMs = 0;
              rawAmbient = Math.max(rawNoise, 1e-4);
              const pre = Math.min(preFilled, preRoll.length);
              for (let i = 0; i < pre; i++) {
                const value = preRoll[(prePos - pre + i + preRoll.length) % preRoll.length];
                if (uttLen < utterance.length) utterance[uttLen++] = value;
              }
            }
          } else voicedMs = Math.max(0, voicedMs - hopMs);
        } else {
          appendUtterance(raw);
          if (hopCount < hopRms.length) hopRms[hopCount++] = rawRms;
          if (decision.voiced) quietMs = 0;
          else quietMs += hopMs;
          if (quietMs >= TURN.endSilenceMs) finish('silence');
          else if (uttLen >= utterance.length - HOP) finish('max');
        }
      }
    },
    setSpeaking(active) {
      speaking = !!active;
      if (speaking) {
        guardSamples = Math.floor(sampleRate * 0.28);
        if (inSpeech) finish('muted');
      } else guardSamples = Math.floor(sampleRate * 0.28);
    },
    interrupt() {
      speaking = true;
      guardSamples = sampleRate;
      if (inSpeech) finish('interrupt');
    },
    resume() {
      speaking = false;
      guardSamples = Math.floor(sampleRate * 0.2);
      voicedMs = 0;
      quietMs = 0;
    },
    reset() {
      inSpeech = false;
      uttLen = 0;
      voicedMs = 0;
      quietMs = 0;
      speaking = false;
      guardSamples = 0;
    },
    stats() {
      return { turns, inSpeech, speaking, utteranceSamples: uttLen, bufferCap: utterance.length };
    }
  };
}

function biquad(sampleRate, cutoff) {
  const q = Math.SQRT1_2;
  const w0 = 2 * Math.PI * cutoff / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    step(x0) {
      const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      return y0;
    }
  };
}

export function detectTurns(samples, sampleRate = SAMPLE_RATE) {
  const turns = [];
  const detector = createTurnDetector({
    sampleRate,
    onTurn: turn => turns.push(turn)
  });
  const chunk = 1600;
  for (let i = 0; i < samples.length; i += chunk) detector.push(samples.subarray(i, i + chunk));
  detector.push(new Float32Array(sampleRate));
  return turns;
}

export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const outLen = Math.max(1, Math.round(input.length * toRate / fromRate));
  const out = new Float32Array(outLen);
  const scale = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * scale;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[Math.min(j, input.length - 1)] || 0;
    const b = input[Math.min(j + 1, input.length - 1)] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function makeRoadNoise(seconds, sampleRate = SAMPLE_RATE, seed = 7) {
  const rand = mulberry32(seed);
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    const white = rand() * 2 - 1;
    brown = (brown + 0.02 * white) / 1.02;
    const t = i / sampleRate;
    const swell = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.28 * t);
    const rumble = Math.sin(2 * Math.PI * 86 * t) * 0.18;
    out[i] = (brown * 1.4 + white * 0.08 + rumble) * swell;
  }
  return normalizeRms(out, 0.03);
}

export function normalizeRms(samples, target) {
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  if (rms < 1e-8) return samples;
  const gain = target / rms;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

export function mixAtSnr(speech, noise, snrDb) {
  const n = Math.min(speech.length, noise.length);
  let speechEnergy = 0;
  let noiseEnergy = 0;
  for (let i = 0; i < n; i++) {
    speechEnergy += speech[i] * speech[i];
    noiseEnergy += noise[i] * noise[i];
  }
  const speechRms = Math.sqrt(speechEnergy / n);
  const noiseRms = Math.sqrt(noiseEnergy / n) || 1e-6;
  const targetNoise = speechRms / (10 ** (snrDb / 20));
  const gain = targetNoise / noiseRms;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = speech[i] + noise[i] * gain;
  return out;
}

function resonator(f, bw, sampleRate) {
  const r = Math.exp(-Math.PI * bw / sampleRate);
  const a1 = -2 * r * Math.cos((2 * Math.PI * f) / sampleRate);
  const a2 = r * r;
  return { a1, a2, y1: 0, y2: 0, step(x) { const y = x - this.a1 * this.y1 - this.a2 * this.y2; this.y2 = this.y1; this.y1 = y; return y; } };
}

export function synthesizeWords(words, sampleRate = SAMPLE_RATE) {
  const pieces = [];
  const timings = [];
  let at = 0;
  for (const word of words) {
    const ms = word.ms || 280;
    const n = Math.floor(sampleRate * ms / 1000);
    const samples = new Float32Array(n);
    const f1 = resonator(word.f1 || 450, word.bw1 || 80, sampleRate);
    const f2 = resonator(word.f2 || 1700, word.bw2 || 110, sampleRate);
    const f3 = resonator(word.f3 || 2700, word.bw3 || 150, sampleRate);
    const f0Start = word.f0 ?? 185;
    const f0End = word.f0End ?? f0Start;
    let phase = 0;
    const rand = mulberry32(word.seed || (word.text || 'w').length * 97);
    for (let i = 0; i < n; i++) {
      const t = n <= 1 ? 0 : i / (n - 1);
      const env = Math.sin(Math.PI * Math.min(1, t * 1.05)) ** 0.6;
      let f0 = f0Start + (f0End - f0Start) * t;
      if (word.jitter) f0 *= 1 + (rand() - 0.5) * word.jitter;
      phase += (2 * Math.PI * f0) / sampleRate;
      let excitation = 0;
      if (word.fry && rand() < 0.35) excitation = rand() < 0.5 ? 1 : 0.2;
      else excitation = phase % (2 * Math.PI) < (2 * Math.PI * f0 / sampleRate) ? 1 : 0;
      if (word.press) excitation += 0.85 * Math.sin(2 * phase);
      const y = f1.step(excitation) * 0.06 + f2.step(excitation) * (word.f2Gain ?? 0.035) + f3.step(excitation) * 0.02;
      const tiltMix = word.tiltMix ?? 0.25;
      samples[i] = (y * (1 - tiltMix) + excitation * tiltMix * 0.15) * env * (word.gain ?? 0.35);
    }
    const silenceN = Math.floor(sampleRate * (word.gapMs ?? 70) / 1000);
    pieces.push(samples, new Float32Array(silenceN));
    timings.push({ text: word.text, start: at / sampleRate, end: (at + n) / sampleRate });
    at += n + silenceN;
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const piece of pieces) {
    samples.set(piece, offset);
    offset += piece.length;
  }
  return { samples: normalizeRms(samples, 0.06), timings };
}
