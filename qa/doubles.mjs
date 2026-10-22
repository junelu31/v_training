// Test doubles that prove the assertions can pass and fail.
// This is not the Drive coach. The app must not import it.

import { CUE_RULES } from './contract.mjs';
import { SAMPLE_RATE, measureClip } from './signals.mjs';

function lineFor(id) {
  switch (id) {
    case 'pitch-low': return 'Bring the pitch up a little.';
    case 'pitch-drop-end': return 'Lift the end of the word. You dropped into chest.';
    case 'vocal-fry': return 'Ease out of the fry and let the tone smooth out.';
    case 'resonance-dark': return 'Move the tongue more forward.';
    case 'breathiness': return 'Use a little less air so the tone stays clear.';
    case 'too-noisy': return 'Too noisy to coach.';
    default: return '';
  }
}

function classify(measure) {
  if (!readable(measure)) return null;
  if (measure.f0 >= 170 && measure.f2 >= 1650) return 'feminine';
  if (measure.f0 <= 140 && measure.f2 <= 1250) return 'masculine';
  return 'androgynous';
}

function readable(measure) {
  return Boolean(measure && measure.confidence >= 0.5 && Number.isFinite(measure.f0) && measure.f0 >= 70 && measure.f0 <= 480 && Number.isFinite(measure.f2));
}

function defectOf(measure) {
  if (!readable(measure)) return null;
  if (measure.f0 < 120 && measure.f0Variation >= 0.012 && measure.f2 >= 1600) return 'vocal-fry';
  if (measure.dropSemitones >= 6) return 'pitch-drop-end';
  if (measure.f0 < 145 && measure.f2 >= 1600 && measure.f0Variation < 0.01) return 'pitch-low';
  if (measure.f2 < 1400 && measure.f0 >= 165) return 'resonance-dark';
  if (
    measure.confidence < 0.8 &&
    measure.f0 >= 160 &&
    measure.f2 >= 1650 &&
    measure.zeroCrossings < 0.12 &&
    Math.abs(measure.dropSemitones) < 1
  ) return 'breathiness';
  return null;
}

async function acquireLock(session) {
  if (session.stopped || session.page.document.visibilityState !== 'visible') return;
  const wakeLock = session.page.navigator.wakeLock;
  if (!wakeLock?.request) {
    session.fallbackVideo();
    return;
  }
  try {
    session.sentinel = await wakeLock.request('screen');
    session.mode = 'lock';
  } catch {
    session.fallbackVideo();
  }
}

function attachWake(session, doc) {
  session.onVisibility = async () => {
    if (session.stopped) return;
    if (doc.visibilityState === 'hidden') {
      session.state = 'paused';
      try { await session.audioContext?.suspend?.(); } catch { /* already closed */ }
      return;
    }
    try { await session.audioContext?.resume?.(); } catch { /* needs a gesture */ }
    session.state = session.audioContext && session.audioContext.state !== 'running' ? 'needs-gesture' : session.state === 'too-noisy' ? 'too-noisy' : 'listening';
    await acquireLock(session);
  };
  session.onGesture = async () => {
    if (session.stopped || doc.visibilityState === 'hidden') return;
    try { await session.audioContext?.resume?.(); } catch { /* still blocked */ }
    if (!session.audioContext || session.audioContext.state === 'running') {
      if (session.state === 'needs-gesture' || session.state === 'paused') session.state = 'listening';
    }
  };
  doc.addEventListener('visibilitychange', session.onVisibility);
  doc.addEventListener('pointerdown', session.onGesture);
  doc.addEventListener('click', session.onGesture);
}

function baseSession(options) {
  const sampleRate = options.sampleRate || SAMPLE_RATE;
  const ring = new Float32Array(sampleRate * 5);
  const doc = options.document || globalThis.document;
  const navPage = {
    document: doc,
    navigator: options.navigator || globalThis.navigator
  };
  const session = {
    sampleRate,
    ring,
    write: 0,
    filled: 0,
    audioContext: options.audioContext || null,
    mediaStream: options.mediaStream || null,
    speak: options.speak || (() => {}),
    page: navPage,
    sentinel: null,
    video: null,
    mode: null,
    stopped: false,
    state: 'listening',
    profile: null,
    cues: [],
    spokenOnce: new Set(),
    push(frame) {
      for (let i = 0; i < frame.length; i++) {
        ring[session.write] = frame[i];
        session.write = (session.write + 1) % ring.length;
      }
      session.filled = Math.min(ring.length, session.filled + frame.length);
    },
    ordered() {
      const out = new Float32Array(session.filled);
      const start = session.filled < ring.length ? 0 : session.write;
      for (let i = 0; i < session.filled; i++) out[i] = ring[(start + i) % ring.length];
      return out;
    },
    fallbackVideo() {
      if (session.video || session.stopped) return;
      const video = doc.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true');
      video.style.display = 'none';
      video.src = 'about:blank';
      doc.body.appendChild(video);
      video.play();
      session.video = video;
      session.mode = 'video';
    },
    say(id) {
      const text = lineFor(id);
      if (!text || session.spokenOnce.has(text)) return;
      session.spokenOnce.add(text);
      session.cues = [{ id, text }];
      session.speak(text);
      session.state = id === 'too-noisy' ? 'too-noisy' : 'coaching';
    },
    snapshot() {
      return { state: session.state, profile: session.profile, cues: session.cues };
    },
    resources() {
      return {
        retainedSamples: session.filled,
        bufferBytes: ring.byteLength,
        audioContexts: session.audioContext && session.audioContext.state !== 'closed' ? 1 : 0,
        mediaStreams: session.mediaStream ? 1 : 0
      };
    },
    async dispose() {
      session.stopped = true;
      doc.removeEventListener('visibilitychange', session.onVisibility);
      doc.removeEventListener('pointerdown', session.onGesture);
      doc.removeEventListener('click', session.onGesture);
      if (session.sentinel && !session.sentinel.released) await session.sentinel.release();
      if (session.video) {
        session.video.pause();
        session.video.remove();
        session.video.src = '';
      }
      try { await session.audioContext?.close?.(); } catch { /* ignore */ }
      for (const track of session.mediaStream?.getTracks?.() || []) track.stop();
    }
  };
  session.ready = (async () => {
    attachWake(session, doc);
    await acquireLock(session);
  })();
  return session;
}

/** A bounded coach that follows the published thresholds on the buffered audio. */
export function createReferenceSession(options = {}) {
  const session = baseSession(options);
  const buffer = session.push.bind(session);
  session.push = frame => buffer(frame);
  session.decide = () => {
    if (session.filled < session.sampleRate * 0.4) return;
    const measure = measureClip(session.ordered(), session.sampleRate);
    const voiced = readable(measure);
    if (!voiced && measure.rms >= 0.15) {
      session.profile = null;
      session.say('too-noisy');
      return;
    }
    if (!voiced) return;
    session.profile = classify(measure);
    const defect = defectOf(measure);
    if (defect) session.say(defect);
  };
  const report = session.snapshot.bind(session);
  session.snapshot = () => {
    if (session.state !== 'paused' && session.state !== 'needs-gesture') session.decide();
    return report();
  };
  return session;
}

/** Classifies from pitch alone. The profile traps must fail this. */
export function createPitchOnlySession(options = {}) {
  const session = baseSession(options);
  const buffer = session.push.bind(session);
  session.push = frame => buffer(frame);
  const report = session.snapshot.bind(session);
  session.snapshot = () => {
    if (session.filled > 0) {
      const measure = measureClip(session.ordered(), session.sampleRate);
      if (measure.confidence >= 0.45 && measure.f0 > 0) session.profile = measure.f0 >= 165 ? 'feminine' : 'masculine';
    }
    return report();
  };
  return session;
}

/** Speaks a tongue cue for noise and for every vowel. */
export function createTriggerHappySession(options = {}) {
  const session = baseSession(options);
  session.push = () => {
    session.say('resonance-dark');
    session.profile = 'feminine';
  };
  return session;
}

/** Keeps every frame and every visibility listener. */
export function createLeakySession(options = {}) {
  const kept = [];
  const doc = options.document || globalThis.document;
  const onVisibility = () => { doc.addEventListener('visibilitychange', () => {}); };
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    ready: Promise.resolve(),
    push(frame) { kept.push(Float32Array.from(frame)); },
    snapshot() { return { state: 'listening', profile: null, cues: [] }; },
    resources() {
      const retainedSamples = kept.reduce((sum, chunk) => sum + chunk.length, 0);
      return { retainedSamples, bufferBytes: retainedSamples * 4, audioContexts: 1, mediaStreams: 1 };
    },
    async dispose() {}
  };
}

/** Adds a new hidden video and a new listener on every tab return. */
export function createWakeLeakySession(options = {}) {
  const doc = options.document || globalThis.document;
  const nav = options.navigator || globalThis.navigator;
  const videos = [];
  const onVisibility = async () => {
    doc.addEventListener('visibilitychange', onVisibility);
    const video = doc.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.style.display = 'none';
    doc.body.appendChild(video);
    await video.play();
    videos.push(video);
    try { await nav.wakeLock?.request?.('screen'); } catch { /* ignore */ }
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    ready: onVisibility(),
    push() {},
    snapshot() { return { state: 'listening', profile: null, cues: [] }; },
    resources() { return { retainedSamples: videos.length * 1000, bufferBytes: videos.length * 4000, audioContexts: 0, mediaStreams: 0 }; },
    async dispose() {}
  };
}

export function referenceCuesMatchContract() {
  for (const id of Object.keys(CUE_RULES)) {
    const text = lineFor(id);
    if (!CUE_RULES[id].text(text)) return `${id} line does not match its own rule: ${text}`;
  }
  return '';
}
