import { SAMPLE_RATE, createTurnDetector, resampleLinear } from './drive-dsp.js';
import { classifyUtterance, createCoachSession, followUpLine, matchCommand, openingLine, parseEar } from './drive-coach.js';
import { createDriveSession, readTurn } from './drive-session.js';
import { applyVisibility, awakeLabel, createStayAwake } from './drive-wake.js';
import { planSpeech, voiceKey } from './drive-voice.js';
import { VOICE_CLIPS } from './drive-voice-clips.js';

export { createDriveSession };

let audioContext = null;
let silentGain = null;
let detector = null;
let session = null;
let speaking = false;
let player = null;
let sourceNode = null;
let processor = null;
let stream = null;
let savedDeps = null;
let fileTest = false;
let lastFeedback = '';
let statusHeld = false;
let guideRetired = false;
let awaitingComfort = false;
let clock = null;
let userPaused = false;
let hiddenByPage = false;
let contextBound = false;
let micGeneration = 0;
let captureScratch = new Float32Array(0);
let stayAwake = null;
let visibilityHandler = null;
let workletReady = null;
let judging = false;
let speechToken = 0;
const SPEECH_TAIL_MS = 250;
let levelFrame = 0;
let levelPeak = 0;
const TURN_TIMEOUT_MS = 6000;
// Granting the microphone on iOS switches the audio session, which fires devicechange and
// can briefly interrupt the AudioContext. Route events inside this window are part of startup.
const SETTLE_MS = 1500;
const FLOW_MS = 1200;
let micOpenedAt = 0;
let lastFrameAt = 0;
let starting = false;
let recovering = null;
const RAW_MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

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
    try {
      audioContext = new Ctor({ sampleRate: SAMPLE_RATE });
    } catch {
      audioContext = new Ctor();
    }
  }
  if (!contextBound) {
    contextBound = true;
    audioContext.onstatechange = () => {
      if (!session || session.status().stopped || hiddenByPage || userPaused) return;
      if (document.visibilityState === 'hidden') return;
      if (audioContext.state === 'suspended' || audioContext.state === 'interrupted') {
        // Try to get audio back first. Pause only if it stays down past startup.
        audioContext.resume().catch(() => {});
        if (starting || Date.now() - micOpenedAt < SETTLE_MS) return;
        session.interrupt(audioContext.state);
        show('The coach is paused.', 'Audio was interrupted. It resumes when the route is back.');
      } else if (audioContext.state === 'running' && session.status().paused) {
        session.resumeAfterInterrupt();
        show(session.prompt() || 'The coach is listening.', lastFeedback);
      }
    };
  }
  return audioContext;
}

async function context() {
  const ctx = ensureContext();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const sessionAudio = navigator.audioSession;
  if (sessionAudio && sessionAudio.type !== 'play-and-record') sessionAudio.type = 'play-and-record';
  return ctx;
}

function outputGain(ctx) {
  if (!silentGain || silentGain.context !== ctx) {
    silentGain?.disconnect();
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    silentGain.connect(ctx.destination);
  }
  return silentGain;
}

function releaseGraph() {
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

// One audio element plays every spoken line. The Start tap plays the first clip on it,
// which unlocks it on iOS for the rest of the session.
function audioElement() {
  if (!player) {
    player = new Audio();
    player.preload = 'auto';
    player.setAttribute('playsinline', '');
  }
  return player;
}

function hasClip(text) {
  return Boolean(VOICE_CLIPS[voiceKey(text)]);
}

// Resolves true when the URL played to the end and false when it failed or was cut off.
function playUrl(url) {
  const audio = audioElement();
  audio.src = url;
  let started;
  try { started = audio.play(); } catch { return Promise.resolve(false); }
  return Promise.resolve(started).then(() => new Promise(resolve => {
    const done = ok => {
      audio.onended = audio.onerror = audio.onpause = null;
      resolve(ok);
    };
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.onpause = () => done(audio.ended);
  }), () => false);
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
  if (player && !player.paused) player.pause();
  window.speechSynthesis?.cancel();
}

async function playPart(part, token) {
  if (part.clip) {
    if (await playUrl(VOICE_CLIPS[voiceKey(part.clip)])) return true;
    return token === speechToken && speakDevice(part.clip);
  }
  // A line that names a word or a count is built at runtime. Cloud speech uses a similar voice.
  const bytes = await cloudSpeech(part.text);
  if (token !== speechToken) return false;
  if (bytes) {
    const url = URL.createObjectURL(new Blob([bytes.body], { type: bytes.mime || 'audio/mpeg' }));
    const played = await playUrl(url);
    URL.revokeObjectURL(url);
    if (played) return true;
    if (token !== speechToken) return false;
  }
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
 * plays and for a short tail, so the coach does not hear itself. The first clip starts
 * synchronously, so a call from the Start tap counts as the user gesture.
 * Resolves true when the whole line played.
 */
function speak(text) {
  if (!text) return Promise.resolve(true);
  stopSpeech();
  const token = speechToken;
  speaking = true;
  detector?.setSpeaking(true);
  return runPlan(planSpeech(text, hasClip), token).then(ok => new Promise(resolve => {
    setTimeout(() => {
      if (token === speechToken) {
        speaking = false;
        detector?.setSpeaking(false);
        if (audioContext && audioContext.state === 'suspended' && !hiddenByPage) audioContext.resume().catch(() => {});
      }
      resolve(ok);
    }, SPEECH_TAIL_MS);
  }));
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
  const take = readTurn(turn);
  if (take.text) return take.text;
  const issues = new Set((local?.confident || []).map(item => item.issue));
  if ((issues.has('fry') || issues.has('drop')) && local?.feedback?.text) return local.feedback.text;
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
  if (!text && !turn.tooNoisy && turn.hopVoicedMs < 200) return { ignored: true, events: [] };
  if (local.feedback) local.feedback = { ...local.feedback, text, spoken: Boolean(text) };
  return coachSession.noteAnalysis(local, { transcript: linePrompt, at });
}

async function onTurn(turn) {
  if (!session || speaking || judging || hiddenByPage || (session.status().paused && !userPaused)) return;
  judging = true;
  try {
    await judgeTurn(turn);
  } finally {
    judging = false;
  }
}

async function judgeTurn(turn) {
  const prompt = session.prompt();
  showHeard('Heard you.');
  const local = classifyUtterance({
    analysis: turn,
    prompt,
    goal: savedDeps.getGoal(),
    cursor: session.status().cursor
  });
  const localText = spokenLine(turn, local);
  const statusRepeat = /\btoo noisy\b/i.test(localText) && statusHeld;
  if (localText && !statusRepeat) {
    statusHeld = /\btoo noisy\b/i.test(localText);
    lastFeedback = localText;
    show(localText, prompt || '');
  }
  const voicePromise = localText && !statusRepeat ? speak(localText) : Promise.resolve();
  const cloud = await cloudTurn(turn.samples, turn.sampleRate);
  if (!session || hiddenByPage || session.status().stopped) {
    await voicePromise;
    return;
  }
  const ear = cloud?.ear ? parseEar(cloud.ear) : null;
  const heard = cloud?.transcript || '';
  const command = matchCommand(heard, { paused: session.status().paused });
  if (command) {
    await voicePromise;
    const result = session.command(command);
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
  if (awaitingComfort) {
    const comfort = session.comfortReply(heard || prompt);
    if (comfort?.say) {
      await voicePromise;
      awaitingComfort = false;
      await say(comfort.say);
      if (comfort.type === 'comfort-pause') await finishSession(comfort.entry);
      else if (comfort.entry) savedDeps.save(comfort.entry);
      return;
    }
  }
  const judged = ear ? classifyUtterance({
    analysis: turn,
    prompt: heard || prompt,
    goal: savedDeps.getGoal(),
    ear,
    cursor: session.status().cursor
  }) : local;
  const heardText = spokenLine(turn, judged) || localText;
  if (judged.feedback) judged.feedback = { ...judged.feedback, text: heardText, spoken: Boolean(heardText) };
  const noted = session.noteAnalysis(judged, { transcript: heard || prompt, at: clock ? clock() : Date.now() });
  await voicePromise;
  if (noted.ignored) return;
  lastFeedback = judged.feedback.text;
  statusHeld = /\btoo noisy\b/i.test(lastFeedback || '');
  for (const event of noted.events) {
    if (event.type === 'comfort-check') awaitingComfort = true;
    if (event.text && event.text !== localText) await say(event.text);
  }
  if (noted.events.some(event => event.type === 'feedback')) checkpoint();
  const coached = Boolean(judged.feedback?.spoken);
  const tooNoisy = Boolean(judged.tooNoisy || turn.tooNoisy);
  const asked = noted.events.some(event => event.type === 'comfort-check' || event.type === 'rest');
  const next = !coached && !tooNoisy && !asked ? session.advance() : '';
  const follow = asked ? '' : followUpLine({ prompt: session.prompt(), coached, tooNoisy, next });
  showHeard(coached ? 'Heard you. One thing to adjust.' : tooNoisy ? 'Heard you, but it was too noisy to judge.' : 'Heard you. That was clear.');
  show(session.prompt() || 'Free talk whenever you are ready.', lastFeedback);
  if (follow && !session.status().stopped && !hiddenByPage) await say(follow);
}

function pushCaptured(input, ctx) {
  lastFrameAt = Date.now();
  const copy = new Float32Array(input.length);
  copy.set(input);
  const samples = ctx.sampleRate === SAMPLE_RATE ? copy : resampleLinear(copy, ctx.sampleRate, SAMPLE_RATE);
  detector?.push(samples);
  let sum = 0;
  for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
  showLevel(Math.sqrt(sum / (copy.length || 1)));
}

async function attachCapture(ctx, generation) {
  sourceNode = ctx.createMediaStreamSource(stream);
  if (ctx.audioWorklet?.addModule) {
    try {
      if (!workletReady) workletReady = ctx.audioWorklet.addModule('drive-capture-worklet.js');
      await workletReady;
      const node = new AudioWorkletNode(ctx, 'drive-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      processor = node;
      node.port.onmessage = event => {
        if (generation !== micGeneration) return;
        const channel = event.data;
        if (channel?.length) pushCaptured(channel, ctx);
      };
      sourceNode.connect(node);
      node.connect(outputGain(ctx));
      return;
    } catch {
      workletReady = null;
    }
  }
  processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = event => {
    const input = event.inputBuffer.getChannelData(0);
    pushCaptured(input, ctx);
  };
  sourceNode.connect(processor);
  processor.connect(outputGain(ctx));
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
    const opening = openingLine(session.prompt(), { resumed });
    const ctx = ensureContext();
    let resumePromise;
    try { resumePromise = ctx.resume(); } catch (error) { resumePromise = Promise.reject(error); }
    if (resumePromise && typeof resumePromise.catch === 'function') resumePromise.catch(() => {});
    let micPromise = null;
    if (!fileTest && navigator.mediaDevices?.getUserMedia) {
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
      show('The microphone is needed.', error.message || 'Allow the microphone, then tap to continue.');
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
    if (starting || !stream || Date.now() - micOpenedAt < SETTLE_MS) return;
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
  awaitingComfort = false;
  lastFeedback = '';
  statusHeld = false;
  guideRetired = false;
  judging = false;
  showHeard('');
  const guide = el('coachGuide');
  if (guide) guide.hidden = false;
  return session;
}

async function begin(ready, micPromise = null, { opening = '', spoken = null } = {}) {
  bindVisibility();
  const mode = await ready;
  showAwake(mode);
  userPaused = false;
  ensureSession();
  if (session.status().paused) session.resumeAfterInterrupt();
  hiddenByPage = false;
  el('coachResume').hidden = true;
  show(session.prompt() || 'Free talk whenever you are ready.', lastFeedback || 'I am listening.');
  starting = true;
  try {
    if (!fileTest) {
      const since = Date.now();
      await listen(micPromise ? await micPromise : null);
      if (!(await framesFlowing(since))) await listen();
      if (!(await framesFlowing(Date.now()))) throw new Error('The microphone is open but not sending sound. Tap to continue.');
    } else await context();
  } finally {
    starting = false;
  }
  // Opening the microphone can cut off speech on iOS. If the opening line did not finish, say it again.
  if (opening && spoken && !(await spoken) && session && !session.status().stopped && !hiddenByPage) await speak(opening);
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
