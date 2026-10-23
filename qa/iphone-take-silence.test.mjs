// June, on iPhone Safari after PR #8: the opening plays, she repeats the phrase,
// and the coach never answers. Playback timers are not the hole. Her samples
// never reach the turn detector. This drives the real capture code. It does not
// call feed(). The deployed worklet is loaded from public/drive-capture-worklet.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { synthesizeWords } from '../drive-dsp.js';

const PHRASE = 'Hi there.';
const workletCtors = {};
new Function('AudioWorkletProcessor', 'registerProcessor', readFileSync(fileURLToPath(new URL('../public/drive-capture-worklet.js', import.meta.url)), 'utf8'))(
  class AudioWorkletProcessor {},
  (name, ctor) => { workletCtors[name] = ctor; }
);

function element() {
  return {
    hidden: true,
    textContent: '',
    style: {},
    focus() {},
    play: () => Promise.resolve(),
    pause() {}
  };
}

class FakeAudioContext {
  static latest = null;
  constructor() {
    this.sampleRate = 16000;
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = { kind: 'destination' };
    this.onstatechange = null;
    this.events = new Map();
    this.sources = [];
    this.mediaSource = null;
    this.workletNodes = 0;
    this.workletPosts = 0;
    this.workletEnergy = 0;
    this.scriptCallbacks = 0;
    this.scriptInputs = 0;
    this.micQueue = new Float32Array(0);
    this.micPos = 0;
    this.audioWorklet = { addModule: async () => {} };
    FakeAudioContext.latest = this;
  }
  addEventListener(type, fn) {
    if (!this.events.has(type)) this.events.set(type, new Set());
    this.events.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.events.get(type)?.delete(fn);
  }
  setState(next) {
    this.state = next;
    this.onstatechange?.();
    for (const fn of this.events.get('statechange') || []) fn();
  }
  resume() {
    if (this.state !== 'running') this.setState('running');
    return Promise.resolve();
  }
  suspend() {
    this.setState('suspended');
    return Promise.resolve();
  }
  close() {
    this.setState('closed');
    return Promise.resolve();
  }
  createGain() {
    const node = { context: this, gain: { value: 0 }, connect() {}, disconnect() {} };
    return node;
  }
  createBuffer(_channels, length, rate) {
    return { duration: length / rate, length };
  }
  createBufferSource() {
    const ctx = this;
    const source = {
      buffer: null,
      started: false,
      ended: false,
      stopped: false,
      connect() {},
      onended: null,
      start() {
        source.started = true;
        ctx.sources.push(source);
        source.timer = setTimeout(() => {
          if (source.ended) return;
          source.ended = true;
          source.onended?.();
        }, 30);
        source.timer.unref?.();
      },
      stop() {
        if (source.ended) return;
        source.ended = true;
        source.stopped = true;
        clearTimeout(source.timer);
        source.onended?.();
      }
    };
    return source;
  }
  createMediaStreamSource() {
    const node = { channelCount: 2, channelCountMode: 'max', connect() {}, disconnect() {} };
    this.mediaSource = node;
    return node;
  }
  createScriptProcessor(_size, inputChannels = 1) {
    this.scriptInputs = inputChannels;
    const ctx = this;
    const node = {
      disconnected: false,
      onaudioprocess: null,
      connect(dest) {
        // iPhone Safari does not run this callback unless the output is the
        // destination, and an explicit-mono source is silence.
        if (dest !== ctx.destination || ctx.mediaSource?.channelCountMode === 'explicit') return;
        const tick = () => {
          if (node.disconnected) return;
          ctx.scriptCallbacks += 1;
          const size = 2048;
          node.onaudioprocess?.({
            inputBuffer: {
              numberOfChannels: inputChannels,
              getChannelData(channel) {
                if (channel !== 1 || inputChannels < 2) return new Float32Array(size);
                return take(ctx, size);
              }
            },
            outputBuffer: {
              numberOfChannels: 1,
              getChannelData: () => new Float32Array(size)
            }
          });
          node.timer = setTimeout(tick, 5);
          node.timer.unref?.();
        };
        tick();
      },
      disconnect() {
        node.disconnected = true;
        clearTimeout(node.timer);
      }
    };
    return node;
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 0.35, length: 5600 });
  }
}

function take(ctx, size) {
  const out = new Float32Array(size);
  const start = ctx.micPos;
  const end = Math.min(ctx.micQueue.length, start + size);
  if (end > start) out.set(ctx.micQueue.subarray(start, end));
  ctx.micPos = end;
  return out;
}

function safariInputs(ctx, size) {
  // Explicit mono is what forceMono asks for. Safari answers with an empty channel.
  if (ctx.mediaSource?.channelCountMode === 'explicit' || ctx.mediaSource?.channelCount === 1) {
    return [[new Float32Array(size)]];
  }
  return [[new Float32Array(size), take(ctx, size)]];
}

class SilentChannelWorklet {
  constructor(ctx) {
    const Ctor = workletCtors['drive-capture'];
    this.processor = new Ctor();
    this.port = { onmessage: null };
    this.processor.port = {
      postMessage: data => {
        ctx.workletPosts += 1;
        if (data?.length) {
          let energy = 0;
          for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
          ctx.workletEnergy += energy;
        }
        this.port.onmessage?.({ data });
      }
    };
    this.ctx = ctx;
    this.disconnected = false;
    ctx.workletNodes += 1;
  }
  connect() {
    const tick = () => {
      if (this.disconnected) return;
      this.processor.process(safariInputs(this.ctx, 128), [[]], {});
      this.timer = setTimeout(tick, 10);
      this.timer.unref?.();
    };
    tick();
  }
  disconnect() {
    this.disconnected = true;
    clearTimeout(this.timer);
  }
}

function installPage() {
  const elements = new Map();
  globalThis.document = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return element(); }
  };
  globalThis.location = { search: '' };
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 16);
  globalThis.AudioWorkletNode = SilentChannelWorklet;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/api/drive/turn')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const heard = body.audioBase64 ? PHRASE : '';
      return { ok: true, json: async () => ({ transcript: heard, ear: null }), arrayBuffer: async () => new ArrayBuffer(8) };
    }
    return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) };
  };
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; }
  }
  globalThis.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  globalThis.window = {
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    AudioWorkletNode: SilentChannelWorklet,
    addEventListener() {},
    SpeechSynthesisUtterance,
    speechSynthesis: { cancel() {}, speak(utterance) { utterance.onend?.(); } }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
      audioSession: { type: 'auto' },
      onLine: true,
      mediaDevices: {
        getUserMedia: () => Promise.resolve({
          getTracks: () => [{ readyState: 'live', addEventListener() {}, stop() {} }],
          getAudioTracks: () => [{ readyState: 'live', addEventListener() {}, stop() {} }]
        }),
        addEventListener() {}
      },
      wakeLock: { request: () => Promise.resolve({ addEventListener() {}, release: () => Promise.resolve() }) }
    }
  });
  return elements;
}

function phraseTake() {
  const speech = synthesizeWords([{ text: 'hi', ms: 800, f0: 210, f1: 380, f2: 2200, seed: 21, gapMs: 0 }]).samples;
  const lead = new Float32Array(Math.floor(16000 * 0.4));
  const tail = new Float32Array(Math.floor(16000 * 1.6));
  const queued = new Float32Array(lead.length + speech.length + tail.length);
  queued.set(speech, lead.length);
  return queued;
}

function longClips(audio) {
  return audio.sources.filter(source => (source.buffer?.duration || 0) > 0.05);
}

async function waitFor(check, label, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    let ok = false;
    try { ok = Boolean(check()); } catch { ok = false; }
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(label);
}

test('iPhone Safari speaks feedback after her take, through the mic graph', async () => {
  const elements = installPage();
  const ui = await import(`../drive-ui.js?iphone-take=${Math.random()}`);
  ui.mountDriveCoach({
    getPlanned: () => 30,
    getRoutine: () => 'week-1',
    getLines: () => [PHRASE, 'We are ready.'],
    getGoal: () => ({}),
    save() {}
  });
  elements.get('startCoach').onclick();
  const audio = FakeAudioContext.latest;
  const coach = globalThis.window.__liltDriveCoach;
  try {
    await waitFor(() => coach.speaking() === false && longClips(audio).length >= 1, 'opening prompt never finished');
    const afterOpening = longClips(audio).length;
    audio.micQueue = phraseTake();
    audio.micPos = 0;
    await waitFor(() => {
      const heard = elements.get('coachHeard').textContent;
      return /Heard you/.test(heard) && longClips(audio).length > afterOpening;
    }, `feedback never spoken after the take. paused=${coach.status()?.paused} speaking=${coach.speaking?.()} line="${elements.get('coachLine').textContent}" heard="${elements.get('coachHeard').textContent}" workletNodes=${audio.workletNodes} workletPosts=${audio.workletPosts} workletEnergy=${audio.workletEnergy.toFixed(4)} scriptInputs=${audio.scriptInputs} scriptCallbacks=${audio.scriptCallbacks} explicit=${audio.mediaSource?.channelCountMode} clips=${longClips(audio).length}`);
    assert.equal(coach.status().paused, false);
  } finally {
    for (const source of audio.sources) source.stop?.();
  }
});
