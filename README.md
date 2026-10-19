# Lilt

Lilt is a voice-practice web app focused on gender-affirming voice exploration, hosted on Cloudflare Workers with D1 account storage and optional Workers AI transcription. It includes email/password login, an eight-week, 40-session course, 50 focused drills, live microphone analysis, five target presets, exact-prompt speech playback, persistent progress, optional locally saved audio, and JSON export.

## Course and feedback

The self-paced course uses five short sessions per training week, with flexible rest days. It moves through vocal ease, resonance and perceived size, pitch floor and flexibility, vocal weight and onset, prosody and articulation, everyday transfer, durability, recovery, and independent maintenance. Every session has a concrete objective, four sequenced activities, and a reflection prompt. The complete drill library is also available for open practice.

After each take, Lilt reports median pitch, pitch floor and ceiling, target coverage, pitch-aware spectral balance and coverage, pitch movement, phrase-ending direction, volume variation, estimated pace, browser phrase match, voiced continuity, and pitch-estimation confidence. The stricter acoustic-only score tops out at 92 and rewards closeness to each practice band's center plus target coverage; merely being inside a broad band no longer earns a perfect component. A score of 100 additionally requires strong scores/coverage and a report that at least three unfamiliar listeners consistently read the voice as female in spontaneous conversation. This is user-reported evidence, not a validated pass/fail judgment. Spectral balance is an approximate, microphone- and vowel-sensitive resonance proxy, not a direct gender or vocal-tract measurement.

For a course activity, “Analyze words with Workers AI” sends the current recording (up to two minutes and 4 MB) to the authenticated Worker only after you press the button. Cloudflare Workers AI Whisper returns a transcript and timestamps. Approximate word locations are cross-checked against the expected prompt before the app shows per-word acoustic proxies and playback controls. Low agreement or too few voiced frames suppresses corrective word feedback. Phoneme-level timing and phoneme-specific feedback are not implemented yet.

The practice play button speaks the exact displayed prompt using the device speech engine and requests an `en-US` voice. Available voices and quality depend on the browser and operating system. Ramona-inspired practice offers separately labeled official Netflix/Universal YouTube clips as character inspiration; they are not the course prompt or an American-accent model. No copyrighted dialogue is copied into the app.

Word labels such as masculine-leaning or feminine-leaning are experimental comparisons to the selected preset, based on pitch and spectral balance. They are not validated listener judgments, a phoneme classifier, or a determination of gender. Physical cues are practice suggestions; audio does not reveal tongue posture directly. Cloud transcription uses the Workers AI Whisper large v3 turbo model; check Cloudflare's [current model pricing and limits](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/) before frequent use.

## Run locally

Install dependencies, apply the local D1 migration, and start the Worker:

```bash
npm install
npm run db:local
npm run dev
```

Then open <http://localhost:8787> and create an account. Microphone APIs require HTTPS or localhost. Firefox supports acoustic analysis but does not currently expose the same speech-recognition API. A plain static HTTP server does not provide the login or persistence API.

## Cloudflare deployment

The connected Cloudflare account's `lilt-db` database is provisioned and the initial migration has been applied. `wrangler.jsonc` contains its account and database IDs. The Worker is named `lilt`. To publish from the CLI:

```bash
npx wrangler login
npm run db:remote
npm run deploy
```

`db:remote` tracks migrations and skips those already applied. For a different account, create a database with `npx wrangler d1 create lilt-db`, update the account/database IDs in `wrangler.jsonc`, then apply migrations and deploy. Public files are copied to `dist/` by an explicit allowlist; source, tests, and database migrations are not served. API routes run in the Worker and access D1 through the `DB` binding.

Run `npm run check` and `npm test` for syntax checks and integration tests in the Workers runtime. `npm run build` followed by `npx wrangler deploy --dry-run` validates packaging without publishing.

## Accounts and saving

Use a password of 12–128 characters. Passwords are salted and hashed with PBKDF2-SHA-256 (100,000 iterations); random session tokens are stored as SHA-256 hashes in D1. Sessions expire after 30 days. Production cookies use Secure, HttpOnly, SameSite, and the `__Host-` prefix. Write requests require the app's origin, and signup/login attempts are rate limited by email and IP. Email addresses are login identifiers; email verification and password recovery are not implemented.

Progress, scores, transcripts, course completion, and preferences are isolated by account. Concurrent device/tab edits are rejected rather than silently overwriting newer progress. Failed saves retain a per-account device backup; use Retry saving, or export a JSON backup in Settings and choose Load latest progress to discard pending changes. The initial release accepts up to 1 MB of progress per save; larger histories must be exported and trimmed. Sign out waits for pending saves.

Existing browser-only progress can be imported explicitly from Settings after signing in. Import replaces account progress; export existing account data first. Old browser recordings remain in their original IndexedDB database; new recordings are scoped to the signed-in account. Reset account progress clears server progress/settings and this account's recordings on the current browser; it does not delete the account or recordings on other devices.

## Privacy

- Acoustic analysis and word timestamping run in the browser with the Web Audio API and Transformers.js.
- Saved scores, transcripts, course completion, and preferences are stored in your Cloudflare D1 account data.
- Pending unsynced changes are temporarily backed up in this browser's `localStorage`.
- Optional audio is stored in account-scoped IndexedDB and does not sync across devices.
- Recordings are sent to Cloudflare only when you press “Analyze words with Workers AI”; the app does not store those uploads.
- Browser speech recognition may use a vendor service; acoustic scoring works without it.

## Measurement limits

Pitch is estimated with normalized autocorrelation. “Brightness” compares average energy in the 1.8–4.5 kHz band with the 250 Hz–1.4 kHz band on voiced frames; it is a spectral-balance practice proxy, not a clinical formant measurement or gender detector. Movement uses the 10th–90th percentile pitch span, and “signal control” is a pitch-confidence/voicing heuristic rather than a measure of vocal health. Results vary with the phrase, microphone, room, distance, accent, and vocal health. Compare takes made with the same setup.

## Training references

The curriculum follows the multidimensional approach described by the American Speech-Language-Hearing Association and UCSF Gender Affirming Health Program: pitch, resonance, intonation, vocal quality/weight, articulation, and functional communication are trained together. The in-app links point to public/open speech sources (Mozilla Common Voice and LibriVox) for permitted real-voice shadowing.

## Drive practice

Drive practice is a list you read while parked and then speak with Lilt closed. There is no prompt audio, timer, microphone, or score. Each course week has a 20-, 30-, or 40-minute routine made from lines already in the course; a longer list repeats those lines instead of adding new ones. After the course, the maintenance routine stays available. Do not use a straw, read, or play a clip while driving. Speak at any volume that stays comfortable, and stop for pain, burning, dizziness, or roughness. An optional check-in afterward logs minutes, comfort, and whether the cue held. That log counts toward the weekly minute ring and the streak. It does not complete a course activity.

- <https://www.asha.org/practice-portal/professional-issues/gender-affirming-voice-and-communication/>
- <https://transcare.ucsf.edu/guidelines/vocal-health>
- <https://commonvoice.mozilla.org/en/datasets>
- <https://librivox.org/>
