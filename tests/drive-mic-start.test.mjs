import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afterMicRequest,
  micFailureCopy,
  onContextState,
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
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
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
          node.timer = setTimeout(tick, 30);
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

function longClips(audio) {
  return audio.sources.filter(source => source.buffer?.duration > 0.2);
}

async function waitFor(check, label) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
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

  // Already granted: opening the mic still interrupts playback, and the line is spoken again.
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
        setTimeout(() => audio.endInterruption(), 20);
      }, 5);
      watch.unref?.();
      return Promise.resolve(fakeStream());
    };
    ui.mountDriveCoach(deps(phrase));
    page.elements.get('startCoach').onclick();
    const audio = FakeAudioContext.latest;
    await waitFor(() => blip && longClips(audio).some(source => source.started && source.buffer && !source.stopped), 'replay after the route change');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(blip, 'the route change ran during the opening line');
    assert.equal(page.media.calls, 1);
    assert.equal(page.media.typeAtCall[0], 'play-and-record');
    assert.equal(globalThis.window.__liltDriveCoach.status().paused, false);
    assert.equal(page.elements.get('coachResume').hidden, true);
    assert.ok(longClips(audio).length >= 2, 'the cut-off opening line plays again');
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
