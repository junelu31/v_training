import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeWords } from '../drive-dsp.js';
import {
  afterMicRequest,
  bufferPlayed,
  interruptionHeld,
  micFailureCopy,
  mixChannels,
  needsDirectScriptCapture,
  onContextState,
  MIC_SETTLE_MS,
  PLAYBACK_CUT_MS,
  startupCoversInterruption,
  usePlayAndRecord
} from '../drive-mic-start.js';

test('the permission sheet is part of startup, before the microphone track exists', () => {
  const covered = startupCoversInterruption({ awaitingPermission: true, starting: false, micOpenedAt: 0, now: 5000 });
  assert.equal(covered, true);
  assert.equal(onContextState({ state: 'interrupted', covered, hidden: false, stopped: false, userPaused: false, paused: false }), 'resume-only');
  const next = afterMicRequest({ granted: true, openingPlayed: false });
  assert.equal(next.listen, true);
  assert.equal(next.replayOpening, true);
  assert.equal(next.recover, null);
});

test('an already open microphone still replays an opening line the route change cut off', () => {
  assert.equal(startupCoversInterruption({ awaitingPermission: false, starting: true, micOpenedAt: 0, now: 1000 }), true);
  assert.equal(afterMicRequest({ granted: true, openingPlayed: false }).replayOpening, true);
  assert.equal(afterMicRequest({ granted: true, openingPlayed: true }).replayOpening, false);
  assert.equal(afterMicRequest({ granted: true, openingPlayed: true }).listen, true);
});

test('a denied microphone does not listen and says how to continue', () => {
  const next = afterMicRequest({ granted: false, openingPlayed: false });
  assert.equal(next.listen, false);
  assert.equal(next.replayOpening, false);
  assert.equal(next.recover, 'denied');
  const blocked = micFailureCopy({ name: 'NotAllowedError' });
  assert.equal(blocked.line, 'The microphone is blocked.');
  assert.match(blocked.hint, /tap to continue/i);
  assert.match(blocked.say, /Allow the microphone for this site/);
  const missing = micFailureCopy({ name: 'NotFoundError' });
  assert.match(missing.line, /No microphone is available/);
  assert.match(micFailureCopy({ name: 'AbortError' }).say, /did not start/);
});

test('after startup a real interruption pauses, and running audio resumes it', () => {
  const during = startupCoversInterruption({ awaitingPermission: false, starting: false, micOpenedAt: 1000, now: 2499 });
  const after = startupCoversInterruption({ awaitingPermission: false, starting: false, micOpenedAt: 1000, now: 2500 });
  assert.equal(during, true);
  assert.equal(after, false);
  assert.equal(onContextState({ state: 'interrupted', covered: false, hidden: false, stopped: false, userPaused: false, paused: false }), 'pause');
  assert.equal(onContextState({ state: 'running', covered: false, hidden: false, stopped: false, userPaused: false, paused: true }), 'resume-session');
  assert.equal(onContextState({ state: 'interrupted', covered: false, hidden: true, stopped: false, userPaused: false, paused: false }), 'ignore');
  assert.equal(onContextState({ state: 'interrupted', covered: false, hidden: false, stopped: false, userPaused: true, paused: false }), 'ignore');
});

test('a short flicker is not a finished clip and not a dropped route', () => {
  assert.equal(interruptionHeld(30), false);
  assert.equal(interruptionHeld(PLAYBACK_CUT_MS - 1), false);
  assert.equal(interruptionHeld(PLAYBACK_CUT_MS), true);
  assert.equal(bufferPlayed({ state: 'running', elapsedSec: 0.35, durationSec: 0.35 }), true);
  assert.equal(bufferPlayed({ cut: true, state: 'running', elapsedSec: 0.35, durationSec: 0.35 }), false);
  assert.equal(bufferPlayed({ state: 'interrupted', elapsedSec: 0.35, durationSec: 0.35 }), false);
  assert.equal(bufferPlayed({ state: 'suspended', elapsedSec: 0, durationSec: 0.35, nowMs: 500, startedMs: 0 }), false);
  assert.equal(bufferPlayed({ state: 'running', elapsedSec: 0.1, durationSec: 0.35, nowMs: 200, startedMs: 0 }), false);
  assert.equal(bufferPlayed({ state: 'running', elapsedSec: 0, durationSec: 0.35, nowMs: 500, startedMs: 0 }), true);
  assert.equal(bufferPlayed({ state: 'running', elapsedSec: 0, durationSec: 0.35, nowMs: 500, startedMs: 0, suspendedMs: 400 }), false);
});

test('an iPhone mic is not forced to explicit mono, and a downmix keeps the voice on channel 0', () => {
  assert.equal(needsDirectScriptCapture('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)'), true);
  assert.equal(needsDirectScriptCapture('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 0), false);
  assert.equal(needsDirectScriptCapture('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 2), true);
  const voice = new Float32Array([0.2, -0.4, 0.6]);
  const silent = new Float32Array(3);
  // WebKit 259193: voice on channel 0, silence on channel 1. Averaging keeps the voice.
  const phone = mixChannels([voice, silent]);
  assert.ok(Math.abs(phone[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(phone[1] + 0.2) < 1e-6);
  const mixed = mixChannels([silent, voice]);
  assert.ok(Math.abs(mixed[1] + 0.2) < 1e-6);
  assert.equal(mixChannels([voice])[0], voice[0]);
  assert.equal(mixChannels([]).length, 0);
});

test('play-and-record is chosen once, before capture starts', () => {
  const session = { type: 'auto' };
  assert.equal(usePlayAndRecord(session), true);
  assert.equal(session.type, 'play-and-record');
  assert.equal(usePlayAndRecord(session), false);
  assert.equal(usePlayAndRecord(null), false);
});

const PHRASE = 'Who is arriving? We are ready whenever you are.';

function element() {
  return {
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
  };
}

class FakeAudioContext {
  static latest = null;
  static holdEnded = false;
  static iosMic = false;
  constructor(options = {}) {
    this.holdEnded = FakeAudioContext.holdEnded;
    this.iosMic = FakeAudioContext.iosMic;
    // iPhone hardware rate. A 16 kHz context hides the resampling the phone actually does.
    this.sampleRate = options.sampleRate || (this.iosMic ? 48000 : 16000);
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
    this.onstatechange = null;
    this.events = new Map();
    this.sources = [];
    this.processors = 0;
    this.interruptions = 0;
    this.waiters = [];
    this.nodes = [];
    this.gain = null;
    this.mediaSource = null;
    this.workletNodes = 0;
    this.micQueue = new Float32Array(0);
    this.micPos = 0;
    this.voiceSamplesPosted = 0;
    this.scriptInputs = 1;
    if (this.iosMic) this.audioWorklet = { async addModule() {} };
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
    return Promise.resolve();
  }
  link(from, dest) {
    if (from.output && from.output.inputs) {
      const index = from.output.inputs.indexOf(from);
      if (index >= 0) from.output.inputs.splice(index, 1);
    }
    from.output = dest || null;
    if (!dest) return;
    if (!dest.inputs) dest.inputs = [];
    if (!dest.inputs.includes(from)) dest.inputs.push(from);
  }
  chainHas(node, pred) {
    const seen = new Set();
    const walk = current => {
      if (!current || seen.has(current)) return false;
      seen.add(current);
      if (pred(current)) return true;
      const inputs = current.inputs || [];
      if (current.kind === 'script') return walk(inputs[inputs.length - 1]);
      return inputs.some(input => walk(input));
    };
    return walk(node);
  }
  createGain() {
    const ctx = this;
    const node = {
      kind: 'gain',
      context: this,
      gain: { value: 0 },
      inputs: [],
      connect(dest) { ctx.link(node, dest); },
      disconnect() { ctx.link(node, null); }
    };
    this.gain = node;
    return node;
  }
  createBuffer(_channels, length, rate) {
    return { duration: length / rate, length };
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
      connect(dest) { ctx.link(source, dest); source.dests.add(dest); },
      disconnect() { ctx.link(source, null); source.dests.clear(); },
      onended: null,
      start() {
        source.started = true;
        ctx.sources.push(source);
        // Once the mic is live, Safari does not fire onended and does not move
        // currentTime. The coach has to finish the clip from the wall clock.
        if (ctx.iosMic || ctx.holdEnded) return;
        source.timer = setTimeout(() => {
          if (source.ended) return;
          source.ended = true;
          source.onended?.();
        }, 150);
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
    const ctx = this;
    const node = {
      kind: 'source',
      liveMic: true,
      inputs: [],
      channelCount: 2,
      channelCountMode: 'max',
      connect(dest) { ctx.link(node, dest); },
      disconnect() { ctx.link(node, null); }
    };
    this.mediaSource = node;
    return node;
  }
  createScriptProcessor(_size, inputChannels = 1) {
    this.processors += 1;
    this.scriptInputs = inputChannels;
    const ctx = this;
    const node = {
      kind: 'script',
      inputs: [],
      disconnected: false,
      inputChannels,
      channelCount: inputChannels,
      channelCountMode: 'max',
      onaudioprocess: null,
      connect(dest) {
        // iPhone Safari does not run the callback unless the output is the destination.
        // Explicit mono is one silent channel. Stereo keeps the voice on channel 0
        // and silence on channel 1 (WebKit 259193). A one-channel processor that was
        // not forced mono gets the voice on that channel.
        const explicitMono = node.channelCountMode === 'explicit' && node.channelCount === 1
          || ctx.mediaSource?.channelCountMode === 'explicit' && ctx.mediaSource?.channelCount === 1;
        if (ctx.iosMic && dest !== ctx.destination) return;
        const tick = () => {
          if (node.disconnected) return;
          if (ctx.iosMic && ctx.state !== 'running') {
            node.timer = setTimeout(tick, 10);
            node.timer.unref?.();
            return;
          }
          const blocks = ctx.iosMic ? 8 : 1;
          const size = 128;
          const monoVoice = !explicitMono && (node.channelCount === 1 || node.inputChannels === 1);
          const stereo = ctx.iosMic && !explicitMono && !monoVoice;
          const clipPlaying = ctx.sources.some(source => source.started && !source.stopped && !source.ended && !source.loop && (source.buffer?.duration || 0) > 0.2);
          const micLive = ctx.chainHas(node, item => item.liveMic);
          const clocked = ctx.chainHas(node, item => item.loop && item.started && !item.stopped && !item.ended);
          const pulling = !ctx.iosMic || (micLive && (clipPlaying || clocked));
          for (let n = 0; n < blocks; n++) {
            const read = new Set();
            let channel0 = null;
            const pull = channel => {
              read.add(channel);
              if (!pulling || !ctx.iosMic || explicitMono) return new Float32Array(size);
              if (stereo && channel !== 0) return new Float32Array(size);
              if (!channel0) {
                channel0 = new Float32Array(size);
                const start = ctx.micPos;
                const end = Math.min(ctx.micQueue.length, start + size);
                if (end > start) channel0.set(ctx.micQueue.subarray(start, end));
                ctx.micPos = end;
              }
              return channel0;
            };
            node.onaudioprocess?.({
              inputBuffer: {
                numberOfChannels: stereo ? 2 : 1,
                getChannelData: pull
              },
              outputBuffer: {
                numberOfChannels: 1,
                getChannelData: () => new Float32Array(size)
              }
            });
            if (ctx.iosMic && read.has(0) && channel0) ctx.voiceSamplesPosted += countVoice(channel0);
          }
          node.timer = setTimeout(tick, ctx.iosMic ? 10 : 30);
          node.timer.unref?.();
        };
        tick();
      },
      disconnect() {
        node.disconnected = true;
        clearTimeout(node.timer);
      }
    };
    this.nodes.push(node);
    return node;
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 0.35, length: 5600 });
  }
  stopNodes() {
    for (const node of this.nodes) node.disconnect();
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
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
    json: async () => ({})
  });
  const audioSession = { type: 'auto' };
  const said = [];
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; }
  }
  globalThis.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  globalThis.window = {
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
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
  const media = {
    calls: 0,
    typeAtCall: [],
    grant: null,
    devices: {
      getUserMedia() { throw new Error('install getUserMedia'); },
      addEventListener() {}
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      audioSession,
      mediaDevices: media.devices,
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
  return { elements, audioSession, said, media };
}

function countVoice(samples) {
  let n = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 0.02) n += 1;
  return n;
}

function phraseAt48k(seed) {
  const speech = synthesizeWords([
    { text: 'hi', ms: 700, f0: 210, f1: 380, f2: 2200, seed, gapMs: 30, gain: 0.6 },
    { text: 'there', ms: 520, f0: 195, f1: 440, f2: 1850, seed: seed + 4, gapMs: 0, gain: 0.6 }
  ]).samples;
  const rate = 48000;
  const lead = Math.floor(rate * 0.5);
  const tail = Math.floor(rate * 1.7);
  const out = new Float32Array(lead + speech.length * 3 + tail);
  for (let i = 0; i < speech.length; i++) {
    const sample = speech[i];
    out[lead + i * 3] = sample;
    out[lead + i * 3 + 1] = sample;
    out[lead + i * 3 + 2] = sample;
  }
  return out;
}

function longClips(audio) {
  return audio.sources.filter(source => source.buffer?.duration > 0.2 && source.started);
}

async function waitFor(check, label, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(label);
}

async function freshCoach() {
  return import(`../drive-ui.js?mic=${Math.random()}`);
}

test('Drive coach survives the mic sheet, an already granted mic, and a denial', async () => {
  const page = installPage();
  const phrase = PHRASE;

  // First run: the sheet interrupts the context, and nothing may pause the coach or start a second prompt.
  {
    const ui = await freshCoach();
    page.media.calls = 0;
    page.media.devices.getUserMedia = () => {
      page.media.calls += 1;
      page.media.typeAtCall.push(page.audioSession.type);
      const audio = FakeAudioContext.latest;
      audio.interruptions = 1;
      audio.setState('interrupted');
      return new Promise(resolve => {
        page.media.grant = () => {
          audio.endInterruption();
          resolve(fakeStream());
        };
      });
    };
    ui.mountDriveCoach(deps(phrase));
    page.elements.get('startCoach').onclick();
    await new Promise(resolve => setTimeout(resolve, 30));
    const audio = FakeAudioContext.latest;
    assert.equal(audio.state, 'interrupted');
    assert.equal(page.media.typeAtCall[0], 'play-and-record');
    assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
    assert.equal(longClips(audio).length, 0, 'the opening line waits out the sheet instead of being counted as finished');
    page.media.grant();
    await waitFor(() => longClips(audio).some(source => source.started) && audio.processors > 0, 'opening clip and microphone after Allow');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(page.media.calls, 1, 'Allow must not open a second permission prompt');
    assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
    assert.equal(page.elements.get('coachResume').hidden, true);
    audio.stopNodes();
  }

  // Already granted: a brief route flicker must not cut the opening off or pause the coach.
  {
    const ui = await freshCoach();
    page.media.calls = 0;
    page.media.typeAtCall = [];
    let blip = null;
    page.media.devices.getUserMedia = () => {
      page.media.calls += 1;
      page.media.typeAtCall.push(page.audioSession.type);
      const audio = FakeAudioContext.latest;
      const watch = setInterval(() => {
        const live = longClips(audio).find(source => source.started && !source.ended);
        if (!live) return;
        clearInterval(watch);
        audio.interruptions = 1;
        audio.setState('interrupted');
        blip = Date.now();
        setTimeout(() => audio.endInterruption(), 30);
      }, 5);
      watch.unref?.();
      return Promise.resolve(fakeStream());
    };
    ui.mountDriveCoach(deps(phrase));
    page.elements.get('startCoach').onclick();
    const audio = FakeAudioContext.latest;
    await waitFor(() => blip && longClips(audio).some(source => source.started), 'opening during the route flicker');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(blip, 'the route change ran during the opening line');
    assert.equal(page.media.calls, 1);
    assert.equal(page.media.typeAtCall[0], 'play-and-record');
    assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
    assert.equal(page.elements.get('coachResume').hidden, true);
    assert.equal(longClips(audio).filter(source => source.stopped).length, 0, 'a short flicker leaves the opening playing');
    audio.stopNodes();
  }

  // A route change that outlasts the clip still replays the opening, and does not pause during startup.
  {
    const ui = await freshCoach();
    page.media.calls = 0;
    let held = null;
    page.media.devices.getUserMedia = () => {
      page.media.calls += 1;
      const audio = FakeAudioContext.latest;
      const watch = setInterval(() => {
        const live = longClips(audio).find(source => source.started && !source.ended);
        if (!live) return;
        clearInterval(watch);
        audio.interruptions = 1;
        audio.setState('interrupted');
        held = Date.now();
        setTimeout(() => audio.endInterruption(), PLAYBACK_CUT_MS + 120);
      }, 5);
      watch.unref?.();
      return Promise.resolve(fakeStream());
    };
    ui.mountDriveCoach(deps(phrase));
    page.elements.get('startCoach').onclick();
    const audio = FakeAudioContext.latest;
    await waitFor(() => held && longClips(audio).length >= 2, 'opening plays again after a held interruption');
    assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
    assert.equal(page.elements.get('coachResume').hidden, true);
    audio.stopNodes();
  }

  // Denied: the coach stops and says what to do, instead of looking like it is listening.
  {
    const ui = await freshCoach();
    page.media.calls = 0;
    page.said.length = 0;
    page.media.devices.getUserMedia = () => {
      page.media.calls += 1;
      page.media.typeAtCall.push(page.audioSession.type);
      const audio = FakeAudioContext.latest;
      audio.interruptions = 1;
      audio.setState('interrupted');
      audio.endInterruption();
      const error = new Error('denied');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    };
    ui.mountDriveCoach(deps(phrase));
    page.elements.get('startCoach').onclick();
    await waitFor(() => page.elements.get('coachLine').textContent === 'The microphone is blocked.', 'denial copy');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(page.elements.get('coachSub').textContent, 'Allow the microphone for this site, then tap to continue.');
    assert.equal(page.elements.get('coachResume').hidden, false);
    assert.equal(globalThis.window.__liltDriveCoach.status().paused, true);
    assert.equal(FakeAudioContext.latest.processors, 0);
    assert.equal(page.media.calls, 1);
    assert.ok(page.said.some(line => /microphone is blocked/i.test(line)), page.said.join(' | '));
    FakeAudioContext.latest.stopNodes();
  }
});

test('iPhone Safari hears two sentences through the mic graph and answers out loud', { timeout: 25000 }, async () => {
  FakeAudioContext.iosMic = true;
  const page = installPage();
  globalThis.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
  globalThis.navigator.platform = 'iPhone';
  globalThis.navigator.maxTouchPoints = 5;
  try {
    const ui = await freshCoach();
    page.media.devices.getUserMedia = () => Promise.resolve(fakeStream());
    ui.mountDriveCoach({
      ...deps('Hi there.'),
      getLines: () => ['Hi there.', 'We are ready.']
    });
    page.elements.get('startCoach').onclick();
    const audio = FakeAudioContext.latest;
    const coach = globalThis.window.__liltDriveCoach;
    coach.feed = () => {
      throw new Error('feed() bypasses the iPhone microphone. The gate does not accept it.');
    };
    assert.throws(() => coach.feed(new Float32Array(8)), /bypasses the iPhone microphone/);
    await waitFor(() => coach.speaking() === false && audio.processors > 0, 'opening finishes with the context clock frozen');
    assert.equal(audio.sampleRate, 48000);
    assert.equal(audio.currentTime, 0, 'Safari does not advance currentTime once the mic is live');
    assert.equal(audio.sources.every(source => !source.timer), true, 'onended never fires from the context clock');
    assert.equal(coach.status().paused, false);
    assert.equal(page.audioSession.type, 'play-and-record');
    assert.ok(longClips(audio).length >= 1, 'the opening line played from the audio context');
    assert.notEqual(audio.mediaSource?.channelCountMode, 'explicit');
    const script = audio.nodes.find(node => node.onaudioprocess);
    assert.ok(audio.chainHas(script, item => item.liveMic), 'the silent keep-alive replaced the microphone');
    assert.ok(audio.chainHas(script, item => item.loop && item.started && !item.stopped), 'after the prompt, only a summed looping source keeps the mic processor alive');
    for (let round = 0; round < 2; round++) {
      const before = longClips(audio).length;
      const postedBefore = audio.voiceSamplesPosted;
      audio.micQueue = phraseAt48k(20 + round * 9);
      audio.micPos = 0;
      await waitFor(
        () => longClips(audio).length > before,
        `round ${round + 1}: no spoken reply (clips ${longClips(audio).length}, heard "${page.elements.get('coachHeard').textContent}", voiced ${audio.voiceSamplesPosted})`,
        10000
      );
      assert.ok(audio.voiceSamplesPosted - postedBefore > 800, `round ${round + 1} posted ${audio.voiceSamplesPosted - postedBefore} voiced samples from channel 0`);
      assert.equal(audio.currentTime, 0);
      if (round === 0) {
        await waitFor(() => longClips(audio).some(source => source.started && !source.ended && !source.stopped), 'a reply clip is still playing when the route flickers');
        const live = longClips(audio).find(source => source.started && !source.ended && !source.stopped);
        audio.interruptions = 1;
        audio.setState('interrupted');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(live.stopped, false, 'a flicker during the reply leaves it playing');
        assert.equal(coach.status().paused, false, 'a flicker during the reply pauses the coach');
        audio.endInterruption();
      }
      await waitFor(() => coach.speaking() === false, `round ${round + 1}: the coach stayed speaking after the reply`);
      assert.equal(coach.status().paused, false);
    }
    await new Promise(resolve => setTimeout(resolve, MIC_SETTLE_MS));
    audio.interruptions = 1;
    audio.setState('interrupted');
    await new Promise(resolve => setTimeout(resolve, PLAYBACK_CUT_MS + 80));
    assert.equal(coach.status().paused, true, 'a held interruption after startup still pauses the coach');
    audio.endInterruption();
    await waitFor(() => coach.status().paused === false, 'audio coming back resumes the coach');
    audio.stopNodes();
  } finally {
    FakeAudioContext.iosMic = false;
    FakeAudioContext.latest?.stopNodes();
  }
});

function fakeStream() {
  const track = {
    readyState: 'live',
    enabled: true,
    addEventListener() {},
    stop() { track.readyState = 'ended'; }
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

function deps(phrase) {
  return {
    getPlanned: () => 30,
    getRoutine: () => 'week-1',
    getLines: () => [phrase],
    getGoal: () => ({}),
    save() {}
  };
}
