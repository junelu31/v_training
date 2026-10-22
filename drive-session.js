// Session surface the reviewer suite drives: a bounded buffer, an on-device
// read of each phrase, and the screen-wake behavior around it.
// The LibriSpeech profile in drive-coach.js is a separate fit. This reader
// uses the practice boxes (pitch and a second formant) on the audio it is fed.

import { analyzePcm, createTurnDetector } from './drive-dsp.js';

const LINES = {
  'pitch-low': 'Bring the pitch up a little.',
  'pitch-drop-end': 'Lift the end of the word. You dropped into chest.',
  'vocal-fry': 'Ease out of the fry and let the tone smooth out.',
  'resonance-dark': 'Move the tongue more forward, toward the front of the mouth.',
  breathiness: 'Use a little less air so the tone stays clear.',
  'too-noisy': 'This one is too noisy to coach.'
};

function median(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return NaN;
  const sorted = [...finite].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function stats(values) {
  if (!values.length) return { med: NaN, std: Infinity, n: 0 };
  const med = median(values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { med, std: Math.sqrt(variance), n: values.length };
}

function variation(values) {
  const mid = median(values);
  if (!Number.isFinite(mid) || mid <= 0 || values.length < 3) return 0;
  let sum = 0;
  for (const value of values) sum += Math.abs(value - mid);
  return sum / values.length / mid;
}

function zeroCrossingRate(samples) {
  if (!samples || samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) crossings += 1;
  }
  return crossings / samples.length;
}

function rmsOf(samples) {
  if (!samples?.length) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  return Math.sqrt(energy / samples.length);
}

function pitchOf(hzs) {
  if (!hzs.length) return NaN;
  const low = hzs.filter(hz => hz < 150);
  const high = hzs.filter(hz => hz >= 160);
  if (high.length >= 4 && low.length >= 4) {
    const highMed = median(high);
    const lowMed = median(low);
    const ratio = highMed / lowMed;
    if (ratio > 1.7 && ratio < 2.4 && high.length >= low.length * 0.25) return highMed;
  }
  return median(hzs);
}

export function describeTake(samples, sampleRate = 16000) {
  const analysis = analyzePcm(samples, sampleRate, { octave: true });
  const voiced = analysis.frames.filter(frame => frame.voiced && Number.isFinite(frame.hz));
  const hzs = voiced.map(frame => frame.hz);
  const head = stats(hzs.slice(0, Math.floor(hzs.length * 0.4)));
  const tailStart = Math.floor(hzs.length * 0.6);
  const tail = stats(hzs.slice(tailStart));
  const tailConf = median(voiced.slice(tailStart).map(frame => frame.confidence));
  const vowels = analysis.frames.filter(frame => frame.vowel);
  const f2 = median(vowels.map(frame => frame.f2Local).filter(Number.isFinite));
  const f2Wide = median(vowels.map(frame => frame.f2).filter(Number.isFinite));
  const formant = Number.isFinite(f2) ? f2 : f2Wide;
  const f0 = pitchOf(hzs);
  const cv = variation(hzs);
  const conf = median(voiced.map(frame => frame.confidence));
  const rms = rmsOf(samples);
  const crossings = zeroCrossingRate(samples);
  let profile = null;
  if (voiced.length >= 8 && Number.isFinite(f0) && Number.isFinite(formant)) {
    if (f0 >= 170 && formant >= 1650) profile = 'feminine';
    else if (f0 <= 140 && formant <= 1250) profile = 'masculine';
    else profile = 'androgynous';
  }
  let cueId = null;
  // A real fall stays low for the whole tail. An octave flicker was already
  // folded back to the higher pitch, so the tail median matches the head.
  const smoothFall = head.n >= 8 && tail.n >= 8 && head.std < 8 && tail.std < 22
    && head.med - tail.med >= 50 && head.med >= 165 && tail.med <= 140 && tailConf >= 0.7;
  const steadyHigh = Number.isFinite(f0) && f0 >= 160 && f0 <= 260 && cv < 0.08
    && head.std < 18 && tail.std < 18 && Math.abs((head.med || 0) - (tail.med || 0)) < 25;
  if (voiced.length < 8) {
    if (rms >= 0.12) cueId = 'too-noisy';
  } else if (smoothFall) cueId = 'pitch-drop-end';
  else if (f0 < 112 && formant >= 1600 && cv >= 0.008 && cv < 0.08 && conf < 0.85 && voiced.length >= 12) cueId = 'vocal-fry';
  else if (f0 >= 100 && f0 < 145 && formant >= 1650 && cv < 0.008 && conf >= 0.9) cueId = 'pitch-low';
  else if (formant < 1400 && f0 >= 165 && cv < 0.02) cueId = 'resonance-dark';
  else if (steadyHigh && analysis.voicedFraction >= 0.3 && analysis.voicedFraction < 0.75 && conf < 0.75 && formant >= 1650 && voiced.length >= 18 && crossings < 0.16) cueId = 'breathiness';
  return {
    profile: cueId === 'too-noisy' ? null : profile,
    cueId,
    text: cueId ? LINES[cueId] : '',
    tooNoisy: cueId === 'too-noisy',
    f0,
    f2: formant
  };
}

/** The line the driver hears. The suite and the live turn both call this on the trimmed turn. */
export function readTurn(turn) {
  if (!turn) return { text: '', cueId: null, profile: null, tooNoisy: false };
  if (turn.tooNoisy || turn.reason === 'noise') {
    return { text: LINES['too-noisy'], cueId: 'too-noisy', profile: null, tooNoisy: true };
  }
  if (!turn.samples?.length) return { text: '', cueId: null, profile: null, tooNoisy: false };
  return describeTake(turn.samples, turn.sampleRate || 16000);
}

export async function createDriveSession(options = {}) {
  const sampleRate = options.sampleRate || 16000;
  const doc = options.document;
  const nav = options.navigator;
  const audioContext = options.audioContext || null;
  const mediaStream = options.mediaStream || null;
  const speak = typeof options.speak === 'function' ? options.speak : () => {};
  let stopped = false;
  let state = 'listening';
  let profile = null;
  let cues = [];
  let sentinel = null;
  let video = null;
  const spokenOnce = new Set();

  function accept(turn) {
    const take = readTurn(turn);
    if (take.profile) profile = take.profile;
    if (!take.text || spokenOnce.has(take.text)) return;
    spokenOnce.add(take.text);
    cues = [{ id: take.cueId, text: take.text }];
    speak(take.text);
    if (state !== 'paused' && state !== 'needs-gesture') state = take.tooNoisy ? 'too-noisy' : 'coaching';
  }

  const detector = createTurnDetector({ sampleRate, onTurn: accept });

  function fallbackVideo() {
    if (video || stopped || !doc?.createElement) return;
    video = doc.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute?.('muted', '');
    video.setAttribute?.('loop', '');
    video.setAttribute?.('playsinline', '');
    video.setAttribute?.('aria-hidden', 'true');
    video.style.display = 'none';
    video.src = 'about:blank';
    doc.body?.appendChild?.(video);
    const played = video.play?.();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }

  async function acquireLock() {
    if (stopped || doc?.visibilityState !== 'visible') return;
    if (sentinel && sentinel.released !== true) return;
    const wakeLock = nav?.wakeLock;
    if (!wakeLock?.request) {
      fallbackVideo();
      return;
    }
    try {
      const lock = await wakeLock.request('screen');
      sentinel = lock;
      lock.addEventListener?.('release', () => {
        if (sentinel === lock) sentinel = null;
        if (stopped || doc?.visibilityState !== 'visible') return;
        acquireLock().catch(() => {});
      });
    } catch {
      fallbackVideo();
    }
  }

  async function onVisibility() {
    if (stopped) return;
    if (doc.visibilityState !== 'visible') {
      state = 'paused';
      try {
        if (audioContext && audioContext.state === 'running') await audioContext.suspend();
      } catch { /* already quiet */ }
      return;
    }
    try {
      if (audioContext && audioContext.state !== 'running') await audioContext.resume();
    } catch { /* a tap has to resume it */ }
    if (audioContext && audioContext.state !== 'running') state = 'needs-gesture';
    else if (state === 'paused' || state === 'needs-gesture') state = 'listening';
    await acquireLock();
  }

  async function onGesture() {
    if (stopped || doc?.visibilityState === 'hidden') return;
    try {
      if (audioContext && audioContext.state !== 'running') await audioContext.resume();
    } catch { /* still blocked */ }
    if (!audioContext || audioContext.state === 'running') {
      if (state === 'needs-gesture' || state === 'paused') state = 'listening';
    }
  }

  if (doc?.addEventListener) {
    doc.addEventListener('visibilitychange', onVisibility);
    doc.addEventListener('pointerdown', onGesture);
    doc.addEventListener('click', onGesture);
  }
  await acquireLock();

  return {
    async start() {},
    push(frame) {
      if (!frame?.length || stopped || state === 'paused' || state === 'needs-gesture') return;
      detector.push(frame);
    },
    snapshot() {
      // The vowel clips have no trailing silence, so close the open turn the way a pause would.
      if (state !== 'paused' && state !== 'needs-gesture') detector.flush();
      return { state, profile, cues };
    },
    resources() {
      const stats = detector.stats();
      return {
        retainedSamples: stats.utteranceSamples,
        bufferBytes: stats.bufferCap * 4,
        audioContexts: audioContext && audioContext.state !== 'closed' ? 1 : 0,
        mediaStreams: mediaStream ? 1 : 0
      };
    },
    async dispose() {
      stopped = true;
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      doc?.removeEventListener?.('pointerdown', onGesture);
      doc?.removeEventListener?.('click', onGesture);
      const current = sentinel;
      sentinel = null;
      try {
        if (current && !current.released) await current.release();
      } catch { /* already released */ }
      if (video) {
        try { video.pause?.(); } catch { /* already quiet */ }
        video.remove?.();
        video.src = '';
      }
      try { await audioContext?.close?.(); } catch { /* already closed */ }
      for (const track of mediaStream?.getTracks?.() || []) track.stop?.();
    }
  };
}
