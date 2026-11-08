import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONVERSATION_PROMPTS } from '../drive-conversation.js';
import { createCoachSession, shouldLeavePhrase, MAX_PHRASE_ATTEMPTS } from '../drive-coach.js';
import {
  JAPANESE_FAMILIES,
  JAPANESE_MEASURE_LABEL,
  JAPANESE_VOICE_MISSING,
  containsJapaneseScript,
  expectedJapaneseVoicedMs,
  japaneseLines,
  japaneseMeaning,
  japanesePlace,
  japaneseRepeatMatch,
  pickJapaneseVoice
} from '../drive-japanese.js';
import { planCoachTurn } from '../drive-ui.js';
import { readDriveWrap } from '../client-logic.js';
import { planSpeech } from '../drive-voice.js';

const goal = { pitch: [160, 210], brightness: [-16, -10] };
const lines = japaneseLines();

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

function variedPitch() {
  return [...frames(18, { hz: 165 }), ...frames(18, { hz: 210 }), ...frames(18, { hz: 180 })];
}

test('the Japanese bank is sentence families, not a word list', () => {
  assert.ok(JAPANESE_FAMILIES.length >= 15 && JAPANESE_FAMILIES.length <= 20);
  assert.ok(lines.length >= 90 && lines.length <= 160);
  assert.equal(new Set(lines).size, lines.length);
  const polite = /(?:です|ます|した|せん|か)。$/;
  let cursor = 0;
  for (const family of JAPANESE_FAMILIES) {
    assert.ok(family.items.length >= 6 && family.items.length <= 8, family.id);
    const blob = family.items.map(item => item.jp).join('\n');
    assert.match(blob, /ました|でした|かったです|いました/, family.id);
    assert.match(blob, /ません|くない|ではありません|ないです|いません/, family.id);
    assert.match(blob, /か。/, family.id);
    for (const item of family.items) {
      assert.deepEqual(Object.keys(item).sort(), ['en', 'jp']);
      assert.equal(item.jp.includes('<') || item.jp.includes('>'), false, item.jp);
      assert.equal(item.en.includes('<') || item.en.includes('>'), false, item.en);
      assert.equal(/[A-Za-z]/.test(item.jp), false, item.jp);
      assert.equal(containsJapaneseScript(item.jp), true, item.jp);
      assert.match(item.jp, polite, item.jp);
      assert.match(item.en, /^[A-Z].*[.!?]$/, item.en);
      assert.equal(/\bmeans\b| = |particle|を marks|furigana|romaji/i.test(item.en), false, item.en);
      assert.equal(japaneseMeaning(item.jp), item.en);
      assert.equal(lines[cursor], item.jp);
      cursor += 1;
    }
  }
  assert.equal(cursor, lines.length);
  assert.equal(japanesePlace(0).family, 1);
  assert.equal(japanesePlace(0).variation, 1);
  assert.equal(japanesePlace(JAPANESE_FAMILIES[0].items.length).family, 2);
  assert.equal(japaneseMeaning('水'), '');
  assert.ok(expectedJapaneseVoicedMs(lines[0]) >= 800);
  assert.equal(expectedJapaneseVoicedMs(''), 0);
});

test('a repeat matches the whole sentence and ignores an English gloss', () => {
  const sentence = '水を飲みます。';
  assert.equal(japaneseRepeatMatch(sentence, sentence), 'match');
  assert.equal(japaneseRepeatMatch(sentence, '水を飲みます'), 'match');
  assert.equal(japaneseRepeatMatch(sentence, 'お茶を飲みます。'), 'mismatch');
  assert.equal(japaneseRepeatMatch(sentence, 'I drink water.'), 'mismatch');
  assert.equal(japaneseRepeatMatch(sentence, 'mizu o nomimasu'), 'mismatch');
  assert.equal(japaneseRepeatMatch(sentence, ''), 'unknown');
  assert.equal(japaneseRepeatMatch(sentence, '   '), 'unknown');
});

test('Japanese speech picks a feminine ja-JP voice and never a known male one', () => {
  const kyoko = { lang: 'ja-JP', name: 'Kyoko', default: false };
  const otoya = { lang: 'ja-JP', name: 'Otoya', default: true };
  const google = { lang: 'ja-JP', name: 'Google 日本語', default: false };
  assert.equal(pickJapaneseVoice([otoya, kyoko, { lang: 'en-US', name: 'Samantha' }]), kyoko);
  assert.equal(pickJapaneseVoice([otoya]), null);
  assert.equal(pickJapaneseVoice([google, { lang: 'en-US', name: 'Samantha' }]), google);
  assert.equal(pickJapaneseVoice([]), null);
  assert.equal(pickJapaneseVoice(null), null);
  assert.match(JAPANESE_VOICE_MISSING, /Japanese/);
  assert.equal(/means|romaji/i.test(JAPANESE_VOICE_MISSING), false);
});

test('Japanese mode drills one family before the next and saves coach.mode', () => {
  const session = createCoachSession({ practice: 'japanese', lines, now: 1_000, id: 'ja' });
  assert.equal(session.status().mode, 'japanese');
  assert.equal(session.prompt(), lines[0]);
  assert.equal(CONVERSATION_PROMPTS.includes(session.prompt()), false);
  const familySize = JAPANESE_FAMILIES[0].items.length;
  for (let index = 0; index < familySize - 1; index += 1) session.advance();
  assert.equal(session.prompt(), lines[familySize - 1]);
  assert.equal(japanesePlace(session.status().lineIndex).family, 1);
  session.advance();
  assert.equal(japanesePlace(session.status().lineIndex).family, 2);
  assert.equal(session.prompt(), JAPANESE_FAMILIES[1].items[0].jp);
  assert.equal(session.command('free', 2_000).say, session.prompt());
  assert.equal(session.status().mode, 'japanese');
  assert.equal(session.command('lines', 2_100).say, session.prompt());
  assert.equal(session.status().mode, 'japanese');
  const stopped = session.command('stop', 30_000);
  assert.equal(stopped.entry.coach.mode, 'japanese');
  assert.equal(stopped.entry.coach.wrap.total, lines.length);
  assert.equal(readDriveWrap(stopped.entry).score, 'No phrases yet');
  const phrases = createCoachSession({ lines: ['Good morning.'], now: 1_000, id: 'en' });
  assert.equal(phrases.status().mode, 'lines');
  assert.equal(phrases.prompt(), 'Good morning.');
  const talk = createCoachSession({ practice: 'conversation', now: 1_000, id: 'talk' });
  assert.equal(talk.prompt(), CONVERSATION_PROMPTS[0]);
  assert.equal(containsJapaneseScript(talk.prompt()), false);
});

test('a Japanese take is coached like a phrase, then the same family continues', () => {
  const session = createCoachSession({ practice: 'japanese', lines, now: 1_000, id: 'grade' });
  const low = planCoachTurn({
    session,
    turn: { frames: frames(54, { hz: 140, brightness: -18 }), tooNoisy: false, hopVoicedMs: 900 },
    heard: lines[0],
    goal,
    at: 2_000
  });
  assert.match(low.feedbackText, /140/);
  assert.match(low.feedbackText, /172/);
  assert.match(low.feedbackText, /the phrase/);
  assert.equal(/\bmeans\b|I drink water|water\b/i.test(low.feedbackText), false);
  assert.equal(low.follow, lines[0]);
  assert.equal(session.prompt(), lines[0]);
  assert.equal(low.finished, false);
  const clean = planCoachTurn({
    session,
    turn: { frames: variedPitch(), tooNoisy: false, hopVoicedMs: 900 },
    heard: lines[0],
    goal,
    at: 3_000
  });
  assert.equal(clean.feedbackText, '');
  assert.ok(clean.praise);
  assert.equal(clean.follow, lines[1]);
  assert.equal(session.prompt(), lines[1]);
  const again = createCoachSession({ practice: 'japanese', lines, now: 4_000, id: 'miss' });
  const missed = planCoachTurn({
    session: again,
    turn: { frames: variedPitch(), tooNoisy: false, hopVoicedMs: 900 },
    heard: '駅に行きます。',
    goal,
    at: 5_000
  });
  assert.equal(missed.praise, '');
  assert.equal(missed.follow, lines[0]);
  assert.equal(again.prompt(), lines[0]);
  assert.equal(missed.heardLine, 'Heard you.');
  const quiet = createCoachSession({ practice: 'japanese', lines, now: 6_000, id: 'quiet' });
  const unheard = planCoachTurn({
    session: quiet,
    turn: { frames: variedPitch(), tooNoisy: false, hopVoicedMs: 900 },
    heard: '',
    goal,
    at: 7_000
  });
  assert.ok(unheard.praise);
  assert.equal(unheard.follow, lines[1]);
  const capped = createCoachSession({ practice: 'japanese', lines, now: 8_000, id: 'cap' });
  for (let attempt = 0; attempt < MAX_PHRASE_ATTEMPTS - 1; attempt += 1) {
    const stay = planCoachTurn({
      session: capped,
      turn: { frames: frames(54, { hz: 140, brightness: -18 }), tooNoisy: false, hopVoicedMs: 900 },
      heard: lines[0],
      goal,
      at: 9_000 + attempt
    });
    assert.equal(stay.follow, lines[0]);
    assert.equal(capped.prompt(), lines[0]);
  }
  assert.equal(shouldLeavePhrase({ passed: false, attempts: 2, mode: 'japanese' }), false);
  assert.equal(shouldLeavePhrase({ passed: false, attempts: 3, mode: 'japanese' }), true);
  assert.equal(shouldLeavePhrase({ passed: true, attempts: 1, mode: 'lines' }), true);
  assert.equal(shouldLeavePhrase({ passed: false, attempts: 3, mode: 'free' }), false);
  const third = planCoachTurn({
    session: capped,
    turn: { frames: frames(54, { hz: 140, brightness: -18 }), tooNoisy: false, hopVoicedMs: 900 },
    heard: lines[0],
    goal,
    at: 12_000
  });
  assert.equal(third.follow, lines[1]);
  assert.equal(capped.prompt(), lines[1]);
  const entry = session.finalEntry(40_000);
  assert.equal(entry.coach.mode, 'japanese');
  assert.equal(entry.coach.phrases[0].prompt, lines[0]);
  assert.match(entry.coach.wrap.notes[0].phrase, /水を飲みます/);
  assert.equal(/\bmeans\b|I drink water/.test(entry.coach.wrap.notes[0].detail), false);
  assert.equal(entry.coach.wrap.notes[0].phrase.length <= 120, true);
  const plan = planSpeech(lines[0], () => false);
  assert.deepEqual(plan, [{ text: lines[0] }]);
  assert.equal(JAPANESE_MEASURE_LABEL, 'the phrase');
});

test('Japanese mode is a third setup choice and does not speak Japanese with an English voice', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../drive-ui.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  const voice = readFileSync(new URL('../drive-voice.js', import.meta.url), 'utf8');
  assert.match(html, /data-drive-mode="phrases"[^>]*aria-pressed="true"/);
  assert.match(html, /data-drive-mode="conversation"/);
  assert.match(html, /data-drive-mode="japanese"/);
  assert.match(html, /id="coachMeaning"/);
  assert.match(ui, /let practiceMode = 'phrases'/);
  assert.match(ui, /picked === 'japanese' \? 'japanese' : 'phrases'/);
  assert.match(ui, /japanese \? japaneseLines\(\)/);
  const spoken = ui.slice(ui.indexOf('async function finishJapaneseSpeech'), ui.indexOf('async function finishSpeech'));
  assert.equal(spoken.includes('cloudSpeech'), false);
  assert.equal(spoken.includes('en-US'), false);
  assert.equal(spoken.includes('xai'), false);
  assert.match(spoken, /pickJapaneseVoice/);
  assert.match(spoken, /playBreathOnly/);
  assert.match(ui, /containsJapaneseScript\(text\)\) return null/);
  assert.equal(voice.includes('drive-japanese'), false);
  assert.match(worker, /'japanese'/);
  assert.match(worker, /language = 'multi'/);
  assert.match(worker, /language: japanese \? 'ja' : 'en'/);
  assert.match(worker, /containsJapaneseScript\(say\)\) return null/);
  assert.equal(worker.includes('api.x.ai'), false);
});
