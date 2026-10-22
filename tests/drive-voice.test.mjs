import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { CUE_LIBRARY } from '../drive-cues.js';
import { SESSION_LINES } from '../drive-session.js';
import { followUpLine, openingLine } from '../drive-coach.js';
import { COACH_LINES, clipFile, planSpeech, voiceKey } from '../drive-voice.js';
import { VOICE_CLIPS } from '../drive-voice-clips.js';

const has = text => Boolean(VOICE_CLIPS[voiceKey(text)]);
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

test('a line that names a word keeps the word at runtime and the cue as a clip', () => {
  const cue = CUE_LIBRARY.fry.variants[0];
  const plan = planSpeech(`Arriving fell into fry. ${cue}`, has);
  assert.deepEqual(plan, [{ text: 'Arriving fell into fry.' }, { clip: cue }]);
  assert.deepEqual(planSpeech('12 phrases. 9 held, 3 had a note.', has), [{ text: '12 phrases. 9 held, 3 had a note.' }]);
});
