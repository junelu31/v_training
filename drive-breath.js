// A count-in inhale before a practice phrase. Shaped noise, not a voice:
// no xAI call, no baked clip. It is mixed onto the front of the phrase buffer
// so iPhone Safari still plays one destination source on the same keep-alive path.

export const BREATH_SECONDS = 0.55;
// A musician's count-in: the inhale finishes, then a short silence, then the phrase.
export const BREATH_GAP_SECONDS = 0.15;
// The cue sits this far under the phrase it introduces.
export const BREATH_UNDER_DB = 12;
export const BREATH_CUE_STORAGE_KEY = 'lilt-breath-cue';

export function readBreathCue(storage) {
  try {
    const value = storage?.getItem?.(BREATH_CUE_STORAGE_KEY);
    if (value == null || value === '') return true;
    return value !== '0' && value !== 'false';
  } catch {
    return true;
  }
}

export function writeBreathCue(storage, on) {
  try { storage?.setItem?.(BREATH_CUE_STORAGE_KEY, on ? '1' : '0'); }
  catch { /* this browser is not storing settings */ }
  return Boolean(on);
}

/** True only for the practice phrase itself, and only when the setting is on. */
export function shouldCueBreath(text, prompt, enabled = true) {
  return Boolean(enabled && prompt && text === prompt);
}

function unitNoise(state) {
  let next = Math.imul(state ^ (state >>> 16), 0x7feb352d);
  next = Math.imul(next ^ (next >>> 15), 0x846ca68b);
  next ^= next >>> 16;
  return { state: next >>> 0, value: (next >>> 0) / 4294967296 * 2 - 1 };
}

/** One inhale: quiet, louder, then silent so the phrase can start on the next sample. */
export function breathSamples(length, sampleRate) {
  const count = Math.max(0, length | 0);
  const out = new Float32Array(count);
  if (!count || !(sampleRate > 0)) return out;
  const hpA = Math.exp(-2 * Math.PI * 380 / sampleRate);
  const lpA = Math.exp(-2 * Math.PI * 3400 / sampleRate);
  let state = 0xa341316c;
  let hp = 0;
  let lp = 0;
  let prev = 0;
  let peak = 1e-8;
  const shaped = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const drawn = unitNoise(state);
    state = drawn.state;
    const x = drawn.value;
    hp = hpA * (hp + x - prev);
    prev = x;
    lp += (1 - lpA) * (hp - lp);
    const t = count === 1 ? 1 : i / (count - 1);
    const env = Math.sin(Math.PI * t) ** 1.2;
    shaped[i] = lp * env;
    const mag = Math.abs(shaped[i]);
    if (mag > peak) peak = mag;
  }
  const gain = 0.3 / peak;
  for (let i = 0; i < count; i++) out[i] = shaped[i] * gain;
  return out;
}

function rmsOf(samples) {
  if (!samples?.length) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  return Math.sqrt(energy / samples.length);
}

/** Scale the inhale so its RMS sits BREATH_UNDER_DB under the phrase, and under the peak ceiling. */
export function breathAtPhraseLevel(breath, phraseRms) {
  const current = rmsOf(breath);
  const target = phraseRms * 10 ** (-BREATH_UNDER_DB / 20);
  const out = new Float32Array(breath.length);
  if (!(current > 1e-8) || !(target > 0)) return out;
  const gain = target / current;
  let peak = 0;
  for (let i = 0; i < breath.length; i++) {
    out[i] = breath[i] * gain;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const ceiling = 10 ** (-3 / 20);
  if (peak > ceiling) {
    const trim = ceiling / peak;
    for (let i = 0; i < out.length; i++) out[i] *= trim;
  }
  return out;
}

/**
 * Inhale, a short silence, then the phrase, in one buffer.
 * phraseGain is the clip's playback gain, applied only to the phrase samples.
 * A test double with no channel data gets a longer duration instead of a second source.
 * A real buffer we cannot safely copy is returned unchanged.
 */
export function prependBreath(ctx, phrase, { phraseGain = 1 } = {}) {
  const rate = ctx?.sampleRate || phrase?.sampleRate || 48000;
  const breathFrames = Math.max(1, Math.round(rate * BREATH_SECONDS));
  const gapFrames = Math.max(0, Math.round(rate * BREATH_GAP_SECONDS));
  const phraseRate = phrase?.sampleRate || rate;
  const gain = phraseGain > 0 ? phraseGain : 1;
  const canCopy = typeof phrase?.getChannelData === 'function'
    && typeof ctx?.createBuffer === 'function'
    && phraseRate === rate
    && phrase.length > 0;
  if (!canCopy) {
    if (typeof phrase?.getChannelData === 'function') return phrase;
    return {
      duration: BREATH_SECONDS + BREATH_GAP_SECONDS + (Number(phrase?.duration) || 0),
      length: breathFrames + gapFrames + (phrase?.length || 0),
      numberOfChannels: phrase?.numberOfChannels || 1,
      sampleRate: rate
    };
  }
  const channels = phrase.numberOfChannels || 1;
  const total = breathFrames + gapFrames + phrase.length;
  let mixed;
  try { mixed = ctx.createBuffer(channels, total, rate); }
  catch { return phrase; }
  if (typeof mixed?.getChannelData !== 'function') {
    return {
      duration: BREATH_SECONDS + BREATH_GAP_SECONDS + (Number(phrase.duration) || phrase.length / rate),
      length: total,
      numberOfChannels: channels,
      sampleRate: rate
    };
  }
  const lead = phrase.getChannelData(0);
  if (!lead) return phrase;
  let energy = 0;
  for (let i = 0; i < lead.length; i++) {
    const sample = lead[i] * gain;
    energy += sample * sample;
  }
  const breath = breathAtPhraseLevel(breathSamples(breathFrames, rate), Math.sqrt(energy / lead.length));
  for (let channel = 0; channel < channels; channel++) {
    const out = mixed.getChannelData(channel);
    const src = phrase.getChannelData(channel);
    if (!out || out.length < total || !src) return phrase;
    out.set(breath, 0);
    const phraseAt = breathFrames + gapFrames;
    for (let i = 0; i < src.length; i++) out[phraseAt + i] = src[i] * gain;
  }
  return mixed;
}
