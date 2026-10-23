import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTurnDetector, makeRoadNoise, synthesizeWords } from '../drive-dsp.js';
import { createCoachSession } from '../drive-coach.js';
import { reviewLiveTurn } from '../drive-ui.js';
import { applyVisibility, awakeLabel, createStayAwake } from '../drive-wake.js';

function fakeStay({ lock = true, videoOk = true } = {}) {
  const live = new Set();
  const video = { plays: 0, playing: false, elements: 1 };
  const rig = { live, video, issued: 0 };
  function makeLock() {
    const listeners = new Set();
    const sentinel = {
      listeners,
      addEventListener(_type, fn) { listeners.add(fn); },
      removeEventListener(_type, fn) { listeners.delete(fn); },
      release() {
        live.delete(sentinel);
        for (const fn of [...listeners]) fn();
        return Promise.resolve();
      }
    };
    live.add(sentinel);
    return sentinel;
  }
  rig.hooks = {
    requestWakeLock() {
      if (!lock) return Promise.reject(new Error('Wake Lock is unavailable'));
      rig.issued += 1;
      return Promise.resolve(makeLock());
    },
    playVideo() {
      if (!videoOk) return Promise.reject(new Error('video blocked'));
      video.plays += 1;
      video.playing = true;
      return Promise.resolve();
    },
    pauseVideo() { video.playing = false; },
    isVideoPlaying() { return video.playing; }
  };
  rig.listenerCount = () => [...live].reduce((sum, item) => sum + item.listeners.size, 0);
  rig.releaseBrowser = () => Promise.all([...live].map(item => item.release()));
  return rig;
}

function listenerCount(live) {
  return [...live].reduce((sum, item) => sum + item.listeners.size, 0);
}

function heap() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed;
}

test('a 40 minute coach loop keeps a fixed buffer and a capped log', async () => {
  const wakeSource = readFileSync(new URL('../drive-wake.js', import.meta.url), 'utf8');
  assert.equal(/setInterval|requestAnimationFrame|createElement\(['"]canvas['"]\)/.test(wakeSource), false);
  assert.equal(awakeLabel('lock'), 'Screen stays on.');
  assert.equal(awakeLabel('video'), 'Screen stays on.');
  assert.equal(awakeLabel('manual'), 'Set Auto-Lock to Never during drives.');
  const speech = synthesizeWords([
    { text: 'Hi', ms: 220, f0: 190, f1: 420, f2: 2000, seed: 1, gapMs: 60 },
    { text: 'there', ms: 280, f0: 180, f0End: 170, f1: 450, f2: 1700, seed: 2, gapMs: 80 }
  ]).samples;
  const noise = makeRoadNoise(8, 16000, 21);
  let now = Date.parse('2026-10-22T08:00:00Z');
  const session = createCoachSession({ plannedMinutes: 40, routineId: 'week-4', lines: ['Hi there'], now, id: 'soak' });
  const goal = { pitch: [160, 210], brightness: [-16, -10] };
  let turns = 0;
  const detector = createTurnDetector({
    onTurn(turn) {
      turns += 1;
      now += 30_000;
      reviewLiveTurn(turn, session, { goal, at: now, prompt: 'Hi there' });
      if (turns % 4 === 0) session.checkpoint(now);
    }
  });
  const rig = fakeStay();
  const stayAwake = createStayAwake(rig.hooks);
  const sessionId = session.id;
  const media = { state: 'running', openTracks: 0 };
  await stayAwake.arm();
  await stayAwake.arm();
  assert.equal(rig.issued, 1);
  assert.equal(stayAwake.status().mode, 'lock');
  assert.equal(rig.video.playing, false);
  assert.equal(rig.video.plays, 2);
  const presence = visible => applyVisibility({
    visible,
    userPaused: false,
    interrupt: reason => session.interrupt(reason),
    resume: () => session.resumeAfterInterrupt(),
    stopMic() { media.openTracks = 0; },
    suspendAudio() { media.state = 'suspended'; return Promise.resolve(); },
    resumeAudio() { media.state = 'running'; return Promise.resolve(); },
    openMic() { media.openTracks = 1; return Promise.resolve(); },
    stayAwake
  });
  const startHeap = heap();
  const mark = { 0: startHeap };
  const chunk = 1600;
  const loop = new Float32Array(speech.length + noise.length);
  loop.set(speech, 0);
  loop.set(noise, speech.length);
  const total = 40 * 60 * 16000;
  let pushed = 0;
  let nextMinute = 1;
  while (pushed < total) {
    for (let offset = 0; offset < loop.length && pushed < total; offset += chunk) {
      detector.push(loop.subarray(offset, Math.min(loop.length, offset + chunk)));
      pushed += Math.min(chunk, loop.length - offset);
      const minute = pushed / 16000 / 60;
      if (minute >= 20 && mark[20] == null) mark[20] = heap();
      if (minute >= 40 && mark[40] == null) mark[40] = heap();
      if (minute >= nextMinute && nextMinute <= 40) {
        const hidden = await presence(false);
        assert.equal(hidden.paused, true);
        assert.equal(media.openTracks, 0);
        assert.equal(media.state, 'suspended');
        assert.equal(session.status().paused, true);
        await rig.releaseBrowser();
        const shown = await presence(true);
        assert.equal(shown.paused, false);
        assert.equal(shown.mode, 'lock');
        assert.equal(media.openTracks, 1);
        assert.equal(media.state, 'running');
        assert.equal(session.status().paused, false);
        assert.equal(session.id, sessionId);
        assert.equal(rig.video.elements, 1);
        assert.equal(rig.video.playing, false);
        assert.equal(rig.live.size, 1);
        assert.equal(listenerCount(rig.live), 1);
        nextMinute += 1;
      }
    }
  }
  detector.push(new Float32Array(16000));
  const stats = detector.stats();
  assert.equal(stats.bufferCap, 16000 * 12);
  assert.equal(stats.utteranceSamples, 0);
  assert.ok(session.status().phrases <= 24);
  assert.ok(session.checkpoint(now).phrases <= 30);
  const growth20 = mark[20] - mark[0];
  const growth40 = mark[40] - mark[20];
  assert.equal(rig.video.plays, 2);
  session.command('pause');
  const pausedAway = await applyVisibility({
    visible: false,
    userPaused: true,
    interrupt: reason => session.interrupt(reason),
    resume: () => session.resumeAfterInterrupt(),
    stopMic() { media.openTracks = 0; },
    suspendAudio() { media.state = 'suspended'; return Promise.resolve(); },
    resumeAudio() { media.state = 'running'; return Promise.resolve(); },
    openMic() { media.openTracks = 1; return Promise.resolve(); },
    stayAwake
  });
  assert.equal(pausedAway.paused, true);
  assert.equal(media.openTracks, 0);
  await rig.releaseBrowser();
  const stillPaused = await applyVisibility({
    visible: true,
    userPaused: true,
    interrupt: reason => session.interrupt(reason),
    resume: () => session.resumeAfterInterrupt(),
    stopMic() { media.openTracks = 0; },
    suspendAudio() { media.state = 'suspended'; return Promise.resolve(); },
    resumeAudio() { media.state = 'running'; return Promise.resolve(); },
    openMic() { media.openTracks = 1; return Promise.resolve(); },
    stayAwake
  });
  assert.equal(stillPaused.heldPaused, true);
  assert.equal(media.openTracks, 0);
  assert.equal(media.state, 'suspended');
  assert.equal(session.status().paused, true);
  assert.equal(session.id, sessionId);
  assert.equal(rig.video.elements, 1);
  assert.equal(rig.live.size, 1);
  await stayAwake.stop();
  assert.equal(stayAwake.status().mode, 'off');
  assert.equal(stayAwake.status().holdingLock, false);
  assert.equal(rig.live.size, 0);
  assert.equal(rig.video.playing, false);
  assert.equal(listenerCount(rig.live), 0);
  const videoRig = fakeStay({ lock: false });
  const videoStay = createStayAwake(videoRig.hooks);
  assert.equal(await videoStay.arm(), 'video');
  for (let minute = 0; minute < 40; minute++) {
    videoRig.video.playing = false;
    assert.equal(await videoStay.onVisible(), 'video');
    assert.equal(videoRig.video.elements, 1);
    assert.equal(videoRig.video.playing, true);
    assert.equal(videoRig.live.size, 0);
  }
  assert.equal(videoRig.video.plays, 41);
  await videoStay.stop();
  assert.equal(videoRig.video.playing, false);
  const manualRig = fakeStay({ lock: false, videoOk: false });
  const manualStay = createStayAwake(manualRig.hooks);
  assert.equal(await manualStay.arm(), 'manual');
  for (let minute = 0; minute < 40; minute++) assert.equal(await manualStay.onVisible(), 'manual');
  assert.equal(manualRig.video.elements, 1);
  assert.equal(manualRig.live.size, 0);
  await manualStay.stop();
  console.log(JSON.stringify({ turns, heapStart: mark[0], heap20: mark[20], heap40: mark[40], growth20, growth40, wakeLocksIssued: rig.issued, videoPlays: rig.video.plays }));
  assert.ok(growth40 < 1.5 * 1024 * 1024, `heap grew ${growth40} bytes in the second 20 minutes`);
  assert.ok(turns > 10);
});

test('a visible wake-lock re-request falls back to the video', async () => {
  const rig = fakeStay();
  rig.hooks.isVisible = () => true;
  const stay = createStayAwake(rig.hooks);
  assert.equal(await stay.arm(), 'lock');
  rig.hooks.requestWakeLock = () => Promise.reject(new Error('Wake Lock rejected'));
  await rig.releaseBrowser();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stay.status().mode, 'video');
  assert.equal(rig.video.playing, true);
  assert.equal(rig.live.size, 0);
  await stay.stop();
  assert.equal(stay.status().mode, 'off');
});
