// 导出时的 Video 录制：只记播放头，不碰 DOM。
// Pamela — the exported movie's view of a video: a playhead, no element.
//
// 舞台上的 Video 是一个 <video> 元素，画面与声音共用同一个播放头：
// enable / play / pause / speed 移动播放头，mute / volume / audio.enable
// 只是叠加在播放头上的开关。导出先把播放头记成若干「段」：每段从某个时刻
// 开始，以某个速率从素材的某个位置播放，并带一条音量折线。声音混音直接吃
// 这些段；等视频帧接进渲染后端时，同一个播放头也可以用来取帧。
//
// 与真舞台一致的几处细节：
// - 建对象时 mute 省略即 true，脚本没有解除静音就没有可听的段；
// - enable() 从头开始，play() 从当前位置继续，pause() 保留位置；
// - 画面轨的 play / pause 也动播放头，因为声音跟着同一个元素走；
// - speed / volume 带时间参数时，舞台会等这段时间走完，导出同样等待。

/** 与 `video.js` 的 rate() 相同的上下限：webview 能接受的播放速率。 */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampRate(value) {
  return Math.min(MAX_RATE, Math.max(MIN_RATE, value));
}

/**
 * 给记录对象套一层代理：未知方法返回自身，链式写法不会炸；返回记录本身
 * 的调用换成代理，`clip.play().move(…)` 不会掉到裸对象上。
 */
function chainable(record) {
  let proxy;
  proxy = new Proxy(record, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value === "function") {
        return (...args) => {
          const result = value.apply(target, args);
          return result === target ? proxy : result;
        };
      }
      if (prop in target) {
        return value;
      }
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON" || prop === "valueOf") {
        return undefined;
      }
      return () => proxy;
    },
  });
  return proxy;
}

/**
 * 视频播放头的录制器。
 *
 * 一次导出建一个；每个 `Video(…)` 从这里拿到自己的记录对象。演出走完后
 * 由 `voices()` 交出所有可听段，交给 `buildAudioTrack` 混音。
 *
 * @param {{now: () => number, wait: (ms: number) => Promise<void>}} options.clock
 */
export function createVideoRecorder({ clock }) {
  const videos = [];
  /** 时间线 target → 播放头状态，供渲染后端按帧取素材时间。 */
  const byKey = new Map();
  let counter = 0;

  function factory(args, context) {
    const path = typeof args?.[0] === "string" ? args[0].trim() : "";
    if (!path) {
      throw new Error("Video 需要视频文件名");
    }

    const id = `video-${(counter += 1)}`;
    const state = {
      path,
      volume: clamp01(numberOr(args[1], 1)),
      loop: Boolean(args[2]),
      muted: args[3] === undefined || args[3] === null ? true : Boolean(args[3]),
      audioEnabled: true,
      rate: 1,
      playing: false,
      /** 非播放状态下的素材位置；播放时是 `sinceMs` 那一刻的位置。 */
      positionMs: 0,
      sinceMs: 0,
      open: null,
      spans: [],
      /** 播放头段：不论静音与否都记，画面取帧靠它定位素材时间。 */
      track: [],
      openTrack: null,
    };
    videos.push(state);

    const now = () => clock.now();
    const positionAt = (at) =>
      state.playing ? state.positionMs + (at - state.sinceMs) * state.rate : state.positionMs;
    const audible = () => state.audioEnabled && !state.muted;
    /** 时间线里这一对象的键；与 `export-stage.js` 写 state 时用的 target 同名。 */
    const key = "video:" + (context?.assignee ? String(context.assignee) : "video");
    byKey.set(key, state);

    /** 舞台上的等待：带时间参数的 volume / speed 要占住这段时间。 */
    const wait = (ms) => {
      const span = Math.max(0, Number(ms) || 0);
      if (!(span > 0)) {
        return;
      }
      context?.pending?.push(clock.wait(span));
    };

    const openSpan = (at) => {
      if (state.open || !state.playing || !audible()) {
        return;
      }
      state.open = {
        kind: "Video",
        id,
        path: state.path,
        startMs: at,
        offsetMs: Math.max(0, positionAt(at)),
        rate: state.rate,
        loop: state.loop,
        gain: [{ at, value: state.volume }],
      };
    };

    const closeSpan = (at) => {
      if (!state.open) {
        return;
      }
      state.open.stopMs = at;
      // 同一时刻开了又关（例如连着两次 enable）不必留下一段空声音。
      if (at > state.open.startMs) {
        state.spans.push(state.open);
      }
      state.open = null;
    };

    const openTrack = (at) => {
      if (state.openTrack || !state.playing) {
        return;
      }
      state.openTrack = {
        startMs: at,
        offsetMs: Math.max(0, positionAt(at)),
        rate: state.rate,
        loop: state.loop,
      };
    };

    const closeTrack = (at) => {
      if (!state.openTrack) {
        return;
      }
      state.openTrack.stopMs = at;
      if (at > state.openTrack.startMs) {
        state.track.push(state.openTrack);
      }
      state.openTrack = null;
    };

    /** 从 `at` 起继续（或从头）播放；`fromStart` 对应 enable() 的重播。 */
    const start = (at, fromStart) => {
      if (fromStart) {
        closeSpan(at);
        closeTrack(at);
        state.positionMs = 0;
      } else {
        state.positionMs = positionAt(at);
        closeSpan(at);
        closeTrack(at);
      }
      state.playing = true;
      state.sinceMs = at;
      openSpan(at);
      openTrack(at);
    };

    const pause = (at) => {
      state.positionMs = positionAt(at);
      closeSpan(at);
      closeTrack(at);
      state.playing = false;
      state.sinceMs = at;
    };

    const setMuted = (at, value) => {
      state.muted = value === undefined || value === null ? true : Boolean(value);
      if (state.muted) {
        closeSpan(at);
      } else {
        openSpan(at);
      }
    };

    const setAudioEnabled = (at, value) => {
      state.audioEnabled = Boolean(value);
      if (state.audioEnabled) {
        openSpan(at);
      } else {
        closeSpan(at);
      }
    };

    const setVolume = (at, value, time) => {
      const previous = state.volume;
      state.volume = clamp01(numberOr(value, previous));
      const fadeMs = Math.max(0, Number(time) || 0);
      if (state.open) {
        if (fadeMs > 0) {
          state.open.gain.push({ at, value: previous }, { at: at + fadeMs, value: state.volume });
        } else {
          state.open.gain.push({ at, value: state.volume });
        }
      }
      wait(time);
    };

    /** 速率是播放头的属性，换速率时把当前段切开，位置接着往下走。 */
    const setRate = (at, value, absolute) => {
      const amount = numberOr(value, null);
      if (amount === null || amount <= 0) {
        throw new Error("Video 的速度需要大于 0 的数字");
      }
      const target = clampRate(absolute ? amount : state.rate * amount);
      if (!state.playing) {
        state.rate = target;
        return;
      }
      const position = positionAt(at);
      // 刚开口就换速：同一时刻不必切出一段零长度的声音。
      const sameInstant = state.openTrack !== null && state.openTrack.startMs === at;
      if (!sameInstant) {
        closeSpan(at);
        closeTrack(at);
      }
      state.positionMs = position;
      state.sinceMs = at;
      state.rate = target;
      if (sameInstant) {
        state.openTrack.rate = target;
        if (state.open) {
          state.open.rate = target;
        }
      } else {
        openSpan(at);
        openTrack(at);
      }
    };

    const setLoop = (at, value) => {
      state.loop = Boolean(value);
      if (state.open) {
        state.open.loop = state.loop;
      }
      if (state.openTrack) {
        state.openTrack.loop = state.loop;
      }
    };

    const mediaRecord = {
      kind: "VideoMedia",
      /** 只影响画面：元素留在舞台上，播放头照常走。 */
      enable() {
        return mediaRecord;
      },
      disable() {
        return mediaRecord;
      },
      play() {
        start(now(), false);
        return mediaRecord;
      },
      pause() {
        pause(now());
        return mediaRecord;
      },
      speed(value, time) {
        setRate(now(), value, false);
        wait(time);
        return mediaRecord;
      },
      speedTo(value, time) {
        setRate(now(), value, true);
        wait(time);
        return mediaRecord;
      },
    };

    const audioRecord = {
      kind: "VideoAudio",
      enable() {
        setAudioEnabled(now(), true);
        return audioRecord;
      },
      disable() {
        setAudioEnabled(now(), false);
        return audioRecord;
      },
      play() {
        start(now(), false);
        return audioRecord;
      },
      pause() {
        pause(now());
        return audioRecord;
      },
      mute(value) {
        setMuted(now(), value);
        return audioRecord;
      },
      volume(value, time) {
        setVolume(now(), value, time);
        return audioRecord;
      },
      loop() {
        setLoop(now(), true);
        return audioRecord;
      },
      once() {
        setLoop(now(), false);
        return audioRecord;
      },
      speed(value, time) {
        setRate(now(), value, false);
        wait(time);
        return audioRecord;
      },
      speedTo(value, time) {
        setRate(now(), value, true);
        wait(time);
        return audioRecord;
      },
      /** 与 `Audio.duration()` 一样：导出没有元数据可读，答案固定是 0。 */
      duration() {
        return Promise.resolve(0);
      },
    };

    const videoRecord = {
      kind: "Video",
      path,
      /** 从头重播，同时启用两条子轨（脚本的 mute 设置仍然管用）。 */
      enable() {
        setAudioEnabled(now(), true);
        start(now(), true);
        return videoRecord;
      },
      disable() {
        pause(now());
        setAudioEnabled(now(), false);
        return videoRecord;
      },
      play() {
        start(now(), false);
        return videoRecord;
      },
      pause() {
        pause(now());
        return videoRecord;
      },
      mute(value) {
        setMuted(now(), value);
        return videoRecord;
      },
      volume(value, time) {
        setVolume(now(), value, time);
        return videoRecord;
      },
      loop() {
        setLoop(now(), true);
        return videoRecord;
      },
      once() {
        setLoop(now(), false);
        return videoRecord;
      },
      speed(value, time) {
        setRate(now(), value, false);
        wait(time);
        return videoRecord;
      },
      speedTo(value, time) {
        setRate(now(), value, true);
        wait(time);
        return videoRecord;
      },
      duration() {
        return audio.duration();
      },
    };

    const media = chainable(mediaRecord);
    const audio = chainable(audioRecord);
    videoRecord.media = media;
    videoRecord.audio = audio;
    return chainable(videoRecord);
  }

  return {
    video: factory,
    /**
     * 所有可听段。在演出结束后调用一次：仍开着的段收在无穷远处，
     * 由渲染长度截断（与 `planAudio` 对仍在响的声音的处理相同）。
     */
    voices() {
      const all = [];
      for (const state of videos) {
        if (state.open) {
          const { open } = state;
          open.stopMs = Number.POSITIVE_INFINITY;
          state.spans.push(open);
          state.open = null;
        }
        all.push(...state.spans);
      }
      return all.sort((left, right) => left.startMs - right.startMs);
    },
    /**
     * `t` 时刻这个对象的播放头在素材里的位置（毫秒）。
     *
     * 渲染后端每帧问一次：还在播的段按速率外推，暂停的段停在收尾处。
     * 循环与否由调用方按素材长度处理（这里不知道文件多长）。
     *
     * @param {string} target 时间线里的键，如 `video:clip`
     * @param {number} tMs 虚拟时钟的毫秒
     */
    mediaTimeAt(target, tMs) {
      const state = byKey.get(String(target));
      if (!state) {
        return 0;
      }
      const open = state.openTrack
        ? { ...state.openTrack, stopMs: Number.POSITIVE_INFINITY }
        : null;
      const segments = open ? [...state.track, open] : state.track;
      if (segments.length === 0) {
        return 0;
      }
      const at = Number(tMs) || 0;
      for (const segment of segments) {
        if (at >= segment.startMs && at < segment.stopMs) {
          return Math.max(0, segment.offsetMs + (at - segment.startMs) * segment.rate);
        }
      }
      const last = segments[segments.length - 1];
      if (at >= last.stopMs) {
        return Math.max(0, last.offsetMs + (last.stopMs - last.startMs) * last.rate);
      }
      return Math.max(0, segments[0].offsetMs);
    },
    /**
     * `t` 时刻这个对象的播放头是不是在循环。画面要按素材长度取余，
     * 声音那边由 `AudioBufferSourceNode.loop` 自己处理。
     */
    loopsAt(target, tMs) {
      const state = byKey.get(String(target));
      if (!state) {
        return false;
      }
      const segments = state.openTrack
        ? [...state.track, { ...state.openTrack, stopMs: Number.POSITIVE_INFINITY }]
        : state.track;
      const at = Number(tMs) || 0;
      for (const segment of segments) {
        if (at >= segment.startMs && at < segment.stopMs) {
          return Boolean(segment.loop);
        }
      }
      const last = segments[segments.length - 1];
      return last ? Boolean(last.loop) : false;
    },
  };
}
