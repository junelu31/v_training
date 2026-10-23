# iPhone Safari Drive — what the harness covers

June’s Drive session is about 40 minutes. The week-1 list is 53 lines. `npm run test:ios-drive` walks that list on a fake iPhone Safari. It does not use her phone, and it does not deploy.

The suite fails when the coach can say the opening line and then stay silent after she repeats it. Pushing samples in with `__liltDriveCoach.feed()` is a failure of the suite: that path skips the microphone, which is how the live bug survived PR #8.

## Simulated

| What bit her | What the harness does |
| --- | --- |
| Mic permission sheet at Start | The context goes `interrupted` until Allow. The coach stays unpaused. The opening line does not count as finished during the sheet. The session type is `play-and-record` before `getUserMedia`. Allow does not prompt a second time. |
| Opening line, she repeats, silence | Her audio is delivered only through the mic graph. The stream is stereo. Channel 0 is silence. Channel 1 is the phrase. A fake AudioWorklet receives that empty channel 0 and posts silence. A ScriptProcessor callback does not run unless its output node is the context destination, and it does not run if the mic source was forced to explicit mono. A spoken reply has to start on the destination and stay up for most of the decoded clip. `feed()` throws if anything calls it. |
| ~40 minutes / 53 lines | Every week-1 line is a coach → listen → spoken reply → next cycle. A line the model coaches is answered out loud, then “next phrase” moves on. After the list, `speaking` is false, the coach is not paused, one capture node is live, and the phrase count matches the list. |
| Route flicker | For 40ms the context is `interrupted` during a reply. The reply is not stopped. The coach does not pause. |
| Held interruption | After the mic-open settle window, a drop longer than the playback cut pauses the coach. `running` resumes it, and later lines still get a spoken reply. |
| `onended` never fires, clock stuck | Buffer sources do not fire `onended`. `currentTime` does not advance. The reply still has to finish, and `speaking` has to clear, or the next phrase is thrown away. |
| Keep-alive mic graph | The script processor’s output is prefilled as if the mic were connected to the speaker. The callback has to silence it. A peak at or above 0.01 fails. |
| “next phrase” | One cloud transcript is `next phrase`. Phrase feedback is skipped. The short reply plays. The line index moves. |
| Mic denial, then Allow | `NotAllowedError` pauses the coach, shows the blocked-mic line, and speaks it. The resume tap allows the mic. The next repeat gets a spoken reply. |
| Mic track ends | The live track fires `ended`. The coach opens the mic again without a second permission sheet and still answers the next repeat. |
| Page hidden / visible | Hiding suspends the context, releases the mic, and pauses the coach. Showing reopens the mic and the next repeat is answered. The wake lock reports “Screen stays on.” |

## Still needs her phone

These are not in the harness. A green run does not clear them.

| Risk | Why it is not simulated |
| --- | --- |
| Real permission sheet and the gesture after Allow | The harness resolves a promise. It does not show iOS’s sheet, and it does not spend the user-activation token. |
| Speaker versus receiver loudness | `play-and-record` is selected. The harness cannot hear whether that route ducks the coach into the earpiece. |
| Ring/Silent switch | No hardware mute switch. A clip can be “playing” in the graph and still be inaudible on the phone. |
| Screen lock that freezes the tab | Visibility is flipped in process. A real lock can suspend timers, kill the audio session, or ignore the wake lock when Lilt is not on the Home Screen. Auto-Lock and Low Power Mode are in this bucket. |
| The stay-awake video after the gesture expires | The fake video’s `play()` always resolves. |
| Phone call, Siri, Bluetooth, CarPlay | No call UI, no HFP route, no CarPlay audio session. A Bluetooth hop can look nothing like `AudioContext` `interrupted`. |
| AirPods or a car mic with a different channel map | The harness uses the map that already failed: stereo, voice on channel 1, channel 0 empty. Another layout needs a new capture. |
| Platform stops the buffer, then fires `onended` only after the context is already `running` | The harness never fires `onended` on its own. That race can count a cut-off blip as a finished line. It is not the bug PR #10 is fixing. If a drive is still silent with the mic graph healthy, this is the next place to look. |
| Real clip bytes and the speaker | `decodeAudioData` returns a fixed short buffer. The test checks that the coach kept a destination source alive for that duration. It does not decode the mp3 and it does not play air. |
| Workers AI, offline saves, a real 40 minutes of road noise | Transcripts are stubbed. Memory over 40 minutes of audio is `tests/coach-soak.test.mjs`, not this file. |

## Voices

The long-term voice is `COACH_VOICE` (`af_river`) and `voice` in `public/voice/voice.json`. They must match.

`PRACTICE_VOICE` is the temporary easier voice. When that export exists it is `af_bella`, stored under `lilt-coach-voice`. The suite then runs one iPhone repeat on Bella (clips from `voice/af_bella/`) and one “main voice” command that comes back to River. Until the export exists, the suite stays on River and does not invent a second voice.

## Review notes

- Do not deploy from this branch. `npm run deploy` publishes the Worker.
- Do not treat a green `npm test` from before this file as evidence the phone will speak. PR #8’s harness injected audio with `feed()`.
- This suite is red on main until the iPhone mic graph delivers her take. That fix is PR #10. The Bella practice voice is PR #12 (`PRACTICE_VOICE = af_bella`). A throwaway merge of those two, with the import conflict in `drive-ui.js` resolved by keeping both the iPhone capture imports and the Bella clip imports, ran this file green (7 tests, including the 53-line drive and a Bella-then-River switch). PR #12 alone does not include the mic-graph fix, so this file stays red there.
- If the fix hears her through some other node, update the fake in the same change. A worklet-only fix will stay red here, because the fake worklet models Safari’s silent channel 0.
- The 53-line run is compressed wall time. It is not a 40-minute soak and it is not a substitute for tomorrow’s phone pass.
- Residual phone risks are the table above. The first things to listen for on the phone: the reply after the first repeat, a route change mid-phrase, and the coach still answering past the 20-minute mark with the screen locked once.
