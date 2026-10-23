// Decisions for the iPhone Safari microphone prompt.
// The sheet (and the route change when the mic opens) interrupts the audio
// session before a track exists. These helpers keep that interruption from
// pausing the coach or counting the opening line as finished.

export const MIC_SETTLE_MS = 1500;

/** Set play-and-record before capture so the route does not flip under the opening line. */
export function usePlayAndRecord(audioSession) {
  if (!audioSession || audioSession.type === 'play-and-record') return false;
  audioSession.type = 'play-and-record';
  return true;
}

/**
 * True while a context interruption is the permission sheet or the mic opening,
 * not a call or a lost route. awaitingPermission covers the sheet itself, which
 * happens before the track exists. starting covers the open that follows.
 */
export function startupCoversInterruption({ awaitingPermission = false, starting = false, micOpenedAt = 0, now = 0 } = {}) {
  if (awaitingPermission || starting) return true;
  return micOpenedAt > 0 && now - micOpenedAt < MIC_SETTLE_MS;
}

/**
 * What to do when the AudioContext changes state.
 * resume-only: the sheet or the route change. Resume, and leave the coach listening.
 * pause: the route dropped after startup.
 * resume-session: audio is back after a real interruption.
 */
export function onContextState({ state, covered, hidden, stopped, userPaused, paused }) {
  if (stopped || hidden || userPaused) return 'ignore';
  if (state === 'interrupted' || state === 'suspended') return covered ? 'resume-only' : 'pause';
  if (state === 'running' && paused) return 'resume-session';
  return 'ignore';
}

/** After getUserMedia settles. A cut-off opening line is spoken again once audio can run. */
export function afterMicRequest({ granted, openingPlayed }) {
  if (!granted) return { listen: false, replayOpening: false, recover: 'denied' };
  return { listen: true, replayOpening: !openingPlayed, recover: null };
}

/** Screen and spoken copy when capture does not start. Spoken only if audio can still play. */
export function micFailureCopy(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return {
      line: 'The microphone is blocked.',
      hint: 'Allow the microphone for this site, then tap to continue.',
      say: 'The microphone is blocked. Allow the microphone for this site, then tap to continue.'
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      line: 'No microphone is available.',
      hint: 'Check that this phone has a microphone, then tap to continue.',
      say: 'No microphone is available. Check that this phone has a microphone, then tap to continue.'
    };
  }
  return {
    line: 'The microphone did not start.',
    hint: 'Tap to continue.',
    say: 'The microphone did not start. Tap to continue.'
  };
}
