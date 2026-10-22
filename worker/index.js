const encoder = new TextEncoder();
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const MAX_BODY = 1024 * 1024;
const MAX_ANALYSIS_AUDIO = 4 * 1024 * 1024;
const json = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
});
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}

function cookie(request, token, age = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:';
  return `${secure ? '__Host-lilt_session' : 'lilt_session'}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
}

async function session(request, db) {
  const name = new URL(request.url).protocol === 'https:' ? '__Host-lilt_session' : 'lilt_session';
  const token = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  const user = await db.prepare('SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').bind(tokenHash, Date.now()).first();
  return user ? { ...user, tokenHash } : null;
}

async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Use application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Request body required.');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'Progress exceeds the 1 MB limit. Export a backup before trimming history.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

async function audioBytes(request) {
  const reader=request.body?.getReader();
  if(!reader)throw new HttpError(400,'Audio recording is required.');
  const chunks=[];let size=0;
  while(true){
    const {value,done}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>MAX_ANALYSIS_AUDIO){await reader.cancel();throw new HttpError(413,'This recording is too large. Keep the prompt recording under 4 MB.');}
    chunks.push(value);
  }
  if(!size)throw new HttpError(400,'Audio recording is empty.');
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return bytes;
}

function toBase64(bytes){
  let binary='';const block=0x8000;
  for(let offset=0;offset<bytes.length;offset+=block)binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+block,bytes.length)));
  return btoa(binary);
}

function promptHeader(value){
  if(!value||value.length>2048||!/^[A-Za-z0-9+/]+=*$/.test(value))throw new HttpError(400,'A valid course prompt is required.');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),character=>character.charCodeAt(0)))}catch{throw new HttpError(400,'The course prompt could not be decoded.')}
  if(!text.trim()||text.length>1000)throw new HttpError(400,'The course prompt is invalid.');
  return text;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !['bright', 'balanced', 'mature', 'tomboy', 'ramona'].includes(state.goal) ||
      !Array.isArray(state.attempts) || !Array.isArray(state.completed) ||
      typeof state.saveAudio !== 'boolean' || typeof state.voice !== 'string' || state.voice.length > 500 ||
      !Number.isFinite(state.rate) || state.rate < 0.1 || state.rate > 3 ||
      !(state.sessionStarted === null || Number.isFinite(state.sessionStarted))) {
    throw new HttpError(400, 'Invalid progress or settings.');
  }
  // Text fields are rendered into the existing app's HTML. Reject markup in saved data.
  const inspect = (value, depth = 0) => {
    if (depth > 20) throw new HttpError(400, 'Progress is nested too deeply.');
    if (typeof value === 'string' && /[<>]/.test(value)) throw new HttpError(400, 'Progress text cannot contain markup.');
    if (value && typeof value === 'object') for (const item of Object.values(value)) inspect(item, depth + 1);
  };
  inspect(state);
  for (const attempt of state.attempts) {
    if (!attempt || typeof attempt.id !== 'string' || typeof attempt.date !== 'string' || !Number.isFinite(Date.parse(attempt.date)) ||
        typeof attempt.lessonTitle !== 'string' || !Number.isFinite(attempt.overall) || !attempt.scores ||
        !['pitch', 'brightness', 'movement', 'ease'].every(key => Number.isFinite(attempt.scores[key]))) throw new HttpError(400, 'Invalid attempt.');
  }
  for (const item of state.completed) if (!item || typeof item.lesson !== 'string' || typeof item.date !== 'string') throw new HttpError(400, 'Invalid completion.');
  return {
    goal: state.goal,
    attempts: state.attempts,
    completed: state.completed,
    saveAudio: state.saveAudio,
    rate: state.rate,
    voice: state.voice,
    sessionStarted: state.sessionStarted,
    driveLog: validateDriveLog(state.driveLog),
    baselineAttemptId: validateBaselineId(state.baselineAttemptId),
    pausedSession: validatePausedSession(state.pausedSession)
  };
}

function validateBaselineId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 80) throw new HttpError(400, 'Invalid baseline.');
  return value;
}

function validatePausedSession(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid rest pause.');
  const activity = value.activity ?? null;
  if (typeof value.lesson !== 'string' || value.lesson.length < 1 || value.lesson.length > 80 ||
      !(activity === null || (typeof activity === 'string' && activity.length > 0 && activity.length <= 80)) ||
      typeof value.date !== 'string' || !Number.isFinite(Date.parse(value.date)) ||
      !Number.isInteger(value.comfort) || value.comfort < 1 || value.comfort > 5 ||
      (value.lessonTitle != null && (typeof value.lessonTitle !== 'string' || value.lessonTitle.length > 120))) {
    throw new HttpError(400, 'Invalid rest pause.');
  }
  return { lesson: value.lesson, activity, date: value.date, comfort: value.comfort, lessonTitle: value.lessonTitle || '' };
}

const COACH_FLAGS = ['drop', 'chesty', 'heavy', 'fry', 'strain', 'dark', 'low', 'breath'];

function validateCoach(entry) {
  const coach = entry.coach;
  if (!coach || typeof coach !== 'object' || Array.isArray(coach)) throw new HttpError(400, 'Invalid drive log.');
  if (!Number.isFinite(coach.minutes) || coach.minutes < 0 || coach.minutes > 120) throw new HttpError(400, 'Invalid drive log.');
  if (!['lines', 'free'].includes(coach.mode)) throw new HttpError(400, 'Invalid drive log.');
  if (typeof coach.comfortKnown !== 'boolean' || typeof coach.comfortPaused !== 'boolean' || typeof coach.restSuggested !== 'boolean') throw new HttpError(400, 'Invalid drive log.');
  if (typeof coach.summary !== 'string' || coach.summary.length > 240) throw new HttpError(400, 'Invalid drive log.');
  if (!Array.isArray(coach.phrases) || coach.phrases.length > 30) throw new HttpError(400, 'Invalid drive log.');
  const phrases = coach.phrases.map(phrase => {
    if (!phrase || typeof phrase.prompt !== 'string' || typeof phrase.transcript !== 'string' || typeof phrase.feedback !== 'string') throw new HttpError(400, 'Invalid drive log.');
    if (phrase.prompt.length > 180 || phrase.transcript.length > 180 || phrase.feedback.length > 240) throw new HttpError(400, 'Invalid drive log.');
    if (!['masculine', 'androgynous', 'feminine', 'unsure'].includes(phrase.profile) || typeof phrase.tooNoisy !== 'boolean') throw new HttpError(400, 'Invalid drive log.');
    if (!Array.isArray(phrase.words) || phrase.words.length > 16) throw new HttpError(400, 'Invalid drive log.');
    return {
      prompt: phrase.prompt,
      transcript: phrase.transcript,
      feedback: phrase.feedback,
      profile: phrase.profile,
      tooNoisy: phrase.tooNoisy,
      words: phrase.words.map(word => {
        if (!word || typeof word.text !== 'string' || word.text.length > 32 || !Array.isArray(word.flags) || word.flags.length > 4) throw new HttpError(400, 'Invalid drive log.');
        if (word.flags.some(flag => !COACH_FLAGS.includes(flag))) throw new HttpError(400, 'Invalid drive log.');
        return { text: word.text, flags: word.flags };
      })
    };
  });
  return {
    minutes: coach.minutes,
    mode: coach.mode,
    comfortKnown: coach.comfortKnown,
    comfortPaused: coach.comfortPaused,
    restSuggested: coach.restSuggested,
    summary: coach.summary,
    phrases
  };
}

function validateDriveLog(driveLog) {
  if (driveLog == null) return [];
  if (!Array.isArray(driveLog) || driveLog.length > 500) throw new HttpError(400, 'Invalid drive log.');
  return driveLog.map(entry => {
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 80 ||
        typeof entry.date !== 'string' || !Number.isFinite(Date.parse(entry.date)) ||
        typeof entry.routineId !== 'string' || entry.routineId.length > 40 ||
        ![20, 30, 40].includes(entry.plannedMinutes) ||
        !['yes', 'partly', 'no'].includes(entry.cueHeld)) throw new HttpError(400, 'Invalid drive log.');
    const unrated = entry.kind === 'coach' && entry.coach?.comfortKnown === false;
    const rated = Number.isInteger(entry.comfort) && entry.comfort >= 1 && entry.comfort <= 5;
    if (!(unrated ? entry.comfort == null || rated : rated)) throw new HttpError(400, 'Invalid drive log.');
    if (entry.kind == null) {
      if (![0, 20, 30, 40].includes(entry.actualMinutes)) throw new HttpError(400, 'Invalid drive log.');
      return { id: entry.id, date: entry.date, routineId: entry.routineId, plannedMinutes: entry.plannedMinutes, actualMinutes: entry.actualMinutes, comfort: entry.comfort, cueHeld: entry.cueHeld };
    }
    if (entry.kind !== 'coach' || !Number.isInteger(entry.actualMinutes) || entry.actualMinutes < 0 || entry.actualMinutes > 120) throw new HttpError(400, 'Invalid drive log.');
    return {
      id: entry.id, date: entry.date, routineId: entry.routineId, plannedMinutes: entry.plannedMinutes,
      actualMinutes: entry.actualMinutes, comfort: entry.comfort, cueHeld: entry.cueHeld, kind: 'coach', coach: validateCoach(entry)
    };
  });
}

const IP_FAILURE_LIMIT = 50;
const LOGIN_FAILURE_LIMIT = 10;

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

async function bumpLimit(db, key) {
  const now = Date.now();
  const result = await db.prepare('INSERT INTO auth_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count').bind(key, now + 15 * 60 * 1000, now, now).first();
  return result.count;
}

async function assertUnderLimit(db, key, maximum) {
  const now = Date.now();
  const row = await db.prepare('SELECT count, expires_at FROM auth_limits WHERE key = ?').bind(key).first();
  if (row && row.expires_at > now && row.count >= maximum) throw new HttpError(429, 'Too many requests. Try again in 15 minutes.');
}

async function limit(db, key, maximum = 20) {
  const count = await bumpLimit(db, key);
  if (count > maximum) throw new HttpError(429, 'Too many requests. Try again in 15 minutes.');
}

async function api(request, env) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return json({ error: 'Method not allowed.' }, 405);
  if (method !== 'GET' && request.headers.get('Origin') !== new URL(request.url).origin) throw new HttpError(403, 'Request must come from this app.');
  const db = env.DB;
  if ((path === '/api/auth/register' || path === '/api/auth/login') && method === 'POST') {
    const input = await body(request);
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = input?.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 128) throw new HttpError(400, 'Enter an email and a password with 12–128 characters.');
    const ipFailKey = `ipfail:${await digest(clientIp(request))}`;
    const loginFailKey = `fail:${await digest(`${email}|${clientIp(request)}`)}`;
    await assertUnderLimit(db, ipFailKey, IP_FAILURE_LIMIT);
    if (path.endsWith('login')) await assertUnderLimit(db, loginFailKey, LOGIN_FAILURE_LIMIT);
    let user;
    if (path.endsWith('register')) {
      const id = crypto.randomUUID(), salt = randomToken();
      const hash = await passwordHash(password, salt);
      const result = await db.prepare('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(id, email, hash, salt, Date.now()).run();
      if (!result.meta.changes) {
        await bumpLimit(db, ipFailKey);
        throw new HttpError(409, 'Unable to create this account. Try signing in.');
      }
      user = { id, email };
    } else {
      user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      const hash = await passwordHash(password, user?.salt || 'lilt-dummy-password-salt');
      // Compare fixed-size hashes using the Workers constant-time Web Crypto extension.
      const expected = user?.password_hash || '0'.repeat(64);
      if (!crypto.subtle.timingSafeEqual(encoder.encode(hash), encoder.encode(expected)) || !user) {
        await bumpLimit(db, loginFailKey);
        await bumpLimit(db, ipFailKey);
        throw new HttpError(401, 'Email or password is incorrect.');
      }
      await db.prepare('DELETE FROM auth_limits WHERE key = ?').bind(loginFailKey).run();
    }
    const token = randomToken();
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()),
      db.prepare('DELETE FROM auth_limits WHERE expires_at <= ?').bind(Date.now()),
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await digest(token), user.id, Date.now() + SESSION_SECONDS * 1000)
    ]);
    return json({ user: { id: user.id, email: user.email } }, 200, { 'Set-Cookie': cookie(request, token) });
  }
  const user = await session(request, db);
  if (!user) throw new HttpError(401, 'Sign in to access your progress.');
  if(path==='/api/analyze'&&method==='POST'){
    const contentType=(request.headers.get('Content-Type')||'').split(';')[0].toLowerCase();
    if(!['audio/webm','audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/ogg','audio/flac'].includes(contentType))throw new HttpError(415,'Use a WebM, WAV, MP3, MP4, OGG, or FLAC recording.');
    const prompt=promptHeader(request.headers.get('X-Practice-Prompt')||'');
    const bytes=await audioBytes(request);
    if(!env.AI)throw new HttpError(503,'Cloud transcription is not configured for this deployment.');
    await limit(db,`analysis:${user.id}`,12);
    try{
      const output=await env.AI.run('@cf/openai/whisper-large-v3-turbo',{audio:toBase64(bytes),task:'transcribe',language:'en',vad_filter:true,initial_prompt:prompt});
      const text=String(output?.text||output?.transcription_info?.text||'').trim();
      const vtt=String(output?.vtt||output?.segments?.map?.(segment=>segment.vtt||'').join('\n')||'');
      if(!text)throw new Error('Workers AI returned an empty transcript.');
      const segments=Array.isArray(output?.segments)?output.segments:[];
      return json({text,vtt,segments,model:'@cf/openai/whisper-large-v3-turbo'});
    }catch(error){
      console.error(JSON.stringify({message:'Workers AI transcription failed',userId:user.id,error:error instanceof Error?error.message:String(error)}));
      throw new HttpError(502,'Cloud transcription failed. Your on-device acoustic score is still available.');
    }
  }
  if (path === '/api/auth/me' && method === 'GET') return json({ user: { id: user.id, email: user.email } });
  if (path === '/api/auth/logout' && method === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
  }
  if (path === '/api/state' && method === 'GET') {
    const row = await db.prepare('SELECT data, version FROM user_state WHERE user_id = ?').bind(user.id).first();
    return json({ state: row ? JSON.parse(row.data) : null, version: row?.version ?? 0 });
  }
  if (path === '/api/drive/turn' && method === 'POST') return driveTurn(request, env, db, user);
  if (path === '/api/state' && method === 'PUT') {
    const input = await body(request);
    const state = validateState(input?.state);
    if (!Number.isSafeInteger(input.version) || input.version < 0) throw new HttpError(400, 'Invalid version.');
    const result = input.version === 0
      ? await db.prepare('INSERT INTO user_state (user_id, data, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING').bind(user.id, JSON.stringify(state), Date.now()).run()
      : await db.prepare('UPDATE user_state SET data = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?').bind(JSON.stringify(state), Date.now(), user.id, input.version).run();
    if (!result.meta.changes) {
      const current = await db.prepare('SELECT version FROM user_state WHERE user_id = ?').bind(user.id).first();
      return json({ error: 'Progress changed in another tab or device.', version: current?.version ?? 0 }, 409);
    }
    return json({ version: input.version + 1 });
  }
  return json({ error: 'Not found.' }, 404);
}

const DRIVE_QUESTIONS = {
  feminine: { type: 'noul', instructions: 'Does this short phrase read as feminine or woman-like?' },
  masculine: { type: 'noul', instructions: 'Does this short phrase read as masculine or man-like?' },
  chesty: { type: 'noul', instructions: 'Does a word sound chesty, dark, or backed in the throat?' },
  heavy: { type: 'noul', instructions: 'Does a word sound heavy, buzzy, or thick in the chest?' },
  strained: { type: 'noul', instructions: 'Does the voice sound strained, pressed, or pushed?' },
  fry: { type: 'noul', instructions: 'Is there vocal fry or a creak, especially near the end?' },
  drop: { type: 'noul', instructions: 'Does the pitch fall at the end of a word or the phrase?' }
};

function readNoul(value) {
  if (typeof value === 'number') return value;
  const noul = value?.noul ?? value?.probability;
  return Number.isFinite(Number(noul)) ? Number(noul) : null;
}

function wordsFromTranscript(output) {
  const alternatives = output?.results?.channels?.[0]?.alternatives?.[0];
  const raw = alternatives?.words || output?.words || [];
  const words = (Array.isArray(raw) ? raw : []).map(word => ({
    text: String(word.word || word.punctuated_word || ''),
    start: Number(word.start),
    end: Number(word.end)
  })).filter(word => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  if (words.length) return { text: String(alternatives?.transcript || words.map(word => word.text).join(' ')).trim(), words };
  const segments = Array.isArray(output?.segments) ? output.segments : [];
  const segmented = segments.flatMap(segment => Array.isArray(segment.words) ? segment.words : []).map(word => ({
    text: String(word.word || ''),
    start: Number(word.start),
    end: Number(word.end)
  })).filter(word => word.text && Number.isFinite(word.start) && word.end > word.start);
  const text = String(output?.text || output?.transcription_info?.text || alternatives?.transcript || '').trim();
  return { text, words: segmented };
}

async function speakLine(env, say) {
  try {
    const response = await env.AI.run('@cf/deepgram/aura-2-en', { text: say, speaker: 'luna', encoding: 'mp3' }, { returnRawResponse: true });
    const bytes = response?.arrayBuffer ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array(response);
    if (!bytes?.length) return null;
    return { model: '@cf/deepgram/aura-2-en', audioBase64: toBase64(bytes), mime: 'audio/mpeg' };
  } catch (error) {
    console.error(JSON.stringify({ message: 'aura-2 failed', error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

async function driveTurn(request, env, db, user) {
  const input = await body(request);
  const audio = typeof input?.audioBase64 === 'string' ? input.audioBase64 : '';
  const say = typeof input?.say === 'string' ? input.say.replace(/[<>]/g, '').slice(0, 280) : '';
  if ((!audio && !say) || audio.length > 900000) throw new HttpError(400, 'Send a short WAV phrase.');
  if (!env.AI) throw new HttpError(503, 'Drive coach cloud models are not configured. On-device coaching still runs.');
  await limit(db, `drive:${user.id}`, 160);
  const started = Date.now();
  if (!audio) {
    const speech = await speakLine(env, say);
    return json({ transcript: '', words: [], sttModel: null, ear: null, earModel: null, speech, latencyMs: Date.now() - started });
  }
  const audioUrl = audio.startsWith('data:') ? audio : `data:audio/wav;base64,${audio}`;
  const transcribe = (async () => {
    try {
      // nova-3 takes the audio as { body, contentType }. A data: URL fails schema validation.
      const wav = Uint8Array.from(atob(audio.replace(/^data:[^,]*,/, '')), character => character.charCodeAt(0));
      const nova = await env.AI.run('@cf/deepgram/nova-3', { audio: { body: new Blob([wav]).stream(), contentType: 'audio/wav' }, punctuate: true, smart_format: false });
      const parsed = wordsFromTranscript(nova);
      if (parsed.text) return { ...parsed, model: '@cf/deepgram/nova-3' };
    } catch (error) {
      console.error(JSON.stringify({ message: 'nova-3 failed', error: error instanceof Error ? error.message : String(error) }));
    }
    try {
      const whisper = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio, task: 'transcribe', language: 'en', vad_filter: true });
      const parsed = wordsFromTranscript(whisper);
      return { ...parsed, model: '@cf/openai/whisper-large-v3-turbo' };
    } catch (error) {
      console.error(JSON.stringify({ message: 'whisper fallback failed', error: error instanceof Error ? error.message : String(error) }));
      return { text: '', words: [], model: null };
    }
  })();
  const ear = (async () => {
    try {
      const output = await env.AI.run('@cf/cloudflare/clef-omni', { model: 'clef-omni', state: {}, audio: [audioUrl], questions: DRIVE_QUESTIONS });
      const answers = output?.answers || {};
      return {
        model: '@cf/cloudflare/clef-omni',
        answers: Object.fromEntries(Object.keys(DRIVE_QUESTIONS).map(key => [key, readNoul(answers[key])])),
        usage: output?.usage || null
      };
    } catch (error) {
      console.error(JSON.stringify({ message: 'clef-omni failed', error: error instanceof Error ? error.message : String(error) }));
      return { model: null, answers: null, usage: null };
    }
  })();
  const speech = say ? speakLine(env, say) : Promise.resolve(null);
  const [transcript, heard, spoken] = await Promise.all([transcribe, ear, speech]);
  return json({
    transcript: transcript.text || '',
    words: transcript.words || [],
    sttModel: transcript.model,
    ear: heard.answers,
    earModel: heard.model,
    usage: heard.usage,
    speech: spoken,
    latencyMs: Date.now() - started
  });
}

export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) return await api(request, env);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ message: 'Request failed', path: new URL(request.url).pathname, error: error.message }));
      return json({ error: 'Server error. Please try again.' }, 500);
    }
  }
};
