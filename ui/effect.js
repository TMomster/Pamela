// 舞台内置特效：rain 下雨、snow 下雪，两套粒子天气。
// Pamela — built-in stage effects drawn by the engine, not loaded from assets.
// 特效不从 assets 读文件，第一个参数就是特效名；画面由引擎自己画在 canvas 上。

/** 目前内置的特效名。引擎自己实现，新增一个只要在这里与 draw / tick 里加一支。 */
export const EFFECT_KINDS = Object.freeze(["rain", "snow"]);

/** A browser with no animation frame callback still draws through a timer. */
const nextFrame =
  typeof requestAnimationFrame === "function"
    ? (run) => requestAnimationFrame(() => run())
    : (run) => setTimeout(run, 16);

/** Reads a finite number, refusing anything else with the object's own name. */
function number(value, fallback, label) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Effect 的${label}需要数字`);
  }
  return parsed;
}

/** A positive multiplier; zero would flatten the whole effect. */
function multiplier(value, fallback, label) {
  const parsed = number(value, fallback, label);
  if (parsed <= 0) {
    throw new Error(`Effect 的${label}需要大于 0 的数字`);
  }
  return parsed;
}

/** Opacity is clamped rather than refused, like a volume is. */
function clamped(value, fallback, label, low, high) {
  const parsed = number(value, fallback, label);
  return Math.min(high, Math.max(low, parsed));
}

/**
 * Builds the `Effect` a script calls.
 *
 * One canvas per effect, appended to the stage's effect layer. The factory owns
 * the frame loops so `clear()` can stop every one of them: a canvas whose loop
 * outlives its run would keep drawing rain over the next scene.
 *
 * @param {object} options
 * @param {HTMLElement} options.layer The stage layer effects are drawn into.
 * @param {{ width: number, height: number }} [options.size] Logical frame size.
 * @param {() => boolean} [options.isReplaying]
 * @param {() => boolean} [options.isPreviewing]
 * @param {(message: string) => void} [options.onError]
 * @param {() => number} [options.random] Injected so a test can pin the particles.
 * @returns {((args: unknown[], context: object) => object) & {
 *   clear: () => void, pauseAll: () => void }}
 */
export function createEffectFactory({
  layer,
  size = { width: 1920, height: 1080 },
  isReplaying = () => false,
  isPreviewing = () => false,
  onError = () => {},
  random = Math.random,
} = {}) {
  /** Rebuilding a variable replaces its effect instead of stacking a second one. */
  const slots = new Map();
  let counter = 0;

  const width = Number(size?.width) || 1920;
  const height = Number(size?.height) || 1080;
  const BASE_COUNT = 240;
  // A density the script asks for is clamped here: `1e9` would otherwise build
  // hundreds of millions of particle objects and freeze the editor.
  const MAX_PARTICLES = 4000;

  const fail = (error) => onError(error instanceof Error ? error.message : String(error));

  /** Drops one canvas out of the layer without rebuilding the others. */
  const drop = (canvas) => {
    if (typeof canvas?.remove === "function") {
      canvas.remove();
      return;
    }
    // childNodes is a live NodeList in the webview, not an array: spread first.
    layer?.replaceChildren?.(...[...(layer.childNodes ?? [])].filter((node) => node !== canvas));
  };

  /** A change that takes time is a beat in the script, so it answers a promise. */
  const tween = (from, to, time, apply, context, running) => {
    const span = isReplaying() || isPreviewing() ? 0 : Math.max(0, Number(time) || 0);
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

  const factory = (args, context) => {
    const type = typeof args[0] === "string" ? args[0].trim().toLowerCase() : "";
    if (!EFFECT_KINDS.includes(type)) {
      throw new Error("Effect 需要特效名：rain 或 snow");
    }
    const slot = context.assignee ?? `effect-${(counter += 1)}`;
    slots.get(slot)?.retire();

    const canvas = document.createElement("canvas");
    canvas.className = "stage__effect";
    canvas.width = width;
    canvas.height = height;
    const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

    // The state lives in the closure, never on the script-facing object: `size`
    // and `density` are methods, so a field of the same name would hide them.
    const state = {
      enabled: false,
      playing: false,
      speed: 1,
      particleSize: 1,
      density: 1,
      scale: 1,
      opacity: 1,
    };
    let particles = [];
    let frameId = 0;
    let lastTime = 0;
    let retired = false;
    /** Tweens still writing this effect, so retiring can stop them. */
    const runningTweens = new Set();

    /** Keeps the count in step with `density`, preserving positions. */
    const syncParticles = () => {
      const wanted = Math.min(
        MAX_PARTICLES,
        Math.max(1, Math.round(BASE_COUNT * state.density)),
      );
      while (particles.length < wanted) {
        particles.push({
          x: random() * width,
          y: random() * height,
          z: 0.4 + random() * 0.6,
          phase: random() * Math.PI * 2,
        });
      }
      if (particles.length > wanted) {
        particles.length = wanted;
      }
    };

    const draw = () => {
      if (!ctx) {
        return;
      }
      ctx.clearRect(0, 0, width, height);
      if (type === "rain") {
        ctx.strokeStyle = "rgba(198, 218, 255, 0.62)";
        ctx.lineWidth = 1.6 * state.particleSize;
        ctx.beginPath();
        for (const p of particles) {
          const length = (14 + p.z * 22) * state.particleSize;
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - length * 0.22, p.y + length);
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
        for (const p of particles) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, (1.2 + p.z * 2.2) * state.particleSize, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    /** One frame: advance by wall time so a dropped frame does not slow the effect. */
    const tick = () => {
      if (retired || !state.playing || !state.enabled) {
        return;
      }
      const at = Date.now();
      const dt = lastTime ? Math.min(0.05, (at - lastTime) / 1000) : 0;
      lastTime = at;
      const rate = dt * state.speed;
      for (const p of particles) {
        if (type === "rain") {
          p.y += (760 + p.z * 620) * rate;
          p.x -= (130 + p.z * 90) * rate;
        } else {
          p.y += (55 + p.z * 85) * rate;
          p.phase += rate * 1.6;
          p.x += Math.sin(p.phase) * 22 * rate;
        }
        if (p.y > height + 30 || p.x < -40) {
          p.y = -30;
          p.x = random() * width;
        }
      }
      draw();
      frameId = nextFrame(tick);
    };

    const stopLoop = () => {
      state.playing = false;
      lastTime = 0;
      if (frameId) {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(frameId);
        } else if (typeof clearTimeout === "function") {
          clearTimeout(frameId);
        }
      }
      frameId = 0;
    };

    const startLoop = () => {
      if (retired || !state.enabled || state.playing || isReplaying() || isPreviewing()) {
        return;
      }
      state.playing = true;
      lastTime = 0;
      frameId = nextFrame(tick);
    };

    const paint = () => {
      if (!canvas.style) {
        return;
      }
      canvas.style.opacity = state.opacity >= 1 ? "" : String(state.opacity);
      canvas.style.transform = `translate(-50%, -50%) scale(${state.scale})`;
      draw();
    };

    const stopTweens = () => {
      for (const tween of [...runningTweens]) {
        tween.cancel?.();
      }
      runningTweens.clear();
    };

    const retire = () => {
      retired = true;
      stopLoop();
      stopTweens();
      drop(canvas);
      slots.delete(slot);
    };
    slots.set(slot, {
      retire,
      pause: () => {
        stopLoop();
        stopTweens();
      },
    });

    // Constructor options, in the order PARAM_SPECS.Effect declares:
    // Effect("rain", scale, size, density, speed, alpha).
    state.scale = multiplier(args[1], 1, "缩放");
    state.particleSize = multiplier(args[2], 1, "尺寸");
    state.density = multiplier(args[3], 1, "密度");
    state.speed = multiplier(args[4], 1, "速度");
    state.opacity = clamped(args[5], 1, "透明度", 0, 1);
    syncParticles();

    /** A relative / absolute pair, all written through the same tween. */
    const relative = (key, label, value, time, absolute) => {
      const amount = absolute ? multiplier(value, state[key], label) : multiplier(value, 1, label);
      const target = absolute ? amount : state[key] * amount;
      const from = state[key];
      tween(from, target, time, (at) => {
        state[key] = at;
        if (key === "density") {
          syncParticles();
        }
        if (key === "scale") {
          paint();
        } else {
          draw();
        }
      }, context, runningTweens);
    };

    const effect = {
      kind: "Effect",
      /** Mounts the canvas, resets the particles and starts playing. */
      enable() {
        // A retired effect (its variable was rebuilt, or the stage was cleared)
        // must not draw a canvas the factory no longer knows how to stop.
        if (retired) {
          return effect;
        }
        particles = [];
        syncParticles();
        state.opacity = 1;
        if (!state.enabled) {
          state.enabled = true;
          layer?.append?.(canvas);
        }
        paint();
        startLoop();
        return effect;
      },
      /** Unmounts the canvas and stops the frame loop. */
      disable() {
        stopLoop();
        state.enabled = false;
        drop(canvas);
        return effect;
      },
      /** Resumes from wherever the animation was paused. */
      play() {
        if (retired || isReplaying() || isPreviewing()) {
          return effect;
        }
        if (!state.enabled) {
          state.enabled = true;
          layer?.append?.(canvas);
          paint();
        }
        startLoop();
        return effect;
      },
      /** Freezes the particles without resetting them. */
      pause() {
        stopLoop();
        return effect;
      },
      /** Fades the picture out to 0, over `time` milliseconds. */
      hide(time) {
        return effect.alpha(0, time);
      },
      /** Fades the picture back in to 1, over `time` milliseconds. */
      show(time) {
        return effect.alpha(1, time);
      },
      /** Sets the canvas opacity, clamped to 0–1. */
      alpha(value, time) {
        const to = clamped(value, 1, "透明度", 0, 1);
        const from = state.opacity;
        tween(from, to, time, (at) => {
          state.opacity = at;
          paint();
        }, context, runningTweens);
        return effect;
      },
      /** Scales the whole particle picture relative to its current size. */
      scale(value, time) {
        relative("scale", "缩放", value, time, false);
        return effect;
      },
      /** Scales the whole particle picture to an absolute multiplier. */
      scaleTo(value, time) {
        relative("scale", "缩放", value, time, true);
        return effect;
      },
      /** Scales each particle relative to its current size. */
      size(value, time) {
        relative("particleSize", "尺寸", value, time, false);
        return effect;
      },
      /** Scales each particle to an absolute multiplier. */
      sizeTo(value, time) {
        relative("particleSize", "尺寸", value, time, true);
        return effect;
      },
      /** Changes the number of particles relative to the current density. */
      density(value, time) {
        relative("density", "密度", value, time, false);
        return effect;
      },
      /** Sets the particle density to an absolute multiplier. */
      densityTo(value, time) {
        relative("density", "密度", value, time, true);
        return effect;
      },
      /** Changes the animation rate relative to its current rate (1.0 = normal). */
      speed(value, time) {
        relative("speed", "速度", value, time, false);
        return effect;
      },
      /** Sets the animation rate to an absolute rate (1.0 = normal). */
      speedTo(value, time) {
        relative("speed", "速度", value, time, true);
        return effect;
      },
    };

    try {
      paint();
    } catch (error) {
      // A frame the webview cannot paint must not take the stage down with it.
      fail(error);
    }
    return effect;
  };

  /** Stops and removes every effect, for a stage being cleared. */
  factory.clear = () => {
    for (const entry of [...slots.values()]) {
      entry.retire();
    }
    slots.clear();
    layer?.replaceChildren?.();
  };

  /** Freezes every effect without removing it, for a stopped run. */
  factory.pauseAll = () => {
    for (const entry of slots.values()) {
      entry.pause();
    }
  };

  return factory;
}
