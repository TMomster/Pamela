// 导出时的粒子特效：录制参数、按固定步长推进、画进离屏画布。
// Pamela — the built-in rain / snow effects inside the exported movie.
//
// 舞台上的 Effect 是一块 <canvas>，用 requestAnimationFrame 按墙钟推进，粒子
// 初始位置来自 Math.random。导出不能这样：同一份脚本必须每次得到同一部成片。
// 所以这里
// - 录制时只记参数（种类、缩放、尺寸、密度、速度、透明度、是否在放），
// - 渲染时按 1/60 秒的固定步长推进，随机数用按对象名播种的 PRNG，
// - 画面直接画进主画布，不再另开画布。
//
// 粒子布局与舞台不等于同一张随机图，但运动规律、密度与观感一致；这是
// 「可以复现」与「逐像素相同」之间必然要选的一边。

import { EFFECT_KINDS } from "./effect.js";
import { addSet, addTween } from "./export-timeline.js";

/** 与 `effect.js` 的 BASE_COUNT 同量级：密度 1 时的粒子数。 */
const BASE_COUNT = 240;

/** 推进用的固定步长：与帧率无关，换 fps 不会改变粒子轨迹。 */
const STEP_SECONDS = 1 / 60;

/** 一帧最多补多少步，避免时间跳跃时卡住。 */
const MAX_STEPS = 600;

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

function multiplier(value, fallback, label) {
  const parsed = number(value, fallback, label);
  if (parsed <= 0) {
    throw new Error(`Effect 的${label}需要大于 0 的数字`);
  }
  return parsed;
}

function clamped(value, fallback, label) {
  return Math.min(1, Math.max(0, number(value, fallback, label)));
}

/** 由名字与序号播种的 PRNG：同一份脚本、同一个对象永远得到同一串随机数。 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashName(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 录制 Effect 的脚本对象：只写时间线，不碰画布。
 *
 * @param {object} options
 * @param {{now: () => number, wait: (ms: number) => Promise<void>}} options.clock
 * @param {object} options.timeline 时间线，状态都写在这里
 */
export function createEffectRecorder({ clock, timeline }) {
  let counter = 0;

  return {
    effect(args, context) {
      const type = typeof args?.[0] === "string" ? args[0].trim().toLowerCase() : "";
      if (!EFFECT_KINDS.includes(type)) {
        throw new Error("Effect 需要特效名：rain 或 snow");
      }
      const assignee = context?.assignee ? String(context.assignee) : `effect-${(counter += 1)}`;
      const target = `effect:${assignee}`;

      const state = {
        kind: type,
        scale: multiplier(args[1], 1, "缩放"),
        size: multiplier(args[2], 1, "尺寸"),
        density: multiplier(args[3], 1, "密度"),
        speed: multiplier(args[4], 1, "速度"),
        opacity: clamped(args[5], 1, "透明度"),
        visible: false,
        playing: false,
        /** 每次 enable() 加一：渲染端看到它变了就重新撒一次粒子。 */
        epoch: 0,
      };

      /** 数值属性按时间插值，其余直接落地；与画面记录同一套语义。 */
      function commit(patch, ms = 0) {
        const start = clock.now();
        const span = Number(ms) > 0 ? Number(ms) : 0;
        if (span > 0) {
          for (const [key, value] of Object.entries(patch)) {
            if (typeof value === "number" && typeof state[key] === "number") {
              addTween(timeline, start, start + span, target, key, state[key], value);
            } else {
              addSet(timeline, start, target, { [key]: value });
            }
          }
          context?.pending?.push(clock.wait(span));
        } else {
          addSet(timeline, start, target, patch);
        }
        Object.assign(state, patch);
      }

      /** 相对 / 绝对一对方法共用的乘数逻辑。 */
      function relative(key, label, value, time, absolute) {
        const amount = absolute ? multiplier(value, state[key], label) : multiplier(value, 1, label);
        commit({ [key]: absolute ? amount : state[key] * amount }, time);
      }

      const effect = {
        kind: "Effect",
        enable() {
          commit({ epoch: state.epoch + 1, opacity: 1, visible: true, playing: true });
          return effect;
        },
        disable() {
          commit({ visible: false, playing: false });
          return effect;
        },
        play() {
          commit({ visible: true, playing: true });
          return effect;
        },
        pause() {
          commit({ playing: false });
          return effect;
        },
        show(time) {
          return effect.alpha(1, time);
        },
        hide(time) {
          return effect.alpha(0, time);
        },
        alpha(value, time) {
          commit({ opacity: clamped(value, 1, "透明度") }, time);
          return effect;
        },
        scale(value, time) {
          relative("scale", "缩放", value, time, false);
          return effect;
        },
        scaleTo(value, time) {
          relative("scale", "缩放", value, time, true);
          return effect;
        },
        size(value, time) {
          relative("size", "尺寸", value, time, false);
          return effect;
        },
        sizeTo(value, time) {
          relative("size", "尺寸", value, time, true);
          return effect;
        },
        density(value, time) {
          relative("density", "密度", value, time, false);
          return effect;
        },
        densityTo(value, time) {
          relative("density", "密度", value, time, true);
          return effect;
        },
        speed(value, time) {
          relative("speed", "速度", value, time, false);
          return effect;
        },
        speedTo(value, time) {
          relative("speed", "速度", value, time, true);
          return effect;
        },
      };

      addSet(timeline, clock.now(), target, { ...state });
      return effect;
    },
  };
}

/**
 * 粒子层的模拟与绘制。
 *
 * `draw(ctx, target, state, t)` 只在导出时被调用，`t` 单调递增；回退或
 * `epoch` 变化时重新播种。没有状态的方法，粒子数按密度补齐 / 截断。
 *
 * @param {object} options
 * @param {number} [options.width]
 * @param {number} [options.height]
 */
export function createEffectLayer({ width = 1920, height = 1080 } = {}) {
  /** 每个 `effect:` 目标一份模拟。 */
  const layers = new Map();

  function spawn(sim, count) {
    while (sim.particles.length < count) {
      sim.particles.push({
        x: sim.random() * width,
        y: sim.random() * height,
        z: 0.4 + sim.random() * 0.6,
        phase: sim.random() * Math.PI * 2,
      });
    }
    if (sim.particles.length > count) {
      sim.particles.length = count;
    }
  }

  function advance(sim, kind, speed) {
    const rate = STEP_SECONDS * speed;
    for (const particle of sim.particles) {
      if (kind === "rain") {
        particle.y += (760 + particle.z * 620) * rate;
        particle.x -= (130 + particle.z * 90) * rate;
      } else {
        particle.y += (55 + particle.z * 85) * rate;
        particle.phase += rate * 1.6;
        particle.x += Math.sin(particle.phase) * 22 * rate;
      }
      if (particle.y > height + 30 || particle.x < -40) {
        particle.y = -30;
        particle.x = sim.random() * width;
      }
    }
  }

  function drawParticles(ctx, sim, kind, state) {
    const size = Math.max(0.01, Number(state.size) || 1);
    if (kind === "rain") {
      ctx.strokeStyle = "rgba(198, 218, 255, 0.62)";
      ctx.lineWidth = 1.6 * size;
      ctx.beginPath();
      for (const particle of sim.particles) {
        const length = (14 + particle.z * 22) * size;
        ctx.moveTo(particle.x, particle.y);
        ctx.lineTo(particle.x - length * 0.22, particle.y + length);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
      for (const particle of sim.particles) {
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, (1.2 + particle.z * 2.2) * size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  return {
    draw(ctx, target, state, t) {
      const kind = state?.kind === "snow" ? "snow"
        : state?.kind === "rain" ? "rain"
        : null;
      if (!kind || state.visible === false) {
        return;
      }
      const at = Number(t) || 0;
      const epoch = Number(state.epoch) || 0;
      let sim = layers.get(target);
      if (!sim || sim.kind !== kind || sim.epoch !== epoch || at < sim.lastT) {
        sim = { kind, epoch, random: seededRandom(hashName(target) + epoch), particles: [], lastT: at };
        layers.set(target, sim);
      }

      const density = Number(state.density) || 1;
      spawn(sim, Math.max(1, Math.round(BASE_COUNT * density)));

      if (state.playing !== false) {
        sim.acc = (sim.acc ?? 0) + Math.max(0, (at - sim.lastT) / 1000);
        let steps = 0;
        while (sim.acc >= STEP_SECONDS && steps < MAX_STEPS) {
          advance(sim, kind, Number(state.speed) || 1);
          sim.acc -= STEP_SECONDS;
          steps += 1;
        }
      }
      sim.lastT = at;

      const scale = Math.max(0.001, Number(state.scale) || 1);
      ctx.save();
      ctx.globalAlpha = Math.min(1, Math.max(0, state.opacity === undefined ? 1 : Number(state.opacity)));
      ctx.translate(width / 2, height / 2);
      ctx.scale(scale, scale);
      ctx.translate(-width / 2, -height / 2);
      drawParticles(ctx, sim, kind, state);
      ctx.restore();
    },
  };
}
