#!/usr/bin/env node
// Render Drive coach clips with Grok Aurora (xAI TTS, voice_id aurora).
// Practice clips stay Kokoro af_bella. Render those with scripts/render_voice.py
// (VOICE=af_bella). Coach files land at public/voice/<hash>.mp3, the path
// clipFile() uses when the voice is COACH_VOICE. This script does not delete
// public/voice/af_bella/.
//
// Usage:
//   node scripts/voice-lines.mjs > /tmp/lines.json
//   XAI_API_KEY=... SPEED=0.95 node scripts/render_aurora_tts.mjs /tmp/lines.json
//   node scripts/voice-lines.mjs --manifest
//
// Needs ffmpeg. FORCE=1 rebuilds clips that already exist.
// The API key is read from the environment and is never printed.
//
// POST https://api.x.ai/v1/tts
// { text, voice_id: "aurora", language: "en", speed }
// The response is audio bytes (default MP3 at 24 kHz). ffmpeg trims edge
// silence and writes mono 24 kHz, 48 kbps MP3, the same encode as the Kokoro
// practice clips.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const linesPath = process.argv[2];
if (!linesPath) {
  console.error('Usage: XAI_API_KEY=... node scripts/render_aurora_tts.mjs /tmp/lines.json');
  process.exit(1);
}

const voiceId = 'aurora';
const speed = Number(process.env.SPEED || '0.95');
if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.5) {
  console.error('SPEED must be a number from 0.7 to 1.5.');
  process.exit(1);
}
if (process.env.VOICE && process.env.VOICE !== voiceId) {
  console.error(`This script renders coach voice ${voiceId}. Practice clips use scripts/render_voice.py.`);
  process.exit(1);
}
const apiKey = process.env.XAI_API_KEY || '';
if (!apiKey) {
  console.error('Set XAI_API_KEY in the environment. Do not pass it on argv.');
  process.exit(1);
}

const force = Boolean(process.env.FORCE);
const lines = JSON.parse(await readFile(linesPath, 'utf8'));
await mkdir('public/voice', { recursive: true });
await writeFile('public/voice/voice.json', `${JSON.stringify({
  voice: voiceId,
  speed,
  rate: 24000,
  channels: 1,
  bitrate: '48k',
  source: 'xai-tts'
})}\n`);

const scratch = await mkdtemp(join(tmpdir(), 'aurora-tts-'));
let wrote = 0;
try {
  for (const line of lines) {
    if (!line?.text || !line?.file) continue;
    if (!line.file.startsWith('voice/') || line.file.slice('voice/'.length).includes('/')) {
      console.error(`Refusing non-coach path ${line.file}. Generate lines with VOICE unset or VOICE=aurora.`);
      process.exit(1);
    }
    const out = join('public', line.file);
    if (existsSync(out) && !force) continue;
    await mkdir(join(out, '..'), { recursive: true });
    const audio = await synthesize(line.text, apiKey, voiceId, speed);
    const raw = join(scratch, 'take.mp3');
    await writeFile(raw, audio);
    await encode(raw, out);
    wrote += 1;
    console.log(out, line.text);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.error(`aurora: wrote ${wrote} clip${wrote === 1 ? '' : 's'}.`);

async function synthesize(text, key, voice, rate) {
  const response = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text, voice_id: voice, language: 'en', speed: rate })
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || type.includes('json') || type.startsWith('text/')) {
    const detail = await response.text();
    throw new Error(`TTS ${response.status}: ${detail.slice(0, 400)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function encode(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,apad=pad_dur=0.08',
      '-ac', '1',
      '-ar', '24000',
      '-codec:a', 'libmp3lame',
      '-b:a', '48k',
      output
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}
