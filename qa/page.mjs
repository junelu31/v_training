// A small stand-in for the browser surface the Drive coach has to survive:
// wake lock, a hidden video fallback, visibility, AudioContext, and a mic stream.

function event(type) {
  return { type };
}

export function createDrivePage() {
  const listeners = { visibilitychange: new Set(), pointerdown: new Set(), click: new Set(), touchend: new Set() };
  const state = {
    visibilityState: 'visible',
    wakeLockMode: 'ok',
    sentinels: [],
    videos: [],
    audioContexts: [],
    streams: [],
    requestCount: 0,
    getUserMediaCalls: 0
  };

  function removeFromBody(node) {
    const index = document.body.children.indexOf(node);
    if (index >= 0) document.body.children.splice(index, 1);
    node.parentNode = null;
    node.removed = true;
  }

  function makeVideo() {
    const video = {
      muted: false,
      loop: false,
      playsInline: false,
      volume: 1,
      paused: true,
      hidden: false,
      src: '',
      width: 300,
      height: 150,
      style: {},
      attributes: {},
      playCount: 0,
      mutedAtPlay: false,
      removed: false,
      parentNode: null,
      setAttribute(name, value) {
        video.attributes[name] = String(value);
        if (name === 'muted') video.muted = true;
        if (name === 'loop') video.loop = true;
        if (name === 'playsinline') video.playsInline = true;
      },
      getAttribute(name) {
        return video.attributes[name] ?? null;
      },
      play() {
        video.playCount += 1;
        video.mutedAtPlay = video.muted === true || video.attributes.muted != null;
        video.paused = false;
        return Promise.resolve();
      },
      pause() {
        video.paused = true;
      },
      remove() {
        removeFromBody(video);
      },
      load() {}
    };
    state.videos.push(video);
    return video;
  }

  const document = {
    get visibilityState() {
      return state.visibilityState;
    },
    get hidden() {
      return state.visibilityState !== 'visible';
    },
    body: { children: [], appendChild(node) { node.parentNode = document.body; document.body.children.push(node); return node; }, removeChild: removeFromBody },
    addEventListener(type, fn) {
      listeners[type]?.add(fn);
    },
    removeEventListener(type, fn) {
      listeners[type]?.delete(fn);
    },
    dispatchEvent(evt) {
      const type = evt?.type;
      for (const fn of [...(listeners[type] || [])]) fn(evt);
      return true;
    },
    createElement(tag) {
      if (String(tag).toLowerCase() === 'video') return makeVideo();
      return { style: {}, setAttribute() {}, appendChild() {}, remove() {} };
    },
    querySelector() {
      return null;
    }
  };

  function releaseSentinel(sentinel) {
    if (sentinel.released) return;
    sentinel.released = true;
    for (const fn of [...sentinel.listeners.release]) fn();
  }

  function requestWakeLock(type) {
    state.requestCount += 1;
    if (state.wakeLockMode === 'reject' || state.visibilityState !== 'visible') {
      const error = new Error(state.visibilityState !== 'visible' ? 'Document is hidden' : 'Wake Lock permission denied');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    }
    const sentinel = {
      type,
      released: false,
      listeners: { release: new Set() },
      addEventListener(name, fn) { sentinel.listeners[name]?.add(fn); },
      removeEventListener(name, fn) { sentinel.listeners[name]?.delete(fn); },
      release() {
        releaseSentinel(sentinel);
        return Promise.resolve();
      }
    };
    state.sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  }

  const navigator = {
    get wakeLock() {
      if (state.wakeLockMode === 'missing') return undefined;
      return { request: requestWakeLock };
    },
    mediaDevices: {
      getUserMedia() {
        state.getUserMediaCalls += 1;
        return Promise.resolve(makeStream());
      }
    }
  };

  function makeTrack() {
    const track = {
      kind: 'audio',
      enabled: true,
      readyState: 'live',
      stop() {
        track.readyState = 'ended';
      }
    };
    return track;
  }

  function makeStream() {
    const tracks = [makeTrack()];
    const stream = {
      getTracks() { return tracks; },
      getAudioTracks() { return tracks.filter(track => track.kind === 'audio'); },
      get active() { return tracks.some(track => track.readyState === 'live'); }
    };
    state.streams.push(stream);
    return stream;
  }

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.state = 'running';
      this.failResume = false;
      this.resumeCalls = 0;
      this.suspendCalls = 0;
      state.audioContexts.push(this);
    }
    resume() {
      this.resumeCalls += 1;
      if (this.failResume) return Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
      if (this.state !== 'closed') this.state = 'running';
      return Promise.resolve();
    }
    suspend() {
      this.suspendCalls += 1;
      if (this.state !== 'closed') this.state = 'suspended';
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        smoothingTimeConstant: 0.8,
        getFloatTimeDomainData(buffer) { buffer.fill(0); },
        getFloatFrequencyData(buffer) { buffer.fill(-100); },
        connect() {},
        disconnect() {}
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      const node = { gain: { value: 1 }, connect() {}, disconnect() {} };
      return node;
    }
    createBuffer() {
      return { getChannelData: () => new Float32Array(128) };
    }
  }

  const speeches = [];
  const speechSynthesis = {
    cancel() {},
    speak(utterance) { speeches.push(String(utterance?.text || '')); },
    getVoices() { return []; }
  };

  function dispatch(type) {
    for (const fn of [...(listeners[type] || [])]) fn(event(type));
  }

  return {
    state,
    document,
    navigator,
    AudioContext: FakeAudioContext,
    speechSynthesis,
    speeches,
    makeStream,
    listenerCount(type = 'visibilitychange') {
      return listeners[type]?.size || 0;
    },
    activeSentinels() {
      return state.sentinels.filter(item => !item.released);
    },
    domVideos() {
      return document.body.children.filter(node => state.videos.includes(node) && !node.removed);
    },
    liveTracks() {
      return state.streams.flatMap(stream => stream.getAudioTracks()).filter(track => track.readyState === 'live');
    },
    hide() {
      state.visibilityState = 'hidden';
      for (const sentinel of state.sentinels) releaseSentinel(sentinel);
      dispatch('visibilitychange');
    },
    show() {
      state.visibilityState = 'visible';
      dispatch('visibilitychange');
    },
    click() {
      dispatch('pointerdown');
      dispatch('click');
    }
  };
}

export function isFallbackVideo(video) {
  if (!video) return false;
  const muted = video.muted === true || video.attributes?.muted != null;
  const loop = video.loop === true || video.attributes?.loop != null;
  const inline = video.playsInline === true || video.attributes?.playsinline != null;
  const hidden = video.hidden === true
    || video.attributes?.['aria-hidden'] === 'true'
    || video.style?.display === 'none'
    || video.style?.visibility === 'hidden'
    || video.style?.opacity === '0'
    || String(video.style?.left || '').includes('-')
    || video.width === 0;
  return muted && loop && inline && hidden && video.playCount > 0 && video.mutedAtPlay && !video.paused && !video.removed;
}

let installedTail = Promise.resolve();

export function withPage(page, fn) {
  const job = installedTail.then(async () => {
    const keys = ['document', 'navigator', 'AudioContext', 'webkitAudioContext', 'window', 'speechSynthesis', 'SpeechSynthesisUtterance'];
    const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const windowRef = {
      document: page.document,
      navigator: page.navigator,
      AudioContext: page.AudioContext,
      webkitAudioContext: page.AudioContext,
      speechSynthesis: page.speechSynthesis,
      SpeechSynthesisUtterance: class SpeechSynthesisUtterance {
        constructor(text) { this.text = text; }
      }
    };
    const installed = {
      document: page.document,
      navigator: page.navigator,
      AudioContext: page.AudioContext,
      webkitAudioContext: page.AudioContext,
      speechSynthesis: page.speechSynthesis,
      SpeechSynthesisUtterance: windowRef.SpeechSynthesisUtterance,
      window: windowRef
    };
    for (const [key, value] of Object.entries(installed)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, enumerable: true, value });
    }
    try {
      return await fn();
    } finally {
      for (const key of keys) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
        else delete globalThis[key];
      }
    }
  });
  installedTail = job.then(() => {}, () => {});
  return job;
}

export async function settle() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
}
