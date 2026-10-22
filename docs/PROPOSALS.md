# Proposals

Voice training items 1 and 2 are implemented. Everything else in this document is still a proposal. Items are ranked by impact versus effort for Lilt as it works in this repository: an eight-week course (`course.js`), browser scoring (`voice-metrics.js`, `app.js`), optional Workers AI word timing (`worker/index.js`), and account progress in D1.

Impact means how much the change would help someone practice or use the app. Effort means how much of the current code and content would have to change. “Low” effort is a focused edit in the files named. “High” effort needs new content, a new data model, or a new loop through the course.

## UI and UX

### 1. Make the sign-in screen feel like the product — high impact, low effort

The sign-in form is a floating card (`styles.css`, `.auth-screen` / `.auth-card`, and the form in `index.html`). The rule is `width: min(100%, 440px)` with 36px of padding, centered in an otherwise empty viewport, so on a desktop it reads as a small island. “Create an account” is a `.secondary-button`: transparent fill and a `--line` border (`#dcd8cf`) on the `--paper-2` card (`#eeebe3`). The label is dark, but the control itself barely separates from the card, so it looks inactive next to the coral “Sign in” button.

Give the card a comfortable measure (about 480px), a short line about what a session is, and a secondary action with a darker border or a filled sage style. Keep the inline errors added for empty, malformed, and short passwords.

### 2. Raise type size and contrast in the practice UI — high impact, low effort

Most instructional copy is 9–12px in `styles.css` (`.cue`, `.privacy-line`, `.metric small`, `.lesson-card p`, `.adjustment p`, the moved course rules in the same file). Muted text is `#69736e` on `#f5f2eb`, which is close to the edge for small sizes, and several labels are 9–10px (observations, word-map tags, history meta). The coach adjustments after a take — the thing a user is supposed to do next — are 10px.

Set a 16px body floor, use 14px for cues and adjustments, and darken `--muted` until small text clears WCAG AA on `--paper` and `--white`. Files: `styles.css`, plus the course-layout rules now at the bottom of that file.

### 3. Give the mobile shell a real navigation bar — high impact, medium effort

Below 900px the sidebar becomes a drawer (`styles.css` media query, `setMenuOpen()` in `app.js`). The streak is `display: none`, sync status stays inside the drawer, and the top bar still has to hold the menu, goal picker, and privacy button (`index.html` `.topbar`). After the drawer scroll/scrim fix, the menu works, but daily use still depends on opening it.

A bottom bar for Today, Practice, Drive, and Progress, with the goal and sync state in the top bar, would match how the app is actually used one-handed. Keep Settings, Course, and Library in the drawer.

### 4. Show recording and analysis state on the page — high impact, low effort

`startRecording()` and `finishRecording()` now write microphone failures into `#micStatus` instead of `alert()`. The rest of the take is still easy to misread: the live chip is an 8px “LIVE” (`styles.css` `.live-chip`), there is no elapsed time, and “Analyze words with Workers AI” only fills `#wordAnalysisStatus` after the click (`analyzeWordsWithCloud()`). Speech recognition failures are a paragraph in the results transcript (`recognitionMessage()`), which is easy to miss.

Show a timer on the record button, a calm “listening” state, and a progress line for cloud analysis (“Uploading”, “Transcribing”, “Matching words”). Disable the record button while a take is being scored so a second press does not overlap `finishRecording()`.

### 5. Add an onboarding path and stronger empty states — high impact, medium effort

A new account lands on Today with “No sessions yet”, a 0-minute ring, and a baseline lesson that does not explain the five goals (`renderToday()`, `presets` in `app.js`). The goal picker in the top bar and Settings (`renderSettings()`) lists the presets with one sentence each. Nothing asks what the person wants, whether they are sore, or how long they can practice. Progress’s empty chart (`#emptyChart`) and history line are fine, but they don’t point at the first action.

A three-step start — pick a goal, record the existing baseline phrase (`course.js` drill `baseline`), confirm the microphone — would make the first score mean something. Empty Progress should link to that baseline. Empty Drive should say which course week the routine belongs to.

### 6. Make lesson cards and the course list usable without a mouse — medium impact, low effort

Lesson cards put an invisible `<button>` over the whole card (`renderToday()`). The visible control is a 24px status icon. Session rows in `renderCourse()` are real buttons, but the grid (`index.html` course rules in `styles.css`) hides the objective under 700px (`.session-row small { display: none }`). Library cards use a 28px “↗” button (`renderLibrary()`).

Use a visible “Start” control with a focus ring, and keep the one-line objective on small screens. Add `:focus-visible` styles next to the existing hover rules in `styles.css`.

### 7. Loosen the desktop layout — medium impact, low effort

Views cap at 1400px with `padding: 58px 6.5vw` (`styles.css` `.view`). The practice page is a two-column grid (studio + 280px coach panel). Results are a 0.9/1.1 split. On a wide screen the prompt, meters, and adjustments sit far apart, while the coach panel repeats the goal that is already in the top bar (`updateGoalUI()`).

Cap the practice column nearer 800px and put the single next adjustment under the record button. Let the coach panel stay for targets, not as a second copy of the goal name.

### 8. Stop pretending the designed fonts loaded — low impact, low effort

`styles.css` still aliases DM Sans and Manrope to `local("Arial")` via `@font-face`, and headings then force Arial. The type ramp in the stylesheet never appears. Either self-host the two families or delete the names so the stack is honest. This is polish after the size and contrast work above.

## Voice training

### 1. Score change from the user’s baseline, not only distance to a preset band — implemented

Implemented. A comfortable save of the Natural voice snapshot (`course.js` drill `baseline`) stores `baselineAttemptId`. Any results screen can also mark the current take as the baseline, which is how a week-4 or week-8 retake replaces it. The overall blends that change with the preset-band score (`blendOverall()` in `voice-metrics.js`): 75% change in weeks 1–2, 50% in weeks 3–5 and open practice, 25% in weeks 6–8. Results and Progress show the pitch delta, including when there is no baseline yet. A trimmed or missing snapshot falls back to the band score. The original reasoning is below.

`analyzeAttempt()` in `app.js` scores median pitch, spectral balance, movement, and signal control against the selected preset in `presets`, using `scoreBand()` in `voice-metrics.js`. Being near the center of a wide band scores higher than merely entering it, and the acoustic total is capped at 92. A 100 is only `validatedOverall()` when the user also picks “3+ unfamiliar listeners consistently read it as female” — a self-report, not a measured listener test.

The course already has a baseline drill (`course.js`, `baseline`: “Use your ordinary voice. Do not improve anything yet.”) and tells the user to repeat it in weeks 4 and 8. Those takes are stored like any other attempt. Nothing compares later pitch, brightness, comfort, or strain with that snapshot. Someone whose comfortable pitch is 140 Hz and whose goal is Bright femme (190–245 Hz) gets a low pitch score for doing the week-1 instruction correctly.

Store the baseline attempt id on the account state. For early weeks, score “same setup, less effort, cue present.” Move the preset-center score in later, and show the delta (“8 Hz above your baseline, still under this goal’s floor”) in `renderResults()`. Files: `app.js` (`analyzeAttempt`, `renderResults`, `saveCurrent`), `voice-metrics.js`, `course.js` baseline notes.

### 2. Let comfort and strain change what happens next — implemented

Implemented. Comfort of 1 or 2 saves the take, does not mark the activity complete, and stores `pausedSession` instead of opening the next drill. The results screen explains the pause and offers rest, the straw/lip-trill reset (`sovt`), or continue anyway. Today keeps a resume banner until that drill is saved comfortably, the reminder is dismissed, or history is cleared. A high acoustic score shows that the comfort rating still counts. The original reasoning is below.

After every take the UI asks for comfort and “sounds like me” (`#comfortRating`, `#alignmentRating` in `index.html`). Those numbers are saved on the attempt and averaged on Progress (`renderProgress()`). They do not change the score, the next activity, or whether another take is offered. The safety copy is static: the coach panel says to stop if it hurts (`index.html` `.tip-box`), Settings has a clinical-care note, and drive blocks say to stop if the voice feels rough (`DRIVE_CLOSE` in `course.js`). `saveCurrent()` always advances to the next activity.

If comfort is 1 or the user marks pain, skip the rest of the session, suggest the straw/lip-trill drill (`sovt`) or rest, and do not treat that as a failed score. If comfort stays at 4–5 and the cue was present, advance. Surface a “you rated this uncomfortable” line next to a high acoustic score so the number cannot outvote the throat. Files: `saveCurrent()`, `renderResults()`, `course.js` `sovt` / `fatigue_reset`.

### 3. Review weak cues instead of only walking forward — high impact, high effort

`currentCourseSession()` picks the first session that still has an incomplete activity, and `saveCurrent()` advances within that session. There are 8 weeks × 5 sessions × 4 activities (`course.js`). Completion is a boolean. A shaky week-2 resonance take is never scheduled again unless the user hunts the Library. Open-practice saves do not update a review queue. Drive routines now follow the course week, but they are a separate check-in, not a review of missed cues.

Add a small review set: the lowest-scoring recent activity whose comfort was acceptable, resurfaced on Today every second or third day, using the same drill id. Do not delete the week structure; put one review card above the day’s four activities. Files: `renderToday()`, `saveCurrent()`, `state.attempts` / `state.completed` in `app.js`, drill ids in `course.js`.

### 4. Gate difficulty on the cue, not on the calendar — high impact, high effort

Week themes already ramp in a sensible order: ease, resonance, pitch floor, weight, prosody, transfer, durability, maintenance (`course.js` week titles). Any session can still be opened from the course list (`renderCourse()` “Preview”), and the acoustic score does not have to be decent before the next week. Week 6 asks for one aim in real sentences whether or not weeks 2–4 were comfortable.

Keep the map visible, but make “Continue” on Today require a simple rule: the session’s focus (the drill `focus` field) was inside the practice band on one comfortable take, or the user chose “skip ahead” explicitly. Preview can stay available. That uses data the app already stores (`attempts[].scores`, `comfort`, `activity`) without new acoustics. Files: `currentCourseSession()`, `renderCourse()`, `course.js` session objectives.

### 5. Make the metrics match the week’s actual target — high impact, medium effort

Every drill is scored with the same four weights for the current preset (`presets` in `app.js`). A week-1 ease drill and a week-5 melody drill produce the same kind of “overall.” Movement, pace, ending direction, and volume are computed in `analyzeAttempt()` (`endingShift`, `pace`, `volumeSpread`) and shown as observations, but only pitch, spectral balance, movement, and signal control enter the score. Intelligibility (`clarity`) is a browser-transcript similarity and is not in the 92. The Ramona preset copies the tomboy pitch and brightness ranges exactly; the character clips are inspiration, not a target (`playRamonaReference()`).

Weight the score by the drill’s `focus` / week: ease weeks emphasize signal control and comfort, resonance weeks emphasize spectral balance, melody weeks emphasize movement and ending direction. Keep the other numbers visible and labeled “not part of today’s score.” Split Ramona’s copy from the tomboy numbers if it is going to stay a separate goal. Files: `analyzeAttempt()`, `buildAdjustments()`, `presets`, `voice-metrics.js`, `course.js` `focus` fields.

### 6. Turn the drive check-in into the habit loop — medium impact, medium effort

Drive is the daily real-speech plan: one cue, three lines, and a check-in for minutes, comfort, and whether the cue held (`saveDriveCheckin()`, `course.js` `drives`). It now counts toward practice time, the weekly ring, and the streak. Nothing schedules it. There is no cron in `wrangler.jsonc`, no reminder, and no “same time tomorrow.” The streak (`streakFromDayKeys()` in `client-logic.js`) rewards any local day with a take or a drive, including a single short recording. The weekly ring target is a hard-coded 60 minutes (`renderToday()`).

Let the user pick a target duration and a reminder time in Settings, and count a day toward the streak only when comfort was at least 3 and the cue was “yes” or “partly,” so a painful take does not look like consistency. A reminder needs a new channel (email is not verified today; a Worker cron can only store the preference). Files: `renderSettings()`, `calculateStreak()`, `renderToday()`, `worker/index.js`, `wrangler.jsonc`.

### 7. Use self-report and acoustics as a disagreement, not as one number — medium impact, medium effort

The results screen asks three different questions and then mostly shows one score: acoustic bands, “sounds like me,” and outside perception (`updateValidatedScore()`). Outside perception flips 92 to 100 only in the “consistent” case, and only with already-high coverage (`validatedOverall()`). “Sounds like me” is averaged on Progress and otherwise ignored. A take can be a 90 and a 2/5 “sounds like me,” and the headline still says “Strong acoustic alignment” (`renderResults()`).

Show two lines every time: “What the microphone measured” and “What you thought.” When they disagree, the adjustment should say so (“The band score is high and you did not recognize yourself; stay with this phrase before adding pitch”). Do not treat the listener dropdown as a pass. Files: `renderResults()`, `updateValidatedScore()`, `renderProgress()`, `voice-metrics.js`.

### 8. Make word feedback trustworthy before adding more of it — medium impact, medium effort

“Play this word” and the word map now use Workers AI `segments[].words[]` when those times exist (`timedWordsFromCloud()` in `client-logic.js`, `buildWordAnalysis()` in `app.js`). Labels such as “masculine-leaning” compare one word’s pitch and spectral balance with the preset. The UI already says this is not a listener judgment. Low prompt agreement hides corrections. There is still no check that the word time overlaps voiced frames before the label is written, beyond a four-frame minimum, and the cues are fixed sentences rather than the drill’s own `cue`.

Keep the word map, but only attach a physical cue when the word is out of band, voiced frames are enough, and the cue repeats that drill’s `cue` from `course.js`. Drop gendered adjectives from the label and describe the acoustic fact (“pitch below this goal’s floor”). Files: `buildWordAnalysis()`, `renderWordAnalysis()`, drill `cue` fields.

### 9. Add a rest day and a vocal-load cap — medium impact, low effort

The README describes flexible rest days. The streak and the Today page do not. `attemptsThisWeek()` plus drive minutes feed a 60-minute ring with no upper bound. Nothing looks at total voiced time, comfort trending down, or the week-7 fatigue drill (`fatigue_reset`) except as another activity to complete.

If the last three saved takes have comfort ≤ 2, or today’s voiced minutes (attempt durations plus drive minutes) pass a limit the user sets, replace Today’s session with the reset drill and an explicit rest message. Do not break the streak for a planned rest day. Files: `renderToday()`, `calculateStreak()`, `course.js` `fatigue_reset` and `sovt`.

### 10. Give the maintenance week a real plan — medium impact, medium effort

Week 8’s last session asks, “What will you practice three times next week, and when?” (`course.js`, “Your maintenance plan”). The answer is not stored. After the course is complete, Drive shows the maintenance routine and does not rotate cues or remember which aim the user trusted. `state` has no field for “my aim” or “three weekly reps.”

Save the chosen aim (the same four aims the week-6 drive already names in `course.js`) and a weekly count. Today, after graduation, shows that plan instead of replaying week 8. Files: `renderToday()`, `currentDrive()` / `selectDrive()`, Settings in `app.js`, the week-8 reflection prompt.

## Suggested order

Baseline-relative scoring and the comfort pause are in place. The next low-effort, high-impact cluster is still sign-in layout and contrast, type size, and recording status, in `styles.css`, `index.html`, and `app.js`. Then add one review card and week-weighted scores. Reminders, a mastery gate, and the maintenance plan are worth doing after that.
