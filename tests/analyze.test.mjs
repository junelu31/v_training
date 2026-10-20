import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('a valid transcription charges the quota and keeps word timestamps', async () => {
  const source = await readFile('worker/index.js', 'utf8');
  const script = `${source.replace('export default', 'const app =')}
export default {
  async fetch(request, env, ctx) {
    const ai = {
      async run() {
        await env.DB.prepare("INSERT INTO auth_limits (key, count, expires_at) VALUES ('ai-runs', 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1").bind(Date.now() + 1000000000).run();
        return { text: 'hello there', segments: [{ text: 'hello there', start: 0, end: 1.2, words: [{ word: 'hello', start: 0.1, end: 0.4 }, { word: 'there', start: 0.4, end: 0.8 }] }] };
      }
    };
    return app.fetch(request, new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === 'AI') return ai;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }), ctx);
  }
};
`;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: '2026-10-04',
    d1Databases: ['DB']
  }));
  try {
    const db = await mf.getD1Database('DB');
    const schema = await readFile('migrations/0001_initial.sql', 'utf8');
    await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
    const register = await mf.dispatchFetch('https://lilt.test/api/auth/register', {
      method: 'POST',
      headers: { Origin: 'https://lilt.test', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.50' },
      body: JSON.stringify({ email: 'analyst@example.com', password: 'a-long-test-password' })
    });
    assert.equal(register.status, 200, await register.clone().text());
    const cookie = register.headers.get('Set-Cookie').split(';')[0];
    const analyze = body => mf.dispatchFetch('https://lilt.test/api/analyze', {
      method: 'POST',
      headers: { Origin: 'https://lilt.test', Cookie: cookie, 'Content-Type': 'audio/webm', 'X-Practice-Prompt': btoa('Hello there'), 'CF-Connecting-IP': '203.0.113.50' },
      body
    });
    const ok = await analyze(new Uint8Array([1, 2, 3, 4]));
    assert.equal(ok.status, 200, await ok.clone().text());
    const payload = await ok.json();
    assert.equal(payload.segments[0].words[0].word, 'hello');
    assert.equal(payload.segments[0].words[0].start, 0.1);
    assert.equal((await db.prepare("SELECT count FROM auth_limits WHERE key LIKE 'analysis:%'").first()).count, 1);
    assert.equal((await db.prepare("SELECT count FROM auth_limits WHERE key = 'ai-runs'").first()).count, 1);
    for (let i = 0; i < 11; i++) assert.equal((await analyze(new Uint8Array([1, 2, 3, 4]))).status, 200);
    assert.equal((await analyze(new Uint8Array([1, 2, 3, 4]))).status, 429);
  } finally { await mf.dispose(); }
});
