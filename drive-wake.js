// Keeps the Drive coach screen awake. The screen Wake Lock is requested from
// the start tap. If that API is missing or the request fails, the same tap
// starts one muted looping video. Nothing here schedules a timer or redraw.

export function awakeLabel(mode) {
  if (mode === 'lock' || mode === 'video') return 'Screen stays on.';
  if (mode === 'manual') return 'Set Auto-Lock to Never during drives.';
  return '';
}

export function createStayAwake(hooks) {
  let sentinel = null;
  let onRelease = null;
  let mode = 'off';
  let active = false;

  function clearListener() {
    if (sentinel && onRelease) sentinel.removeEventListener?.('release', onRelease);
    onRelease = null;
  }

  function hold(lock) {
    clearListener();
    sentinel = lock;
    onRelease = () => {
      lock.removeEventListener?.('release', onRelease);
      if (sentinel === lock) sentinel = null;
      if (!active) return;
      const visible = hooks.isVisible ? hooks.isVisible() : (typeof document !== 'undefined' && document.visibilityState === 'visible');
      if (!visible) {
        mode = 'off';
        hooks.onMode?.('off');
        return;
      }
      Promise.resolve().then(() => hooks.requestWakeLock()).then(next => {
        if (!active || !next) {
          next?.release?.();
          return;
        }
        hold(next);
        try { hooks.pauseVideo(); } catch { /* the video can already be quiet */ }
        mode = 'lock';
        hooks.onMode?.('lock');
      }).catch(() => {
        if (!active) return;
        Promise.resolve().then(() => hooks.playVideo()).then(() => {
          if (!active) return;
          mode = 'video';
          hooks.onMode?.('video');
        }).catch(() => {
          if (!active) return;
          mode = 'manual';
          hooks.onMode?.('manual');
        });
      });
    };
    lock.addEventListener?.('release', onRelease);
  }

  function arm() {
    active = true;
    let videoPlay;
    try {
      videoPlay = hooks.playVideo();
    } catch (error) {
      videoPlay = Promise.reject(error);
    }
    if (videoPlay && typeof videoPlay.catch === 'function') videoPlay.catch(() => {});
    if (sentinel) {
      hooks.pauseVideo();
      return Promise.resolve(mode);
    }
    let lockPlay;
    try {
      lockPlay = hooks.requestWakeLock();
    } catch (error) {
      lockPlay = Promise.reject(error);
    }
    return Promise.resolve(lockPlay).then(lock => {
      hold(lock);
      hooks.pauseVideo();
      mode = 'lock';
      return mode;
    }).catch(() => Promise.resolve(videoPlay).then(() => {
      mode = 'video';
      return mode;
    }).catch(() => {
      mode = 'manual';
      return mode;
    }));
  }

  async function onVisible() {
    if (!active || sentinel) return mode;
    try {
      const lock = await hooks.requestWakeLock();
      hold(lock);
      hooks.pauseVideo();
      mode = 'lock';
      return mode;
    } catch { /* the video is the fallback */ }
    try {
      if (!hooks.isVideoPlaying?.()) await hooks.playVideo();
      mode = 'video';
    } catch {
      mode = 'manual';
    }
    return mode;
  }

  async function stop() {
    active = false;
    const current = sentinel;
    clearListener();
    sentinel = null;
    mode = 'off';
    try { hooks.pauseVideo(); } catch { /* already quiet */ }
    try { await current?.release?.(); } catch { /* the browser already released it */ }
    return mode;
  }

  function status() {
    return { mode, active, holdingLock: !!sentinel };
  }

  return { arm, onVisible, stop, status };
}

export async function applyVisibility({
  visible,
  stopped = false,
  userPaused = false,
  interrupt,
  resume,
  stopMic,
  suspendAudio,
  resumeAudio,
  openMic,
  stayAwake
}) {
  if (stopped) return { skipped: true, mode: stayAwake.status().mode };
  if (!visible) {
    interrupt('hidden');
    stopMic();
    await suspendAudio();
    return { paused: true, mode: stayAwake.status().mode };
  }
  const mode = await stayAwake.onVisible();
  if (userPaused) return { paused: true, mode, heldPaused: true };
  await resumeAudio();
  await openMic();
  resume();
  return { paused: false, mode };
}
