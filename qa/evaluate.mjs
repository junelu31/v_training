import { cuesMatching, isTooNoisyText, PROFILE_LABELS, SOAK_LIMITS, spokenCopyIssues } from './contract.mjs';
import { cueCorpus, noiseCorpus, profileCorpus } from './corpus.mjs';
import { createDrivePage, isFallbackVideo, settle, withPage } from './page.mjs';
import { openSession, runClip, snapshotProfile, snapshotState } from './session.mjs';
import { SAMPLE_RATE } from './signals.mjs';

function fail(reasons, message) {
  reasons.push(message);
}

export function confusionMatrix(rows) {
  const columns = [...PROFILE_LABELS, 'abstain'];
  const matrix = Object.fromEntries(PROFILE_LABELS.map(label => [label, Object.fromEntries(columns.map(column => [column, 0]))]));
  for (const row of rows) {
    const actual = PROFILE_LABELS.includes(row.actual) ? row.actual : 'androgynous';
    const predicted = columns.includes(row.predicted) ? row.predicted : 'abstain';
    matrix[actual][predicted] += 1;
  }
  return matrix;
}

export function formatMatrix(matrix) {
  const columns = [...PROFILE_LABELS, 'abstain'];
  const width = Math.max(12, ...columns.map(column => column.length));
  const cell = value => String(value).padStart(width);
  const header = ['predicted →', ...columns].map(cell).join(' ');
  const lines = PROFILE_LABELS.map(label => [label, ...columns.map(column => matrix[label][column])].map(cell).join(' '));
  return ['Rows are the labeled voice. Columns are what the coach said.', header, ...lines].join('\n');
}

function predictedCues(lines, snapshot) {
  const fromText = new Set(lines.flatMap(cuesMatching));
  const fromIds = (snapshot?.cues || [])
    .filter(cue => cue && typeof cue === 'object' && cue.id && cue.id !== 'too-noisy')
    .map(cue => cue.id);
  for (const id of fromIds) fromText.add(id);
  return fromText;
}

function copyProblems(lines) {
  const problems = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.trim().toLowerCase();
    if (seen.has(key)) problems.push(`repeated “${line}”`);
    seen.add(key);
    for (const issue of spokenCopyIssues(line)) problems.push(`“${line}”: ${issue}`);
  }
  return problems;
}

export async function evaluateProfiles(factory) {
  const rows = [];
  const reasons = [];
  for (const clip of profileCorpus()) {
    let run;
    try {
      run = await runClip(factory, clip);
    } catch (error) {
      fail(reasons, `${clip.id} threw ${error.message}`);
      rows.push({ id: clip.id, actual: clip.label, predicted: 'abstain' });
      continue;
    }
    const predicted = snapshotProfile(run.snapshot);
    rows.push({ id: clip.id, actual: clip.label, predicted: predicted || 'abstain', trap: clip.trap });
    if (clip.label === 'feminine' && predicted !== 'feminine') fail(reasons, `${clip.id} predicted ${predicted || 'abstain'}, expected feminine`);
    if (clip.label === 'masculine' && predicted !== 'masculine') fail(reasons, `${clip.id} predicted ${predicted || 'abstain'}, expected masculine`);
    if (clip.trap === 'not-feminine' && predicted === 'feminine') fail(reasons, `${clip.id} followed pitch alone and called a dark high voice feminine`);
    if (clip.trap === 'not-masculine' && predicted === 'masculine') fail(reasons, `${clip.id} followed pitch alone and called a forward low voice masculine`);
    if (!clip.trap && clip.label === 'androgynous' && predicted && predicted !== 'androgynous' && predicted !== 'abstain') {
      fail(reasons, `${clip.id} predicted ${predicted} for a mid voice`);
    }
  }
  const matrix = confusionMatrix(rows.map(row => ({ actual: row.actual, predicted: row.predicted === 'abstain' ? 'abstain' : row.predicted })));
  return { pass: reasons.length === 0, reasons, rows, matrix };
}

export async function evaluateCues(factory) {
  const cases = [];
  const reasons = [];
  const per = Object.fromEntries(['pitch-low', 'pitch-drop-end', 'vocal-fry', 'resonance-dark', 'breathiness'].map(id => [id, { tp: 0, fp: 0, fn: 0 }]));
  for (const clip of cueCorpus()) {
    let run;
    try {
      run = await runClip(factory, clip);
    } catch (error) {
      fail(reasons, `${clip.id} threw ${error.message}`);
      continue;
    }
    const predicted = predictedCues(run.lines, run.snapshot);
    const expected = new Set(clip.expected ? [clip.expected] : []);
    cases.push({ id: clip.id, expected: clip.expected, predicted: [...predicted], lines: run.lines });
    for (const issue of copyProblems(run.lines)) fail(reasons, `${clip.id} copy: ${issue}`);
    for (const cue of run.snapshot?.cues || []) {
      if (!cue || typeof cue !== 'object' || !cue.id || !cue.text) continue;
      if (cue.id !== 'too-noisy' && !cuesMatching(cue.text).includes(cue.id) && !(cue.id === 'breathiness' && cuesMatching(cue.text).includes('breathiness'))) {
        if (!CUE_TEXT_OK(cue.id, cue.text)) fail(reasons, `${clip.id} id ${cue.id} does not match its text “${cue.text}”`);
      }
    }
    if (run.lines.some(isTooNoisyText)) fail(reasons, `${clip.id} said too noisy on a clean studio vowel`);
    for (const id of new Set([...expected, ...predicted])) {
      if (!per[id]) continue;
      const hit = expected.has(id);
      const got = predicted.has(id);
      if (hit && got) per[id].tp += 1;
      else if (got) per[id].fp += 1;
      else if (hit) per[id].fn += 1;
    }
    for (const id of predicted) if (!expected.has(id)) fail(reasons, `${clip.id} spoke ${id}, expected ${clip.expected || 'no cue'}`);
    for (const id of expected) if (!predicted.has(id)) fail(reasons, `${clip.id} missed ${id}. Heard: ${run.lines.join(' | ') || '(silence)'}`);
  }
  const totals = Object.values(per).reduce((sum, item) => ({
    tp: sum.tp + item.tp,
    fp: sum.fp + item.fp,
    fn: sum.fn + item.fn
  }), { tp: 0, fp: 0, fn: 0 });
  const precision = totals.tp + totals.fp === 0 ? 1 : totals.tp / (totals.tp + totals.fp);
  const recall = totals.tp + totals.fn === 0 ? 1 : totals.tp / (totals.tp + totals.fn);
  if (precision < 0.8) fail(reasons, `cue precision ${precision.toFixed(2)} is under 0.80`);
  if (recall < 0.8) fail(reasons, `cue recall ${recall.toFixed(2)} is under 0.80`);
  return { pass: reasons.length === 0, reasons, cases, per, precision, recall };
}

function CUE_TEXT_OK(id, text) {
  return cuesMatching(text).includes(id);
}

function defectLines(lines) {
  return lines.filter(line => cuesMatching(line).length > 0);
}

export async function evaluateNoise(factory) {
  const reasons = [];
  const cases = [];
  for (const clip of noiseCorpus()) {
    let run;
    try {
      run = await runClip(factory, clip);
    } catch (error) {
      fail(reasons, `${clip.id} threw ${error.message}`);
      continue;
    }
    const state = snapshotState(run.snapshot, run.lines);
    const defects = defectLines(run.lines);
    const noisy = state === 'too-noisy' || run.lines.some(isTooNoisyText);
    cases.push({ id: clip.id, expect: clip.expect, state, noisy, defects, profile: snapshotProfile(run.snapshot), lines: run.lines });
    if (defects.length) fail(reasons, `${clip.id} coached on noise or a clean vowel: ${defects.join(' | ')}`);
    if (clip.expect === 'ignore' && noisy) fail(reasons, `${clip.id} said too noisy for ordinary road noise`);
    if (clip.expect === 'too-noisy') {
      if (!run.lines.some(isTooNoisyText)) fail(reasons, `${clip.id} did not speak a too-noisy line`);
      if (state !== 'too-noisy') fail(reasons, `${clip.id} state was ${state || 'missing'}, expected too-noisy`);
    }
    if (clip.expect === 'coach-ok') {
      if (noisy) fail(reasons, `${clip.id} gave up at SNR ${clip.snrDb}`);
      const profile = snapshotProfile(run.snapshot);
      if (clip.snrDb >= 10 && profile !== 'feminine') fail(reasons, `${clip.id} profile was ${profile || 'abstain'} at SNR ${clip.snrDb}`);
      if (clip.snrDb === 5 && profile === 'masculine') fail(reasons, `${clip.id} called the voice masculine at SNR 5`);
    }
    for (const issue of copyProblems(run.lines)) fail(reasons, `${clip.id} copy: ${issue}`);
  }
  return { pass: reasons.length === 0, reasons, cases };
}

export async function runSoak(factory, { minutes = 40, sampleRate = SAMPLE_RATE, frameMs = 20, toggleEachMinute = false } = {}) {
  const page = createDrivePage();
  return withPage(page, async () => {
    if (globalThis.gc) globalThis.gc();
    const opened = await openSession(factory, page, { sampleRate });
    const frame = Math.max(1, Math.round(sampleRate * frameMs / 1000));
    const buffer = new Float32Array(frame);
    const framesPerMinute = Math.round(60000 / frameMs);
    const totalFrames = Math.round(minutes * framesPerMinute);
    const samples = [];
    const heapAt = () => process.memoryUsage().heapUsed;
    const started = heapAt();
    for (let index = 0; index < totalFrames; index++) {
      for (let i = 0; i < buffer.length; i++) buffer[i] = ((index + i) % 17) / 100;
      const result = opened.session.push?.(buffer, { sampleRate, time: (index * frame) / sampleRate });
      if (result?.then) await result;
      if (toggleEachMinute && index > 0 && index % framesPerMinute === 0) {
        page.hide();
        await settle();
        page.show();
        await settle();
      }
      if ((index + 1) % framesPerMinute === 0 || index === totalFrames - 1) {
        if (globalThis.gc) globalThis.gc();
        const resources = opened.session.resources?.() || {};
        samples.push({
          minute: samples.length + 1,
          heapUsed: heapAt(),
          retainedSamples: Number(resources.retainedSamples) || 0,
          bufferBytes: Number(resources.bufferBytes) || 0,
          listeners: page.listenerCount(),
          videos: page.domVideos().length,
          locks: page.activeSentinels().length
        });
        if (heapAt() - started > 256 * 1024 * 1024) break;
      }
    }
    if (globalThis.gc) globalThis.gc();
    const endHeap = heapAt();
    await opened.session.dispose?.();
    await settle();
    return {
      minutes,
      sampleRate,
      startedHeap: started,
      endHeap,
      heapGrowth: endHeap - started,
      samples,
      page,
      audioContext: opened.audioContext,
      mediaStream: opened.mediaStream
    };
  });
}

export function assessSoak(report) {
  const reasons = [];
  const cap = report.sampleRate * SOAK_LIMITS.maxRetainedSeconds;
  const last = report.samples.at(-1);
  if (!last) fail(reasons, 'soak produced no samples');
  if (last && !Number.isFinite(last.retainedSamples)) fail(reasons, 'session.resources().retainedSamples is missing');
  if (last && last.retainedSamples > cap) fail(reasons, `retained ${last.retainedSamples} samples, cap is ${cap}`);
  const maxBuffer = Math.max(...report.samples.map(sample => sample.bufferBytes), 0);
  if (maxBuffer > cap * 8) fail(reasons, `bufferBytes grew to ${maxBuffer}`);
  if (report.heapGrowth > SOAK_LIMITS.maxHeapGrowthBytes) fail(reasons, `heap grew ${report.heapGrowth} bytes`);
  if (report.audioContext && report.audioContext.state !== 'closed') fail(reasons, `AudioContext left ${report.audioContext.state} after dispose`);
  const live = report.page.liveTracks();
  if (live.length) fail(reasons, `${live.length} mic track(s) still live after dispose`);
  const running = report.page.state.audioContexts.filter(context => context.state === 'running');
  if (running.length) fail(reasons, `${running.length} AudioContext(s) still running after dispose`);
  if (report.page.listenerCount() > 0) fail(reasons, 'visibility listener still attached after dispose');
  if (report.page.activeSentinels().length) fail(reasons, 'wake lock still held after dispose');
  const playing = report.page.domVideos().filter(video => !video.paused && !video.removed);
  if (playing.length) fail(reasons, 'fallback video still playing after dispose');
  return { pass: reasons.length === 0, reasons };
}

export async function evaluateWakeLock(factory) {
  const reasons = [];
  reasons.push(...await checkReacquire(factory));
  reasons.push(...await checkMissing(factory));
  reasons.push(...await checkReject(factory));
  reasons.push(...await checkRelease(factory));
  reasons.push(...await checkCycles(factory, 40));
  reasons.push(...await checkMicRecovery(factory));
  reasons.push(...await checkGesture(factory));
  return { pass: reasons.length === 0, reasons: reasons.filter(Boolean) };
}

async function checkReacquire(factory) {
  const page = createDrivePage();
  const reasons = [];
  await withPage(page, async () => {
    const opened = await openSession(factory, page);
    if (page.activeSentinels().length !== 1) reasons.push(`expected 1 wake lock after start, found ${page.activeSentinels().length}`);
    if (page.state.sentinels.some(item => item.type !== 'screen')) reasons.push('wake lock was not requested as screen');
    const before = page.state.sentinels.length;
    page.hide();
    await settle();
    if (page.state.audioContexts.some(context => context.state === 'running')) reasons.push('AudioContext kept running while the page was hidden');
    const hiddenSnapshot = await opened.session.snapshot?.();
    if (hiddenSnapshot && !['paused', 'needs-gesture'].includes(hiddenSnapshot.state)) reasons.push(`hidden state was ${hiddenSnapshot.state}, expected paused`);
    page.show();
    await settle();
    if (page.state.sentinels.length - before < 1) reasons.push('did not request a new wake lock when the page was shown again');
    if (page.activeSentinels().length !== 1) reasons.push(`expected 1 active lock after returning, found ${page.activeSentinels().length}`);
    if (page.listenerCount() > SOAK_LIMITS.maxVisibilityListeners) reasons.push(`visibility listeners grew to ${page.listenerCount()}`);
    await opened.session.dispose?.();
  });
  return reasons;
}

async function checkMissing(factory) {
  const page = createDrivePage();
  page.state.wakeLockMode = 'missing';
  const reasons = [];
  await withPage(page, async () => {
    const opened = await openSession(factory, page);
    const videos = page.domVideos().filter(isFallbackVideo);
    if (videos.length !== 1) reasons.push(`missing wake lock should start one hidden looping video, found ${videos.length}`);
    if (page.activeSentinels().length) reasons.push('missing API still reported an active sentinel');
    await opened.session.dispose?.();
    await settle();
    if (page.domVideos().some(video => !video.paused && !video.removed)) reasons.push('fallback video kept playing after stop');
  });
  return reasons;
}

async function checkReject(factory) {
  const page = createDrivePage();
  page.state.wakeLockMode = 'reject';
  const reasons = [];
  await withPage(page, async () => {
    const opened = await openSession(factory, page);
    const videos = page.domVideos().filter(isFallbackVideo);
    if (videos.length !== 1) reasons.push(`rejected wake lock should fall back to one video, found ${videos.length}`);
    if (page.state.requestCount > 4) reasons.push(`wake lock request spun ${page.state.requestCount} times after a rejection`);
    await opened.session.dispose?.();
  });
  return reasons;
}

async function checkRelease(factory) {
  const page = createDrivePage();
  const reasons = [];
  await withPage(page, async () => {
    const opened = await openSession(factory, page);
    await opened.session.dispose?.();
    await settle();
    page.show();
    await settle();
    if (page.activeSentinels().length) reasons.push('wake lock was re-acquired after stop');
    if (page.listenerCount() !== 0) reasons.push('visibility listener leaked after stop');
    if (page.domVideos().some(video => !video.removed && !video.paused)) reasons.push('video fallback was not stopped');
  });
  return reasons;
}

async function checkCycles(factory, cycles) {
  const page = createDrivePage();
  const reasons = [];
  await withPage(page, async () => {
    const opened = await openSession(factory, page);
    for (let i = 0; i < cycles; i++) {
      page.hide();
      await settle();
      page.show();
      await settle();
    }
    if (page.listenerCount() > SOAK_LIMITS.maxVisibilityListeners) reasons.push(`after ${cycles} tab switches, visibility listeners = ${page.listenerCount()}`);
    if (page.domVideos().length > SOAK_LIMITS.maxVideos) reasons.push(`after ${cycles} tab switches, videos in the page = ${page.domVideos().length}`);
    if (page.activeSentinels().length > SOAK_LIMITS.maxActiveWakeLocks) reasons.push(`after ${cycles} tab switches, active wake locks = ${page.activeSentinels().length}`);
    await opened.session.dispose?.();
    await settle();
    if (page.listenerCount() !== 0) reasons.push('listeners left after the long session');
    if (page.activeSentinels().length !== 0) reasons.push('wake lock left after the long session');
  });
  return reasons;
}

async function checkMicRecovery(factory) {
  const page = createDrivePage();
  const reasons = [];
  await withPage(page, async () => {
    const opened = await openSession(factory, page);
    const frame = new Float32Array(320);
    await opened.session.push?.(frame, { sampleRate: 16000, time: 0 });
    page.hide();
    await settle();
    const runningHidden = page.state.audioContexts.filter(context => context.state === 'running');
    if (runningHidden.length) reasons.push('mic context stayed running while hidden');
    page.show();
    await settle();
    const running = page.state.audioContexts.filter(context => context.state === 'running');
    if (running.length !== 1) reasons.push(`after show, running AudioContexts = ${running.length}, expected 1`);
    if (page.liveTracks().length !== 1) reasons.push(`after show, live mic tracks = ${page.liveTracks().length}, expected 1`);
    const ended = page.state.streams.flatMap(stream => stream.getAudioTracks()).filter(track => track.readyState === 'ended');
    if (ended.length && page.liveTracks().length !== 1) reasons.push('old mic tracks were stopped and not replaced');
    const after = await opened.session.snapshot?.();
    if (after && ['paused', 'needs-gesture'].includes(after.state)) reasons.push(`session stayed ${after.state} after the page was shown`);
    await opened.session.push?.(frame, { sampleRate: 16000, time: 0.02 });
    await opened.session.dispose?.();
  });
  return reasons;
}

async function checkGesture(factory) {
  const page = createDrivePage();
  const reasons = [];
  await withPage(page, async () => {
    const opened = await openSession(factory, page);
    opened.audioContext.failResume = true;
    page.hide();
    await settle();
    page.show();
    await settle();
    const blocked = await opened.session.snapshot?.();
    if (!blocked || blocked.state !== 'needs-gesture') reasons.push(`resume rejection should surface needs-gesture, got ${blocked?.state || 'no snapshot'}`);
    if (page.state.audioContexts.some(context => context.state === 'running')) reasons.push('context was running even though resume rejected');
    opened.audioContext.failResume = false;
    page.click();
    await settle();
    if (opened.audioContext.state !== 'running') reasons.push('a tap did not resume the AudioContext');
    const recovered = await opened.session.snapshot?.();
    if (recovered?.state === 'needs-gesture' || recovered?.state === 'paused') reasons.push(`session stayed ${recovered.state} after the tap`);
    await opened.session.dispose?.();
  });
  return reasons;
}
