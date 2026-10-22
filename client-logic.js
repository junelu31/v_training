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
    if (!entry || entry.kind !== 'coach' || !entry.coach || !Array.isArray(entry.coach.phrases)) return entry;
    return { ...entry, coach: { ...entry.coach, phrases: entry.coach.phrases.slice(-30).map(phrase => ({ ...phrase, words: Array.isArray(phrase.words) ? phrase.words.slice(0, 16) : [] })) } };
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
