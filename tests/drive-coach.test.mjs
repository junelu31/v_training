import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzePcm, createTurnDetector, detectTurns, makeRoadNoise, mixAtSnr, synthesizeWords } from '../drive-dsp.js';
import { classifyUtterance, composeFeedback, confusion, createCoachSession, joinIssueWords, matchCommand, profilePhrase, scoreFlags } from '../drive-coach.js';
import { CUE_LIBRARY, PRACTICE_CUE_LIBRARY, cueLine } from '../drive-cues.js';
import { COACH_VOICE, DRIVE_VOICES, PRACTICE_VOICE, readDriveVoice, writeDriveVoice } from '../drive-voice.js';
import { PRACTICE_SESSION_LINES, sessionLine } from '../drive-session.js';

const goal = { pitch: [175, 225], brightness: [-8, -4] };

function frames({ hz, f2, vtl, tilt, resonance, count = 8 }) {
  return Array.from({ length: count }, () => ({ voiced: true, hz, f2, vtl, tilt, resonance, centroid: 1200, fry: 0, unstable: false }));
}

test('cue library rotates physical lines and stays free of markup', () => {
  for (const [issue, entry] of Object.entries(CUE_LIBRARY)) {
    assert.ok(entry.variants.length >= 2, issue);
    for (const line of entry.variants) assert.equal(/[<>]/.test(line), false, line);
  }
  assert.match(cueLine('chesty', 0), /tongue more forward/);
  assert.match(cueLine('dark', 0), /larynx/);
  assert.match(cueLine('heavy', 0), /light sigh/);
  assert.match(cueLine('heavy', 1), /gentle hm/);
  assert.match(cueLine('drop', 0), /end of the word/);
  assert.match(cueLine('fry', 0), /air flowing/);
  assert.match(cueLine('strain', 0), /light hum/);
  assert.notEqual(cueLine('drop', 0), cueLine('drop', 1));
});

test('the practice voice has its own physical cues', () => {
  const physical = /tongue|larynx|pitch|air|hum|sigh|lips|chest|jaw|push/;
  const banned = /feminine|woman|girl|lady|\bRiver\b|gender/i;
  for (const issue of ['drop', 'chesty', 'dark', 'heavy', 'fry', 'low', 'breath', 'strain']) {
    const practice = PRACTICE_CUE_LIBRARY[issue].variants;
    const river = new Set(CUE_LIBRARY[issue].variants);
    assert.ok(practice.length >= 2, issue);
    for (const line of practice) {
      assert.equal(river.has(line), false, line);
      assert.equal(banned.test(line), false, line);
      assert.equal(/[<>]/.test(line), false, line);
      assert.match(line, physical, line);
      assert.equal(/\.$/.test(line), true, line);
    }
    assert.equal(cueLine(issue, 0, PRACTICE_VOICE), practice[0]);
    assert.equal(cueLine(issue, 0, COACH_VOICE), CUE_LIBRARY[issue].variants[0]);
  }
  const line = composeFeedback({
    words: [{ text: 'June', flags: [{ issue: 'heavy', speak: true }] }],
    cursor: 0,
    voice: PRACTICE_VOICE
  });
  assert.equal(line.text, `June went heavy. ${cueLine('heavy', 0, PRACTICE_VOICE)}`);
  assert.match(line.text, /thin sigh/);
  assert.equal(sessionLine('pitch-low', PRACTICE_VOICE), PRACTICE_SESSION_LINES['pitch-low']);
  assert.notEqual(sessionLine('pitch-low', PRACTICE_VOICE), sessionLine('pitch-low'));
  const memory = { store: {}, getItem(key) { return this.store[key]; }, setItem(key, value) { this.store[key] = value; } };
  assert.equal(readDriveVoice(memory), COACH_VOICE);
  assert.equal(writeDriveVoice(memory, PRACTICE_VOICE), PRACTICE_VOICE);
  assert.equal(readDriveVoice(memory), PRACTICE_VOICE);
  assert.equal(writeDriveVoice(memory, 'af_sky'), COACH_VOICE);
  assert.match(DRIVE_VOICES[PRACTICE_VOICE].note, /higher and lighter/);
  assert.match(DRIVE_VOICES[COACH_VOICE].note, /voice to land on/);
  for (const voice of Object.values(DRIVE_VOICES)) assert.equal(/[<>]|let's|certainly/i.test(voice.note), false);
});

test('profile uses resonance and weight, so pitch alone loses the swapped voices', () => {
  const lowWoman = profilePhrase({ frames: frames({ hz: 142, f2: 2150, vtl: 14.1, tilt: -4.2, resonance: -4 }) });
  const highMan = profilePhrase({ frames: frames({ hz: 198, f2: 1120, vtl: 17.6, tilt: -11, resonance: -16 }) });
  assert.equal(lowWoman.label, 'feminine');
  assert.equal(lowWoman.pitchOnly, 'masculine');
  assert.equal(highMan.label, 'masculine');
  assert.equal(highMan.pitchOnly, 'feminine');
  const pairs = [
    { actual: 'feminine', predicted: lowWoman.label, id: 'low-f0-woman' },
    { actual: 'masculine', predicted: highMan.label, id: 'high-f0-man' }
  ];
  const matrix = confusion(pairs);
  assert.equal(matrix.accuracy, 1);
  assert.equal(matrix.matrix.feminine.feminine, 1);
  assert.equal(matrix.matrix.masculine.masculine, 1);
  const thin = profilePhrase({ frames: frames({ hz: 180, f2: 1600, vtl: 16, tilt: -6, resonance: -12, count: 3 }) });
  assert.equal(thin.label, 'unsure');
});

function burst(partial, count, gap) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      t: 0, rms: 0.08, voiced: true, hz: partial.hz, f2: partial.f2 ?? 1800, f1: partial.f1 ?? 450, f3: partial.f3 ?? 2800,
      vtl: partial.vtl ?? 14.8, tilt: partial.tilt ?? -5, resonance: partial.resonance ?? -6, centroid: 1500,
      h1h2: partial.h1h2 ?? 4, fry: partial.fry ?? 0, confidence: 0.86, unstable: !!partial.unstable, support: 20
    });
  }
  for (let i = 0; i < gap; i++) frames.push({ t: 0, rms: 0.001, voiced: false, hz: NaN, fry: 0, unstable: false, confidence: 0 });
  frames.forEach((frame, index) => { frame.t = index * 0.02; });
  return frames;
}

test('confident issues are specific and clean words stay quiet', () => {
  const pieces = [
    burst({ hz: 188, f2: 2000, unstable: true }, 8, 4),
    burst({ hz: 198, f2: 1900 }, 8, 4),
    burst({ hz: 196, f2: 1850 }, 8, 4),
    burst({ hz: 130, f2: 1100, tilt: -10, vtl: 15 }, 8, 4),
    burst({ hz: 112, f2: 1700, fry: 0.85 }, 8, 2)
  ];
  const frames = pieces.flat();
  let cursor = 0;
  const timings = ['Hi', 'my', 'name', 'June', 'please'].map((text, index) => {
    const startIndex = cursor;
    const endIndex = cursor + pieces[index].length;
    cursor = endIndex;
    return { text, startIndex, endIndex };
  });
  const result = classifyUtterance({ analysis: { frames, snrDb: 20, voicedFraction: 0.5 }, prompt: 'Hi my name June please', goal, cursor: 0, timings });
  assert.equal(result.tooNoisy, false);
  const flagged = Object.fromEntries(result.words.map(word => [word.text, word.flags.filter(flag => flag.speak).map(flag => flag.issue)]));
  assert.deepEqual(flagged.my, []);
  assert.deepEqual(flagged.name, []);
  assert.ok(flagged.Hi.includes('strain'));
  assert.ok(flagged.June.includes('drop'));
  assert.ok(flagged.June.includes('chesty') || flagged.June.includes('heavy'));
  assert.ok(flagged.please.includes('drop'));
  assert.ok(flagged.please.includes('fry'));
  assert.match(result.feedback.text, /Hi|June|please/);
  assert.ok(result.feedback.text.split(/[.!?]/).filter(part => part.trim()).length <= 2);
  const expected = { Hi: ['strain'], my: [], name: [], June: ['drop', 'chesty', 'heavy'], please: ['drop', 'fry'] };
  const cases = result.words.map(word => ({ expected: expected[word.text] || [], flags: word.flags.filter(flag => flag.speak) }));
  const score = scoreFlags(cases);
  for (const row of score.rows) {
    if (row.tp + row.fp + row.fn === 0) continue;
    if (row.precision != null) assert.ok(row.precision >= 0.5, row.category);
  }
  assert.equal(score.naggedClean, 0);
  const noisy = classifyUtterance({ analysis: { frames, snrDb: 4, voicedFraction: 0.4, tooNoisy: true }, prompt: 'Hi my name June please', goal });
  assert.match(noisy.feedback.text, /too noisy|road/);
  assert.equal(noisy.words.some(word => word.flags.some(flag => flag.speak)), false);
});

test('road noise alone never opens a turn, and a buried phrase is too noisy to name a word', () => {
  assert.equal(detectTurns(makeRoadNoise(12, 16000, 11)).length, 0);
  const speech = synthesizeWords([
    { text: 'please', ms: 420, f0: 150, f0End: 120, f1: 450, f2: 1700, seed: 8, gapMs: 80 }
  ]).samples;
  const noisy = mixAtSnr(speech, makeRoadNoise(speech.length / 16000 + 0.2, 16000, 12), 5);
  const turns = detectTurns(noisy);
  for (const turn of turns) {
    const result = classifyUtterance({ analysis: turn, prompt: 'please', goal });
    if (result.tooNoisy) assert.match(result.feedback.text, /too noisy|road/);
    else assert.equal(result.words.some(word => word.flags.some(flag => flag.speak && !['drop', 'fry', 'heavy', 'chesty', 'strain', 'dark', 'low', 'breath'].includes(flag.issue))), false);
  }
});

test('commands and the in-memory phrase cap, with no comfort or rest nag', () => {
  let now = Date.parse('2026-10-22T12:00:00Z');
  const session = createCoachSession({ plannedMinutes: 40, routineId: 'week-3', lines: ['Hello there', 'One more line'], now, id: 'coach-test' });
  assert.equal(matchCommand('next'), 'next');
  assert.equal(matchCommand('how am I doing?'), 'summary');
  assert.equal(matchCommand('start'), null);
  assert.equal(session.hear('Next.').type, 'next');
  assert.equal(session.prompt(), 'One more line');
  assert.equal(session.hear('pause').type, 'pause');
  assert.equal(session.hear('resume', now).type, 'resume');
  const analysis = { frames: frames({ hz: 190, f2: 1800, vtl: 14.5, tilt: -5, resonance: -6 }), snrDb: 18, voicedFraction: 0.4, tooNoisy: false };
  for (let i = 0; i < 30; i++) {
    now += 1000;
    session.noteAnalysis(classifyUtterance({ analysis, prompt: 'Hello there', goal, cursor: i }), { at: now });
  }
  assert.ok(session.status().phrases <= 24);
  assert.equal(session.comfortReply, undefined);
  const later = createCoachSession({ lines: ['Again'], now, id: 'rest' });
  const rest = later.noteAnalysis(classifyUtterance({ analysis, prompt: 'Again', goal }), { at: now + 21 * 60000 });
  assert.equal(rest.events.some(event => event.type === 'rest' || event.type === 'comfort-check'), false);
  const early = createCoachSession({ lines: ['Again'], now, id: 'comfort' });
  const check = early.noteAnalysis(classifyUtterance({ analysis, prompt: 'Again', goal }), { at: now + 5 * 60000 });
  assert.equal(check.events.some(event => event.type === 'comfort-check' || event.type === 'rest'), false);
  const entry = later.logEntry();
  assert.equal(entry.kind, 'coach');
  assert.equal(entry.comfort, null);
  assert.equal(entry.coach.comfortKnown, undefined);
  assert.equal(entry.coach.restSuggested, undefined);
  assert.ok(entry.actualMinutes >= 20 && entry.actualMinutes <= 22);
  assert.equal(entry.coach.phrases.length <= 30, true);
  const source = readFileSync(new URL('../drive-coach.js', import.meta.url), 'utf8');
  assert.equal(source.includes('Quick comfort check'), false);
  assert.equal(source.includes('You have been at this a while'), false);
});

test('positive reinforcement changes after the same word improves', () => {
  const before = [{ text: 'please', flags: [{ issue: 'drop', speak: true }] }];
  const words = [{ text: 'please', voiced: 4, flags: [] }];
  const line = composeFeedback({ words, cursor: 1, cleared: [{ word: 'please', issue: 'drop' }] });
  assert.match(line.text, /please/i);
  assert.match(line.text, /closer to how I say it|moved toward my voice|held/i);
});

test('the same issue names every heard word, then one cue', () => {
  const words = [
    { text: 'June', flags: [{ issue: 'drop', speak: true }, { issue: 'chesty', speak: true }] },
    { text: 'please', flags: [{ issue: 'drop', speak: true }] },
    { text: 'ready', heard: false, flags: [{ issue: 'drop', speak: true }] },
    { text: 'window', flags: [{ issue: 'heavy', speak: true }] }
  ];
  const line = composeFeedback({ words, cursor: 0 });
  assert.equal(line.issue, 'drop');
  assert.equal(line.spoken, true);
  assert.equal(line.text.startsWith('June and please dropped. '), true);
  assert.equal(line.text.includes('ready'), false);
  assert.equal(line.text.includes('window'), false);
  assert.equal(line.text.includes('heavy'), false);
  const sentences = line.text.split(/[.!?]/).map(part => part.trim()).filter(Boolean);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[1], cueLine('drop', 0).replace(/[.!?]$/, ''));
  const three = composeFeedback({
    words: ['arriving', 'ready', 'morning'].map(text => ({ text, flags: [{ issue: 'fry', speak: true }] })),
    cursor: 2
  });
  assert.equal(three.text.startsWith(`${joinIssueWords(['arriving', 'ready', 'morning'])} fell into fry. `), true);
  assert.equal(three.text.split(/[.!?]/).filter(part => part.trim()).length, 2);
});

test('a short take does not name prompt words that were not said', () => {
  const heardFrames = [
    ...burst({ hz: 188, f2: 1400, tilt: -9, vtl: 16.5 }, 10, 2),
    ...burst({ hz: 120, f2: 1000, tilt: -11, vtl: 17 }, 10, 2)
  ];
  const prompt = 'alpha bravo charlie delta echo foxtrot';
  const completed = classifyUtterance({
    analysis: { frames: heardFrames, snrDb: 18, voicedFraction: 0.7, tooNoisy: false },
    prompt,
    transcript: prompt,
    goal
  });
  const partial = classifyUtterance({
    analysis: { frames: heardFrames, snrDb: 18, voicedFraction: 0.7, tooNoisy: false },
    prompt,
    transcript: 'alpha bravo',
    goal
  });
  for (const result of [completed, partial]) {
    for (const word of result.words) assert.ok(['alpha', 'bravo'].includes(word.text), word.text);
    assert.equal(/charlie|delta|echo|foxtrot/.test(result.feedback.text), false);
  }
  assert.ok(partial.words.length >= 1 && partial.words.length <= 2);
});

test('a mid-phrase pause does not end the turn while the prompt is unfinished', () => {
  const words = [
    { text: 'one', ms: 320, f0: 190, f1: 400, f2: 1900, seed: 3, gapMs: 40 },
    { text: 'two', ms: 320, f0: 188, f1: 420, f2: 1850, seed: 4, gapMs: 700 },
    { text: 'three', ms: 320, f0: 186, f1: 410, f2: 1800, seed: 5, gapMs: 40 },
    { text: 'four', ms: 340, f0: 184, f1: 430, f2: 1760, seed: 6, gapMs: 40 }
  ];
  const speech = synthesizeWords(words).samples;
  const tail = new Float32Array(Math.floor(16000 * 1.7));
  const samples = new Float32Array(speech.length + tail.length);
  samples.set(speech);
  const push = detector => {
    for (let offset = 0; offset < samples.length; offset += 1600) detector.push(samples.subarray(offset, offset + 1600));
  };
  const early = [];
  const cut = createTurnDetector({ onTurn: turn => early.push(turn) });
  push(cut);
  const held = [];
  const wait = createTurnDetector({ onTurn: turn => held.push(turn) });
  wait.setExpectation(4000);
  push(wait);
  assert.ok(early.length >= 2, `a 700 ms pause closed ${early.length} turn(s) with no prompt`);
  assert.equal(held.length, 1, `prompt still open, turns: ${held.length}`);
  assert.ok(held[0].duration > 1.2, held[0].duration);
});

test('tts mute drops an open turn instead of scoring the coach voice', () => {
  const turns = [];
  const detector = createTurnDetector({ onTurn: turn => turns.push(turn) });
  const speech = synthesizeWords([{ text: 'keep', ms: 500, f0: 190, f1: 400, f2: 2000, seed: 4, gapMs: 20 }]).samples;
  detector.push(speech.subarray(0, 4000));
  detector.setSpeaking(true);
  detector.push(speech);
  detector.setSpeaking(false);
  detector.push(new Float32Array(16000));
  assert.equal(turns.length <= 1, true);
});
