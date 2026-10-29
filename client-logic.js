export const MAX_ATTEMPTS = 300;
export const MAX_DRIVE_LOG = 500;
export const MAX_OPEN_COMPLETIONS = 100;

export function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return localDayKey(date);
}

export function streakFromDayKeys(dayKeys, now = new Date()) {
  const days = new Set(dayKeys.filter(Boolean));
  let count = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(localDayKey(cursor))) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

export function mergeState(server, local) {
  const byKey = (name, key) => [...new Map([...(server?.[name] || []), ...(local?.[name] || [])].map(item => [key(item), item])).values()];
  return {
    ...server,
    ...local,
    attempts: byKey('attempts', item => item?.id).sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || ''))),
    driveLog: byKey('driveLog', item => item?.id),
    completed: byKey('completed', item => item?.activity || `${item?.lesson}|${item?.date}`)
  };
}

export const LOW_COMFORT = 2;

export function shouldPauseForComfort(comfort) {
  return Number.isInteger(comfort) && comfort >= 1 && comfort <= LOW_COMFORT;
}

export function normalizeState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const baselineAttemptId = typeof source.baselineAttemptId === 'string' && source.baselineAttemptId.length > 0 && source.baselineAttemptId.length <= 80
    ? source.baselineAttemptId
    : null;
  const pause = source.pausedSession;
  const activity = pause?.activity ?? null;
  const pausedSession = pause && typeof pause === 'object' && !Array.isArray(pause) &&
    typeof pause.lesson === 'string' && pause.lesson.length > 0 && pause.lesson.length <= 80 &&
    (activity === null || (typeof activity === 'string' && activity.length > 0 && activity.length <= 80)) &&
    typeof pause.date === 'string' && Number.isFinite(Date.parse(pause.date)) &&
    Number.isInteger(pause.comfort) && pause.comfort >= 1 && pause.comfort <= 5
    ? {
      lesson: pause.lesson,
      activity,
      date: pause.date,
      comfort: pause.comfort,
      lessonTitle: typeof pause.lessonTitle === 'string' ? pause.lessonTitle.slice(0, 120) : ''
    }
    : null;
  return { ...source, baselineAttemptId, pausedSession };
}

// Dedicated account baseline first. Otherwise the earliest saved take of the
// same course activity, or the same lesson when this is open practice.
export function baselineReferences(attempts, { activityId = null, lessonId = null } = {}) {
  const list = (Array.isArray(attempts) ? attempts : []).filter(item => item && typeof item.id === 'string' && item.date);
  const phrase = list.filter(item => activityId ? item.activity === activityId : item.lesson === lessonId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null;
  return { phrase };
}

const HARD_WORD_CAP = 40;

// A minute or more is a checkpoint. An ended coach log is kept even under a minute,
// so tapping Done or backgrounding Safari cannot drop the wrap-up.
export function keepDriveLog(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (Number.isFinite(entry.actualMinutes) && entry.actualMinutes >= 1) return true;
  return entry.ended === true && entry.kind === 'coach' && !!entry.coach && typeof entry.coach === 'object';
}

// Null for older logs that have no wrap-up. Score matches the end-of-drive screen.
export function readDriveWrap(entry) {
  const wrap = entry?.kind === 'coach' ? entry.coach?.wrap : null;
  if (!wrap || typeof wrap !== 'object' || Array.isArray(wrap)) return null;
  if (!Number.isInteger(wrap.achieved) || wrap.achieved < 0 || !Number.isInteger(wrap.attempted) || wrap.attempted < 0) return null;
  const problems = (Array.isArray(wrap.problems) ? wrap.problems : []).filter(row =>
    row && typeof row.word === 'string' && row.word.trim() && typeof row.phonetics === 'string' && row.phonetics.trim()
  ).map(row => ({
    word: row.word,
    phonetics: row.phonetics,
    count: Number.isInteger(row.count) && row.count > 0 ? row.count : 1
  }));
  const score = wrap.attempted > 0 ? `${wrap.achieved} of ${wrap.attempted} phrases achieved` : 'No phrases yet';
  const total = Number.isInteger(wrap.total) && wrap.total >= 0 ? wrap.total : null;
  const notes = (Array.isArray(wrap.notes) ? wrap.notes : []).filter(row =>
    row && typeof row.phrase === 'string' && row.phrase.trim() && typeof row.detail === 'string' && row.detail.trim()
  ).slice(0, HARD_WORD_CAP).map(row => ({
    phrase: row.phrase,
    issue: typeof row.issue === 'string' ? row.issue : '',
    detail: row.detail,
    delta: typeof row.delta === 'string' ? row.delta : ''
  }));
  return { achieved: wrap.achieved, attempted: wrap.attempted, total, score, problems, notes };
}

export function driveHardHtml(problems) {
  const rows = Array.isArray(problems) ? problems : [];
  if (!rows.length) return '<p class="history-hard-empty">No word was flagged as hard.</p>';
  const items = rows.map(row => {
    const extra = row.count > 1 ? ` · ${row.count} tries` : '';
    return `<li>${escapeHtml(row.word)} — ${escapeHtml(row.phonetics)}${extra}</li>`;
  }).join('');
  return `<details class="history-hard"><summary>Words that were hard</summary><ul>${items}</ul></details>`;
}

export function driveNotesHtml(notes) {
  const rows = (Array.isArray(notes) ? notes : []).filter(row => row && row.phrase && row.detail);
  if (!rows.length) return '';
  const items = rows.map(row => {
    const delta = row.delta ? ` (${escapeHtml(row.delta)})` : '';
    return `<li>${escapeHtml(row.phrase)} — ${escapeHtml(row.detail)}${delta}</li>`;
  }).join('');
  return `<details class="history-hard"><summary>What the takes measured</summary><ul>${items}</ul></details>`;
}

export function driveHistoryExtras(entry) {
  const wrap = readDriveWrap(entry);
  if (!wrap) return { score: '', hardHtml: '' };
  return { score: wrap.score, hardHtml: `${driveHardHtml(wrap.problems)}${driveNotesHtml(wrap.notes)}` };
}

export function trimHistory(value) {
  const source = value && typeof value === 'object' ? value : {};
  const attempts = (Array.isArray(source.attempts) ? source.attempts : []).slice(-MAX_ATTEMPTS).map(attempt => {
    if (!attempt || typeof attempt !== 'object' || !Array.isArray(attempt.wordAnalysis)) return attempt;
    return {
      ...attempt,
      wordAnalysis: attempt.wordAnalysis.map(item => {
        if (!item || typeof item !== 'object') return item;
        const { cue, ...rest } = item;
        return rest;
      })
    };
  });
  const driveLog = (Array.isArray(source.driveLog) ? source.driveLog : []).slice(-MAX_DRIVE_LOG).map(entry => {
    if (!entry || entry.kind !== 'coach' || !entry.coach || typeof entry.coach !== 'object') return entry;
    const coach = { ...entry.coach };
    if (Array.isArray(coach.phrases)) {
      coach.phrases = coach.phrases.slice(-30).map(phrase => ({ ...phrase, words: Array.isArray(phrase.words) ? phrase.words.slice(0, 16) : [] }));
    }
    if (coach.wrap && typeof coach.wrap === 'object') {
      const wrap = { ...coach.wrap };
      if (Array.isArray(wrap.problems)) wrap.problems = wrap.problems.slice(0, HARD_WORD_CAP);
      if (Array.isArray(wrap.notes)) wrap.notes = wrap.notes.slice(0, HARD_WORD_CAP);
      coach.wrap = wrap;
    }
    return { ...entry, coach };
  });
  const seen = new Set();
  const course = [];
  const open = [];
  for (const item of Array.isArray(source.completed) ? source.completed : []) {
    if (item?.activity) {
      if (!seen.has(item.activity)) {
        seen.add(item.activity);
        course.push(item);
      }
    } else open.push(item);
  }
  const next = { ...source, attempts, driveLog, completed: [...course, ...open.slice(-MAX_OPEN_COMPLETIONS)] };
  if (next.baselineAttemptId && !attempts.some(item => item?.id === next.baselineAttemptId)) next.baselineAttemptId = null;
  return next;
}

export function stableState(value) {
  const normalize = item => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce((copy, key) => {
        if (item[key] !== undefined) copy[key] = normalize(item[key]);
        return copy;
      }, {});
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function selectDrive(drives, { week, courseComplete = false, date = new Date() } = {}) {
  const list = Array.isArray(drives) ? drives : [];
  if (courseComplete) {
    const maintenance = list.filter(drive => drive?.id === 'maintenance' || drive?.week === 'maintenance');
    if (maintenance.length) {
      const index = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
      return maintenance[((index % maintenance.length) + maintenance.length) % maintenance.length];
    }
  }
  return list.find(drive => drive?.week === week) || list.find(drive => drive?.id === 'maintenance') || list[0] || null;
}

export function timedWordsFromCloud(result) {
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const words = segments.flatMap(segment => Array.isArray(segment?.words) ? segment.words : [])
    .map(word => ({ text: String(word?.word || ''), timestamp: [Number(word?.start), Number(word?.end)] }))
    .filter(word => word.text.trim() && Number.isFinite(word.timestamp[0]) && word.timestamp[1] > word.timestamp[0]);
  if (words.length) return words;
  const chunks = segments.map(segment => ({ text: String(segment?.text || ''), timestamp: [Number(segment?.start), Number(segment?.end)] }))
    .filter(chunk => chunk.text && Number.isFinite(chunk.timestamp[0]) && Number.isFinite(chunk.timestamp[1]) && chunk.timestamp[1] > chunk.timestamp[0]);
  if (chunks.length) return chunks;
  return timedWordsFromVtt(result?.vtt);
}

export function timedWordsFromVtt(vtt) {
  const timestamp = /(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(\d{2}:)?\d{2}:\d{2}[.,]\d{3}/;
  const seconds = value => {
    const [hours = 0, minutes = 0, secs = 0] = String(value).replace(',', '.').split(':').map(Number);
    return hours * 3600 + minutes * 60 + secs;
  };
  const blocks = String(vtt || '').replace(/^WEBVTT[^\n]*\n?/i, '').trim().split(/\n\s*\n/);
  const parsed = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const lineIndex = lines.findIndex(line => timestamp.test(line));
    if (lineIndex < 0) continue;
    const times = lines[lineIndex].split('-->').map(part => part.trim().split(/\s+/)[0]);
    const text = lines.slice(lineIndex + 1).join(' ').replace(/<[^>]*>/g, ' ').trim();
    if (!text) continue;
    parsed.push({ text, timestamp: [seconds(times[0]), seconds(times[1])] });
  }
  return parsed;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
