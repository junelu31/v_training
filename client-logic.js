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
  const conversation = entry?.coach?.mode === 'conversation';
  const score = wrap.attempted > 0
    ? `${wrap.achieved} of ${wrap.attempted} ${conversation ? 'questions on target' : 'phrases achieved'}`
    : (conversation ? 'No questions yet' : 'No phrases yet');
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

export const TREND_WEEKS = 8;
export const AURORA_PITCH_HZ = 172;
export const AURORA_BRIGHTNESS_DB = -13.6;

const TREND_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TREND_ISSUES = {
  drop: 'falling end',
  chesty: 'dark resonance',
  heavy: 'heavy',
  fry: 'fry',
  strain: 'pressed',
  dark: 'dark',
  low: 'low pitch',
  breath: 'breathy',
  high: 'high pitch',
  flat: 'flat melody',
  quiet: 'quiet',
  fast: 'fast',
  misread: 'misread'
};

function localCalendarDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** ISO week of the local calendar day. Monday starts the week. */
export function isoWeekKey(value) {
  const local = localCalendarDate(value);
  if (!local) return '';
  const thursday = new Date(local);
  thursday.setDate(local.getDate() + 3 - ((local.getDay() + 6) % 7));
  const week1 = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(((thursday - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function trendWeeks(now, count) {
  const monday = localCalendarDate(now);
  if (!monday) return [];
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = [];
  for (let ago = count - 1; ago >= 0; ago--) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - ago * 7);
    weeks.push({
      key: isoWeekKey(start),
      label: `${TREND_MONTHS[start.getMonth()]} ${start.getDate()}`,
      sessions: 0,
      passed: 0,
      attempted: 0,
      hzSum: 0,
      hzN: 0,
      dbSum: 0,
      dbN: 0,
      issues: new Map()
    });
  }
  return weeks;
}

function finiteIn(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function addMeasure(week, hz, db, weight) {
  if (!(weight > 0)) return;
  const pitch = finiteIn(hz, 50, 500);
  const bright = finiteIn(db, -60, 20);
  if (pitch != null) {
    week.hzSum += pitch * weight;
    week.hzN += weight;
  }
  if (bright != null) {
    week.dbSum += bright * weight;
    week.dbN += weight;
  }
}

function topIssue(counts) {
  let best = '';
  let bestCount = 0;
  for (const [issue, count] of counts) {
    if (!TREND_ISSUES[issue]) continue;
    if (count > bestCount || (count === bestCount && issue < best)) {
      best = issue;
      bestCount = count;
    }
  }
  return best ? { issue: best, label: TREND_ISSUES[best], count: bestCount } : null;
}

function finishWeek(week) {
  const passRate = week.attempted > 0 ? week.passed / week.attempted : null;
  const issue = topIssue(week.issues);
  return {
    key: week.key,
    label: week.label,
    sessions: week.sessions,
    passed: week.passed,
    attempted: week.attempted,
    passRate,
    pitchHz: week.hzN > 0 ? Math.round((week.hzSum / week.hzN) * 10) / 10 : null,
    brightnessDb: week.dbN > 0 ? Math.round((week.dbSum / week.dbN) * 10) / 10 : null,
    issue: issue?.issue || null,
    issueLabel: issue?.label || ''
  };
}

function trendSummary(current, previous) {
  const rate = week => (week && week.attempted > 0 ? (week.passed / week.attempted) * 100 : null);
  const nowRate = rate(current);
  const thenRate = rate(previous);
  if (nowRate == null && thenRate == null) return 'No scored phrases in the last two weeks.';
  if (nowRate == null) return 'No scored phrases this week yet.';
  if (thenRate == null) return `This week’s pass rate is ${Math.round(nowRate)}%. Last week had no scored phrases.`;
  const delta = Math.round(nowRate - thenRate);
  if (delta > 0) return `Pass rate up ${delta}% from last week.`;
  if (delta < 0) return `Pass rate down ${Math.abs(delta)}% from last week.`;
  return 'Pass rate is even with last week.';
}

/**
 * Last eight ISO weeks from Drive sessions and saved practice takes.
 * Sessions and pass rate come from coach logs. Pitch and brightness use a
 * session's saved sound when it has one, plus practice takes that stored raw
 * pitch and brightness. Older Drive logs without sound still count, and are
 * left out of those averages.
 */
export function weeklyTrend(source = {}, now = new Date()) {
  const weeks = trendWeeks(now, TREND_WEEKS);
  const byKey = new Map(weeks.map(week => [week.key, week]));
  for (const entry of Array.isArray(source.driveLog) ? source.driveLog : []) {
    if (entry?.kind !== 'coach') continue;
    const week = byKey.get(isoWeekKey(entry.date));
    if (!week) continue;
    week.sessions += 1;
    const wrap = entry.coach?.wrap;
    if (wrap && Number.isInteger(wrap.achieved) && wrap.achieved >= 0 && Number.isInteger(wrap.attempted) && wrap.attempted >= wrap.achieved) {
      week.passed += wrap.achieved;
      week.attempted += wrap.attempted;
    }
    const sound = wrap?.sound;
    if (sound && Number.isInteger(sound.takes) && sound.takes > 0) addMeasure(week, sound.hz, sound.db, sound.takes);
    for (const note of Array.isArray(wrap?.notes) ? wrap.notes : []) {
      if (note && TREND_ISSUES[note.issue]) week.issues.set(note.issue, (week.issues.get(note.issue) || 0) + 1);
    }
  }
  for (const attempt of Array.isArray(source.attempts) ? source.attempts : []) {
    const week = byKey.get(isoWeekKey(attempt?.date));
    const raw = attempt?.raw;
    if (!week || !raw) continue;
    addMeasure(week, raw.pitch, raw.brightness, 1);
  }
  const finished = weeks.map(finishWeek);
  return {
    weeks: finished,
    summary: trendSummary(finished[finished.length - 1], finished[finished.length - 2])
  };
}

function svgNum(value) {
  return Number(value).toFixed(1);
}

function passChart(weeks) {
  const width = 320;
  const height = 118;
  const padX = 8;
  const padTop = 16;
  const padBottom = 22;
  const gap = 6;
  const barW = (width - padX * 2 - gap * (weeks.length - 1)) / weeks.length;
  const inner = height - padTop - padBottom;
  const bars = weeks.map((week, index) => {
    const x = padX + index * (barW + gap);
    const rate = week.passRate == null ? 0 : Math.max(0, Math.min(1, week.passRate));
    const h = week.attempted > 0 ? Math.max(rate * inner, 2) : 0;
    const y = padTop + inner - h;
    const bar = h ? `<rect x="${svgNum(x)}" y="${svgNum(y)}" width="${svgNum(barW)}" height="${svgNum(h)}" rx="3" fill="#e77a60"></rect>` : `<rect x="${svgNum(x)}" y="${svgNum(padTop + inner - 1)}" width="${svgNum(barW)}" height="1" fill="#dcd8cf"></rect>`;
    const label = week.passRate == null ? '—' : `${Math.round(week.passRate * 100)}`;
    return `${bar}<text x="${svgNum(x + barW / 2)}" y="${height - 6}" text-anchor="middle" fill="#69736e" font-size="11" font-family="DM Sans, system-ui, sans-serif">${escapeHtml(week.label.split(' ')[1] || week.label)}</text><text x="${svgNum(x + barW / 2)}" y="${svgNum(Math.max(12, y - 4))}" text-anchor="middle" fill="#21322d" font-size="11" font-family="DM Sans, system-ui, sans-serif">${escapeHtml(label)}</text>`;
  }).join('');
  return `<svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Pass rate for the last eight weeks">${bars}</svg>`;
}

function sparkChart(weeks, key, target, label) {
  const finite = weeks.map(week => week[key]).filter(value => Number.isFinite(value));
  if (!finite.length) return `<p class="trend-empty">No ${escapeHtml(label)} saved in these weeks.</p>`;
  const width = 320;
  const height = 88;
  const pad = 14;
  let lo = Math.min(...finite, target);
  let hi = Math.max(...finite, target);
  if (hi - lo < 1) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo || 1;
  const xAt = index => pad + (weeks.length === 1 ? (width - pad * 2) / 2 : index / (weeks.length - 1) * (width - pad * 2));
  const yAt = value => pad + (1 - (value - lo) / span) * (height - pad * 2);
  const targetY = yAt(target);
  let path = '';
  let pen = false;
  weeks.forEach((week, index) => {
    const value = week[key];
    if (!Number.isFinite(value)) {
      pen = false;
      return;
    }
    path += `${pen ? 'L' : 'M'}${svgNum(xAt(index))} ${svgNum(yAt(value))} `;
    pen = true;
  });
  const dots = weeks.map((week, index) => Number.isFinite(week[key])
    ? `<circle cx="${svgNum(xAt(index))}" cy="${svgNum(yAt(week[key]))}" r="3.5" fill="#fffdf8" stroke="#e77a60" stroke-width="2"></circle>`
    : '').join('');
  return `<svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">${`<line x1="${pad}" y1="${svgNum(targetY)}" x2="${width - pad}" y2="${svgNum(targetY)}" stroke="#718f7d" stroke-dasharray="4 4" stroke-width="1.5"></line><path d="${path.trim()}" fill="none" stroke="#e77a60" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>${dots}`}</svg>`;
}

function weekLine(week) {
  const sessions = `${week.sessions} session${week.sessions === 1 ? '' : 's'}`;
  const passed = week.attempted > 0 ? `${week.passed} of ${week.attempted} passed` : 'no scored phrases';
  const pitch = week.pitchHz == null ? 'pitch not saved' : `${week.pitchHz} Hz`;
  const bright = week.brightnessDb == null ? 'resonance not saved' : `${week.brightnessDb} dB`;
  const issue = week.issueLabel ? week.issueLabel : 'no main note';
  return `<li><b>${escapeHtml(week.label)}</b><span>${escapeHtml(`${sessions} · ${passed}`)}</span><span>${escapeHtml(`${pitch} · ${bright} · ${issue}`)}</span></li>`;
}

/** Inline SVG and a readable week list. Numbers and labels only; no stored prose. */
export function weeklyTrendHtml(trend) {
  const data = trend && Array.isArray(trend.weeks) ? trend : { weeks: [], summary: '' };
  const any = data.weeks.some(week => week.sessions > 0 || week.pitchHz != null || week.brightnessDb != null);
  if (!any) {
    return `<p class="trend-summary">${escapeHtml(data.summary || 'No scored phrases in the last two weeks.')}</p><p class="trend-empty">Drive sessions show up here after practice. Older sessions without pitch or resonance are left out of those averages.</p>`;
  }
  return `<p class="trend-summary">${escapeHtml(data.summary || '')}</p>
    <p class="trend-caption">Pass rate</p>${passChart(data.weeks)}
    <p class="trend-caption">Pitch vs ${AURORA_PITCH_HZ} Hz</p>${sparkChart(data.weeks, 'pitchHz', AURORA_PITCH_HZ, 'Average pitch versus 172 hertz')}
    <p class="trend-caption">Resonance vs ${AURORA_BRIGHTNESS_DB} dB</p>${sparkChart(data.weeks, 'brightnessDb', AURORA_BRIGHTNESS_DB, 'Average resonance versus -13.6 decibels')}
    <ol class="trend-weeks">${data.weeks.filter(week => week.sessions > 0 || week.pitchHz != null || week.brightnessDb != null).map(weekLine).join('')}</ol>`;
}
