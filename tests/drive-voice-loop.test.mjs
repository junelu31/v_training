import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoachSession, followUpLine, openingLine } from '../drive-coach.js';

const lines = ['Who is arriving? We are ready whenever you are.', 'Mia is here early.'];

test('the opening line reads the first phrase aloud', () => {
  assert.equal(openingLine(lines[0]), 'Drive coach is on. Match how I say this: Who is arriving? We are ready whenever you are.');
  assert.equal(openingLine(''), 'Drive coach is on. Talk in this voice whenever you are ready.');
  assert.equal(openingLine(lines[1], { resumed: true }), 'The coach is listening again. Match how I say this: Mia is here early.');
});

test('a clear take moves to the next phrase and says it', () => {
  const session = createCoachSession({ lines, now: 0 });
  const next = session.advance();
  assert.equal(next, lines[1]);
  assert.equal(session.prompt(), lines[1]);
  assert.equal(followUpLine({ prompt: session.prompt(), next }), 'That matched. Next: Mia is here early.');
  assert.equal(session.advance(), lines[0], 'the routine loops');
});

test('a coached take repeats the same phrase, and noise or free talk adds nothing', () => {
  assert.equal(followUpLine({ prompt: lines[0], coached: true }), `Try it again, and match how I say it: ${lines[0]}`);
  assert.equal(followUpLine({ prompt: lines[0], tooNoisy: true }), '');
  assert.equal(followUpLine({ prompt: '', next: '' }), '');
  const free = createCoachSession({ lines, now: 0 });
  free.command('free');
  assert.equal(free.advance(), '');
});
