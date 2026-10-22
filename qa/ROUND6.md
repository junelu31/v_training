# Round 6 review of the Drive coach

Reviewed `cursor/drive-coach-0c04` at `c873b9e` on 22 Oct 2026. The builder’s files were not edited. The suite was pointed at `drive-ui.js`. The diff from `bfc3b32` is `drive-dsp.js` and `drive-session.js`.

## Verdict

One blocker remains.

The two Round 5 blockers are fixed. A breathy phrase is still coached after the pause that closes a turn, clean and at 20 dB. The low-pitch line is “Hum the next word, and bring the pitch up a little.” Noise alone produces no technique cue: quiet and moderate road, loud road, the 86 Hz rumble, turn-signal clicks, a short horn, road-seam thumps, music bleed, and the recorded road-only clip. Fry at 10 and 12 dB stays off the breath and drop lines. Fry at 18 and 20 dB after a road pause is the fry line. A clear vowel at 10 and 20 dB is not called breath. The profile matrix is 12/12. Cue precision and recall are 1.00. The 40-minute noise-heavy soak opens no turns.

The 60 ms turn gate, which is what lets the 20 dB breath mixes open, also opens a short tone on quiet road. That turn is spoken as “This one is too noisy to coach,” and repeating it fills the phrase log to the cap. The same clip is silent when the gate is 100 ms.

## What was re-run

`QA_COACH_MODULE=/tmp/drive-coach/drive-ui.js QA_REFERENCE_DIR=/home/ubuntu/.cursor/projects/workspace/uploads node --expose-gc --test qa/coach.test.mjs qa/octave.test.mjs qa/cabin.test.mjs qa/harness.test.mjs`

32 passed and 1 failed. The failure is “a short tone on quiet road does not pile up false turns.” Matrix 12/12. Cue precision and recall 1.00. Noise passed. Wake lock passed. The attached 40-minute soak passed its caps. Local road clips ran.

Their soak passed, 9 tests. Heap was 5,274,408 at the start, 6,043,048 at 20 minutes, and 6,110,744 at 40 minutes. Growth in the second half was 67,696 bytes. Turns 278. Wake locks issued 42. Fallback video plays 2.

The noise-heavy soak in `qa/cabin.test.mjs` pushed 40 minutes of moderate road, an 80 ms blip, and music. Turns 0. Phrases 0. Heap at 0, 20, and 40 minutes was 6,204,736, 6,213,368, and 6,211,800. Second-half growth was −1,568 bytes. Heard lines were empty.

## What the builder’s claims do

`TURN.minVoicedMs` is 60. The comment says a breathy vowel under moderate road noise stays voiced for about three hops. At 100 ms the 20 dB fade and the 20 dB steady vowel are silent. At 60 ms both are “Use a little less air so the tone stays clear.” The clean fade, and the clean fade plus 0.56 s of silence, are that breath line at either gate.

Phrase end is the last analysis frame whose rms is above the noise floor. Voiced fraction for the breath cue is counted from the first voiced frame to the last. The breath body also has to stay tonal (`bodyFlat` under 0.05). Trailing quiet no longer cancels the breath line.

The low-pitch clip speaks “Hum the next word, and bring the pitch up a little.” The drop line is still “Lift the end of the word with a small hum.” The fry line is still “Keep breath flowing through the last word, and lift the pitch a little so the end does not creak.”

## Blocking

### A short tone on quiet road fills the phrase log

- Severity: high
- Where: `drive-dsp.js` `TURN.minVoicedMs`, now 60, and `finish`, which marks `tooNoisy` when `voicedFraction` is under 0.12. `endSilenceMs` is still 560, so a short tone is stored with the quiet that follows it.
- Repro: 1.6 s of quiet road noise, seed 42, with a 120 ms 300 Hz tone at RMS 0.12 starting at 0.2 s. One turn closes on silence. Duration 0.76 s, tracker SNR about −3 dB, voiced fraction 0.114, `tooNoisy` true. The session says “This one is too noisy to coach.” Forty repeats of that clip open 40 turns and the in-memory phrase log stops at 24, every line that status sentence. With `minVoicedMs` set back to 100, the same forty clips open 0 turns.
- The same gate is what the 20 dB breath mixes need. Putting the minimum back to 100 ms makes “20 dB fade” and “20 dB steady” silent again. A 40 ms 300 Hz tone in digital silence is the other new open: one turn and the same status line at 60 ms, and no turn at 100 ms. From 60 ms upward, a tone in digital silence already opened at the old gate.
- Clicks, a 220 ms horn, road-seam thumps, and music, on quiet road and on moderate road, stay silent. An 80 to 160 ms tone on moderate road stays silent. Loud road and a loud 86 Hz rumble say only the status line, which is what the noise contract asks for. The recorded 12 s road-only clip is silent.
- `qa/cabin.test.mjs` fails on “a short tone on quiet road does not pile up false turns.” The log line is `{"lines":["This one is too noisy to coach."],"turns":40,"phrases":24,"heard":["This one is too noisy to coach."]}`.
- Fix: keep the 60 ms open so the 20 dB breath mixes still coach. Drop a closed turn whose voiced fraction is under 0.12 when the sound that opened it is only a short tone, and do not speak it or store it. The 0.76 s length here is the tone plus the 560 ms close. It is not a buried phrase.

## Cue audit

Spoken by `readTurn`:

| Line | Action | While driving |
| --- | --- | --- |
| “Hum the next word, and bring the pitch up a little.” | Hum the next word, and raise the pitch. | The hum is on the next word. |
| “Lift the end of the word with a small hum.” | Lift the end, on a small hum. | Fits the next phrase. |
| “Keep breath flowing through the last word, and lift the pitch a little so the end does not creak.” | Keep breath moving, and lift the pitch. | One sentence. It names the last word. |
| “Move the tongue more forward, toward the front of the mouth.” | Move the tongue forward. | Fits the next word. |
| “Use a little less air so the tone stays clear.” | Use less air. | Fits the next word. |
| “This one is too noisy to coach.” | Status. | The noise contract uses it for loud noise. On the short quiet-road tone it is a false turn. See the blocker. |

The heavy library lines are unchanged and are not on this spoken path.

## Also checked

The practice takes under `QA_REFERENCE_DIR` are a smoke test. They are not a labeled profile or a cue key. At this commit, the 11.5 s takes labeled snr20, snr10, and snr5 each spoke “Keep breath flowing through the last word, and lift the pitch a little so the end does not creak.” The snr5 take also spoke “This one is too noisy to coach.” The profile on all three was androgynous. The 12 s road-only clip spoke nothing. The suite still only requires a snapshot from the speech takes, and no technique cue from road-only.

The sign-in sentence is unchanged. This commit does not touch the page.
