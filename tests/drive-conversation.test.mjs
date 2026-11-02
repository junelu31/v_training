import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_PROMPTS } from '../drive-conversation.js';
import { conversationTimings, createCoachSession } from '../drive-coach.js';
import { clipFile, fixedVoiceLines, planSpeech, speechHasClip, voiceKey, COACH_VOICE, PRACTICE_VOICE } from '../drive-voice.js';
import { VOICE_CLIPS } from '../drive-voice-clips.js';
import { planCoachTurn } from '../drive-ui.js';
import { readDriveWrap } from '../client-logic.js';
import { TURN, createTurnDetector } from '../drive-dsp.js';

const has = text => Boolean(VOICE_CLIPS[text.startsWith('~') ? text : voiceKey(text)]);
const goal = { pitch: [160, 210], brightness: [-16, -10] };

function frames(count, extra = {}) {
  return Array.from({ length: count }, (_, index) => ({
    t: index * 0.02,
    rms: 0.08,
    voiced: true,
    unstable: false,
    fry: 0,
    confidence: 0.9,
    hz: 172,
    f1: 450,
    f2: 1900,
    f2Local: 1900,
    f3: 2800,
    vtl: 15,
    tilt: -5,
    brightness: -13.6,
    resonance: -8,
    centroid: 1500,
    h1h2: -5.9,
    breathy: false,
    ...extra
  }));
}

test('the question bank is ready for a later Aurora bake and speaks as fallback until then', () => {
  assert.equal(CONVERSATION_PROMPTS.length, 40);
  const keys = new Set();
  const coach = new Set(fixedVoiceLines(['Hello there'], COACH_VOICE).map(voiceKey));
  const practice = fixedVoiceLines(['Hello there'], PRACTICE_VOICE).map(voiceKey);
  for (const line of CONVERSATION_PROMPTS) {
    assert.equal(/[<>]/.test(line), false, line);
    assert.match(line, /[?.]$/);
    const key = voiceKey(line);
    assert.equal(keys.has(key), false, key);
    keys.add(key);
    assert.equal(coach.has(key), true, line);
    assert.equal(practice.includes(key), false, line);
    assert.equal(clipFile(line).startsWith('voice/'), true);
    const plan = planSpeech(line, speechHasClip(line, has));
    assert.deepEqual(plan, [{ text: line }], `${line} should stay on the fallback voice`);
  }
});

test('a conversation answer is graded like a phrase miss, then the next question is asked', () => {
  const session = createCoachSession({ practice: 'conversation', now: 1_000, id: 'talk' });
  assert.equal(session.status().mode, 'conversation');
  assert.equal(session.prompt(), CONVERSATION_PROMPTS[0]);
  const low = planCoachTurn({
    session,
    turn: { frames: frames(54, { hz: 140, brightness: -18 }), tooNoisy: false },
    heard: '',
    goal,
    at: 2_000
  });
  assert.match(low.feedbackText, /140/);
  assert.match(low.feedbackText, /172/);
  assert.equal(low.follow, CONVERSATION_PROMPTS[1]);
  assert.equal(low.finished, false);
  assert.equal(session.prompt(), CONVERSATION_PROMPTS[1]);
  const clean = planCoachTurn({
    session,
    turn: { frames: [...frames(18, { hz: 165 }), ...frames(18, { hz: 210 }), ...frames(18, { hz: 180 })], tooNoisy: false },
    heard: '',
    goal,
    at: 3_000,
    lastPraise: ''
  });
  assert.equal(clean.feedbackText, '');
  assert.ok(clean.praise);
  assert.equal(clean.follow, CONVERSATION_PROMPTS[2]);
  const entry = session.finalEntry(4_000);
  assert.equal(entry.coach.mode, 'conversation');
  assert.equal(entry.coach.wrap.attempted, 2);
  assert.equal(entry.coach.wrap.achieved, 1);
  assert.match(entry.coach.wrap.notes[0].detail, /140/);
  assert.equal(readDriveWrap(entry).score, '1 of 2 questions on target');
  assert.equal(session.command('free').say, session.prompt());
  assert.equal(session.status().mode, 'conversation');
  assert.equal(session.command('next').say, CONVERSATION_PROMPTS[3]);
});

test('conversation turns wait about two seconds and can run longer than a phrase', () => {
  const phrase = createTurnDetector();
  assert.equal(phrase.stats().bufferCap, 16000 * TURN.maxTurnSec);
  assert.equal(phrase.stats().endSilenceMs, TURN.endSilenceMs);
  const talk = createTurnDetector({ maxTurnSec: 28, endSilenceMs: 2000 });
  assert.equal(talk.stats().bufferCap, 16000 * 28);
  assert.equal(talk.stats().endSilenceMs, 2000);
  assert.ok(conversationTimings(frames(40)).length >= 2);
});
