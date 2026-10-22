# Round 8 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `2dceb05` on 22 Oct 2026. The builder’s files were not edited. The suite was pointed at `drive-ui.js`. The diff from `65fc9c8` is `drive-dsp.js`, `drive-session.js`, `drive-ui.js`, and `tests/short-speech.test.mjs`.

## Verdict

No known bugs.

SNR is the speech span against the floor measured before the turn. The status line on a turn requires that floor to be at least RMS 0.12 and the turn to have at least 200 ms of voicing. A turn under 200 ms of voicing, with nothing to say, is not stored. Short words, clean and at 20 dB, open and get no status line. A 70 ms tone in digital silence gets no status line and stores no phrase. The −15 dB mix still gets the status line. The profile matrix is 12/12. Cue precision and recall are 1.00. Noise, the wake lock, and both 40-minute soaks pass.

The 0.12 gate is an absolute level. The same loud road 12 dB quieter goes silent, and 6 dB louder still says the status line. None of those gains produced a technique cue. A relative criterion would make the status survive mic gain. It is a limitation, not a blocker, because the miss is silence.

## What was re-run

`QA_COACH_MODULE=/tmp/drive-coach/drive-ui.js QA_REFERENCE_DIR=/home/ubuntu/.cursor/projects/workspace/uploads node --expose-gc --test qa/coach.test.mjs qa/octave.test.mjs qa/cabin.test.mjs qa/words.test.mjs qa/harness.test.mjs`

39 passed. Matrix 12/12. Cue precision and recall 1.00. Noise passed. Wake lock passed. Local road clips ran.

Their soak, their drive-coach tests, and their short-speech tests passed, 12 tests. Heap was 5,276,480 at the start, 6,096,352 at 20 minutes, and 6,159,536 at 40 minutes. Growth in the second half was 63,184 bytes. Turns 278. Wake locks issued 42. Fallback video plays 2.

The noise-heavy soak pushed 40 minutes of moderate road, an 80 ms blip, and music. Turns 0. Phrases 0. Heap at 0, 20, and 40 minutes was 6,211,048, 6,219,888, and 6,218,136. Second-half growth was −1,752 bytes. Forty 70 ms tones in digital silence opened 40 turns and stored 0 phrases.

## The new rule

`finish` sets `snrDb` from the RMS of the voiced span over `rawAmbient`, the floor captured when the turn opened. `tooNoisy` on that turn is `rawAmbient >= 0.12 && hopVoicedMs >= 200`. A separate path, `noteLoud`, still says the status line when a hop stays at RMS 0.12 or more for 640 ms and stays mostly unvoiced. `reviewLiveTurn` drops a turn that has no line, is not that status, and has under 200 ms of voicing.

| Clip | Result |
| --- | --- |
| “hi”, “yes”, “please”, “okay”, clean | 1 turn, no status line, no technique cue |
| The same words at 20 dB | 1 turn, no status line, no technique cue |
| 70 ms, 300 Hz, RMS 0.1, six times in zeros | 6 turns, 0 phrases, no line |
| Loud road, RMS 0.30 | “This one is too noisy to coach.” |
| Same road, −12 dB, RMS 0.075 | Silence |
| Same road, +6 dB, RMS 0.60 | “This one is too noisy to coach.” |
| Loud road with a vowel, −12 dB and +6 dB | Silence at −12 dB, the status line at +6 dB |
| Clear vowel at 5 dB, floor RMS 0.04 | Silence |
| Clear vowel at 5 dB, floor RMS 0.08 | The status line, from `noteLoud` |
| Clear vowel at 10 dB, floor RMS 0.04 and 0.08 | A turn, no line |
| Corpus mix at −15 dB | The status line |

No technique cue on any of those rows. The −12 dB and +6 dB rows are the same recording with one gain change.

## Absolute level

RMS 0.12 does depend on mic gain. Processing is off, so an iPhone that sits 12 dB under this synthetic loud road (RMS 0.30 down to 0.075) never reaches the gate, and the same road 6 dB hotter still does. −6 dB, RMS 0.15, still says the status line, so the cliff is the 0.12 cut.

A relative criterion, speech against the pre-turn floor, or the status tied to the tracker SNR instead of an absolute RMS, would keep that line when the whole scene gets quieter. It is not needed to stop a wrong technique cue. At −12 dB, 0 dB, and +6 dB the loud road produced no pitch, fry, breath, drop, or resonance line. The safe failure is silence.

`noteLoud` can still speak the status when the floor itself is under 0.12. A vowel at 5 dB on a floor of RMS 0.08 pushed hop energy over 0.12, voicing stayed low, and the line was the status. That is the hop gate, not the new turn rule. It is still not a technique cue. At 10 dB on that floor the turn opens and says nothing.

## Final numbers

- Confusion matrix: masculine 4/4, feminine 4/4, androgynous 4/4. No swaps, no abstentions.
- Cue precision 1.00, recall 1.00, for pitch-low, pitch-drop-end, vocal-fry, resonance-dark, and breathiness.
- Noise: quiet and moderate stay silent, loud and the −15 dB mix say the status line, and the cabin set produces no technique cue.
- Builder heap across 40 minutes: 5,276,480 → 6,096,352 → 6,159,536. Second-half growth 63,184 bytes. Noise-heavy soak: 6,211,048 → 6,219,888 → 6,218,136. Second-half growth −1,752 bytes. 0 turns.

## Limitations

- The status line uses an absolute RMS of 0.12. The same loud road at −12 dB (RMS 0.075) is silent. At +6 dB (RMS 0.60) it still says “This one is too noisy to coach.” A relative or SNR criterion would follow mic gain. The miss is silence, and there is no technique cue.
- A 5 dB vowel on a floor of RMS 0.08 can still get the status line from `noteLoud`, because the mix hops cross 0.12. At 10 dB on that floor, and at 5 dB on a floor of 0.04, the coach says nothing.
