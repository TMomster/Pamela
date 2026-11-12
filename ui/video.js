// 舞台视频：一个 video 元素，media / audio 两条控制子轨。
// Pamela — video on the stage, with two control sub-tracks.
// 两轨是门面而非两条独立时间轴：共用一个元素，音画永远同步。

import {
  addTint,
  clampChannel,
  lookFilter,
  neutralLook,
  parseHex,
  tintMatrix,
  withLook,
} from "./filters.js";
import {
  CORNERS,
  clampDepth,
  depthScale,
  homographyInPixels,
  isFlatPose,
  projectPose,
  quadHomography,
} from "./space.js";

/** The properties a video's `transition` may carry. */
const TRANSITION_PROPERTIES = ["left", "top", "transform", "opacity", "filter"];
const transitionTimes = new WeakMap();

/** Which CSS properties each remembered frame value animates through. */
const FRAME_TRANSITIONS = {
  x: ["left"],
  y: ["top"],
  rotation: ["transform"],
  scale: ["transform"],
  // 两个转角改的是整条 `matrix3d`，位置也跟着投影中心走。
  rotateH: ["left", "top", "transform"],
  rotateV: ["left", "top", "transform"],
  // 深度同时改位置与尺寸：三者必须同一条时长，斜着退后才是连贯的一次移动。
  z: ["left", "top", "transform"],
  opacity: ["opacity"],
};

/** 四个角在自身坐标里的符号（y 向上），顺序与 `CORNERS` 一致。 */
const CORNER_SIGN = Object.freeze({
  upleft: [-1, 1],
  upright: [1, 1],
  downright: [1, -1],
  downleft: [-1, -1],
});

/** Reads a finite number, refusing anything else with the object's own name. */
function number(value, fallback, label, kind = "Video") {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${kind} 的${label}需要数字`);
  }
  return parsed;
}

/** A positive multiplier, the way `scale` reads one. */
function multiplier(value, fallback, label, kind) {
  const parsed = number(value, fallback, label, kind);
  if (parsed <= 0) {
    throw new Error(`${kind} 的${label}需要大于 0 的数字`);
  }
  return parsed;
}

/** Playback rates the webview can actually honour. */
function rate(value) {
  return Math.min(16, Math.max(0.0625, value));
}

/**
 * Builds the `Video` a script calls.
 *
 * `Video` itself fans a call out to both tracks when the call belongs to both
 * (`enable`, `play`, `pause`, `speed`, `loop`), and delegates an unambiguous
 * call to the one track that owns it (`move` to `media`, `mute` to `audio`).
 * `video.media` and `video.audio` are namespaces a script reaches through a
 * dot, the way `character.transform` already works.
 *
 * @param {object} options
 * @param {HTMLElement} options.layer The stage layer videos are drawn into.
 * @param {(path: string) => Promise<string>} options.resolveAsset
 * @param {{ width: number, height: number }} [options.size] Logical frame size.
 * @param {() => boolean} [options.isReplaying]
 * @param {() => boolean} [options.isPreviewing]
 * @param {() => boolean} [options.perspective] 舞台是否开着透视；关着时按正交
 *   投影摆放画面，深度不改变大小。
 * @param {(message: string) => void} [options.onError]
 * @returns {((args: unknown[], context: object) => object) & {
 *   clear: () => void, pauseAll: () => void, repaint: () => void }}
 */
export function createVideoFactory({
  layer,
  resolveAsset,
  size = { width: 1920, height: 1080 },
  isReplaying = () => false,
  isPreviewing = () => false,
  perspective = () => false,
  onError = () => {},
} = {}) {
  const slots = new Map();
  let counter = 0;
  let tintSeq = 0;
  const width = Number(size?.width) || 1920;
  const height = Number(size?.height) || 1080;

  const fail = (error) => onError(error instanceof Error ? error.message : String(error));
  const quiet = () => isReplaying() || isPreviewing();

  const drop = (element) => {
    if (typeof element?.remove === "function") {
      element.remove();
      return;
    }
    // childNodes is a live NodeList in the webview, not an array: spread first.
    layer?.replaceChildren?.(...[...(layer.childNodes ?? [])].filter((node) => node !== element));
  };

  /** A CSS change with a duration is a beat the script waits for. */
  const settled = (time, context) => {
    const span = quiet() ? 0 : Math.max(0, Number(time) || 0);
    if (!(span > 0)) {
      return undefined;
    }
    const promise = new Promise((resolve) => setTimeout(resolve, span));
    context.pending?.push(promise);
    return promise;
  };

  /** A numeric change with no CSS property to animate (volume, playbackRate). */
  const glide = (from, to, time, apply, context, running) => {
    const span = quiet() ? 0 : Math.max(0, Number(time) || 0);
    if (!(span > 0)) {
      apply(to);
      return undefined;
    }
    const started = Date.now();
    let timer = 0;
    let cancelled = false;
    const promise = new Promise((resolve) => {
      const step = () => {
        if (cancelled) {
          resolve();
          return;
        }
        const progress = Math.min(1, (Date.now() - started) / span);
        apply(from + (to - from) * progress);
        if (progress < 1) {
          timer = setTimeout(step, 16);
        } else {
          resolve();
        }
      };
      step();
    });
    running?.add(promise);
    promise.cancel = () => {
      cancelled = true;
      clearTimeout(timer);
      running?.delete(promise);
      resolve();
    };
    void promise.then(
      () => running?.delete(promise),
      () => running?.delete(promise),
    );
    context.pending?.push(promise);
    return promise;
  };

  /** Merges one call's transition durations with those still in flight. */
  const writeTransition = (element, patch) => {
    if (!element?.style) {
      return;
    }
    const times = { ...(transitionTimes.get(element) ?? {}) };
    for (const [property, time] of Object.entries(patch)) {
      if (time > 0) {
        times[property] = time;
      } else {
        delete times[property];
      }
    }
    transitionTimes.set(element, times);
    const running = TRANSITION_PROPERTIES.filter((property) => times[property] > 0).map(
      (property) => `${property} ${times[property]}ms linear`,
    );
    element.style.transition = running.length ? running.join(", ") : "none";
  };

  const factory = (args, context) => {
    const path = typeof args[0] === "string" ? args[0].trim() : "";
    if (!path) {
      throw new Error("Video 需要视频文件名");
    }
    const slot = context.assignee ?? `video-${(counter += 1)}`;
    slots.get(slot)?.retire();

    const element = document.createElement("video");
    element.className = "stage__video";
    element.preload = "auto";
    element.loop = false;
    element.playsInline = true;
    element.volume = 1;
    element.muted = true;
    element.playbackRate = 1;

    const frame = {
      x: 0,
      y: 0,
      z: 0,
      rotation: 0,
      // 转出 W 面的两个角：0 表示这段画面躺在舞台上、正对观众。
      rotateH: 0,
      rotateV: 0,
      scale: 1,
      opacity: 1,
      visible: false,
    };
    let look = neutralLook();
    let tint = { r: 0, g: 0, b: 0 };
    let tintId = null;
    let volume = 1;
    let speed = 1;
    let muted = true;
    let audioEnabled = true;
    let mounted = false;
    let retired = false;
    let generation = 0;
    /** Volume / rate glides still writing this element. */
    const runningGlides = new Set();
    let source = null;
    let tintSvg = null;
    /** Duration reads still waiting for metadata, ended when the video retires. */
    const pendingDurations = new Set();

    /** Video(source, volume?, loop?, mute?) — mute defaults to true. */
    volume = Math.min(1, Math.max(0, number(args[1], 1, "音量")));
    element.volume = volume;
    if (args[2] !== undefined && args[2] !== null) {
      element.loop = Boolean(args[2]);
    }
    muted = args[3] === undefined || args[3] === null ? true : Boolean(args[3]);
    syncMute();

    function syncMute() {
      element.muted = muted || !audioEnabled;
    }

    /** Creates the SVG colour matrix a tint needs, when SVG is available. */
    const ensureTint = () => {
      if (tintId || typeof document.createElementNS !== "function") {
        return tintId;
      }
      try {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", "stage__video-tint-defs");
        const defs = document.createElementNS(ns, "defs");
        const filter = document.createElementNS(ns, "filter");
        tintId = `video-tint-${(tintSeq += 1)}`;
        filter.setAttribute("id", tintId);
        const matrix = document.createElementNS(ns, "feColorMatrix");
        matrix.setAttribute("type", "matrix");
        matrix.setAttribute("values", tintMatrix(0, 0, 0));
        filter.append(matrix);
        defs.append(filter);
        svg.append(defs);
        layer?.append?.(svg);
        tintSvg = svg;
      } catch {
        // A host without SVG support keeps the four CSS filters and drops the
        // tint; it never fails the run over a colour offset.
        tintId = null;
      }
      return tintId;
    };

    const filterCss = () => {
      const tinted = tint.r || tint.g || tint.b;
      const tintCss = tinted && ensureTint() ? `url(#${tintId})` : "";
      return [tintCss, lookFilter(look)].filter(Boolean).join(" ") || "none";
    };

    /** 这段画面此刻投到舞台上的姿态（中心、四角与是否躺在 W 面里）。 */
    const poseOf = () =>
      projectPose(frame, { w: width, h: height }, { perspective: perspective() });

    /**
     * 整条 `transform`：躺着时是转+缩，转出 W 面之后是整次投影。
     *
     * 元素自己的像素与逻辑像素差一个倍率（画面按百分比铺满舞台），`matrix3d`
     * 的透视项要按那个倍率换算，所以从父元素量一次 —— 与舞台同一个做法。
     */
    const poseTransform = () => {
      const pose = poseOf();
      if (pose.flat) {
        const flat = pose.center.scale;
        return `translate(-50%, -50%) rotate(${frame.rotation}deg) scale(${frame.scale * flat})`;
      }
      const units = (Number(element.parentElement?.clientWidth) || width) / width;
      const source = CORNERS.map((handle) => {
        const [ax, ay] = CORNER_SIGN[handle];
        return { x: (ax * width) / 2, y: (-ay * height) / 2 };
      });
      const target = CORNERS.map((handle) => {
        const at = pose.corners[handle];
        return { x: at.x - pose.center.x, y: -(at.y - pose.center.y) };
      });
      const matrix = quadHomography(source, target);
      if (!matrix) {
        return "translate(-50%, -50%)";
      }
      const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = homographyInPixels(matrix, units);
      return `translate(-50%, -50%) matrix3d(${h00}, ${h10}, 0, ${h20}, ${h01}, ${h11}, 0, ${h21}, 0, 0, 1, 0, ${h02}, ${h12}, 0, ${h22})`;
    };

    const paint = () => {
      if (!element.style) {
        return;
      }
      // 深度与图片同一套：远的更小、更靠中心（见 `ui/space.js`）。
      element.style.transform = poseTransform();
      const at = poseOf().center;
      element.style.left = `${50 + (at.x / width) * 100}%`;
      element.style.top = `${50 - (at.y / height) * 100}%`;
      element.style.opacity = frame.opacity >= 1 ? "" : String(frame.opacity);
      element.style.visibility = frame.visible ? "" : "hidden";
      element.style.filter = filterCss();
    };

    /** Mounts the element once; a video stays mounted while its audio plays on. */
    const mount = () => {
      // A retired video was already removed by clear(); bringing its element
      // back would leave the stage with a player nobody can stop.
      if (mounted || retired) {
        return;
      }
      mounted = true;
      layer?.append?.(element);
      paint();
    };

    const load = () => {
      if (!source) {
        source = Promise.resolve()
          .then(() => resolveAsset(path))
          .then((url) => {
            if (!url) {
              throw new Error(`无法加载视频：${path}`);
            }
            element.src = url;
          })
          .catch((error) => {
            // A missing file is retryable: the author may add it while the
            // project stays open. Do not keep the rejected promise forever.
            source = null;
            throw error;
          });
      }
      return source;
    };

    /** Starts (or resumes) without moving the playhead. */
    const start = (fromBeginning, reveal = false) => {
      if (quiet() || retired) {
        return;
      }
      const wanted = (generation += 1);
      mount();
      if (reveal) {
        frame.visible = true;
      }
      paint();
      load()
        .then(() => {
          if (wanted !== generation || retired) {
            return;
          }
          if (fromBeginning) {
            element.currentTime = 0;
          }
          const started = element.play?.();
          if (started && typeof started.catch === "function") {
            started.catch(fail);
          }
        })
        .catch(fail);
    };

    const freeze = () => {
      generation += 1;
      element.pause?.();
    };

    const setFrame = (patch, time) => {
      const span = quiet() ? 0 : Math.max(0, Number(time) || 0);
      const running = {};
      for (const key of Object.keys(patch)) {
        for (const property of FRAME_TRANSITIONS[key] ?? []) {
          running[property] = span;
        }
      }
      writeTransition(element, running);
      Object.assign(frame, patch);
      paint();
      return settled(time, context);
    };

    const setLook = (property, value, time) => {
      look = withLook(look, property, value, "Video");
      const span = quiet() ? 0 : Math.max(0, Number(time) || 0);
      writeTransition(element, { filter: span });
      paint();
      return settled(time, context);
    };

    const setTint = (r, g, b, time) => {
      tint = { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b) };
      const id = ensureTint();
      if (id) {
        const matrix = layer?.querySelector?.(`#${id} feColorMatrix`);
        matrix?.setAttribute?.("values", tintMatrix(tint.r, tint.g, tint.b));
      }
      const span = quiet() ? 0 : Math.max(0, Number(time) || 0);
      writeTransition(element, { filter: span });
      paint();
      return settled(time, context);
    };

    const setSpeed = (value, time, absolute) => {
      const amount = absolute
        ? multiplier(value, speed, "速度", "Video")
        : multiplier(value, 1, "速度", "Video");
      const target = rate(absolute ? amount : speed * amount);
      const from = speed;
      glide(from, target, time, (at) => {
        speed = at;
        element.playbackRate = rate(at);
      }, context, runningGlides);
    };

    const setVolume = (value, time) => {
      const target = Math.min(1, Math.max(0, number(value, volume, "音量")));
      const from = volume;
      glide(from, target, time, (at) => {
        volume = at;
        element.volume = at;
      }, context, runningGlides);
    };

    /** The picture's own methods — everything `Video` delegates to `media`. */
    const mediaMethods = {
      /** Shows the picture without restarting the playhead. */
      enable() {
        mount();
        frame.visible = true;
        paint();
        return media;
      },
      /** Hides the picture; the element stays mounted so audio keeps playing. */
      disable() {
        frame.visible = false;
        paint();
        return media;
      },
      play() {
        start(false, true);
        return media;
      },
      pause() {
        freeze();
        return media;
      },
      show(time) {
        return media.alpha(1, time);
      },
      hide(time) {
        return media.alpha(0, time);
      },
      alpha(value, time) {
        setFrame({ opacity: Math.min(1, Math.max(0, number(value, 1, "透明度", "Video"))) }, time);
        return media;
      },
      move(dx, dy, dz, time) {
        const z = dz === undefined || dz === null
          ? null
          : clampDepth(frame.z + number(dz, 0, "深度", "Video"));
        return media.moveTo(
          frame.x + number(dx, 0, "横坐标", "Video"),
          frame.y + number(dy, 0, "纵坐标", "Video"),
          z,
          time,
        );
      },
      moveTo(x, y, z, time) {
        const patch = {
          x: number(x, 0, "横坐标", "Video"),
          y: number(y, 0, "纵坐标", "Video"),
        };
        if (z !== undefined && z !== null) {
          patch.z = clampDepth(number(z, 0, "深度", "Video"));
        }
        setFrame(patch, time);
        return media;
      },
      /** 深度：0 是舞台平面，正数往画面深处（更远、更小）。 */
      z(value, time) {
        setFrame({ z: clampDepth(number(value, 0, "深度", "Video")) }, time);
        return media;
      },
      /** 沿 x 轴相对移动画面：正数向右。 */
      x(dx, time) {
        return media.move(dx, 0, undefined, time);
      },
      /** 沿 y 轴相对移动画面：正数向上。 */
      y(dy, time) {
        return media.move(0, dy, undefined, time);
      },
      /** 沿 z 轴（深度）相对移动画面：正数往画面深处。 */
      z(dz, time) {
        return media.move(0, 0, dz, time);
      },
      /** 把画面的绝对 x 坐标设成 `x`。 */
      xTo(x, time) {
        return media.moveTo(x, frame.y, undefined, time);
      },
      /** 把画面的绝对 y 坐标设成 `y`。 */
      yTo(y, time) {
        return media.moveTo(frame.x, y, undefined, time);
      },
      /** 把画面放到绝对深度 `z`；这是 `z` 改名后的绝对写法。 */
      zTo(z, time) {
        return media.moveTo(frame.x, frame.y, z, time);
      },
      /** H（平轴，即 x）的相对移动：与 `x` 同一个调用。 */
      h(dh, time) {
        return media.x(dh, time);
      },
      /** V（升轴，即 y）的相对移动：与 `y` 同一个调用。 */
      v(dv, time) {
        return media.y(dv, time);
      },
      /** 把画面的绝对 H（即 x）设成 `h`。 */
      hTo(h, time) {
        return media.xTo(h, time);
      },
      /** 把画面的绝对 V（即 y）设成 `v`。 */
      vTo(v, time) {
        return media.yTo(v, time);
      },
      rotate(degrees, time) {
        return media.rotateTo(frame.rotation + number(degrees, 0, "角度", "Video"), time);
      },
      rotateTo(degrees, time) {
        setFrame({ rotation: number(degrees, 0, "角度", "Video") }, time);
        return media;
      },
      /** 沿 H 面（水平面）的圈转出画面：一侧朝观众转过来。 */
      rotateH(degrees, time) {
        setFrame({ rotateH: frame.rotateH + number(degrees, 0, "角度", "Video") }, time);
        return media;
      },
      rotateHTo(degrees, time) {
        setFrame({ rotateH: number(degrees, 0, "角度", "Video") }, time);
        return media;
      },
      /** 沿 V 面（正立面）的圈抬落：顶边朝观众倒下来。 */
      rotateV(degrees, time) {
        setFrame({ rotateV: frame.rotateV + number(degrees, 0, "角度", "Video") }, time);
        return media;
      },
      rotateVTo(degrees, time) {
        setFrame({ rotateV: number(degrees, 0, "角度", "Video") }, time);
        return media;
      },
      scale(value, time) {
        return media.scaleTo(frame.scale * multiplier(value, 1, "缩放", "Video"), time);
      },
      scaleTo(value, time) {
        setFrame({ scale: multiplier(value, 1, "缩放", "Video") }, time);
        return media;
      },
      blur(value, time) {
        setLook("blur", value, time);
        return media;
      },
      brightness(value, time) {
        setLook("brightness", value, time);
        return media;
      },
      contrast(value, time) {
        setLook("contrast", value, time);
        return media;
      },
      saturate(value, time) {
        setLook("saturate", value, time);
        return media;
      },
      rgb(dr, dg, db, time) {
        const next = addTint(tint, number(dr, 0, "红", "Video"), number(dg, 0, "绿", "Video"), number(db, 0, "蓝", "Video"));
        setTint(next.r, next.g, next.b, time);
        return media;
      },
      rgbTo(r, g, b, time) {
        setTint(number(r, 0, "红", "Video"), number(g, 0, "绿", "Video"), number(b, 0, "蓝", "Video"), time);
        return media;
      },
      hex(hex, time) {
        const { r, g, b } = parseHex(hex);
        setTint(r, g, b, time);
        return media;
      },
      speed(value, time) {
        setSpeed(value, time, false);
        return media;
      },
      speedTo(value, time) {
        setSpeed(value, time, true);
        return media;
      },
    };

    /** The sound's own methods — everything `Video` delegates to `audio`. */
    const audioMethods = {
      /** Enables the audio track (a script's own `mute` setting still applies). */
      enable() {
        audioEnabled = true;
        syncMute();
        return audio;
      },
      /** Silences the audio track without touching the picture. */
      disable() {
        audioEnabled = false;
        syncMute();
        return audio;
      },
      play() {
        start(false);
        return audio;
      },
      pause() {
        freeze();
        return audio;
      },
      /** `mute()` with no argument means true, `mute(false)` unmutes. */
      mute(value) {
        muted = value === undefined || value === null ? true : Boolean(value);
        syncMute();
        return audio;
      },
      volume(value, time) {
        setVolume(value, time);
        return audio;
      },
      loop() {
        element.loop = true;
        return audio;
      },
      once() {
        element.loop = false;
        return audio;
      },
      speed(value, time) {
        setSpeed(value, time, false);
        return audio;
      },
      speedTo(value, time) {
        setSpeed(value, time, true);
        return audio;
      },
      /** The track's length in milliseconds, or 0 when metadata never arrives. */
      duration() {
        return new Promise((resolve) => {
          if (Number.isFinite(element.duration) && element.duration > 0) {
            resolve(Math.round(element.duration * 1000));
            return;
          }
          let done = false;
          // Each call owns its timer: a second `duration()` must not clear the
          // first one's timeout, or one of the two would never resolve.
          let timer = 0;
          const finish = (ms) => {
            if (done) {
              return;
            }
            done = true;
            clearTimeout(timer);
            element.removeEventListener?.("loadedmetadata", onMeta);
            element.removeEventListener?.("durationchange", onMeta);
            pendingDurations.delete(finish);
            resolve(ms);
          };
          const onMeta = () => finish(Math.round((element.duration || 0) * 1000));
          pendingDurations.add(finish);
          element.addEventListener?.("loadedmetadata", onMeta);
          element.addEventListener?.("durationchange", onMeta);
          timer = setTimeout(() => finish(0), 2000);
        });
      },
    };

    const media = { kind: "VideoMedia", ...mediaMethods };
    const audio = { kind: "VideoAudio", ...audioMethods };

    // A call on the Video itself either belongs to both tracks or is one the
    // other track has no opinion about. Either way there is one implementation.
    const video = {
      kind: "Video",
      // 变量名就是舞台认这段画面的键：`crood(true)` 用它去取下面的姿态。
      slot,
      media,
      audio,
      /** Restarts from the beginning and enables both tracks. */
      enable() {
        media.enable();
        audio.enable();
        start(true);
        return video;
      },
      /** Stops, hides the picture and silences the audio track. */
      disable() {
        freeze();
        media.disable();
        audio.disable();
        return video;
      },
      /** Plays from the current position. */
      play() {
        start(false, true);
        return video;
      },
      /** Pauses without moving the playhead. */
      pause() {
        freeze();
        return video;
      },
      loop() {
        element.loop = true;
        return video;
      },
      once() {
        element.loop = false;
        return video;
      },
      speed(value, time) {
        setSpeed(value, time, false);
        return video;
      },
      speedTo(value, time) {
        setSpeed(value, time, true);
        return video;
      },
      show(time) {
        media.show(time);
        return video;
      },
      hide(time) {
        media.hide(time);
        return video;
      },
      alpha(value, time) {
        media.alpha(value, time);
        return video;
      },
      move(dx, dy, dz, time) {
        media.move(dx, dy, dz, time);
        return video;
      },
      moveTo(x, y, z, time) {
        media.moveTo(x, y, z, time);
        return video;
      },
      /** 深度：0 是舞台平面，正数往画面深处（更远、更小）。 */
      z(value, time) {
        media.z(value, time);
        return video;
      },
      x(dx, time) {
        media.x(dx, time);
        return video;
      },
      y(dy, time) {
        media.y(dy, time);
        return video;
      },
      xTo(x, time) {
        media.xTo(x, time);
        return video;
      },
      yTo(y, time) {
        media.yTo(y, time);
        return video;
      },
      zTo(z, time) {
        media.zTo(z, time);
        return video;
      },
      /** H（平轴，即 x）的相对移动：与 `x` 同一个调用。 */
      h(dh, time) {
        media.h(dh, time);
        return video;
      },
      /** V（升轴，即 y）的相对移动：与 `y` 同一个调用。 */
      v(dv, time) {
        media.v(dv, time);
        return video;
      },
      /** 把画面的绝对 H（即 x）设成 `h`。 */
      hTo(h, time) {
        media.hTo(h, time);
        return video;
      },
      /** 把画面的绝对 V（即 y）设成 `v`。 */
      vTo(v, time) {
        media.vTo(v, time);
        return video;
      },
      rotate(degrees, time) {
        media.rotate(degrees, time);
        return video;
      },
      rotateTo(degrees, time) {
        media.rotateTo(degrees, time);
        return video;
      },
      scale(value, time) {
        media.scale(value, time);
        return video;
      },
      scaleTo(value, time) {
        media.scaleTo(value, time);
        return video;
      },
      blur(value, time) {
        media.blur(value, time);
        return video;
      },
      brightness(value, time) {
        media.brightness(value, time);
        return video;
      },
      contrast(value, time) {
        media.contrast(value, time);
        return video;
      },
      saturate(value, time) {
        media.saturate(value, time);
        return video;
      },
      rgb(dr, dg, db, time) {
        media.rgb(dr, dg, db, time);
        return video;
      },
      rgbTo(r, g, b, time) {
        media.rgbTo(r, g, b, time);
        return video;
      },
      hex(hex, time) {
        media.hex(hex, time);
        return video;
      },
      mute(value) {
        audio.mute(value);
        return video;
      },
      volume(value, time) {
        audio.volume(value, time);
        return video;
      },
      duration() {
        return audio.duration();
      },
    };

    const stopGlides = () => {
      for (const glide of [...runningGlides]) {
        glide.cancel?.();
      }
      runningGlides.clear();
    };

    const retire = () => {
      retired = true;
      generation += 1;
      stopGlides();
      for (const finish of [...pendingDurations]) {
        finish(0);
      }
      pendingDurations.clear();
      element.pause?.();
      element.removeAttribute?.("src");
      element.load?.();
      if (tintSvg) {
        tintSvg.remove?.();
        tintSvg = null;
        tintId = null;
      }
      drop(element);
      slots.delete(slot);
    };
    slots.set(slot, {
      frame,
      retire,
      // 透视开关一改，已经摆好的画面要按新投影重画一次。
      paint,
      pause: () => {
        freeze();
        stopGlides();
      },
    });

    paint();
    return video;
  };

  /** Stops and removes every video, for a stage being cleared. */
  factory.clear = () => {
    for (const entry of [...slots.values()]) {
      entry.retire();
    }
    slots.clear();
    layer?.replaceChildren?.();
  };

  /** Freezes every video without removing it, for a stopped run. */
  factory.pauseAll = () => {
    for (const entry of slots.values()) {
      entry.pause();
    }
  };

  /** 按当前的投影重画每一段画面；`stage.perspective()` 切换时调用。 */
  factory.repaint = () => {
    for (const entry of slots.values()) {
      entry.paint?.();
    }
  };

  /**
   * 一段视频此刻的姿态，供舞台的坐标轴覆盖层读（见 `ui/axes.js`）。
   * 交回副本：覆盖层只该看，不该改到画面自己的 frame。
   */
  factory.axisPose = (slot) => {
    const entry = slots.get(slot);
    return entry?.frame ? { ...entry.frame } : null;
  };

  return factory;
}
