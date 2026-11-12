// 分项计时纯逻辑测试：不改变同步性、异常也计时、快照换算。
// Export metrics: sync/async transparency, error paths, snapshot math.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createExportMetrics,
  createNullMetrics,
  METRIC_STAGES,
} from "../export-metrics.js";

test("call 对同步函数返回同步值，对异步函数返回其结果", async () => {
  let now = 0;
  const metrics = createExportMetrics({ clock: () => now });
  const sync = metrics.call("tint", () => {
    now += 3;
    return 42;
  });
  assert.equal(sync, 42);
  assert.ok(!(sync instanceof Promise), "同步路径不能被包装成 Promise");
  const asyncValue = await metrics.call("seek", async () => {
    now += 7;
    return "ok";
  });
  assert.equal(asyncValue, "ok");
  assert.equal(metrics.snapshot().stages.tint.ms, 3);
  assert.equal(metrics.snapshot().stages.seek.ms, 7);
});

test("抛错与 reject 也会记下耗时", async () => {
  let now = 0;
  const metrics = createExportMetrics({ clock: () => now });
  assert.throws(
    () =>
      metrics.call("tint", () => {
        now += 5;
        throw new Error("x");
      }),
    /x/,
  );
  await assert.rejects(
    () =>
      metrics.call("append", async () => {
        now += 11;
        throw new Error("y");
      }),
    /y/,
  );
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.stages.tint.ms, 5);
  assert.equal(snapshot.stages.tint.calls, 1);
  assert.equal(snapshot.stages.append.ms, 11);
  assert.equal(snapshot.stages.append.calls, 1);
});

test("snapshot 换算每帧均值，未知阶段被忽略", () => {
  const metrics = createExportMetrics({ clock: () => 0 });
  metrics.add("encode", 20);
  metrics.add("whatever", 999);
  metrics.add("encode", 10);
  const snapshot = metrics.snapshot({ frames: 10, elapsedMs: 250 });
  assert.equal(snapshot.avgFrameMs, 25);
  assert.equal(snapshot.stages.encode.ms, 30);
  assert.equal(snapshot.stages.encode.calls, 2);
  assert.equal(snapshot.stages.whatever, undefined);
  assert.deepEqual(METRIC_STAGES, ["render", "seek", "tint", "encode", "append"]);
});

test("createNullMetrics 不改变同步性且快照为 null", () => {
  const metrics = createNullMetrics();
  assert.equal(metrics.call("render", () => "plain"), "plain");
  assert.equal(metrics.snapshot({ frames: 1, elapsedMs: 1 }), null);
});

test("enabled=false 时完全不读时钟", () => {
  const metrics = createExportMetrics({
    clock: () => {
      throw new Error("不该读时钟");
    },
    enabled: false,
  });
  assert.equal(metrics.call("tint", () => 1), 1);
  assert.equal(metrics.snapshot(), null);
});

test("note 记录非时间类计数并出现在快照里", () => {
  const metrics = createExportMetrics({ clock: () => 0 });
  metrics.note("reuse");
  metrics.note("reuse", 2);
  const snapshot = metrics.snapshot({ frames: 10, elapsedMs: 100 });
  assert.equal(snapshot.counters.reuse, 3);
  assert.equal(snapshot.stages.render.ms, 0, "计数不混进耗时");
});

test("createNullMetrics 的 note 是安全的空操作", () => {
  const metrics = createNullMetrics();
  metrics.note("reuse");
  assert.equal(metrics.snapshot(), null);
});
