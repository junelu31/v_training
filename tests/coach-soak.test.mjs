import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnDetector, makeRoadNoise, synthesizeWords } from '../drive-dsp.js';
import { classifyUtterance, createCoachSession } from '../drive-coach.js';

function heap() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed;
}

test('a 40 minute coach loop keeps a fixed buffer and a capped log', () => {
  const speech = synthesizeWords([
    { text: 'Hi', ms: 220, f0: 190, f1: 420, f2: 2000, seed: 1, gapMs: 60 },
    { text: 'there', ms: 280, f0: 180, f0End: 170, f1: 450, f2: 1700, seed: 2, gapMs: 80 }
  ]).samples;
  const noise = makeRoadNoise(8, 16000, 21);
  let now = Date.parse('2026-10-22T08:00:00Z');
  const session = createCoachSession({ plannedMinutes: 40, routineId: 'week-4', lines: ['Hi there'], now, id: 'soak' });
  const goal = { pitch: [175, 225], brightness: [-8, -4] };
  let turns = 0;
  const detector = createTurnDetector({
    onTurn(turn) {
      turns += 1;
      const judged = classifyUtterance({ analysis: turn, prompt: 'Hi there', goal, cursor: turns });
      now += 30_000;
      session.noteAnalysis(judged, { transcript: 'Hi there', at: now });
      if (turns % 4 === 0) session.checkpoint(now);
    }
  });
  const startHeap = heap();
  const mark = { 0: startHeap };
  const chunk = 1600;
  const loop = new Float32Array(speech.length + noise.length);
  loop.set(speech, 0);
  loop.set(noise, speech.length);
  const total = 40 * 60 * 16000;
  let pushed = 0;
  while (pushed < total) {
    const end = Math.min(loop.length, chunk);
    for (let offset = 0; offset < loop.length && pushed < total; offset += chunk) {
      detector.push(loop.subarray(offset, Math.min(loop.length, offset + chunk)));
      pushed += Math.min(chunk, loop.length - offset);
      const minute = pushed / 16000 / 60;
      if (minute >= 20 && mark[20] == null) mark[20] = heap();
      if (minute >= 40 && mark[40] == null) mark[40] = heap();
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
  console.log(JSON.stringify({ turns, heapStart: mark[0], heap20: mark[20], heap40: mark[40], growth20, growth40 }));
  assert.ok(growth40 < 8 * 1024 * 1024, `heap grew ${growth40} bytes in the second 20 minutes`);
  assert.ok(turns > 10);
});
