import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoachSession, followUpLine, openingLine } from '../drive-coach.js';
import { PRACTICE_VOICE } from '../drive-voice.js';

const lines = ['Who is arriving? We are ready whenever you are.', 'Mia is here early.'];

test('the opening line reads the first phrase aloud', () => {
  assert.equal(openingLine(lines[0]), lines[0]);
  assert.equal(openingLine(''), 'I am listening again.');
  assert.equal(openingLine(lines[1], { resumed: true }), lines[1]);
  assert.equal(openingLine('', { resumed: true }), 'The coach is listening again.');
  assert.equal(openingLine(lines[0], { voice: PRACTICE_VOICE }), lines[0]);
  assert.equal(openingLine('', { voice: PRACTICE_VOICE }), 'I am listening again.');
  assert.equal(openingLine(lines[0], { switched: true }), lines[0]);
  assert.equal(openingLine('', { switched: true }), 'The coach is listening again.');
});

test('a clear take moves to the next phrase and says it', () => {
  const session = createCoachSession({ lines, now: 0 });
  const next = session.advance();
  assert.equal(next, lines[1]);
  assert.equal(session.prompt(), lines[1]);
  assert.equal(followUpLine({ prompt: session.prompt(), next }), lines[1]);
  assert.equal(session.advance(), '', 'the bank ends instead of looping');
  assert.equal(session.status().exhausted, true);
});

test('a coached take repeats the same phrase, and noise or free talk adds nothing', () => {
  assert.equal(followUpLine({ prompt: lines[0], coached: true }), lines[0]);
  assert.equal(followUpLine({ prompt: lines[0], coached: true, voice: PRACTICE_VOICE }), lines[0]);
  assert.equal(followUpLine({ prompt: lines[0], next: lines[1], voice: PRACTICE_VOICE }), lines[1]);
  assert.equal(followUpLine({ prompt: lines[0], tooNoisy: true }), '');
  assert.equal(followUpLine({ prompt: '', next: '' }), '');
  const free = createCoachSession({ lines, now: 0 });
  free.command('free');
  assert.equal(free.advance(), '');
});
