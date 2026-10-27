import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { baselineReferences, dayOf, driveHistoryExtras, escapeHtml, keepDriveLog, localDayKey, mergeState, normalizeState, selectDrive, shouldPauseForComfort, stableState, streakFromDayKeys, timedWordsFromCloud, trimHistory, MAX_ATTEMPTS } from '../client-logic.js';

const run = promisify(execFile);

test('word timestamps from Workers AI are kept instead of spreading a whole segment', () => {
  const words = timedWordsFromCloud({
    segments: [{
      text: 'MMM, maybe we meet near noon.',
      start: 0,
      end: 2.4,
      words: [
        { word: 'MMM', start: 0, end: 0.68 },
        { word: 'maybe', start: 1.1, end: 1.34 },
        { word: 'we', start: 1.34, end: 1.54 }
      ]
    }]
  });
  assert.deepEqual(words.map(word => word.timestamp), [[0, 0.68], [1.1, 1.34], [1.34, 1.54]]);
  assert.equal(words[1].text, 'maybe');
});

test('segment text and WebVTT remain fallbacks when word times are absent', () => {
  const segments = timedWordsFromCloud({ segments: [{ text: 'hello there', start: 0.2, end: 1.2 }] });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'hello there');
  const vtt = timedWordsFromCloud({ vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nHello\n' });
  assert.deepEqual(vtt, [{ text: 'Hello', timestamp: [0, 0.5] }]);
});

test('pending progress merges onto the server version instead of replaying a stale one', () => {
  const server = { goal: 'balanced', attempts: [{ id: 'saved', date: '2026-10-01T00:00:00.000Z' }], driveLog: [], completed: [{ activity: 'w1d1-1', lesson: 'flow', date: '2026-10-01' }] };
  const pending = { goal: 'bright', attempts: [{ id: 'saved', date: '2026-10-01T00:00:00.000Z' }, { id: 'local', date: '2026-10-02T00:00:00.000Z' }], driveLog: [{ id: 'drive-1' }], completed: [{ lesson: 'flow', date: '2026-10-02' }] };
  const merged = mergeState(server, pending);
  assert.equal(merged.goal, 'bright');
  assert.deepEqual(merged.attempts.map(attempt => attempt.id), ['saved', 'local']);
  assert.equal(merged.driveLog.length, 1);
  assert.equal(merged.completed.length, 2);
  assert.equal(stableState(mergeState(server, server)), stableState(server));
});

test('history keeps the latest takes and drops stored coaching paragraphs', () => {
  const attempts = Array.from({ length: MAX_ATTEMPTS + 5 }, (_, index) => ({
    id: `attempt-${index}`,
    date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    wordAnalysis: [{ word: 'maybe', label: 'Within selected practice bands', cue: 'x'.repeat(400) }]
  }));
  const trimmed = trimHistory({ attempts, driveLog: [], completed: [{ activity: 'w1d1-1', lesson: 'flow', date: '2026-10-01' }, { activity: 'w1d1-1', lesson: 'flow', date: '2026-10-02' }, { lesson: 'open', date: '2026-10-03' }] });
  assert.equal(trimmed.attempts.length, MAX_ATTEMPTS);
  assert.equal(trimmed.attempts[0].id, 'attempt-5');
  assert.equal(trimmed.attempts[0].wordAnalysis[0].cue, undefined);
  assert.equal(trimmed.attempts[0].wordAnalysis[0].label, 'Within selected practice bands');
  assert.equal(trimmed.completed.length, 2);
  assert.equal(stableState(trimHistory(trimmed)), stableState(trimmed));
});

test('missing baseline and pause fields default, and a trimmed snapshot is dropped', () => {
  const legacy = normalizeState({ goal: 'balanced', attempts: [{ id: 'keep', date: '2026-10-01T00:00:00.000Z' }] });
  assert.equal(legacy.baselineAttemptId, null);
  assert.equal(legacy.pausedSession, null);
  assert.equal(legacy.goal, 'balanced');
  const pause = { lesson: 'sovt', activity: null, date: '2026-10-21T12:00:00.000Z', comfort: 1, lessonTitle: 'Straw or lip-trill warm-up' };
  assert.deepEqual(normalizeState({ pausedSession: pause, baselineAttemptId: 'keep' }).pausedSession, pause);
  assert.equal(normalizeState({ pausedSession: { ...pause, comfort: 0 } }).pausedSession, null);
  assert.equal(shouldPauseForComfort(1), true);
  assert.equal(shouldPauseForComfort(2), true);
  assert.equal(shouldPauseForComfort(3), false);
  const attempts = [
    { id: 'first', date: '2026-10-01T00:00:00.000Z', activity: 'w1d1-2', lesson: 'baseline' },
    { id: 'later', date: '2026-10-02T00:00:00.000Z', activity: 'w1d1-2', lesson: 'baseline' }
  ];
  assert.equal(baselineReferences(attempts, { activityId: 'w1d1-2' }).phrase.id, 'first');
  assert.equal(baselineReferences(attempts, { lessonId: 'other' }).phrase, null);
  const trimmed = trimHistory({ attempts: attempts.slice(0, 1), baselineAttemptId: 'missing', driveLog: [], completed: [] });
  assert.equal(trimmed.baselineAttemptId, null);
  const kept = trimHistory({ attempts, baselineAttemptId: 'later', driveLog: [], completed: [] });
  assert.equal(kept.baselineAttemptId, 'later');
  assert.equal(stableState(trimHistory(kept)), stableState(kept));
});

test('today’s drive follows the course week and maintenance follows completion', () => {
  const drives = [
    { id: 'week-1', week: 1, title: 'Ease' },
    { id: 'week-8', week: 8, title: 'Ownership' },
    { id: 'maintenance', week: 'maintenance', title: 'Keep it' }
  ];
  assert.equal(selectDrive(drives, { week: 1 }).id, 'week-1');
  assert.equal(selectDrive(drives, { week: 8 }).id, 'week-8');
  assert.equal(selectDrive(drives, { week: 8, courseComplete: true, date: new Date('2026-10-20T18:00:00Z') }).id, 'maintenance');
});

test('streak day keys use the local calendar day of an instant', () => {
  const evening = '2026-10-20T00:30:00.000Z';
  assert.equal(dayOf(evening), localDayKey(new Date(evening)));
  const today = new Date(2026, 9, 20);
  assert.equal(streakFromDayKeys([localDayKey(today), localDayKey(new Date(2026, 9, 19))], today), 2);
  assert.equal(streakFromDayKeys([localDayKey(new Date(2026, 9, 18))], today), 0);
});

test('an evening UTC timestamp stays on the local day in Chicago', async () => {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
    import { dayOf } from './client-logic.js';
    const local = dayOf('2026-10-20T00:30:00.000Z');
    if (local !== '2026-10-19') throw new Error(local);
  `], { env: { ...process.env, TZ: 'America/Chicago' } });
  assert.equal(stdout, '');
});

test('saved text is escaped before it is inserted as HTML', () => {
  assert.equal(escapeHtml(`" onmouseover="alert(1)`), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(escapeHtml(`<b>`), '&lt;b&gt;');
});

test('drive history shows the wrap score and hard words, and older logs stay plain', () => {
  const legacy = { id: 'old', kind: 'coach', date: '2026-10-01T00:00:00.000Z', coach: { summary: 'Two phrases held.', phrases: [] } };
  assert.deepEqual(driveHistoryExtras(legacy), { score: '', hardHtml: '' });
  assert.deepEqual(driveHistoryExtras({ id: 'check', actualMinutes: 0, comfort: 4 }), { score: '', hardHtml: '' });
  const saved = {
    id: 'new', kind: 'coach', actualMinutes: 0, ended: true,
    coach: { wrap: { achieved: 1, attempted: 3, total: 53, problems: [{ word: 'morning', phonetics: 'Pitch sitting low: sat low in pitch', count: 2 }] } }
  };
  const extra = driveHistoryExtras(saved);
  assert.equal(extra.score, '1 of 3 phrases achieved');
  assert.match(extra.hardHtml, /<summary>Words that were hard<\/summary>/);
  assert.match(extra.hardHtml, /morning — Pitch sitting low: sat low in pitch · 2 tries/);
  const empty = driveHistoryExtras({ ...saved, coach: { wrap: { achieved: 0, attempted: 0, total: 53, problems: [] } } });
  assert.equal(empty.score, 'No phrases yet');
  assert.match(empty.hardHtml, /No word was flagged as hard/);
  const hostile = driveHistoryExtras({
    ...saved,
    coach: { wrap: { achieved: 1, attempted: 1, total: 1, problems: [{ word: '<b>', phonetics: 'a <note>', count: 1 }] } }
  });
  assert.equal(hostile.hardHtml.includes('<b>'), false);
  assert.match(hostile.hardHtml, /&lt;b&gt;/);
  assert.equal(keepDriveLog(saved), true);
  assert.equal(keepDriveLog({ actualMinutes: 12, kind: 'coach' }), true);
  assert.equal(keepDriveLog({ actualMinutes: 0, comfort: 4 }), false);
  const trimmed = trimHistory({
    attempts: [],
    completed: [],
    driveLog: [{
      ...saved,
      coach: {
        ...saved.coach,
        phrases: [{ words: Array.from({ length: 20 }, () => ({ text: 'hi' })) }],
        wrap: { ...saved.coach.wrap, problems: Array.from({ length: 45 }, (_, index) => ({ word: `w${index}`, phonetics: 'low', count: 1 })) }
      }
    }]
  });
  assert.equal(trimmed.driveLog[0].coach.wrap.problems.length, 40);
  assert.equal(trimmed.driveLog[0].coach.wrap.achieved, 1);
  assert.equal(trimmed.driveLog[0].coach.phrases[0].words.length, 16);
  assert.equal(trimmed.driveLog[0].coach.summary, undefined);
});
