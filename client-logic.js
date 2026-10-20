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
  const driveLog = (Array.isArray(source.driveLog) ? source.driveLog : []).slice(-MAX_DRIVE_LOG);
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
  return { ...source, attempts, driveLog, completed: [...course, ...open.slice(-MAX_OPEN_COMPLETIONS)] };
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
