import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRACTICE_CLIPS, VOICE_CLIPS } from '../drive-voice-clips.js';
import { CLIP_LEVELS, LOUDNESS_BEFORE, RMS_TO_LUFS_OFFSET } from '../drive-clip-levels.js';
import {
  DEVICE_SPEECH_VOLUME,
  GAIN_BOOST_BELOW_DB,
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

test('every Drive clip has a playback gain, and hot clips come down without a blanket boost', () => {
  const files = new Set([...Object.values(VOICE_CLIPS), ...Object.values(PRACTICE_CLIPS)]);
  assert.ok(files.size > 1000);
  const after = [];
  const before = [];
  const peaks = [];
  const gains = [];
  let boosted = 0;
  let attenuated = 0;
  const boostBelow = SPEECH_TARGET_LUFS - GAIN_BOOST_BELOW_DB;
  for (const file of files) {
    const row = CLIP_LEVELS[file];
    assert.ok(row, `no level for ${file}`);
    const [lufs, truePeak, rms] = row;
    const gainDb = playbackGainDb({ lufs, truePeakDb: truePeak, rmsDb: rms });
    const linear = clipPlaybackGain(file);
    assert.ok(Number.isFinite(linear) && linear > 0 && linear < 10, `${file} gain ${linear}`);
    assert.ok(Math.abs(linear - 10 ** (gainDb / 20)) < 1e-9);
    const estimate = lufs > LUFS_GATE_FLOOR ? lufs : rms + RMS_TO_LUFS_OFFSET;
    if (estimate < boostBelow) {
      if (linear > 1) boosted += 1;
      assert.ok(estimate + gainDb <= SPEECH_TARGET_LUFS + 0.05);
    } else {
      assert.ok(linear <= 1.0000001, `${file} boosted from ${estimate}`);
    }
    if (estimate > SPEECH_TARGET_LUFS) {
      assert.ok(linear < 1, `${file} stays hot`);
      attenuated += 1;
    }
    before.push(estimate);
    after.push(estimate + gainDb);
    peaks.push(truePeak + gainDb);
    gains.push(linear);
  }
  assert.ok(attenuated > files.size / 2, 'most clips are hotter than the target and must come down');
  assert.ok(boosted < files.size / 10, 'boosts are only for the quiet tail');
  assert.ok(Math.min(...gains) < 1);
  assert.ok(Math.max(...peaks) <= TRUE_PEAK_CEILING_DBTP + 0.05);
  assert.ok(Math.max(...after) <= SPEECH_TARGET_LUFS + 0.05);
  assert.ok(Math.max(...after) - Math.min(...after) < LOUDNESS_BEFORE.lufsMax - LOUDNESS_BEFORE.lufsMin);
  assert.ok(percentile(after, 50) <= SPEECH_TARGET_LUFS + 0.05);
  assert.ok(percentile(after, 50) <= LOUDNESS_BEFORE.lufsP50);
  const beforeMean = before.reduce((sum, value) => sum + value, 0) / before.length;
  const afterMean = after.reduce((sum, value) => sum + value, 0) / after.length;
  assert.ok(afterMean <= beforeMean);
  assert.equal(SPEECH_TARGET_LUFS, -23);
  assert.equal(GAIN_BOOST_BELOW_DB, 3);
  assert.equal(TRUE_PEAK_CEILING_DBTP, -3);
});

test('baked feedback clips hotter than -23 LUFS are turned down, not boosted', () => {
  for (const file of ['voice/d9cba173.mp3', 'voice/bb90c751.mp3', 'voice/855211ec.mp3', 'voice/384b4806.mp3']) {
    const [lufs, truePeak, rms] = CLIP_LEVELS[file];
    assert.ok(lufs > SPEECH_TARGET_LUFS, file);
    const gainDb = playbackGainDb({ lufs, truePeakDb: truePeak, rmsDb: rms });
    assert.ok(clipPlaybackGain(file) < 1, file);
    assert.ok(clipPlaybackGain(file) <= 1, file);
    assert.ok(lufs + gainDb <= SPEECH_TARGET_LUFS + 0.05, file);
  }
});

test('a clip is boosted only when it is more than 3 dB under target, and only up to that target', () => {
  const safePeak = -20;
  assert.ok(Math.abs(playbackGainDb({ lufs: -22, truePeakDb: safePeak, rmsDb: -22 }) - (-1)) < 1e-9);
  assert.equal(playbackGainDb({ lufs: -24, truePeakDb: safePeak, rmsDb: -24 }), 0);
  assert.equal(playbackGainDb({ lufs: SPEECH_TARGET_LUFS - GAIN_BOOST_BELOW_DB, truePeakDb: safePeak, rmsDb: -26 }), 0);
  assert.ok(Math.abs(playbackGainDb({ lufs: -29, truePeakDb: safePeak, rmsDb: -29 }) - 6) < 1e-9);
  const peakLimited = playbackGainDb({ lufs: -35, truePeakDb: -4, rmsDb: -35 });
  assert.ok(Math.abs(peakLimited - 1) < 1e-9);
  assert.ok(Math.abs(playbackGainDb({ lufs: -24, truePeakDb: -1, rmsDb: -24 }) - (-2)) < 1e-9);
  const deviceDb = TRUE_PEAK_CEILING_DBTP + (SPEECH_TARGET_LUFS - (-20));
  assert.equal(deviceDb, -6);
  assert.ok(Math.abs(DEVICE_SPEECH_VOLUME - 10 ** (deviceDb / 20)) < 1e-9);
  assert.ok(DEVICE_SPEECH_VOLUME < 10 ** (TRUE_PEAK_CEILING_DBTP / 20));
});

function tone(level) {
  const stored = new Float32Array(4800).fill(level);
  return {
    stored,
    buffer: {
      length: stored.length,
      numberOfChannels: 1,
      sampleRate: 48000,
      getChannelData: () => stored
    }
  };
}

function play(buffer, gain) {
  const ctx = {
    sampleRate: 48000,
    createBuffer(_channels, length, rate) {
      const out = new Float32Array(length);
      return { length, sampleRate: rate, numberOfChannels: 1, duration: length / rate, getChannelData: () => out };
    }
  };
  return scaleBuffer(ctx, buffer, gain).getChannelData(0);
}

test('cloud speech uses the same gain rule, including the unity cap', () => {
  const hot = tone(0.2);
  const hotGain = gainForBuffer(hot.buffer);
  assert.ok(hotGain < 1);
  const hotOut = play(hot.buffer, hotGain);
  let peak = 0;
  let energy = 0;
  for (let i = 0; i < hotOut.length; i++) {
    peak = Math.max(peak, Math.abs(hotOut[i]));
    energy += hotOut[i] * hotOut[i];
  }
  assert.ok(dbFromLinear(peak) <= TRUE_PEAK_CEILING_DBTP + 0.05);
  const hotRms = dbFromLinear(Math.sqrt(energy / hotOut.length));
  assert.ok(Math.abs(hotRms + RMS_TO_LUFS_OFFSET - SPEECH_TARGET_LUFS) < 0.2);
  assert.ok(Math.abs(hot.stored[0] - 0.2) < 1e-5);

  const nearDb = -24 - RMS_TO_LUFS_OFFSET;
  const near = tone(10 ** (nearDb / 20));
  const nearGain = gainForBuffer(near.buffer);
  assert.ok(Math.abs(nearGain - 1) < 1e-6);

  const quietDb = -30 - RMS_TO_LUFS_OFFSET;
  const quiet = tone(10 ** (quietDb / 20));
  const quietGain = gainForBuffer(quiet.buffer);
  assert.ok(quietGain > 1);
  const quietOut = play(quiet.buffer, quietGain);
  let quietEnergy = 0;
  let quietPeak = 0;
  for (let i = 0; i < quietOut.length; i++) {
    quietPeak = Math.max(quietPeak, Math.abs(quietOut[i]));
    quietEnergy += quietOut[i] * quietOut[i];
  }
  const quietRms = dbFromLinear(Math.sqrt(quietEnergy / quietOut.length));
  assert.ok(Math.abs(quietRms + RMS_TO_LUFS_OFFSET - SPEECH_TARGET_LUFS) < 0.2);
  assert.ok(dbFromLinear(quietPeak) <= TRUE_PEAK_CEILING_DBTP + 0.05);
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
