// Spoken cue library for Drive coach. Each line is one physical fix or a
// micro-drill. Feedback speaks at most one of these, and rotates through the
// list so a long drive does not repeat the same sentence every phrase.
// Keep the text free of < and >, because saved progress rejects markup.

export const CUE_LIBRARY = {
  drop: {
    name: 'End-of-phrase pitch drop',
    variants: [
      'Lift the end of the word so it finishes the way I do, and the last sound does not fall.',
      'Say that word once more, and keep the end up the way I just did.',
      'Finish the word while the sound is still moving up, the same way mine does.'
    ]
  },
  chesty: {
    name: 'Low F2, dark resonance',
    variants: [
      'Bring your tongue more forward, toward your top teeth, so the vowel matches mine.',
      'Smile slightly, keep the tongue forward, and say it again the way I do.',
      'Whisper hee, then the word, with the tongue staying forward like mine.'
    ]
  },
  dark: {
    name: 'Low overall formants',
    variants: [
      'Lift your larynx a little, like a whispered hee, then say the word with your tongue forward so the size matches mine.',
      'Bring the tongue toward the front of the mouth, then say the word again the way I do.'
    ]
  },
  heavy: {
    name: 'Heavy buzzy weight',
    variants: [
      'Start from a light sigh, then say the word with less buzz in your chest, closer to my weight.',
      'Start from a gentle hm at the front of the face, only as loud as I am.',
      'Sigh the word out lightly, then say it again at the same easy weight I use.'
    ]
  },
  fry: {
    name: 'Vocal fry',
    variants: [
      'Take a breath before the last words, and keep air flowing so the end stays as clear as mine.',
      'Put a little airflow under the last word so it does not fall into fry below my pitch.',
      'Breathe, then finish the word while the air is still moving, the way I do.'
    ]
  },
  low: {
    name: 'Pitch sitting low',
    variants: [
      'Bring the pitch up to where I say it, and keep it there.',
      'Let the pitch sit with mine through the whole word.'
    ]
  },
  breath: {
    name: 'Breathy voice',
    variants: [
      'Use a little less air so the tone stays as clear as mine.',
      'Keep the tone connected, with less air leaking, the way I say it.'
    ]
  },
  strain: {
    name: 'Strain or pressed voice',
    variants: [
      'Ease off, and start from a light hum, mm, then the word, without pressing past my voice.',
      'Use less push. Let it start as softly as I do.',
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
      'That one matched. Keep going.',
      'Nothing to fix there.',
      'That stayed with my voice.'
    ]
  }
};

export const IMPROVED_LINES = [
  "'{word}' is closer to how I say it.",
  "That '{word}' moved toward my voice.",
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
    return `dropped and ${PROBLEM[quality]}`;
  }
  return ordered.map(issue => PROBLEM[issue]).join(' and ');
}
