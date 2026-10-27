import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRACTICE_CLIPS, VOICE_CLIPS } from '../drive-voice-clips.js';
import { CLIP_LEVELS, LOUDNESS_BEFORE, RMS_TO_LUFS_OFFSET } from '../drive-clip-levels.js';
import {
  DEVICE_SPEECH_VOLUME,
  LUFS_GATE_FLOOR,
  SPEECH_TARGET_LUFS,
  TRUE_PEAK_CEILING_DBTP,
  clipPlaybackGain,
  dbFromLinear,
  gainForBuffer,
  playbackGainDb,
  scaleBuffer
} from '../drive-clip-gains.js';

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
}

test('every Drive clip has a playback gain, and the result stays under the peak ceiling', () => {
  const files = new Set([...Object.values(VOICE_CLIPS), ...Object.values(PRACTICE_CLIPS)]);
  assert.ok(files.size > 1000);
  const after = [];
  const peaks = [];
  for (const file of files) {
    const row = CLIP_LEVELS[file];
    assert.ok(row, `no level for ${file}`);
    const [lufs, truePeak, rms] = row;
    const gainDb = playbackGainDb({ lufs, truePeakDb: truePeak, rmsDb: rms });
    const linear = clipPlaybackGain(file);
    assert.ok(Number.isFinite(linear) && linear > 0.4 && linear < 2.5, `${file} gain ${linear}`);
    assert.ok(Math.abs(linear - 10 ** (gainDb / 20)) < 1e-9);
    const estimate = lufs > LUFS_GATE_FLOOR ? lufs : rms + RMS_TO_LUFS_OFFSET;
    after.push(estimate + gainDb);
    peaks.push(truePeak + gainDb);
  }
  assert.ok(Math.max(...peaks) <= TRUE_PEAK_CEILING_DBTP + 0.05);
  assert.ok(Math.max(...after) <= SPEECH_TARGET_LUFS + 0.05);
  assert.ok(Math.max(...after) - Math.min(...after) < LOUDNESS_BEFORE.lufsMax - LOUDNESS_BEFORE.lufsMin);
  assert.ok(percentile(after, 50) <= SPEECH_TARGET_LUFS + 0.05);
  assert.equal(SPEECH_TARGET_LUFS, -20);
  assert.equal(TRUE_PEAK_CEILING_DBTP, -3);
});

test('a cloud clip with no baked measurement is gained to the same target', () => {
  const stored = new Float32Array(4800).fill(0.2);
  const buffer = {
    length: stored.length,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => stored
  };
  const gain = gainForBuffer(buffer);
  const ctx = {
    sampleRate: 48000,
    createBuffer(_channels, length, rate) {
      const out = new Float32Array(length);
      return { length, sampleRate: rate, numberOfChannels: 1, duration: length / rate, getChannelData: () => out };
    }
  };
  const scaled = scaleBuffer(ctx, buffer, gain);
  let peak = 0;
  let energy = 0;
  const samples = scaled.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
    energy += samples[i] * samples[i];
  }
  assert.ok(dbFromLinear(peak) <= TRUE_PEAK_CEILING_DBTP + 0.05);
  const rmsDb = dbFromLinear(Math.sqrt(energy / samples.length));
  assert.ok(Math.abs(rmsDb + RMS_TO_LUFS_OFFSET - SPEECH_TARGET_LUFS) < 0.2 || dbFromLinear(peak) <= TRUE_PEAK_CEILING_DBTP + 0.05);
  assert.ok(Math.abs(stored[0] - 0.2) < 1e-5);
  assert.ok(Math.abs(DEVICE_SPEECH_VOLUME - 10 ** (TRUE_PEAK_CEILING_DBTP / 20)) < 1e-9);
});

test('playback gain does not sit on the microphone graph', () => {
  const source = readFileSync(new URL('../drive-ui.js', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('function startBuffer'), source.indexOf('// \'played\' reached the speaker'));
  assert.equal(start.includes('createGain'), false);
  assert.match(start, /source\.connect\(ctx\.destination\)/);
  assert.match(source, /output\[0\] = 1e-4/);
  assert.match(source, /clipPlaybackGain\(url\)/);
  assert.match(source, /gainForBuffer\(buffer\)/);
});
