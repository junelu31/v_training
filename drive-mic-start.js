// Decisions for the iPhone Safari microphone prompt, and for playback after a take.
// The sheet (and the route change when the mic opens) interrupts the audio
// session before a track exists. A later flicker does the same for a few dozen
// milliseconds once the mic graph is hot. These helpers keep that flicker from
// pausing the coach or counting a clip as finished, and they notice a clip that
// played through even when the buffer never fires its end event.

export const MIC_SETTLE_MS = 1500;
// A real route drop (a call, the sheet) outlasts this. A playback flicker does not.
export const PLAYBACK_CUT_MS = 700;
// Wall-clock slack after the buffer's duration. The context clock is preferred.
export const PLAYBACK_END_SLACK_MS = 80;

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

/**
 * iPhone Safari capture uses a ScriptProcessor connected to the destination.
 * AudioWorkletNode defaults to an explicit channel count. Forcing that count
 * to 1 hands the processor one silent channel. Stereo input keeps the voice
 * on channel 0 and silence on channel 1 (WebKit bug 259193).
 */
export function needsDirectScriptCapture(userAgent = '', platform = '', touchPoints = 0) {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return platform === 'MacIntel' && touchPoints > 1;
}

/** Downmix every channel. On iPhone the voice is channel 0 and channel 1 is silent. */
export function mixChannels(channels) {
  const list = (channels || []).filter(channel => channel && channel.length);
  if (!list.length) return new Float32Array(0);
  const length = list[0].length;
  const mix = new Float32Array(length);
  for (const channel of list) {
    const n = Math.min(length, channel.length);
    for (let i = 0; i < n; i++) mix[i] += channel[i];
  }
  if (list.length === 1) return mix;
  const scale = 1 / list.length;
  for (let i = 0; i < length; i++) mix[i] *= scale;
  return mix;
}

/** True once a non-running context has stayed down long enough to be a real cut. */
export function interruptionHeld(elapsedMs, limitMs = PLAYBACK_CUT_MS) {
  return elapsedMs >= limitMs;
}

/**
 * True when a buffer source has played its clip.
 * currentTime only counts while the source was not stopped: the clock keeps
 * moving after stop() whenever the context is running. The wall clock covers
 * a context that stays running but never fires onended and never advances
 * currentTime. Time spent interrupted or suspended is not counted.
 */
export function bufferPlayed({
  cut = false,
  state = 'running',
  elapsedSec = 0,
  durationSec = 0,
  suspendedMs = 0,
  nowMs = 0,
  startedMs = 0
} = {}) {
  if (cut) return false;
  if (state === 'interrupted' || state === 'suspended' || state === 'closed') return false;
  if (!(durationSec > 0)) return false;
  if (elapsedSec + 0.03 >= durationSec) return true;
  const wall = nowMs - startedMs - suspendedMs;
  return wall >= durationSec * 1000 + PLAYBACK_END_SLACK_MS;
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
