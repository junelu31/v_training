import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function loadCoach() {
  const spec = process.env.QA_COACH_MODULE;
  if (!spec) {
    return {
      ok: false,
      reason: 'QA_COACH_MODULE is not set. Point it at the Drive coach entry, for example QA_COACH_MODULE=./drive-coach.js'
    };
  }
  const href = spec.startsWith('file:') ? spec : pathToFileURL(resolve(spec)).href;
  try {
    const loaded = await import(href);
    const factory = loaded.createDriveSession
      || loaded.createDriveCoach
      || (typeof loaded.default === 'function' ? loaded.default : null)
      || loaded.default?.createDriveSession
      || loaded.default?.createDriveCoach;
    if (typeof factory !== 'function') {
      return { ok: false, reason: `${spec} does not export createDriveSession` };
    }
    return { ok: true, createDriveSession: factory, href, sourceFile: fileURLToPath(href) };
  } catch (error) {
    return { ok: false, reason: `Could not import ${spec}: ${error.message}` };
  }
}

const IMPORT_RE = /import\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g;

export function localSourceFiles(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (text.length > 200000) continue;
    for (const match of text.matchAll(IMPORT_RE)) {
      let spec = match[1];
      if (!/\.(mjs|js|cjs)$/.test(spec)) spec += '.js';
      queue.push(resolve(dirname(file), spec));
    }
  }
  return [...seen];
}

export function readCoachSources(entry) {
  return localSourceFiles(entry).map(file => {
    try { return { file, text: readFileSync(file, 'utf8') }; } catch { return { file, text: '' }; }
  });
}
