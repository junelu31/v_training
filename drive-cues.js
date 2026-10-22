// Spoken cue library for Drive coach. Each line is one physical fix or a
// micro-drill. Feedback speaks at most one of these, and rotates through the
// list so a long drive does not repeat the same sentence every phrase.
// Keep the text free of < and >, because saved progress rejects markup.

export const CUE_LIBRARY = {
  drop: {
    name: 'End-of-phrase pitch drop',
    variants: [
      'Keep the last syllable up, and end it like a gentle question.',
      'Say that word once more, and lift the very end.',
      'Finish while the sound is still moving up, instead of letting it fall.'
    ]
  },
  chesty: {
    name: 'Low F2, dark resonance',
    variants: [
      'Bring your tongue more forward, toward your top teeth, and smile slightly.',
      'Think of a brighter vowel, tongue forward, lips easy, then say it again.',
      'Whisper hee, then the word, with the tongue staying forward.'
    ]
  },
  dark: {
    name: 'Low overall formants',
    variants: [
      'Lift your larynx a little, think of a small-dog pant or a whispered hee, before the word.',
      'Make the space inside your mouth a bit smaller, then say the word again.',
      'Start with a tiny hee, then the word, and keep that smaller feeling.'
    ]
  },
  heavy: {
    name: 'Heavy buzzy weight',
    variants: [
      'Lighten up, thinner and softer, like talking to a sleeping baby, with less buzz in your chest.',
      'Use only enough voice for someone close by, and let the buzz get thinner.',
      'Sigh the word out lightly, then say it again the same easy way.'
    ]
  },
  fry: {
    name: 'Vocal fry',
    variants: [
      'Take a breath before the last words, and keep air flowing all the way to the end.',
      'Put a little airflow under the last word so it does not creak.',
      'Breathe, then finish the word while the air is still moving.'
    ]
  },
  strain: {
    name: 'Strain or pressed voice',
    variants: [
      'Ease off, and start from a light hum, mm, then the word.',
      'Use less push. Let it start as softly as a hum.',
      'Hum mm, then slide into the word without pressing.'
    ]
  },
  noisy: {
    name: 'Road noise',
    variants: [
      'This one is too noisy to coach. Try it a little closer, or wait for a quieter stretch of road.',
      'I am hearing the road more than your voice, so I will not guess. Try that line again when it is quieter.'
    ]
  },
  held: {
    name: 'No confident issue',
    variants: [
      'That one held. Keep going.',
      'Nothing to fix there.',
      'That stayed easy.'
    ]
  }
};

export const PRAISE_LINES = [
  "Nice lift on '{word}'.",
  "'{word}' stayed easy.",
  "Good, '{word}' held."
];

export const IMPROVED_LINES = [
  "'{word}' is better than last time.",
  "That '{word}' improved.",
  "'{word}' held this time."
];

export const ISSUE_ORDER = ['strain', 'fry', 'drop', 'heavy', 'chesty', 'dark'];

const PROBLEM = {
  drop: 'dropped',
  chesty: 'went chesty',
  dark: 'sounded too big in the throat',
  heavy: 'went heavy',
  fry: 'fell into fry',
  strain: 'sounded pressed'
};

export function cueLine(issue, cursor) {
  const list = CUE_LIBRARY[issue]?.variants || CUE_LIBRARY.held.variants;
  const index = ((cursor % list.length) + list.length) % list.length;
  return list[index];
}

export function fillWord(template, word) {
  return template.replaceAll('{word}', word);
}

export function problemPhrase(issues) {
  const ordered = ISSUE_ORDER.filter(issue => issues.includes(issue)).slice(0, 2);
  if (!ordered.length) return '';
  if (ordered.length === 1) return PROBLEM[ordered[0]];
  if (ordered.includes('drop') && (ordered.includes('heavy') || ordered.includes('chesty'))) {
    const quality = ordered.includes('heavy') ? 'heavy' : 'chesty';
    return `dropped and ${PROBLEM[quality].replace('went ', 'went ')}`;
  }
  return ordered.map(issue => PROBLEM[issue]).join(' and ');
}
