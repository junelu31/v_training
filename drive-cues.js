// Spoken cue library for Drive coach. Each line is one physical fix or a
// micro-drill. Feedback speaks at most one of these, and rotates through the
// list so a long drive does not repeat the same sentence every phrase.
// Keep the text free of < and >, because saved progress rejects markup.

export const CUE_LIBRARY = {
  drop: {
    name: 'End-of-phrase pitch drop',
    variants: [
      'Lift the end of the word so the last sound does not fall.',
      'Say that word once more, and keep the end of the word up.',
      'Finish the end of the word while the sound is still moving up.'
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
      'Lift your larynx a little, like a whispered hee, then say the word with your tongue forward.',
      'Bring the tongue forward, toward the front of the mouth, then say the word again.'
    ]
  },
  heavy: {
    name: 'Heavy buzzy weight',
    variants: [
      'Start from a light sigh, then say the word with less buzz in your chest.',
      'Start from a gentle hm at the front of the face, only as loud as someone close by.',
      'Sigh the word out lightly, then say it again the same easy way.'
    ]
  },
  fry: {
    name: 'Vocal fry',
    variants: [
      'Take a breath before the last words, and keep air flowing so the end does not creak.',
      'Put a little airflow under the last word so it does not fall into fry.',
      'Breathe, then finish the word while the air is still moving.'
    ]
  },
  low: {
    name: 'Pitch sitting low',
    variants: [
      'Bring the pitch up a little, and keep it there.',
      'Let the pitch sit a bit higher through the whole word.'
    ]
  },
  breath: {
    name: 'Breathy voice',
    variants: [
      'Use a little less air so the tone stays clear.',
      'Keep the tone connected, with less air leaking through the word.'
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

export const IMPROVED_LINES = [
  "'{word}' is better than last time.",
  "That '{word}' improved.",
  "'{word}' held this time."
];

export const ISSUE_ORDER = ['strain', 'fry', 'drop', 'low', 'heavy', 'chesty', 'dark', 'breath'];

const PROBLEM = {
  drop: 'dropped',
  chesty: 'went chesty',
  dark: 'sounded too big in the throat',
  heavy: 'went heavy',
  fry: 'fell into fry',
  strain: 'sounded pressed',
  low: 'sat low in pitch',
  breath: 'went breathy'
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
