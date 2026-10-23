// Gate for the live iPhone Safari failure that PR #8 shipped with a green suite.
//
// June hears the opening sentence, then nothing after she says it. The old
// drive-mic-start harness called __liltDriveCoach.feed(), posted zeros from the
// script processor, and nudged the clip clock forward, so it never asked the
// capture graph to hear her. The follow-up test in that file now uses these rules.
//
// This fake is the iPhone graph those tests skip:
// - Hardware rate is 48 kHz. The worklet block is 128 frames.
// - AudioWorkletNode defaults to channelCountMode "explicit". Forcing channelCount 1 (the
//   current capture node) makes Safari hand the processor one silent channel. Stereo explicit
//   input keeps the voice on channel 0 and silence on channel 1 (WebKit bug 259193).
// - A ScriptProcessor forced to explicit mono is silent the same way. A processor that is not
//   forced mono gets the voice on channel 0.
// - The real drive-capture-worklet.js runs. It cannot invent samples the graph did not deliver.
// - onended never fires, and currentTime does not move, once the mic is live. A clip finishes
//   only from the wall clock.
// - The script processor keeps the microphone only while a clip is still playing, or while a
//   looping source is connected to that processor. After the one-shot prompt ends, silence
//   here is the live bug.
// - feed() throws. A reply counts only when a new clip buffer starts on the audio context.
//
// A pass here is still not a phone certificate. It does not measure earpiece routing or the
// play-and-record volume drop. It does fail the build that is live tonight.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { synthesizeWords } from '../drive-dsp.js';

const BLOCK = 128;
const RATE = 48000;
const PHRASE = 'Hi there.';
const LINES = ['Hi there.', 'We are ready.'];

function loadWorklet() {
  const src = readFileSync(new URL('../public/drive-capture-worklet.js', import.meta.url), 'utf8');
  let Ctor = null;
  const sandbox = {
    AudioWorkletProcessor: class {},
    registerProcessor(_name, ctor) { Ctor = ctor; }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (!Ctor) throw new Error('drive-capture-worklet.js did not register a processor');
  return Ctor;
}

const WorkletProcessor = loadWorklet();

function explicitMono(node) {
  if (!node || node.channelCount !== 1) return false;
  // Worklet nodes are explicit unless the page opts out. Script processors are not,
  // until forceMono sets the mode. Explicit mono is the silent iOS input.
  if (node.kind === 'worklet') return node.channelCountMode !== 'max' && node.channelCountMode !== 'clamped-max';
  return node.channelCountMode === 'explicit';
}

function countVoice(samples) {
  let n = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 0.02) n += 1;
  return n;
}

class MicQueue {
  constructor() {
    this.chunks = [];
    this.offset = 0;
  }
  push(samples) {
    this.chunks.push(samples);
  }
  take(n) {
    const out = new Float32Array(n);
    let filled = 0;
    while (filled < n && this.chunks.length) {
      const chunk = this.chunks[0];
      const avail = chunk.length - this.offset;
      const take = Math.min(avail, n - filled);
      out.set(chunk.subarray(this.offset, this.offset + take), filled);
      this.offset += take;
      filled += take;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }
}

function phraseAt48k(seed) {
  const speech = synthesizeWords([
    { text: 'hi', ms: 700, f0: 210, f1: 380, f2: 2200, seed, gapMs: 30, gain: 0.6 },
    { text: 'there', ms: 520, f0: 195, f1: 440, f2: 1850, seed: seed + 4, gapMs: 0, gain: 0.6 }
  ]).samples;
  // 0.5s covers the post-speech guard (0.28s at 16 kHz) after the coach stops talking.
  const lead = Math.floor(RATE * 0.5);
  const tail = Math.floor(RATE * 1.7);
  const out = new Float32Array(lead + speech.length * 3 + tail);
  for (let i = 0; i < speech.length; i++) {
    const sample = speech[i];
    out[lead + i * 3] = sample;
    out[lead + i * 3 + 1] = sample;
    out[lead + i * 3 + 2] = sample;
  }
  return out;
}

class SafariAudioContext {
  static latest = null;
  constructor() {
    this.sampleRate = RATE;
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = { kind: 'destination' };
    this.onstatechange = null;
    this.events = new Map();
    this.sources = [];
    this.queue = new MicQueue();
    this.voiceSamplesPosted = 0;
    this.workletNodes = 0;
    this.scriptNodes = 0;
    this.workletUrl = '';
    this.interruptions = 0;
    this.waiters = [];
    this.nodes = [];
    this.gain = null;
    this.pump = setInterval(() => this.tick(), 10);
    this.pump.unref?.();
    SafariAudioContext.latest = this;
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
    const property = this.onstatechange;
    const list = [...(this.events.get('statechange') || [])];
    if (typeof property === 'function') property();
    for (const fn of list) fn();
  }
  resume() {
    if (this.interruptions > 0) return new Promise(resolve => { this.waiters.push(resolve); });
    if (this.state !== 'running') this.setState('running');
    return Promise.resolve();
  }
  endInterruption() {
    this.interruptions = 0;
    const waiters = this.waiters.splice(0);
    if (this.state !== 'running') this.setState('running');
    for (const resolve of waiters) resolve();
  }
  suspend() {
    this.setState('suspended');
    return Promise.resolve();
  }
  close() {
    this.setState('closed');
    this.stop();
    return Promise.resolve();
  }
  createGain() {
    const node = {
      context: this,
      gain: { value: 0 },
      connect() { node.connected = true; },
      disconnect() { node.connected = false; },
      connected: false
    };
    this.gain = node;
    return node;
  }
  createBuffer(_channels, length, rate) {
    return { duration: length / rate, length, numberOfChannels: 1 };
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 0.3, length: Math.round(RATE * 0.3), numberOfChannels: 1 });
  }
  createBufferSource() {
    const ctx = this;
    const source = {
      context: ctx,
      buffer: null,
      loop: false,
      started: false,
      ended: false,
      stopped: false,
      dests: new Set(),
      connect(dest) { source.dests.add(dest); },
      disconnect() { source.dests.clear(); },
      onended: null,
      start() {
        source.started = true;
        ctx.sources.push(source);
        // The mic is sharing this context. Safari does not fire onended and does not
        // advance currentTime. The coach has to finish the clip from the wall clock.
      },
      stop() {
        if (source.ended) return;
        source.ended = true;
        source.stopped = true;
        source.onended?.();
      }
    };
    return source;
  }
  createMediaStreamSource() {
    const node = {
      kind: 'source',
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      connect() { node.connected = true; },
      disconnect() { node.connected = false; },
      connected: false
    };
    return node;
  }
  get audioWorklet() {
    const ctx = this;
    return {
      addModule(url) {
        ctx.workletUrl = String(url);
        if (!ctx.workletUrl.includes('drive-capture-worklet.js')) {
          return Promise.reject(new Error(`unexpected worklet ${ctx.workletUrl}`));
        }
        return Promise.resolve();
      }
    };
  }
  createScriptProcessor(bufferSize, inputChannels) {
    this.scriptNodes += 1;
    const ctx = this;
    const node = {
      kind: 'script',
      channelCount: inputChannels,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      inputChannels,
      bufferSize,
      onaudioprocess: null,
      connected: false,
      connect() { node.connected = true; },
      disconnect() { node.connected = false; },
      context: ctx
    };
    this.nodes.push(node);
    return node;
  }
  tick() {
    if (this.state !== 'running') return;
    const script = this.nodes.find(node => node.kind === 'script' && node.connected && !node.disconnected);
    const worklet = this.nodes.find(node => node.kind === 'worklet' && node.connected);
    // Eight blocks per tick is a bit faster than realtime so the turn still closes
    // on sample counts while playback finishes on the wall clock.
    for (let n = 0; n < 8; n++) {
      if (worklet) this.tickWorklet(worklet);
      else if (script) this.tickScript(script);
    }
  }
  capturePulling(node) {
    // Safari stops a ScriptProcessor when the last one-shot buffer ends. A looping
    // source connected to that processor is what keeps the microphone scheduled.
    const clip = this.sources.some(source => source.started && !source.stopped && !source.ended && !source.loop && (source.buffer?.duration || 0) > 0.2);
    if (clip) return true;
    return this.sources.some(source => source.loop && source.started && !source.stopped && !source.ended && source.dests?.has(node));
  }
  inputBlock(node) {
    const silent = new Float32Array(BLOCK);
    if (node.kind === 'script' && !this.capturePulling(node)) {
      return { channels: [silent, new Float32Array(BLOCK)], voice: 0 };
    }
    const voice = this.queue.take(BLOCK);
    if (explicitMono(node)) return { channels: [silent], voice: 0 };
    if (node.channelCount === 1 || node.inputChannels === 1) return { channels: [voice], voice: countVoice(voice) };
    return { channels: [voice, silent.slice(0)], voice: countVoice(voice) };
  }
  tickWorklet(node) {
    const { channels, voice } = this.inputBlock(node);
    node.processor.process([channels], [[new Float32Array(BLOCK)]]);
    node.voiceFromGraph += voice;
  }
  tickScript(node) {
    const { channels } = this.inputBlock(node);
    const read = new Set();
    const buffer = {
      numberOfChannels: channels.length,
      getChannelData(index) {
        read.add(index);
        return channels[index] || new Float32Array(BLOCK);
      }
    };
    const output = new Float32Array(BLOCK);
    node.onaudioprocess?.({
      inputBuffer: buffer,
      outputBuffer: {
        numberOfChannels: 1,
        getChannelData() { return output; }
      }
    });
    // Count the voice on channels the callback actually read. Channel 1 is the
    // silent extra track from WebKit bug 259193, so a mix that includes channel 0
    // counts and a reader that looks only at channel 1 does not.
    if (read.has(0)) this.voiceSamplesPosted += countVoice(channels[0] || new Float32Array(0));
    node.voiceFromGraph += countVoice(channels[0] || new Float32Array(0));
  }
  stop() {
    clearInterval(this.pump);
    for (const node of this.nodes) node.connected = false;
  }
}

function installPage() {
  const elements = new Map();
  const element = () => ({
    hidden: true,
    textContent: '',
    style: {},
    paused: true,
    ended: false,
    defaultMuted: false,
    muted: false,
    playsInline: false,
    loop: false,
    setAttribute() {},
    focus() {},
    play: () => Promise.resolve(),
    pause() { this.paused = true; }
  });
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
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
    json: async () => ({})
  });
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; }
  }
  const said = [];
  globalThis.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  globalThis.window = {
    AudioContext: SafariAudioContext,
    webkitAudioContext: SafariAudioContext,
    addEventListener() {},
    SpeechSynthesisUtterance,
    speechSynthesis: {
      cancel() {},
      speak(utterance) {
        said.push(utterance.text);
        utterance.onend?.();
      }
    }
  };
  const audioSession = { type: 'auto' };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
      audioSession,
      mediaDevices: {
        getUserMedia() { return Promise.resolve(fakeStream()); },
        addEventListener() {}
      },
      wakeLock: {
        request() {
          return Promise.resolve({
            released: false,
            addEventListener() {},
            removeEventListener() {},
            release() { this.released = true; return Promise.resolve(); }
          });
        }
      },
      onLine: true
    }
  });
  return { elements, said, audioSession };
}

function fakeStream() {
  const track = {
    readyState: 'live',
    enabled: true,
    addEventListener() {},
    stop() { track.readyState = 'ended'; }
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

function longClips(audio) {
  return audio.sources.filter(source => source.buffer?.duration > 0.2 && source.started);
}

async function waitFor(check, label, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(label);
}

function AudioWorkletNode(context, name, options = {}) {
  if (name !== 'drive-capture') throw new Error(`unexpected worklet ${name}`);
  context.workletNodes += 1;
  const node = {
    kind: 'worklet',
    channelCount: options.channelCount ?? 2,
    channelCountMode: options.channelCountMode ?? 'explicit',
    channelInterpretation: options.channelInterpretation ?? 'speakers',
    connected: false,
    voiceFromGraph: 0,
    connect() { node.connected = true; },
    disconnect() { node.connected = false; },
    port: {
      onmessage: null,
      postMessage() {}
    }
  };
  const processor = new WorkletProcessor();
  processor.port = {
    postMessage(data) {
      const samples = data?.length ? data : new Float32Array(0);
      context.voiceSamplesPosted += countVoice(samples);
      node.port.onmessage?.({ data: samples });
    }
  };
  node.processor = processor;
  context.nodes.push(node);
  return node;
}

test('iPhone Safari hears a repeated sentence through the mic graph and answers out loud', { timeout: 25000 }, async () => {
  const page = installPage();
  globalThis.AudioWorkletNode = AudioWorkletNode;
  const ui = await import(`../drive-ui.js?iphone-gate=${Math.random()}`);
  ui.mountDriveCoach({
    getPlanned: () => 40,
    getRoutine: () => 'week-1',
    getLines: () => LINES,
    getGoal: () => ({}),
    save() {}
  });
  page.elements.get('startCoach').onclick();
  const audio = SafariAudioContext.latest;
  const coach = globalThis.window.__liltDriveCoach;
  coach.feed = () => {
    throw new Error('feed() bypasses the iPhone microphone. The gate does not accept it.');
  };
  try {
    await waitFor(() => coach.speaking() === false && (audio.workletNodes + audio.scriptNodes) > 0, 'opening finishes while the mic graph is up, with the context clock frozen');
    assert.equal(coach.status().paused, false, 'startup left the coach paused');
    assert.equal(page.audioSession.type, 'play-and-record');
    assert.ok(longClips(audio).length >= 1, 'the opening sentence never started on the audio context');
    const capture = audio.nodes.find(node => node.kind === 'worklet') || audio.nodes.find(node => node.kind === 'script');
    assert.ok(capture, 'no capture node');
    assert.equal(audio.currentTime, 0, 'Safari does not advance currentTime once the mic is live');
    assert.ok(
      audio.sources.some(source => source.loop && source.started && !source.stopped && source.dests.has(capture)),
      'after the prompt ends, nothing keeps the mic processor alive'
    );

    const rounds = 2;
    for (let round = 0; round < rounds; round++) {
      const clipsBefore = longClips(audio).length;
      const postedBefore = audio.voiceSamplesPosted;
      audio.queue.push(phraseAt48k(20 + round * 9));
      await waitFor(() => longClips(audio).length > clipsBefore, replyFailure(audio, page, capture, round), 10000);
      const posted = audio.voiceSamplesPosted - postedBefore;
      assert.ok(posted > 800, replyFailure(audio, page, capture, round));
      assert.ok(longClips(audio).length > clipsBefore, `round ${round + 1}: samples reached the page but no coach clip started. Heard "${page.elements.get('coachHeard').textContent}". Device speech said "${page.said.join(' | ')}". A speechSynthesis timer is not playback.`);
      if (round === 0) {
        await waitFor(() => longClips(audio).some(source => source.started && !source.ended && !source.stopped), 'a reply clip is still playing when the route flickers');
        const live = longClips(audio).find(source => source.started && !source.ended && !source.stopped);
        audio.interruptions = 1;
        audio.setState('interrupted');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(live.stopped, false, 'a flicker during the reply cuts it off');
        assert.equal(coach.status().paused, false, 'a flicker during the reply pauses the coach');
        audio.endInterruption();
      }
      await waitFor(() => coach.speaking() === false, `round ${round + 1}: the coach stayed on "speaking" after the reply, so the next sentence is thrown away`);
      assert.equal(coach.status().paused, false);
    }
    assert.equal(coach.speaking(), false);
    assert.equal(coach.status().stopped, false);
    assert.equal(coach.status().paused, false);
  } finally {
    audio.stop();
  }
});

function replyFailure(audio, page, capture, round) {
  const mode = capture ? `${capture.kind} channelCount=${capture.channelCount} mode=${capture.channelCountMode}` : 'no node';
  return `round ${round + 1}: no spoken reply after she repeated the sentence. ${mode}. Voiced samples posted from the graph: ${audio.voiceSamplesPosted}. Heard "${page.elements.get('coachHeard').textContent}". Clips ${longClips(audio).length}. An explicit-mono capture node is silent on iPhone Safari, and feed() is not allowed to paper over it.`;
}
