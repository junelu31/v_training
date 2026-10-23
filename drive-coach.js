import { median } from './drive-dsp.js';
import { CUE_LIBRARY, cueLine, fillWord, problemPhrase, ISSUE_ORDER, IMPROVED_LINES } from './drive-cues.js';
import { createDriveSession } from './drive-session.js';
import { AURORA_SWITCH_LINES, COACH_VOICE, PRACTICE_VOICE } from './drive-voice.js';

export { createDriveSession };

export const CONFIDENCE_GATE = 0.62;
// A phrase is left after a clean pass, or after this many judged tries.
export const MAX_PHRASE_ATTEMPTS = 3;
const MEMORY_PHRASES = 24;
const SAVED_PHRASES = 30;
const SAVED_WORDS = 16;

const PROFILE_LABELS = ['masculine', 'androgynous', 'feminine', 'unsure'];
// Fit on the calibration half of train-clean-100 only (see scripts/profile-split.mjs).
// Median F2 on voiced vowels, with the part predicted by F0 removed.
// On that split, F3 and spectral tilt added nothing once F0 was accounted for.
// |residual| p90 is 233 Hz, so smaller gaps stay with pitch.
// A confident pitch read is flipped only past 320 Hz, above the p95 (267 Hz).
// A lower floor scored higher on the calibration speakers and was rejected:
// on the held-out speakers it added opposite-gender mistakes.
const F2_FROM_F0 = { intercept: 1380, slope: 0.465 };
const RESIDUAL_FLOOR = 230;
const RESIDUAL_OVERRIDE = 320;
const PROFILE_SURE = 0.62;

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

function estimateSyllables(word) {
  const cleaned = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!cleaned) return 1;
  const groups = cleaned.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;
  if (cleaned.endsWith('e') && count > 1 && !cleaned.endsWith('le')) count -= 1;
  return Math.max(1, count);
}

/**
 * Grades one practice line from the text already in the bank.
 * Shorter statements are easier. Questions, extra clauses, and consonant
 * clusters add difficulty. The band is a tag; the score is the sort key.
 */
export function phraseDifficulty(phrase) {
  const text = String(phrase || '');
  const words = tokenizePrompt(text);
  const syllables = words.reduce((sum, word) => sum + estimateSyllables(word), 0);
  const questions = /\?/.test(text) ? 1 : 0;
  const clauses = (text.match(/[,;:]/g) || []).length;
  const clusters = (text.toLowerCase().match(/[bcdfghjklmnpqrstvwxz]{3,}/g) || []).length;
  const score = words.length * 3 + syllables + questions * 6 + clauses * 4 + clusters * 2;
  // Cut points sit on the week-1 bank: short lines, everyday sentences, then the long ones.
  const band = score <= 36 ? 'easy' : score <= 49 ? 'medium' : 'hard';
  return { score, band, words: words.length, syllables };
}

/** Easiest first. Equal scores keep the original order. */
export function orderPracticePhrases(phrases) {
  return (Array.isArray(phrases) ? phrases : [])
    .map((phrase, index) => ({ phrase, index, ...phraseDifficulty(phrase) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(item => item.phrase);
}

/** Acoustic name already used by the coach, plus the short problem line. Not a new phonetic model. */
export function wordPhonetics(issue) {
  const name = CUE_LIBRARY[issue]?.name || '';
  const how = problemPhrase(issue ? [issue] : []);
  if (name && how) return `${name}: ${how}`;
  return name || how || '';
}

/** Leave the phrase after a clean pass or once the attempt cap is used. Free talk stays put. */
export function shouldLeavePhrase({ ignored = false, passed = false, attempts = 0, mode = 'lines' } = {}) {
  if (ignored || mode !== 'lines') return false;
  return Boolean(passed) || attempts >= MAX_PHRASE_ATTEMPTS;
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
    f2Local: pick('f2Local'),
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
    unstable: slice.length ? slice.filter(frame => frame.unstable).length / slice.length : 0,
    startHz: finiteMedian(voiced.slice(0, Math.max(1, Math.ceil(voiced.length * 0.35))).map(frame => frame.hz)),
    endHz: finiteMedian(voiced.slice(Math.floor(voiced.length * 0.7)).map(frame => frame.hz)),
    breath: voiced.length ? voiced.filter(frame => frame.h1h2 > 8 || frame.breathy).length / voiced.length : 0
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
  const phraseVtl = finiteMedian(measured.map(word => word.vtl));
  const phraseCentroid = finiteMedian(measured.map(word => word.centroid));
  const brightnessFloor = Array.isArray(goal.brightness) ? goal.brightness[0] : -10;
  return measured.map((word, index) => {
    const flags = [];
    const enough = word.voiced >= 1;
    const smoothFall = Number.isFinite(word.startHz) && Number.isFinite(word.endHz)
      && word.startHz - word.endHz >= 36 && word.startHz >= 160 && word.endHz <= 150;
    const previousVoiced = [...measured.slice(0, index)].reverse().find(item => Number.isFinite(item.hz));
    if (enough && smoothFall) {
      addFlag(flags, 'drop', 0.8, `pitch fell from ${Math.round(word.startHz)} Hz to ${Math.round(word.endHz)} Hz at the end of the word`);
    }
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
    // VTL is 43750/F3, about 17 cm for a typical adult, so an absolute cutoff flags the whole phrase.
    if (enough && Number.isFinite(word.vtl) && Number.isFinite(phraseVtl) && word.vtl > phraseVtl + 1.4) {
      addFlag(flags, 'dark', (word.vtl - phraseVtl) / 2.2, `vocal tract about ${word.vtl.toFixed(1)} cm`);
    } else if (enough && Number.isFinite(word.centroid) && Number.isFinite(phraseCentroid) && word.centroid < phraseCentroid - 180 && Number.isFinite(word.f2) && Number.isFinite(phraseF2) && word.f2 < phraseF2 - 180) {
      addFlag(flags, 'dark', (phraseCentroid - word.centroid) / 280, `centroid ${Math.round(word.centroid)} Hz`);
    }
    if (enough && flags.some(flag => flag.issue === 'drop') && Number.isFinite(word.tilt) && Number.isFinite(phraseTilt) && word.tilt < phraseTilt - 0.6) {
      addFlag(flags, 'heavy', 0.74, `tilt ${word.tilt.toFixed(1)} dB/octave, heavier than the phrase`);
      if (!flags.some(flag => flag.issue === 'chesty')) addFlag(flags, 'chesty', 0.7, 'darker weight on the dropped word');
    } else if (enough && Number.isFinite(word.tilt) && word.tilt < -8.5 && Number.isFinite(phraseTilt) && word.tilt < phraseTilt - 1.4) {
      addFlag(flags, 'heavy', 0.7, `tilt ${word.tilt.toFixed(1)} dB/octave`);
    }
    const finalWord = index === measured.length - 1 || word.text === '-tte';
    if (!smoothFall && word.voiced >= 2 && Number.isFinite(word.hz) && word.hz < 160 && word.fryPeak >= 0.7 && (finalWord || word.fry >= 0.4)) {
      addFlag(flags, 'fry', Math.max(0.7, word.fry), `fry on ${Math.round(word.fry * 100)}% of voiced frames`);
    }
    const formant = Number.isFinite(word.f2Local) ? word.f2Local : word.f2;
    if (enough && !smoothFall && word.voiced >= 4 && Number.isFinite(word.hz) && word.hz < 145 && Number.isFinite(formant) && formant >= 1600 && !flags.some(flag => flag.issue === 'fry' || flag.issue === 'drop')) {
      addFlag(flags, 'low', 0.74, `pitch ${Math.round(word.hz)} Hz with F2 ${Math.round(formant)} Hz`);
    }
    if (enough && word.breath >= 0.5 && !flags.some(flag => flag.speak || flag.confidence >= CONFIDENCE_GATE)) {
      addFlag(flags, 'breath', 0.7, 'breathy frames through the word');
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

/** "June and please", or "June, ready, and please". */
export function joinIssueWords(texts) {
  const words = texts.map(text => String(text || '').trim()).filter(Boolean);
  if (words.length <= 1) return words[0] || '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

export function composeFeedback({ words = [], tooNoisy = false, previous = null, cursor = 0, cleared = [], voice = COACH_VOICE } = {}) {
  if (tooNoisy) {
    return { text: cueLine('noisy', cursor, voice), issue: 'noisy', word: '', cursor: cursor + 1, spoken: false };
  }
  const groups = new Map();
  for (const word of words) {
    if (word.heard === false) continue;
    const issues = spokenIssues(word);
    if (!issues.length) continue;
    const issue = issues[0];
    if (!groups.has(issue)) groups.set(issue, []);
    groups.get(issue).push(word);
  }
  if (!groups.size) {
    const improved = cleared.find(item => item.word && item.heard !== false);
    if (improved) {
      return { text: fillWord(IMPROVED(cursor), improved.word), issue: 'held', word: improved.word, cursor: cursor + 1, spoken: false };
    }
    return { text: '', issue: 'held', word: '', cursor: cursor + 1, spoken: false };
  }
  const issue = ISSUE_ORDER.find(item => groups.has(item));
  const group = groups.get(issue);
  const names = joinIssueWords(group.map(word => word.text));
  const sentence = `${names} ${problemPhrase([issue])}. ${cueLine(issue, cursor, voice)}`;
  return {
    text: sentence,
    issue,
    word: group[0].text,
    words: group.map(word => word.text),
    cursor: cursor + 1,
    spoken: true
  };
}

function IMPROVED(cursor) {
  return IMPROVED_LINES[Math.abs(cursor) % IMPROVED_LINES.length];
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

function formantSpread(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 4) return null;
  const mid = finiteMedian(finite);
  return finiteMedian(finite.map(value => Math.abs(value - mid)));
}

export function profilePhrase(analysis, ear = null) {
  const voiced = (analysis?.frames || []).filter(frame => frame.voiced && Number.isFinite(frame.hz));
  const vowels = (analysis?.frames || []).filter(frame => frame.voiced && frame.vowel !== false && Number.isFinite(frame.f2));
  const hz = finiteMedian(voiced.map(frame => frame.hz));
  const f2 = finiteMedian(vowels.map(frame => frame.f2));
  const f3 = finiteMedian(vowels.map(frame => frame.f3));
  const vtl = finiteMedian(vowels.map(frame => frame.vtl));
  const tilt = finiteMedian(voiced.map(frame => frame.tilt));
  const resonance = finiteMedian(voiced.map(frame => frame.resonance));
  const centroid = finiteMedian(voiced.map(frame => frame.centroid));
  const f3Spread = formantSpread(vowels.map(frame => frame.f3));
  const pitchOnly = sigmoid(Number.isFinite(hz) ? (hz - 165) / 22 : 0);
  const pitchLabel = pitchOnly >= 0.62 ? 'feminine' : pitchOnly <= 0.38 ? 'masculine' : 'androgynous';
  const reliable = voiced.length >= 6 && vowels.length >= 6 && Number.isFinite(hz) && Number.isFinite(f2) && !(f3Spread > 900);
  const features = {
    hz: round(hz),
    f2: round(f2),
    f3: round(f3),
    vtl: round(vtl),
    tilt: round(tilt),
    resonance: round(resonance),
    centroid: round(centroid),
    vowels: vowels.length
  };
  if (!reliable) {
    return {
      label: 'unsure',
      probability: null,
      pitchOnly: pitchLabel,
      pitchProbability: Math.round(pitchOnly * 1000) / 1000,
      usedEar: false,
      features
    };
  }
  const residual = f2 - (F2_FROM_F0.intercept + F2_FROM_F0.slope * hz);
  const absResidual = Math.abs(residual);
  const residualTerm = absResidual >= RESIDUAL_FLOOR ? clamp(residual / 160, -1.6, 1.6) : 0;
  let probability = sigmoid((hz - 165) / 22 + 1.3 * residualTerm);
  const feminine = Number(ear?.feminine);
  const masculine = Number(ear?.masculine);
  let usedEar = false;
  if (feminine >= CONFIDENCE_GATE || masculine >= CONFIDENCE_GATE) {
    const earProbability = feminine >= CONFIDENCE_GATE ? feminine : 1 - masculine;
    probability = 0.65 * probability + 0.35 * clamp(earProbability, 0, 1);
    usedEar = true;
  }
  let label = probability >= PROFILE_SURE ? 'feminine' : probability <= 1 - PROFILE_SURE ? 'masculine' : 'unsure';
  const pitchConfident = pitchLabel === 'feminine' || pitchLabel === 'masculine';
  if (!usedEar && pitchConfident && label !== pitchLabel && label !== 'unsure' && absResidual < RESIDUAL_OVERRIDE) {
    label = 'unsure';
  }
  return {
    label,
    probability: Math.round(probability * 1000) / 1000,
    pitchOnly: pitchLabel,
    pitchProbability: Math.round(pitchOnly * 1000) / 1000,
    usedEar,
    features: { ...features, residual: round(residual) }
  };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

const FRAME_HOP_SEC = 0.02;

function frameHopSec(frames) {
  const times = frames.map(frame => frame.t).filter(Number.isFinite);
  if (times.length < 2) return FRAME_HOP_SEC;
  const gaps = [];
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap > 0.005 && gap < 0.08) gaps.push(gap);
  }
  if (!gaps.length) return FRAME_HOP_SEC;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Prompt words this take can actually have produced. A cloud transcript drops
 * any prompt word it did not hear. A short recording drops later prompt words
 * even when the recognizer completes the sentence.
 */
export function heardPrompt(prompt, { transcript = '', frames = [] } = {}) {
  const tokens = tokenizePrompt(prompt);
  if (!tokens.length) return '';
  const said = tokenizePrompt(transcript);
  const voiced = frames.filter(frame => frame.voiced || frame.unstable).length;
  const voicedMs = voiced * frameHopSec(frames) * 1000;
  const limit = voiced ? Math.max(1, Math.floor(voicedMs / 150)) : tokens.length;
  let kept = tokens;
  if (said.length) {
    const lowered = said.map(word => word.toLowerCase());
    const matched = [];
    let cursor = 0;
    for (const token of tokens) {
      const key = token.toLowerCase();
      let at = -1;
      for (let index = cursor; index < lowered.length; index++) {
        if (lowered[index] === key) { at = index; break; }
      }
      if (at < 0) continue;
      matched.push(token);
      cursor = at + 1;
    }
    if (!matched.length) return '';
    kept = matched.length < tokens.length ? matched : tokens;
  }
  if (voiced && limit < kept.length) kept = kept.slice(0, limit);
  return kept.join(' ');
}

/** Voiced time a finished reading of this prompt usually takes, for the turn detector. */
export function expectedVoicedMs(prompt) {
  const count = tokenizePrompt(prompt).length;
  if (!count) return 0;
  return Math.min(9000, count * 170 + 120);
}

export function classifyUtterance({ analysis, prompt, goal, ear, previousWords = [], cursor = 0, timings = null, transcript = '', voice = COACH_VOICE } = {}) {
  const tooNoisy = analysis && Object.prototype.hasOwnProperty.call(analysis, 'tooNoisy')
    ? !!analysis.tooNoisy
    : !!((Number.isFinite(analysis?.snrDb) && analysis.snrDb < 11) || analysis?.voicedFraction < 0.12);
  const frames = analysis?.frames || [];
  const explicitTimings = Array.isArray(timings) && timings.length;
  const usable = explicitTimings ? prompt : heardPrompt(prompt, { transcript, frames });
  let words = measureWords(analysis, usable, goal, explicitTimings ? timings : null);
  if (!explicitTimings) {
    words = words.filter(word => word.voiced >= 2 && Number.isFinite(word.end) && Number.isFinite(word.start) && word.end - word.start >= 0.09);
  }
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
  const feedback = composeFeedback({ words, tooNoisy, previous: previousWords, cursor, cleared, voice });
  const profile = profilePhrase(analysis, tooNoisy ? null : ear);
  const confident = words.flatMap(word => word.flags.filter(flag => flag.speak).map(flag => ({ word: word.text, ...flag })));
  return { tooNoisy, words, feedback, profile, confident, cleared };
}

// Whole utterances only. A longer practice sentence is not a command, even if it
// contains one of these words. Fillers are removed before the lookup.
const COACH_COMMANDS = [
  { name: 'next', phrases: [
    'next', 'skip', 'next phrase', 'next one', 'next line',
    'skip this', 'skip it', 'skip this one', 'skip this phrase', 'skip this line',
    'skip the phrase', 'skip the line', 'skip ahead',
    'go next', 'go to the next', 'go to the next one', 'go to the next phrase', 'go to the next line',
    'do next', 'do the next', 'do the next one', 'do the next phrase', 'do the next line',
    'on to the next', 'on to the next one', 'on to the next phrase',
    'onto the next', 'onto the next one', 'onto the next phrase',
    'move on', 'move on to the next', 'move on to the next one', 'move on to the next phrase',
    'give me the next', 'give me the next one', 'give me the next phrase', 'give me the next line'
  ]},
  { name: 'repeat', phrases: [
    'repeat', 'again', 'repeat that', 'repeat it', 'repeat this',
    'repeat the phrase', 'repeat the line', 'repeat the prompt',
    'say it again', 'say that again', 'say this again',
    'say it one more time', 'say that one more time', 'say this one more time',
    'say the phrase again', 'say the line again',
    'one more time', 'once more', 'one more',
    'do it again', 'do that again', 'try again', 'try it again', 'try that again',
    'try that one more time', 'come again', 'read it again', 'say that once more'
  ]},
  { name: 'pause', phrases: [
    'pause', 'pause the coach', 'pause coach', 'hold on', 'hang on',
    'wait', 'wait a second', 'wait a minute', 'wait a moment',
    'pause for a second', 'pause for a minute', 'pause for a moment',
    'take a break', 'give me a second', 'give me a minute'
  ]},
  { name: 'stop', phrases: [
    'stop', 'finish', 'done', 'stop the coach', 'stop coach', 'stop the session',
    'end the coach', 'end the session', 'finish the coach', 'finish up', 'stop for now',
    'end practice', 'end the practice', 'end this practice',
    'stop practice', 'stop the practice', 'finish practice', 'finish the practice',
    'save and stop', "i'm done", 'i am done', 'im done',
    "i'm finished", 'i am finished', 'im finished',
    "i'm done for now", 'i am done for now', 'done for now',
    "that's enough", 'thats enough', 'that is enough',
    "we're done", 'we are done', 'were done', "i'm stopping"
  ]},
  { name: 'resume', phrases: [
    'resume', 'start', 'continue', 'keep going', 'start again',
    'resume the coach', 'continue the coach', 'start the coach', 'unpause',
    "i'm ready", 'i am ready', 'im ready', 'ready',
    "let's go", 'lets go', 'go ahead', "i'm back", 'i am back', 'im back'
  ]},
  { name: 'summary', phrases: [
    'how am i doing', 'how am i doing so far', 'how am i doing today', 'how am i',
    "how's it going", 'hows it going', 'how is it going', "how's it going so far", 'hows it going so far',
    'how did i do', 'how did that go',
    "what's my progress", 'whats my progress', 'what is my progress', 'how is my voice'
  ]},
  { name: 'free', phrases: [
    'free talk', 'free', 'free talk mode', "let's talk", 'lets talk',
    "let's just talk", 'lets just talk', 'just talk', 'open talk'
  ]},
  { name: 'lines', phrases: [
    'lines', 'prompts', 'back to lines', 'back to the lines',
    'back to prompts', 'back to the prompts', 'back to the phrases', 'back to phrases',
    'line mode', 'practice lines'
  ]}
];

const COMMAND_PHRASE_SETS = COACH_COMMANDS.map(command => ({ name: command.name, phrases: new Set(command.phrases) }));
const LEADING_FILLER = new Set(['okay', 'ok', 'um', 'uh', 'uhh', 'umm', 'er', 'ah', 'hmm', 'mm', 'please', 'coach', 'hey', 'so', 'well', 'now', 'yeah', 'yep', 'just', 'like', 'alright', 'right']);
const TRAILING_FILLER = new Set(['okay', 'ok', 'um', 'uh', 'uhh', 'umm', 'er', 'ah', 'hmm', 'mm', 'please', 'hey', 'so', 'well', 'now', 'yeah', 'yep', 'just', 'like', 'alright', 'right']);
const POLITE_PREFIX = /^(?:can you|could you|would you|will you|can we|could we|would we|let's|lets|let us)\s+/;

export function normalizeCommandText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function commandCandidates(normalized) {
  const found = new Set();
  let words = normalized.split(' ').filter(Boolean);
  for (let step = 0; step < 8 && words.length; step += 1) {
    found.add(words.join(' '));
    let next = words.slice();
    while (next.length && LEADING_FILLER.has(next[0])) next.shift();
    while (next.length && TRAILING_FILLER.has(next[next.length - 1])) next.pop();
    const stripped = next.join(' ').replace(POLITE_PREFIX, '');
    next = stripped ? stripped.split(' ') : [];
    if (next.join(' ') === words.join(' ')) break;
    words = next;
  }
  found.delete('');
  return found;
}

function isPromptReading(said, prompt) {
  const expected = normalizeCommandText(prompt);
  if (!said || !expected) return false;
  if (said === expected) return true;
  const saidWords = said.split(' ').filter(Boolean);
  const expectedWords = expected.split(' ').filter(Boolean);
  if (expectedWords.length >= 3 && expected.includes(said) && saidWords.length >= 4) return true;
  if (saidWords.length >= 4 && said.includes(expected)) return true;
  if (saidWords.length < 4 || expectedWords.length < 4) return false;
  const expectedSet = new Set(expectedWords);
  const overlap = saidWords.filter(word => expectedSet.has(word)).length;
  return overlap / saidWords.length >= 0.8 && overlap / expectedWords.length >= 0.6;
}

const VOICE_REQUESTS = [
  { voice: PRACTICE_VOICE, phrases: ['practice voice', 'easier voice', 'easier practice', 'brighter voice', 'the practice voice'] },
  { voice: COACH_VOICE, phrases: ['main voice', 'aurora', 'back to aurora', 'the main voice', 'main coach voice'] }
];

/** A whole utterance that asks to change the coach voice. The current line stays put. */
export function matchVoiceRequest(text, { prompt = '' } = {}) {
  const normalized = normalizeCommandText(text);
  if (!normalized || isPromptReading(normalized, prompt)) return null;
  const options = commandCandidates(normalized);
  const found = VOICE_REQUESTS.find(request => [...options].some(option => request.phrases.includes(option)));
  return found ? found.voice : null;
}

/**
 * Matches one spoken command. Fillers such as "okay", "um", "please", and "coach"
 * can sit around it, and punctuation or casing from the transcript does not matter.
 * The whole utterance has to be the command. Reading the current prompt aloud is
 * practice, even when that line contains "next" or "stop".
 */
export function matchCommand(text, { paused = false, prompt = '' } = {}) {
  const normalized = normalizeCommandText(text);
  if (!normalized || isPromptReading(normalized, prompt)) return null;
  const options = commandCandidates(normalized);
  const found = COMMAND_PHRASE_SETS.find(command => [...options].some(option => command.phrases.has(option)));
  if (!found) return null;
  if (found.name === 'resume' && !paused) return null;
  return found.name;
}

export function coachMinutes(elapsedMs) {
  if (elapsedMs < 20000) return 0;
  return clamp(Math.round(elapsedMs / 60000), 1, 120);
}

/** Spoken when the coach starts or resumes. The driver hears the selected voice, then matches it. */
export function openingLine(prompt, { resumed = false, voice = COACH_VOICE, switched = false } = {}) {
  if (voice === PRACTICE_VOICE) {
    const lead = resumed
      ? 'The coach is listening again. Match this lighter practice voice:'
      : 'Drive coach is on. Match this lighter practice voice:';
    const idle = resumed
      ? 'The coach is listening again. Talk in this lighter practice voice whenever you are ready.'
      : 'Drive coach is on. Talk in this lighter practice voice whenever you are ready.';
    return prompt ? `${lead} ${prompt}` : idle;
  }
  if (switched) {
    const [withPrompt, idle] = AURORA_SWITCH_LINES;
    return prompt ? `${withPrompt} ${prompt}` : idle;
  }
  const lead = resumed ? 'The coach is listening again.' : 'Drive coach is on.';
  return prompt ? `${lead} Match how I say this: ${prompt}` : `${lead} Talk in this voice whenever you are ready.`;
}

/** Spoken after a judged phrase in line mode: the same line after a cue, the next line after a match. */
export function followUpLine({ prompt, coached = false, tooNoisy = false, next = '', voice = COACH_VOICE } = {}) {
  if (tooNoisy || !prompt) return '';
  if (voice === PRACTICE_VOICE) {
    if (coached) return `Try it again, and match this lighter practice voice: ${prompt}`;
    return next ? `That matched this practice voice. Next: ${next}` : '';
  }
  if (coached) return `Try it again, and match how I say it: ${prompt}`;
  return next ? `That matched. Next: ${next}` : '';
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
  let lineAttempts = 0;
  let paused = false;
  let stopped = false;
  let cursor = 0;
  let cleanPhrases = 0;
  let coachedPhrases = 0;
  let phraseCount = 0;
  let cueHeld = 'partly';
  let summary = '';
  let startedAt = now;
  let clock = now;
  const phrases = [];
  const phraseRecords = [];
  const pendingSaves = [];
  let checks = 0;

  function prompt() {
    if (mode === 'free') return '';
    if (!lines.length || lineIndex < 0 || lineIndex >= lines.length) return '';
    return lines[lineIndex];
  }

  function exhausted() {
    return mode === 'lines' && lines.length > 0 && lineIndex >= lines.length;
  }

  function currentRecord() {
    let record = phraseRecords.find(item => item.lineIndex === lineIndex && !item.closed);
    if (!record) {
      record = { lineIndex, prompt: prompt(), attempts: 0, achieved: false, closed: false, words: [] };
      phraseRecords.push(record);
    }
    return record;
  }

  function closeCurrent() {
    const record = phraseRecords.find(item => item.lineIndex === lineIndex && !item.closed);
    if (record) record.closed = true;
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
      profile: PROFILE_LABELS.includes(phrase.profile) ? phrase.profile : 'unsure',
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
      // Saved logs still use 20, 30, or 40. Nothing stops the session at that mark.
      plannedMinutes: [20, 30, 40].includes(plannedMinutes) ? plannedMinutes : 30,
      actualMinutes: Math.max(minutes, minutes === 0 ? 0 : minutes),
      comfort: null,
      cueHeld,
      kind: 'coach',
      coach: {
        minutes,
        mode,
        summary: summary.slice(0, 240),
        phrases: saved
      }
    };
  }

  return {
    id: sessionId,
    prompt,
    status() {
      return {
        paused, stopped, mode, lineIndex, cursor, phraseCount, phrases: phrases.length,
        lineAttempts, lineCount: lines.length, exhausted: exhausted()
      };
    },
    noteAnalysis(result, { transcript = '', at = Date.now() } = {}) {
      clock = at;
      if (paused || stopped) return { ignored: true };
      // Sustained loud noise may say so once. The same status does not go into the
      // phrase log again until a real phrase has been heard.
      if (result.tooNoisy && phrases.length && phrases[phrases.length - 1].tooNoisy) {
        return { ignored: true, events: [] };
      }
      phraseCount += 1;
      const passed = !result.feedback?.spoken && !result.tooNoisy;
      coachedPhrases += result.feedback?.spoken ? 1 : 0;
      if (passed) cleanPhrases += 1;
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
      const record = currentRecord();
      record.attempts += 1;
      lineAttempts = record.attempts;
      if (passed) record.achieved = true;
      for (const word of entry.words) {
        for (const issue of word.flags) record.words.push({ text: word.text, issue });
      }
      remember(entry);
      summary = spokenSummary();
      const events = [{ type: 'feedback', text: entry.feedback, entry }];
      if (phraseCount % 4 === 0) {
        pendingSaves.push(logEntry(at));
        if (pendingSaves.length > 4) pendingSaves.splice(0, pendingSaves.length - 4);
      }
      return { events, entry };
    },
    advance() {
      if (mode !== 'lines' || !lines.length || lineIndex >= lines.length) return '';
      closeCurrent();
      lineIndex += 1;
      lineAttempts = 0;
      return prompt();
    },
    hear(text, at = Date.now()) {
      clock = at;
      const command = matchCommand(text, { paused, prompt: prompt() });
      if (!command) return { type: 'speech', text };
      return this.command(command, at);
    },
    command(name, at = Date.now()) {
      clock = at;
      if (name === 'pause') {
        paused = true;
        return { type: 'pause', say: 'The coach is paused. Say resume when you want to continue.' };
      }
      if (name === 'resume') {
        if (!paused || stopped) return { type: 'speech' };
        paused = false;
        return { type: 'resume', say: 'The coach is listening again.' };
      }
      if (name === 'stop') {
        if (stopped) return { type: 'stop', say: '', entry: null };
        stopped = true;
        paused = true;
        closeCurrent();
        const entry = logEntry(at);
        if (entry.actualMinutes >= 1) pendingSaves.push(entry);
        return { type: 'stop', say: 'Stopping. I saved this drive.', entry };
      }
      if (name === 'next') {
        if (mode !== 'lines') return { type: 'next', say: 'Next line.' };
        const next = this.advance();
        if (!next) {
          stopped = true;
          paused = true;
          const entry = logEntry(at);
          if (entry.actualMinutes >= 1) pendingSaves.push(entry);
          return { type: 'next', finished: true, say: 'Stopping. I saved this drive.', entry };
        }
        return { type: 'next', say: `Next. ${next}` };
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
    },
    markEnded() {
      stopped = true;
      paused = true;
      closeCurrent();
    },
    spokenSummary,
    /**
     * Achieved: the phrase passed (a take with no coaching note and not too noisy).
     * Attempted: the phrase was spoken at least once. Skipped lines count as neither.
     * Problems are words the coach already flagged, with that flag's existing phonetic name.
     */
    wrapUp() {
      const attempted = phraseRecords.filter(item => item.attempts > 0);
      const achieved = attempted.filter(item => item.achieved);
      const seen = new Map();
      for (const phrase of attempted) {
        for (const word of phrase.words) {
          const text = String(word.text || '').trim();
          if (!text || !word.issue) continue;
          const key = `${text.toLowerCase()}|${word.issue}`;
          const row = seen.get(key) || {
            word: text,
            issue: word.issue,
            phonetics: wordPhonetics(word.issue),
            count: 0
          };
          row.count += 1;
          seen.set(key, row);
        }
      }
      const problems = [...seen.values()]
        .filter(row => row.phonetics)
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
        .slice(0, 12);
      return { achieved: achieved.length, attempted: attempted.length, takes: phraseCount, problems };
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
  const labels = ['masculine', 'androgynous', 'feminine', 'unsure'];
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
