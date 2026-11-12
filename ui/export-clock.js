// 可替换的演出时钟：实时演出用真实时钟，离屏逐帧导出用虚拟时钟。
// Pamela — an injectable clock: wall time for playback, virtual ticks for export.
//
// 舞台与对话框里所有 setTimeout / rAF / Date.now / Math.random 都要改走这里。
// 两种后端实现同一组接口，因此实时演出的代码路径与今天保持一致，只有导出
// 模式换成虚拟时钟；`tick()` 推进一帧，到期的 Promise 才会 resolve。

/** 时间刻度：30000 ticks 相当于 1 秒，30fps 时每帧恰好 1000 ticks。 */
export const EXPORT_TIMESCALE = 30000;
/** 默认导出帧率。 */
export const DEFAULT_FPS = 30;

/** 固定种子的 PRNG：粒子与路径 ID 在导出时必须可复现。 */
export function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 虚拟时钟。时间只由 `tick()` / `tickMs()` 推进，不受真实时间影响。
 *
 * `wait(ms <= 0)` 返回 `undefined` 而不是 Promise，与 `stage.js` 的
 * `settled(time)` 一致：零耗时动作不该往 `context.pending` 里塞一个
 * 还要多等一轮事件循环的空 Promise。
 *
 * @param {object} [options]
 * @param {number} [options.fps] 帧率，决定每帧推进多少 ticks。
 * @param {number} [options.timescale] 每秒 ticks 数。
 * @param {number} [options.seed] 随机种子。
 */
export function createVirtualClock({
  fps = DEFAULT_FPS,
  timescale = EXPORT_TIMESCALE,
  seed = 1,
} = {}) {
  const ticksPerSecond = Math.max(1, Math.round(Number(timescale) || EXPORT_TIMESCALE));
  const framesPerSecond = Math.max(1, Number(fps) || DEFAULT_FPS);
  const frameTicks = Math.max(1, Math.round(ticksPerSecond / framesPerSecond));
  const ticksPerMs = ticksPerSecond / 1000;
  const random = seededRandom(seed);

  let ticks = 0;
  let sequence = 0;
  const timers = [];
  const frames = [];

  const now = () => ticks / ticksPerMs;

  /** 注册一个定时等待，返回可取消的 handle。 */
  function schedule(ms) {
    const span = Number(ms);
    const delayTicks =
      Number.isFinite(span) && span > 0 ? Math.round(span * ticksPerMs) : 0;
    if (delayTicks <= 0) {
      return { promise: Promise.resolve(), cancel() {}, done: true, cancelled: false };
    }
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const handle = {
      promise,
      due: ticks + delayTicks,
      sequence: (sequence += 1),
      done: false,
      cancelled: false,
      resolve,
      cancel: null,
    };
    handle.cancel = () => {
      handle.cancelled = true;
      handle.done = true;
    };
    timers.push(handle);
    return handle;
  }

  /** 定时等待；供 `runtime.sleep` 与各处的 `settled` / `glide` 使用。 */
  const wait = (ms) => {
    const span = Number(ms);
    if (!Number.isFinite(span) || span <= 0) {
      return undefined;
    }
    return schedule(span).promise;
  };

  /** 等待下一帧；供 eased / followPath / 粒子循环使用。 */
  function scheduleFrame() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const handle = { promise, done: false, resolve, cancel: null };
    handle.cancel = () => {
      handle.done = true;
    };
    frames.push(handle);
    return handle;
  }

  const frame = () => scheduleFrame().promise;

  /** 推进 `stepTicks`，resolve 所有到期定时器与本帧回调。 */
  function tickBy(stepTicks) {
    ticks += Math.max(0, Math.round(stepTicks));

    const due = timers
      .filter((handle) => !handle.done && !handle.cancelled && handle.due <= ticks)
      .sort((a, b) => a.due - b.due || a.sequence - b.sequence);
    // resolve 是同步的：解释器的续体排在微任务队列，由帧循环随后 flush。
    for (const handle of due) {
      handle.done = true;
      handle.resolve();
    }
    for (let i = timers.length - 1; i >= 0; i -= 1) {
      if (timers[i].done || timers[i].cancelled) {
        timers.splice(i, 1);
      }
    }

    const pendingFrames = frames.splice(0, frames.length);
    for (const handle of pendingFrames) {
      if (handle.done) {
        continue;
      }
      handle.done = true;
      handle.resolve();
    }
    return now();
  }

  /** 推进一帧；返回推进后的毫秒时间。 */
  const tick = () => tickBy(frameTicks);
  /** 推进任意毫秒，用于测试或非整帧对齐的等待。 */
  const tickMs = (ms) => tickBy((Number(ms) || 0) * ticksPerMs);

  /** 取消 `schedule` / `scheduleFrame` 返回的 handle。 */
  const cancel = (handle) => handle?.cancel?.();

  /** 仍在等待的定时器与帧回调数量；与"解释器已结束"一起决定导出何时收尾。 */
  const pending = () =>
    timers.filter((handle) => !handle.done && !handle.cancelled).length +
    frames.filter((handle) => !handle.done).length;

  return {
    now,
    wait,
    schedule,
    frame,
    scheduleFrame,
    tick,
    tickMs,
    cancel,
    random,
    pending,
    timescale: ticksPerSecond,
    fps: framesPerSecond,
    frameMs: frameTicks / ticksPerMs,
  };
}

/**
 * 真实时钟后端：接口与虚拟时钟一致，实时演出注入它即可保持现有行为。
 * `tick()` 是 no-op —— 时间由平台自己推进。
 */
export function createRealClock() {
  const timers = new Set();
  const frames = new Set();

  const now = () => Date.now();

  function schedule(ms) {
    const span = Number(ms);
    if (!Number.isFinite(span) || span <= 0) {
      return { promise: Promise.resolve(), cancel() {}, done: true, cancelled: false };
    }
    let handle;
    const promise = new Promise((resolve) => {
      const id = setTimeout(() => {
        timers.delete(handle);
        handle.done = true;
        resolve();
      }, span);
      handle = {
        promise: null,
        done: false,
        cancelled: false,
        id,
        cancel: null,
      };
      handle.cancel = () => {
        clearTimeout(id);
        timers.delete(handle);
        handle.cancelled = true;
        handle.done = true;
      };
      timers.add(handle);
    });
    // executor 执行期间 `promise` 还在 TDZ，只能在外部回填。
    handle.promise = promise;
    return handle;
  }

  const wait = (ms) => {
    const span = Number(ms);
    if (!Number.isFinite(span) || span <= 0) {
      return undefined;
    }
    return schedule(span).promise;
  };

  function scheduleFrame() {
    let handle;
    const promise = new Promise((resolve) => {
      const run = () => {
        frames.delete(handle);
        handle.done = true;
        resolve();
      };
      const id =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(run)
          : setTimeout(run, 16);
      handle = { promise: null, done: false, id, cancel: null };
      handle.cancel = () => {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(handle.id);
        } else {
          clearTimeout(handle.id);
        }
        frames.delete(handle);
        handle.done = true;
      };
      frames.add(handle);
    });
    handle.promise = promise;
    return handle;
  }

  const frame = () => scheduleFrame().promise;
  const cancel = (handle) => handle?.cancel?.();
  const pending = () => timers.size + frames.size;

  return {
    now,
    wait,
    schedule,
    frame,
    scheduleFrame,
    tick: now,
    tickMs: now,
    cancel,
    random: Math.random,
    pending,
    timescale: 1000,
    fps: 60,
    frameMs: 1000 / 60,
  };
}

/** 只清空微任务队列；纯逻辑测试用，不引入真实等待。 */
export async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/**
 * 让解释器跑到下一个 await 点：`tick()` 只 resolve Promise，续体要等微任务，
 * 而 `readScene` / 资源缓存这类宿主回调可能还排在宏任务队列里。
 * 这里用的是真实的 0ms 定时器，但不影响虚拟时间的取值。
 */
export async function flushTasks(rounds = 8) {
  await flushMicrotasks(rounds);
  await new Promise((resolve) => setTimeout(resolve, 0));
}
