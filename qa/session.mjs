import { isTooNoisyText } from './contract.mjs';
import { createDrivePage, settle, withPage } from './page.mjs';

export async function openSession(factory, page, extra = {}) {
  const spoken = [];
  const audioContext = extra.audioContext || new page.AudioContext();
  const mediaStream = extra.mediaStream || page.makeStream();
  const options = {
    sampleRate: extra.sampleRate || 16000,
    goal: extra.goal || 'balanced',
    document: page.document,
    navigator: page.navigator,
    window: globalThis.window,
    audioContext,
    mediaStream,
    speak(text) { spoken.push(String(text)); },
    ...extra,
    speak(text) { spoken.push(String(text)); }
  };
  // extra may have overwritten speak; force the collector.
  options.speak = text => spoken.push(String(text));
  const session = await factory(options);
  if (typeof session?.start === 'function') await session.start();
  if (session?.ready) await session.ready;
  await settle();
  return { session, spoken, audioContext, mediaStream, page };
}

export function spokenLines(spoken, snapshot, page) {
  const fromCallback = spoken.filter(Boolean);
  const fromSynth = page.speeches.filter(Boolean);
  const chosen = fromCallback.length ? fromCallback : fromSynth;
  const fromSnapshot = (snapshot?.cues || [])
    .map(cue => (typeof cue === 'string' ? cue : cue?.text))
    .filter(Boolean)
    .filter(text => !chosen.includes(text));
  return [...chosen, ...fromSnapshot];
}

export function cueIdsFromSnapshot(snapshot) {
  return (snapshot?.cues || []).map(cue => (cue && typeof cue === 'object' ? cue.id : null)).filter(Boolean);
}

export async function runClip(factory, clip, page = createDrivePage()) {
  return withPage(page, async () => {
    const opened = await openSession(factory, page, { sampleRate: clip.sampleRate });
    const frame = Math.round(clip.sampleRate * 0.02);
    for (let offset = 0; offset < clip.samples.length; offset += frame) {
      const slice = clip.samples.subarray(offset, Math.min(clip.samples.length, offset + frame));
      const copy = new Float32Array(slice);
      const result = opened.session.push?.(copy, {
        sampleRate: clip.sampleRate,
        time: offset / clip.sampleRate
      });
      if (result?.then) await result;
    }
    await settle();
    const snapshot = (await opened.session.snapshot?.()) || {};
    const lines = spokenLines(opened.spoken, snapshot, page);
    const resources = opened.session.resources?.() || null;
    await opened.session.dispose?.();
    await opened.session.stop?.();
    await settle();
    return { snapshot, lines, resources, page, opened };
  });
}

export function snapshotProfile(snapshot) {
  const value = snapshot?.profile;
  if (value == null || value === '') return null;
  const label = String(value).toLowerCase();
  if (label === 'male') return 'masculine';
  if (label === 'female') return 'feminine';
  return label;
}

export function snapshotState(snapshot, lines) {
  if (snapshot?.state) return snapshot.state;
  if (lines.some(isTooNoisyText)) return 'too-noisy';
  return null;
}
