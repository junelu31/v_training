import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('accounts, sessions, persistence, isolation, conflicts, and input protection in Workers', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: await readFile('worker/index.js', 'utf8'),
    compatibilityDate: '2026-10-04',
    d1Databases: ['DB']
  }));
  try {
    const db = await mf.getD1Database('DB');
    const schema = await readFile('migrations/0001_initial.sql', 'utf8');
    await db.batch(schema.split(';').map(x => x.trim()).filter(Boolean).map(sql => db.prepare(sql)));
    const call = (path, method = 'GET', data, cookie, origin = 'https://lilt.test') => mf.dispatchFetch(`https://lilt.test${path}`, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    assert.equal((await call('/api/state')).status, 401);
    const credentials = { email: 'first@example.com', password: 'a-long-test-password' };
    assert.equal((await call('/api/auth/register', 'POST', credentials, null, 'https://evil.test')).status, 403);
    const register = await call('/api/auth/register', 'POST', credentials);
    assert.equal(register.status, 200, await register.clone().text());
    const setCookie = register.headers.get('Set-Cookie');
    assert.match(setCookie, /__Host-lilt_session=.*HttpOnly.*SameSite=Lax.*Secure/);
    const first = setCookie.split(';')[0];
    assert.equal((await call('/api/auth/register', 'POST', credentials)).status, 409);
    assert.equal((await call('/api/auth/me', 'GET', undefined, first)).status, 200);
    assert.deepEqual(await (await call('/api/state', 'GET', undefined, first)).json(), { state: null, version: 0 });
    const state = { goal: 'balanced', attempts: [], completed: [], saveAudio: false, rate: 0.88, voice: '', sessionStarted: null };
    assert.equal((await call('/api/state', 'PUT', { state, version: 0 }, first)).status, 200);
    assert.equal((await call('/api/state', 'PUT', { state, version: 0 }, first)).status, 409);
    const changed = { ...state, goal: 'bright', completed: [{ lesson: 'test', activity: 'w1d1-1', date: '2026-10-04' }], attempts: [{ id: 'test-attempt', date: '2026-10-04T12:00:00Z', lessonTitle: 'Practice', overall: 70, scores: { pitch: 70, brightness: 60, movement: 80, ease: 90 } }] };
    assert.equal((await call('/api/state', 'PUT', { state: changed, version: 1 }, first)).status, 200);
    assert.deepEqual(await (await call('/api/state', 'GET', undefined, first)).json(), { state: { ...changed, driveLog: [] }, version: 2 });
    assert.equal((await call('/api/state', 'PUT', { state, version: 1 }, first)).status, 409);
    assert.equal((await call('/api/state', 'PUT', { state: { ...state, attempts: [{}] }, version: 2 }, first)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { state: { ...state, voice: '<script>' }, version: 2 }, first)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { padding: 'x'.repeat(1024 * 1024) }, first)).status, 413);
    const secondRegister = await call('/api/auth/register', 'POST', { ...credentials, email: 'second@example.com' });
    const second = secondRegister.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await (await call('/api/state', 'GET', undefined, second)).json()).state, null);
    assert.equal((await call('/api/auth/login', 'POST', { ...credentials, password: 'wrong-long-password' })).status, 401);
    const login = await call('/api/auth/login', 'POST', credentials);
    assert.equal(login.status, 200);
    const signedIn = login.headers.get('Set-Cookie').split(';')[0];
    assert.deepEqual((await (await call('/api/state', 'GET', undefined, signedIn)).json()).state, { ...changed, driveLog: [] });
    const ramonaState = { ...changed, goal: 'ramona' };
    assert.equal((await call('/api/state', 'PUT', { state: ramonaState, version: 2 }, signedIn)).status, 200);
    assert.equal((await (await call('/api/state', 'GET', undefined, signedIn)).json()).state.goal, 'ramona');
    const driveEntry = { id: 'drive-1', date: '2026-10-04T12:00:00Z', routineId: 'week-2', plannedMinutes: 30, actualMinutes: 30, comfort: 4, cueHeld: 'partly' };
    const driveState = { ...ramonaState, driveLog: [driveEntry] };
    assert.equal((await call('/api/state', 'PUT', { state: driveState, version: 3 }, signedIn)).status, 200);
    assert.deepEqual((await (await call('/api/state', 'GET', undefined, signedIn)).json()).state.driveLog, [driveEntry]);
    assert.equal((await call('/api/state', 'PUT', { state: { ...driveState, driveLog: [{ ...driveEntry, actualMinutes: 15 }] }, version: 4 }, signedIn)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { state: { ...driveState, driveLog: [{ ...driveEntry, cueHeld: 'maybe' }] }, version: 4 }, signedIn)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { state: { ...driveState, driveLog: Array.from({ length: 501 }, (_, index) => ({ ...driveEntry, id: `drive-${index}` })) }, version: 4 }, signedIn)).status, 400);
    assert.equal((await call('/api/auth/logout', 'POST', {}, signedIn)).status, 200);
    assert.equal((await call('/api/state', 'GET', undefined, signedIn)).status, 401);
    const hash = signedIn.split('=')[1];
    await db.prepare('UPDATE sessions SET expires_at = 0').run();
    assert.equal((await call('/api/state', 'GET', undefined, first)).status, 401);
    const stored = await db.prepare('SELECT password_hash FROM users WHERE email = ?').bind(credentials.email).first();
    assert.notEqual(stored.password_hash, credentials.password);
    assert.notEqual(stored.password_hash, hash);
    for (let i = 0; i < 21; i++) await call('/api/auth/login', 'POST', credentials);
    assert.equal((await call('/api/auth/login', 'POST', credentials)).status, 429);
  } finally { await mf.dispose(); }
});
