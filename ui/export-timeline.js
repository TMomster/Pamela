// 演出时间线：把舞台状态变化登记成带时间戳的事件，再对任意 t 求值。
// Pamela — a recorded performance timeline, evaluable at any instant.
//
// 离屏逐帧导出的核心是"给定 t 得到一帧画面"。这里不碰 DOM、不碰 Canvas：
// 只维护 `{ [target]: { [prop]: value } }` 的数值状态，由渲染后端去画。
//
// 事件有两种：
//   set   —— 从 t 起生效的离散赋值（显隐、换图、台词文本）
//   tween —— [t0, t1] 内线性插值（现有 CSS transition 全是 linear）
// 同一 target+prop 的后来者覆盖前者，与 `stage.js` 的 `writeTransition`
// "每次只改自己命名的属性、保留其它在飞属性" 的语义一致。

const LINEAR = (progress) => progress;

/** @returns {number} 有限数，非法值回落到 fallback。 */
function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 拒绝会污染对象原型的键；target 是脚本可见的对象名。 */
function checkTarget(target) {
  if (typeof target !== "string" || !target) {
    throw new Error("时间线的 target 需要非空字符串");
  }
  if (target === "__proto__" || target === "prototype" || target === "constructor") {
    throw new Error("时间线的 target 不能是原型键");
  }
}

function setProp(state, target, prop, value) {
  if (!state[target]) {
    state[target] = {};
  }
  state[target][prop] = value;
}

function cloneState(state) {
  const copy = {};
  for (const [target, props] of Object.entries(state)) {
    copy[target] = { ...props };
  }
  return copy;
}

/** 事件的排序键：set 用生效时刻，tween 用起始时刻。 */
function sortKey(event) {
  return event.kind === "set" ? event.t : event.t0;
}

function orderedEvents(timeline) {
  return timeline.events
    .slice()
    .sort((a, b) => sortKey(a) - sortKey(b) || a.seq - b.seq);
}

/** 插值并按 quantize 取整；打字机字数、GIF 帧号需要整数。 */
function tweenValue(event, t) {
  if (t >= event.t1) {
    return event.quantize ? quantize(event.to, event.quantize) : event.to;
  }
  const progress = Math.min(1, Math.max(0, (t - event.t0) / (event.t1 - event.t0)));
  const value = event.from + (event.to - event.from) * event.ease(progress);
  return event.quantize ? quantize(value, event.quantize) : value;
}

function quantize(value, mode) {
  if (mode === "floor") {
    return Math.floor(value + 1e-9);
  }
  if (mode === "round") {
    return Math.round(value);
  }
  return value;
}

/**
 * 构建期容器。`events` 只通过 addSet / addTween 追加，求值函数不修改它。
 * @returns {{ events: object[], sequence: number }}
 */
export function createTimeline() {
  return { events: [], sequence: 0 };
}

/** 登记一次离散赋值。 */
export function addSet(timeline, t, target, patch) {
  checkTarget(target);
  if (!patch || typeof patch !== "object") {
    throw new Error("时间线的 set 需要一个 patch 对象");
  }
  timeline.events.push({
    kind: "set",
    t: finite(t, 0),
    target,
    patch: { ...patch },
    seq: (timeline.sequence += 1),
  });
  return timeline;
}

/**
 * 登记一段线性插值。`t1 <= t0` 时退化为 set，避免除零。
 * @param {object} [options]
 * @param {(p: number) => number} [options.ease] 缓动函数，默认线性。
 * @param {"floor"|"round"|null} [options.quantize] 取整方式。
 */
export function addTween(
  timeline,
  t0,
  t1,
  target,
  prop,
  from,
  to,
  options = {},
) {
  checkTarget(target);
  const start = finite(t0, 0);
  const end = finite(t1, start);
  if (end <= start) {
    return addSet(timeline, start, target, { [prop]: to });
  }
  if (!Number.isFinite(Number(from)) || !Number.isFinite(Number(to))) {
    throw new Error("时间线的 tween 目前只支持数值属性");
  }
  if (typeof prop !== "string" || !prop) {
    throw new Error("时间线的 tween 需要属性名");
  }
  timeline.events.push({
    kind: "tween",
    t0: start,
    t1: end,
    target,
    prop,
    from: Number(from),
    to: Number(to),
    ease: typeof options.ease === "function" ? options.ease : LINEAR,
    quantize: options.quantize ?? null,
    seq: (timeline.sequence += 1),
  });
  return timeline;
}

/** 最后一个事件结束的时刻（毫秒）；导出时长至少到这里。 */
export function timelineDuration(timeline) {
  let end = 0;
  for (const event of timeline.events) {
    end = Math.max(end, event.kind === "set" ? event.t : event.t1);
  }
  return end;
}

/**
 * 纯参考实现：按时间顺序重放所有事件，返回 t 时刻的状态快照。
 * 帧循环请用 `createStateCursor`，两者结果一致（测试里有逐点对照）。
 */
export function stateAt(timeline, t) {
  const at = finite(t, 0);
  const state = {};
  for (const event of orderedEvents(timeline)) {
    if (event.kind === "set") {
      if (event.t > at) {
        continue;
      }
      for (const [prop, value] of Object.entries(event.patch)) {
        setProp(state, event.target, prop, value);
      }
      continue;
    }
    if (at < event.t0) {
      continue;
    }
    setProp(state, event.target, event.prop, tweenValue(event, at));
  }
  return state;
}

/**
 * 增量求值游标：t 单调递增，每帧只处理新到期的事件与仍在飞的 tween。
 *
 * 演出是边跑边登记事件的（解释器被虚拟时钟逐帧推进），所以不能像静态
 * 时间线那样在创建时快照一次事件列表。早期实现每帧对全部历史事件做
 * `filter + sort`，长剧本会退化成 O(帧数 × 事件数)；这里改成「已扫描指针
 * + 有序待处理队列」：每帧只吸收上次之后新增的事件、从队头弹出已到期的，
 * 成本与当帧事件数成正比。队列始终按 (sortKey, seq) 升序，与 `orderedEvents`
 * 的顺序完全一致，因此输出与全量重放逐位相同。
 */
export function createStateCursor(timeline) {
  const state = {};
  const active = new Map();
  /** 已扫描但未到期的事件，按 (sortKey, seq) 升序。 */
  const pending = [];
  let scanned = 0;
  let last = -Infinity;

  const keyOf = (target, prop) => target + "\u0000" + prop;

  /** 顺序登记时直接尾部追加；乱序事件从尾部回退到正确位置。 */
  function enqueue(event) {
    const key = sortKey(event);
    let index = pending.length;
    while (index > 0) {
      const prev = pending[index - 1];
      const order = sortKey(prev) - key || prev.seq - event.seq;
      if (order <= 0) {
        break;
      }
      index -= 1;
    }
    pending.splice(index, 0, event);
  }

  return {
    /** @returns {object} 独立的状态快照，渲染后端只读。 */
    at(t) {
      const at = finite(t, 0);
      if (at < last) {
        throw new Error("时间线游标只能向前推进");
      }
      last = at;

      // 只吸收上次扫描之后追加的事件；已扫描但未到期的仍留在 pending 里。
      while (scanned < timeline.events.length) {
        enqueue(timeline.events[scanned]);
        scanned += 1;
      }

      let arrived = 0;
      while (arrived < pending.length && sortKey(pending[arrived]) <= at) {
        const event = pending[arrived];
        arrived += 1;
        if (event.kind === "set") {
          for (const [prop, value] of Object.entries(event.patch)) {
            active.delete(keyOf(event.target, prop));
            setProp(state, event.target, prop, value);
          }
        } else {
          const key = keyOf(event.target, event.prop);
          active.delete(key);
          active.set(key, event);
        }
      }
      if (arrived > 0) {
        pending.splice(0, arrived);
      }

      for (const [key, event] of [...active]) {
        setProp(state, event.target, event.prop, tweenValue(event, at));
        if (at >= event.t1) {
          active.delete(key);
        }
      }
      return cloneState(state);
    },
  };
}
