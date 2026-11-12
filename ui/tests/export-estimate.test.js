// 按剧本估算时长：快进时钟 + 真解释器，不画一帧。
// Duration estimation: the real interpreter under a clock that jumps.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdvancingClock,
  estimateDuration,
  framesFor,
} from "../export-estimate.js";

test("快进时钟一次跨到最早的事件，而不是一帧一帧挪", () => {
  const clock = createAdvancingClock({ fps: 30, timescale: 30000 });
  assert.equal(clock.now(), 0);
  assert.equal(clock.advance(), false, "没有待办事件时不动");

  const landed = [];
  clock.wait(5000).then(() => landed.push(clock.now()));
  assert.equal(clock.advance(), true);
  assert.equal(clock.now(), 5000, "5000ms 是整帧，落到事件自己的时刻");
  assert.equal(clock.pending(), 0);
});

test("快进时钟把到期时刻对齐到帧边界，与虚拟时钟一致", () => {
  // 30fps 下一帧是 1000/30 ms；50ms 的等待落在第 2 帧的边界上。
  const clock = createAdvancingClock({ fps: 30, timescale: 30000 });
  clock.wait(50);
  clock.advance();
  assert.equal(Math.round(clock.now() * 30), 2000, "50ms → 两帧");
});

test("帧回调只在推进时兑现，且不推进时间时不会自己跑", () => {
  const clock = createAdvancingClock({ fps: 24, timescale: 24000 });
  let runs = 0;
  clock.frame().then(() => {
    runs += 1;
  });
  assert.equal(runs, 0);
  clock.advance();
  assert.equal(clock.pending(), 0);
  assert.equal(clock.now(), 1000 / 24, "没有定时器时推进恰好一帧");
});

test("framesFor 由时长与帧率换算，最少一帧", () => {
  assert.equal(framesFor(2000, 30), 60);
  assert.equal(framesFor(2000, 60), 120);
  assert.equal(framesFor(0, 30), 1);
  assert.equal(framesFor(-5, 30), 1);
});

test("estimateDuration 把台词停留、停顿与收尾都算进时长", async () => {
  const result = await estimateDuration({
    source: ['say("开场")', "wait 200", 'say("第二句")'].join("\n"),
    path: "scripts/main.pe",
    read: async () => "",
  });

  assert.equal(result.error, null);
  assert.equal(result.complete, true);
  // holdFor：max(900, 字数 × 55 + 600) —— 两句都是 900ms，中间 200ms 停顿。
  assert.equal(result.clockMs, 2000);
  assert.equal(result.ms, 2000);
  assert.equal(result.frames, 60);
});

test("estimateDuration 跟着 include 读进子场景", async () => {
  const asked = [];
  const result = await estimateDuration({
    source: ['include "ch1.pe"', 'say("完")'].join("\n"),
    path: "scripts/main.pe",
    read: async (relative) => {
      asked.push(relative);
      return 'say("第一章")';
    },
  });

  assert.deepEqual(asked, ["scripts/ch1.pe"]);
  assert.equal(result.error, null);
  assert.ok(result.ms >= 1800, `两句话至少 1800ms，实际 ${result.ms}`);
});

test("时长至少要覆盖最后一个画面事件，哪怕演出已经结束", async () => {
  const result = await estimateDuration({
    source: ['ch = Character("hero.png")', "ch.enable()", "ch.moveTo(100, 0, 0, 3000)"].join("\n"),
    path: "scripts/main.pe",
    read: async () => "",
  });

  assert.equal(result.error, null);
  // 演出在 3s 的移动结束时就停了；时间线的末端才是视频该有的长度。
  assert.equal(result.timelineMs, 3000);
  assert.ok(result.ms >= 3000, `估出来的时长应覆盖移动，实际 ${result.ms}`);
});

test("脚本有错时仍然回答跑到哪一步，并带上错误", async () => {
  const result = await estimateDuration({
    source: 'say("开场")\n不认识的语句 ???',
    path: "scripts/main.pe",
    read: async () => "",
  });

  assert.ok(result.error, "应当把解析错误交回来");
  assert.equal(result.complete, false);
  assert.ok(result.ms >= 0);
});
