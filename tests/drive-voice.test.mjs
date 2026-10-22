import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { CUE_LIBRARY, IMPROVED_LINES, ISSUE_ORDER, fillWord, problemPhrase } from '../drive-cues.js';
import { SESSION_LINES } from '../drive-session.js';
import { createCoachSession, followUpLine, openingLine } from '../drive-coach.js';
import { COACH_LINES, clipFile, fragmentWords, planSpeech, voiceKey } from '../drive-voice.js';
import { VOICE_CLIPS } from '../drive-voice-clips.js';

const has = text => Boolean(VOICE_CLIPS[text.startsWith("~") ? text : voiceKey(text)]);
globalThis.window = {};
await import('../course.js');
const content = globalThis.window.COURSE_CONTENT;
const ids = new Set(content.drives.flatMap(drive => drive.lines));
const phrases = content.drills.filter(drill => ids.has(drill.id)).map(drill => drill.phrase);

test('every fixed line has a clip file that exists and stays small', () => {
  const coachSource = readFileSync(new URL('../drive-coach.js', import.meta.url), 'utf8');
  const literals = [...coachSource.matchAll(/(?:say: |type: '[a-z-]+', text: )'([^'$]+)'/g)].map(match => match[1]);
  assert.ok(literals.length >= 8);
  const fixed = [...COACH_LINES, ...Object.values(SESSION_LINES), ...Object.values(CUE_LIBRARY).flatMap(entry => entry.variants), ...literals, ...phrases];
  for (const line of fixed) {
    assert.ok(has(line), `no clip for: ${line}`);
    const file = new URL(`../public/${clipFile(line)}`, import.meta.url);
    assert.ok(existsSync(file), `missing file for: ${line}`);
    assert.ok(statSync(file).size < 80000, `clip too large: ${line}`);
  }
});

test('opening and follow-up lines play entirely from clips', () => {
  for (const phrase of phrases) {
    for (const line of [openingLine(phrase), openingLine(phrase, { resumed: true }), followUpLine({ prompt: phrase, next: phrase }), followUpLine({ prompt: phrase, coached: true }), `Next. ${phrase}`, `Again. ${phrase}`, `Back to lines. ${phrase}`]) {
      const plan = planSpeech(line, has);
      assert.ok(plan.every(part => part.clip), `runtime part in: ${line}`);
      assert.ok(plan.length <= 2, `too many clips for: ${line}`);
    }
  }
  assert.ok(planSpeech(openingLine(''), has).every(part => part.clip));
});

test('a line that names a word is stitched from Bella fragments, not a second voice', () => {
  const cue = CUE_LIBRARY.fry.variants[0];
  assert.deepEqual(planSpeech(`Arriving fell into fry. ${cue}`, has), [{ clip: '~arriving' }, { clip: '~fell into fry' }, { clip: cue }]);
  const words = [...new Set(phrases.flatMap(fragmentWords))];
  const problems = ISSUE_ORDER.flatMap(a => [problemPhrase([a]), ...ISSUE_ORDER.filter(b => b !== a).map(b => problemPhrase([a, b]))]);
  for (const word of words) {
    for (const problem of problems) {
      const plan = planSpeech(`${word} ${problem}. ${cue}`, has);
      assert.ok(plan.every(part => part.clip), `runtime part in: ${word} ${problem}`);
    }
    for (const template of IMPROVED_LINES) {
      const plan = planSpeech(fillWord(template, word), has);
      assert.ok(plan.every(part => part.clip), `runtime part in: ${fillWord(template, word)}`);
    }
  }
  // Words with curly apostrophes in the course text still match.
  assert.ok(planSpeech('I\u2019m dropped.', has).every(part => part.clip));
});

test('the summary is stitched up to 199 phrases and falls back above that', () => {
  const plan = planSpeech('12 phrases. 9 held, 3 had a note, 2 too noisy to coach.', has);
  assert.deepEqual(plan.map(part => part.clip), ['~12', '~phrases', '~9', '~held', '~3', '~had a note', '~2', '~too noisy to coach']);
  assert.ok(planSpeech('199 phrases. 150 held, 49 had a note.', has).every(part => part.clip));
  assert.deepEqual(planSpeech('240 phrases. 200 held, 40 had a note.', has), [{ text: '240 phrases. 200 held, 40 had a note.' }]);
  assert.deepEqual(planSpeech('Zebra dropped.', has), [{ text: 'Zebra dropped.' }], 'an unknown word sends the whole part to one fallback voice');
});

test('command replies play entirely from Bella clips', () => {
  const phrase = phrases[0];
  const lines = [phrase, phrases[1] || phrase];
  const replies = [];
  const fresh = () => createCoachSession({ lines, now: 0 });
  let session = fresh();
  replies.push(session.command('next').say);
  session = fresh();
  replies.push(session.command('repeat').say);
  session = fresh();
  replies.push(session.command('pause').say);
  replies.push(session.command('resume').say);
  session = fresh();
  replies.push(session.command('stop').say);
  session = fresh();
  replies.push(session.command('summary').say);
  session = fresh();
  replies.push(session.command('free').say);
  session = fresh();
  session.command('free');
  replies.push(session.command('lines').say);
  for (const say of replies) {
    const plan = planSpeech(say, has);
    assert.ok(plan.length > 0 && plan.every(part => part.clip), `a command reply would leave Bella: ${say} ${JSON.stringify(plan)}`);
  }
});

test('all clips together stay under 4 MB', () => {
  const total = Object.values(VOICE_CLIPS).reduce((sum, file) => sum + statSync(new URL(`../public/${file}`, import.meta.url)).size, 0);
  assert.ok(total < 4 * 1024 * 1024, `clips total ${total} bytes`);
});
