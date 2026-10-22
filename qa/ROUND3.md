# Round 3 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `f2bbff6` on 22 Oct 2026. The builder’s files were not edited. The suite was pointed at `drive-ui.js`. Adversarial clips are in `qa/octave.test.mjs`.

## Verdict

One blocking issue remains. Phrase-final fry is silent.

The spoken line and the suite now share one reader. `drive-ui.js` re-exports `createDriveSession`, and that function is the same object as `drive-session.js`. Both speak `readTurn` on the trimmed turn. `reviewLiveTurn`, which the soak calls, stores that same text.

## What was re-run

`QA_COACH_MODULE=/tmp/drive-coach/drive-ui.js node --expose-gc --test qa/coach.test.mjs` passed. Matrix 12/12. Cue precision and recall 1.00, including the whole-vowel fry clip. Noise passed, including too-noisy on loud noise and at −15 dB. The wake-lock checks passed. The 40-minute soak passed.

Their soak, which now logs through `reviewLiveTurn`, passed. Heap was 5,271,224 at the start, 6,034,480 at 20 minutes, and 6,101,368 at 40 minutes. Growth in the second half was 66,888 bytes, about 65 KiB. Their wake test also passed: a visible re-request that rejects starts the fallback video.

`qa/octave.test.mjs` against the same module: five passed, one failed. The failure is the blocker below.

## Spoken path

`createDriveSession` pushes audio into `createTurnDetector` and scores `readTurn` when the turn closes. `drive-ui.js` `spokenLine` returns `readTurn(turn).text`. On the clips below, the session cue, `detectTurns` + `readTurn`, and `reviewLiveTurn`’s saved feedback were the same string.

`onTurn` still runs `classifyUtterance` for the log, then overwrites `feedback.text` with the `readTurn` line before it speaks. A cloud ear can change flags. It does not change the spoken sentence.

## Octave cases

| Clip | Fold | What was spoken |
| --- | --- | --- |
| Steady 100 Hz, F2 about 1080 Hz | 0 frames doubled | Nothing. Profile masculine. Median 100 Hz. |
| Fall from 205 Hz to 96 Hz across the second half | 0 frames doubled. Tail stays at 96 Hz. | “Lift the end of the word. You dropped into chest.” |
| 205 Hz, then 110 Hz for about 140 ms (5 voiced frames, under 8) | 0 frames doubled. Those frames stay at 110 Hz. | Nothing. The phrase median stays feminine. |
| 10 dB clean vowel | Half-locks at 101 Hz fold to 202–203 Hz | Nothing. Profile feminine. F0 203 Hz. |
| Breathy vowel, no noise | Half-locks at 96 Hz fold to 193 Hz | “Use a little less air so the tone stays clear.” F0 193 Hz. |
| Same breathy vowel at 25 dB SNR | — | The breath line. Not a drop, not fry. |
| Same breathy vowel at 12 dB SNR | No voiced frames, no turn | Silence. Not a drop, not fry. |
| 205 Hz for 0.95 s, then 0.42 s of fry at 92 Hz | Fry frames stay near 92 Hz. None of them are doubled. | Silence. |

A short genuine 110 Hz tail is left alone, and a voice that lives at 100 Hz is not doubled. The long fall to 96 Hz is still a drop. That part of the folder matches the claim.

## Blocking

### Phrase-final fry is not coached

- Severity: high
- Where: `drive-session.js` `describeTake`. Fry requires the whole-turn median under 112 Hz. A drop requires a tail standard deviation under 22 and tail confidence of at least 0.7. `drive-ui.js` speaks that result and discards the `classifyUtterance` sentence.
- Repro: concatenate 0.95 s at 205 Hz (F2 2050 Hz) with 0.42 s of the fry vowel the suite already uses (92 Hz, jitter 0.035, F2 1900 Hz). `QA_COACH_MODULE=./drive-ui.js node --test qa/octave.test.mjs` fails on “fry at the end of a phrase is coached as fry” with `heard (silence)`.
- What the audio does: 60 voiced frames. The last 40% has median 94 Hz, standard deviation 54.6, confidence 0.64. The last 12 frames sit between 89 and 94 Hz. Octave correction does not lift them. The whole-turn median is 203 Hz, so the fry rule does not fire, and the tail is too uneven for the drop rule.
- The log classifier on that same turn would have said “ah dropped. Lift the end of the word so the last sound does not fall.” The spoken path overwrites that with the empty `readTurn` line. The whole-vowel fry clip still passes, because its median really is under 112 Hz.
- Fix: when the last 8 or more voiced frames sit under about 112 Hz, say the fry line if that ending is irregular, and the drop line if it is steady and confident. Do not require the earlier part of the phrase to sit in the fry range.

## Privacy modal

Checked in headless WebKit with `/api/auth/me` and `/api/state` stubbed. Before the account response, the app shell is hidden and `privacyButton.onclick` is null. `init()` binds it, and `init()` runs from `enterApp` after sign-in.

After the stubbed account, the ? button opens the dialog. “Got it” and the close button both dismiss it, and a second click opens it again.

- Kicker: “SENT TO CLOUDFLARE”
- Title: “Drive coach sends each phrase to Cloudflare.”
- Body: “Acoustic scoring runs in this browser. Progress is saved to your account. Drive coach sends each phrase to Cloudflare for a transcript and a second listen, and does not keep that audio. When you choose Analyze words with Workers AI, that recording is sent to Cloudflare for transcription and timestamped segments. Browser speech recognition, when available, may also use your browser vendor’s service.”
- Button: “Got it”

The Settings lede says the same upload fact. The dialog is `role="dialog"` with `aria-labelledby="modalTitle"`.

The sign-in card still says “Your audio stays in this browser.” That sentence is about saved practice recordings, and it was the line the phase-1 review kept. It now disagrees with the modal. It is not the modal bug. Severity medium.

## Copy and the car screen

The cue variants pass the spoken lint: one physical sentence, no hype, no exclamation. The breath line the driver hears is “Use a little less air so the tone stays clear.” The drop line is “Lift the end of the word. You dropped into chest.”

The overlay guide “Switching apps pauses the coach until you come back.” is visible when the session opens and hidden after the first cue. In WebKit, Start showed the guide; a loud-noise turn then hid it and left the too-noisy line. The longer note stays on the drive card, which is the right place for it.

“You have been at this a while…” and the free-talk reply are three spoken sentences. They are calm and specific. They are not the coaching cue.

This headless WebKit still cannot start an audio device, so Start says “The microphone is needed.” `getUserMedia` is called from the click. That limit is the image, not a new regression.

## Also found

- Severity medium. The sign-in sentence above.
- A breathy vowel at a true 20 dB mix is called too noisy (tracker SNR −20). At 22 dB and above, the same vowel gets the breath line. At 12 dB it opens no turn. None of those say drop or fry.
