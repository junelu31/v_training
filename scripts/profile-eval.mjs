// Scores Drive coach's per-phrase read against the LibriSpeech sample in
// /tmp/lilt-profile. Run scripts/fetch-profile-audio.py first. Audio stays
// outside the repo. Also remixes each clip with synthetic road noise at 10 dB.
import { readFileSync, writeFileSync } from 'node:fs';
import { analyzePcm, makeRoadNoise, mixAtSnr } from '../drive-dsp.js';
import { confusion, profilePhrase } from '../drive-coach.js';

const root = '/tmp/lilt-profile';
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'));
const noise = makeRoadNoise(4.2, 16000, 17);

function load(name) {
  const buffer = readFileSync(`${root}/${name}`);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

function choose(speakers) {
  const scored = speakers.map(speaker => {
    const analysis = analyzePcm(load(speaker.file));
    const profile = profilePhrase(analysis);
    return { ...speaker, hz: profile.features.hz, profile };
  }).filter(speaker => Number.isFinite(speaker.hz));
  const byLabel = label => scored.filter(speaker => speaker.label === label).sort((a, b) => a.hz - b.hz);
  const pick = list => {
    if (list.length <= 50) return list;
    const low = list.slice(0, 8);
    const high = list.slice(-8);
    const middle = list.slice(8, -8);
    const step = middle.length / 34;
    const chosen = [...low];
    for (let i = 0; i < 34; i++) chosen.push(middle[Math.min(middle.length - 1, Math.floor(i * step))]);
    return [...chosen, ...high].slice(0, 50);
  };
  return [...pick(byLabel('feminine')), ...pick(byLabel('masculine'))];
}

const selected = choose(manifest.speakers);
const cleanPairs = [];
const noisyPairs = [];
const pitchPairs = [];
const failures = [];
for (const speaker of selected) {
  const clean = analyzePcm(load(speaker.file));
  const profile = profilePhrase(clean);
  cleanPairs.push({ actual: speaker.label, predicted: profile.label, id: speaker.id, hz: profile.features.hz, f2: profile.features.f2 });
  pitchPairs.push({ actual: speaker.label, predicted: profile.pitchOnly, id: speaker.id });
  if (profile.label !== speaker.label && failures.length < 15) failures.push({ id: speaker.id, actual: speaker.label, predicted: profile.label, hz: profile.features.hz, f2: profile.features.f2, vtl: profile.features.vtl });
  const mixed = mixAtSnr(load(speaker.file), noise, 10);
  const noisy = profilePhrase(analyzePcm(mixed));
  noisyPairs.push({ actual: speaker.label, predicted: noisy.label, id: speaker.id });
}
const clean = confusion(cleanPairs);
const noisy = confusion(noisyPairs);
const pitch = confusion(pitchPairs);
const report = {
  source: manifest.source,
  license: manifest.license,
  speakers: { feminine: selected.filter(s => s.label === 'feminine').length, masculine: selected.filter(s => s.label === 'masculine').length },
  clean: { accuracy: clean.accuracy, matrix: clean.matrix, failures },
  pitchOnly: { accuracy: pitch.accuracy, matrix: pitch.matrix },
  snr10: { accuracy: noisy.accuracy, matrix: noisy.matrix },
  note: 'LibriSpeech train-clean-100 is audiobook English, so accent variety is limited. The 50 per label include the lowest-pitched and highest-pitched speakers of that label so pitch alone is not the whole set. Clef-omni is blended only when its noul is at least 0.62; this table is the acoustic read.'
};
writeFileSync(`${root}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
