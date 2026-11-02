import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_NOISY_LINE, CONVERSATION_PROMPTS } from '../drive-conversation.js';
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

test('a noisy conversation take is spoken, and the next question comes by the second try', () => {
  const session = createCoachSession({ practice: 'conversation', now: 1_000, id: 'noise' });
  const turn = { tooNoisy: true, reason: 'noise', sampleRate: 16000, samples: new Float32Array(0), hopVoicedMs: 800, frames: [] };
  const first = planCoachTurn({ session, turn, heard: '', at: 2_000 });
  assert.notEqual(first.type, 'ignored');
  assert.equal(first.feedbackText, CONVERSATION_NOISY_LINE);
  assert.equal(first.follow, CONVERSATION_PROMPTS[0]);
  assert.equal(session.prompt(), CONVERSATION_PROMPTS[0]);
  const second = planCoachTurn({ session, turn, heard: '', at: 3_000 });
  assert.notEqual(second.type, 'ignored');
  assert.equal(second.feedbackText, CONVERSATION_NOISY_LINE);
  assert.equal(second.follow, CONVERSATION_PROMPTS[1]);
  assert.equal(session.prompt(), CONVERSATION_PROMPTS[1]);
  const third = planCoachTurn({ session, turn, heard: '', at: 4_000 });
  assert.equal(third.feedbackText, CONVERSATION_NOISY_LINE);
  assert.equal(third.follow, CONVERSATION_PROMPTS[1]);
  const fourth = planCoachTurn({ session, turn, heard: '', at: 5_000 });
  assert.equal(fourth.feedbackText, CONVERSATION_NOISY_LINE);
  assert.equal(fourth.follow, CONVERSATION_PROMPTS[2]);
  const plan = planSpeech(CONVERSATION_NOISY_LINE, speechHasClip(CONVERSATION_NOISY_LINE, has));
  assert.deepEqual(plan, [{ text: CONVERSATION_NOISY_LINE }]);
});

test('a conversation answer with no transcript does not file the placeholder word', () => {
  const session = createCoachSession({ practice: 'conversation', now: 1_000, id: 'plain' });
  const flagged = (text, at) => session.noteAnalysis({
    tooNoisy: false,
    words: [{ text, flags: [{ issue: 'low', speak: true }], hz: 140, brightness: -18, voiced: 8 }],
    feedback: { spoken: true, text: 'Pitch was low.', issue: 'low', detail: 'Pitch was about 140 hertz, Aurora sits near 172.', delta: '140 Hz vs 172 Hz' },
    profile: { label: 'androgynous' }
  }, { transcript: text === 'that' ? '' : text, at });
  flagged('that', 2_000);
  assert.equal(session.wrapUp().problems.some(row => row.word === 'that'), false);
  planCoachTurn({
    session,
    turn: { frames: frames(54, { hz: 140, brightness: -18 }), tooNoisy: false },
    heard: '',
    goal,
    at: 3_000
  });
  assert.equal(session.wrapUp().problems.some(row => row.word === 'that'), false);
  flagged('morning', 4_000);
  assert.equal(session.wrapUp().problems.some(row => row.word === 'morning'), true);
  assert.equal(session.wrapUp().problems.some(row => row.word === 'that'), false);
});

test('a conversation stretch keeps a spoken reply across many turns', () => {
  const session = createCoachSession({ practice: 'conversation', now: 1_000, id: 'soak' });
  const low = { frames: frames(54, { hz: 140, brightness: -18 }), tooNoisy: false };
  const noise = { tooNoisy: true, reason: 'noise', sampleRate: 16000, samples: new Float32Array(0), hopVoicedMs: 800, frames: [] };
  for (let index = 0; index < 30; index++) {
    const plan = planCoachTurn({ session, turn: low, heard: '', goal, at: 2_000 + index * 1000 });
    assert.equal(plan.type, 'practice');
    assert.equal(plan.finished, false);
    assert.equal(plan.follow, CONVERSATION_PROMPTS[(index + 1) % CONVERSATION_PROMPTS.length]);
  }
  assert.equal(session.status().phrases, 24);
  assert.equal(session.wrapUp().attempted, 30);
  assert.equal(session.wrapUp().problems.some(row => row.word === 'that'), false);
  const at = 40_000;
  for (let index = 0; index < 6; index++) {
    const plan = planCoachTurn({ session, turn: noise, heard: '', at: at + index * 1000 });
    assert.notEqual(plan.type, 'ignored');
    assert.equal(plan.feedbackText, CONVERSATION_NOISY_LINE);
    assert.ok(plan.follow);
  }
  assert.equal(session.prompt(), CONVERSATION_PROMPTS[(30 + 3) % CONVERSATION_PROMPTS.length]);
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
