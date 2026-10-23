import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUE_LIBRARY, ISSUE_ORDER } from '../drive-cues.js';
import { classifyUtterance, composeFeedback, heardPrompt, matchCommand, openingLine, followUpLine } from '../drive-coach.js';
import { COACH_VOICE } from '../drive-voice.js';

globalThis.window = globalThis.window || {};
await import('../course.js');
const content = globalThis.window.COURSE_CONTENT;

const SENTENCE = /[.?!]["']?$/;

test('the coach voice is af_river and each drive keeps the long phrase bank', () => {
  const meta = JSON.parse(readFileSync(new URL('../public/voice/voice.json', import.meta.url), 'utf8'));
  assert.equal(COACH_VOICE, 'af_river');
  assert.equal(meta.voice, 'af_river');
  assert.equal(meta.speed, 0.95);
  const phrases = new Set();
  for (const drive of content.drives) {
    assert.ok(drive.lines.length >= 50, `${drive.id} has ${drive.lines.length} lines`);
    const linePhrases = drive.lines.map(id => content.drills.find(drill => drill.id === id)?.phrase);
    assert.equal(linePhrases.filter(Boolean).length, drive.lines.length, drive.id);
    for (const phrase of linePhrases) phrases.add(phrase);
  }
  assert.ok(phrases.size >= 53, `only ${phrases.size} distinct drive lines`);
});

test('spoken cues are complete sentences that imitate the coach, with no comfort or rest nag', () => {
  const coach = readFileSync(new URL('../drive-coach.js', import.meta.url), 'utf8');
  assert.equal(coach.includes('Quick comfort check'), false);
  assert.equal(coach.includes("type: 'rest'"), false);
  assert.equal(coach.includes("type: 'comfort-check'"), false);
  for (const [issue, entry] of Object.entries(CUE_LIBRARY)) {
    for (const line of entry.variants) {
      assert.match(line, SENTENCE, line);
      assert.equal(/comfort check|rate your comfort|take a rest|you should rest/i.test(line), false, line);
    }
    if (ISSUE_ORDER.includes(issue)) {
      assert.ok(entry.variants.some(line => /\b(I|my|mine)\b/.test(line)), `${issue} never mentions the coach voice`);
    }
  }
});

test('the opening and the follow-up tell her to match the coach voice', () => {
  const phrase = 'Mia is here early.';
  assert.match(openingLine(phrase), /^Drive coach is on\. Match how I say this: Mia is here early\.$/);
  assert.match(followUpLine({ prompt: phrase, coached: true }), /^Try it again, and match how I say it: Mia is here early\.$/);
  assert.match(followUpLine({ prompt: phrase, next: 'Hey, it is good to see you.' }), /^That matched\. Next: Hey, it is good to see you\.$/);
  assert.equal(followUpLine({ prompt: phrase, tooNoisy: true }), '');
});

test('a natural next-phrase command is a command, and a reading of the prompt is not', () => {
  const prompt = 'If you run out of breath, use a little less air on the next phrase.';
  assert.equal(matchCommand('Um, next phrase please.', { prompt }), 'next');
  assert.equal(matchCommand('Next phrase.', { prompt }), 'next');
  assert.equal(matchCommand(prompt, { prompt }), null);
});

test('one root cause is spoken for the whole group, and unspoken prompt words are left out', () => {
  const frames = Array.from({ length: 30 }, (_, index) => ({ t: index * 0.02, voiced: true }));
  const prompt = 'alpha bravo charlie delta';
  assert.equal(heardPrompt(prompt, { transcript: 'alpha bravo', frames }), 'alpha bravo');
  const partial = classifyUtterance({
    analysis: {
      frames: [
        ...Array.from({ length: 8 }, (_, index) => ({ t: index * 0.02, voiced: true, hz: 190, f2: 1800, fry: 0.8, fryPeak: 0.8, unstable: false, h1h2: 2, tilt: -2, resonance: 0, vtl: 16, centroid: 1800, confidence: 0.8, rms: 0.05 })),
        ...Array.from({ length: 8 }, (_, index) => ({ t: 0.2 + index * 0.02, voiced: true, hz: 110, f2: 1700, fry: 0.9, fryPeak: 0.9, unstable: false, h1h2: 2, tilt: -2, resonance: 0, vtl: 16, centroid: 1700, confidence: 0.8, rms: 0.05 }))
      ],
      snrDb: 18,
      voicedFraction: 0.8,
      tooNoisy: false
    },
    prompt,
    transcript: 'alpha bravo',
    goal: {}
  });
  assert.equal(/charlie|delta/.test(partial.feedback.text), false, partial.feedback.text);
  const grouped = composeFeedback({
    words: [
      { text: 'arriving', flags: [{ issue: 'fry', speak: true }] },
      { text: 'ready', flags: [{ issue: 'fry', speak: true }] },
      { text: 'morning', flags: [{ issue: 'drop', speak: true }] }
    ],
    cursor: 0
  });
  assert.equal(grouped.spoken, true);
  assert.equal(grouped.issue, 'fry');
  assert.match(grouped.text, /^arriving and ready fell into fry\. /);
  assert.equal(grouped.text.split(/[.!?]/).filter(part => part.trim()).length, 2);
});
