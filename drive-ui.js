import { SAMPLE_RATE, createTurnDetector, resampleLinear } from './drive-dsp.js';
import { classifyUtterance, createCoachSession, expectedVoicedMs, followUpLine, matchCommand, openingLine, parseEar } from './drive-coach.js';
import { createDriveSession, readTurn } from './drive-session.js';
import { applyVisibility, awakeLabel, createStayAwake } from './drive-wake.js';
import { planSpeech, voiceKey } from './drive-voice.js';
import { VOICE_CLIPS } from './drive-voice-clips.js';
import { afterMicRequest, bufferPlayed, interruptionHeld, micFailureCopy, mixChannels, needsDirectScriptCapture, onContextState, PLAYBACK_CUT_MS, startupCoversInterruption, usePlayAndRecord } from './drive-mic-start.js';

export { createDriveSession };

let audioContext = null;
let silentGain = null;
let detector = null;
let session = null;
let speaking = false;
let activeSource = null;
let sourceNode = null;
let processor = null;
let stream = null;
let savedDeps = null;
let fileTest = false;
let lastFeedback = '';
let statusHeld = false;
let guideRetired = false;
let clock = null;
let userPaused = false;
let hiddenByPage = false;
let contextBound = false;
let micGeneration = 0;
let captureScratch = new Float32Array(0);
let stayAwake = null;
let visibilityHandler = null;
let workletReady = null;
let awaitingPermission = false;
let captureClock = null;
const clipBuffers = new WeakMap();
let judging = false;
let speechToken = 0;
const SPEECH_TAIL_MS = 250;
let levelFrame = 0;
let levelPeak = 0;
const TURN_TIMEOUT_MS = 6000;
// How long a resume() may sit on the permission sheet before this attempt gives up.
// The caller speaks the line again after the sheet closes.
const RESUME_WAIT_MS = 12000;
const FLOW_MS = 1200;
let micOpenedAt = 0;
let lastFrameAt = 0;
let starting = false;
let recovering = null;
let routePauseTimer = null;
// Far below the noise floor. Zero is dropped by Safari, so the capture graph never runs.
const KEEP_ALIVE_GAIN = 0.0001;
const RAW_MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

function clearRoutePause() {
  if (!routePauseTimer) return;
  clearTimeout(routePauseTimer);
  routePauseTimer = null;
}

function el(id) {
  return document.getElementById(id);
}

function show(line, sub = '') {
  const overlay = el('coachOverlay');
  if (!overlay) return;
  const wasHidden = overlay.hidden;
  overlay.hidden = false;
  el('coachLine').textContent = line;
  el('coachSub').textContent = sub;
  const guide = el('coachGuide');
  if (lastFeedback) guideRetired = true;
  if (guide) guide.hidden = guideRetired;
  if (wasHidden) overlay.focus();
}

function showHeard(text) {
  const node = el('coachHeard');
  if (node) node.textContent = text;
}

function showLevel(rms) {
  levelPeak = Math.max(levelPeak, rms);
  if (levelFrame || typeof requestAnimationFrame !== 'function') return;
  levelFrame = requestAnimationFrame(() => {
    levelFrame = 0;
    const bar = el('coachLevel');
    // About -50 dBFS reads as empty and -10 dBFS as full.
    const db = 20 * Math.log10(levelPeak + 1e-9);
    if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 50) / 40)).toFixed(3)})`;
    levelPeak = 0;
  });
}

function showAwake(mode) {
  const node = el('coachAwake');
  if (!node) return;
  const label = awakeLabel(mode);
  node.hidden = !label;
  node.textContent = label;
}

function stayVideo() {
  const video = el('coachStayAwake');
  if (!video) return null;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.loop = true;
  return video;
}

function ensureStayAwake() {
  if (stayAwake) return stayAwake;
  stayAwake = createStayAwake({
    requestWakeLock() {
      if (!navigator.wakeLock?.request) return Promise.reject(new Error('Wake Lock is unavailable'));
      return navigator.wakeLock.request('screen');
    },
    playVideo() {
      const video = stayVideo();
      if (!video) return Promise.reject(new Error('No stay-awake video'));
      return video.play();
    },
    pauseVideo() {
      stayVideo()?.pause();
    },
    isVideoPlaying() {
      const video = stayVideo();
      return !!video && !video.paused && !video.ended;
    },
    isVisible() {
      return document.visibilityState === 'visible';
    },
    onMode(mode) {
      showAwake(mode);
    }
  });
  return stayAwake;
}

function ensureContext() {
  if (!audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    // Hardware rate. Coach clips play on this same context, and a forced 16 kHz
    // context would dull the voice she is matching. The turn detector resamples.
    audioContext = new Ctor();
  }
  if (!contextBound) {
    contextBound = true;
    const picture = () => ({
      state: audioContext.state,
      covered: startupCoversInterruption({ awaitingPermission, starting, micOpenedAt, now: Date.now() }),
      hidden: hiddenByPage || document.visibilityState === 'hidden',
      stopped: false,
      userPaused,
      paused: session.status().paused
    });
    // Look again while the route stays down. A flicker ends before this and is ignored.
    // A drop that begins during startup is paused only once startup no longer covers it.
    const scheduleRouteCheck = () => {
      if (routePauseTimer) return;
      routePauseTimer = setTimeout(() => {
        routePauseTimer = null;
        if (!session || session.status().stopped || !audioContext) return;
        const still = onContextState(picture());
        if (still === 'pause') {
          session.interrupt(audioContext.state);
          show('The coach is paused.', 'Audio was interrupted. It resumes when the route is back.');
        } else if (still === 'resume-only') scheduleRouteCheck();
      }, PLAYBACK_CUT_MS);
      routePauseTimer.unref?.();
    };
    audioContext.onstatechange = () => {
      if (!session || session.status().stopped) return;
      const action = onContextState(picture());
      // resume() during the sheet resolves when the sheet goes away, which is what lets speech start.
      if (action === 'resume-only' || action === 'pause') {
        audioContext.resume().catch(() => {});
        scheduleRouteCheck();
        return;
      }
      clearRoutePause();
      if (action === 'resume-session') {
        session.resumeAfterInterrupt();
        show(session.prompt() || 'The coach is listening.', lastFeedback);
      }
    };
  }
  return audioContext;
}

function armPlayAndRecord() {
  usePlayAndRecord(typeof navigator === 'undefined' ? null : navigator.audioSession);
}

async function context() {
  const ctx = ensureContext();
  armPlayAndRecord();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  return ctx;
}

// Called synchronously from the Start tap, before getUserMedia. The silent buffer
// unlocks this context so a clip can start after the permission sheet without another tap.
function armOutput(ctx) {
  armPlayAndRecord();
  let pending;
  try { pending = ctx.resume(); } catch (error) { pending = Promise.reject(error); }
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  try {
    const rate = ctx.sampleRate || SAMPLE_RATE;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.round(rate * 0.02)), rate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  } catch { /* the context is already unlocked, or it is closing */ }
  // Started inside the tap. iOS stops the mic processor when this one-shot ends.
  try { ensureCaptureClock(ctx); } catch { /* the context is closing */ }
  return pending;
}

// A looping silent buffer, started in the Start tap. On iPhone Safari the script
// processor only keeps pulling the microphone while a source like this stays
// connected to it. The opening prompt is a one-shot buffer, so without this the
// processor stops when the prompt ends and her take never reaches the coach.
function ensureCaptureClock(ctx) {
  if (captureClock) return captureClock;
  const rate = ctx.sampleRate || SAMPLE_RATE;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.round(rate * 0.02)), rate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start();
  captureClock = source;
  return source;
}

function outputGain(ctx) {
  if (!silentGain || silentGain.context !== ctx) {
    silentGain?.disconnect();
    silentGain = ctx.createGain();
    silentGain.gain.value = KEEP_ALIVE_GAIN;
    silentGain.connect(ctx.destination);
  }
  return silentGain;
}

function releaseGraph() {
  clearRoutePause();
  micGeneration += 1;
  processor?.disconnect();
  sourceNode?.disconnect();
  processor = null;
  sourceNode = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
}

async function suspendAudio() {
  if (audioContext && audioContext.state === 'running') await audioContext.suspend();
}

// Fragment keys start with ~ and are already normalized.
function clipUrl(key) {
  return VOICE_CLIPS[key.startsWith('~') ? key : voiceKey(key)];
}

function hasClip(key) {
  return Boolean(clipUrl(key));
}

// Clips play through the AudioContext unlocked by the Start tap. An HTML audio
// element is paused by the mic permission sheet and does not resume on its own,
// and a later play() is blocked once that tap's activation is gone.
function bufferFor(ctx, url) {
  let cache = clipBuffers.get(ctx);
  if (!cache) {
    cache = new Map();
    clipBuffers.set(ctx, cache);
  }
  const existing = cache.get(url);
  if (existing) return existing;
  const pending = fetch(url).then(async response => {
    if (!response.ok) throw new Error('missing clip');
    const bytes = await response.arrayBuffer();
    // decodeAudioData detaches the buffer it is given.
    return ctx.decodeAudioData(bytes.slice(0));
  }).catch(error => {
    cache.delete(url);
    throw error;
  });
  cache.set(url, pending);
  return pending;
}

function whenRunning(ctx, token) {
  if (!ctx || ctx.state === 'closed' || token !== speechToken) return Promise.resolve(false);
  // iOS can report running and still be silent until resume() is called again.
  let resumePromise;
  try { resumePromise = ctx.resume(); } catch (error) { resumePromise = Promise.reject(error); }
  if (resumePromise && typeof resumePromise.catch === 'function') resumePromise.catch(() => {});
  if (ctx.state === 'running') return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.removeEventListener?.('statechange', onState);
      resolve(Boolean(ok && token === speechToken && ctx.state === 'running'));
    };
    const onState = () => {
      if (token !== speechToken || ctx.state === 'closed') finish(false);
      else if (ctx.state === 'running') finish(true);
    };
    ctx.addEventListener?.('statechange', onState);
    const timer = setTimeout(() => finish(ctx.state === 'running'), RESUME_WAIT_MS);
    Promise.resolve(resumePromise).then(() => {
      if (ctx.state === 'running') finish(true);
    }, () => {
      if (ctx.state === 'running') finish(true);
    });
  });
}

function startBuffer(ctx, buffer, token) {
  return new Promise(resolve => {
    if (!buffer || token !== speechToken || ctx.state !== 'running') {
      resolve(false);
      return;
    }
    let source;
    try {
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
    } catch {
      resolve(false);
      return;
    }
    activeSource = source;
    let settled = false;
    let cut = false;
    let completed = false;
    let downSince = 0;
    let suspendedMs = 0;
    const startedMs = Date.now();
    const startedAt = ctx.currentTime || 0;
    const duration = buffer.duration || 0;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      ctx.removeEventListener?.('statechange', onState);
      if (activeSource === source) activeSource = null;
      resolve(ok);
    };
    const noteDown = () => {
      if (!downSince) downSince = Date.now();
    };
    const noteUp = () => {
      if (!downSince) return;
      suspendedMs += Date.now() - downSince;
      downSince = 0;
    };
    const played = () => bufferPlayed({
      cut,
      state: ctx.state,
      elapsedSec: (ctx.currentTime || 0) - startedAt,
      durationSec: duration,
      suspendedMs,
      nowMs: Date.now(),
      startedMs
    });
    const onState = () => {
      if (token !== speechToken || ctx.state === 'closed') {
        cut = true;
        try { source.stop(); } catch { /* already stopped */ }
        finish(false);
        return;
      }
      // Leave the source running through a flicker. resume() brings the route back
      // without a new tap. A held interruption fails the clip so the line can be said again.
      if (ctx.state === 'interrupted' || ctx.state === 'suspended') {
        noteDown();
        try {
          const pending = ctx.resume();
          if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        } catch { /* already resuming */ }
        return;
      }
      noteUp();
    };
    source.onended = () => {
      if (completed) {
        finish(true);
        return;
      }
      // Ended while the route was still down: the sheet or the route change stopped it.
      const down = ctx.state === 'interrupted' || ctx.state === 'suspended' || ctx.state === 'closed';
      if (down || cut || token !== speechToken) {
        cut = true;
        finish(false);
        return;
      }
      finish(true);
    };
    ctx.addEventListener?.('statechange', onState);
    // onended often never fires once a live microphone shares this context, which
    // used to leave the coach "speaking" forever and throw her take away.
    const watch = setInterval(() => {
      if (settled) return;
      if (token !== speechToken || ctx.state === 'closed') {
        cut = true;
        try { source.stop(); } catch { /* already stopped */ }
        finish(false);
        return;
      }
      if (ctx.state === 'interrupted' || ctx.state === 'suspended') {
        noteDown();
        if (downSince && interruptionHeld(Date.now() - downSince)) {
          cut = true;
          try { source.stop(); } catch { /* already stopped */ }
          finish(false);
        }
        return;
      }
      noteUp();
      if (played()) {
        completed = true;
        try { source.stop(); } catch { /* already stopped, or it never fires onended */ }
        finish(true);
      }
    }, 40);
    watch.unref?.();
    try { source.start(); } catch { finish(false); }
  });
}

async function playClip(url, token) {
  if (!url) return false;
  const ctx = ensureContext();
  let buffer;
  try { buffer = await bufferFor(ctx, url); } catch { return false; }
  if (token !== speechToken) return false;
  if (!(await whenRunning(ctx, token))) return false;
  return startBuffer(ctx, buffer, token);
}

async function playDecoded(bytes, token) {
  const ctx = ensureContext();
  if (!(await whenRunning(ctx, token)) || token !== speechToken) return false;
  let buffer;
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    buffer = await ctx.decodeAudioData(copy);
  } catch { return false; }
  if (token !== speechToken) return false;
  return startBuffer(ctx, buffer, token);
}

// Device speech, used only for a line without a clip when cloud speech is unavailable.
function speakDevice(text) {
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve(false);
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.95;
    let settled = false;
    // iOS sometimes never fires end. Without a limit the coach would stop listening for good.
    const limit = setTimeout(() => finish(true), 3000 + text.split(/\s+/).length * 600);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      resolve(ok);
    }
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    window.speechSynthesis.speak(utterance);
  });
}

// A silent utterance inside the tap lets later device speech play on iOS.
function primeDeviceSpeech() {
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return;
  const utterance = new SpeechSynthesisUtterance(' ');
  utterance.volume = 0;
  window.speechSynthesis.speak(utterance);
}

function stopSpeech() {
  speechToken += 1;
  try { activeSource?.stop(); } catch { /* already stopped */ }
  activeSource = null;
  window.speechSynthesis?.cancel();
}

async function playPart(part, token) {
  if (part.clip) {
    if (await playClip(clipUrl(part.clip), token)) return true;
    return token === speechToken && speakDevice(part.clip.replace(/^~/, ''));
  }
  // A line that names a word or a count is built at runtime. Cloud speech uses a similar voice.
  const bytes = await cloudSpeech(part.text);
  if (token !== speechToken) return false;
  if (bytes && await playDecoded(bytes.body, token)) return true;
  if (token !== speechToken) return false;
  return speakDevice(part.text);
}

async function runPlan(plan, token) {
  let ok = true;
  for (const part of plan) {
    if (token !== speechToken) return false;
    ok = (await playPart(part, token)) && ok;
  }
  return ok && token === speechToken;
}

/**
 * Speaks a line, interrupting whatever is playing. Turn detection stays off while it
 * plays and for a short tail, so the coach does not hear itself. The AudioContext
 * was unlocked on the Start tap, so a clip can still start after the mic sheet.
 * Resolves true when the whole line played.
 */
function speak(text) {
  if (!text) return Promise.resolve(true);
  stopSpeech();
  const token = speechToken;
  speaking = true;
  detector?.setSpeaking(true);
  return finishSpeech(text, token);
}

async function finishSpeech(text, token) {
  try {
    const plan = () => planSpeech(text, hasClip);
    let ok = await runPlan(plan(), token);
    // The sheet can stop a source that had already started. Say the whole line once it can run.
    if (!ok && token === speechToken && !hiddenByPage && audioContext && audioContext.state !== 'closed') {
      try { activeSource?.stop(); } catch { /* already stopped */ }
      if (activeSource) activeSource = null;
      window.speechSynthesis?.cancel();
      if (audioContext.state !== 'running') await whenRunning(audioContext, token);
      if (token === speechToken && audioContext.state === 'running') ok = await runPlan(plan(), token);
    }
    await new Promise(resolve => setTimeout(resolve, SPEECH_TAIL_MS));
    return Boolean(ok && token === speechToken);
  } finally {
    if (token === speechToken) {
      speaking = false;
      if (!judging) detector?.setSpeaking(false);
      if (audioContext && audioContext.state === 'suspended' && !hiddenByPage && !userPaused) audioContext.resume().catch(() => {});
    }
  }
}

async function say(text) {
  if (!text) return;
  show(text, session?.prompt() || '');
  await speak(text);
}

function fetchWithTimeout(url, options, ms = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function cloudSpeech(text) {
  try {
    const response = await fetchWithTimeout('/api/drive/turn', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: '', say: text })
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (!result.speech?.audioBase64) return null;
    const binary = atob(result.speech.audioBase64);
    const body = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) body[i] = binary.charCodeAt(i);
    return { body, mime: result.speech.mime };
  } catch { return null; }
}

function wavBase64(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function cloudTurn(samples, sampleRate) {
  try {
    const response = await fetchWithTimeout('/api/drive/turn', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // The reply's speech is never played, so do not ask the Worker to synthesize it.
      body: JSON.stringify({ audioBase64: wavBase64(samples, sampleRate), say: '' })
    }, TURN_TIMEOUT_MS);
    if (!response.ok) return null;
    return response.json();
  } catch { return null; }
}

function checkpoint() {
  const entry = session?.logEntry();
  if (!entry) return;
  if (navigator.onLine) {
    const flushed = session.flushSaves(true);
    savedDeps.save(entry);
    for (const queued of flushed.sent) if (queued.id !== entry.id) savedDeps.save(queued);
  } else session.queueSave(entry);
}

function bindVisibility() {
  if (visibilityHandler) return;
  visibilityHandler = () => { onVisibility().catch(() => {}); };
  document.addEventListener('visibilitychange', visibilityHandler);
}

function unbindVisibility() {
  if (!visibilityHandler) return;
  document.removeEventListener('visibilitychange', visibilityHandler);
  visibilityHandler = null;
}

async function finishSession(entry) {
  if (entry) savedDeps.save(entry);
  await ensureStayAwake().stop();
  showAwake('off');
  unbindVisibility();
  releaseGraph();
  await suspendAudio();
  const overlay = el('coachOverlay');
  if (overlay) overlay.hidden = true;
}

function spokenLine(turn, local) {
  if (turn?.tooNoisy || turn?.reason === 'noise') return local?.feedback?.text || readTurn(turn).text || '';
  if (local?.feedback?.spoken && local.feedback.text) return local.feedback.text;
  const take = readTurn(turn);
  if (take.text) return take.text;
  return '';
}

export function reviewLiveTurn(turn, coachSession, { goal, at = Date.now(), prompt } = {}) {
  const linePrompt = prompt || coachSession.prompt();
  const local = classifyUtterance({
    analysis: turn,
    prompt: linePrompt,
    goal,
    cursor: coachSession.status().cursor
  });
  const text = spokenLine(turn, local);
  // A blip or a one-beat tone is too short to judge. Say nothing and do not log it.
  if (!turn.tooNoisy && turn.hopVoicedMs < 200) return { ignored: true, events: [] };
  if (local.feedback) local.feedback = { ...local.feedback, text, spoken: Boolean(text) };
  return coachSession.noteAnalysis(local, { transcript: linePrompt, at });
}

async function onTurn(turn) {
  if (!session || speaking || judging || hiddenByPage || (session.status().paused && !userPaused)) return;
  judging = true;
  detector?.setSpeaking(true);
  try {
    await judgeTurn(turn);
  } finally {
    judging = false;
    if (!speaking) detector?.setSpeaking(false);
  }
}

/**
 * Decides what to say once the transcript is in. A command does the command and
 * returns only its short reply, so phrase feedback is not spoken for it.
 * An empty transcript means transcription failed or timed out: the take is coached
 * from the audio, and no command is guessed.
 */
export function planCoachTurn({
  session: coachSession,
  turn,
  heard = '',
  ear = null,
  goal = {},
  at = Date.now(),
  statusHeld: noisyStatusHeld = false
}) {
  const prompt = coachSession.prompt();
  const judged = classifyUtterance({
    analysis: turn,
    prompt,
    transcript: heard,
    goal,
    ear,
    cursor: coachSession.status().cursor
  });
  const localText = spokenLine(turn, judged);
  const command = matchCommand(heard, { paused: coachSession.status().paused, prompt });
  if (command) {
    const result = coachSession.command(command, at);
    return {
      type: 'command',
      command,
      result,
      feedbackText: '',
      extra: [],
      follow: '',
      say: result.say || '',
      heardLine: 'Heard you.',
      statusHeld: noisyStatusHeld,
      checkpoint: false,
      showLine: '',
      showSub: ''
    };
  }
  if (judged.feedback) judged.feedback = { ...judged.feedback, text: localText, spoken: Boolean(localText) };
  const noted = coachSession.noteAnalysis(judged, { transcript: heard || prompt, at });
  if (noted.ignored) {
    return {
      type: 'ignored',
      feedbackText: '',
      extra: [],
      follow: '',
      say: '',
      heardLine: 'Heard you.',
      statusHeld: noisyStatusHeld,
      checkpoint: false,
      showLine: '',
      showSub: '',
      noted
    };
  }
  const statusRepeat = /\btoo noisy\b/i.test(localText) && noisyStatusHeld;
  const feedbackText = localText && !statusRepeat ? localText : '';
  const extra = [];
  for (const event of noted.events) {
    if (event.text && event.text !== localText) extra.push(event.text);
  }
  const coached = Boolean(judged.feedback?.spoken);
  const tooNoisy = Boolean(judged.tooNoisy || turn.tooNoisy);
  const next = !coached && !tooNoisy ? coachSession.advance() : '';
  const follow = followUpLine({ prompt: coachSession.prompt(), coached, tooNoisy, next });
  return {
    type: 'practice',
    feedbackText,
    extra,
    follow,
    say: '',
    heardLine: coached ? 'Heard you. One thing to adjust.' : tooNoisy ? 'Heard you, but it was too noisy to judge.' : 'Heard you. That matched.',
    statusHeld: /\btoo noisy\b/i.test(judged.feedback?.text || ''),
    checkpoint: noted.events.some(event => event.type === 'feedback'),
    showLine: coachSession.prompt() || 'Free talk whenever you are ready.',
    showSub: judged.feedback?.text || '',
    noted
  };
}

async function judgeTurn(turn) {
  const prompt = session.prompt();
  showHeard('Heard you.');
  // Wait for the transcript before any phrase line. Otherwise "next phrase" is
  // coached out loud, and the command reply only starts after that finishes.
  const cloud = await cloudTurn(turn.samples, turn.sampleRate);
  if (!session || hiddenByPage || session.status().stopped) return;
  const plan = planCoachTurn({
    session,
    turn,
    heard: cloud?.transcript || '',
    ear: cloud?.ear ? parseEar(cloud.ear) : null,
    goal: savedDeps.getGoal(),
    at: clock ? clock() : Date.now(),
    statusHeld
  });
  if (plan.type === 'command') {
    const result = plan.result;
    if (result.type === 'pause') userPaused = true;
    if (result.type === 'resume') {
      userPaused = false;
      try { await listen(); } catch { /* the resume button stays available */ }
    }
    if (result.say) await say(result.say);
    if (result.type === 'stop') await finishSession(result.entry);
    else if (result.entry) savedDeps.save(result.entry);
    return;
  }
  if (plan.type === 'ignored') return;
  statusHeld = plan.statusHeld;
  lastFeedback = plan.showSub || '';
  if (plan.feedbackText) {
    show(plan.feedbackText, prompt || '');
    await speak(plan.feedbackText);
  }
  for (const line of plan.extra) {
    if (!session || session.status().stopped || hiddenByPage) return;
    await say(line);
  }
  if (plan.checkpoint) checkpoint();
  showHeard(plan.heardLine);
  show(plan.showLine, lastFeedback);
  if (plan.follow && session && !session.status().stopped && !hiddenByPage) await say(plan.follow);
}

function pushCaptured(input, ctx) {
  lastFrameAt = Date.now();
  if (session && detector) detector.setExpectation(expectedVoicedMs(session.prompt()));
  const copy = new Float32Array(input.length);
  copy.set(input);
  const samples = ctx.sampleRate === SAMPLE_RATE ? copy : resampleLinear(copy, ctx.sampleRate, SAMPLE_RATE);
  detector?.push(samples);
  let sum = 0;
  for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
  showLevel(Math.sqrt(sum / (copy.length || 1)));
}

function mixBuffer(buffer) {
  const count = buffer?.numberOfChannels || (buffer?.getChannelData ? 1 : 0);
  const channels = [];
  for (let channel = 0; channel < count; channel++) channels.push(buffer.getChannelData(channel));
  return mixChannels(channels);
}

function attachScriptCapture(ctx, generation, { direct }) {
  let node = null;
  if (direct) {
    try { node = ctx.createScriptProcessor(2048, 2, 1); } catch { node = null; }
  }
  if (!node) node = ctx.createScriptProcessor(2048, 1, 1);
  processor = node;
  processor.onaudioprocess = event => {
    if (generation !== micGeneration) return;
    const mixed = mixBuffer(event.inputBuffer);
    if (mixed.length) pushCaptured(mixed, ctx);
    // One non-zero sample keeps Safari pulling the node. The mic itself stays out of the speaker.
    const outCount = event.outputBuffer?.numberOfChannels || 0;
    for (let channel = 0; channel < outCount; channel++) {
      const output = event.outputBuffer.getChannelData(channel);
      output.fill(0);
      if (output.length) output[0] = 1e-4;
    }
  };
  sourceNode.connect(processor);
  // iOS only runs this callback when the processor's output is the context destination,
  // and only while a looping source is still connected. The prompt is not that source.
  if (direct) ensureCaptureClock(ctx).connect(processor);
  processor.connect(direct ? ctx.destination : outputGain(ctx));
}

async function attachCapture(ctx, generation) {
  // Do not set channelCount on this node. Explicit mono is silence on iPhone Safari.
  sourceNode = ctx.createMediaStreamSource(stream);
  const ios = needsDirectScriptCapture(navigator.userAgent || '', navigator.platform || '', navigator.maxTouchPoints || 0);
  if (ios && ctx.createScriptProcessor) {
    attachScriptCapture(ctx, generation, { direct: true });
    return;
  }
  const keepAlive = outputGain(ctx);
  try { sourceNode.connect(keepAlive); } catch { /* already connected */ }
  if (ctx.audioWorklet?.addModule) {
    try {
      if (!workletReady) workletReady = ctx.audioWorklet.addModule('drive-capture-worklet.js');
      await workletReady;
      const node = new AudioWorkletNode(ctx, 'drive-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
      processor = node;
      node.port.onmessage = event => {
        if (generation !== micGeneration) return;
        const channel = event.data;
        if (channel?.length) pushCaptured(channel, ctx);
      };
      sourceNode.connect(node);
      node.connect(keepAlive);
      return;
    } catch {
      workletReady = null;
    }
  }
  attachScriptCapture(ctx, generation, { direct: false });
}

async function listen(alreadyOpen) {
  const ctx = await context();
  releaseGraph();
  const generation = micGeneration;
  stream = alreadyOpen || await navigator.mediaDevices.getUserMedia({ audio: RAW_MIC });
  if (generation !== micGeneration || hiddenByPage) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
    return;
  }
  micOpenedAt = Date.now();
  await attachCapture(ctx, generation);
  const track = stream.getAudioTracks()[0];
  track.addEventListener('ended', () => {
    if (generation !== micGeneration || hiddenByPage || !session || session.status().stopped) return;
    recover();
  });
  // iOS mutes the track during a call or Siri and unmutes it afterward. The capture graph survives that.
  track.addEventListener('unmute', () => {
    if (generation !== micGeneration || !audioContext) return;
    audioContext.resume().catch(() => {});
  });
}

function micLive() {
  const track = stream?.getAudioTracks?.()[0];
  return Boolean(track && track.readyState === 'live' && track.enabled);
}

async function framesFlowing(since, ms = FLOW_MS) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (lastFrameAt > since) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return lastFrameAt > since;
}

// Rebuild capture without asking the driver to tap. If iOS refuses a new microphone
// outside a gesture, fall back to the tap.
function recover() {
  if (recovering || !session || session.status().stopped || hiddenByPage || userPaused || fileTest) return recovering;
  recovering = (async () => {
    try {
      const since = Date.now();
      if (!micLive()) await listen();
      else await context();
      if (!(await framesFlowing(since))) {
        await listen();
        if (!(await framesFlowing(Date.now()))) throw new Error('No microphone frames');
      }
      if (session.status().paused) session.resumeAfterInterrupt();
      el('coachResume').hidden = true;
      show(session.prompt() || 'The coach is listening.', lastFeedback);
    } catch {
      session?.interrupt('mic-ended');
      el('coachResume').hidden = false;
      show('The microphone stopped.', 'Tap to continue.');
    } finally {
      recovering = null;
    }
  })();
  return recovering;
}

function presenceArgs() {
  return {
    stopped: !session || session.status().stopped,
    userPaused,
    interrupt: reason => session.interrupt(reason),
    resume: () => session.resumeAfterInterrupt(),
    stopMic: releaseGraph,
    suspendAudio,
    resumeAudio: async () => {
      if (audioContext && audioContext.state !== 'running') await audioContext.resume();
    },
    openMic: async () => {
      if (!fileTest) await listen();
    },
    stayAwake: ensureStayAwake()
  };
}

async function onVisibility() {
  if (!session || session.status().stopped) return;
  const visible = document.visibilityState === 'visible';
  hiddenByPage = !visible;
  try {
    const result = await applyVisibility({ visible, ...presenceArgs() });
    showAwake(result.mode);
    if (!visible) {
      show('The coach is paused.', 'Open Lilt to continue.');
      return;
    }
    if (result.heldPaused) {
      show('The coach is paused.', 'Say resume when you want to continue.');
      return;
    }
    el('coachResume').hidden = true;
    show(session.prompt() || 'The coach is listening.', lastFeedback);
  } catch {
    el('coachResume').hidden = false;
    show('The microphone stopped.', 'Tap to continue.');
  }
}

export function mountDriveCoach(deps) {
  savedDeps = deps;
  fileTest = new URLSearchParams(location.search).has('coachTest');
  el('coachTestRow').hidden = !fileTest;
  const clicked = () => {
    const resumed = Boolean(session && !session.status().stopped);
    ensureSession();
    // A previous denial left the coach paused. This tap is the new start.
    userPaused = false;
    const opening = openingLine(session.prompt(), { resumed });
    const ctx = ensureContext();
    // Cover the sheet before it exists. The statechange it causes must not pause the coach.
    starting = true;
    awaitingPermission = !fileTest && Boolean(navigator.mediaDevices?.getUserMedia);
    // Unlock output and choose play-and-record before the prompt, still inside this tap.
    armOutput(ctx);
    let micPromise = null;
    if (awaitingPermission) {
      try { micPromise = navigator.mediaDevices.getUserMedia({ audio: RAW_MIC }); }
      catch (error) { micPromise = Promise.reject(error); }
    }
    const ready = ensureStayAwake().arm();
    const spoken = speak(opening);
    primeDeviceSpeech();
    const overlay = el('coachOverlay');
    if (overlay) {
      overlay.hidden = false;
      overlay.focus();
    }
    begin(ready, micPromise, { opening, spoken }).catch(error => {
      el('coachResume').hidden = false;
      show('The microphone did not start.', error.message || 'Tap to continue.');
    });
  };
  el('startCoach').onclick = clicked;
  el('coachResume').onclick = clicked;
  el('coachFile').onchange = () => {
    const ready = (!session || session.status().stopped) ? ensureStayAwake().arm() : null;
    consumeFile(el('coachFile').files?.[0], ready);
  };
  bindVisibility();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!session || session.status().stopped || hiddenByPage || userPaused) return;
    // The permission grant itself changes the route while the microphone is still opening.
    if (!stream || startupCoversInterruption({ awaitingPermission, starting, micOpenedAt, now: Date.now() })) return;
    recover();
  });
  window.addEventListener('online', () => {
    const flushed = session?.flushSaves(true);
    for (const entry of flushed?.sent || []) deps.save(entry);
  });
  window.__liltDriveCoach = {
    feed(samples, sampleRate = SAMPLE_RATE) {
      const audio = sampleRate === SAMPLE_RATE ? samples : resampleLinear(samples, sampleRate, SAMPLE_RATE);
      detector?.push(audio);
    },
    speaking: () => speaking,
    status: () => session?.status() || null,
    lastFeedback: () => lastFeedback,
    audioContext: () => audioContext,
    awake: () => ensureStayAwake().status()
  };
}

function ensureSession() {
  if (session && !session.status().stopped) return session;
  session = createCoachSession({
    plannedMinutes: savedDeps.getPlanned(),
    routineId: savedDeps.getRoutine(),
    lines: savedDeps.getLines(),
    now: Date.now()
  });
  detector = createTurnDetector({ sampleRate: SAMPLE_RATE, onTurn });
  detector.setExpectation(expectedVoicedMs(session.prompt()));
  lastFeedback = '';
  statusHeld = false;
  guideRetired = false;
  judging = false;
  showHeard('');
  const guide = el('coachGuide');
  if (guide) guide.hidden = false;
  return session;
}

async function failMic(error) {
  const copy = micFailureCopy(error);
  // Set before any await so a context that returns to running cannot unpause a coach with no microphone.
  userPaused = true;
  session?.interrupt('mic-denied');
  const resumeButton = el('coachResume');
  if (resumeButton) resumeButton.hidden = false;
  show(copy.line, copy.hint);
  try { await speak(copy.say); } catch { /* the screen still says what to do */ }
}

async function begin(ready, micPromise = null, { opening = '', spoken = null } = {}) {
  bindVisibility();
  starting = true;
  let mode = 'manual';
  try { mode = await ready; } catch { mode = 'manual'; }
  showAwake(mode);
  userPaused = false;
  ensureSession();
  if (session.status().paused) session.resumeAfterInterrupt();
  hiddenByPage = false;
  const resumeButton = el('coachResume');
  if (resumeButton) resumeButton.hidden = true;
  show(session.prompt() || 'Free talk whenever you are ready.', lastFeedback || 'I am listening.');
  try {
    if (fileTest) {
      awaitingPermission = false;
      await context();
      return;
    }
    let opened = null;
    try {
      opened = micPromise ? await micPromise : await navigator.mediaDevices.getUserMedia({ audio: RAW_MIC });
    } catch (error) {
      awaitingPermission = false;
      await failMic(error);
      return;
    }
    awaitingPermission = false;
    const since = Date.now();
    await listen(opened);
    if (!(await framesFlowing(since))) await listen();
    if (!(await framesFlowing(Date.now()))) throw new Error('The microphone is open but not sending sound. Tap to continue.');
    const played = spoken ? await spoken : true;
    const decision = afterMicRequest({ granted: true, openingPlayed: Boolean(played) });
    if (decision.replayOpening && opening && session && !session.status().stopped && !hiddenByPage) await speak(opening);
  } finally {
    starting = false;
    awaitingPermission = false;
  }
}

async function consumeFile(file, ready) {
  if (!file) return;
  if (!session || session.status().stopped) await begin(ready || ensureStayAwake().arm());
  const ctx = await context();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  const mixed = decoded.getChannelData(0);
  const samples = decoded.sampleRate === SAMPLE_RATE ? mixed : resampleLinear(mixed, decoded.sampleRate, SAMPLE_RATE);
  detector.push(samples);
  detector.push(new Float32Array(SAMPLE_RATE));
}

export function coachForTest(deps) {
  clock = deps.now;
  return { createSession: deps.createSession, feed: samples => detector?.push(samples) };
}
