# Round 2 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `54e571f` on 22 Oct 2026. The builder’s files were not edited. The QA suite was run against `drive-session.js`. The live path (`detectTurns` → `classifyUtterance` → `spokenLine` in `drive-ui.js`) was run on the same clips. Headless WebKit clicked Start and fed a hung `/api/drive/turn`.

## Verdict

Blocking issues remain. The suite’s green run is the box reader in `drive-session.js`. The line the driver hears still comes from `drive-ui.js`, and that path still coaches the wrong fix on two clips the suite is meant to cover.

## What the suite reported, and what it actually ran

`QA_COACH_MODULE=/tmp/drive-coach/drive-session.js node --expose-gc --test qa/coach.test.mjs` passed. Matrix 12/12. Cue precision 1.00, recall 1.00. Noise passed, including “too noisy” on loud noise and on speech at −15 dB. Wake lock passed. The 40-minute soak passed. Their `tests/drive-coach.test.mjs` and `tests/coach-soak.test.mjs` passed (heap 5.8 MB at the start, 9.4 MB at 20 minutes, 14.6 MB at 40 minutes; growth in the second half was 5.0 MB; 42 wake locks issued, one held).

`createDriveSession` calls `describeTake`, which labels a clip with the practice boxes (F0 ≥ 170 and F2 ≥ 1650 feminine, F0 ≤ 140 and F2 ≤ 1250 masculine, otherwise androgynous) and emits a cue from a second set of thresholds. `profilePhrase` in `drive-coach.js` is a different fit. The comment at the top of `drive-session.js` says so.

`spokenLine` (`drive-ui.js` 287–293) consults `describeTake` only in three cases: the box reader says too noisy, the box reader says a pitch drop while the product said fry, or the product line is empty. A non-empty product line is what gets spoken.

## The six earlier blockers

| # | Earlier bug | Result at `54e571f` |
| --- | --- | --- |
| 1 | Start tap awaited the wake lock before the mic | Fixed in code and in WebKit. `clicked` calls `resume()` and `getUserMedia` in the click, then arms the lock. The stub recorded `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }`. `resume()` ran from `drive-ui.js:466`. This headless WebKit then rejected `resume()` with `InvalidStateError: Failed to start the audio device`, so the context stayed suspended and the overlay said “The microphone is needed.” That rejection is this image, which has no audio device. |
| 2 | Live mic ran AEC, noise suppression, and AGC | Fixed. `RAW_MIC` sets all three false. The WebKit stub received that object. |
| 3 | Defects missed, called “held,” or called fry | Partly fixed, and the suite no longer sees the live path. See the blocking repros. Clean speech is now silent (`composeFeedback` returns `text: ''`). Low pitch, a real within-word fall, and fry are spoken correctly on a one-word prompt. |
| 4 | Loud noise and −15 dB stayed silent | Fixed on both paths. Loud noise and the buried vowel say “This one is too noisy to coach.” Quiet and moderate noise open no turn. |
| 5 | Cue awaited the cloud, and the privacy copy denied the upload | The wait is fixed. A hung `POST /api/drive/turn` spoke the local line at 16 ms, updated the overlay at 21 ms, and aborted at 2518 ms. The Settings lede and the modal body now say each phrase is sent to Cloudflare. The modal title does not. See blocker 2. |
| 6 | A visible wake-lock release did not request again | Fixed on the success path. Releasing the sentinel while visible issued a second `request('screen')` and held the new lock. A release while hidden issued no second request. |

## Blocking

### 1. The live turn still coaches the wrong fix, and the green suite does not hear that path

- Severity: high
- Where: `drive-dsp.js` pitch track inside `analyzePcm` (the turn’s median falls an octave); `drive-coach.js` `measureWords` (a 36 Hz fall with the tail ≤ 150 Hz becomes `drop`; fry fires when `hz < 160` and `fryPeak ≥ 0.7`); `drive-ui.js` `spokenLine` (a non-empty product line wins over `describeTake`)
- Suite gap: `createDriveSession` pushes the whole clip into an 8 second ring and classifies that buffer. It does not run `createTurnDetector`.

Repro A. Clean feminine vowel mixed with moderate road noise at 10 dB SNR (`qa/corpus.mjs`, `speech-snr10`). `detectTurns` opens one turn, tracker SNR 6.9 dB, `tooNoisy` false. `classifyUtterance` with prompt `ah` says: “ah fell into fry. Take a breath before the last words, and keep air flowing so the end does not creak.” The word’s median pitch is 101 Hz and fry is set on 71% of voiced frames. `describeTake` on those same turn samples reads F0 203 Hz, F2 2125 Hz, profile feminine, and no cue. `spokenLine` keeps the fry sentence because it is non-empty. The contract for 10 dB is a feminine read and no defect cue.

Repro B. Steady breathy vowel, F0 about 195 Hz, forward F2 (`defect-breath`). The turn’s word stats are start 192 Hz, end 96 Hz, breath fraction 0.03. The spoken line is “ah dropped. Lift the end of the word so the last sound does not fall.” `describeTake` on the trimmed turn reads F0 192 Hz and no cue (`voicedFraction` 0.35, outside the 0.40–0.75 breath window). `describeTake` on the untrimmed clip, which is what the suite feeds, does say breathiness. The suite’s recall of 1.00 for breath is that untrimmed buffer. The driver hears a pitch-drop instruction for a vowel that did not drop.

- Fix: treat a tail at half the head pitch as the same fundamental, and do not speak fry or drop from that halving. Judge breath on the trimmed turn. Let `spokenLine` prefer the box read when the product line names a different defect, or stop using the box reader as a separate pass and make one classifier face both the suite and the driver.

### 2. The privacy modal still says the voice stays on the device

- Severity: high
- Where: `index.html` lines 312–313
- Current title: “Your voice stays here.” Kicker: “PRIVATE BY DEFAULT”.
- Current body: “Drive coach sends each phrase to Cloudflare for a transcript and a second listen, and does not keep that audio.” The Settings lede says the same thing.
- Repro: open the first-run privacy modal. The heading states the opposite of the paragraph under it.
- Fix: replace the kicker and the title with the fact in the paragraph. One heading is enough, for example “Drive coach sends each phrase to Cloudflare.”

## Judgments the builder asked for

### (a) Held-out LibriSpeech at 81%, with 23 unsure, against 84% for pitch alone

Acceptable. It is not a bug that a resonance model scores a few points under pitch on read-aloud speech, provided “unsure” is an honest abstention and opposite-gender mistakes stay rare.

The 81% figure was not recomputed here. `/tmp/lilt-profile` is not on this machine. `scripts/profile-eval.mjs` writes both scores through `confusion()`, which counts a match only when the label equals the speaker’s label. `unsure` is its own column, so an abstention is a miss. Pitch-only maps its `androgynous` band to `unsure` before that same function, so pitch-only abstentions are misses too. That comparison is fair. Two opposite-gender errors on the held-out set is the number that matters, and it is small.

Resonance does move the two cases June cares about, when it can see a second formant:

- Their unit test feeds frames directly. A 142 Hz voice with F2 2150 Hz is feminine while pitch alone says masculine. A 198 Hz voice with F2 1120 Hz is masculine while pitch alone says feminine.
- On the synthetic high-pitch dark vowel, wide F2 is missing on every vowel frame and local F2 is 1063 Hz. `profilePhrase` returns `unsure` (pitch alone would say feminine). It does not apply the residual, because it requires a finite wide F2 and at least six vowel frames.
- On the synthetic low-pitch forward vowel, F0 is 114 Hz, F2 is 2106 Hz, residual is +672 Hz. Pitch alone says masculine. The residual pulls the probability to about 0.44, inside the unsure band (0.38–0.62). The label is `unsure`, not masculine.

Abstaining is the right failure. A lower residual floor that flipped more of these clips was rejected in the source comment because it added opposite-gender mistakes on the held-out speakers.

### (b) The 5 dB vowel got neither a cue nor “too noisy”

Silence is right. The contract says SNR 5 must not be labeled masculine and must not get a defect cue. It does not require “too noisy.” Both the box reader and the turn detector stay silent: the mix has no voiced frames and the level stays under the loud-noise gate (RMS 0.12 for 640 ms). “Too noisy” remains required for loud noise-only and for speech at −15 dB, and both of those speak it.

### (c) Declining the synthetic F0/F2 boxes as the classifier

`profilePhrase` does not use those boxes. The reported suite pass does. `drive-session.js` is the module the suite loads, and `describeTake` implements the boxes and the cue thresholds that score 12/12 and recall 1.00. `spokenLine` also uses that reader as an overlay: too noisy, fry-versus-drop, and any empty product line. The dark vowel is the clear case. `classifyUtterance` returns no flags and an empty line, because a single dark word has no brighter word to compare with. `describeTake` on the turn says `resonance-dark`, and that is the line the driver hears: “Move the tongue more forward, toward the front of the mouth.”

So the boxes are not the LibriSpeech profile, and they are on the spoken path whenever the product line is empty. The suite number is the box reader. Blocker 1 is what that split still gets wrong.

### (d) The dark line pairs the larynx sentence with “tongue forward”

Acceptable. The first variant is one sentence: “Lift your larynx a little, like a whispered hee, then say the word with your tongue forward.” It names two articulator moves, and both belong to a dark vowel. It passes the copy lint (one sentence, 92 characters, no slogan). The second variant is only the tongue: “Bring the tongue forward, toward the front of the mouth, then say the word again.”

### (e) Drive check-ins still require a 1–5 comfort rating

Not a bug. The manual check-in in `app.js` `saveDriveCheckin` still requires minutes, a comfort integer from 1 to 5, and whether the cue held. That matches the existing drive log and `shouldPauseForComfort`. The coach log no longer invents a 3: `logEntry` stores `comfort: null` when `comfortKnown` is false, and `validateDriveLog` allows that for `kind === 'coach'`. The spoken check (“Say a number from one to five.”) is the pause-for-pain path.

### (f) AudioWorklet with a ScriptProcessor fallback

Not a bug. `attachCapture` loads `drive-capture-worklet.js`, and the processor posts `channel.slice(0)`. On failure it uses a 2048-sample `ScriptProcessor`, and `pushCaptured` copies the channel before resampling. `scripts/build.mjs` copies the worklet into the build output. A 404 on the module falls back to the processor, which is the intended path.

## Copy and the car screen

Fixed since `eccc984`: “That one held. Keep going.” is no longer spoken for a clean phrase. The praise lines (“Nice lift”, “Good, '{word}' held.”) are gone. The sleeping-baby line and the small-dog pant are gone. The note under the start button is 15px. The overlay takes focus when it opens. The stay-awake video is `aria-hidden`.

Still on the overlay, under every cue: “Switching apps pauses the coach until you come back.” Useful once, redundant with the note on the drive card. Low.

“Thank you. Keep it easy.” is a fine comfort reply. The improved lines (“better than last time”, “improved”, “held this time”) report a change and are specific.

The overlay itself is still the right shape for a mount: full screen, `#f6f1e8` on `#14120f`, the cue in `clamp(40px, 8vw, 84px)`, start control 64px tall.

## Also found

- Severity medium. If a visible wake lock is released and the new `request('screen')` rejects, `drive-wake.js` sets mode `off` and does not start the fallback video. The video was paused when the first lock was acquired. Repro: first request resolves, second throws, fire `release` while visible. Result: two requests, mode `off`, the video was played once and then paused. The screen can sleep for the rest of the drive.
- Severity low. `devicechange` and `online` listeners added in `mountDriveCoach` are not removed on stop. One of each. They do not grow during a drive.
- Severity low. The guide sentence stays on the coaching screen, as above.

## Known limits

The 81% LibriSpeech figure was not recomputed. Gender is still stored and not spoken. WebKit in this image cannot start an audio device and cannot decode the h264 stay-awake clip, so the fallback video was checked in Node. Worker tests that need `miniflare` were not run; the comfort-null branch in `validateDriveLog` was read directly.
