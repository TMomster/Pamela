// 演出时间线纯逻辑测试：事件求值、覆盖语义、增量游标与参考实现一致。
// Timeline evaluation, override rules, and cursor/reference agreement.

import assert from "node:assert/strict";
import test from "node:test";

import {
  addSet,
  addTween,
  createStateCursor,
  createTimeline,
  stateAt,
  timelineDuration,
} from "../export-timeline.js";

test("a set only takes effect from its timestamp on", () => {
  const timeline = createTimeline();
  addSet(timeline, 100, "dialogue", { text: "你好", visible: true });
  assert.deepEqual(stateAt(timeline, 99), {});
  assert.deepEqual(stateAt(timeline, 100), {
    dialogue: { text: "你好", visible: true },
  });
});

test("a tween interpolates linearly and clamps at both ends", () => {
  const timeline = createTimeline();
  addSet(timeline, 0, "character:hero", { opacity: 0 });
  addTween(timeline, 0, 1000, "character:hero", "opacity", 0, 1);
  assert.deepEqual(stateAt(timeline, -50), {});
  assert.equal(stateAt(timeline, 0)["character:hero"].opacity, 0);
  const at250 = stateAt(timeline, 250)["character:hero"].opacity;
  assert.ok(Math.abs(at250 - 0.25) < 1e-9);
  assert.equal(stateAt(timeline, 1000)["character:hero"].opacity, 1);
  assert.equal(stateAt(timeline, 5000)["character:hero"].opacity, 1);
});

test("a later tween on the same property overrides the earlier one", () => {
  const timeline = createTimeline();
  addTween(timeline, 0, 1000, "background", "opacity", 0, 1);
  addTween(timeline, 500, 1500, "background", "opacity", 0.2, 0.4);
  // At 500 the second tween starts at its own `from`.
  assert.ok(Math.abs(stateAt(timeline, 500).background.opacity - 0.2) < 1e-9);
  assert.ok(Math.abs(stateAt(timeline, 1000).background.opacity - 0.3) < 1e-9);
  assert.equal(stateAt(timeline, 1500).background.opacity, 0.4);
});

test("a set interrupts an in-flight tween, like a new CSS value would", () => {
  const timeline = createTimeline();
  addTween(timeline, 0, 1000, "background", "opacity", 0, 1);
  addSet(timeline, 500, "background", { opacity: 0.5 });
  assert.ok(Math.abs(stateAt(timeline, 300).background.opacity - 0.3) < 1e-9);
  assert.equal(stateAt(timeline, 700).background.opacity, 0.5);
  assert.equal(stateAt(timeline, 1200).background.opacity, 0.5);
});

test("properties on the same target keep independent time ranges", () => {
  const timeline = createTimeline();
  addTween(timeline, 0, 1000, "character:hero", "x", 0, 100);
  addTween(timeline, 500, 1500, "character:hero", "y", 0, 200);
  const state = stateAt(timeline, 750);
  assert.equal(state["character:hero"].x, 75);
  assert.equal(state["character:hero"].y, 50);
});

test("quantize supports typewriter character counts and GIF frame numbers", () => {
  const timeline = createTimeline();
  addTween(timeline, 0, 100, "dialogue", "revealed", 0, 10, { quantize: "floor" });
  assert.equal(stateAt(timeline, 0).dialogue.revealed, 0);
  assert.equal(stateAt(timeline, 39).dialogue.revealed, 3);
  assert.equal(stateAt(timeline, 100).dialogue.revealed, 10);
});

test("a zero-length tween degenerates into a set", () => {
  const timeline = createTimeline();
  addTween(timeline, 200, 200, "background", "opacity", 0, 0.7);
  assert.deepEqual(stateAt(timeline, 199), {});
  assert.equal(stateAt(timeline, 200).background.opacity, 0.7);
  assert.equal(timelineDuration(timeline), 200);
});

test("duration is the end of the last event", () => {
  const timeline = createTimeline();
  addSet(timeline, 10, "dialogue", { text: "a" });
  addTween(timeline, 10, 900, "background", "opacity", 0, 1);
  addSet(timeline, 1200, "dialogue", { text: "b" });
  assert.equal(timelineDuration(timeline), 1200);
});

test("the incremental cursor agrees with stateAt at every sampled instant", () => {
  const timeline = createTimeline();
  addSet(timeline, 0, "background", { path: "bg.png", opacity: 1, x: 0 });
  addTween(timeline, 0, 1000, "background", "x", 0, 100);
  addTween(timeline, 300, 1300, "background", "opacity", 1, 0);
  addSet(timeline, 700, "dialogue", { text: "第一句", revealed: 0 });
  addTween(timeline, 700, 1500, "dialogue", "revealed", 0, 12, { quantize: "floor" });
  addTween(timeline, 900, 1800, "background", "x", 100, -100);
  addSet(timeline, 1100, "background", { path: "bg2.png" });
  addSet(timeline, 1600, "dialogue", { text: "第二句" });

  const cursor = createStateCursor(timeline);
  for (let t = 0; t <= 2000; t += 7) {
    assert.deepEqual(cursor.at(t), stateAt(timeline, t), `分歧于 t=${t}`);
  }
});

test("the cursor sees events appended while the export is running", () => {
  const timeline = createTimeline();
  const cursor = createStateCursor(timeline);
  assert.deepEqual(cursor.at(0), {});

  addSet(timeline, 0, "dialogue", { text: "第一句" });
  addTween(timeline, 0, 100, "dialogue", "revealed", 0, 5, { quantize: "floor" });
  assert.equal(cursor.at(0).dialogue.text, "第一句");
  assert.equal(cursor.at(50).dialogue.revealed, 2);

  // 解释器推进到 50ms 时才登记这一句，游标必须能看见。
  addSet(timeline, 50, "dialogue", { text: "第二句" });
  assert.equal(cursor.at(50).dialogue.text, "第二句");
  assert.equal(cursor.at(100).dialogue.revealed, 5);
});

test("the cursor refuses to travel backwards", () => {
  const cursor = createStateCursor(createTimeline());
  cursor.at(100);
  assert.throws(() => cursor.at(50), /只能向前/);
});

test("invalid targets and non-numeric tweens are rejected", () => {
  const timeline = createTimeline();
  assert.throws(() => addSet(timeline, 0, "__proto__", { x: 1 }), /原型键/);
  assert.throws(() => addSet(timeline, 0, "", { x: 1 }), /非空字符串/);
  assert.throws(
    () => addTween(timeline, 0, 100, "background", "tint", { r: 0 }, { r: 1 }),
    /数值属性/,
  );
});

test("乱序登记的事件仍按 (时刻, seq) 顺序生效", () => {
  const timeline = createTimeline();
  addSet(timeline, 300, "dialogue", { text: "晚" });
  addSet(timeline, 100, "dialogue", { text: "早" });
  // 同一时刻时，后登记（seq 更大）的覆盖前者。
  addSet(timeline, 100, "dialogue", { text: "早且后登记" });
  const cursor = createStateCursor(timeline);
  assert.deepEqual(cursor.at(50), {});
  assert.equal(cursor.at(100).dialogue.text, "早且后登记");
  assert.deepEqual(cursor.at(100), stateAt(timeline, 100));
  assert.equal(cursor.at(300).dialogue.text, "晚");
  assert.deepEqual(cursor.at(300), stateAt(timeline, 300));
});

/**
 * 旧实现的朴素版本：每帧对全部历史事件 filter + sort。只活在测试里，
 * 用来证明增量改造（已扫描指针 + 有序队列）是逐帧等价的变换。
 */
function legacyCursor(timeline) {
  const state = {};
  const active = new Map();
  const consumed = new Set();
  let last = -Infinity;
  const keyOf = (target, prop) => target + "\u0000" + prop;
  const put = (target, prop, value) => {
    if (!state[target]) {
      state[target] = {};
    }
    state[target][prop] = value;
  };
  const eventKey = (event) => (event.kind === "set" ? event.t : event.t0);
  const quantize = (value, mode) =>
    mode === "floor"
      ? Math.floor(value + 1e-9)
      : mode === "round"
        ? Math.round(value)
        : value;
  const tweenAt = (event, at) => {
    if (at >= event.t1) {
      return event.quantize ? quantize(event.to, event.quantize) : event.to;
    }
    const progress = Math.min(1, Math.max(0, (at - event.t0) / (event.t1 - event.t0)));
    const value = event.from + (event.to - event.from) * event.ease(progress);
    return event.quantize ? quantize(value, event.quantize) : value;
  };
  return {
    at(t) {
      const at = Number.isFinite(Number(t)) ? Number(t) : 0;
      if (at < last) {
        throw new Error("时间线游标只能向前推进");
      }
      last = at;
      const arrived = timeline.events
        .filter((event) => !consumed.has(event.seq) && eventKey(event) <= at)
        .sort((a, b) => eventKey(a) - eventKey(b) || a.seq - b.seq);
      for (const event of arrived) {
        consumed.add(event.seq);
        if (event.kind === "set") {
          for (const [prop, value] of Object.entries(event.patch)) {
            active.delete(keyOf(event.target, prop));
            put(event.target, prop, value);
          }
        } else {
          const key = keyOf(event.target, event.prop);
          active.delete(key);
          active.set(key, event);
        }
      }
      for (const [key, event] of [...active]) {
        put(event.target, event.prop, tweenAt(event, at));
        if (at >= event.t1) {
          active.delete(key);
        }
      }
      const copy = {};
      for (const [target, props] of Object.entries(state)) {
        copy[target] = { ...props };
      }
      return copy;
    },
  };
}

test("边跑边追加、乱序排期（含迟到事件）：增量游标与旧算法逐帧一致", () => {
  let seed = 20261109;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const timeline = createTimeline();
  const cursor = createStateCursor(timeline);
  const legacy = legacyCursor(timeline);
  for (let step = 0; step < 240; step += 1) {
    const t = step * 10;
    const count = Math.floor(rand() * 4);
    for (let i = 0; i < count; i += 1) {
      // 时刻可能早于当前 t（迟到的过去事件）或远在未来：两种都要与旧算法同解。
      const when = Math.max(0, t + Math.floor((rand() - 0.35) * 400));
      const target = `character:h${Math.floor(rand() * 3)}`;
      if (rand() < 0.5) {
        addSet(timeline, when, target, { path: `p${step}.png`, opacity: rand() });
      } else {
        addTween(timeline, when, when + 50 + Math.floor(rand() * 200), target, "x", 0, 100, {
          quantize: rand() < 0.3 ? "floor" : null,
        });
      }
    }
    assert.deepEqual(cursor.at(t), legacy.at(t), `分歧于 t=${t}`);
  }
});

test("真实排期（事件不早于登记时刻）与全量重放逐帧一致", () => {
  let seed = 771103;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const timeline = createTimeline();
  const cursor = createStateCursor(timeline);
  for (let step = 0; step < 180; step += 1) {
    const t = step * 10;
    for (let i = 0, count = Math.floor(rand() * 4); i < count; i += 1) {
      const when = t + Math.floor(rand() * 300);
      const target = `character:h${Math.floor(rand() * 4)}`;
      if (rand() < 0.5) {
        addSet(timeline, when, target, { path: `p${step}.png`, opacity: rand() });
      } else {
        addTween(timeline, when, when + 40 + Math.floor(rand() * 160), target, "x", 0, 100, {
          quantize: rand() < 0.3 ? "floor" : null,
        });
      }
    }
    assert.deepEqual(cursor.at(t), stateAt(timeline, t), `分歧于 t=${t}`);
  }
});

test("大量历史事件下增量游标仍与全量重放逐点一致", () => {
  const timeline = createTimeline();
  for (let i = 0; i < 1200; i += 1) {
    addSet(timeline, i * 5, `character:h${i % 8}`, { path: `p${i}.png`, x: i });
    if (i % 3 === 0) {
      addTween(timeline, i * 5, i * 5 + 120, `character:h${i % 8}`, "opacity", 0, 1, {
        quantize: "floor",
      });
    }
  }
  const cursor = createStateCursor(timeline);
  for (let t = 0; t <= 6000; t += 97) {
    assert.deepEqual(cursor.at(t), stateAt(timeline, t), `分歧于 t=${t}`);
  }
});
