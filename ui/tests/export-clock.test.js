// 虚拟时钟纯逻辑测试：定时器、帧回调、确定性随机，以及驱动解释器。
// Virtual clock: timers, frames, deterministic randomness, and interpreter drive.

import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../pamela.js";
import {
  createRealClock,
  createVirtualClock,
  flushMicrotasks,
  flushTasks,
  EXPORT_TIMESCALE,
  DEFAULT_FPS,
} from "../export-clock.js";

test("a virtual clock starts at zero and advances one exact frame per tick", () => {
  const clock = createVirtualClock();
  assert.equal(clock.timescale, EXPORT_TIMESCALE);
  assert.equal(clock.fps, DEFAULT_FPS);
  assert.equal(clock.now(), 0);
  assert.ok(Math.abs(clock.frameMs - 1000 / 30) < 1e-9);
  clock.tick();
  assert.ok(Math.abs(clock.now() - 1000 / 30) < 1e-9);
  clock.tick();
  assert.ok(Math.abs(clock.now() - 2000 / 30) < 1e-9);
});

test("parallel waits keep their own deadlines and resolve in due order", async () => {
  const clock = createVirtualClock();
  const order = [];
  clock.wait(50).then(() => order.push("short"));
  clock.wait(100).then(() => order.push("long"));
  assert.equal(clock.pending(), 2);

  clock.tick();
  await flushMicrotasks();
  assert.deepEqual(order, []);

  clock.tick();
  await flushMicrotasks();
  assert.deepEqual(order, ["short"]);

  clock.tick();
  clock.tick();
  await flushMicrotasks();
  assert.deepEqual(order, ["short", "long"]);
  assert.equal(clock.pending(), 0);
});

test("wait(0) returns undefined, matching settled() in the stage", () => {
  const clock = createVirtualClock();
  assert.equal(clock.wait(0), undefined);
  assert.equal(clock.wait(-10), undefined);
  assert.equal(clock.wait(Number.NaN), undefined);
  assert.equal(clock.pending(), 0);
});

test("cancelling a scheduled wait keeps it from resolving", async () => {
  const clock = createVirtualClock();
  let fired = false;
  const handle = clock.schedule(50);
  handle.promise.then(() => {
    fired = true;
  });
  assert.equal(clock.pending(), 1);
  clock.cancel(handle);
  clock.tick();
  clock.tick();
  await flushMicrotasks();
  assert.equal(fired, false);
  assert.equal(clock.pending(), 0);
});

test("frame() resolves on the next tick and can be cancelled", async () => {
  const clock = createVirtualClock();
  let fired = false;
  clock.frame().then(() => {
    fired = true;
  });
  const cancelled = clock.scheduleFrame();
  clock.cancel(cancelled);
  assert.equal(clock.pending(), 1);
  clock.tick();
  await flushMicrotasks();
  assert.equal(fired, true);
  assert.equal(clock.pending(), 0);
});

test("random is reproducible for a seed and differs across seeds", () => {
  const a = createVirtualClock({ seed: 42 });
  const b = createVirtualClock({ seed: 42 });
  const c = createVirtualClock({ seed: 43 });
  const first = [a.random(), a.random(), a.random()];
  assert.deepEqual(first, [b.random(), b.random(), b.random()]);
  assert.notDeepEqual(first, [c.random(), c.random(), c.random()]);
  for (const value of first) {
    assert.ok(value >= 0 && value < 1);
  }
});

test("the real clock exposes the same interface", async () => {
  const clock = createRealClock();
  assert.equal(typeof clock.now(), "number");
  assert.equal(clock.wait(0), undefined);
  await clock.wait(1);

  const handle = clock.schedule(1000);
  assert.equal(clock.pending(), 1);
  clock.cancel(handle);
  assert.equal(clock.pending(), 0);

  // Node has no requestAnimationFrame, so the 16 ms fallback is exercised.
  let framed = false;
  const framePromise = clock.frame().then(() => {
    framed = true;
  });
  await framePromise;
  assert.equal(framed, true);
});

test("runtime.sleep drives interpret through a wait() statement", async () => {
  const clock = createVirtualClock();
  const running = run("wait(100)\nx = 7", { sleep: clock.wait });
  await flushTasks();
  assert.equal(clock.pending(), 1, "the script is parked on its 100 ms wait");

  for (let i = 0; i < 4; i += 1) {
    clock.tick();
    await flushTasks();
  }

  const result = await running;
  assert.equal(result.error, undefined);
  assert.notEqual(result.stopped, true);
  assert.equal(clock.pending(), 0);
});

test("a cue hold lets the script proceed while its group timer keeps running", async () => {
  const clock = createVirtualClock();
  const running = run("cue(50) {\n  wait(120)\n}\nx = 7", { sleep: clock.wait });
  await flushTasks();
  assert.equal(clock.pending(), 2, "the 50 ms hold and the 120 ms group timer coexist");

  clock.tick();
  clock.tick();
  await flushTasks();

  const result = await running;
  assert.equal(result.error, undefined);
  assert.equal(clock.pending(), 1, "the unfinished group is still on the clock");

  clock.tickMs(60);
  await flushMicrotasks();
  assert.equal(clock.pending(), 0);
});
