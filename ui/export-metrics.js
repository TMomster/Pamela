// 导出分项计时：把一帧的墙钟时间拆成取帧 / 调色 / 编码 / 写盘几段。
// Pamela — per-stage timing for the offline exporter.
//
// 只记录、不改变任何渲染行为：`call()` 对同步函数返回同步值，对异步函数
// 返回 Promise，因此渲染后端的同步 / 异步路径都保持原样；异常路径也会计时。
// 这是 `docs/2026-11-08.md` §2.3 P1-2「先测，再决定改不改」的那个「测」。

/** 计时阶段；`render` 是整帧渲染（含 seek / 调色 / 绘制），不是分项之和。 */
export const METRIC_STAGES = Object.freeze(["render", "seek", "tint", "encode", "append"]);

/** 浏览器用高精度时钟，Node 测试可注入假时钟。 */
function defaultClock() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * @param {object} [options]
 * @param {() => number} [options.clock] 返回毫秒
 * @param {boolean} [options.enabled] 关闭后不读时钟、不改变调用形态
 */
export function createExportMetrics({ clock = defaultClock, enabled = true } = {}) {
  const totals = Object.create(null);
  const counts = Object.create(null);
  /** 非时间类计数（如跳过的静止帧数）。 */
  const counters = Object.create(null);
  for (const stage of METRIC_STAGES) {
    totals[stage] = 0;
    counts[stage] = 0;
  }

  function record(stage, ms) {
    if (!Object.prototype.hasOwnProperty.call(totals, stage)) {
      return;
    }
    totals[stage] += Math.max(0, Number(ms) || 0);
    counts[stage] += 1;
  }

  return {
    now: clock,

    /** 手动累加一次耗时（append 在独立 Promise 链上时用）。 */
    add: record,

    /** 记录一个非时间类计数；禁用计时时也不产生副作用。 */
    note(name, amount = 1) {
      if (!enabled) {
        return;
      }
      counters[name] = (counters[name] || 0) + amount;
    },

    /**
     * 量一次调用，原样返回结果：同步函数仍同步返回，异步函数仍返回 Promise。
     * 抛错 / reject 时也会记下耗时，不让异常路径悄悄消失。
     */
    call(stage, fn) {
      if (!enabled) {
        return fn();
      }
      const start = clock();
      const finish = () => record(stage, clock() - start);
      let result;
      try {
        result = fn();
      } catch (error) {
        finish();
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result.then(
          (value) => {
            finish();
            return value;
          },
          (error) => {
            finish();
            throw error;
          },
        );
      }
      finish();
      return result;
    },

    /** @returns {object|null} 各阶段累计毫秒与调用次数、每帧平均毫秒。 */
    snapshot({ frames = 0, elapsedMs = 0 } = {}) {
      if (!enabled) {
        return null;
      }
      const stages = {};
      for (const stage of METRIC_STAGES) {
        stages[stage] = { ms: totals[stage], calls: counts[stage] };
      }
      const frameCount = Math.max(0, Number(frames) || 0);
      const total = Math.max(0, Number(elapsedMs) || 0);
      return {
        elapsedMs: total,
        frames: frameCount,
        avgFrameMs: frameCount > 0 ? total / frameCount : 0,
        stages,
        counters: { ...counters },
      };
    },
  };
}

/** 关闭计时时的零开销替身：不引入 Promise，也不读时钟。 */
export function createNullMetrics() {
  return {
    now: () => 0,
    add: () => {},
    note: () => {},
    call: (_stage, fn) => fn(),
    snapshot: () => null,
  };
}
