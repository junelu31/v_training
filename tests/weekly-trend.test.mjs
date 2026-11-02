import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoachSession, takeSound } from '../drive-coach.js';
import { isoWeekKey, weeklyTrend, weeklyTrendHtml } from '../client-logic.js';

const monday = new Date(2026, 10, 2, 9, 0, 0);

function drive(date, wrap, id) {
  return {
    id, date, routineId: 'week-1', plannedMinutes: 30, actualMinutes: 12,
    comfort: null, cueHeld: 'partly', kind: 'coach',
    coach: { minutes: 12, mode: 'lines', summary: '', phrases: [], wrap }
  };
}

test('ISO weeks start on Monday and share the year of their Thursday', () => {
  assert.equal(isoWeekKey(new Date(2026, 10, 2)), isoWeekKey(new Date(2026, 10, 8)));
  assert.notEqual(isoWeekKey(new Date(2026, 10, 1)), isoWeekKey(new Date(2026, 10, 2)));
  assert.equal(isoWeekKey(new Date(2025, 11, 29)), isoWeekKey(new Date(2026, 0, 1)));
  assert.match(isoWeekKey(new Date(2026, 0, 1)), /^2026-W01$/);
  assert.equal(isoWeekKey('not a date'), '');
});

test('weekly trend counts sessions and pass rate, and skips sound that was never saved', () => {
  const thisWeek = monday.toISOString();
  const lastWeek = new Date(2026, 9, 26, 9).toISOString();
  const ancient = new Date(2026, 5, 1, 9).toISOString();
  const trend = weeklyTrend({
    driveLog: [
      drive(thisWeek, {
        achieved: 8, attempted: 10, total: 20, problems: [],
        sound: { hz: 168, db: -14, takes: 2 },
        notes: [
          { phrase: 'morning', issue: 'low', detail: 'secret detail <b>' },
          { phrase: 'light', issue: 'low', detail: 'again' },
          { phrase: 'ready', issue: 'fry', detail: 'fry' }
        ]
      }, 'a'),
      drive(thisWeek, {
        achieved: 2, attempted: 2, total: 20, problems: [],
        notes: [{ phrase: 'one', issue: 'fry', detail: 'more fry' }]
      }, 'b'),
      drive(lastWeek, {
        achieved: 5, attempted: 10, total: 20, problems: [],
        sound: { hz: 160, db: -15, takes: 1 },
        notes: [{ phrase: 'old', issue: 'dark', detail: 'darker' }]
      }, 'c'),
      drive(ancient, { achieved: 9, attempted: 9, total: 9, problems: [], sound: { hz: 200, db: -5, takes: 5 } }, 'd'),
      { id: 'check', date: thisWeek, kind: null, actualMinutes: 20 }
    ],
    attempts: [{ id: 'practice', date: thisWeek, raw: { pitch: 180, brightness: -12 } }]
  }, monday);
  const current = trend.weeks.at(-1);
  const previous = trend.weeks.at(-2);
  assert.equal(trend.weeks.length, 8);
  assert.equal(current.sessions, 2);
  assert.equal(current.passed, 10);
  assert.equal(current.attempted, 12);
  assert.equal(current.pitchHz, 172);
  assert.equal(current.brightnessDb, -13.3);
  assert.equal(current.issue, 'fry');
  assert.equal(previous.sessions, 1);
  assert.equal(previous.passRate, 0.5);
  assert.equal(previous.pitchHz, 160);
  assert.equal(trend.weeks.some(week => week.pitchHz === 200), false);
  assert.equal(trend.summary, 'Pass rate up 33% from last week.');
  const html = weeklyTrendHtml(trend);
  assert.match(html, /Pass rate up 33% from last week/);
  assert.match(html, /172 Hz/);
  assert.match(html, /fry/);
  assert.equal(html.includes('secret detail'), false);
  assert.equal(html.includes('<script'), false);
  assert.match(html, /<svg /);
});

test('an empty fortnight says so, and a first scored week does not invent a delta', () => {
  const empty = weeklyTrend({ driveLog: [], attempts: [] }, monday);
  assert.equal(empty.summary, 'No scored phrases in the last two weeks.');
  assert.match(weeklyTrendHtml(empty), /left out of those averages/);
  const only = weeklyTrend({
    driveLog: [drive(monday.toISOString(), { achieved: 1, attempted: 2, total: 4, problems: [] }, 'only')]
  }, monday);
  assert.equal(only.summary, 'This week’s pass rate is 50%. Last week had no scored phrases.');
  const quiet = weeklyTrend({
    driveLog: [drive(new Date(2026, 9, 26, 9).toISOString(), { achieved: 1, attempted: 1, total: 1, problems: [] }, 'old')]
  }, monday);
  assert.equal(quiet.summary, 'No scored phrases this week yet.');
});

test('a graded take stores average pitch and resonance, and a noisy take does not', () => {
  const at = monday.getTime();
  const session = createCoachSession({ lines: ['morning'], now: at, id: 'sound' });
  const words = hz => ({
    tooNoisy: false,
    words: [
      { text: 'morning', hz, brightness: hz === 160 ? -15 : -16, voiced: 8, flags: [] },
      { text: 'light', hz: hz + 20, brightness: hz === 160 ? -13 : -16, voiced: 8, flags: [] }
    ],
    feedback: { spoken: false, text: '' },
    profile: { label: 'androgynous' }
  });
  assert.deepEqual(takeSound(words(160).words), { hz: 170, db: -14 });
  assert.equal(takeSound([{ text: 'morning', hz: 150, voiced: 8 }]), null);
  session.noteAnalysis(words(160), { transcript: 'morning', at });
  session.noteAnalysis({
    tooNoisy: true,
    words: [{ text: 'morning', hz: 90, brightness: -30, voiced: 8, flags: [] }],
    feedback: { spoken: true, text: 'Too noisy.', issue: 'noisy' },
    profile: { label: 'unsure' }
  }, { transcript: '', at: at + 1000 });
  session.noteAnalysis(words(150), { transcript: 'morning', at: at + 2000 });
  assert.deepEqual(session.finalEntry(at + 2000).coach.wrap.sound, { hz: 165, db: -15, takes: 2 });
});
