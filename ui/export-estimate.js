// 按剧本内容推算视频时长：用真解释器跑一遍，只记时间线、不画一帧。
// Pamela — how long the script runs, without rendering anything.
//
// 导出时长由两部分里更长的一个决定：时间线最后一个事件的结束时刻，和演出真正
// 走到的时刻（最后一句台词的停留不产生新的画面事件，但视频要把它读完）。
// 两者都只有在脚本跑完之后才知道，所以这里用一个「会自己跳到下一个事件」的
// 时钟把演出快进一遍：不按帧推进，代价只与 await 的次数成正比。
//
// 时钟跳到的时刻与整帧对齐，与 `export-clock.js` 的虚拟时钟取整方式一致，
// 因此估出来的时长与真导出相差不到一帧。

import {
  DEFAULT_FPS,
  EXPORT_TIMESCALE,
  flushMicrotasks,
  seededRandom,
} from "./export-clock.js";
import { createExportPerformance } from "./export-performance.js";
import { createStateCursor, createTimeline, timelineDuration } from "./export-timeline.js";

export const DEFAULT_ESTIMATE = Object.freeze({
  fps: DEFAULT_FPS,
  timescale: EXPORT_TIMESCALE,
  /** 事件上限：只用来防止脚本把自己跑飞，正常剧本远到不了。 */
  maxSteps: 200_000,
  /** 连续空转上限：解释器可能停在 include 的真实读盘上。 */
  maxStalls: 512,
});

/** 毫秒时长换算成帧数；至少一帧，空剧本也仍然是一个可播放的文件。 */
export function framesFor(ms, fps) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  const rate = Math.max(1, Number(fps) || DEFAULT_FPS);
  return Math.max(1, Math.round(seconds * rate));
}

/** 让出宏任务队列，等真实 I/O（读 include 的场景文件）回话。 */
function yieldToTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 会自己跳到下一个事件的时钟：接口与 `createVirtualClock` 一致，但时间只由
 * `advance()` 推进，且一次跨到最早的到期时刻（对齐整帧）。
 *
 * @param {object} [options]
 * @param {number} [options.fps]
 * @param {number} [options.timescale]
 * @param {number} [options.seed]
 */
export function createAdvancingClock({
  fps = DEFAULT_ESTIMATE.fps,
  timescale = DEFAULT_ESTIMATE.timescale,
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

  const wait = (ms) => {
    const span = Number(ms);
    if (!Number.isFinite(span) || span <= 0) {
      return undefined;
    }
    return schedule(span).promise;
  };

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
  const cancel = (handle) => handle?.cancel?.();

  const pending = () =>
    timers.filter((handle) => !handle.done && !handle.cancelled).length +
    frames.filter((handle) => !handle.done).length;

  /** 跳到下一个到期事件并 resolve 它；没有待办时返回 false。 */
  function advance() {
    let due = null;
    for (const handle of timers) {
      if (handle.done || handle.cancelled) {
        continue;
      }
      if (due === null || handle.due < due) {
        due = handle.due;
      }
    }
    const waitingFrame = frames.some((handle) => !handle.done);
    if (due === null && !waitingFrame) {
      return false;
    }

    if (due === null) {
      ticks += frameTicks;
    } else {
      // 与虚拟时钟一致：事件落在它到期后的第一个帧边界上。
      ticks = Math.max(ticks + frameTicks, Math.ceil(due / frameTicks) * frameTicks);
    }

    const ready = timers
      .filter((handle) => !handle.done && !handle.cancelled && handle.due <= ticks)
      .sort((a, b) => a.due - b.due || a.sequence - b.sequence);
    for (const handle of ready) {
      handle.done = true;
      handle.resolve();
    }
    for (let i = timers.length - 1; i >= 0; i -= 1) {
      if (timers[i].done || timers[i].cancelled) {
        timers.splice(i, 1);
      }
    }
    const waiting = frames.splice(0, frames.length);
    for (const handle of waiting) {
      if (handle.done) {
        continue;
      }
      handle.done = true;
      handle.resolve();
    }
    return true;
  }

  return {
    now,
    wait,
    schedule,
    frame,
    scheduleFrame,
    /** 时间只这样前进：一跨就是下一个事件。没有 `tick()`，因为没有「下一帧」。 */
    advance,
    cancel,
    random,
    pending,
    timescale: ticksPerSecond,
    fps: framesPerSecond,
    frameMs: frameTicks / ticksPerMs,
  };
}

/**
 * 跑一遍入口脚本，回答它有多长。
 *
 * 不画帧、不解码图片、不编码：只给解释器一个会快进的时钟和一个录制舞台，
 * 让时间线自己长出来。脚本出错时仍回答已经走到的那一段，并带上 `error`。
 *
 * @param {object} options
 * @param {string} options.source 入口脚本原文
 * @param {string} [options.path] 入口脚本的项目相对路径
 * @param {(path: string) => Promise<string>} [options.read] 读 include 的场景
 * @param {number} [options.fps]
 * @param {number} [options.timescale]
 * @param {number} [options.maxSteps]
 * @param {number} [options.maxStalls]
 * @param {() => boolean} [options.isStopped] 调用方随时叫停
 * @param {(labels: string[]) => Promise<number>} [options.chooseStrategy]
 *   选择支怎么走；与真导出用同一个策略，估出来的时长才对得上
 * @param {(session: object) => Promise<unknown>} [options.performance] 测试注入
 * @returns {Promise<{ ms: number, frames: number, timelineMs: number, clockMs: number,
 *   complete: boolean, error: string|null }>}
 */
export async function estimateDuration({
  source = "",
  path = "",
  read = async () => "",
  fps = DEFAULT_ESTIMATE.fps,
  timescale = DEFAULT_ESTIMATE.timescale,
  maxSteps = DEFAULT_ESTIMATE.maxSteps,
  maxStalls = DEFAULT_ESTIMATE.maxStalls,
  isStopped = null,
  chooseStrategy = null,
  performance = null,
} = {}) {
  const clock = createAdvancingClock({ fps, timescale });
  const timeline = createTimeline();
  const session = {
    config: { fps, timescale },
    clock,
    timeline,
    cursor: createStateCursor(timeline),
    assets: new Map(),
    renderer: null,
  };

  const drive = performance ?? createExportPerformance({ source, path, read, chooseStrategy });

  let settled = false;
  let failure = null;
  const running = Promise.resolve()
    .then(() => drive(session))
    .then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        failure = error instanceof Error ? error : new Error(String(error));
      },
    );
  // 脚本可能长时间不结束；不 await，调用方随时可以停，停了就把 Promise 放着。
  void running;

  let steps = 0;
  let stalls = 0;
  for (;;) {
    await flushMicrotasks(2);
    if (settled && clock.pending() === 0) {
      break;
    }
    if (isStopped?.() || steps >= maxSteps) {
      break;
    }
    steps += 1;
    if (clock.advance()) {
      stalls = 0;
      continue;
    }
    if (settled) {
      break;
    }
    // 没有待办事件：解释器多半停在 include 的真实读盘上，让出宏任务等它。
    if (stalls >= maxStalls) {
      break;
    }
    stalls += 1;
    await yieldToTasks();
  }

  const timelineMs = timelineDuration(timeline);
  const clockMs = clock.now();
  const ms = Math.max(timelineMs, clockMs);
  return {
    ms,
    frames: framesFor(ms, fps),
    timelineMs,
    clockMs,
    complete: settled && !failure && clock.pending() === 0,
    error: failure ? failure.message : null,
  };
}
