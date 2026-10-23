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
    const call = (path, method = 'GET', data, cookie, origin = 'https://lilt.test', ip = '203.0.113.10') => mf.dispatchFetch(`https://lilt.test${path}`, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
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
    const me = await call('/api/auth/me', 'GET', undefined, first);
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.user.email, credentials.email);
    assert.equal(typeof meBody.user.id, 'string');
    assert.equal(meBody.state, null);
    assert.equal(meBody.version, 0);
    assert.deepEqual(await (await call('/api/state', 'GET', undefined, first)).json(), { state: null, version: 0 });
    const state = { goal: 'balanced', attempts: [], completed: [], saveAudio: false, rate: 0.88, voice: '', sessionStarted: null };
    assert.equal((await call('/api/state', 'PUT', { state, version: 0 }, first)).status, 200);
    const firstConflict = await call('/api/state', 'PUT', { state, version: 0 }, first);
    assert.equal(firstConflict.status, 409);
    assert.equal((await firstConflict.json()).version, 1);
    const changed = { ...state, goal: 'bright', completed: [{ lesson: 'test', activity: 'w1d1-1', date: '2026-10-04' }], attempts: [{ id: 'test-attempt', date: '2026-10-04T12:00:00Z', lessonTitle: 'Practice', overall: 70, scores: { pitch: 70, brightness: 60, movement: 80, ease: 90 } }] };
    assert.equal((await call('/api/state', 'PUT', { state: changed, version: 1 }, first)).status, 200);
    const withDefaults = value => ({ baselineAttemptId: null, pausedSession: null, driveLog: [], ...value });
    assert.deepEqual(await (await call('/api/state', 'GET', undefined, first)).json(), { state: withDefaults(changed), version: 2 });
    const secondConflict = await call('/api/state', 'PUT', { state, version: 1 }, first);
    assert.equal(secondConflict.status, 409);
    assert.equal((await secondConflict.json()).version, 2);
    assert.equal((await call('/api/state', 'PUT', { state: { ...state, attempts: [{}] }, version: 2 }, first)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { state: { ...state, voice: '<script>' }, version: 2 }, first)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { padding: 'x'.repeat(1024 * 1024) }, first)).status, 413);
    const secondRegister = await call('/api/auth/register', 'POST', { ...credentials, email: 'second@example.com' });
    const second = secondRegister.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await (await call('/api/state', 'GET', undefined, second)).json()).state, null);
    assert.equal((await call('/api/auth/login', 'POST', { ...credentials, password: 'wrong-long-password' })).status, 401);
    const login = await call('/api/auth/login', 'POST', credentials);
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.user.email, credentials.email);
    assert.deepEqual(loginBody.state, withDefaults(changed));
    assert.equal(loginBody.version, 2);
    const signedIn = login.headers.get('Set-Cookie').split(';')[0];
    assert.deepEqual((await (await call('/api/state', 'GET', undefined, signedIn)).json()).state, withDefaults(changed));
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
    const legacy = await (await call('/api/state', 'GET', undefined, signedIn)).json();
    assert.equal(legacy.version, 4);
    assert.equal(legacy.state.baselineAttemptId, null);
    assert.equal(legacy.state.pausedSession, null);
    const pause = { lesson: 'baseline', activity: 'w1d1-2', date: '2026-10-05T12:00:00.000Z', comfort: 1, lessonTitle: 'Natural voice snapshot' };
    const enriched = { ...driveState, baselineAttemptId: 'test-attempt', pausedSession: pause };
    assert.equal((await call('/api/state', 'PUT', { state: enriched, version: 4 }, signedIn)).status, 200);
    const roundTrip = (await (await call('/api/state', 'GET', undefined, signedIn)).json()).state;
    assert.equal(roundTrip.baselineAttemptId, 'test-attempt');
    assert.deepEqual(roundTrip.pausedSession, pause);
    assert.equal((await call('/api/state', 'PUT', { state: { ...enriched, pausedSession: { ...pause, comfort: 0 } }, version: 5 }, signedIn)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { state: { ...enriched, baselineAttemptId: 'x'.repeat(81) }, version: 5 }, signedIn)).status, 400);
    assert.equal((await call('/api/state', 'PUT', { state: { ...enriched, pausedSession: { ...pause, lesson: '<bad>' } }, version: 5 }, signedIn)).status, 400);
    const coachEntry = {
      id: 'coach-1', date: '2026-10-06T12:00:00Z', routineId: 'week-2', plannedMinutes: 30, actualMinutes: 15,
      comfort: 3, cueHeld: 'partly', kind: 'coach',
      coach: { minutes: 15, mode: 'lines', comfortKnown: false, comfortPaused: false, restSuggested: false, summary: 'Two phrases held.', phrases: [{ prompt: 'Hi there', transcript: 'Hi there', feedback: 'That one held.', profile: 'androgynous', tooNoisy: false, words: [{ text: 'Hi', flags: ['strain'] }] }] }
    };
    assert.equal((await call('/api/state', 'PUT', { state: { ...enriched, driveLog: [driveEntry, coachEntry] }, version: 5 }, signedIn)).status, 200);
    const coachRound = (await (await call('/api/state', 'GET', undefined, signedIn)).json()).state.driveLog[1];
    assert.equal(coachRound.actualMinutes, 15);
    assert.equal(coachRound.coach.comfortKnown, false);
    assert.deepEqual(coachRound.coach.phrases[0].words[0].flags, ['strain']);
    const quietCoach = {
      ...coachEntry, id: 'coach-2', comfort: null,
      coach: { minutes: 15, mode: 'lines', summary: 'Two phrases held.', phrases: coachEntry.coach.phrases }
    };
    assert.equal((await call('/api/state', 'PUT', { state: { ...enriched, driveLog: [driveEntry, quietCoach] }, version: 6 }, signedIn)).status, 200);
    const quietRound = (await (await call('/api/state', 'GET', undefined, signedIn)).json()).state.driveLog[1];
    assert.equal(quietRound.comfort, null);
    assert.equal(quietRound.coach.comfortKnown, false);
    assert.equal(quietRound.coach.comfortPaused, false);
    assert.equal(quietRound.coach.restSuggested, false);
    assert.equal((await call('/api/state', 'PUT', { state: { ...enriched, driveLog: [{ ...coachEntry, coach: { ...coachEntry.coach, phrases: [{ ...coachEntry.coach.phrases[0], feedback: 'bad <b>' }] } }] }, version: 7 }, signedIn)).status, 400);
    const analyze = (headers, body) => mf.dispatchFetch('https://lilt.test/api/analyze', {
      method: 'POST', headers: { Origin: 'https://lilt.test', Cookie: signedIn, 'CF-Connecting-IP': '203.0.113.10', ...headers }, body
    });
    assert.equal((await analyze({ 'Content-Type': 'text/plain' }, 'nope')).status, 415);
    assert.equal((await analyze({ 'Content-Type': 'audio/webm' }, new Uint8Array([1, 2, 3, 4]))).status, 400);
    assert.equal((await analyze({ 'Content-Type': 'audio/webm', 'X-Practice-Prompt': btoa('Hello there') }, new Uint8Array())).status, 400);
    assert.equal((await analyze({ 'Content-Type': 'audio/webm', 'X-Practice-Prompt': btoa('Hello there') }, new Uint8Array([1, 2, 3, 4]))).status, 503);
    assert.equal((await db.prepare("SELECT key FROM auth_limits WHERE key LIKE 'analysis:%'").all()).results.length, 0);
    assert.equal((await call('/api/auth/logout', 'POST', {}, signedIn)).status, 200);
    assert.equal((await call('/api/state', 'GET', undefined, signedIn)).status, 401);
    const hash = signedIn.split('=')[1];
    await db.prepare('UPDATE sessions SET expires_at = 0').run();
    assert.equal((await call('/api/state', 'GET', undefined, first)).status, 401);
    const stored = await db.prepare('SELECT password_hash FROM users WHERE email = ?').bind(credentials.email).first();
    assert.notEqual(stored.password_hash, credentials.password);
    assert.notEqual(stored.password_hash, hash);
    for (let i = 0; i < 3; i++) assert.equal((await call('/api/auth/login', 'POST', credentials)).status, 200);
    const attacker = '203.0.113.20';
    for (let i = 0; i < 10; i++) assert.equal((await call('/api/auth/login', 'POST', { ...credentials, password: 'wrong-long-password' }, null, 'https://lilt.test', attacker)).status, 401);
    assert.equal((await call('/api/auth/login', 'POST', credentials, null, 'https://lilt.test', attacker)).status, 429);
    assert.equal((await call('/api/auth/login', 'POST', credentials, null, 'https://lilt.test', '203.0.113.21')).status, 200);
    const resetting = '203.0.113.30';
    for (let i = 0; i < 9; i++) assert.equal((await call('/api/auth/login', 'POST', { ...credentials, password: 'wrong-long-password' }, null, 'https://lilt.test', resetting)).status, 401);
    assert.equal((await call('/api/auth/login', 'POST', credentials, null, 'https://lilt.test', resetting)).status, 200);
    assert.equal((await call('/api/auth/login', 'POST', { ...credentials, password: 'wrong-long-password' }, null, 'https://lilt.test', resetting)).status, 401);
    const digestHex = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const blockedIp = '198.51.100.40';
    await db.prepare('INSERT INTO auth_limits (key, count, expires_at) VALUES (?, 50, ?)').bind(`ipfail:${await digestHex(blockedIp)}`, Date.now() + 600000).run();
    assert.equal((await call('/api/auth/login', 'POST', credentials, null, 'https://lilt.test', blockedIp)).status, 429);
    assert.equal((await db.prepare("SELECT key FROM auth_limits WHERE key LIKE 'email:%'").all()).results.length, 0);
  } finally { await mf.dispose(); }
});
