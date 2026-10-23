import { CUE_LIBRARY, PRACTICE_CUE_LIBRARY, IMPROVED_LINES, ISSUE_ORDER, problemPhrase } from './drive-cues.js';
import { PRACTICE_SESSION_LINES, SESSION_LINES } from './drive-session.js';

// Spoken lines for Drive coach. Every fixed line has a pre-rendered clip.
// That clip is the sound to imitate.
// Coach clips are Grok Aurora (xAI TTS, voice_id aurora) at voice/<hash>.mp3.
// Render them with scripts/render_aurora_tts.mjs. Practice clips stay Kokoro
// af_bella at voice/af_bella/<hash>.mp3, rendered with scripts/render_voice.py.
// FORCE=1 rebuilds clips that already exist.
// A line that names a word or a count is stitched from fragment clips in that same
// voice: each word of the drive phrases, each problem phrase, the word "and", the
// summary words, and the numbers 0 to 199.
// Only a part no fragment covers falls back to cloud speech or the device voice.

// aurora: the long-term target, and the default. On a multi-sentence sample at
// speed 0.95 (the same analyzePcm path as the app) the median pitch is about
// 171.9 Hz (p10 ~155, p90 ~250), brightness median about -13.6 dB
// (p10 ~-25.4, p90 ~4.6), and H1-H2 median about -5.9 dB.
export const COACH_VOICE = 'aurora';
export const COACH_VOICE_SPEED = 0.95;
// af_bella: temporary practice voice. Same kind of paragraph at speed 0.95,
// about 212 Hz and a lighter tone (H1-H2 about +8 dB). af_sky is lower
// (about 152 Hz) and darker (centroid near 990 Hz), so the gap from a
// masculine start is smaller.
export const PRACTICE_VOICE = 'af_bella';
export const DRIVE_VOICE_STORAGE_KEY = 'lilt-drive-voice';
// The iPhone endurance gate stores the same choice under this name.
export const COACH_VOICE_STORAGE_KEY = 'lilt-coach-voice';

export const DRIVE_VOICES = {
  aurora: {
    id: 'aurora',
    button: 'Aurora',
    detail: 'The voice to land on',
    kicker: 'DRIVE COACH · AURORA',
    note: 'This is Aurora, the voice to land on. Switch to the practice voice when you want a higher, lighter target.',
    switchTo: 'Switch to practice voice'
  },
  af_bella: {
    id: 'af_bella',
    button: 'Easier practice',
    detail: 'Higher and lighter, for now',
    kicker: 'DRIVE COACH · PRACTICE VOICE',
    note: 'This is the temporary practice voice. It sits higher and lighter than Aurora, so the gap is easier to hear. Match this voice. Aurora stays the one to land on.',
    switchTo: 'Switch to Aurora'
  }
};
export const DRIVE_VOICE_ORDER = [COACH_VOICE, PRACTICE_VOICE];

export function normalizeDriveVoice(value) {
  return value === PRACTICE_VOICE ? PRACTICE_VOICE : COACH_VOICE;
}

export function readDriveVoice(storage) {
  try {
    const own = storage?.getItem?.(DRIVE_VOICE_STORAGE_KEY);
    if (own === PRACTICE_VOICE || own === COACH_VOICE) return own;
    return normalizeDriveVoice(storage?.getItem?.(COACH_VOICE_STORAGE_KEY));
  } catch {
    return COACH_VOICE;
  }
}

export function writeDriveVoice(storage, value) {
  const next = normalizeDriveVoice(value);
  try {
    storage?.setItem?.(DRIVE_VOICE_STORAGE_KEY, next);
    storage?.setItem?.(COACH_VOICE_STORAGE_KEY, next);
  } catch { /* this browser is not storing settings */ }
  return next;
}

// Lines from drive-coach.js commands and checks. tests/drive-voice.test.mjs fails if one is missing.
export const COACH_LINES = [
  'The coach is paused. Say resume when you want to continue.',
  'The coach is listening again.',
  'Stopping. I saved this drive.',
  'Next line.',
  'Say that once more.',
  'Free talk. I will coach whatever you say. Say lines when you want the prompts back.',
  'Back to lines.',
  'Nothing to report yet.',
  'I am listening again.'
];

// Leads that come before a phrase. Each is one clip so the phrasing stays natural.
export const LEAD_LINES = [
  'Drive coach is on. Match how I say this:',
  'Drive coach is on. Talk in this voice whenever you are ready.',
  'The coach is listening again. Match how I say this:',
  'The coach is listening again. Talk in this voice whenever you are ready.',
  'That matched. Next:',
  'Try it again, and match how I say it:',
  'Next.',
  'Again.',
  'Back to lines.'
];

// Spoken only when she switches back to Aurora during a drive.
export const AURORA_SWITCH_LINES = [
  'Back to Aurora. Match how I say this:',
  'Back to Aurora. Talk in this voice whenever you are ready.'
];

export const PRACTICE_LEAD_LINES = [
  'Drive coach is on. Match this lighter practice voice:',
  'Drive coach is on. Talk in this lighter practice voice whenever you are ready.',
  'The coach is listening again. Match this lighter practice voice:',
  'The coach is listening again. Talk in this lighter practice voice whenever you are ready.',
  'That matched this practice voice. Next:',
  'Try it again, and match this lighter practice voice:',
  'Next.',
  'Again.',
  'Back to lines.'
];

export function voiceKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Words of a runtime part, without punctuation or quotes, as fragment keys use them. */
export function fragmentWords(text) {
  return String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9']+/g, ' ')
    .split(' ').map(word => word.replace(/^'+|'+$/g, '')).filter(Boolean);
}

export function fragmentKey(text) {
  return `~${fragmentWords(text).join(' ')}`;
}

export const SUMMARY_FRAGMENTS = ['phrases', 'held', 'had a note', 'too noisy to coach'];
const GLUE_FRAGMENTS = ['and'];
export const MAX_COUNT = 199;

export function fragmentLines(phrases = []) {
  const words = new Set(phrases.flatMap(fragmentWords));
  const problems = new Set();
  for (const a of ISSUE_ORDER) {
    problems.add(problemPhrase([a]));
    for (const b of ISSUE_ORDER) if (a !== b) problems.add(problemPhrase([a, b]));
  }
  const improved = IMPROVED_LINES.flatMap(line => line.split(/'?\{word\}'?/)).map(part => part.trim()).filter(Boolean);
  const counts = Array.from({ length: MAX_COUNT + 1 }, (_, n) => String(n));
  const all = [...words, ...problems, ...improved, ...SUMMARY_FRAGMENTS, ...GLUE_FRAGMENTS, ...counts];
  const seen = new Map();
  for (const line of all) {
    const key = fragmentKey(line);
    if (key !== '~' && !seen.has(key)) seen.set(key, fragmentWords(line).join(' '));
  }
  return [...seen.values()];
}

// Covers a runtime part with fragment clips, longest run first. Returns null when any word is uncovered,
// so the whole part goes to one fallback voice instead of switching voices mid-sentence.
function stitch(text, hasClip) {
  const words = fragmentWords(text);
  const parts = [];
  let i = 0;
  while (i < words.length) {
    let found = 0;
    for (let j = words.length; j > i; j--) {
      if (hasClip(`~${words.slice(i, j).join(' ')}`)) { found = j; break; }
    }
    if (!found) return null;
    parts.push({ clip: `~${words.slice(i, found).join(' ')}` });
    i = found;
  }
  return parts.length ? parts : null;
}

export function fixedVoiceLines(phrases = [], voice = COACH_VOICE) {
  const practice = voice === PRACTICE_VOICE;
  const cues = Object.values(practice ? PRACTICE_CUE_LIBRARY : CUE_LIBRARY).flatMap(entry => entry.variants);
  const leads = practice ? PRACTICE_LEAD_LINES : [...LEAD_LINES, ...AURORA_SWITCH_LINES];
  const session = Object.values(practice ? PRACTICE_SESSION_LINES : SESSION_LINES);
  const all = [...session, ...cues, ...COACH_LINES, ...leads, ...phrases];
  const seen = new Map();
  for (const line of all) if (line && !seen.has(voiceKey(line))) seen.set(voiceKey(line), line.trim());
  return [...seen.values()];
}

/**
 * Splits text into clips and runtime parts. It takes the longest run of sentences
 * that has a clip, so "That was clear. Next: Mia is here early." plays as two clips.
 */
export function planSpeech(text, hasClip) {
  const chunks = String(text || '').trim().split(/(?<=[.?!:])\s+/).filter(Boolean);
  const plan = [];
  let i = 0;
  while (i < chunks.length) {
    let found = 0;
    for (let j = chunks.length; j > i; j--) {
      if (hasClip(chunks.slice(i, j).join(' '))) { found = j; break; }
    }
    if (found) {
      plan.push({ clip: chunks.slice(i, found).join(' ') });
      i = found;
    } else {
      const last = plan[plan.length - 1];
      if (last && 'text' in last) last.text += ` ${chunks[i]}`;
      else plan.push({ text: chunks[i] });
      i += 1;
    }
  }
  return plan.flatMap(part => ('text' in part ? stitch(part.text, hasClip) || [part] : [part]));
}

export function clipFile(text, voice = COACH_VOICE) {
  let hash = 0x811c9dc5;
  for (const char of text.startsWith('~') ? text : voiceKey(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const name = `${hash.toString(16).padStart(8, '0')}.mp3`;
  return voice === COACH_VOICE ? `voice/${name}` : `voice/${voice}/${name}`;
}
