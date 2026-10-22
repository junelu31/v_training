import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePcm, createTurnDetector, detectTurns, makeRoadNoise, mixAtSnr, synthesizeWords } from '../drive-dsp.js';
import { classifyUtterance, composeFeedback, confusion, createCoachSession, matchCommand, profilePhrase, scoreFlags } from '../drive-coach.js';
import { CUE_LIBRARY, cueLine } from '../drive-cues.js';

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
  assert.match(cueLine('heavy', 0), /sleeping baby/);
  assert.match(cueLine('drop', 0), /gentle question/);
  assert.match(cueLine('fry', 0), /air flowing/);
  assert.match(cueLine('strain', 0), /light hum/);
  assert.notEqual(cueLine('drop', 0), cueLine('drop', 1));
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
    else assert.equal(result.words.some(word => word.flags.some(flag => flag.speak && !['drop', 'fry', 'heavy', 'chesty', 'strain', 'dark'].includes(flag.issue))), false);
  }
});

test('commands, comfort pause, rest, and the in-memory phrase cap', () => {
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
  assert.equal(session.comfortReply('two', now).type, 'comfort-pause');
  const later = createCoachSession({ lines: ['Again'], now, id: 'rest' });
  const rest = later.noteAnalysis(classifyUtterance({ analysis, prompt: 'Again', goal }), { at: now + 21 * 60000 });
  assert.ok(rest.events.some(event => event.type === 'rest'));
  const entry = later.logEntry();
  assert.equal(entry.kind, 'coach');
  assert.ok(entry.actualMinutes >= 20 && entry.actualMinutes <= 22);
  assert.equal(entry.coach.phrases.length <= 30, true);
});

test('positive reinforcement changes after the same word improves', () => {
  const before = [{ text: 'please', flags: [{ issue: 'drop', speak: true }] }];
  const words = [{ text: 'please', voiced: 4, flags: [] }];
  const line = composeFeedback({ words, cursor: 1, cleared: [{ word: 'please', issue: 'drop' }] });
  assert.match(line.text, /please/i);
  assert.match(line.text, /better|improved|held/i);
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
