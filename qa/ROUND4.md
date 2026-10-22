# Round 4 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `dd71a8a` on 22 Oct 2026. The builder’s files were not edited. The suite was pointed at `drive-ui.js`. The new clips are in `qa/octave.test.mjs`.

## Verdict

Two blockers remain.

Phrase-final fry on a quiet clip is coached, and the sign-in card now says where the audio goes. Under moderate road noise the same fry is told to use less air. The sentence spoken for fry names the fry and does not say what to do with breath or pitch.

## What was re-run

`QA_COACH_MODULE=/tmp/drive-coach/drive-ui.js node --expose-gc --test qa/coach.test.mjs qa/octave.test.mjs qa/harness.test.mjs`

24 passed, 1 failed, 1 skipped (local road clips, no `QA_REFERENCE_DIR`). Matrix 12/12. Cue precision and recall 1.00, including the whole-vowel fry clip. Noise passed. Wake lock passed. The 40-minute soak passed its caps (retained audio, buffer, heap, dispose).

The one failure is the new case “phrase-final fry in 10 to 20 dB road noise is not called breath or a drop.”

Their soak passed, 9 tests. Heap was 5,272,888 at the start, 6,036,184 at 20 minutes, and 6,103,200 at 40 minutes. Growth in the second half was 67,016 bytes. Wake locks issued 42. Fallback video plays 2.

## What the builder’s claims do

Quiet phrase-final fry is scored on the tail. The repro is 0.95 s at 205 Hz (F2 2050 Hz, seed 84) plus 0.42 s of fry at 92 Hz (jitter 0.035, F2 1900 Hz, seed 83). The tail is 15 voiced frames, median 92 Hz, confidence 0.52, fry score 0.3. Confidence under 0.7 makes that ending irregular. The session, `detectTurns` plus `readTurn`, and `reviewLiveTurn` all say “Ease out of the fry and let the tone smooth out.”

A fry or drop the segmenter already marked is kept when `readTurn` is empty. A turn whose samples are silence, so `readTurn` is empty, and whose frames make `classifyUtterance` confident, is saved as the library line: “hello fell into fry. Take a breath before the last words, and keep air flowing so the end does not creak.” The drop case is saved as “morning dropped. Lift the end of the word so the last sound does not fall.”

The sign-in card in `index.html` reads: “Practice recordings stay in this browser. Drive coach sends each phrase to Cloudflare.”

## Adversarial clips

The phrase above, mixed with moderate road noise (seed 97). “Road pause” appends 0.8 s of that same noise after the phrase, which is how a turn closes in the car. “Flush” scores the mix with no following pause. The low-ending gate is 8 frames under 112 Hz.

| SNR | Road pause | Flush |
| --- | --- | --- |
| 20 dB | Fry line. 8 frames, median 94 Hz, confidence 0.50. | Silence. The captured turn has 7 low frames, one under the gate. |
| 18 dB | Fry line. 8 frames, median 94 Hz, confidence 0.47. | Silence. |
| 15 dB | Silence. 2 low frames. | Silence. |
| 12 dB | “Use a little less air so the tone stays clear.” No frame under 112 Hz. Whole-turn F0 203 Hz. Tracker SNR about 14. | The same breath line. |
| 10 dB | Silence. No frame under 112 Hz. Voiced fraction 0.31. | The breath line. |

A steady dark vowel at 100, 105, and 110 Hz (F2 1080–1120 Hz) stays masculine, median on the fundamental, fry score 0, and is silent. A steady 108 Hz vowel with F2 about 2000 Hz is “Bring the pitch up a little.” That is the low-pitch cue. It is not called fry.

A creak of 0.12 s after 1.05 s at 205 Hz leaves 2 frames under 112 Hz. Both the session and the segmenter stay silent.

An 86 Hz tone, frequency-modulated by 6 Hz, at RMS 0.05 produces no voiced frames and no line. At RMS 0.2 the only line is “This one is too noisy to coach.” Loud road noise alone says the same. Neither is fry.

## Blocking

### Phrase-final fry at 12 dB is coached as breathiness

- Severity: high
- Where: `drive-session.js` `describeTake`. Once the tail is no longer 8 frames under 112 Hz, the whole turn still looks like a steady vowel near 203 Hz with a voiced fraction under 0.75 and confidence under 0.75, and the breath rule wins.
- Repro: the quiet fry phrase above, mixed at 12 dB SNR with moderate road noise, seed 97. `QA_COACH_MODULE=./drive-ui.js node --test qa/octave.test.mjs` fails on “phrase-final fry in 10 to 20 dB road noise is not called breath or a drop” with:
  - `12 dB road pause heard Use a little less air so the tone stays clear.`
  - `12 dB flush heard Use a little less air so the tone stays clear.`
  - `10 dB flush heard Use a little less air so the tone stays clear.`
- A road-noise pause at 10 dB stays silent, and 15 dB stays silent. Those are missed tails, not a wrong instruction. 18 dB and 20 dB with a pause say the fry line. The wrong instruction is the breath line at 12 dB on both paths, and at 10 dB when the turn is flushed with no trailing noise.
- Fix: if the low tail has fallen apart, stay silent or say the clip is too noisy. Do not give a breath cue for a fry ending the tracker can no longer see.

### The spoken fry line has no physical action

- Severity: high
- Where: `drive-session.js` `LINES['vocal-fry']`. This is the sentence `readTurn` returns, so it is what the driver hears on the quiet repro and at 18–20 dB.
- Current: “Ease out of the fry and let the tone smooth out.”
- It names fry and asks the tone to smooth. It does not say what to do with breath, tongue, jaw, or pitch.
- Proposed: “Keep breath flowing through the last word, and lift the pitch a little so the end does not creak.”
- The library already has that kind of line (“Take a breath before the last words, and keep air flowing so the end does not creak.”). Those lines are spoken only when `readTurn` is empty. Whenever `readTurn` matches, the short sentence above replaces them.
- The suite’s vocal-fry matcher accepts any line that says “fry” or “creak,” so this sentence still scores as a hit. The matcher does not check for a physical action.

## Cue audit

June’s bar: every cue gives a concrete articulatory or breath action. Lines below are everything the drive coach can speak as a cue today, plus the library lines that describe a fix and are not on that path.

Spoken by `readTurn` (`drive-session.js` `LINES`):

| Line | Action |
| --- | --- |
| “Bring the pitch up a little.” | Raise pitch. |
| “Lift the end of the word. You dropped into chest.” | Lift the end of the word. |
| “Ease out of the fry and let the tone smooth out.” | None. See the blocker above. |
| “Move the tongue more forward, toward the front of the mouth.” | Move the tongue forward. |
| “Use a little less air so the tone stays clear.” | Use less air. |
| “This one is too noisy to coach.” | Status. It is not a technique cue. |

Spoken only when `readTurn` is empty and the segmenter is already confident of fry or drop (`drive-cues.js`, prefixed with the word and the problem):

| Line | Action |
| --- | --- |
| “Take a breath before the last words, and keep air flowing so the end does not creak.” | Take a breath and keep air flowing. |
| “Put a little airflow under the last word so it does not fall into fry.” | Put airflow under the last word. |
| “Breathe, then finish the word while the air is still moving.” | Breathe, and finish while the air is moving. |
| “Lift the end of the word so the last sound does not fall.” | Lift the end. |
| “Say that word once more, and keep the end of the word up.” | Keep the end up. |
| “Finish the end of the word while the sound is still moving up.” | Finish with the sound moving up. |

In the library, and not spoken on the current path (`spokenLine` keeps a segmenter sentence only for fry and drop; every other cue comes from `LINES`):

| Line | Action |
| --- | --- |
| “Use a lighter voice, with less buzz in your chest.” | None. “Lighter” and “less buzz” name the sound. Proposed: “Sigh the word out, with less buzz in your chest.” |
| “Use only enough voice for someone close by, and let the buzz get thinner.” | None. It names loudness. Proposed: “Sigh only enough air for someone close by, and let the buzz get thinner.” |
| “Sigh the word out lightly, then say it again the same easy way.” | Sigh the word out. |
| Chest, dark, low, breath, and strain variants | Each one has a tongue, larynx, pitch, breath, or hum action. |
| “This one is too noisy…” and the held lines | Status. They are not technique cues. |

The two heavy lines are not blockers while they stay off the spoken path. They should be rewritten before that path starts using them.

## Also checked

The privacy modal title is still “Drive coach sends each phrase to Cloudflare.” The sign-in paragraph above is the change in this commit, and it matches the modal.
