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

// Cues for the temporary practice voice (Kokoro af_bella), not for Aurora.
// Bella sits higher and lighter than Aurora. These lines name that placement:
// pitch in the lighter part of the voice, a thin start, and the tongue a little
// farther forward. They are not notes about sounding feminine.
export const PRACTICE_CUE_LIBRARY = {
  drop: {
    name: 'End-of-phrase pitch drop',
    variants: [
      'Lift the pitch at the end of the word and keep it light, the way I finish it, so the last sound does not fall.',
      'Say that word once more, and leave the pitch up in the lighter part of the voice, the way I just did.',
      'Finish the word while the pitch is still up and the tone is still light, the same way mine does.'
    ]
  },
  chesty: {
    name: 'Low F2, dark resonance',
    variants: [
      'Lift your tongue a little higher, toward the ridge behind your top teeth, so the vowel sits as forward as mine.',
      'Ease the jaw, keep the tongue forward, and say it again the way I do.',
      'Whisper a small ee with the tongue high, then the word, so the vowel stays as forward as mine.'
    ]
  },
  dark: {
    name: 'Low overall formants',
    variants: [
      'Lift your larynx a little, like a whispered ee, and keep the tongue high so the sound is as small and light as mine.',
      'Bring the tongue up behind the top teeth, then say the word again the way I do.'
    ]
  },
  heavy: {
    name: 'Heavy buzzy weight',
    variants: [
      'Start from a thin sigh at the front of the mouth, then say the word with almost no buzz in the chest, as light as I am.',
      'Hum a small hm on the lips, lightly, only as easy as I am.',
      'Let the word start thin, with less thickness in the chest, then say it again at the same light weight I use.'
    ]
  },
  fry: {
    name: 'Vocal fry',
    variants: [
      'Take a breath before the last words, and keep a little air moving so the end stays light and clear, the way mine does.',
      'Put a thin stream of air under the last word so it stays up with my pitch and does not creak.',
      'Breathe, then finish the word while the tone is still light and the air is moving, the way I do.'
    ]
  },
  low: {
    name: 'Pitch sitting low',
    variants: [
      'Let the pitch sit up in the lighter part of your voice, where I say it, and keep it there.',
      'Start the word up where my pitch sits, and stay there through the whole word.'
    ]
  },
  breath: {
    name: 'Breathy voice',
    variants: [
      'Use a little less air so the tone stays light and clear, the way mine does.',
      'Keep the tone connected, with less air leaking, and as light as I say it.'
    ]
  },
  strain: {
    name: 'Strain or pressed voice',
    variants: [
      'Ease off, and start from a small hum at the front, mm, then the word, without squeezing to reach my pitch.',
      'Use less push. Let it start as thin and easy as I do.',
      'Hum a light mm at the lips, then slide into the word without pressing.'
    ]
  },
  noisy: {
    name: 'Road noise',
    variants: CUE_LIBRARY.noisy.variants
  },
  held: {
    name: 'No confident issue',
    variants: [
      'Nothing to fix there.'
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

export function cueLine(issue, cursor, voice = 'aurora') {
  const library = voice === 'af_bella' ? PRACTICE_CUE_LIBRARY : CUE_LIBRARY;
  const list = library[issue]?.variants || library.held.variants;
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

// Short praise after a clean take, before the breath and the next phrase.
// One to four words. Lines already in the Aurora bank play as clips. The
// others use the cloud or device voice until June bakes them.
export const PRAISE_LINES = [
  'Nice.',
  'Good.',
  'Nice one.',
  'Good one.',
  'That is nice.',
  'That is good.',
  'Nothing to fix there.',
  'That held.',
  'Easy.',
  'Nice and easy.',
  "That's it.",
  'Beautiful resonance.'
];

// Terse miss lines. {word} is the word that failed. Several variants per
// dimension, and the picker skips the line just spoken. A template whose
// words are already fragments plays from the clip bank. Anything else is
// the cloud or device fallback (needs an Aurora bake).
export const FEEDBACK_LINES = {
  drop: [
    '{word} dropped.',
    'Keep the end up.',
    'End up on {word}.',
    'Lift the end of "{word}".'
  ],
  low: [
    '{word} sat low in pitch.',
    'Up on {word}.',
    'Pitch up on "{word}".',
    'Higher on "{word}".'
  ],
  high: [
    'Ease down on "{word}".',
    'Not so high on "{word}".',
    'Too high on "{word}".'
  ],
  chesty: [
    '{word} went chesty.',
    'Brighter on "{word}".',
    'More forward on "{word}".'
  ],
  dark: [
    '{word} sounded too big in the throat.',
    'Brighter on "{word}".',
    'Smaller on "{word}".'
  ],
  heavy: [
    '{word} went heavy.',
    'Easy on {word}.',
    'Lighter on "{word}".'
  ],
  fry: [
    '{word} fell into fry.',
    'Clear the end of "{word}".',
    'Keep air through "{word}".'
  ],
  strain: [
    '{word} sounded pressed.',
    'Easy on {word}.',
    'Softer on "{word}".'
  ],
  breath: [
    '{word} went breathy.',
    'Less air on "{word}".',
    'Clearer on "{word}".'
  ],
  flat: [
    'Shape "{word}".',
    'More melody on "{word}".',
    'Not so flat on "{word}".'
  ],
  quiet: [
    'Louder on "{word}".',
    'A little louder on "{word}".',
    '{word} was quiet.'
  ],
  fast: [
    'Slow on {word}.',
    'Not so fast on "{word}".',
    '{word} went fast.'
  ],
  misread: [
    'Try "{word}" again.',
    '"{word}" did not land.',
    'Say "{word}" once more.'
  ]
};

// Spoken ahead of the saved issue list. New dimensions stay out of ISSUE_ORDER
// so the clip manifest and the saved flag allow-list do not have to grow.
export const SPEAK_ORDER = [...ISSUE_ORDER, 'high', 'flat', 'quiet', 'fast', 'misread'];

export function chooseSpoken(lines, cursor = 0, previous = '') {
  const list = (lines || []).filter(Boolean);
  if (!list.length) return '';
  const start = ((cursor % list.length) + list.length) % list.length;
  for (let step = 0; step < list.length; step++) {
    const line = list[(start + step) % list.length];
    if (line !== previous) return line;
  }
  return list[start];
}

export function praiseLine(cursor = 0, previous = '') {
  return chooseSpoken(PRAISE_LINES, cursor, previous);
}

export function feedbackLine(issue, word, cursor = 0, previous = '') {
  return techniqueLine(issue, word, cursor, previous);
}

// One physical fix for the next try. Baked {word} lines stitch from Aurora
// fragments. The sentences without a number are the proposed bake: they use
// the cloud or device voice until June approves clips.
export const TECHNIQUE_LINES = {
  drop: [
    'Lift the end of "{word}".',
    'End up on {word}.',
    'Lift the last stressed syllable.'
  ],
  low: [
    'Pitch up on "{word}".',
    'Higher on "{word}".',
    'Let the pitch sit up where mine does.'
  ],
  high: [
    'Ease down on "{word}".',
    'Not so high on "{word}".',
    'Too high on "{word}".'
  ],
  chesty: [
    'More forward on "{word}".',
    'Brighter on "{word}".',
    'Smile a little and keep the tongue forward.'
  ],
  dark: [
    'Smaller on "{word}".',
    'Brighter on "{word}".',
    'Smile a little and place it forward.'
  ],
  heavy: [
    'Lighter on "{word}".',
    'Easy on {word}.',
    'Start from a light sigh, then the word.'
  ],
  fry: [
    'Keep air through "{word}".',
    'Clear the end of "{word}".',
    'Less push and more air on the last word.'
  ],
  strain: [
    'Softer on "{word}".',
    'Easy on {word}.',
    'Less push and more air.'
  ],
  breath: [
    'Less air on "{word}".',
    'Clearer on "{word}".'
  ],
  flat: [
    'More melody on "{word}".',
    'Shape "{word}".',
    'Not so flat on "{word}".'
  ],
  quiet: [
    'A little louder on "{word}".',
    'Louder on "{word}".'
  ],
  fast: [
    'Not so fast on "{word}".',
    'Slow on {word}.',
    'Give each word a little more time.'
  ],
  misread: [
    'Try "{word}" again.',
    'Say "{word}" once more.'
  ]
};

// Fixed notes for a clean take. No numbers, so they can be baked later.
export const PASS_NOTES = {
  pitch: 'Pitch was right on target.',
  resonance: 'Resonance was right on target.'
};

export function techniqueLine(issue, word, cursor = 0, previous = '') {
  const name = String(word || '').replace(/[<>"]/g, '').trim();
  const lines = (TECHNIQUE_LINES[issue] || [])
    .filter(template => name || !template.includes('{word}'))
    .map(template => fillWord(template, name));
  if (!lines.length) return '';
  const start = ((cursor % lines.length) + lines.length) % lines.length;
  for (let step = 0; step < lines.length; step++) {
    const line = lines[(start + step) % lines.length];
    if (!previous || !previous.includes(line)) return line;
  }
  return lines[start];
}
