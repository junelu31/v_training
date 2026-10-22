// Scores the frozen profiler on the held-out LibriSpeech speakers.
// Run scripts/fetch-profile-audio.py first. Audio stays in /tmp/lilt-profile.
// Prints clean and 10 dB confusion matrices. It does not choose weights.
import { readFileSync, writeFileSync } from 'node:fs';
import { analyzePcm, detectTurns, makeRoadNoise, mixAtSnr } from '../drive-dsp.js';
import { confusion, profilePhrase } from '../drive-coach.js';
import { assignProfileSplit } from './profile-split.mjs';

const root = '/tmp/lilt-profile';
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'));
const before = JSON.parse(readFileSync(`${root}/before-speakers.json`, 'utf8'));
const noise = makeRoadNoise(4.2, 16000, 17);

function load(name) {
  const buffer = readFileSync(`${root}/${name}`);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

const measured = manifest.speakers.map(speaker => {
  const pcm = load(speaker.file);
  const clean = profilePhrase(analyzePcm(pcm));
  const noisy = profilePhrase(analyzePcm(mixAtSnr(pcm, noise, 10)));
  return { ...speaker, hz: clean.features.hz, clean, noisy };
}).filter(speaker => Number.isFinite(speaker.hz));

const { test } = assignProfileSplit(measured);
const heldOut = measured.filter(speaker => test.has(speaker.id));
const beforeById = new Map(before.map(row => [row.id, row]));
const paired = heldOut.filter(speaker => beforeById.has(speaker.id));

function pairs(speakers, read) {
  return speakers.map(speaker => ({ id: speaker.id, actual: speaker.label, predicted: read(speaker) }));
}

const report = {
  source: manifest.source,
  license: manifest.license,
  split: 'Held-out speakers only. Calibration speakers were used to choose the weights and are not in these matrices.',
  heldOut: {
    feminine: heldOut.filter(speaker => speaker.label === 'feminine').length,
    masculine: heldOut.filter(speaker => speaker.label === 'masculine').length
  },
  beforeAll: confusion(before.map(row => ({ id: row.id, actual: row.label, predicted: row.predicted }))),
  beforeHeldOut: confusion(pairs(paired, speaker => beforeById.get(speaker.id).predicted)),
  after: confusion(pairs(heldOut, speaker => speaker.clean.label)),
  pitchOnly: confusion(pairs(heldOut, speaker => speaker.clean.pitchOnly === 'androgynous' ? 'unsure' : speaker.clean.pitchOnly)),
  snr10: confusion(pairs(heldOut, speaker => speaker.noisy.label)),
  snr10PitchOnly: confusion(pairs(heldOut, speaker => speaker.noisy.pitchOnly === 'androgynous' ? 'unsure' : speaker.noisy.pitchOnly)),
  severe: heldOut.filter(speaker => {
    const predicted = speaker.clean.label;
    return (speaker.label === 'masculine' && predicted === 'feminine') || (speaker.label === 'feminine' && predicted === 'masculine');
  }).map(speaker => ({
    id: speaker.id,
    actual: speaker.label,
    predicted: speaker.clean.label,
    hz: speaker.clean.features.hz,
    f2: speaker.clean.features.f2,
    residual: speaker.clean.features.residual
  })),
  failures: heldOut.filter(speaker => speaker.clean.label !== speaker.label).slice(0, 15).map(speaker => ({
    id: speaker.id,
    actual: speaker.label,
    predicted: speaker.clean.label,
    hz: speaker.clean.features.hz,
    f2: speaker.clean.features.f2,
    f3: speaker.clean.features.f3,
    residual: speaker.clean.features.residual
  }))
};
writeFileSync(`${root}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
