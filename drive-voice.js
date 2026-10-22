// Spoken lines for Drive coach. Every fixed line has a pre-rendered clip under
// public/voice, so the coach sounds like one natural voice. A line that names a
// word or a count is built at runtime and has no clip; the player speaks that
// part with cloud speech or the device voice.

import { CUE_LIBRARY } from './drive-cues.js';
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
  return plan;
}

export function clipFile(text) {
  let hash = 0x811c9dc5;
  for (const char of voiceKey(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `voice/${hash.toString(16).padStart(8, '0')}.mp3`;
}
