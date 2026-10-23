// Drives the real coach screen the way an iPhone would: start, the mic sheet,
// a spoken reply after her phrase, a command, a denial, and a clip that plays
// without ever firing onended. The page and the audio context are fakes.
// Nothing here is a second coaching policy.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeWords } from '../drive-dsp.js';

const PHRASE = 'Who is arriving? We are ready whenever you are.';
const NEXT = 'Mia is here early.';

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
  static hangEnded = false;
  static clipDuration = 0.35;
  static latest = null;
  constructor() {
    this.sampleRate = 48000;
    this.state = 'suspended';
    this.destination = {};
    this.onstatechange = null;
    this.events = new Map();
    this.sources = [];
    this.processors = 0;
    this.interruptions = 0;
    this.waiters = [];
    this.nodes = [];
    this.clipDuration = FakeAudioContext.clipDuration;
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
    return { gain: { value: 0 }, connect() {}, disconnect() {} };
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
        if (FakeAudioContext.hangEnded) return;
        source.timer = setTimeout(() => {
          if (source.ended) return;
          source.ended = true;
          source.onended?.();
        }, 40);
        source.timer.unref?.();
      },
      stop() {
        if (source.ended) return;
        source.ended = true;
        source.stopped = true;
        clearTimeout(source.timer);
        if (!FakeAudioContext.hangEnded) source.onended?.();
      }
    };
    return source;
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    this.processors += 1;
    const node = {
      disconnected: false,
      onaudioprocess: null,
      connect() {
        const tick = () => {
          if (node.disconnected) return;
          node.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(128) } });
          node.timer = setTimeout(tick, 20);
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
    const duration = this.clipDuration;
    return Promise.resolve({ duration, length: Math.max(1, Math.round(this.sampleRate * duration)) });
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
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 16);
  const said = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/api/drive/turn')) {
      const body = options.body ? JSON.parse(options.body) : {};
      const heard = body.audioBase64 ? (globalThis.__heardTranscript || '') : '';
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
    addEventListener() {},
    SpeechSynthesisUtterance,
    speechSynthesis: {
      cancel() {},
      speak(utterance) {
        if (utterance.volume === 0) return;
        said.push(utterance.text);
        utterance.onend?.();
      }
    }
  };
  const media = {
    calls: 0,
    hold: false,
    deny: false,
    grant: null,
    devices: {
      getUserMedia() {
        media.calls += 1;
        const audio = FakeAudioContext.latest;
        if (media.deny) {
          audio.interruptions = 1;
          audio.setState('interrupted');
          audio.endInterruption();
          const error = new Error('denied');
          error.name = 'NotAllowedError';
          return Promise.reject(error);
        }
        if (media.hold) {
          audio.interruptions = 1;
          audio.setState('interrupted');
          return new Promise(resolve => {
            media.grant = () => {
              audio.endInterruption();
              resolve(fakeStream());
            };
          });
        }
        return Promise.resolve(fakeStream());
      },
      addEventListener() {}
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      audioSession: { type: 'auto' },
      onLine: true,
      mediaDevices: media.devices,
      wakeLock: {
        request() {
          return Promise.resolve({ addEventListener() {}, release() { return Promise.resolve(); } });
        }
      }
    }
  });
  return { elements, said, media };
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

function deps() {
  return {
    getPlanned: () => 30,
    getRoutine: () => 'week-1',
    getLines: () => [PHRASE, NEXT],
    getGoal: () => ({}),
    save() {}
  };
}

function longClips(audio) {
  return audio.sources.filter(source => (source.buffer?.duration || 0) > 0.05);
}

async function waitFor(check, label, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    let ok = false;
    try { ok = Boolean(check()); } catch { ok = false; }
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(label);
}

async function waitUntilQuiet(audio) {
  let count = -1;
  let stable = 0;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const clips = longClips(audio);
    const settled = clips.length > 0 && clips.every(source => source.ended || source.stopped);
    if (settled && clips.length === count) stable += 40;
    else stable = 0;
    count = clips.length;
    if (stable >= 500) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('speech did not settle');
}

function phraseAudio() {
  const words = PHRASE.split(/\s+/).map((text, index) => ({
    text, ms: 220, f0: 210, f1: 420, f2: 2100, seed: 30 + index, gapMs: 40
  }));
  const speech = synthesizeWords(words).samples;
  const samples = new Float32Array(speech.length + 16000 * 2);
  samples.set(speech);
  return samples;
}

function feed(samples) {
  const coach = globalThis.window.__liltDriveCoach;
  for (let offset = 0; offset < samples.length; offset += 1600) {
    coach.feed(samples.subarray(offset, offset + 1600));
  }
  return coach;
}

async function fresh(label) {
  return import(`../drive-ui.js?qa=${label}-${Math.random()}`);
}

describe('iPhone Safari coach loop', { concurrency: 1 }, () => {

test('Drive speaks on start, waits out the mic sheet, then keeps listening', async () => {
  FakeAudioContext.hangEnded = false;
  FakeAudioContext.clipDuration = 0.35;
  const page = installPage();
  page.media.hold = true;
  const ui = await fresh('sheet');
  ui.mountDriveCoach(deps());
  page.elements.get('startCoach').onclick();
  await new Promise(resolve => setTimeout(resolve, 40));
  const audio = FakeAudioContext.latest;
  assert.equal(audio.state, 'interrupted');
  assert.equal(globalThis.navigator.audioSession.type, 'play-and-record');
  assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
  assert.equal(longClips(audio).length, 0);
  assert.equal(page.media.calls, 1);
  page.media.grant();
  await waitFor(() => longClips(audio).some(source => source.started) && audio.processors > 0, 'no opening audio after Allow');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(page.media.calls, 1);
  assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
  assert.equal(page.elements.get('coachResume').hidden, true);
  audio.stopNodes();
});

test('after she says the phrase, the coach speaks a follow-up', async () => {
  FakeAudioContext.hangEnded = false;
  globalThis.__heardTranscript = PHRASE;
  const page = installPage();
  const ui = await fresh('reply');
  ui.mountDriveCoach(deps());
  page.elements.get('startCoach').onclick();
  const audio = FakeAudioContext.latest;
  await waitUntilQuiet(audio);
  const before = longClips(audio).length;
  audio.stopNodes();
  const coach = feed(phraseAudio());
  await waitFor(() => /Heard you/.test(page.elements.get('coachHeard').textContent) && longClips(audio).length > before, `no spoken follow-up. heard=${page.elements.get('coachHeard').textContent} line=${page.elements.get('coachLine').textContent}`);
  const screen = `${page.elements.get('coachLine').textContent} ${page.elements.get('coachSub').textContent} ${page.said.join(' ')}`;
  assert.match(screen, /That matched|Try it again|too noisy|fell into|dropped|breathy|pressed|pitch|match how I say/i, screen);
  assert.equal(coach.status().paused, false);
  audio.stopNodes();
});

test('next phrase is spoken as a command and does not also coach the line', async () => {
  FakeAudioContext.hangEnded = false;
  globalThis.__heardTranscript = 'Um, next phrase please.';
  const page = installPage();
  const ui = await fresh('command');
  ui.mountDriveCoach(deps());
  page.elements.get('startCoach').onclick();
  const audio = FakeAudioContext.latest;
  await waitUntilQuiet(audio);
  audio.stopNodes();
  const before = longClips(audio).length;
  const coach = feed(phraseAudio());
  await waitFor(() => coach.status().lineIndex === 1 && longClips(audio).length > before, `command was not spoken. line=${page.elements.get('coachLine').textContent} heard=${page.elements.get('coachHeard').textContent} status=${JSON.stringify(coach.status())}`);
  assert.match(page.elements.get('coachLine').textContent, /^Next\./);
  assert.equal(/Try it again|That matched/.test(page.elements.get('coachLine').textContent), false);
  assert.equal(coach.status().paused, false);
  audio.stopNodes();
});

test('a denied microphone says how to continue and does not pretend to listen', async () => {
  FakeAudioContext.hangEnded = false;
  const page = installPage();
  page.media.deny = true;
  const ui = await fresh('deny');
  ui.mountDriveCoach(deps());
  page.elements.get('startCoach').onclick();
  await waitFor(() => page.elements.get('coachLine').textContent === 'The microphone is blocked.', 'denial copy missing');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(page.elements.get('coachSub').textContent, 'Allow the microphone for this site, then tap to continue.');
  assert.equal(page.elements.get('coachResume').hidden, false);
  assert.equal(globalThis.window.__liltDriveCoach.status().paused, true);
  assert.equal(FakeAudioContext.latest.processors, 0);
  assert.equal(page.media.calls, 1);
  assert.ok(page.said.some(line => /microphone is blocked/i.test(line)), page.said.join(' | '));
});

test('audio coming back after a real interruption still answers the next phrase', async () => {
  FakeAudioContext.hangEnded = false;
  globalThis.__heardTranscript = 'next phrase';
  const page = installPage();
  const ui = await fresh('resume');
  ui.mountDriveCoach(deps());
  page.elements.get('startCoach').onclick();
  const audio = FakeAudioContext.latest;
  await waitUntilQuiet(audio);
  await new Promise(resolve => setTimeout(resolve, 1700));
  audio.interruptions = 1;
  audio.setState('interrupted');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(globalThis.window.__liltDriveCoach.status().paused, true);
  audio.endInterruption();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
  audio.stopNodes();
  const before = longClips(audio).length;
  const coach = feed(phraseAudio());
  await waitFor(() => coach.status().lineIndex === 1 && longClips(audio).length > before, `reply lost after the interruption. line=${page.elements.get('coachLine').textContent} paused=${coach.status().paused}`);
  assert.match(page.elements.get('coachLine').textContent, /^Next\./);
  audio.stopNodes();
});

test('a clip that never fires onended still lets the next phrase get a spoken reply', async () => {
  FakeAudioContext.hangEnded = true;
  FakeAudioContext.clipDuration = 0.12;
  globalThis.__heardTranscript = PHRASE;
  const page = installPage();
  const ui = await fresh('hang');
  ui.mountDriveCoach(deps());
  page.elements.get('startCoach').onclick();
  const audio = FakeAudioContext.latest;
  await waitFor(() => longClips(audio).some(source => source.started) && audio.processors > 0, 'opening never started');
  await new Promise(resolve => setTimeout(resolve, 3500));
  audio.stopNodes();
  const before = longClips(audio).length;
  const coach = feed(phraseAudio());
  await waitFor(
    () => /Heard you/.test(page.elements.get('coachHeard').textContent) && longClips(audio).length > before,
    `still mute after the phrase. paused=${coach.status()?.paused} line=${page.elements.get('coachLine').textContent} heard=${page.elements.get('coachHeard').textContent} clips=${longClips(audio).length}`,
    5000
  );
  assert.equal(coach.status().paused, false);
  audio.stopNodes();
});

});
