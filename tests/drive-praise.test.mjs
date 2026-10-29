import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyUtterance, composeFeedback, createCoachSession, misreadWord } from '../drive-coach.js';
import {
  FEEDBACK_LINES,
  PRAISE_LINES,
  feedbackLine,
  praiseLine
} from '../drive-cues.js';
import { shouldCueBreath } from '../drive-breath.js';
import { planSpeech, voiceKey } from '../drive-voice.js';
import { VOICE_CLIPS } from '../drive-voice-clips.js';
import { planCoachTurn } from '../drive-ui.js';

const has = text => Boolean(VOICE_CLIPS[text.startsWith('~') ? text : voiceKey(text)]);
const goal = { pitch: [160, 210], brightness: [-16, -10] };

function wordsIn(line) {
  return String(line || '').replace(/[^A-Za-z0-9']+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function covered(line) {
  const plan = planSpeech(line, has);
  return plan.length > 0 && plan.every(part => part.clip);
}

function tone({ hz = 180, f2 = 1900, rms = 0.08, count = 10, gap = 4 } = {}) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      t: 0, rms, voiced: true, hz, f2, f1: 450, f3: 2800,
      vtl: 15, tilt: -5, resonance: -8, centroid: 1500,
      h1h2: 4, fry: 0, confidence: 0.9, unstable: false, brightness: -12
    });
  }
  for (let i = 0; i < gap; i++) frames.push({ t: 0, rms: 0.001, voiced: false, hz: NaN, fry: 0, unstable: false, confidence: 0 });
  return frames;
}

function phrase(words, options = {}) {
  const pieces = words.map((text, index) => tone({ ...options, hz: options.hzs?.[index] ?? options.hz ?? 180 }));
  const frames = pieces.flat();
  frames.forEach((frame, index) => { frame.t = index * 0.02; });
  let cursor = 0;
  const timings = words.map((text, index) => {
    const startIndex = cursor;
    const endIndex = cursor + pieces[index].length;
    cursor = endIndex;
    return { text, startIndex, endIndex };
  });
  return { frames, timings, snrDb: 20, voicedFraction: 0.7, tooNoisy: false };
}

test('praise is a short rotated line, and the baked ones stay on Aurora clips', () => {
  assert.ok(PRAISE_LINES.length >= 8);
  const seen = new Set();
  for (const line of PRAISE_LINES) {
    const count = wordsIn(line).length;
    assert.ok(count >= 1 && count <= 4, line);
    assert.equal(/[<>]/.test(line), false, line);
    assert.equal(seen.has(line), false, line);
    seen.add(line);
  }
  let previous = '';
  for (let cursor = 0; cursor < PRAISE_LINES.length * 2; cursor++) {
    const line = praiseLine(cursor, previous);
    assert.notEqual(line, previous);
    assert.ok(PRAISE_LINES.includes(line));
    previous = line;
  }
  for (const line of ['Nice.', 'Good.', 'Nice one.', 'Good one.', 'That is nice.', 'That is good.', 'Nothing to fix there.', 'That held.', 'Easy.', 'Nice and easy.']) {
    assert.equal(covered(line), true, line);
  }
  for (const line of ["That's it.", 'Beautiful resonance.']) {
    assert.equal(covered(line), false, line);
  }
  for (const line of PRAISE_LINES) {
    assert.equal(shouldCueBreath(line, 'Mia is here early.', true), false, line);
  }
});

test('a miss names the failed dimension, rotates, and reuses a clip when one exists', () => {
  for (const [issue, lines] of Object.entries(FEEDBACK_LINES)) {
    assert.ok(lines.length >= 3, issue);
    for (const line of lines) assert.equal(/[<>]/.test(line), false, line);
  }
  const clipBacked = {
    drop: 'morning dropped.',
    low: 'morning sat low in pitch.',
    chesty: 'morning went chesty.',
    dark: 'morning sounded too big in the throat.',
    heavy: 'morning went heavy.',
    fry: 'morning fell into fry.',
    strain: 'morning sounded pressed.',
    breath: 'morning went breathy.',
    fast: 'Slow on morning.'
  };
  for (const line of Object.values(clipBacked)) assert.equal(covered(line), true, line);
  for (const line of [
    'Lift the end of "morning".',
    'Pitch up on "morning".',
    'Higher on "morning".',
    'Brighter on "morning".',
    'More forward on "morning".',
    'Smaller on "morning".',
    'Lighter on "morning".',
    'Clear the end of "morning".',
    'Keep air through "morning".',
    'Softer on "morning".',
    'Less air on "morning".',
    'Clearer on "morning".',
    'Shape "morning".',
    'More melody on "morning".',
    'Not so flat on "morning".',
    'Louder on "morning".',
    'A little louder on "morning".',
    'morning was quiet.',
    'Not so fast on "morning".',
    'morning went fast.',
    'Ease down on "morning".',
    'Not so high on "morning".',
    'Too high on "morning".',
    'Try "morning" again.',
    '"morning" did not land.',
    'Say "morning" once more.'
  ]) assert.equal(covered(line), false, line);

  let previous = '';
  for (const issue of Object.keys(FEEDBACK_LINES)) {
    const first = feedbackLine(issue, 'morning', 0, previous);
    const second = feedbackLine(issue, 'morning', 0, first);
    assert.notEqual(first, second, issue);
    assert.match(first, /morning/i, issue);
    assert.ok(wordsIn(first).length <= 8, first);
    previous = second;
  }
  const named = composeFeedback({
    words: [{ text: 'morning', flags: [{ issue: 'chesty', speak: true }] }],
    cursor: 1
  });
  assert.equal(named.text, 'Brighter on "morning".');
  assert.equal(named.spoken, true);
});

test('a clean take praises before the next phrase, and a miss does not', () => {
  const analysis = phrase(['good', 'morning']);
  const turn = { ...analysis, sampleRate: 16000, samples: new Float32Array(800), hopVoicedMs: 800 };
  const session = createCoachSession({ lines: ['good morning', 'See you then.'], now: 0 });
  const plan = planCoachTurn({ session, turn, heard: 'good morning', goal, at: 1000 });
  assert.equal(plan.type, 'practice');
  assert.equal(plan.feedbackText, '');
  assert.ok(PRAISE_LINES.includes(plan.praise), plan.praise);
  assert.equal(plan.follow, 'See you then.');
  assert.notEqual(plan.praise, plan.follow);
  const second = planCoachTurn({
    session,
    turn,
    heard: 'good morning',
    goal,
    at: 2000,
    lastPraise: plan.praise
  });
  assert.notEqual(second.praise, plan.praise);

  const missed = planCoachTurn({
    session: createCoachSession({ lines: ['good morning', 'See you then.'], now: 0 }),
    turn,
    heard: 'good mourning',
    goal,
    at: 1000
  });
  assert.equal(missed.praise || '', '');
  assert.match(missed.feedbackText, /morning/i);

  const source = readFileSync(new URL('../drive-ui.js', import.meta.url), 'utf8');
  const judge = source.slice(source.indexOf('async function judgeTurn'), source.indexOf('function pushCaptured'));
  const praiseAt = judge.indexOf('if (plan.praise)');
  const followAt = judge.indexOf('if (plan.follow &&');
  assert.ok(praiseAt > -1 && followAt > praiseAt);
});

test('pitch, resonance, pace, level, and a swapped word each get their own line', () => {
  const highTake = phrase(['morning'], { hz: 260 });
  const high = classifyUtterance({
    analysis: highTake,
    prompt: 'morning',
    transcript: 'morning',
    goal,
    timings: highTake.timings
  });
  assert.equal(high.feedback.issue, 'high');
  assert.match(high.feedback.text, /morning/i);
  assert.match(high.feedback.text, /high|down/i);

  const flatTake = phrase(['one', 'two', 'three', 'four']);
  const flat = classifyUtterance({
    analysis: flatTake,
    prompt: 'one two three four',
    transcript: 'one two three four',
    goal,
    timings: flatTake.timings
  });
  assert.equal(flat.feedback.issue, 'flat');
  assert.match(flat.feedback.text, /one|two|three|four/);

  const quietTake = phrase(['morning', 'light'], { rms: 0.008 });
  const quiet = classifyUtterance({
    analysis: quietTake,
    prompt: 'morning light',
    transcript: 'morning light',
    goal,
    timings: quietTake.timings
  });
  assert.equal(quiet.feedback.issue, 'quiet');
  assert.match(quiet.feedback.text, /morning|light|loud|quiet/i);

  const fastTake = phrase(['one', 'two', 'three', 'four'], { hzs: [170, 185, 200, 220], count: 3, gap: 1 });
  const fast = classifyUtterance({
    analysis: fastTake,
    prompt: 'one two three four',
    transcript: 'one two three four',
    goal,
    timings: fastTake.timings
  });
  assert.equal(fast.feedback.issue, 'fast');
  assert.match(fast.feedback.text, /slow|fast/i);

  assert.equal(misreadWord('good morning', 'good morning'), '');
  assert.equal(misreadWord('good morning friend', 'good morning'), '');
  assert.equal(misreadWord('good morning', 'good mourning'), 'morning');
  const swapped = classifyUtterance({
    analysis: phrase(['good', 'morning']),
    prompt: 'good morning',
    transcript: 'good mourning',
    goal
  });
  assert.equal(swapped.feedback.issue, 'misread');
  assert.match(swapped.feedback.text, /morning/);
});
