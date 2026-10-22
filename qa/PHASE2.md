# Phase 2 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `eccc984` on 22 Oct 2026. Fetched again before this verdict. No newer commit was on the branch. The builder’s files were not edited.

The QA suite called `createTurnDetector`, `classifyUtterance`, and `createStayAwake` the way `drive-ui.js` does. `npm run qa` in the QA branch, with that harness and `node --expose-gc`, ran the profile, cue, noise, wake-lock, and 40-minute soak checks. Their own `tests/drive-coach.test.mjs` passed (7). Their `tests/coach-soak.test.mjs` passed. Worker tests were not executed here because `miniflare` is not installed in this environment. Headless WebKit (Playwright) loaded the coach, clicked Start, hid and showed the page, and pushed 40 minutes of audio.

## Verdict

Blocking issues are listed below. This is not a clean bill of health.

## Confusion matrix

Rows are the labeled synthetic vowel. Columns are the coach’s label.

| Labeled | Masculine | Feminine | Androgynous | Abstained |
| --- | ---: | ---: | ---: | ---: |
| Masculine | 3 | 0 | 0 | 1 |
| Feminine | 0 | 4 | 0 | 0 |
| Androgynous | 1 | 1 | 2 | 0 |

The high-pitch dark vowel was masculine. Pitch alone would call it feminine. The low-pitch forward vowel was feminine. Pitch alone would call it masculine. The two mid vowels were androgynous. The suite’s only profile failure is `masc-2`: a 95 Hz vowel. `estimatePitch` returned 94.96 Hz at confidence 0.94, and `MIN_HZ` in `drive-dsp.js` is 95, so the frame is unvoiced and no turn opens.

When F2 is missing, the label follows pitch. The 240 Hz vowel (`fem-4`) and the 105 Hz vowel (`masc-4`) had no F2 and still landed in the right column. The published LibriSpeech gap is unchanged: this commit does not include a retune, and that eval was not re-run.

## Cues

Isolated defects, recall 0.00. The “held” line does not match a defect pattern, so precision is an empty 1.00 rather than evidence the cues are right.

| Clip | Heard |
| --- | --- |
| Low pitch, forward F2 | That one held. Keep going. |
| Pitch fall from 205 Hz to 96 Hz | That one held. Keep going. |
| Fry at 92 Hz | Silence |
| Dark vowel, F2 980 Hz | That one held. Keep going. |
| Breathy vowel | Silence |
| Clean vowel | That one held. Keep going. |

On the dark vowel, F1 was about 844 Hz on every voiced frame and F2 was missing on all of them. `formantPeaks` keeps a second peak only when it is at least 280 Hz above F1, so a second resonance near 980 Hz is dropped.

In a two-word phrase, the pitch fall was spoken as “ah fell into fry and dropped. Take a breath before the last words, and keep air flowing all the way to the end.” The breathy vowel got that same fry line.

## Road noise

Quiet and moderate noise stayed silent. A clean vowel at 20 dB stayed feminine and got no defect cue. At 5 dB the synthetic vowel did not open a turn and was not labeled masculine. Loud noise, and speech mixed at −15 dB, stayed silent instead of saying the road was too noisy. The 10 dB mix did not open a turn.

The local road-only clip produced 0 turns. The local 5 dB clip said “This one is too noisy to coach” and named no technique. Those clips were not used as a profile of the speaker.

## Wake lock, pause, and the 40-minute soak

Hide and show, the missing API, a rejected request, release on stop, 40 tab switches, mic recovery, and a rejected `resume()` all passed, except one finding: `mountDriveCoach` adds a `visibilitychange` listener and never removes it. After stop the listener returns immediately. One listener does not grow across the 40 switches.

Their soak, with `--expose-gc`: heap 5,134,080 at the start, 5,957,944 at 20 minutes, 6,283,520 at 40 minutes. Growth in the second 20 minutes was 325,576 bytes. The QA noise soak grew 72,384 bytes, retained 0 samples, and kept one lock and one video.

Headless WebKit: Start acquired a screen wake lock and showed “Screen stays on.” The audio context stayed suspended, `getUserMedia` was never called, and the headline was “The microphone is needed.” Hiding the page showed “The coach is paused.” Showing it showed “Tap to continue” and left the context suspended. Pushing 40 minutes of audio took 0.9 seconds and left one video element. WebKit does not expose heap size. Any h264 file, including a baseline file generated here, crashed this headless WebKit on load, so `stay-awake.mp4` was not played in the browser. The Node checks did exercise the fallback video element.

## Blocking

### 1. The start tap loses the microphone

- Severity: high
- Where: `drive-ui.js` `clicked` (about line 380) and `begin` (line 420)
- Repro: headless WebKit, click Start. The overlay says “The microphone is needed.” The audio context stays suspended. The stubbed `getUserMedia` is never called. `begin` awaits the wake-lock promise before `listen()`, so the mic request is no longer in the gesture turn. An `AbortError` from `video.play()` is also left unhandled when the lock succeeds (`drive-wake.js` `arm`).
- Fix: call `getUserMedia` and `audioContext.resume()` in the click handler before any await. Catch the video `play()` promise when the lock is granted.

### 2. The live mic filters the voice before it is measured

- Severity: high
- Where: `drive-ui.js` line 309
- Repro: the practice recorder sets echo cancellation, noise suppression, and auto gain to false. The coach sets all three to true. Road noise and formants are changed before `createTurnDetector` sees them. The PCM suite cannot see this.
- Fix: use the same constraints as practice. The detector already ignores audio while the coach is speaking.

### 3. Defects are missed, or answered with “that one held,” or called fry

- Severity: high
- Where: `drive-dsp.js` `MIN_HZ` and `formantPeaks` (about lines 6 and 263–275); `drive-coach.js` `measureWords` (the drop requires a later word, about line 178); `drive-cues.js` held and fry lines; `composeFeedback`
- Repro: the cue table above. A within-word fall stays one word, its low tail falls through the 95 Hz floor, and the median stays near 202 Hz. Fry at 92 Hz never voices. A two-word fall is labeled fry because fry outranks drop.
- Fix: lower the pitch floor to about 70 Hz. Keep a second formant even when it sits close to a high F1. Compare the start of a word with its end. Add a low-pitch line and a breathy line. Speak “held” only when a voiced phrase had no flagged word. Do not call a smooth fall fry.

### 4. Loud noise does not say it is too noisy

- Severity: high
- Where: `drive-dsp.js` `finish` (about line 481). A turn is required before `tooNoisy` can be spoken, and noise alone never opens a turn. Their unit test locks that in.
- Repro: loud noise and speech at −15 dB stay in `listening` with no line. The 10 dB vowel never opens a turn.
- Fix: if the level stays high and almost no frames are voiced, say “This one is too noisy to coach.” Do not wait for a turn that noise will not open. Keep ordinary noise silent.

### 5. The cue waits on an upload the privacy copy denies

- Severity: high
- Where: `drive-ui.js` `onTurn` (about line 259); `index.html` Settings (about line 298) and the privacy modal (about lines 312–313); `worker/index.js` `driveTurn`
- Repro: the local cue is computed, then the coach awaits `POST /api/drive/turn` (nova-3, clef, and aura) before speaking. There is no timeout. A second phrase can enter `onTurn` during that wait. Settings still say a recording is uploaded only when someone asks for Workers AI.
- Fix: speak the on-device line immediately. Let the cloud call update the log. Put a timeout on the fetch. Say in Settings and the modal that Drive coach sends each phrase for a transcript and a second listen.

### 6. A dropped wake lock is not requested again while the page stays visible

- Severity: high
- Where: `drive-wake.js` lines 25–28
- Repro: the `release` handler sets `sentinel` to null and does not request again. `onVisible` runs only on a visibility change. The label can stay “Screen stays on.” after the browser has dropped the lock.
- Fix: if the session is active and `visibilityState` is `visible`, request `screen` again from that handler.

## Also found

- Severity medium. `drive-cues.js` praise: “Nice lift on '{word}'.” and “Good, '{word}' held.” Speak a change in the measurement, or say nothing.
- Severity medium. The heavy line (“like talking to a sleeping baby”) and the dark line (“small-dog pant”) are doing too much. “Use a lighter voice, with less buzz in your chest.” “Lift your larynx a little, like a whispered hee, then say the word.”
- Severity medium. `ScriptProcessor` in `listen` is the capture path for a 40-minute iPhone session. An AudioWorklet keeps the same copy-out of each buffer.
- Severity medium. `drive:${user.id}` allows 160 cloud calls per 15 minutes. A chatty drive falls back to the device only after a 429, and only if the fetch returns. Speaking locally first avoids the stall.
- Severity low. The visibility listener in `mountDriveCoach` (about line 391) is never removed. It does not acquire the lock after stop.
- Severity low. `logEntry` stores comfort 3 before anyone answers. History already says “comfort not rated” when `comfortKnown` is false.
- Severity low. The coach overlay is the right shape for a mount: large type, dark ground, a 64px start control and a 72px resume control. The note under the button is 13px. The overlay does not take focus. The video is not `aria-hidden`. “Switching apps pauses the coach until you come back.” stays on screen under every cue.

## Known limits that were not treated as new bugs

The gender read is stored and not spoken. Live nova-3 / aura latency was not timed; the wait itself is bug 5. The LibriSpeech acoustic-only number was not re-run. Node and WebKit both ran a 40-minute feed; WebKit could not report heap, and it could not decode the stay-awake video in this image.
