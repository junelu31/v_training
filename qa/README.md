# Drive coach QA

Independent checks for Lilt’s hands-free Drive coach. The suite generates its own speech and road noise. It does not contain anyone’s voice, and it does not import an implementation until you point it at one.

Phase 1 runs the corpus checks and a reference double that proves the assertions can pass and fail. Point the same tests at the coach when it lands. The double in `doubles.mjs` is a test oracle, not the product, and the app must not import it.

## Run

```bash
npm run qa
```

That is `node --test qa/*.test.mjs`. It skips anything that needs the coach module.

When the coach is on disk:

```bash
QA_COACH_MODULE=./drive-coach.js npm run qa
```

The module must export `createDriveSession` (or `createDriveCoach`, or a function as the default export). A 40-minute soak is included in that run. Shorten it with `QA_SOAK_MINUTES=2`. Heap numbers are tighter if you also pass Node’s garbage-collector hook:

```bash
QA_COACH_MODULE=./drive-coach.js node --expose-gc --test qa/coach.test.mjs
```

Optional local road clips, including the attached takes, stay outside git:

```bash
QA_COACH_MODULE=./drive-coach.js QA_REFERENCE_DIR=/path/to/clips npm run qa
```

The folder may contain `snr20`, `snr10`, `snr5`, and `road only` / `noise only` files. Those clips are a smoke test: noise alone must not produce a coaching line. They are not a labeled profile of the speaker. Do not commit them. `qa/local/` is gitignored.

## What the tests cover

- Road noise alone at quiet, ordinary, and very loud levels, plus the same clean vowel mixed at 20, 10, 5, and −15 dB SNR. Ordinary road noise must not coach and must not say “too noisy.” Very loud noise must say “Too noisy to coach.” and must not give an articulatory fix. At 20 and 10 dB the clean vowel stays feminine.
- Twelve synthesized vowels labeled feminine, masculine, or androgynous, including a high pitch with a dark F2 and a low pitch with a forward F2. The report is a confusion matrix. Pitch alone fails those two traps.
- Five injected defects and a clean control: low pitch, a pitch drop at the end of the word, vocal fry, dark resonance (low F2), and breathiness. Precision and recall have to be at least 0.80, and the spoken line has to name that defect rather than a different one.
- A simulated session that streams frames for the requested number of minutes (40 when the coach is attached). It checks heap growth, retained samples, buffer bytes, and that `dispose` closes the `AudioContext`, stops the mic, releases the wake lock, and drops the visibility listener.
- Screen wake lock: re-request after a hide/show, one hidden muted looping video when the API is missing or rejects, release on stop, no extra listeners or videos across 40 tab switches, mic and `AudioContext` pause while hidden and recover when shown, and a `needs-gesture` state if `resume()` rejects until the next tap.

`harness.test.mjs` checks the corpus itself: formant and pitch regions, SNR, and that no audio file under `qa/` is tracked.

## Contract

`createDriveSession(options)` returns a session. The tests pass these options and also install the same objects on `globalThis` for code that reads the globals:

| Option | Role |
| --- | --- |
| `sampleRate` | Hertz. The corpus uses 16000. |
| `goal` | Preset key. Tests use `balanced`. |
| `document`, `navigator`, `window` | Page surface, including `document.visibilityState` and `navigator.wakeLock`. |
| `audioContext` | Context the session owns for this drive. |
| `mediaStream` | Mic stream the session owns. |
| `speak(text)` | Spoken coaching line. If this is omitted, `speechSynthesis.speak` is collected instead. |

The array passed to `push` may be reused by the caller after `push` returns. Copy anything you need to keep.

```js
session.push(float32Frame, { sampleRate, time })
session.snapshot()
session.resources()
session.dispose()
```

`start()` is optional and is awaited when present.

`snapshot()` returns:

- `state`: `idle`, `listening`, `paused`, `needs-gesture`, `too-noisy`, or `coaching`
- `profile`: `masculine`, `feminine`, `androgynous`, or `null` when there is no reliable voice
- `cues`: `{ id, text }[]` for the current fix. `text` is what would be spoken.

`resources()` returns `retainedSamples`, `bufferBytes`, `audioContexts`, and `mediaStreams`. Retained audio must stay within 15 seconds. Heap growth across the soak must stay within 32 MB after the samples are still reachable.

`dispose()` releases the screen wake lock, pauses and removes a fallback video, removes the `visibilitychange` listener, closes the `AudioContext`, and stops the mic tracks.

### Profile regions

These are practice categories from pitch and resonance together, not a judgment about the person.

- Feminine: F0 at least 170 Hz and F2 at least 1650 Hz.
- Masculine: F0 at most 140 Hz and F2 at most 1250 Hz.
- Androgynous: everything else, including a high pitch with a dark F2 and a low pitch with a forward F2.

### Spoken cues

The line has to be short, calm, and specific: at most two sentences, no exclamation, no praise. Matching is on the wording, so an id alone is not enough.

| Id | The line has to say |
| --- | --- |
| `pitch-low` | pitch, and bringing it up. Not the end of the word. |
| `pitch-drop-end` | the end of the word, or a drop into chest. |
| `vocal-fry` | fry or creak. |
| `resonance-dark` | tongue forward, or the hard palate / front of the mouth. |
| `breathiness` | less air, or a clearer connected tone. |
| `too-noisy` | “too noisy”, or that the coach cannot hear. This is a state, not a technique fix. |

Examples that pass: “Bring the pitch up a little.” “Lift the end of the word. You dropped into chest.” “Move the tongue more forward.” “Too noisy to coach.”

### Wake lock

On start, while the page is visible, request `navigator.wakeLock.request('screen')`.

When the document becomes hidden, the browser drops the lock. Suspend the `AudioContext` (do not leave it running) and set `state` to `paused`. When it becomes visible again, request a new screen lock and `resume()` the context. If `resume()` rejects, set `state` to `needs-gesture` and resume on the next `pointerdown` or `click`. Do not add another `visibilitychange` listener each time.

If `navigator.wakeLock` is missing, or `request` rejects, start one hidden, muted, looping, inline `<video>`, call `play()`, and do not spin on the rejection.

`dispose()` releases the lock and stops the video. A later visibility change must not acquire either one again. Across a long drive, keep at most one active lock, one fallback video, and one visibility listener.

## Reports

- [FINDINGS.md](FINDINGS.md) is the phase-1 copy and UI review of the app that is in the tree now.
- [DEPENDENCIES.md](DEPENDENCIES.md) is what a Drive coach will be tempted to reuse, and the wake-lock review checks.
