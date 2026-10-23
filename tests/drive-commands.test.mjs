import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCoachSession, matchCommand, matchVoiceRequest } from '../drive-coach.js';
import { COACH_VOICE, PRACTICE_VOICE } from '../drive-voice.js';
import { planCoachTurn } from '../drive-ui.js';
import { SESSION_LINES } from '../drive-session.js';

const lines = ['Who is arriving? We are ready whenever you are.', 'Mia is here early.'];
const hum = 'Hum the next word, and bring the pitch up a little.';
const pauseLine = 'I\u2019m going to pause, reset, and say that again more easily.';
const nextLine = 'If you run out of breath, use a little less air on the next phrase.';
const stopLine = 'Say line 3 once when you are ready to stop.';

function expectCommand(text, name, options = {}) {
  assert.equal(matchCommand(text, options), name, text);
}

test('natural next phrasings advance, including filler, punctuation, and casing', () => {
  const nexts = [
    'next', 'skip', 'next phrase', 'next one', 'skip this', 'okay next', 'next please',
    'Next phrase.', 'NEXT PHRASE', 'Next phrase!', 'um, next phrase', 'Um, next phrase, please.',
    'okay, next', 'ok next', 'hey coach, next phrase', 'coach next', 'please next',
    'can you do the next one', 'could you skip this', 'go to the next phrase', 'skip the line',
    "let's do the next phrase", 'give me the next one', 'move on'
  ];
  for (const text of nexts) expectCommand(text, 'next', { prompt: hum });
  const session = createCoachSession({ lines, now: 0 });
  assert.equal(session.hear('next phrase').type, 'next');
  assert.equal(session.prompt(), lines[1]);
  assert.equal(session.hear('Next.').type, 'next');
  assert.equal(session.prompt(), lines[0]);
});

test('repeat, pause, stop, summary, free, and lines accept the way someone would say them', () => {
  const groups = {
    repeat: ['again', 'repeat', 'say it again', 'repeat that', 'one more time', 'say that again', 'Once more.', 'um, say it again please', 'can you repeat that'],
    pause: ['pause', 'pause the coach', 'hold on', 'Okay, pause.', 'please pause the coach', 'wait a second'],
    stop: ['stop', 'finish', 'done', "I'm done", 'I am done', 'stop the coach', "I'm done.", "that's enough", 'um I\u2019m finished please'],
    summary: ['how am I doing', 'how am I doing?', 'How am I doing?', 'how am i doing so far', "how's it going", 'okay, how am I doing'],
    free: ['free talk', 'free', "let's just talk", 'just talk', 'hey coach, free talk please'],
    lines: ['lines', 'prompts', 'back to lines', 'back to the prompts', 'Okay, back to lines.']
  };
  for (const [name, phrases] of Object.entries(groups)) {
    for (const text of phrases) expectCommand(text, name, { prompt: lines[0] });
  }
  expectCommand('resume', 'resume', { paused: true, prompt: lines[0] });
  expectCommand('start', 'resume', { paused: true });
  expectCommand("I'm ready", 'resume', { paused: true });
  expectCommand('okay, keep going', 'resume', { paused: true });
  expectCommand('start', null);
  expectCommand('continue', null);
  expectCommand('ready', null);
});

test('a practice sentence that merely contains a command word is not a command', () => {
  const rejected = [
    [hum, hum],
    [nextLine, nextLine],
    [pauseLine, pauseLine],
    [stopLine, stopLine],
    ['The next stop is coming up, so do not stop early.', 'The next stop is coming up, so do not stop early.'],
    ['I need to stop by the store and then say the next line of the story.', lines[0]],
    ['Please start the car when the light changes.', lines[0]],
    ['We are ready whenever you are.', lines[0]],
    ['Say that word once more, and keep the end of the word up.', lines[0]],
    ['the next train', hum],
    ['next stop', hum],
    ['stop there', stopLine],
    ['one more line', lines[0]],
    ['I will stop after this sentence about the next meeting.', nextLine],
    ['', hum],
    ['...', hum],
    ['please', lines[0]],
    ['coach', lines[0]],
    ['um', lines[0]]
  ];
  for (const [text, prompt] of rejected) assert.equal(matchCommand(text, { prompt }), null, text);
  // The same words as a real command still work while that prompt is on screen.
  expectCommand('next phrase', 'next', { prompt: nextLine });
  expectCommand('Next phrase.', 'next', { prompt: hum });
  expectCommand('pause the coach', 'pause', { prompt: pauseLine });
  expectCommand('say it again', 'repeat', { prompt: pauseLine });
  expectCommand('stop the coach', 'stop', { prompt: stopLine });
  const session = createCoachSession({ lines: [hum, lines[1]], now: 0 });
  assert.equal(session.hear(hum).type, 'speech');
  assert.equal(session.prompt(), hum);
});

test('a command skips phrase feedback and only speaks its short reply', () => {
  const session = createCoachSession({ lines, now: 0 });
  const turn = { tooNoisy: true, reason: 'noise', sampleRate: 16000, samples: new Float32Array(0), hopVoicedMs: 800 };
  const plan = planCoachTurn({ session, turn, heard: 'Um, next phrase please.', at: 1000 });
  assert.equal(plan.type, 'command');
  assert.equal(plan.command, 'next');
  assert.equal(plan.feedbackText, '');
  assert.deepEqual(plan.extra, []);
  assert.equal(plan.follow, '');
  assert.equal(plan.heardLine, 'Heard you.');
  assert.equal(plan.say, `Next. ${lines[1]}`);
  assert.equal(session.prompt(), lines[1]);
  assert.equal(session.status().phraseCount, 0);
  assert.equal([plan.feedbackText, plan.say, plan.follow].some(line => line.includes(SESSION_LINES['too-noisy'])), false);

  const repeat = createCoachSession({ lines, now: 0 });
  const again = planCoachTurn({ session: repeat, turn, heard: 'say it again', at: 1000 });
  assert.equal(again.command, 'repeat');
  assert.equal(again.feedbackText, '');
  assert.equal(again.say, `Again. ${lines[0]}`);
  assert.equal(repeat.prompt(), lines[0]);

  const stopping = createCoachSession({ lines, now: 0 });
  const done = planCoachTurn({ session: stopping, turn, heard: "I'm done", at: 5000 });
  assert.equal(done.command, 'stop');
  assert.equal(done.say, 'Stopping. I saved this drive.');
  assert.equal(stopping.status().paused, true);
  assert.equal(stopping.status().stopped, true);
});

test('practice voice and main voice switch the coach and leave the line alone', () => {
  assert.equal(matchVoiceRequest('main voice'), COACH_VOICE);
  assert.equal(matchVoiceRequest('Main voice.'), COACH_VOICE);
  assert.equal(matchVoiceRequest('okay, back to aurora'), COACH_VOICE);
  assert.equal(matchVoiceRequest('practice voice'), PRACTICE_VOICE);
  assert.equal(matchVoiceRequest('easier voice please'), PRACTICE_VOICE);
  assert.equal(matchVoiceRequest('I need the main voice later today', { prompt: lines[0] }), null);
  assert.equal(matchCommand('main voice'), null);
  const session = createCoachSession({ lines, now: 0 });
  const turn = { tooNoisy: false, sampleRate: 16000, samples: new Float32Array(1600), hopVoicedMs: 800, frames: [] };
  const plan = planCoachTurn({ session, turn, heard: 'main voice', at: 1000, voice: PRACTICE_VOICE });
  assert.equal(plan.type, 'voice');
  assert.equal(plan.voice, COACH_VOICE);
  assert.match(plan.say, /^Back to Aurora\./);
  assert.equal(plan.feedbackText, '');
  assert.equal(session.prompt(), lines[0]);
  assert.equal(session.status().phraseCount, 0);
});

test('a failed transcript coaches the take and does not invent a command', () => {
  const session = createCoachSession({ lines, now: 0 });
  const turn = { tooNoisy: true, reason: 'noise', sampleRate: 16000, samples: new Float32Array(0), hopVoicedMs: 800 };
  const plan = planCoachTurn({ session, turn, heard: '', at: 1000 });
  assert.equal(plan.type, 'practice');
  assert.equal(plan.say, '');
  assert.match(plan.feedbackText, /too noisy/);
  assert.equal(session.prompt(), lines[0]);
  assert.equal(session.status().phraseCount, 1);
});

test('reading the prompt aloud is coached instead of taken as a command', () => {
  const session = createCoachSession({ lines: [hum, lines[1]], now: 0 });
  const turn = { tooNoisy: true, reason: 'noise', sampleRate: 16000, samples: new Float32Array(0), hopVoicedMs: 800 };
  const plan = planCoachTurn({ session, turn, heard: hum, at: 1000 });
  assert.equal(plan.type, 'practice');
  assert.equal(plan.feedbackText.includes('Next.'), false);
  assert.equal(session.prompt(), hum);
});

test('phrase feedback is not spoken until the transcript shows it is not a command', () => {
  const source = readFileSync(new URL('../drive-ui.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function judgeTurn');
  const end = source.indexOf('function pushCaptured');
  const fn = source.slice(start, end);
  const cloudAt = fn.indexOf('await cloudTurn');
  const speakAt = fn.indexOf('speak(');
  const sayAt = fn.indexOf('say(');
  assert.ok(cloudAt > 0 && speakAt > cloudAt && sayAt > cloudAt);
});
