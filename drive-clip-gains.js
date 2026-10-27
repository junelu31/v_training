// Playback levels for Drive. Clips stay as baked. This module turns the offline
// measurement into a per-clip gain so speech lands near one loudness, with the
// true peak held at or under the ceiling. The microphone graph is not touched.

import { CLIP_LEVELS, RMS_TO_LUFS_OFFSET } from './drive-clip-levels.js';

export const SPEECH_TARGET_LUFS = -20;
export const TRUE_PEAK_CEILING_DBTP = -3;
export const BREATH_UNDER_DB = 12;
// Integrated loudness at or under this is the EBU gate floor, not a real level.
export const LUFS_GATE_FLOOR = -40;

export function linearFromDb(db) {
  return 10 ** (db / 20);
}

export function dbFromLinear(linear) {
  return 20 * Math.log10(Math.max(linear, 1e-12));
}

/**
 * Decibels to apply. Integrated LUFS when the meter could gate the clip,
 * otherwise RMS shifted by the speech offset measured from the gated clips.
 * Gain is reduced when it would push the true peak over the ceiling.
 */
export function playbackGainDb({ lufs, truePeakDb, rmsDb } = {}) {
  const gated = Number.isFinite(lufs) && lufs > LUFS_GATE_FLOOR;
  const estimate = gated ? lufs : (Number.isFinite(rmsDb) ? rmsDb + RMS_TO_LUFS_OFFSET : SPEECH_TARGET_LUFS);
  let gainDb = SPEECH_TARGET_LUFS - estimate;
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

// Device speech has no samples to measure. Full scale sits about 3 dB over the ceiling.
export const DEVICE_SPEECH_VOLUME = linearFromDb(TRUE_PEAK_CEILING_DBTP);
