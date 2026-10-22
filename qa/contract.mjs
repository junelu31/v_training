// Independent contract for the Drive coach. The suite imports whatever module
// QA_COACH_MODULE points at and adapts it to this shape. It does not describe
// a specific implementation.

export const PROFILE_LABELS = ['masculine', 'feminine', 'androgynous'];

// Practice categories from pitch AND resonance. A pitch-only rule is wrong.
// Feminine: F0 >= 170 Hz and F2 >= 1650 Hz.
// Masculine: F0 <= 140 Hz and F2 <= 1250 Hz.
// Anything else, including a high pitch with a dark F2 or a low pitch with a
// forward F2, is androgynous.
export const PROFILE_RULES = {
  feminine: { minF0: 170, minF2: 1650 },
  masculine: { maxF0: 140, maxF2: 1250 }
};

export const CUE_IDS = ['pitch-low', 'pitch-drop-end', 'vocal-fry', 'resonance-dark', 'breathiness'];

// Spoken lines have to name the physical fix. Matching is deliberately
// specific so "try again" does not count.
export const CUE_RULES = {
  'pitch-low': {
    text: text => /\bpitch\b/i.test(text) && /\b(up|higher|raise)\b/i.test(text) && !/\b(chest|end of the word)\b/i.test(text)
  },
  'pitch-drop-end': {
    text: text => /\bend of the word\b/i.test(text) || (/\bchest\b/i.test(text) && /\b(dropped|drop|lift)\b/i.test(text))
  },
  'vocal-fry': {
    text: text => /\b(fry|creak)\b/i.test(text)
  },
  'resonance-dark': {
    text: text => (/\btongue\b/i.test(text) && /\bforward\b/i.test(text)) || /\b(hard palate|front of the mouth)\b/i.test(text)
  },
  breathiness: {
    text: text => /\b(breath|airy|air)\b/i.test(text) && /\b(less|clear|tone|connected)\b/i.test(text)
  },
  'too-noisy': {
    text: text => /\btoo noisy\b/i.test(text) || /\b(can(?:not|'t) hear)\b/i.test(text)
  }
};

const HYPE = /\b(great job|good job|amazing|awesome|perfect|unlock|journey|you(?:'ve| have) got this|embrace|empower|incredible)\b/i;

export function spokenCopyIssues(text) {
  const issues = [];
  const value = String(text || '').trim();
  if (!value) issues.push('empty');
  if (value.length > 180) issues.push('longer than a short spoken fix');
  if (HYPE.test(value)) issues.push('filler praise or hype');
  if (value.includes('!')) issues.push('exclamation');
  const sentences = value.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 2) issues.push('more than two sentences');
  const fragments = sentences.filter(sentence => sentence.replace(/[.!?]/g, '').trim().split(/\s+/).filter(Boolean).length <= 2);
  if (sentences.length >= 3 && fragments.length >= 3) issues.push('choppy fragments');
  return issues;
}

export function cuesMatching(text) {
  const hits = [];
  for (const [id, rule] of Object.entries(CUE_RULES)) {
    if (id === 'too-noisy') continue;
    if (rule.text(text)) hits.push(id);
  }
  return hits;
}

export function isTooNoisyText(text) {
  return CUE_RULES['too-noisy'].text(String(text || ''));
}

export const SOAK_LIMITS = {
  maxRetainedSeconds: 15,
  maxHeapGrowthBytes: 32 * 1024 * 1024,
  maxActiveWakeLocks: 1,
  maxVideos: 1,
  maxVisibilityListeners: 1
};
