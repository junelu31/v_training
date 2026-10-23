# Drive coach checks

`npm test` runs these with the rest of the suite. `npm run qa` runs only this folder.

The checks drive the coach that is on main. They do not import a second policy, and they do not record anyone's voice.

- `qa/invariants.test.mjs` locks the voice (`af_river`), the long phrase bank, imitate-the-coach sentences, no comfort or rest nag, "next phrase" as a command, grouped fry feedback, and unspoken prompt words.
- `qa/safari-loop.test.mjs` mounts the coach on a fake iPhone page. It checks that start speaks, the mic sheet does not pause the coach, a phrase gets a spoken follow-up, "next phrase" is only the command, a denial does not fake-listen, a flicker shorter than the route hold stays live, a held drop pauses and then resumes, and a clip that never fires `onended` and never moves the context clock does not leave the rest of the drive mute.
- Unauthenticated `/api/auth/me`, `/api/auth/logout`, `/api/state`, `/api/analyze`, and `/api/drive/turn` must answer 401. That lives in `tests/worker.test.mjs` so it shares one local database.

A signed-in drive turn with no cloud model configured answers 400 for an empty body and 503 when there is text to speak. It must not answer 500.
