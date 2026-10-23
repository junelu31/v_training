// iPhone Safari Drive endurance. June's phone is not here. This harness is the
// failure that already reached her: the opening line can play, she repeats it,
// and the coach stays silent because the take never arrives.
//
// Do not "fix" a red run by pushing samples through __liltDriveCoach.feed().
// That skips the mic graph and is how PR #8 stayed green. Her voice is stereo,
// channel 0 is empty, the AudioWorklet is handed that empty channel, explicit
// mono is silence, and a ScriptProcessor does not run unless its output is the
// context destination. onended does not fire, and currentTime does not move.
//
// A full week-1 drive is 53 lines, which is the ~40 minute list. The wall clock
// is compressed. What is still phone-only is written in qa/iphone-safari-drive.md.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { synthesizeWords } from '../drive-dsp.js';
import { MIC_SETTLE_MS, PLAYBACK_CUT_MS } from '../drive-mic-start.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';
const CLIP_SEC = 0.28;

const host = {};
globalThis.window = host;
await import('../course.js');
const content = host.COURSE_CONTENT;
const week = content.drives.find(drive => drive.id === 'week-1');
const DRIVE_LINES = week.lines.map(id => content.drills.find(drill => drill.id === id)?.phrase).filter(Boolean);

const TAKE = (() => {
  const speech = synthesizeWords([{ text: 'hi', ms: 800, f0: 210, f1: 380, f2: 2200, seed: 21, gapMs: 0 }]).samples;
  for (let i = 0; i < speech.length; i++) speech[i] *= 2;
  const lead = new Float32Array(Math.floor(16000 * 0.7));
  const tail = new Float32Array(Math.floor(16000 * 1.6));
  const queued = new Float32Array(lead.length + speech.length + tail.length);
  queued.set(speech, lead.length);
  return queued;
})();

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
  constructor() {
    this.sampleRate = 16000;
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = { name: 'destination' };
    this.onstatechange = null;
    this.events = new Map();
    this.sources = [];
    this.nodes = [];
    this.processors = 0;
    this.workletNodes = 0;
    this.interruptions = 0;
    this.waiters = [];
    this.gain = null;
    this.mediaSource = null;
    this.scriptInputs = 0;
    this.micQueue = new Float32Array(0);
    this.micPos = 0;
    this.deliverMic = false;
    this.outputPeak = null;
    this.captureStarted = 0;
    this.audioWorklet = { async addModule() {} };
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
  createGain() {
    const node = { context: this, gain: { value: 1 }, connect() {}, disconnect() {} };
    this.gain = node;
    return node;
  }
  createBuffer(_channels, length, rate) {
    return { duration: length / rate, length, numberOfChannels: 1, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const ctx = this;
    const source = {
      buffer: null,
      started: false,
      ended: false,
      stopped: false,
      startedAt: 0,
      stoppedAt: 0,
      dest: null,
      connect(dest) { source.dest = dest; },
      onended: null,
      start() {
        source.started = true;
        source.startedAt = Date.now();
        ctx.sources.push(source);
        // iPhone Safari does not fire onended while the mic graph is hot,
        // and currentTime stays put. The coach has to notice the clip itself.
      },
      stop() {
        if (source.ended) return;
        source.ended = true;
        source.stopped = true;
        source.stoppedAt = Date.now();
        source.onended?.();
      }
    };
    return source;
  }
  createMediaStreamSource() {
    const node = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      connect() {},
      disconnect() {}
    };
    this.mediaSource = node;
    return node;
  }
  createScriptProcessor(_size, inputChannels = 1) {
    this.processors += 1;
    this.scriptInputs = inputChannels;
    const ctx = this;
    const node = {
      disconnected: false,
      inputChannels,
      output: new Float32Array(2048),
      onaudioprocess: null,
      connect(dest) {
        node.dest = dest;
        // Callbacks run only into the destination, and explicit mono is silence.
        if (dest !== ctx.destination || ctx.mediaSource?.channelCountMode === 'explicit') return;
        const tick = () => {
          if (node.disconnected) return;
          node.timer = setTimeout(tick, 5);
          node.timer.unref?.();
          if (ctx.state !== 'running') return;
          node.output.fill(0.8);
          const size = 2048;
          node.onaudioprocess?.({
            inputBuffer: {
              numberOfChannels: node.inputChannels,
              getChannelData(channel) {
                const out = new Float32Array(size);
                if (channel === 0 || node.inputChannels < 2 || !ctx.deliverMic) return out;
                const start = ctx.micPos;
                const end = Math.min(ctx.micQueue.length, start + size);
                if (end > start) out.set(ctx.micQueue.subarray(start, end));
                ctx.micPos = end;
                return out;
              }
            },
            outputBuffer: {
              numberOfChannels: 1,
              getChannelData: () => node.output
            }
          });
          let peak = 0;
          for (let i = 0; i < node.output.length; i++) peak = Math.max(peak, Math.abs(node.output[i]));
          ctx.outputPeak = ctx.outputPeak == null ? peak : Math.max(ctx.outputPeak, peak);
          if (!ctx.captureStarted) ctx.captureStarted = Date.now();
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
    const length = Math.round(this.sampleRate * CLIP_SEC);
    return Promise.resolve({
      duration: CLIP_SEC,
      length,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(length)
    });
  }
  liveProcessors() {
    return this.nodes.filter(node => !node.disconnected).length;
  }
  stopNodes() {
    for (const node of this.nodes) node.disconnect();
  }
}

function installWorklet() {
  class SilentChannelWorklet {
    constructor() {
      this.port = { onmessage: null };
      this.disconnected = false;
      FakeAudioContext.latest.workletNodes += 1;
    }
    connect() {
      const tick = () => {
        if (this.disconnected) return;
        // Safari's worklet input on this path is channel 0, which is empty.
        this.port.onmessage?.({ data: new Float32Array(128) });
        this.timer = setTimeout(tick, 20);
        this.timer.unref?.();
      };
      tick();
    }
    disconnect() {
      this.disconnected = true;
      clearTimeout(this.timer);
    }
  }
  globalThis.AudioWorkletNode = SilentChannelWorklet;
}

function installPage() {
  const elements = new Map();
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    createElement() { return element(); },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn();
    }
  };
  globalThis.document = document;
  globalThis.location = { search: '' };
  const said = [];
  const page = {
    elements,
    document,
    said,
    mode: 'live',
    grant: null,
    nextTranscript: '',
    urls: [],
    audioSession: { type: 'auto' },
    media: { calls: 0, typeAtCall: [] }
  };
  globalThis.fetch = async (url, options = {}) => {
    page.urls.push(String(url));
    let body = {};
    try { body = options.body ? JSON.parse(options.body) : {}; } catch { body = {}; }
    const transcript = body.audioBase64 ? page.nextTranscript : '';
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16),
      json: async () => ({ transcript })
    };
  };
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.volume = 1; }
  }
  globalThis.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  globalThis.window = {
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    SpeechSynthesisUtterance,
    addEventListener() {},
    speechSynthesis: {
      cancel() {},
      speak(utterance) {
        said.push(utterance.text);
        utterance.onend?.();
      }
    }
  };
  page.media.devices = {
    addEventListener() {},
    getUserMedia() {
      page.media.calls += 1;
      page.media.typeAtCall.push(page.audioSession.type);
      const audio = FakeAudioContext.latest;
      if (page.mode === 'deny') {
        audio.interruptions = 1;
        audio.setState('interrupted');
        audio.endInterruption();
        const error = new Error('denied');
        error.name = 'NotAllowedError';
        return Promise.reject(error);
      }
      if (page.mode === 'sheet') {
        audio.interruptions = 1;
        audio.setState('interrupted');
        return new Promise(resolve => {
          page.grant = () => {
            page.mode = 'live';
            const stream = fakeStream();
            page.stream = stream;
            audio.endInterruption();
            resolve(stream);
          };
        });
      }
      const stream = fakeStream();
      page.stream = stream;
      return Promise.resolve(stream);
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: IPHONE_UA,
      platform: 'iPhone',
      maxTouchPoints: 5,
      audioSession: page.audioSession,
      mediaDevices: page.media.devices,
      onLine: true,
      wakeLock: {
        request() {
          return Promise.resolve({
            released: false,
            addEventListener() {},
            removeEventListener() {},
            release() { this.released = true; return Promise.resolve(); }
          });
        }
      }
    }
  });
  installWorklet();
  return page;
}

function fakeStream() {
  const listeners = {};
  const track = {
    readyState: 'live',
    enabled: true,
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    stop() { track.readyState = 'ended'; },
    end() {
      track.readyState = 'ended';
      for (const fn of listeners.ended || []) fn();
    }
  };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
}

function longClips(audio) {
  return audio.sources.filter(source => source.buffer?.duration > 0.2);
}

function uiText(page, id) {
  return page.elements.get(id)?.textContent || '';
}

function picture(page, audio, coach) {
  const status = coach?.status?.() || {};
  return `clips ${longClips(audio).length}, speaking ${coach?.speaking?.()}, paused ${status.paused}, line ${status.lineIndex}, ` +
    `mic ${audio.micPos}/${audio.micQueue?.length || 0}, processors ${audio.liveProcessors()} (created ${audio.processors}), ` +
    `worklet ${audio.workletNodes}, inputs ${audio.scriptInputs}, mono ${audio.mediaSource?.channelCountMode}, ` +
    `screen "${uiText(page, 'coachLine')}", heard "${uiText(page, 'coachHeard')}"`;
}

async function waitFor(check, label, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(typeof label === 'function' ? label() : label);
}

let nonce = 0;
function freshCoach() {
  return import(`../drive-ui.js?ios-drive=${nonce += 1}`);
}

function deps(lines) {
  return {
    getPlanned: () => 40,
    getRoutine: () => 'week-1',
    getLines: () => lines,
    getGoal: () => ({}),
    save() {}
  };
}

function assertAudible(sources, audio) {
  assert.ok(sources.length >= 1, 'spoken feedback never started a clip');
  for (const source of sources) {
    assert.equal(source.dest, audio.destination, 'the reply was not connected to the speaker');
    assert.ok(source.started, 'the reply never started');
    assert.ok(source.stopped || source.ended, 'speaking ended while the reply was still marked running');
    const life = source.stoppedAt - source.startedAt;
    const need = source.buffer.duration * 1000 * 0.65;
    assert.ok(life >= need, `silent-after-speak: clip lived ${life}ms, the buffer is ${source.buffer.duration}s`);
  }
}

async function captureReady(page, audio, coach) {
  await waitFor(() => {
    const line = uiText(page, 'coachLine');
    if (/did not start|not sending sound/i.test(line)) return true;
    const openingDone = coach.speaking() === false && longClips(audio).length > 0;
    // The opening can finish while the worklet graph is still silent. Do not sit there.
    if (openingDone && audio.processors < 1) return true;
    return openingDone && audio.processors > 0;
  }, () => `opening never finished on iPhone. ${picture(page, audio, coach)}`, 9000);
  if (audio.processors < 1 || audio.workletNodes > 0 || audio.scriptInputs < 2 || audio.mediaSource?.channelCountMode === 'explicit') {
    assert.fail(
      `silent after she speaks: the iPhone mic graph did not deliver her take, so feedback cannot play. ${picture(page, audio, coach)}`
    );
  }
}

async function mountAndStart(page, lines) {
  const ui = await freshCoach();
  ui.mountDriveCoach(deps(lines));
  page.elements.get('startCoach').onclick();
  const audio = FakeAudioContext.latest;
  const coach = globalThis.window.__liltDriveCoach;
  coach.feed = () => {
    throw new Error('iPhone Safari audio has to arrive through the mic graph, not feed()');
  };
  if (page.mode === 'sheet') {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(audio.state, 'interrupted', 'the permission sheet interrupts the audio context');
    assert.equal(coach.status().paused, false, 'the permission sheet must not pause the coach');
    assert.equal(page.elements.get('coachResume').hidden, true);
    assert.equal(longClips(audio).length, 0, 'the opening line has to wait out the sheet');
    assert.equal(page.media.typeAtCall[0], 'play-and-record');
    page.grant();
  }
  await captureReady(page, audio, coach);
  assert.equal(coach.status().paused, false);
  assert.equal(coach.speaking(), false);
  assert.equal(page.elements.get('coachAwake').textContent, 'Screen stays on.');
  assertAudible(longClips(audio), audio);
  return { audio, coach };
}

async function expectReply(page, audio, coach, { during } = {}) {
  const before = longClips(audio).length;
  const mark = Date.now();
  audio.micPos = 0;
  audio.micQueue = TAKE;
  audio.deliverMic = true;
  await waitFor(
    () => longClips(audio).some(source => source.started && source.startedAt >= mark && !source.stopped && !source.ended),
    () => `spoken feedback did not play after her take. ${picture(page, audio, coach)}`,
    10000
  );
  if (during) await during(audio, coach);
  await waitFor(
    () => coach.speaking() === false && longClips(audio).filter(source => source.startedAt >= mark).every(source => source.stopped || source.ended),
    () => `the reply never finished, so the next phrase would be thrown away. ${picture(page, audio, coach)}`,
    15000
  );
  audio.deliverMic = false;
  const fresh = longClips(audio).filter(source => source.startedAt >= mark);
  assertAudible(fresh, audio);
  assert.equal(coach.status().paused, false, 'the coach paused itself after a take');
  assert.equal(coach.speaking(), false, 'speaking stayed true after the reply');
  assert.equal(audio.liveProcessors(), 1, 'the mic graph leaked or dropped');
  assert.equal(page.elements.get('coachResume').hidden, true);
  assert.match(page.elements.get('coachHeard').textContent, /Heard you/);
  return fresh;
}

async function settle(audio) {
  const remain = audio.captureStarted + MIC_SETTLE_MS + 80 - Date.now();
  if (remain > 0) await new Promise(resolve => setTimeout(resolve, remain));
}

describe('iPhone Safari Drive', { concurrency: false }, () => {

test('iPhone Safari: the mic sheet, then her repeat, then spoken feedback', async () => {
  const page = installPage();
  page.mode = 'sheet';
  try {
    const lines = DRIVE_LINES.slice(0, 2);
    const { audio, coach } = await mountAndStart(page, lines);
    assert.equal(page.media.calls, 1, 'Allow must not open a second permission sheet');
    await expectReply(page, audio, coach);
    assert.equal(typeof audio.outputPeak, 'number');
    assert.ok(audio.outputPeak < 0.01, `the microphone was played back at ${audio.outputPeak}`);
    audio.stopNodes();
  } finally {
    FakeAudioContext.latest?.stopNodes();
  }
});

test('a 53-line drive keeps speaking and does not leak paused or capture state', { timeout: 180000 }, async () => {
  assert.ok(DRIVE_LINES.length >= 53, `week-1 drive has ${DRIVE_LINES.length} lines, expected at least 53`);
  const page = installPage();
  try {
    const { audio, coach } = await mountAndStart(page, DRIVE_LINES);
    await settle(audio);
    const seen = new Set();
    let replies = 0;
    let guard = 0;
    while (seen.size < DRIVE_LINES.length) {
      guard += 1;
      assert.ok(guard <= DRIVE_LINES.length + 6, `the drive stalled at ${seen.size} of ${DRIVE_LINES.length} lines`);
      const index = coach.status().lineIndex;
      const prompt = DRIVE_LINES[index % DRIVE_LINES.length];
      seen.add(prompt);
      const during = seen.size === 20
        ? async () => {
          audio.interruptions = 1;
          audio.setState('interrupted');
          await new Promise(resolve => setTimeout(resolve, 40));
          assert.equal(coach.status().paused, false, 'a route flicker mid-reply paused the drive');
          const live = longClips(audio).filter(source => source.started && !source.stopped && !source.ended);
          assert.ok(live.length >= 1 && live.every(source => !source.stopped), 'a route flicker cut the reply off');
          audio.endInterruption();
        }
        : null;
      await expectReply(page, audio, coach, { during });
      replies += 1;
      if (coach.status().lineIndex === index) {
        page.nextTranscript = 'next phrase';
        await expectReply(page, audio, coach);
        page.nextTranscript = '';
        replies += 1;
        assert.notEqual(coach.status().lineIndex, index, `next phrase did not move off: ${prompt}`);
      }
      if (seen.size === 10) {
        audio.interruptions = 1;
        audio.setState('interrupted');
        await waitFor(
          () => coach.status().paused === true,
          () => `a held route drop should pause after startup. ${picture(page, audio, coach)}`,
          PLAYBACK_CUT_MS + 1500
        );
        audio.endInterruption();
        await waitFor(() => coach.status().paused === false, () => `the coach stayed paused after audio returned. ${picture(page, audio, coach)}`);
        assert.equal(coach.speaking(), false);
        assert.equal(audio.liveProcessors(), 1);
      }
      if (seen.size % 10 === 0) console.log(`iPhone drive ${seen.size}/${DRIVE_LINES.length}`);
    }
    assert.equal(seen.size, DRIVE_LINES.length);
    assert.equal(coach.status().lineIndex, DRIVE_LINES.length);
    assert.equal(coach.status().phraseCount, DRIVE_LINES.length);
    assert.equal(coach.status().paused, false);
    assert.equal(coach.status().stopped, false);
    assert.equal(coach.speaking(), false);
    assert.equal(audio.liveProcessors(), 1);
    assert.equal(audio.workletNodes, 0);
    assert.ok(replies >= DRIVE_LINES.length);
    assert.ok(audio.outputPeak < 0.01, `the microphone was played back at ${audio.outputPeak}`);
    assert.equal(page.media.calls, 1, 'the drive re-prompted for the microphone');
    audio.stopNodes();
  } finally {
    FakeAudioContext.latest?.stopNodes();
  }
});

test('a denied microphone can be allowed, and a dropped track still gets a spoken reply', async () => {
  const page = installPage();
  page.mode = 'deny';
  try {
    const ui = await freshCoach();
    const lines = DRIVE_LINES.slice(0, 2);
    ui.mountDriveCoach(deps(lines));
    page.elements.get('startCoach').onclick();
    await waitFor(
      () => uiText(page, 'coachLine') === 'The microphone is blocked.',
      () => `denial copy missing. ${uiText(page, 'coachLine')}`
    );
    const coach = globalThis.window.__liltDriveCoach;
    coach.feed = () => { throw new Error('iPhone Safari audio has to arrive through the mic graph, not feed()'); };
    assert.equal(coach.status().paused, true);
    assert.equal(page.elements.get('coachResume').hidden, false);
    assert.equal(FakeAudioContext.latest.processors, 0);
    assert.ok(page.said.some(line => /microphone is blocked/i.test(line)), page.said.join(' | '));
    page.mode = 'live';
    page.elements.get('coachResume').onclick();
    const audio = FakeAudioContext.latest;
    await captureReady(page, audio, coach);
    await expectReply(page, audio, coach);
    const calls = page.media.calls;
    assert.ok(page.stream?.track, 'the microphone track was not opened');
    page.stream.track.end();
    await waitFor(
      () => coach.status().paused === false && audio.liveProcessors() === 1 && coach.speaking() === false && page.media.calls > calls,
      () => `the coach did not recover after the microphone dropped. ${picture(page, audio, coach)}`,
      9000
    );
    await expectReply(page, audio, coach);
    audio.stopNodes();
  } finally {
    FakeAudioContext.latest?.stopNodes();
  }
});

test('leaving the page pauses the coach, and the next take is still answered', async () => {
  const page = installPage();
  try {
    const { audio, coach } = await mountAndStart(page, DRIVE_LINES.slice(0, 2));
    await expectReply(page, audio, coach);
    page.document.visibilityState = 'hidden';
    page.document.dispatch('visibilitychange');
    await waitFor(
      () => coach.status().paused === true && audio.liveProcessors() === 0 && audio.state === 'suspended' && /paused/i.test(uiText(page, 'coachLine')),
      () => `hiding the page did not pause and drop the mic. ${picture(page, audio, coach)}`
    );
    page.document.visibilityState = 'visible';
    page.document.dispatch('visibilitychange');
    await waitFor(
      () => coach.status().paused === false && audio.liveProcessors() === 1 && coach.speaking() === false,
      () => `coming back did not resume the drive. ${picture(page, audio, coach)}`,
      9000
    );
    await expectReply(page, audio, coach);
    audio.stopNodes();
  } finally {
    FakeAudioContext.latest?.stopNodes();
  }
});

function practiceClip(url, id) {
  return url.includes(`voice/${id}/`);
}

function riverClip(url) {
  return /(?:^|\/)voice\/[0-9a-f]{8}\.mp3$/.test(url);
}

test('af_bella speaks when it is the practice voice, and River stays the main voice', async () => {
  const mod = await import('../drive-voice.js');
  if (!mod.PRACTICE_VOICE) {
    assert.equal(mod.COACH_VOICE, 'af_river');
    return;
  }
  assert.equal(mod.COACH_VOICE, 'af_river');
  assert.equal(mod.PRACTICE_VOICE, 'af_bella');
  const store = new Map([['lilt-coach-voice', mod.PRACTICE_VOICE]]);
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  };
  const page = installPage();
  page.mode = 'sheet';
  try {
    const { audio, coach } = await mountAndStart(page, DRIVE_LINES.slice(0, 3));
    assert.ok(page.urls.some(url => practiceClip(url, 'af_bella')), `practice clips did not play: ${page.urls.filter(url => url.includes('voice/')).slice(0, 6).join(' | ')}`);
    assert.equal(page.urls.some(riverClip), false, 'the practice voice played River clips');
    await expectReply(page, audio, coach);
    const switched = page.urls.length;
    page.nextTranscript = 'main voice';
    await expectReply(page, audio, coach);
    page.nextTranscript = '';
    const mainClips = page.urls.slice(switched);
    assert.ok(mainClips.some(riverClip), `main voice did not play River: ${mainClips.join(' | ')}`);
    assert.equal(mainClips.some(url => practiceClip(url, 'af_bella')), false, 'River reply still used Bella clips');
    assert.equal(coach.status().paused, false);
    assert.equal(coach.speaking(), false);
    audio.stopNodes();
  } finally {
    FakeAudioContext.latest?.stopNodes();
    delete globalThis.localStorage;
  }
});

test('af_river stays the clip voice, and a second practice voice is checked when it is declared', async () => {
  const meta = JSON.parse(readFileSync(new URL('../public/voice/voice.json', import.meta.url), 'utf8'));
  // The practice-voice change can export either name, or record the id on the manifest.
  // Until that lands, the only voice is af_river and this test is the switch point.
  const mod = await import('../drive-voice.js');
  assert.equal(meta.voice, mod.COACH_VOICE, 'voice.json must be the voice the coach actually plays');
  const named = [mod.COACH_VOICE, mod.RIVER_VOICE, meta.river, ...(meta.voices || [])].filter(Boolean);
  assert.ok(named.includes('af_river'), `af_river is no longer named (${named.join(', ')})`);
  const practice = mod.PRACTICE_VOICE || mod.EASIER_PRACTICE_VOICE || meta.practiceVoice || '';
  if (!practice) {
    assert.equal(mod.COACH_VOICE, 'af_river');
    return;
  }
  assert.match(practice, /^[a-z]{2}_[a-z0-9]+$/, practice);
  if (practice !== 'af_river') assert.ok(named.includes('af_river'));
  assert.equal(meta.voice, mod.COACH_VOICE);
});

test('the iPhone matrix says what this harness covers and what the phone still has to prove', () => {
  const text = readFileSync(new URL('../qa/iphone-safari-drive.md', import.meta.url), 'utf8');
  for (const needle of ['Simulated', 'phone', 'screen lock', 'af_river', 'feed()', 'Bluetooth', 'CarPlay']) {
    assert.match(text, new RegExp(needle, 'i'), needle);
  }
});

});
