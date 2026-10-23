// Scores local 16 kHz mono float32 takes. June's recordings are not in the repo.
// Put them in /tmp/lilt-audio, or set DRIVE_AUDIO_DIR, then run:
//   node scripts/road-noise-eval.mjs
// Generated-noise checks that do not need those files live in tests/drive-coach.test.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { detectTurns } from '../drive-dsp.js';
import { classifyUtterance } from '../drive-coach.js';

const dir = process.env.DRIVE_AUDIO_DIR || '/tmp/lilt-audio';
const prompt = "Hi, my name is June, I'd like a medium latte, please.";
const goal = { pitch: [160, 210], brightness: [-16, -10] };
const files = [
  ['clean', 'take1_20261021_2334_1fad.f32'],
  ['snr20', 'take1_road_snr20_bcde.f32'],
  ['snr10', 'take1_road_snr10_c5d9.f32'],
  ['snr5', 'take1_road_snr5_19f3.f32'],
  ['road_only', 'road_only_46cf.f32']
];

if (!existsSync(dir)) {
  console.log(JSON.stringify({
    skipped: true,
    dir,
    reason: 'No local audio directory. This script does not download June\'s recording.'
  }, null, 2));
  process.exit(0);
}

function load(name) {
  const path = `${dir}/${name}`;
  if (!existsSync(path)) return null;
  const buffer = readFileSync(path);
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

const rows = [];
for (const [label, name] of files) {
  const samples = load(name);
  if (!samples) {
    rows.push({ file: label, missing: name });
    continue;
  }
  const turns = detectTurns(samples);
  rows.push({
    file: label,
    turns: turns.length,
    detail: turns.map(turn => {
      const judged = classifyUtterance({ analysis: turn, prompt, goal });
      const spoken = judged.words.flatMap(word => word.flags.filter(flag => flag.speak).map(flag => `${word.text}:${flag.issue}`));
      return {
        sec: Math.round(turn.duration * 10) / 10,
        snrDb: Math.round((turn.snrDb || 0) * 10) / 10,
        tooNoisy: judged.tooNoisy,
        medianHz: judged.profile?.features?.hz ?? null,
        spoken: judged.feedback.text,
        flags: spoken
      };
    })
  });
}
console.log(JSON.stringify({ dir, prompt, rows }, null, 2));
