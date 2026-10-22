# Round 7 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `65fc9c8` on 22 Oct 2026. The builder’s files were not edited. The suite was pointed at `drive-ui.js`. The diff from `c873b9e` is `drive-dsp.js`, `drive-coach.js`, and `drive-ui.js`.

## Verdict

No known bugs.

The quiet-road blip from round 6 now opens 0 turns. A turn still opens after 60 ms of voicing, and it is discarded when the longest voiced run is under 100 ms and the voiced stretch is under 200 ms. Short words still open. The 20 dB breathy vowel still gets the breath line. The profile matrix is 12/12. Cue precision and recall are 1.00. Noise, the wake lock, and both 40-minute soaks pass.

A 70 ms tone in digital silence still opens a turn and says “This one is too noisy to coach.” That sentence is the wrong description of silence. It is listed below as a limitation, not a blocker. The same tone on a road-noise floor is the blip that now stays closed, and the status is stored once for a run of these tones.

## What was re-run

`QA_COACH_MODULE=/tmp/drive-coach/drive-ui.js QA_REFERENCE_DIR=/home/ubuntu/.cursor/projects/workspace/uploads node --expose-gc --test qa/coach.test.mjs qa/octave.test.mjs qa/cabin.test.mjs qa/words.test.mjs qa/harness.test.mjs`

36 passed. Matrix 12/12. Cue precision and recall 1.00. Noise passed. Wake lock passed. Local road clips ran. The round 6 check “a short tone on quiet road does not pile up false turns” now passes: 0 turns, 0 phrases.

Their soak passed, 9 tests. Heap was 5,276,096 at the start, 6,011,456 at 20 minutes, and 6,077,840 at 40 minutes. Growth in the second half was 66,384 bytes. Turns 278. Wake locks issued 42. Fallback video plays 2.

The noise-heavy soak pushed 40 minutes of moderate road, an 80 ms blip, and music. Turns 0. Phrases 0. Heap at 0, 20, and 40 minutes was 6,209,928, 6,218,744, and 6,217,064. Second-half growth was −1,680 bytes.

## What the builder’s claims do

The 120 ms, 300 Hz tone at RMS 0.12 on quiet road (seed 42, starting at 0.2 s) opens 0 turns. The same is true of an 80 ms tone and a 200 ms tone on that bed, and of the 120 ms tone on moderate road.

A 70 ms, 300 Hz tone at RMS 0.1 in digital silence opens one turn. The longest voiced run is 120 ms and the voiced stretch is 120 ms, so the discard does not apply. The closed turn is 0.8 s, tracker SNR −20 dB, voiced fraction 0.162. The session says “This one is too noisy to coach.” Six repeats open 6 turns and store 1 phrase. Forty repeats in the cabin soak open 40 turns and store 1 phrase. At the previous commit those forty turns stored 24 phrases.

Sustained loud road says the status line once. A second loud stretch does not add a phrase. After 2 s of silence and an 0.8 s vowel, the phrase log moves, and the next loud stretch is logged again. The page path keeps a `statusHeld` flag so a repeated “too noisy” line is not shown or spoken until a later line does not contain those words. The phrase-log check above is the path the suite drives.

## Short speech

The discard does not drop these turns. Each one opens:

| Clip | Turns | Line |
| --- | --- | --- |
| “hi”, 0.22 s, clean, then 0.8 s of silence | 1 | “This one is too noisy to coach.” |
| “hi” at 20 dB on a matched moderate bed | 1 | “This one is too noisy to coach.” |
| “yes”, 0.30 s, clean and at 20 dB | 1 | the same status line |
| “please”, 0.38 s, clean and at 20 dB | 1 | the same status line |
| “okay”, 0.16 s plus a 50 ms gap plus 0.20 s, clean and at 20 dB | 1 | the same status line |

No technique cue on any of them. The same clips at `c873b9e` open and say the same status line, so this commit did not add that result.

The 20 dB breathy vowel (195 Hz, breath 0.28, 1.25 s, seed 55) has a longest voiced run of 60 ms and a voiced stretch of 280 ms. The discard keeps it. “a fading breathy phrase is still coached, clean and at 20 dB” passes, including the closing pause. A 1.2 s clear vowel on a matched 20 dB bed is tracker SNR about 18 dB and is not given the status line.

## The silence tone

A 70 ms tone in digital silence is a false status. The words say the take is too noisy, and the buffer is a beep plus zeros.

It is not a blocker. The analysis frame is 1024 samples, 64 ms, so the tone stays voiced for 120 ms after it has gone. The discard requires the longest run to be under 100 ms as well as the stretch under 200 ms, and 120 ms fails that test. The status then comes from the tracker: the 62nd percentile of the hop levels falls in the zero tail, and a zero level is defined as −20 dB, which is under the 5.15 dB coaching floor. Voiced fraction 0.162 is above the 0.12 cut, so the fraction is not what selects the line.

A cabin mic does not deliver digital silence. The driving repro, the same kind of tone on quiet road, now opens 0 turns. The false status is stored once and it is not a technique cue.

## Limitations

- A short tone in digital silence can still open a turn and be told “This one is too noisy to coach.”, once per run, until a phrase that is not that status. Repro: 70 ms at 300 Hz, RMS 0.1, starting at 0.2 s in 1.6 s of zeros. Voiced run 120 ms. Six turns, one stored phrase.
- A one-syllable word, and the short “okay”, is kept by the discard and then given that same status line, clean and at 20 dB on a matched bed. The closing floor is most of the buffer, so the 62nd percentile of the hop levels sits on the floor. Tracker SNR is about −20 dB on a zero tail and about −2 dB on the 20 dB bed. A vowel of about 1.2 s on that bed is not given the status line. This estimator is the same at `c873b9e`.

## Final numbers

- Confusion matrix: masculine 4/4, feminine 4/4, androgynous 4/4. No swaps, no abstentions.
- Cue precision 1.00, recall 1.00, for pitch-low, pitch-drop-end, vocal-fry, resonance-dark, and breathiness.
- Noise: quiet and moderate stay silent, loud says the status line, and the cabin set (clicks, horn, thumps, music, rumble, road-only) produces no technique cue.
- Builder heap across 40 minutes: 5,276,096 → 6,011,456 → 6,077,840. Second-half growth 66,384 bytes. Noise-heavy soak: 6,209,928 → 6,218,744 → 6,217,064. Second-half growth −1,680 bytes. 0 turns.
