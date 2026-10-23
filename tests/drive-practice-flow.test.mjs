import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PHRASE_ATTEMPTS,
  createCoachSession,
  matchCommand,
  orderPracticePhrases,
  phraseDifficulty,
  shouldLeavePhrase
} from '../drive-coach.js';
import { planCoachTurn } from '../drive-ui.js';

const lines = ['Who is arriving? We are ready whenever you are.', 'Mia is here early.'];

const coached = {
  tooNoisy: false,
  feedback: { spoken: true, text: 'Morning sat low.', cursor: 1 },
  words: [{ text: 'morning', flags: [{ issue: 'low', speak: true }] }],
  profile: { label: 'androgynous' }
};

const passed = {
  tooNoisy: false,
  feedback: { spoken: false, text: '', cursor: 1 },
  words: [],
  profile: { label: 'feminine' }
};

test('phrases are tagged and ordered easiest to hardest', () => {
  const easy = 'Hey, it is good to see you.';
  const mid = 'Who is arriving? We are ready whenever you are.';
  const hard = 'I moved the meeting to three, so we have a little more time.';
  assert.ok(phraseDifficulty(easy).score < phraseDifficulty(mid).score);
  assert.ok(phraseDifficulty(mid).score < phraseDifficulty(hard).score);
  assert.equal(phraseDifficulty(easy).band, 'easy');
  assert.equal(phraseDifficulty(mid).band, 'medium');
  assert.equal(phraseDifficulty(hard).band, 'hard');
  const original = [hard, easy, mid];
  const copy = [...original];
  const ordered = orderPracticePhrases(original);
  assert.deepEqual(original, copy);
  assert.equal(ordered[0], easy);
  assert.equal(ordered[ordered.length - 1], hard);
  const scores = ordered.map(phrase => phraseDifficulty(phrase).score);
  for (let index = 1; index < scores.length; index++) assert.ok(scores[index] >= scores[index - 1]);
});

test('the week-1 bank is graded and sorted, not left in list order', async () => {
  globalThis.window = globalThis.window || {};
  await import('../course.js');
  const content = globalThis.window.COURSE_CONTENT;
  const week = content.drives.find(drive => drive.id === 'week-1');
  const phrases = week.lines.map(id => content.drills.find(drill => drill.id === id).phrase);
  const ordered = orderPracticePhrases(phrases);
  assert.equal(ordered.length, phrases.length);
  const scores = ordered.map(phrase => phraseDifficulty(phrase).score);
  for (let index = 1; index < scores.length; index++) assert.ok(scores[index] >= scores[index - 1]);
  assert.notDeepEqual(ordered, phrases);
  const bands = new Set(ordered.map(phrase => phraseDifficulty(phrase).band));
  assert.equal(bands.has('easy'), true);
  assert.equal(bands.has('hard'), true);
});

test('end practice stops the session and does not skip to the next phrase', () => {
  assert.equal(matchCommand('end practice', { prompt: lines[0] }), 'stop');
  assert.equal(matchCommand('End practice.', { prompt: lines[0] }), 'stop');
  assert.notEqual(matchCommand('end practice'), 'next');
  const session = createCoachSession({ lines, now: 0 });
  const ended = session.hear('end practice');
  assert.equal(ended.type, 'stop');
  assert.equal(ended.say, 'Stopping. I saved this drive.');
  assert.equal(session.status().stopped, true);
  assert.equal(session.status().lineIndex, 0);
  assert.equal(session.prompt(), lines[0]);
  const turn = { tooNoisy: true, reason: 'noise', sampleRate: 16000, samples: new Float32Array(0), hopVoicedMs: 800, frames: [] };
  const plan = planCoachTurn({ session: createCoachSession({ lines, now: 0 }), turn, heard: 'end practice', at: 1000 });
  assert.equal(plan.type, 'command');
  assert.equal(plan.command, 'stop');
  assert.equal(plan.result.type, 'stop');
  assert.equal(plan.follow, '');
});

test('three judged tries move to the next phrase, and a pass counts as achieved', () => {
  assert.equal(MAX_PHRASE_ATTEMPTS, 3);
  assert.equal(shouldLeavePhrase({ passed: false, attempts: 2, mode: 'lines' }), false);
  assert.equal(shouldLeavePhrase({ passed: false, attempts: 3, mode: 'lines' }), true);
  assert.equal(shouldLeavePhrase({ passed: true, attempts: 1, mode: 'lines' }), true);
  assert.equal(shouldLeavePhrase({ passed: false, attempts: 3, mode: 'free' }), false);
  const bank = [...lines, 'One more easy line.'];
  const session = createCoachSession({ lines: bank, now: 0 });
  session.noteAnalysis(passed, { transcript: bank[0], at: 1000 });
  assert.equal(session.status().lineAttempts, 1);
  session.advance();
  session.noteAnalysis(coached, { transcript: 'morning', at: 2000 });
  session.noteAnalysis(coached, { transcript: 'morning', at: 3000 });
  assert.equal(session.prompt(), bank[1]);
  assert.equal(session.status().lineAttempts, 2);
  const turn = { tooNoisy: true, reason: 'noise', sampleRate: 16000, samples: new Float32Array(0), hopVoicedMs: 800, frames: [] };
  const plan = planCoachTurn({ session, turn, heard: 'morning light', at: 4000 });
  assert.equal(plan.type, 'practice');
  assert.equal(plan.finished, false);
  assert.match(plan.follow, /^Next\. /);
  assert.equal(session.prompt(), bank[2]);
  assert.equal(session.status().stopped, false);
  assert.equal(session.status().lineAttempts, 0);
  session.noteAnalysis(coached, { transcript: 'morning', at: 5000 });
  session.noteAnalysis(coached, { transcript: 'morning', at: 6000 });
  const last = planCoachTurn({ session, turn, heard: 'morning light', at: 7000 });
  assert.equal(last.finished, true);
  assert.equal(session.prompt(), '');
  assert.equal(session.status().exhausted, true);
  const summary = session.wrapUp();
  assert.equal(summary.attempted, 3);
  assert.equal(summary.achieved, 1);
  assert.equal(summary.problems[0].word, 'morning');
  assert.match(summary.problems[0].phonetics, /Pitch sitting low/);
  assert.match(summary.problems[0].phonetics, /sat low in pitch/);
  assert.equal(summary.problems[0].count, 4);
});

test('the drive page no longer offers a 20, 30, or 40 minute session', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(app.includes('[20,30,40]'), false);
  assert.equal(app.includes('data-drive-minutes'), false);
  assert.match(app, /return orderPracticePhrases\(phrases\)/);
  assert.equal(html.includes('id="driveDurations"'), false);
  assert.equal(html.includes('id="driveActual"'), false);
  assert.match(html, /id="coachEnd"/);
  assert.match(html, />End practice</);
});
