import {
  SAMPLE_RATE,
  measureClip,
  mixAtSnr,
  roadNoise,
  synthesizeVowel
} from './signals.mjs';

const RATE = SAMPLE_RATE;

function vowel(overrides) {
  return synthesizeVowel({
    sampleRate: RATE,
    duration: 1.25,
    f1: 400,
    f2: 2000,
    f3: 3000,
    f0: 200,
    seed: 11,
    ...overrides
  });
}

function clip(partial) {
  return {
    sampleRate: RATE,
    samples: partial.samples,
    ...partial
  };
}

/** Labeled vowels. Values sit inside the contract regions, not on the borders. */
export function profileCorpus() {
  const specs = [
    { id: 'fem-1', label: 'feminine', f0: 200, f1: 350, f2: 2200, seed: 21 },
    { id: 'fem-2', label: 'feminine', f0: 220, f1: 400, f2: 1900, seed: 22 },
    { id: 'fem-3', label: 'feminine', f0: 185, f1: 450, f2: 1800, seed: 23 },
    { id: 'fem-4', label: 'feminine', f0: 240, f1: 320, f2: 2400, seed: 24 },
    { id: 'masc-1', label: 'masculine', f0: 110, f1: 700, f2: 1100, seed: 31 },
    { id: 'masc-2', label: 'masculine', f0: 95, f1: 680, f2: 980, seed: 32 },
    { id: 'masc-3', label: 'masculine', f0: 125, f1: 720, f2: 1180, seed: 33 },
    { id: 'masc-4', label: 'masculine', f0: 105, f1: 650, f2: 900, seed: 34 },
    // High pitch, dark resonance. Pitch alone would call this feminine.
    { id: 'trap-high-dark', label: 'androgynous', f0: 215, f1: 680, f2: 1000, seed: 41, trap: 'not-feminine' },
    // Low pitch, forward resonance. Pitch alone would call this masculine.
    { id: 'trap-low-bright', label: 'androgynous', f0: 115, f1: 380, f2: 2100, seed: 42, trap: 'not-masculine' },
    { id: 'mid-1', label: 'androgynous', f0: 155, f1: 550, f2: 1450, seed: 43 },
    { id: 'mid-2', label: 'androgynous', f0: 160, f1: 500, f2: 1500, seed: 44 }
  ];
  return specs.map(spec => clip({
    ...spec,
    kind: 'profile',
    samples: vowel(spec)
  }));
}

/** One obvious defect each, plus a clean control the coach should leave alone. */
export function cueCorpus() {
  const specs = [
    {
      id: 'defect-pitch-low',
      expected: 'pitch-low',
      f0: 118,
      f1: 380,
      f2: 2050,
      seed: 51
    },
    {
      id: 'defect-pitch-drop',
      expected: 'pitch-drop-end',
      f0: 205,
      f0End: 96,
      f1: 380,
      f2: 2000,
      duration: 1.4,
      seed: 52
    },
    {
      id: 'defect-fry',
      expected: 'vocal-fry',
      f0: 92,
      jitter: 0.035,
      f1: 400,
      f2: 1900,
      fry: true,
      seed: 53
    },
    {
      id: 'defect-dark',
      expected: 'resonance-dark',
      f0: 205,
      f1: 700,
      f2: 980,
      seed: 54
    },
    {
      id: 'defect-breath',
      expected: 'breathiness',
      f0: 195,
      f1: 380,
      f2: 2050,
      breath: 0.28,
      seed: 55
    },
    {
      id: 'clean',
      expected: null,
      f0: 205,
      f1: 360,
      f2: 2150,
      seed: 56
    }
  ];
  return specs.map(spec => clip({
    ...spec,
    kind: 'cue',
    samples: vowel(spec)
  }));
}

function cleanSpeech(seed) {
  return vowel({ f0: 205, f1: 360, f2: 2150, seed, duration: 1.25 });
}

/** Road noise alone, and the same clean vowel mixed at known SNRs. */
export function noiseCorpus() {
  const speech = cleanSpeech(61);
  const noise = roadNoise(speech.length, RATE, 70, 'moderate');
  const loud = roadNoise(speech.length, RATE, 71, 'loud');
  const quiet = roadNoise(speech.length, RATE, 72, 'quiet');
  return [
    clip({ id: 'noise-quiet', kind: 'noise-only', loudness: 'quiet', expect: 'ignore', samples: quiet }),
    clip({ id: 'noise-moderate', kind: 'noise-only', loudness: 'moderate', expect: 'ignore', samples: noise }),
    clip({ id: 'noise-loud', kind: 'noise-only', loudness: 'loud', expect: 'too-noisy', samples: loud }),
    clip({ id: 'speech-snr20', kind: 'speech-noise', snrDb: 20, expect: 'coach-ok', samples: mixAtSnr(speech, noise, 20), speech, noise }),
    clip({ id: 'speech-snr10', kind: 'speech-noise', snrDb: 10, expect: 'coach-ok', samples: mixAtSnr(speech, noise, 10), speech, noise }),
    clip({ id: 'speech-snr5', kind: 'speech-noise', snrDb: 5, expect: 'coach-ok', samples: mixAtSnr(speech, noise, 5), speech, noise }),
    clip({ id: 'speech-buried', kind: 'speech-noise', snrDb: -15, expect: 'too-noisy', samples: mixAtSnr(speech, loud, -15), speech, noise: loud })
  ];
}

export function measureAll(clips) {
  return clips.map(item => ({ id: item.id, label: item.label, expected: item.expected, ...measureClip(item.samples, item.sampleRate) }));
}
