// Spoken lines for Drive coach. Every fixed line has a pre-rendered clip under
// public/voice, so the coach sounds like one natural voice. A line that names a
// word or a count is stitched from fragment clips: each word of the drive
// phrases, each problem phrase, the summary words and the numbers 0 to 199.
// Only a part no fragment covers falls back to cloud speech or the device voice.

import { CUE_LIBRARY, IMPROVED_LINES, ISSUE_ORDER, problemPhrase } from './drive-cues.js';
import { SESSION_LINES } from './drive-session.js';

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
  'That is a low comfort score, so I am stopping here. Rest your voice.',
  'Thank you. Keep it easy.',
  'I am listening again.',
  'Quick comfort check. Say a number from one to five.',
  'You have been at this a while. A short rest would be kind. Say stop if you want to save and pause.'
];

// Leads that come before a phrase. Each is one clip so the phrasing stays natural.
export const LEAD_LINES = [
  'Drive coach is on. Say this:',
  'Drive coach is on. Talk whenever you are ready.',
  'The coach is listening again. Say this:',
  'The coach is listening again. Talk whenever you are ready.',
  'That was clear. Next:',
  'Try it again:',
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
  const all = [...words, ...problems, ...improved, ...SUMMARY_FRAGMENTS, ...counts];
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

export function fixedVoiceLines(phrases = []) {
  const cues = Object.values(CUE_LIBRARY).flatMap(entry => entry.variants);
  const all = [...Object.values(SESSION_LINES), ...cues, ...COACH_LINES, ...LEAD_LINES, ...phrases];
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

export function clipFile(text) {
  let hash = 0x811c9dc5;
  for (const char of text.startsWith('~') ? text : voiceKey(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `voice/${hash.toString(16).padStart(8, '0')}.mp3`;
}
