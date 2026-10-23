# Lilt

Lilt is a voice-practice web app focused on gender-affirming voice exploration, hosted on Cloudflare Workers with D1 account storage and optional Workers AI transcription. It includes email/password login, an eight-week, 40-session course, 50 focused drills, live microphone analysis, five target presets, exact-prompt speech playback, persistent progress, optional locally saved audio, and JSON export.

## Course and feedback

The self-paced course uses five short sessions per training week, with flexible rest days. It moves through vocal ease, resonance and perceived size, pitch floor and flexibility, vocal weight and onset, prosody and articulation, everyday transfer, durability, recovery, and independent maintenance. Every session has a concrete objective, four sequenced activities, and a reflection prompt. The complete drill library is also available for open practice.

After each take, Lilt reports median pitch, pitch floor and ceiling, target coverage, pitch-aware spectral balance and coverage, pitch movement, phrase-ending direction, volume variation, estimated pace, browser phrase match, voiced continuity, and pitch-estimation confidence. The stricter acoustic-only score tops out at 92 and rewards closeness to each practice band's center plus target coverage; merely being inside a broad band no longer earns a perfect component. Once a baseline snapshot is saved, the overall also includes change from that take: more of the blend in weeks 1–2, half in weeks 3–5 and open practice, and less in weeks 6–8. With no baseline, the overall stays the distance to the goal band. A score of 100 additionally requires strong scores/coverage and a report that at least three unfamiliar listeners consistently read the voice as female in spontaneous conversation. This is user-reported evidence, not a validated pass/fail judgment. Spectral balance is an approximate, microphone- and vowel-sensitive resonance proxy, not a direct gender or vocal-tract measurement. A comfort rating of 1 or 2 saves the take and pauses the session instead of opening the next drill. The same drill can be resumed from Today.

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

Use a password of 12–128 characters. Passwords are salted and hashed with PBKDF2-SHA-256 (100,000 iterations); random session tokens are stored as SHA-256 hashes in D1. Sessions expire after 30 days. Production cookies use Secure, HttpOnly, SameSite, and the `__Host-` prefix. Write requests require the app's origin. Failed sign-in attempts are rate limited per IP, and failed logins are also limited per email plus IP. A successful login clears that email’s failure count, so signing in does not lock the account. Email addresses are login identifiers; email verification and password recovery are not implemented.

Progress, scores, transcripts, course completion, and preferences are isolated by account. Saves keep the newest account version and merge attempts, drive check-ins, and course completions if two devices save at once. Retry saving reloads the server copy and merges this device’s pending changes. Failed saves retain a per-account device backup; export a JSON backup in Settings, or choose Load latest progress to discard pending changes. Saved history keeps the latest 300 takes, drops stored word-coaching paragraphs, and stays within the 1 MB save limit. Sign out waits for pending saves.

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

## Publishing

Every commit on this computer pushes the current branch to GitHub and deploys the Cloudflare Worker. The hook is `.githooks/post-commit`, enabled with `git config core.hooksPath .githooks`.

## Drive coach

Drive coach can match two voices. **Aurora** (xAI TTS `voice_id` `aurora`) is the default and the voice to land on. **Easier practice** is Kokoro `af_bella`, a temporary higher, lighter target. On a multi-sentence Aurora sample at speed 0.95, the same `analyzePcm` path used in the app measures pitch median about 171.9 Hz (p10 ~155, p90 ~250), brightness median about −13.6 dB (p10 ~−25.4, p90 ~4.6), and H1–H2 median about −5.9 dB. Bella, on the same kind of paragraph at speed 0.95, sits near 212 Hz with a light tone (H1–H2 about +8 dB). Sky (`af_sky`) sits near 152 Hz with a dark spectrum (centroid near 990 Hz), so it is a smaller step up from a lower voice, not an easier one. The choice is stored in this browser. Clips and coaching follow the voice that is selected. Coach clips live at `public/voice/<hash>.mp3`. Practice clips stay under `public/voice/af_bella/`. The default Balanced femme goal used by Drive is pitch [160, 210] Hz and brightness [−16, −10] dB, so scoring sits on Aurora’s measured pitch and darker spectral balance. Bella’s cues name her placement: a higher lighter pitch, a thin easy start, and the tongue a little farther forward.

Drive coach is the hands-free practice loop. One **Start Drive coach** button opens a full-screen page. The browser keeps a single `AudioContext`, a fixed-length utterance buffer, and a pre-roll ring. The on-device line is spoken as soon as a phrase ends. The page then posts that utterance to `POST /api/drive/turn` with a short timeout, and uses the reply only as a follow-up. The Worker runs Workers AI speech-to-text (`@cf/deepgram/nova-3`, Whisper large v3 turbo as fallback), an optional `@cf/cloudflare/clef-omni` ear check, and `@cf/deepgram/aura-2-en` speech (speaker `luna`) in parallel. Pitch, formants, vocal-tract length, spectral tilt, and fry are measured in the browser. The spoken line is one or two sentences from `drive-cues.js`, and only a word whose measured confidence is at least 0.62 is named. A clean phrase gets no praise line. The gender-leaning read (feminine, masculine, or unsure) is stored on the phrase and is not spoken. Androgynous remains a valid saved label from earlier sessions. Settings and the privacy note say that Drive coach sends each phrase for a transcript and a second listen.

This does not use `@cloudflare/voice` `withVoice`. That loop only hands the page a transcript, so it cannot score her audio or keep the coach's own voice out of the take. There is no Durable Object. A coach check-in is a drive-log row with `kind: "coach"`, so older drive logs stay valid. Sessions under about 20 seconds are not written. The in-memory phrase list is capped, and a checkpoint is persisted every few phrases.

On an iPhone, add Lilt to the Home Screen. Starting Drive coach requests a screen Wake Lock from that tap, asks again when the page becomes visible, and releases the lock when the session stops. If the browser has no Wake Lock API, or the request fails, the same tap plays `stay-awake.mp4`: one muted, inline, looping video, two pixels on screen. The page says “Screen stays on.” If neither method works, it says “Set Auto-Lock to Never during drives.” There is no timer and no canvas redraw. Switching apps pauses the coach, stops the microphone, and suspends the one audio context. Coming back re-acquires the lock and resumes the same session. A call, Siri, CarPlay, or a Bluetooth route change pauses and resumes when audio returns. Saves that fail offline stay queued and flush when the network returns.

Do not deploy from this branch unless June asks. `npm run deploy` publishes the Worker.

### Re-running the Drive coach checks

`npm test` runs the harnesses that do not need June's recording. It passes `--expose-gc`, which the soak uses.

| Check | Command | What it prints or asserts |
| --- | --- | --- |
| Cue library, confidence gate, synthetic issue precision/recall, commands, praise | `node --test tests/drive-coach.test.mjs` | Physical cues stay one sentence, rotate, and contain no HTML. Clean words are not flagged. A labeled phrase must catch strain, a pitch drop, chest or weight, and fry. |
| Generated road noise | same file | Twelve seconds of synthetic road noise opens no turn. A phrase mixed at 5 dB does not invent a spoken issue when the take is too noisy. |
| 40-minute memory soak | `node --expose-gc --test tests/coach-soak.test.mjs` | Loops speech plus noise for 40 simulated minutes and hides the page once a minute. Logs heap at the start, 20 minutes, and 40 minutes. The second 20 minutes must grow by less than 8 MB. The phrase log stays capped. The wake lock and the fallback video stay at one instance each, and the module does not start a timer or a canvas loop. |
| iPhone Safari Drive, ~40 minutes | `npm run test:ios-drive` | Also part of `npm test`. Permission sheet, a repeat whose audio arrives only through the iPhone mic graph, spoken feedback, all 53 week-1 lines, route flicker, a held drop, `next phrase`, mic denial, a dropped track, and hiding the page. Fails if the reply never plays. What still needs the phone is `qa/iphone-safari-drive.md`. |
| iPhone Safari Drive, ~40 minutes | `npm run test:ios-drive` | Also part of `npm test`. Permission sheet, a repeat whose audio arrives only through the iPhone mic graph, spoken feedback, all 53 week-1 lines, route flicker, a held drop, `next phrase`, mic denial, a dropped track, and hiding the page. Fails if the reply never plays. What still needs the phone is `qa/iphone-safari-drive.md`. |
| Coach progress shape | `node --test tests/worker.test.mjs` | A `kind: "coach"` row round-trips. Markup inside feedback is rejected. |

Masculine/feminine profiling uses OpenSLR LibriSpeech train-clean-100 (CC BY 4.0), streamed from the Hugging Face mirror `openslr/librispeech_asr`. Audio is written under `/tmp/lilt-profile` and must not be committed.

```bash
python3 scripts/fetch-profile-audio.py
node scripts/profile-eval.mjs
```

The fetch needs `datasets`, `soundfile`, and NumPy 2. It saves 100 feminine and 100 masculine speakers, one clip each, at 16 kHz float32. `scripts/profile-split.mjs` holds out about 65 of each label, including low-pitched and high-pitched tails. Weights in `drive-coach.js` were chosen on the calibration speakers only. The read uses median pitch plus median F2 on voiced vowels, with the part of F2 predicted by pitch removed. A gap under 230 Hz stays with pitch. A confident pitch read becomes unsure instead of flipping unless that gap is at least 320 Hz. Below 0.62 probability either way, the label is unsure. The eval scores that acoustic read clean and remixed with synthetic road noise at 10 dB, and compares it with a pitch-only read. Results go to the terminal and to `/tmp/lilt-profile/report.json`. On the held-out speakers the retuned read was 107 of 132 (81%), with 2 opposite-gender guesses and 23 unsures. The earlier read on its 110-speaker table was 48 of 110 (44%). A pitch-only read on the same held-out speakers was 111 of 132 (84%), with 4 opposite-gender guesses. At 10 dB the retuned read was 105 of 132 (80%). Clef-omni is blended in the product only when its probability is at least 0.62; this offline table is the acoustic read. LibriSpeech is read-aloud English, so accent variety is limited.

June's latte recording and the road-noise mixes are not in the repository. If you already have the 16 kHz mono float32 files locally, point the harness at that directory:

```bash
DRIVE_AUDIO_DIR=/tmp/lilt-audio node scripts/road-noise-eval.mjs
```

Expected names, if you have them: `take1_20261021_2334_1fad.f32`, `take1_road_snr20_bcde.f32`, `take1_road_snr10_c5d9.f32`, `take1_road_snr5_19f3.f32`, `road_only_46cf.f32`. The script prints turns, the tracker SNR, whether the take was called too noisy, the spoken line, and the confident flags. If the directory is missing it exits without downloading anything.

A local browser pass can feed a file instead of the microphone: `npm run db:local && npm run dev`, sign in, and open `http://localhost:8787/?coachTest=1`.

## Drive practice

Drive practice has no set length. Phrases run from easiest to hardest, up to three tries each, until you tap End practice or finish the bank. Today’s routine matches the current course week. After all 40 sessions are complete, the maintenance routine is used. An optional check-in logs comfort and whether the cue held. The coach log counts the minutes you actually spoke toward the weekly minute ring, the streak, and Progress practice time. It does not complete a course activity.

- <https://www.asha.org/practice-portal/professional-issues/gender-affirming-voice-and-communication/>
- <https://transcare.ucsf.edu/guidelines/vocal-health>
- <https://commonvoice.mozilla.org/en/datasets>
- <https://librivox.org/>
