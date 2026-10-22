import { SAMPLE_RATE, createTurnDetector, resampleLinear } from './drive-dsp.js';
import { classifyUtterance, createCoachSession, matchCommand, parseEar } from './drive-coach.js';
import { describeTake } from './drive-session.js';
import { applyVisibility, awakeLabel, createStayAwake } from './drive-wake.js';

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
  if (wasHidden) overlay.focus();
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
  if (ctx.state === 'suspended') await ctx.resume();
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

async function playSpeech(buffer, mime) {
  const ctx = await context();
  speaking = true;
  detector?.setSpeaking(true);
  const url = URL.createObjectURL(new Blob([buffer], { type: mime || 'audio/mpeg' }));
  if (!player) player = new Audio();
  player.src = url;
  try {
    await player.play();
    await new Promise(resolve => { player.onended = resolve; player.onerror = resolve; });
  } catch { /* device speech is the fallback */ }
  URL.revokeObjectURL(url);
  player.removeAttribute('src');
  speaking = false;
  detector?.setSpeaking(false);
  if (ctx.state === 'suspended' && !hiddenByPage) await ctx.resume();
}

function speakLocal(text) {
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve();
  speaking = true;
  detector?.setSpeaking(true);
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.95;
    utterance.onend = utterance.onerror = () => { speaking = false; detector?.setSpeaking(false); resolve(); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

async function say(text) {
  if (!text) return;
  show(text, session?.prompt() || '');
  const bytes = await cloudSpeech(text);
  if (bytes) await playSpeech(bytes.body, bytes.mime);
  else await speakLocal(text);
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

async function cloudTurn(samples, sampleRate, line) {
  try {
    const response = await fetchWithTimeout('/api/drive/turn', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: wavBase64(samples, sampleRate), say: line })
    });
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
  const take = turn?.samples?.length ? describeTake(turn.samples, turn.sampleRate || SAMPLE_RATE) : null;
  const localText = local.feedback?.text || '';
  if (take?.tooNoisy) return take.text;
  if (take?.cueId === 'pitch-drop-end' && local.feedback?.issue === 'fry') return take.text;
  if (!localText && take?.text) return take.text;
  return localText;
}

async function onTurn(turn) {
  if (!session || speaking || hiddenByPage) return;
  const prompt = session.prompt();
  const local = classifyUtterance({
    analysis: turn,
    prompt,
    goal: savedDeps.getGoal(),
    cursor: session.status().cursor
  });
  const localText = spokenLine(turn, local);
  if (localText) {
    lastFeedback = localText;
    show(localText, prompt || '');
  }
  const voicePromise = localText ? speakLocal(localText) : Promise.resolve();
  const cloud = await cloudTurn(turn.samples, turn.sampleRate, localText);
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
  if (localText && judged.feedback) judged.feedback = { ...judged.feedback, text: localText };
  const noted = session.noteAnalysis(judged, { transcript: heard || prompt, at: clock ? clock() : Date.now() });
  await voicePromise;
  if (noted.ignored) return;
  lastFeedback = judged.feedback.text;
  for (const event of noted.events) {
    if (event.type === 'comfort-check') awaitingComfort = true;
    if (event.text && event.text !== localText) await say(event.text);
  }
  if (noted.events.some(event => event.type === 'feedback')) checkpoint();
  show(session.prompt() || 'Free talk whenever you are ready.', lastFeedback);
}

function pushCaptured(input, ctx) {
  const copy = new Float32Array(input.length);
  copy.set(input);
  const samples = ctx.sampleRate === SAMPLE_RATE ? copy : resampleLinear(copy, ctx.sampleRate, SAMPLE_RATE);
  detector?.push(samples);
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
  await attachCapture(ctx, generation);
  stream.getAudioTracks()[0].addEventListener('ended', () => {
    if (generation !== micGeneration || hiddenByPage || !session || session.status().stopped) return;
    session.interrupt('mic-ended');
    el('coachResume').hidden = false;
    show('The microphone stopped.', 'Tap to continue.');
  });
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
    const overlay = el('coachOverlay');
    if (overlay) {
      overlay.hidden = false;
      overlay.focus();
    }
    begin(ready, micPromise).catch(error => show('The microphone is needed.', error.message || 'Allow the microphone, then tap to continue.'));
  };
  el('startCoach').onclick = clicked;
  el('coachResume').onclick = clicked;
  el('coachFile').onchange = () => {
    const ready = (!session || session.status().stopped) ? ensureStayAwake().arm() : null;
    consumeFile(el('coachFile').files?.[0], ready);
  };
  bindVisibility();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!session || session.status().stopped || hiddenByPage) return;
    const track = stream?.getAudioTracks?.()[0];
    if (!track || track.readyState === 'ended') {
      el('coachResume').hidden = false;
      show('The microphone stopped.', 'The audio route changed. Tap to continue.');
      return;
    }
    context().then(ctx => ctx.resume()).catch(() => {});
    show(session.prompt() || 'The coach is listening.', 'The audio route changed.');
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

async function begin(ready, micPromise = null) {
  bindVisibility();
  const mode = await ready;
  showAwake(mode);
  userPaused = false;
  if (!session || session.status().stopped) {
    const lines = savedDeps.getLines();
    session = createCoachSession({
      plannedMinutes: savedDeps.getPlanned(),
      routineId: savedDeps.getRoutine(),
      lines,
      now: Date.now()
    });
    detector = createTurnDetector({ sampleRate: SAMPLE_RATE, onTurn });
    awaitingComfort = false;
    lastFeedback = '';
  } else if (session.status().paused) {
    session.resumeAfterInterrupt();
  }
  hiddenByPage = false;
  el('coachResume').hidden = true;
  show(session.prompt() || 'Free talk whenever you are ready.', lastFeedback || 'I am listening.');
  if (!fileTest) await listen(micPromise ? await micPromise : null);
  else await context();
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
