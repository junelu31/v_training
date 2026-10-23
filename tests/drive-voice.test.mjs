import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { CUE_LIBRARY, IMPROVED_LINES, ISSUE_ORDER, fillWord, problemPhrase } from '../drive-cues.js';
import { SESSION_LINES } from '../drive-session.js';
import { createCoachSession, followUpLine, openingLine } from '../drive-coach.js';
import { COACH_LINES, COACH_VOICE, COACH_VOICE_SPEED, LEAD_LINES, PRACTICE_VOICE, clipFile, fragmentWords, planSpeech, voiceKey } from '../drive-voice.js';
import { PRACTICE_CLIPS, VOICE_CLIPS } from '../drive-voice-clips.js';
import { activeCoachVoice, coachClip, selectCoachVoice } from '../drive-ui.js';

const has = text => Boolean(VOICE_CLIPS[text.startsWith("~") ? text : voiceKey(text)]);
const hasPractice = text => Boolean(PRACTICE_CLIPS[text.startsWith("~") ? text : voiceKey(text)]);
globalThis.window = {};
await import('../course.js');
const content = globalThis.window.COURSE_CONTENT;
const ids = new Set(content.drives.flatMap(drive => drive.lines));
const phrases = content.drills.filter(drill => ids.has(drill.id)).map(drill => drill.phrase);

test('every fixed line has a clip file that exists and stays small', () => {
  const coachSource = readFileSync(new URL('../drive-coach.js', import.meta.url), 'utf8');
  const literals = [...coachSource.matchAll(/(?:say: |type: '[a-z-]+', text: )'([^'$]+)'/g)].map(match => match[1]);
  assert.ok(literals.length >= 5, `found ${literals.length} spoken literals`);
  for (const line of literals) assert.ok(COACH_LINES.includes(line), line);
  const fixed = [...COACH_LINES, ...Object.values(SESSION_LINES), ...Object.values(CUE_LIBRARY).flatMap(entry => entry.variants), ...literals, ...phrases];
  for (const line of fixed) {
    assert.ok(has(line), `no clip for: ${line}`);
    const file = new URL(`../public/${clipFile(line)}`, import.meta.url);
    assert.ok(existsSync(file), `missing file for: ${line}`);
    assert.ok(statSync(file).size < 80000, `clip too large: ${line}`);
  }
});

test('opening and follow-up lines play entirely from clips', () => {
  for (const ready of [has, hasPractice]) {
    for (const phrase of phrases) {
      for (const line of [
        openingLine(phrase),
        openingLine(phrase, { resumed: true }),
        followUpLine({ prompt: phrase, next: phrase }),
        followUpLine({ prompt: phrase, coached: true }),
        `Next. ${phrase}`,
        `Again. ${phrase}`,
        `Back to lines. ${phrase}`,
        `Practice voice is on. Match how I say this: ${phrase}`,
        `Main coach voice is on. Match how I say this: ${phrase}`
      ]) {
        const plan = planSpeech(line, ready);
        assert.ok(plan.every(part => part.clip), `runtime part in: ${line}`);
        assert.ok(plan.length <= 2, `too many clips for: ${line}`);
      }
    }
    assert.ok(planSpeech(openingLine(''), ready).every(part => part.clip));
    assert.ok(planSpeech('Practice voice is on. Talk in this voice whenever you are ready.', ready).every(part => part.clip));
    assert.ok(planSpeech('Main coach voice is on. Talk in this voice whenever you are ready.', ready).every(part => part.clip));
  }
});

test('each drive loads a long conversational phrase bank', () => {
  assert.ok(phrases.length >= 60, `only ${phrases.length} drive phrases`);
  for (const drive of content.drives) {
    assert.ok(drive.lines.length >= 50, `${drive.id} has ${drive.lines.length} lines`);
    const linePhrases = drive.lines.map(id => content.drills.find(drill => drill.id === id)?.phrase).filter(Boolean);
    assert.equal(linePhrases.length, drive.lines.length, drive.id);
    assert.equal(new Set(linePhrases).size, linePhrases.length, drive.id);
  }
});

test('a line that names a word is stitched from fragments of the coach voice, not a second voice', () => {
  const cue = CUE_LIBRARY.fry.variants[0];
  assert.deepEqual(planSpeech(`Arriving fell into fry. ${cue}`, has), [{ clip: '~arriving' }, { clip: '~fell into fry' }, { clip: cue }]);
  const grouped = planSpeech(`Arriving and ready fell into fry. ${cue}`, has);
  assert.ok(grouped.every(part => part.clip), JSON.stringify(grouped));
  assert.equal(grouped.some(part => part.clip === '~and'), true);
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

test('command replies play entirely from coach-voice clips', () => {
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
    assert.ok(plan.length > 0 && plan.every(part => part.clip), `a command reply would leave the coach voice: ${say} ${JSON.stringify(plan)}`);
  }
});

test('clips are the long-term coach plus the easier practice voice, and together stay under 20 MB', () => {
  const meta = JSON.parse(readFileSync(new URL('../public/voice/voice.json', import.meta.url), 'utf8'));
  const practiceMeta = JSON.parse(readFileSync(new URL(`../public/voice/${PRACTICE_VOICE}/voice.json`, import.meta.url), 'utf8'));
  assert.equal(meta.voice, COACH_VOICE);
  assert.equal(meta.speed, COACH_VOICE_SPEED);
  assert.equal(practiceMeta.voice, PRACTICE_VOICE);
  assert.equal(practiceMeta.speed, COACH_VOICE_SPEED);
  assert.equal(meta.rate, 24000);
  assert.equal(practiceMeta.rate, 24000);
  assert.equal(meta.channels, 1);
  assert.equal(practiceMeta.channels, 1);
  assert.equal(PRACTICE_VOICE, 'af_bella');
  assert.notEqual(PRACTICE_VOICE, COACH_VOICE);
  const files = [...Object.values(VOICE_CLIPS), ...Object.values(PRACTICE_CLIPS)];
  const total = files.reduce((sum, file) => sum + statSync(new URL(`../public/${file}`, import.meta.url)).size, 0);
  assert.ok(total < 20 * 1024 * 1024, `clips total ${total} bytes`);
});

test('the practice voice has the same lines, in its own folder, and playback follows the choice', () => {
  assert.deepEqual(Object.keys(PRACTICE_CLIPS).sort(), Object.keys(VOICE_CLIPS).sort());
  for (const [key, file] of Object.entries(VOICE_CLIPS)) {
    assert.equal(file, clipFile(key, COACH_VOICE), key);
    assert.equal(PRACTICE_CLIPS[key], clipFile(key, PRACTICE_VOICE), key);
    assert.ok(existsSync(new URL(`../public/${PRACTICE_CLIPS[key]}`, import.meta.url)), key);
    assert.notEqual(PRACTICE_CLIPS[key], file, key);
    assert.equal(PRACTICE_CLIPS[key].startsWith(`voice/${PRACTICE_VOICE}/`), true, key);
  }
  for (const line of [...LEAD_LINES, ...phrases]) {
    assert.ok(hasPractice(line), `practice voice has no clip for: ${line}`);
    const plan = planSpeech(line, hasPractice);
    assert.ok(plan.every(part => part.clip), `practice voice would leave its own sound: ${line}`);
  }
  const phrase = phrases[0];
  assert.equal(selectCoachVoice(PRACTICE_VOICE), PRACTICE_VOICE);
  assert.equal(activeCoachVoice(), PRACTICE_VOICE);
  assert.equal(coachClip(phrase), PRACTICE_CLIPS[voiceKey(phrase)]);
  assert.equal(selectCoachVoice(COACH_VOICE), COACH_VOICE);
  assert.equal(coachClip(phrase), VOICE_CLIPS[voiceKey(phrase)]);
  assert.equal(selectCoachVoice('af_sky'), COACH_VOICE);
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(page, new RegExp(`id="practiceVoiceButton"[^>]*data-coach-voice="${PRACTICE_VOICE}"`));
  assert.match(page, new RegExp(`id="mainVoiceButton"[^>]*data-coach-voice="${COACH_VOICE}"`));
});
