# Phase 1 copy and UI review

Reviewed on `cursor/fix-review-bugs-460b` before the Drive coach UI existed. Nothing here edits the app. Severity is high when the line is misleading, hard to read while driving, or fails a basic accessibility check; medium when it is filler or awkward; low when it is polish.

The course and drive instructions in `course.js` are mostly already plain sentences with a real physical cue. The problems are the slogans around them, type that is too small to read, and a Drive screen that is a long article rather than a car display.

## Copy

### C1. Results title is a three-beat slogan

- Severity: high
- Where: `index.html:180`
- Current: “Listen, notice, adjust.”
- Proposed: “Here is what this take measured.”

### C2. Today’s greeting never leaves week 1

- Severity: high
- Where: `index.html:85`. `renderToday()` in `app.js` updates the session title and does not touch this sentence.
- Current: “A short, focused session beats a heroic one. Let’s build ease.”
- Proposed: one sentence taken from the day’s session, for example “Week 3. Finish the last words on the same easy pitch.” Delete the second sentence. “Heroic” is a slogan, and “build ease” is the wrong instruction after week 1.

### C3. Create-account title is doing too much

- Severity: medium
- Where: `app.js:138` (the button next to it already says “Create account”)
- Current: “Make room for your voice.”
- Proposed: “Create an account.”

### C4. Score headlines praise or dodge

- Severity: medium
- Where: `app.js:502` and `app.js:516`
- Current: “Strong targets plus outside feedback.” “Strong acoustic alignment.” “A promising working take.” “Useful information.” “Let’s simplify the next take.”
- Proposed, in the same order: “You reported that listeners hear this as female.” “This take sits near the goal.” “Some of this take sits near the goal.” “A few measures are outside the goal.” “Try a shorter phrase at an easy volume.”

### C5. Word labels sound like a verdict

- Severity: medium
- Where: `app.js:610` and `app.js:613`. The cues under them are specific; the labels are the problem.
- Current: “More masculine-leaning acoustic cues relative to this goal.” “More feminine-leaning acoustic cues relative to this goal.”
- Proposed: “Pitch and resonance are both under this goal.” “Pitch and brightness are both above this goal.”
- The single-cause labels can stay factual: “Pitch is under this goal’s floor.” “Resonance is darker than this goal.” “Pitch is above this goal.” “Brightness is above this goal.”

### C6. An in-range pitch still gets a pep talk

- Severity: medium
- Where: `app.js:642`
- Current: “Pitch is well placed; give attention to resonance, expression, and comfort next.”
- Proposed: “Median pitch is inside this goal.” If nothing is wrong, stop there.

### C7. The prompt is explained twice

- Severity: medium
- Where: `index.html:145` and `index.html:148`
- Current kicker: “HEAR THE EXACT PROMPT · U.S. ENGLISH”
- Current line: “Device speech voice reads this exact line in U.S. English; voice availability and quality vary by browser.”
- Proposed: delete the kicker. Keep one sentence: “Plays this line in a U.S. English voice on your device.”

### C8. The comfort sliders have a pep-talk label

- Severity: medium
- Where: `index.html:191`
- Current: “YOUR EXPERIENCE MATTERS TOO”
- Proposed: delete it. “Comfort” and “Sounds like me” are the labels.

### C9. Empty transcript explains the scoring system

- Severity: medium
- Where: `index.html:219`
- Current: “A transcript will appear here when your browser provides one. Acoustic scoring does not depend on it.”
- Proposed: “No transcript for this take.”

### C10. Privacy heading is vague, and the Ramona note is said three times

- Severity: medium
- Where: `index.html:304` and `index.html:151`
- Current: “Your voice stays here.” And the Ramona block repeats that the clip is not the course line in the status, the iframe caption, and the small print.
- Proposed heading: “Where audio goes.” Proposed Ramona note, once: “This clip is not the course line.”

### C11. Section eyebrows that only rename the heading

- Severity: medium
- Where: `index.html:7`, `index.html:265`, `index.html:289`, and the same kicker style on `index.html:15`, `index.html:102`, `index.html:112`, `index.html:117`, `index.html:172`, `index.html:217`, `index.html:228`, `index.html:232`, `index.html:238`
- Current examples: “voice practice, made visible.” “TRAIN WITH INTENTION.” “MAKE IT YOURS.” “LILT · YOUR PRACTICE.” “SESSION INTENTION.” “CURRENT TARGET.”
- Proposed: delete the ones that repeat the heading. Keep a kicker only when it adds a fact, such as “WEEK 2 · 3/5 SESSIONS”.

### C12. Library and progress empty states are slightly dressed up

- Severity: low
- Where: `index.html:267`, `index.html:271`, `index.html:284`, `index.html:184`
- Current: “Choose the movement you want to isolate, then carry it into real speech.” “Bring a voice reference you love.” “Complete and save a practice attempt to begin your trend.” “Building your voice map.”
- Proposed: “Pick one drill, then try it in a sentence you actually say.” “Shadow a recording you have permission to use.” “Save a take to see it here.” “Scoring this take.”

### C13. Small grammar and leftover labels

- Severity: low
- Where: `index.html:65`, `index.html:239`, `course.js:5`
- Current: “0 day streak.” “After you practice.” “This is the voice I’m choosing today, and I know how to find it comfortably.”
- Proposed: “0 days” (and “1 day” only when the count is 1). Delete “After you practice”; the fields are already labeled. Practice line: “This is the voice I’m using today.”

Lines that should stay: the sign-in sentence about audio staying in the browser (`index.html:17`), the throat-pain warning (`index.html:174`), the microphone errors (`app.js:335`), and the drive block instructions in `course.js`. Those are specific and calm.

## UI and UX

### U1. The words a person must act on are too small and too faint

- Severity: high
- Where: `styles.css:2` (`.cue` 12px, `.privacy-line` 9px `#929995`, `.metric small` 9px `#969d99`, `.tip-box` 11px), `styles.css:26` (`.score-evidence` 10px), `styles.css:61` (`.adjustment p` 10px), `styles.css:73` (`.analysis-status` 10px), `styles.css:79` (word cues 10px)
- Measured contrast on the current colors: `#929995` on `#f5f2eb` is about 2.6:1. `#969d99` on `#fffdf8` is about 2.7:1. `#78817d` kickers on `#f5f2eb` are about 3.6:1. `#69736e` on `#f5f2eb` is about 4.4:1, under the 4.5:1 floor once the type is 10–12px. White `#fff` on the coral `#e77a60` record button, primary buttons, and the active lesson card is about 2.9:1.
- Proposed: 16px minimum for instructions, cues, adjustments, errors, and the pain warning. Darken muted text until it clears 4.5:1 on `--paper` and `--white`. Darken the coral until white text clears 4.5:1, or put `--ink` text on the current coral.

### U2. Several controls are below a 44px tap target

- Severity: high
- Where: `styles.css:2` (`.icon-button` is 32px, `.round-action` is 28px, `.filter-button` is about 11px type with 9px padding, `.modal-close` has no hit area), `styles.css:80` (word play button), `styles.css:97` (drive check-in labels at 12px)
- The 20 / 30 / 40 minute choices are those filter buttons (`app.js:281`). On a phone or a car mount they are easy to miss.
- Proposed: 44px minimum height for the menu, privacy, library, duration, word-play, and modal-close controls. Duration buttons should read “20 minutes”, “30 minutes”, “40 minutes”.

### U3. Keyboard focus is invisible

- Severity: high
- Where: `styles.css` has no `:focus` or `:focus-visible` rule. `styles.css:34` sets `.main { overflow: hidden; }`, which can clip a ring that sits on the edge of a view.
- Proposed: a 2px `--ink` outline with a 2px offset on `:focus-visible` for links, buttons, inputs, and summaries. Let the main column scroll rather than clipping.

### U4. The weekly ring’s name replaces the number

- Severity: high
- Where: `index.html:87`
- Current: `aria-label="Weekly practice progress"` on the element that also contains “0 of 60 min”. The label replaces that text for assistive tech.
- Proposed: drop the aria-label, or set it from script to the same fact, for example “12 of 60 minutes this week.”

### U5. Drive is a reading page, and the phone can sleep

- Severity: high
- Where: `index.html:225` through `index.html:261`, `app.js:278` through `app.js:292`, `styles.css:84` through `styles.css:99`. Nothing in the app calls `navigator.wakeLock` or listens for `visibilitychange`.
- The screen shows a planned length, a cue, three quoted lines, four blocks of instructions, a “How to do this” list, and a check-in with a slider. Body copy is 12px and muted. There is no listening, speaking, or too-noisy state.
- Proposed for the live coach, one glance from a mount: the current line in large type, one status sentence, and large controls. Status is “Listening.”, “Too noisy to coach.”, or the single fix, such as “Move the tongue more forward.” Keep “Stop if your throat hurts.” in the same large type. Leave the block-by-block instructions in `course.js` for someone reading at home, behind a disclosure, not on the live screen. The session itself has to hold a screen wake lock; that behavior is specified in `README.md` and checked by the suite.

### U6. “Create an account” barely looks like a button

- Severity: medium
- Where: `styles.css:2` (`.secondary-button` border `--line`) and `styles.css:17` (`.auth-card` is 440px on `--paper-2`)
- `#dcd8cf` on `#eeebe3` is about 1.2:1, so the border disappears and the secondary action looks inactive. Week numbers in `#98a09b` on `#eeebe3` are about 2.3:1 (`styles.css:46`).
- Proposed: a filled sage or a 2px `--ink` border for secondary actions, and a card near 480px wide. Darken the week number.

### U7. The target bars are not measurements

- Severity: medium
- Where: `app.js:305` to `app.js:306`
- Current: Pitch, Brightness, Movement, and Effort render at fixed widths of 70, 78, 62, and 85 percent on every visit.
- Proposed: show the preset ranges as text and delete the bars until they reflect a real take.

### U8. The avatar is a hardcoded J

- Severity: medium
- Where: `index.html:46`. `enterApp()` sets the email and does not change the avatar.
- Proposed: use the account’s initial, or remove the avatar.

### U9. Lesson and library controls are easy to miss

- Severity: medium
- Where: `styles.css:2` (`.lesson-card button` covers the card; `.status-icon` is 24px; `.round-action` is 28px), `app.js:273` (aria-label “Start lesson” on a “↗”), `styles.css:100` (session objective hidden under 700px), `styles.css:4` (history columns after the second are hidden under 600px)
- Proposed: a visible “Start” control of at least 44px, keep the one-line objective on small screens, and on a phone show pitch and comfort instead of dropping them.

### U10. Recording state is a tiny LIVE chip

- Severity: medium
- Where: `styles.css:2` (`.live-chip` is 8px), `app.js:360` and `app.js:373`
- The button label does change to “Stop & analyze”, and Space is a real shortcut (`app.js:807`). There is no elapsed time. A second tap before `getUserMedia` resolves can start a second stream and orphan the first (`app.js:350`).
- Proposed: disable the button while the mic is opening, show minutes and seconds next to “Stop”, and use a text status (“Listening”) rather than an 8px chip. The floating “SPACE” label can stay on a keyboard and stay hidden on a phone, which it already is under 600px.

### U11. The drive check-in is a desktop form

- Severity: medium
- Where: `index.html:249` to `index.html:256`
- A range slider and two selects are hard to use in a mount. The comfort warning elsewhere in the app is clear; this form does not repeat “stop if it hurts” at the moment someone is logging the drive.
- Proposed: three large choices for minutes (20, 30, 40, skipped), five large comfort choices, and the same three cue answers. One line above them: “Stop if your throat hurts.”

### U12. Designed fonts are aliased to Arial

- Severity: low
- Where: `styles.css:31` to `styles.css:38`
- `@font-face` maps DM Sans and Manrope to local Arial, then headings force Arial. The names in the file describe a typeface the page does not load.
- Proposed: self-host the families, or delete the aliases and say Arial in the stack.

## Spoken Drive coach copy

When the coach speaks, use the same bar as the cue tests: one or two calm sentences, the physical fix, no praise, no slogan. “Move the tongue more forward.” and “Lift the end of the word. You dropped into chest.” are the right length. “Great job. Speak. Listen. Improve.” is not.
