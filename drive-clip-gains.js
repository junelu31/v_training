// Playback levels for Drive. Clips stay as baked. This module turns the offline
// measurement into a per-clip gain. Hot clips come down to the speech target.
// A clip is not made louder unless it is more than GAIN_BOOST_BELOW_DB under
// that target, and a boost stops at the target. True peak stays at or under
// the ceiling. The microphone graph is not touched.

import { CLIP_LEVELS, RMS_TO_LUFS_OFFSET } from './drive-clip-levels.js';

export const SPEECH_TARGET_LUFS = -23;
export const TRUE_PEAK_CEILING_DBTP = -3;
// Unity gain unless the clip is more than this far under the target.
export const GAIN_BOOST_BELOW_DB = 3;
export const BREATH_UNDER_DB = 12;
// Integrated loudness at or under this is the EBU gate floor, not a real level.
export const LUFS_GATE_FLOOR = -40;
// Device speech used to sit at the peak ceiling against a -20 LUFS map.
const DEVICE_SPEECH_MAP_LUFS = -20;

export function linearFromDb(db) {
  return 10 ** (db / 20);
}

export function dbFromLinear(linear) {
  return 20 * Math.log10(Math.max(linear, 1e-12));
}

/**
 * Decibels to apply. Integrated LUFS when the meter could gate the clip,
 * otherwise RMS shifted by the speech offset measured from the gated clips.
 * Gain stays at unity or below unless the clip is more than 3 dB under the
 * target, in which case it may rise only as far as the target. It is reduced
 * again when it would push the true peak over the ceiling.
 */
export function playbackGainDb({ lufs, truePeakDb, rmsDb } = {}) {
  const gated = Number.isFinite(lufs) && lufs > LUFS_GATE_FLOOR;
  const estimate = gated ? lufs : (Number.isFinite(rmsDb) ? rmsDb + RMS_TO_LUFS_OFFSET : SPEECH_TARGET_LUFS);
  let gainDb = SPEECH_TARGET_LUFS - estimate;
  const mayBoost = estimate < SPEECH_TARGET_LUFS - GAIN_BOOST_BELOW_DB;
  if (!mayBoost && gainDb > 0) gainDb = 0;
  if (Number.isFinite(truePeakDb)) {
    const peaked = truePeakDb + gainDb;
    if (peaked > TRUE_PEAK_CEILING_DBTP) gainDb -= peaked - TRUE_PEAK_CEILING_DBTP;
  }
  return gainDb;
}

export function clipPlaybackGain(path) {
  const row = CLIP_LEVELS[path];
  if (!row) return 1;
  return linearFromDb(playbackGainDb({ lufs: row[0], truePeakDb: row[1], rmsDb: row[2] }));
}

/** Linear gain for a decoded buffer that has no offline measurement (cloud TTS). */
export function gainForBuffer(buffer) {
  if (typeof buffer?.getChannelData !== 'function' || !(buffer.length > 0)) return 1;
  const channels = buffer.numberOfChannels || 1;
  let energy = 0;
  let count = 0;
  let peak = 0;
  for (let channel = 0; channel < channels; channel++) {
    const samples = buffer.getChannelData(channel);
    if (!samples) continue;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      energy += sample * sample;
      count += 1;
      const mag = Math.abs(sample);
      if (mag > peak) peak = mag;
    }
  }
  if (!count || energy <= 0 || peak <= 0) return 1;
  return linearFromDb(playbackGainDb({
    lufs: LUFS_GATE_FLOOR,
    truePeakDb: dbFromLinear(peak),
    rmsDb: dbFromLinear(Math.sqrt(energy / count))
  }));
}

/** A copy at the playback gain. The cached decode and the mic buffer stay as they are. */
export function scaleBuffer(ctx, buffer, linearGain) {
  if (!buffer || !(linearGain > 0) || Math.abs(linearGain - 1) < 1e-4) return buffer;
  if (typeof buffer.getChannelData !== 'function' || typeof ctx?.createBuffer !== 'function') return buffer;
  const rate = buffer.sampleRate || ctx.sampleRate;
  if (rate !== ctx.sampleRate || !(buffer.length > 0)) return buffer;
  const channels = buffer.numberOfChannels || 1;
  let mixed;
  try { mixed = ctx.createBuffer(channels, buffer.length, rate); }
  catch { return buffer; }
  if (typeof mixed?.getChannelData !== 'function') return buffer;
  for (let channel = 0; channel < channels; channel++) {
    const src = buffer.getChannelData(channel);
    const out = mixed.getChannelData(channel);
    if (!src || !out || out.length < src.length) return buffer;
    for (let i = 0; i < src.length; i++) {
      const sample = src[i] * linearGain;
      out[i] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    }
  }
  return mixed;
}

// Device speech has no samples to measure. Volume 1 is full scale, about 3 dB
// over the peak ceiling on the old -20 LUFS map. This target is quieter, so
// the utterance volume comes down by the same amount.
export const DEVICE_SPEECH_VOLUME = linearFromDb(
  TRUE_PEAK_CEILING_DBTP + (SPEECH_TARGET_LUFS - DEVICE_SPEECH_MAP_LUFS)
);
