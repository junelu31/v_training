import { median } from './drive-dsp.js';
import { cueLine, fillWord, problemPhrase, ISSUE_ORDER } from './drive-cues.js';
import { shouldPauseForComfort } from './client-logic.js';

export const CONFIDENCE_GATE = 0.62;
const MEMORY_PHRASES = 24;
const SAVED_PHRASES = 30;
const SAVED_WORDS = 16;

const PROFILE_LABELS = ['masculine', 'androgynous', 'feminine'];

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

export function tokenizePrompt(prompt) {
  return String(prompt || '')
    .split(/\s+/)
    .map(word => word.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ''))
    .filter(Boolean);
}

function finiteMedian(values) {
  return median(values.filter(Number.isFinite));
}

function voicedSpan(frames) {
  let first = frames.findIndex(frame => frame.voiced || frame.unstable);
  let last = frames.length - 1;
  for (let index = frames.length - 1; index >= 0; index--) {
    if (frames[index].voiced || frames[index].unstable) {
      last = index;
      break;
    }
  }
  if (first < 0) return frames;
  first = Math.max(0, first - 1);
  last = Math.min(frames.length - 1, last + 1);
  return frames.slice(first, last + 1);
}

export function alignWords(frames, prompt) {
  const tokens = tokenizePrompt(prompt);
  frames = voicedSpan(frames || []);
  if (!tokens.length || !frames.length) return [];
  const rms = frames.map(frame => Math.max(frame.rms || 0, frame.voiced ? 0.02 : 0));
  const count = tokens.length;
  const length = frames.length;
  const weights = tokens.map(token => Math.max(1, token.replace(/[^a-z]/gi, '').length));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const prefix = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) prefix[i + 1] = prefix[i] + rms[i];
  const huge = 1e12;
  const cost = Array.from({ length: count + 1 }, () => new Float64Array(length + 1).fill(huge));
  const from = Array.from({ length: count + 1 }, () => new Int16Array(length + 1).fill(-1));
  cost[0][0] = 0;
  for (let word = 0; word < count; word++) {
    const target = Math.max(2, Math.round(length * weights[word] / weightSum));
    for (let start = 0; start <= length; start++) {
      if (cost[word][start] >= huge / 2) continue;
      const last = Math.min(length, start + Math.max(8, target * 3));
      for (let end = start + 1; end <= last; end++) {
        const duration = end - start;
        const energy = prefix[end] - prefix[start];
        const boundary = (end < length ? rms[end] : 0) + (start > 0 ? rms[start - 1] : 0);
        const next = cost[word][start] + (target - duration) ** 2 * 0.015 + boundary * 3.2 - energy * 0.12;
        if (next < cost[word + 1][end]) {
          cost[word + 1][end] = next;
          from[word + 1][end] = start;
        }
      }
    }
  }
  let end = length;
  let best = cost[count][length];
  for (let index = Math.floor(length * 0.45); index <= length; index++) {
    if (cost[count][index] < best) {
      best = cost[count][index];
      end = index;
    }
  }
  if (best >= huge / 2) return [];
  const words = [];
  for (let word = count; word >= 1; word--) {
    const start = from[word][end];
    if (start < 0) return [];
    words.push({ text: tokens[word - 1], startIndex: start, endIndex: end });
    end = start;
  }
  words.reverse();
  return splitDroppedTails(frames, words).map(word => ({
    ...word,
    start: frames[word.startIndex]?.t ?? 0,
    end: frames[Math.max(word.startIndex, word.endIndex - 1)]?.t ?? 0
  }));
}

function splitDroppedTails(frames, words) {
  const split = [];
  for (const word of words) {
    const span = word.endIndex - word.startIndex;
    const tailName = /latte/i.test(word.text) ? '-tte' : '';
    if (!tailName || span < 6) {
      split.push(word);
      continue;
    }
    const mid = word.startIndex + Math.floor(span * 0.58);
    const headHz = finiteMedian(frames.slice(word.startIndex, mid).filter(frame => frame.voiced).map(frame => frame.hz));
    const tailHz = finiteMedian(frames.slice(mid, word.endIndex).filter(frame => frame.voiced).map(frame => frame.hz));
    if (Number.isFinite(headHz) && Number.isFinite(tailHz) && headHz - tailHz >= 6) {
      split.push({ text: 'la', startIndex: word.startIndex, endIndex: mid });
      split.push({ text: tailName, startIndex: mid, endIndex: word.endIndex });
    } else split.push(word);
  }
  return split;
}

function wordStats(frames, word) {
  const slice = frames.slice(word.startIndex, word.endIndex);
  const voiced = slice.filter(frame => frame.voiced);
  const pick = key => finiteMedian(voiced.map(frame => frame[key]));
  const fryFrames = voiced.filter(frame => frame.fry >= 0.45).length;
  const fryPeak = voiced.reduce((peak, frame) => Math.max(peak, frame.fry || 0), 0);
  return {
    ...word,
    frames: slice.length,
    voiced: voiced.length,
    hz: pick('hz'),
    f1: pick('f1'),
    f2: pick('f2'),
    f3: pick('f3'),
    vtl: pick('vtl'),
    tilt: pick('tilt'),
    brightness: pick('brightness'),
    resonance: pick('resonance'),
    centroid: pick('centroid'),
    h1h2: pick('h1h2'),
    rms: pick('rms'),
    confidence: pick('confidence'),
    fry: voiced.length ? fryFrames / voiced.length : 0,
    fryPeak,
    unstable: slice.length ? slice.filter(frame => frame.unstable).length / slice.length : 0
  };
}

function addFlag(flags, issue, confidence, evidence) {
  const score = clamp(confidence, 0, 1);
  if (score < 0.34) return;
  flags.push({ issue, confidence: Math.round(score * 100) / 100, evidence, speak: score >= CONFIDENCE_GATE });
}

export function measureWords(analysis, prompt, goal = {}, timings = null) {
  const frames = analysis?.frames || [];
  const aligned = Array.isArray(timings) && timings.length
    ? timings.map(word => ({ text: word.text, startIndex: word.startIndex, endIndex: word.endIndex }))
    : alignWords(frames, prompt);
  const measured = aligned.map(word => wordStats(frames, word));
  const wordPitches = measured.map(word => word.hz).filter(Number.isFinite).sort((a, b) => a - b);
  const highPitch = wordPitches.length ? wordPitches[Math.min(wordPitches.length - 1, Math.ceil((wordPitches.length - 1) * 0.72))] : NaN;
  const bodyPitch = finiteMedian(measured.slice(0, Math.max(1, measured.length - 1)).map(word => word.hz));
  const phraseTilt = finiteMedian(measured.map(word => word.tilt));
  const phraseH1 = finiteMedian(measured.map(word => word.h1h2));
  const phraseResonance = finiteMedian(measured.map(word => word.resonance));
  const phraseF2 = finiteMedian(measured.map(word => word.f2));
  const brightnessFloor = Array.isArray(goal.brightness) ? goal.brightness[0] : -10;
  return measured.map((word, index) => {
    const flags = [];
    const enough = word.voiced >= 1;
    const previousVoiced = [...measured.slice(0, index)].reverse().find(item => Number.isFinite(item.hz));
    if (enough && Number.isFinite(word.hz) && Number.isFinite(highPitch)) {
      const fell = previousVoiced && previousVoiced.hz - word.hz >= 36;
      const ending = index === measured.length - 1 && Number.isFinite(bodyPitch) && bodyPitch - word.hz >= 16;
      const belowHigh = highPitch - word.hz;
      if ((fell || ending) && belowHigh >= 18 && index > 0) {
        addFlag(flags, 'drop', (belowHigh - 8) / 26, `pitch ${Math.round(word.hz)} Hz, phrase high ${Math.round(highPitch)} Hz`);
      }
    }
    if (enough && Number.isFinite(word.f2) && word.f2 < 1500 && (!Number.isFinite(phraseF2) || word.f2 < phraseF2 - 180)) {
      addFlag(flags, 'chesty', (1580 - word.f2) / 420, `F2 ${Math.round(word.f2)} Hz`);
    } else if (enough && Number.isFinite(word.resonance) && word.resonance < -14 && Number.isFinite(phraseResonance) && word.resonance < phraseResonance - 3.5) {
      addFlag(flags, 'chesty', (phraseResonance - word.resonance) / 8, `resonance ${word.resonance.toFixed(1)} dB`);
    }
    if (enough && Number.isFinite(word.vtl) && word.vtl > 16.4) {
      addFlag(flags, 'dark', (word.vtl - 15.6) / 2.2, `vocal tract about ${word.vtl.toFixed(1)} cm`);
    } else if (enough && Number.isFinite(word.centroid) && word.centroid < 700 && Number.isFinite(word.f2) && word.f2 < 1400) {
      addFlag(flags, 'dark', (850 - word.centroid) / 280, `centroid ${Math.round(word.centroid)} Hz`);
    }
    if (enough && flags.some(flag => flag.issue === 'drop') && Number.isFinite(word.tilt) && Number.isFinite(phraseTilt) && word.tilt < phraseTilt - 0.6) {
      addFlag(flags, 'heavy', 0.74, `tilt ${word.tilt.toFixed(1)} dB/octave, heavier than the phrase`);
      if (!flags.some(flag => flag.issue === 'chesty')) addFlag(flags, 'chesty', 0.7, 'darker weight on the dropped word');
    } else if (enough && Number.isFinite(word.tilt) && word.tilt < -8.5 && Number.isFinite(phraseTilt) && word.tilt < phraseTilt - 1.4) {
      addFlag(flags, 'heavy', 0.7, `tilt ${word.tilt.toFixed(1)} dB/octave`);
    }
    const finalWord = index === measured.length - 1 || word.text === '-tte';
    if (word.voiced >= 2 && Number.isFinite(word.hz) && word.hz < 160 && word.fryPeak >= 0.7 && (finalWord || word.fry >= 0.4)) {
      addFlag(flags, 'fry', Math.max(0.7, word.fry), `fry on ${Math.round(word.fry * 100)}% of voiced frames`);
    }
    if (word.frames >= 4 && word.voiced >= 1 && word.unstable >= (index === 0 ? 0.3 : 0.5)) {
      addFlag(flags, 'strain', Math.max(word.unstable, index === 0 ? 0.66 : word.unstable), `unstable onset on ${Math.round(word.unstable * 100)}% of frames`);
    } else if (enough && Number.isFinite(word.h1h2) && word.h1h2 < -4 && Number.isFinite(phraseH1) && word.h1h2 < phraseH1 - 4) {
      addFlag(flags, 'strain', 0.7, `H1-H2 ${word.h1h2.toFixed(1)} dB`);
    }
    if (Number.isFinite(word.brightness) && word.brightness < brightnessFloor - 8 && flags.some(flag => flag.issue === 'chesty' || flag.issue === 'heavy')) {
      const heavy = flags.find(flag => flag.issue === 'heavy');
      if (heavy) heavy.confidence = Math.max(heavy.confidence, 0.7);
    }
    return { ...word, flags };
  });
}

export function applyEar(words, ear, { tooNoisy = false } = {}) {
  if (tooNoisy || !ear || !words.length) return words;
  const strained = Number(ear.strained);
  const chesty = Number(ear.chesty);
  const heavy = Number(ear.heavy);
  const fry = Number(ear.fry);
  const decorated = words.map(word => ({ ...word, flags: word.flags.map(flag => ({ ...flag })) }));
  const boost = (issue, probability, pick) => {
    if (!(probability >= CONFIDENCE_GATE)) return;
    const word = pick(decorated);
    if (!word) return;
    const existing = word.flags.find(flag => flag.issue === issue);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, Math.round(probability * 100) / 100);
      existing.speak = existing.confidence >= CONFIDENCE_GATE;
      existing.evidence = `${existing.evidence}; ear ${probability.toFixed(2)}`;
      return;
    }
    const acoustic = word.flags.some(flag => flag.confidence >= 0.34) || word.unstable >= 0.25 || word.fry >= 0.25;
    if (!acoustic) return;
    word.flags.push({ issue, confidence: Math.round(probability * 100) / 100, evidence: `ear ${probability.toFixed(2)}`, speak: true });
  };
  boost('strain', strained, list => [...list].sort((a, b) => b.unstable - a.unstable)[0]);
  boost('chesty', chesty, list => [...list].filter(word => word.flags.some(flag => flag.issue === 'drop' || flag.issue === 'chesty')).sort((a, b) => (a.f2 || 9999) - (b.f2 || 9999))[0]);
  boost('heavy', heavy, list => [...list].filter(word => word.flags.some(flag => flag.issue === 'drop' || flag.issue === 'heavy')).sort((a, b) => (a.tilt || 0) - (b.tilt || 0))[0]);
  boost('fry', fry, list => [...list].sort((a, b) => b.fry - a.fry)[0]);
  return decorated;
}

function spokenIssues(word) {
  return ISSUE_ORDER.filter(issue => word.flags.some(flag => flag.issue === issue && flag.speak));
}

export function composeFeedback({ words = [], tooNoisy = false, previous = null, cursor = 0, cleared = [] } = {}) {
  if (tooNoisy) {
    return { text: cueLine('noisy', cursor), issue: 'noisy', word: '', cursor: cursor + 1, spoken: false };
  }
  const candidates = [];
  for (const word of words) {
    const issues = spokenIssues(word);
    if (issues.length) candidates.push({ word, issues });
  }
  if (!candidates.length) {
    const improved = cleared.find(item => item.word);
    if (improved) {
      return { text: fillWord(IMPROVED(cursor), improved.word), issue: 'held', word: improved.word, cursor: cursor + 1, spoken: false };
    }
    const clean = words.find(word => word.voiced >= 3 && !word.flags.some(flag => flag.speak));
    if (clean && cursor % 3 === 2) {
      return { text: fillWord(PRAISE(cursor), clean.text), issue: 'held', word: clean.text, cursor: cursor + 1, spoken: false };
    }
    return { text: cueLine('held', cursor), issue: 'held', word: '', cursor: cursor + 1, spoken: false };
  }
  candidates.sort((a, b) => ISSUE_ORDER.indexOf(a.issues[0]) - ISSUE_ORDER.indexOf(b.issues[0]));
  const chosen = candidates[0];
  const lead = chosen.issues.slice(0, 2);
  const sentence = `${chosen.word.text} ${problemPhrase(lead)}. ${cueLine(lead[0], cursor)}`;
  return { text: sentence, issue: lead[0], word: chosen.word.text, cursor: cursor + 1, spoken: true };
}

function PRAISE(cursor) {
  return ["Nice lift on '{word}'.", "'{word}' stayed easy.", "Good, '{word}' held."][Math.abs(cursor) % 3];
}
function IMPROVED(cursor) {
  return ["'{word}' is better than last time.", "That '{word}' improved.", "'{word}' held this time."][Math.abs(cursor) % 3];
}

export function parseEar(answers) {
  const read = key => {
    const value = answers?.[key];
    if (typeof value === 'number') return value;
    const noul = value?.noul ?? value?.probability;
    return Number.isFinite(noul) ? noul : null;
  };
  return {
    feminine: read('feminine'),
    masculine: read('masculine'),
    chesty: read('chesty'),
    heavy: read('heavy'),
    strained: read('strained'),
    fry: read('fry'),
    drop: read('drop')
  };
}

export function profilePhrase(analysis, ear = null) {
  const frames = (analysis?.frames || []).filter(frame => frame.voiced);
  const hz = finiteMedian(frames.map(frame => frame.hz));
  const f2 = finiteMedian(frames.map(frame => frame.f2));
  const vtl = finiteMedian(frames.map(frame => frame.vtl));
  const tilt = finiteMedian(frames.map(frame => frame.tilt));
  const resonance = finiteMedian(frames.map(frame => frame.resonance));
  const centroid = finiteMedian(frames.map(frame => frame.centroid));
  const f0Term = Number.isFinite(hz) ? clamp((hz - 165) / 55, -1.4, 1.4) : 0;
  const f2Term = Number.isFinite(f2) ? clamp((f2 - 1550) / 400, -1.4, 1.4) : 0;
  const vtlTerm = Number.isFinite(vtl) ? clamp((15.6 - vtl) / 1.8, -1.4, 1.4) : 0;
  const tiltTerm = Number.isFinite(tilt) ? clamp((tilt - (-7.5)) / 3.5, -1.4, 1.4) : 0;
  const resonanceTerm = Number.isFinite(resonance)
    ? clamp((resonance - (-12)) / 8, -1.4, 1.4)
    : (Number.isFinite(centroid) ? clamp((centroid - 1100) / 450, -1.4, 1.4) : 0);
  const acousticLogit = 0.55 * f2Term + 0.5 * vtlTerm + 0.4 * resonanceTerm + 0.32 * tiltTerm + 0.22 * f0Term;
  let probability = sigmoid(acousticLogit);
  const pitchOnly = sigmoid(Number.isFinite(hz) ? (hz - 165) / 22 : 0);
  const feminine = Number(ear?.feminine);
  const masculine = Number(ear?.masculine);
  let usedEar = false;
  if (feminine >= CONFIDENCE_GATE || masculine >= CONFIDENCE_GATE) {
    const earProbability = feminine >= CONFIDENCE_GATE ? feminine : 1 - masculine;
    probability = 0.65 * probability + 0.35 * clamp(earProbability, 0, 1);
    usedEar = true;
  }
  const label = probability >= 0.6 ? 'feminine' : probability <= 0.4 ? 'masculine' : 'androgynous';
  const pitchLabel = pitchOnly >= 0.62 ? 'feminine' : pitchOnly <= 0.38 ? 'masculine' : 'androgynous';
  return {
    label,
    probability: Math.round(probability * 1000) / 1000,
    pitchOnly: pitchLabel,
    pitchProbability: Math.round(pitchOnly * 1000) / 1000,
    usedEar,
    features: {
      hz: round(hz),
      f2: round(f2),
      vtl: round(vtl),
      tilt: round(tilt),
      resonance: round(resonance),
      centroid: round(centroid)
    }
  };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

export function classifyUtterance({ analysis, prompt, goal, ear, previousWords = [], cursor = 0, timings = null }) {
  const tooNoisy = analysis && Object.prototype.hasOwnProperty.call(analysis, 'tooNoisy')
    ? !!analysis.tooNoisy
    : !!((Number.isFinite(analysis?.snrDb) && analysis.snrDb < 11) || analysis?.voicedFraction < 0.12);
  let words = measureWords(analysis, prompt, goal, timings);
  words = applyEar(words, ear, { tooNoisy });
  if (tooNoisy) words = words.map(word => ({ ...word, flags: word.flags.map(flag => ({ ...flag, speak: false })) }));
  const cleared = [];
  if (previousWords.length) {
    for (const word of words) {
      const prior = previousWords.find(item => item.text === word.text);
      if (!prior) continue;
      const priorIssues = new Set((prior.flags || []).filter(flag => flag.speak).map(flag => flag.issue));
      const now = new Set(spokenIssues(word));
      for (const issue of priorIssues) if (!now.has(issue)) cleared.push({ word: word.text, issue });
    }
  }
  const feedback = composeFeedback({ words, tooNoisy, previous: previousWords, cursor, cleared });
  const profile = profilePhrase(analysis, tooNoisy ? null : ear);
  const confident = words.flatMap(word => word.flags.filter(flag => flag.speak).map(flag => ({ word: word.text, ...flag })));
  return { tooNoisy, words, feedback, profile, confident, cleared };
}

const COMMANDS = [
  { name: 'next', pattern: /^(next|skip)$/ },
  { name: 'repeat', pattern: /^(repeat|again)$/ },
  { name: 'pause', pattern: /^pause$/ },
  { name: 'stop', pattern: /^(stop|finish|done)$/ },
  { name: 'resume', pattern: /^(start|resume|continue)$/ },
  { name: 'summary', pattern: /^(how am i doing|how am i doing\?)$/ },
  { name: 'free', pattern: /^(free talk|free)$/ },
  { name: 'lines', pattern: /^(lines|prompts|back to lines)$/ }
];

export function matchCommand(text, { paused = false } = {}) {
  const normalized = String(text || '').toLowerCase().replace(/[^a-z\s?]/g, ' ').replace(/\s+/g, ' ').trim();
  const found = COMMANDS.find(command => command.pattern.test(normalized));
  if (!found) return null;
  if (found.name === 'resume' && !paused) return null;
  return found.name;
}

export function coachMinutes(elapsedMs) {
  if (elapsedMs < 20000) return 0;
  return clamp(Math.round(elapsedMs / 60000), 1, 120);
}

export function createCoachSession({
  plannedMinutes = 30,
  routineId = 'week-1',
  lines = [],
  now = Date.now(),
  id = ''
} = {}) {
  const sessionId = id || `coach-${now}`;
  let mode = 'lines';
  let lineIndex = 0;
  let paused = false;
  let stopped = false;
  let cursor = 0;
  let comfort = null;
  let comfortKnown = false;
  let comfortPaused = false;
  let restSuggested = false;
  let fryStrainStreak = 0;
  let cleanPhrases = 0;
  let coachedPhrases = 0;
  let phraseCount = 0;
  let cueHeld = 'partly';
  let summary = '';
  let lastComfortAt = now;
  let startedAt = now;
  let clock = now;
  const phrases = [];
  const pendingSaves = [];
  let checks = 0;

  function prompt() {
    if (mode === 'free') return '';
    if (!lines.length) return '';
    return lines[lineIndex % lines.length];
  }

  function remember(entry) {
    phrases.push(entry);
    if (phrases.length > MEMORY_PHRASES) phrases.shift();
  }

  function recomputeCue() {
    if (!phraseCount) {
      cueHeld = 'partly';
      return;
    }
    const ratio = cleanPhrases / phraseCount;
    cueHeld = ratio >= 0.7 ? 'yes' : ratio >= 0.35 ? 'partly' : 'no';
  }

  function logEntry(at = clock) {
    const minutes = coachMinutes(at - startedAt);
    const saved = phrases.slice(-SAVED_PHRASES).map(phrase => ({
      prompt: phrase.prompt.slice(0, 180),
      transcript: phrase.transcript.slice(0, 180),
      feedback: phrase.feedback.slice(0, 240),
      profile: PROFILE_LABELS.includes(phrase.profile) ? phrase.profile : 'androgynous',
      tooNoisy: !!phrase.tooNoisy,
      words: phrase.words.slice(0, SAVED_WORDS).map(word => ({
        text: String(word.text || '').slice(0, 32),
        flags: (word.flags || []).filter(flag => ISSUE_ORDER.includes(flag)).slice(0, 4)
      }))
    }));
    return {
      id: sessionId,
      date: new Date(at).toISOString(),
      routineId,
      plannedMinutes: [20, 30, 40].includes(plannedMinutes) ? plannedMinutes : 30,
      actualMinutes: Math.max(minutes, minutes === 0 ? 0 : minutes),
      comfort: comfort ?? 3,
      cueHeld,
      kind: 'coach',
      coach: {
        minutes,
        mode,
        comfortKnown,
        comfortPaused,
        restSuggested,
        summary: summary.slice(0, 240),
        phrases: saved
      }
    };
  }

  return {
    id: sessionId,
    prompt,
    status() {
      return { paused, stopped, mode, lineIndex, cursor, comfort, comfortKnown, restSuggested, phraseCount, phrases: phrases.length };
    },
    noteAnalysis(result, { transcript = '', at = Date.now() } = {}) {
      clock = at;
      if (paused || stopped) return { ignored: true };
      phraseCount += 1;
      coachedPhrases += result.feedback?.spoken ? 1 : 0;
      const strainy = result.confident?.some(flag => flag.issue === 'strain' || flag.issue === 'fry');
      fryStrainStreak = strainy ? fryStrainStreak + 1 : 0;
      if (!result.feedback?.spoken && !result.tooNoisy) cleanPhrases += 1;
      recomputeCue();
      cursor = result.feedback?.cursor ?? cursor + 1;
      const entry = {
        prompt: prompt(),
        transcript: transcript || prompt(),
        feedback: result.feedback?.text || '',
        profile: result.profile?.label || 'androgynous',
        tooNoisy: !!result.tooNoisy,
        words: (result.words || []).map(word => ({
          text: word.text,
          flags: (word.flags || []).filter(flag => flag.speak).map(flag => flag.issue)
        }))
      };
      remember(entry);
      summary = spokenSummary();
      const elapsedMin = (at - startedAt) / 60000;
      const events = [{ type: 'feedback', text: entry.feedback, entry }];
      if (at - lastComfortAt >= 4 * 60000) {
        lastComfortAt = at;
        events.push({ type: 'comfort-check', text: 'Quick comfort check. Say a number from one to five.' });
      }
      if (!restSuggested && (elapsedMin >= 20 || fryStrainStreak >= 3)) {
        restSuggested = true;
        events.push({ type: 'rest', text: 'You have been at this a while. A short rest would be kind. Say stop if you want to save and pause.' });
      }
      if (phraseCount % 4 === 0) pendingSaves.push(logEntry(at));
      return { events, entry };
    },
    hear(text, at = Date.now()) {
      clock = at;
      const command = matchCommand(text, { paused });
      if (!command) return { type: 'speech', text };
      return this.command(command, at);
    },
    command(name, at = Date.now()) {
      clock = at;
      if (name === 'pause') {
        paused = true;
        return { type: 'pause', say: 'Paused. Say resume when you want to continue.' };
      }
      if (name === 'resume') {
        if (!paused || stopped) return { type: 'speech' };
        paused = false;
        return { type: 'resume', say: 'Back with you.' };
      }
      if (name === 'stop') {
        stopped = true;
        paused = true;
        const entry = logEntry(at);
        if (entry.actualMinutes >= 1) pendingSaves.push(entry);
        return { type: 'stop', say: 'Stopping. I saved this drive.', entry };
      }
      if (name === 'next') {
        lineIndex += 1;
        return { type: 'next', say: prompt() ? `Next. ${prompt()}` : 'Next line.' };
      }
      if (name === 'repeat') return { type: 'repeat', say: prompt() ? `Again. ${prompt()}` : 'Say that once more.' };
      if (name === 'summary') return { type: 'summary', say: spokenSummary() };
      if (name === 'free') {
        mode = 'free';
        return { type: 'free', say: 'Free talk. I will coach whatever you say. Say lines when you want the prompts back.' };
      }
      if (name === 'lines') {
        mode = 'lines';
        return { type: 'lines', say: prompt() ? `Back to lines. ${prompt()}` : 'Back to lines.' };
      }
      return { type: 'speech' };
    },
    comfortReply(text, at = Date.now()) {
      const match = String(text || '').toLowerCase().match(/\b(one|two|three|four|five|[1-5])\b/);
      if (!match) return null;
      const map = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      comfort = map[match[1]] || Number(match[1]);
      comfortKnown = true;
      if (shouldPauseForComfort(comfort)) {
        comfortPaused = true;
        stopped = true;
        paused = true;
        const entry = logEntry(at);
        pendingSaves.push(entry);
        return { type: 'comfort-pause', say: 'That is a low comfort score, so I am stopping here. Rest your voice.', entry };
      }
      return { type: 'comfort', say: 'Thank you. Keep it easy.' };
    },
    interrupt(reason = 'audio') {
      paused = true;
      return { type: 'interrupted', reason, say: '' };
    },
    resumeAfterInterrupt() {
      if (stopped) return { type: 'stopped' };
      paused = false;
      return { type: 'resumed', say: 'I am listening again.' };
    },
    queueSave(entry = logEntry()) {
      pendingSaves.push(entry);
      return pendingSaves.length;
    },
    flushSaves(online = true) {
      if (!online) return { sent: [], queued: pendingSaves.length };
      const sent = pendingSaves.splice(0, pendingSaves.length);
      return { sent, queued: 0 };
    },
    logEntry() {
      const entry = logEntry();
      if (entry.actualMinutes < 1) return null;
      return entry;
    },
    checkpoint(at = Date.now()) {
      checks += 1;
      const entry = logEntry(at);
      return { id: entry.id, phrases: entry.coach.phrases.length, minutes: entry.coach.minutes, memoryPhrases: phrases.length, checks };
    }
  };

  function spokenSummary() {
    if (!phraseCount) return 'Nothing to report yet.';
    const noisy = phrases.filter(phrase => phrase.tooNoisy).length;
    return `${phraseCount} phrases. ${cleanPhrases} held, ${coachedPhrases} had a note${noisy ? `, ${noisy} too noisy to coach` : ''}.`;
  }
}

export function scoreFlags(cases) {
  const categories = ['strain', 'fry', 'drop', 'heavy', 'chesty', 'dark'];
  const totals = Object.fromEntries(categories.map(category => [category, { tp: 0, fp: 0, fn: 0 }]));
  let naggedClean = 0;
  let cleanWords = 0;
  for (const item of cases) {
    const expected = new Set(item.expected || []);
    const flagged = new Set((item.flags || []).filter(flag => flag.speak !== false).map(flag => flag.issue || flag));
    if (!expected.size) {
      cleanWords += 1;
      if (flagged.size) naggedClean += 1;
    }
    for (const category of categories) {
      const want = expected.has(category);
      const got = flagged.has(category);
      if (want && got) totals[category].tp += 1;
      else if (got && !want) totals[category].fp += 1;
      else if (want && !got) totals[category].fn += 1;
    }
  }
  const rows = categories.map(category => {
    const { tp, fp, fn } = totals[category];
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    return { category, tp, fp, fn, precision, recall };
  });
  return { rows, naggedClean, cleanWords };
}

export function confusion(pairs) {
  const labels = ['masculine', 'androgynous', 'feminine'];
  const matrix = Object.fromEntries(labels.map(label => [label, Object.fromEntries(labels.map(item => [item, 0]))]));
  let correct = 0;
  const failures = [];
  for (const pair of pairs) {
    const actual = labels.includes(pair.actual) ? pair.actual : 'androgynous';
    const predicted = labels.includes(pair.predicted) ? pair.predicted : 'androgynous';
    matrix[actual][predicted] += 1;
    if (actual === predicted) correct += 1;
    else if (failures.length < 12) failures.push(pair);
  }
  return { matrix, correct, total: pairs.length, accuracy: pairs.length ? correct / pairs.length : 0, failures };
}
