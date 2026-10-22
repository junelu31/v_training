# What the Drive coach will be tempted to reuse

Reviewed on `cursor/fix-review-bugs-460b`. This is the audio path, the memory ceiling, and the wake-lock checks the suite already runs. It does not change the app.

Live practice analysis is in the browser. The Worker transcribes a short saved take. A 40-minute drive should stay on the device.

## Pitch is measured. Resonance is not.

`estimatePitch` in `app.js` (around line 414) is a normalized autocorrelation. It searches 65–550 Hz, ignores frames under RMS 0.003, and requires confidence of at least 0.45. That is a usable pitch estimate for a quiet take.

`spectralBalance` in `voice-metrics.js` (lines 1–25) is a pitch-aware ratio of a high band to a low band, in dB. The comment on that function says it is not a formant and not a gender or resonance measurement. The presets in `app.js` (lines 8–12) store that dB band as `brightness`. They do not store F2.

A coach that profiles from pitch alone, or from that brightness number, will call a high pitch with a dark F2 feminine and a low pitch with a forward F2 masculine. The profile corpus includes both traps. The spoken fix for a dark vowel has to be an articulatory cue (tongue forward, hard palate, front of the mouth), which a band-ratio meter does not justify on its own.

Post-take copy in `buildAdjustments` (`app.js` around lines 638–652) and the word map (`app.js` around lines 607–633) already talk about resonance from this proxy. Those lines are for a saved phrase. They are the wrong source for a live drive cue.

## The practice recorder is not a 40-minute session

Module state in `app.js` (lines 24–25) keeps `mediaStream`, `audioContext`, `analyser`, `sourceNode`, `recorder`, `chunks`, and `samples` for one take.

`startRecording` (`app.js` 342–366):

- Calls `getUserMedia` with echo cancellation, noise suppression, and auto gain all off. That is the right constraint for measuring the voice, and it also means road noise arrives at full level. Noise has to be rejected in the coach, not by the browser.
- There is no in-flight guard. `toggleRecording` only stops when `recorder.state` is already `'recording'`. A second tap before `MediaRecorder` exists starts a second `getUserMedia`. The later assignment replaces `mediaStream` without stopping the earlier tracks.
- `MediaRecorder` emits a blob every 200 ms into `chunks` (`app.js` 356). `drawAndAnalyze` pushes every voiced frame into `samples` (`app.js` 410) and schedules itself again with `requestAnimationFrame`.

`stopRecording` (`app.js` 369–373) stops the tracks, closes the `AudioContext`, and cancels the animation frame. It does not disconnect `sourceNode`, and it does not clear `samples`, `chunks`, `sourceNode`, or `audioContext`. The error path inside `startRecording` (`app.js` 363–365) does null the stream and the context. A drive `dispose()` has to do the full cleanup: release the wake lock, remove the visibility listener, pause and remove a fallback video, close the context, and stop every mic track.

The soak cap is 15 seconds of retained samples, 32 MB of heap growth, and a closed context with no live tracks after `dispose`. Reusing `samples` and `chunks` for 40 minutes will fail that. Copy a short ring if you need history, and drop the frame the caller passed to `push` after you return. The caller reuses that array.

## Do not upload the drive

`/api/analyze` (`worker/index.js` around lines 221–234) sends the body to Workers AI Whisper. The body cap is 4 MB (`MAX_ANALYSIS_AUDIO`). The client refuses a take longer than two minutes before that call (`app.js` around line 570). The route is also rate-limited per user. A drive recording does not belong there.

`saveAudio` writes an optional practice blob to IndexedDB and is off unless the person turns it on (`app.js` `defaultState.saveAudio`, around line 18). The drive check-in (`saveDriveCheckin`, `app.js` 294–300) stores minutes, comfort, and whether the cue held. That is the shape to keep. Do not add audio to `driveLog`.

Local road clips used by this suite stay in `QA_REFERENCE_DIR` or `qa/local/`. `qa/local/` is gitignored. Do not commit recordings.

## Today’s Drive screen has no session

`selectDrive` (`client-logic.js` 120–129) picks the week’s script, or a maintenance script after the course is complete. `renderDrive` (`app.js` 278–292) prints that script, a 20/30/40 minute choice, and the check-in. There is no listening state, no too-noisy state, no `visibilitychange` handler, and no `navigator.wakeLock`.

## iPhone Safari

The Screen Wake Lock API releases itself when the document is hidden. A request made while hidden rejects. Re-request `screen` only after `visibilityState` is `visible` again.

On a phone, `request` often rejects: missing API, no user gesture, or Low Power Mode. The fallback is one hidden `<video>` that is `muted`, `loop`, and `playsInline`, with `play()` called while muted. A blank `about:blank` video can satisfy the unit test and still fail on a device. Phase 2 should confirm the element has a real, tiny, silent media resource.

iOS suspends an `AudioContext` in the background, and `resume()` often rejects until the next tap. While hidden, suspend the context and set `state` to `paused`. When shown, resume. If `resume()` rejects, set `state` to `needs-gesture` and resume on the next `pointerdown` or `click`. Leave at most one running context and one live mic track. Recreating the context on show is acceptable only when the previous context is closed and the previous tracks are stopped.

## Wake-lock review checks

`evaluateWakeLock` runs these against whatever `QA_COACH_MODULE` exports. The same checks pass on the reference double and fail on `createWakeLeakySession`. When the module is set, `coach.test.mjs` also greps the coach sources for `wakeLock`, `'screen'`, `visibilitychange`, `visibilityState`, `release(`, `muted`, `loop`, `playsInline`, `suspend(`, and `resume(`.

1. **Re-acquire after a tab switch.** After start, exactly one active sentinel, type `screen`. Hide the page: the browser releases that lock, no `AudioContext` is `running`, and `snapshot().state` is `paused` (or `needs-gesture` if resume is already blocked). Show the page: a new `request('screen')` runs, exactly one lock is active, and the listener count stays at one.
2. **API missing.** `navigator.wakeLock` is undefined. Exactly one fallback video: muted at `play()`, looping, `playsInline`, and hidden (`display: none`, `aria-hidden`, opacity 0, off-screen, or zero width). No sentinel. After `dispose`, that video is paused or removed.
3. **API rejects.** `request` throws. Same single video. `request` is not called in a spin (the mock allows at most four attempts).
4. **Release on stop.** After `dispose`, a later show acquires nothing: zero active locks, zero visibility listeners, and no playing video.
5. **No leak across a long drive.** Forty hide/show cycles leave at most one listener, one video in the document, and one active lock. `dispose` then leaves zero listeners and zero locks. The 40-minute soak (`QA_SOAK_MINUTES`, default 40) toggles visibility once a minute and applies the same `dispose` checks, plus the 15-second sample cap and the 32 MB heap cap. Run it with `node --expose-gc` when you want the heap number to mean something after collection.
6. **Mic and `AudioContext` recover.** After hide, zero contexts are `running`. After show, exactly one context is `running` and exactly one mic track is live. A later `push` still works, and the state is not stuck on `paused` or `needs-gesture`. If `resume()` rejects, the state is `needs-gesture` and the context stays suspended until a `click`, which then leaves it `running`.
