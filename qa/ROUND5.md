# Round 5 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `bfc3b32` on 22 Oct 2026. The builder’s files were not edited. The suite was pointed at `drive-ui.js`.

## Verdict

Two blockers remain.

Fry under road noise is no longer called breath, and the new fry sentence tells the driver what to do. A breathy phrase is coached only while the buffer is still voiced at the end. The pause that closes a live turn removes that cue. The new low-pitch line asks for a hum that is not tied to the next word.

## What was re-run

`QA_COACH_MODULE=/tmp/drive-coach/drive-ui.js node --expose-gc --test qa/coach.test.mjs qa/octave.test.mjs qa/harness.test.mjs`

26 passed, 1 failed, 1 skipped (local road clips). Matrix 12/12. Cue precision and recall 1.00. Noise passed. Wake lock passed. The 40-minute soak passed its caps. The failure is “a fading breathy phrase is still coached, clean and at 20 dB.”

Their soak passed, 9 tests. Heap was 5,273,304 at the start, 6,041,160 at 20 minutes, and 6,108,176 at 40 minutes. Growth in the second half was 67,016 bytes. Wake locks issued 42. Fallback video plays 2.

## What the builder’s claims do

The quiet fry repro, and the same phrase at 18, 19, and 20 dB after 0.8 s of the same road noise, is spoken as “Keep breath flowing through the last word, and lift the pitch a little so the end does not creak.”

At 12 dB, with a road pause and on a flush, the session is silent. A flush of the 10 dB mix is silent. Neither says the breath line.

A steady low voice at 105 and 110 Hz is still silent. A creak under 8 frames is still silent. An 86 Hz rumble is still silence or “too noisy,” not fry.

The low-pitch clip is “Hum, and bring the pitch up a little.” The long fall is “Lift the end of the word with a small hum.”

A clean breathy vowel, and the same vowel with a 0.35 s fade at the end, is still “Use a little less air so the tone stays clear.” when the buffer ends on that fade.

## Blocking

### A breathy phrase goes quiet once the turn has a pause

- Severity: high
- Where: `drive-session.js` `describeTake`. Breath now requires `breathThrough`, and `maskedTail` is true when the last voiced frame is more than 0.34 s before the end of the buffer. A live turn closes after 560 ms of quiet, and that quiet is inside the buffer.
- Repro, pause: 1.25 s at 195 Hz, breath 0.28, F2 2050 Hz, seed 55, then a 0.3 s fade and 0.56 s of silence. `describeTake` and the session are silent. The same vowel with only the fade, and no extra silence, is the breath line. On the paused buffer the older breath conditions still hold: steady pitch near 193 Hz, 31 voiced frames, voiced fraction 0.39, confidence 0.51, F2 2063 Hz. The new gate is what goes quiet. The same thing happens to a 24 dB or 25 dB mix of that vowel once 0.56 s of silence is added. Those mixes are coached when the buffer ends on the vowel.
- Repro, 20 dB: the same vowel, and the 0.35 s fade, mixed at 20 dB with moderate road noise, seed 90. The session is silent. This mix has 16 voiced frames and a voiced fraction of 0.27, so the older voiced-count gate is silent here too. The fade does not restore it. A session coaches this vowel again at 24 dB, until a pause is added.
- `qa/octave.test.mjs` fails on “a fading breathy phrase is still coached, clean and at 20 dB” with silence for the pause, the 20 dB fade, and the 20 dB steady vowel. The clean fade with no extra pause passes inside that test.
- Fix: judge breath on the voiced body of the phrase. A fade, or the quiet that ends the turn, should stay inside the breath cue when the voiced portion was breathy. Keep the masked-fry case silent: a fry tail that noise has already erased should not become a breath cue.

### “Hum, and bring the pitch up a little.” does not say what to hum

- Severity: high
- Where: `drive-session.js` `LINES['pitch-low']`. This is the line a low, forward vowel speaks. The passing check is “pitch, drop, and fry are spoken as a physical action.”
- Current: “Hum, and bring the pitch up a little.”
- A hum is a physical action, and the sentence is short and calm. Said after a phrase, while driving, it asks for a hum on its own and then a pitch change. It does not say to hum the next word. The driver has to invent where the hum goes.
- Proposed: “Hum the next word, and bring the pitch up a little.”
- The drop line, “Lift the end of the word with a small hum,” keeps the hum on the end of the word. That one can be done on the next phrase.

## Cue audit

Spoken by `readTurn`:

| Line | Action | While driving |
| --- | --- | --- |
| “Hum, and bring the pitch up a little.” | Hum, then raise pitch. | The hum is not tied to a word. See the blocker. |
| “Lift the end of the word with a small hum.” | Lift the end, on a small hum. | Fits the next phrase. |
| “Keep breath flowing through the last word, and lift the pitch a little so the end does not creak.” | Keep breath moving, and lift the pitch. | One sentence. It names the last word. |
| “Move the tongue more forward, toward the front of the mouth.” | Move the tongue forward. | Fits the next word. |
| “Use a little less air so the tone stays clear.” | Use less air. | Fits the next word. |
| “This one is too noisy to coach.” | Status. | It is not a technique cue. |

Spoken only when `readTurn` is empty and the segmenter is already confident of fry or drop. Each fry and drop variant still has a breath, an airflow, or a lift. The heavy lines are not on this path. They now read “Start from a light sigh, then say the word with less buzz in your chest” and “Start from a gentle hm at the front of the face, only as loud as someone close by.” Both name a sigh or a hum, and the loudness line fits a car. The third heavy line still starts with a sigh.

Chest, dark, low, breath, and strain variants still name tongue, larynx, pitch, breath, or a hum. The noisy and held lines are status.

## Also checked

The sign-in sentence is unchanged: “Practice recordings stay in this browser. Drive coach sends each phrase to Cloudflare.”
