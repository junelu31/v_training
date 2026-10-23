import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTurns, synthesizeWords } from '../drive-dsp.js';
import { describeTake, readTurn } from '../drive-session.js';

test('readTurn scores the frames the detector already measured', () => {
  const { samples } = synthesizeWords([
    { text: 'hello', ms: 700, f0: 190, f1: 400, f2: 1900, seed: 8, gapMs: 40 }
  ]);
  const turn = detectTurns(samples, 16000).find(item => item.samples?.length && item.frames?.length);
  assert.ok(turn, 'expected a voiced turn');
  assert.equal(Number.isFinite(turn.pcmSnrDb), true);
  const scored = readTurn(turn);
  assert.deepEqual(scored, describeTake(turn.samples, turn.sampleRate));
  assert.equal(Number.isFinite(scored.f0), true);
  const tampered = readTurn({
    ...turn,
    frames: turn.frames.map(frame => ({ ...frame, voiced: false, hz: NaN, vowel: false })),
    pcmSnrDb: turn.pcmSnrDb
  });
  assert.notDeepEqual(tampered, scored);
  assert.equal(Number.isFinite(tampered.f0), false);
});
