import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PATTERNS = [
  { id: 'snr20', expect: 'speech', test: name => /snr[\s_-]*20/i.test(name) },
  { id: 'snr10', expect: 'speech', test: name => /snr[\s_-]*10/i.test(name) },
  { id: 'snr5', expect: 'speech', test: name => /snr[\s_-]*5(?!\d)/i.test(name) },
  { id: 'road-only', expect: 'noise-only', test: name => /road[\s_-]*only|noise[\s_-]*only/i.test(name) }
];

export function referenceDir() {
  return process.env.QA_REFERENCE_DIR || '';
}

export function findReferenceClips(dir = referenceDir()) {
  if (!dir) return [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const found = [];
  for (const pattern of PATTERNS) {
    const name = names.find(file => pattern.test(file) && statSync(join(dir, file)).isFile());
    if (name) found.push({ ...pattern, file: join(dir, name) });
  }
  return found;
}

export function decodeAudio(file) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', file,
    '-ac', '1',
    '-ar', '16000',
    '-f', 'f32le',
    'pipe:1'
  ], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || `ffmpeg failed for ${file}`);
  }
  const bytes = result.stdout;
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return new Float32Array(copy);
}
