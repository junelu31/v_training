import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  assessSoak,
  evaluateCues,
  evaluateNoise,
  evaluateProfiles,
  evaluateWakeLock,
  formatMatrix,
  runSoak
} from './evaluate.mjs';
import {
  createLeakySession,
  createPitchOnlySession,
  createReferenceSession,
  createTriggerHappySession,
  createWakeLeakySession
} from './doubles.mjs';
import { loadCoach, readCoachSources } from './load-coach.mjs';
import { decodeAudio, findReferenceClips, referenceDir } from './reference-media.mjs';
import { runClip } from './session.mjs';
import { SAMPLE_RATE } from './signals.mjs';
import { cuesMatching } from './contract.mjs';

function formatReasons(report) {
  return ['', ...(report.reasons || [])].join('\n');
}

test('reference double passes profile, cue, noise, wake, and soak checks', async () => {
  const profiles = await evaluateProfiles(createReferenceSession);
  console.log(formatMatrix(profiles.matrix));
  assert.equal(profiles.pass, true, formatReasons(profiles));

  const cues = await evaluateCues(createReferenceSession);
  console.log(`cue precision ${cues.precision?.toFixed(2)} recall ${cues.recall?.toFixed(2)}`);
  assert.equal(cues.pass, true, formatReasons(cues));

  const noise = await evaluateNoise(createReferenceSession);
  assert.equal(noise.pass, true, formatReasons(noise));

  const wake = await evaluateWakeLock(createReferenceSession);
  assert.equal(wake.pass, true, formatReasons(wake));

  const soak = await runSoak(createReferenceSession, { minutes: 0.2, toggleEachMinute: false });
  const assessed = assessSoak(soak);
  assert.equal(assessed.pass, true, formatReasons(assessed));
});

test('pitch-only profiling fails the resonance traps', async () => {
  const report = await evaluateProfiles(createPitchOnlySession);
  assert.equal(report.pass, false);
  assert.match(report.reasons.join('\n'), /pitch alone/);
});

test('a coach that talks over noise fails the noise corpus', async () => {
  const report = await evaluateNoise(createTriggerHappySession);
  assert.equal(report.pass, false);
  assert.match(report.reasons.join('\n'), /coached|too noisy|profile/i);
});

test('wrong cues fail precision and recall', async () => {
  const report = await evaluateCues(createTriggerHappySession);
  assert.equal(report.pass, false);
});

test('an unbounded buffer fails the soak assessment', async () => {
  const report = await runSoak(createLeakySession, { minutes: 0.15 });
  const assessed = assessSoak(report);
  assert.equal(assessed.pass, false);
  assert.ok(report.samples.at(-1).retainedSamples > SAMPLE_RATE);
});

test('a wake lock that adds a listener per tab switch fails the 40-cycle check', async () => {
  const report = await evaluateWakeLock(createWakeLeakySession);
  assert.equal(report.pass, false);
  assert.match(report.reasons.join('\n'), /listener|video|wake lock/i);
});

test('Drive coach module, when QA_COACH_MODULE is set', async (t) => {
  const coach = await loadCoach();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const profiles = await evaluateProfiles(coach.createDriveSession);
  console.log(formatMatrix(profiles.matrix));
  assert.equal(profiles.pass, true, formatReasons(profiles));
  const cues = await evaluateCues(coach.createDriveSession);
  console.log(JSON.stringify({ precision: cues.precision, recall: cues.recall, per: cues.per }, null, 2));
  assert.equal(cues.pass, true, formatReasons(cues));
  const noise = await evaluateNoise(coach.createDriveSession);
  assert.equal(noise.pass, true, formatReasons(noise));
  const wake = await evaluateWakeLock(coach.createDriveSession);
  assert.equal(wake.pass, true, formatReasons(wake));
  const minutes = Number(process.env.QA_SOAK_MINUTES || 40);
  const soak = await runSoak(coach.createDriveSession, { minutes, toggleEachMinute: true });
  assert.ok(soak.samples.length >= Math.ceil(minutes), `soak covered ${soak.samples.length} minutes`);
  const assessed = assessSoak(soak);
  assert.equal(assessed.pass, true, formatReasons(assessed));
});

test('wake lock source review, when QA_COACH_MODULE is set', async (t) => {
  const coach = await loadCoach();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const sources = readCoachSources(coach.sourceFile);
  const text = sources.map(file => file.text).join('\n');
  const checks = [
    ['navigator.wakeLock', /wakeLock/],
    ['screen lock type', /['"]screen['"]/],
    ['visibilitychange', /visibilitychange/],
    ['re-request after the document is visible', /visibilityState/],
    ['release on stop', /release\s*\(/],
    ['muted fallback video', /muted/],
    ['looping fallback video', /loop/],
    ['inline playback for iPhone', /playsInline|playsinline/],
    ['AudioContext suspend while hidden', /suspend\s*\(/],
    ['AudioContext resume when shown', /resume\s*\(/]
  ];
  const missing = checks.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  assert.deepEqual(missing, [], `Wake lock review did not find: ${missing.join(', ')}. Files: ${sources.map(file => file.file).join(', ')}`);
  assert.ok(sources.length >= 1);
  assert.ok(readFileSync(coach.sourceFile, 'utf8').length > 0);
});

test('optional local road clips never coach a defect on noise alone', async (t) => {
  const dir = referenceDir();
  if (!dir) {
    t.skip('Set QA_REFERENCE_DIR to a local folder of road clips. Do not commit them.');
    return;
  }
  const coach = await loadCoach();
  if (!coach.ok) {
    t.skip(coach.reason);
    return;
  }
  const clips = findReferenceClips(dir);
  assert.ok(clips.length > 0, `No snr20/10/5 or road-only clips in ${dir}`);
  for (const clip of clips) {
    const samples = decodeAudio(clip.file);
    const run = await runClip(coach.createDriveSession, { id: clip.id, sampleRate: SAMPLE_RATE, samples });
    const defects = run.lines.filter(line => cuesMatching(line).length > 0);
    if (clip.expect === 'noise-only') {
      assert.deepEqual(defects, [], `${clip.id} coached on noise alone: ${defects.join(' | ')}`);
      continue;
    }
    // These clips are one person's practice take. They check that the coach
    // runs. They are not a labeled profile or a cue key.
    assert.ok(run.snapshot && typeof run.snapshot === 'object', `${clip.id} returned no snapshot`);
    assert.ok(Array.isArray(run.lines), clip.id);
  }
});
