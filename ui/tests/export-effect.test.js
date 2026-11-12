// 导出时的粒子：录制参数、固定步长推进、层序（全部用假上下文）。
// Particles in the exported movie: recorded params, fixed-step stepping, layer order.

import assert from "node:assert/strict";
import test from "node:test";

import { createEffectLayer, createEffectRecorder } from "../export-effect.js";
import { createVirtualClock } from "../export-clock.js";
import { createCanvasRenderer } from "../export-render.js";
import { createTimeline, stateAt } from "../export-timeline.js";

function fakeCtx() {
  const calls = [];
  const ctx = {
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    save() {
      calls.push(["save"]);
    },
    restore() {
      calls.push(["restore"]);
    },
    translate(...args) {
      calls.push(["translate", ...args]);
    },
    scale(...args) {
      calls.push(["scale", ...args]);
    },
    rotate(...args) {
      calls.push(["rotate", ...args]);
    },
    beginPath() {
      calls.push(["beginPath"]);
    },
    moveTo(...args) {
      calls.push(["moveTo", ...args]);
    },
    lineTo(...args) {
      calls.push(["lineTo", ...args]);
    },
    arc(...args) {
      calls.push(["arc", ...args]);
    },
    stroke() {
      calls.push(["stroke"]);
    },
    fill() {
      calls.push(["fill"]);
    },
    createRadialGradient(...args) {
      calls.push(["createRadialGradient", ...args]);
      return { addColorStop() {} };
    },
    clearRect() {},
    fillRect() {},
    drawImage(...args) {
      calls.push(["drawImage", ...args]);
    },
    fillText(...args) {
      calls.push(["fillText", ...args]);
    },
    measureText(text) {
      return { width: [...text].length * 10 };
    },
  };
  return { calls, ctx };
}

function harness() {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createEffectRecorder({ clock, timeline });
  return { clock, timeline, recorder };
}

test("Effect records its parameters under an effect: target", () => {
  const { timeline, recorder } = harness();
  const rain = recorder.effect(["rain", 2, 1.5, 0.5, 3, 0.8], { assignee: "weather" });
  rain.enable();

  const state = stateAt(timeline, 0)["effect:weather"];
  assert.equal(state.kind, "rain");
  assert.equal(state.scale, 2);
  assert.equal(state.size, 1.5);
  assert.equal(state.density, 0.5);
  assert.equal(state.speed, 3);
  assert.equal(state.opacity, 1, "enable 会把透明度拉回 1");
  assert.equal(state.visible, true);
  assert.equal(state.playing, true);
  assert.equal(state.epoch, 1);

  rain.alpha(0.4);
  assert.equal(stateAt(timeline, 0)["effect:weather"].opacity, 0.4);
});

test("Effect keeps the same relative/absolute rules as the stage", () => {
  const { timeline, recorder } = harness();
  const snow = recorder.effect(["snow"], { assignee: "snow" });
  snow.density(2);
  snow.sizeTo(0.5);
  snow.speed(0.5).speed(0.5);
  const state = stateAt(timeline, 0)["effect:snow"];
  assert.equal(state.density, 2);
  assert.equal(state.size, 0.5);
  assert.equal(state.speed, 0.25);

  assert.throws(() => recorder.effect(["storm"], {}), /特效名/);
  assert.throws(() => recorder.effect(["rain", 0], {}), /缩放/);
});

test("Effect pace changes interpolate and wait like the stage", () => {
  const { clock, timeline, recorder } = harness();
  const context = { assignee: "rain", pending: [] };
  const rain = recorder.effect(["rain"], context);
  rain.enable();
  clock.tickMs(1000);
  rain.densityTo(2, 1000);
  assert.equal(context.pending.length, 1);
  assert.equal(stateAt(timeline, 1500)["effect:rain"].density, 1.5);
  clock.tickMs(1000);
  assert.equal(stateAt(timeline, 2000)["effect:rain"].density, 2);
});

test("the effect layer advances by a fixed step and can be replayed", () => {
  const state = {
    kind: "snow",
    scale: 1,
    size: 1,
    density: 0.1,
    speed: 1,
    opacity: 1,
    visible: true,
    playing: true,
    epoch: 1,
  };
  const first = fakeCtx();
  const second = fakeCtx();
  const a = createEffectLayer();
  const b = createEffectLayer();
  a.draw(first.ctx, "effect:snow", state, 0);
  b.draw(second.ctx, "effect:snow", state, 0);

  const arcs = (calls) => calls.filter((call) => call[0] === "arc").map((call) => call.slice(1));
  assert.equal(arcs(first.calls).length, 24, "240 × 密度 0.1");
  assert.deepEqual(arcs(first.calls), arcs(second.calls), "同一对象、同一时刻 → 同一张粒子图");

  first.calls.length = 0;
  a.draw(first.ctx, "effect:snow", state, 1000);
  assert.notDeepEqual(arcs(first.calls), [], "一秒后仍然有粒子");
  assert.notDeepEqual(arcs(first.calls), arcs(second.calls), "粒子确实动了");
});

test("pausing freezes the particles and disabling hides the layer", () => {
  const { calls, ctx } = fakeCtx();
  const layer = createEffectLayer();
  const state = {
    kind: "rain",
    scale: 1,
    size: 1,
    density: 0.1,
    speed: 1,
    opacity: 1,
    visible: true,
    playing: true,
    epoch: 1,
  };
  layer.draw(ctx, "effect:rain", state, 0);
  const moving = calls.filter((call) => call[0] === "moveTo").map((call) => call.slice(1));

  calls.length = 0;
  layer.draw(ctx, "effect:rain", state, 1000);
  const later = calls.filter((call) => call[0] === "moveTo").map((call) => call.slice(1));
  assert.notDeepEqual(later, moving);

  calls.length = 0;
  const frozen = { ...state, playing: false };
  layer.draw(ctx, "effect:rain", frozen, 2000);
  const paused = calls.filter((call) => call[0] === "moveTo").map((call) => call.slice(1));
  calls.length = 0;
  layer.draw(ctx, "effect:rain", frozen, 5000);
  const stillPaused = calls.filter((call) => call[0] === "moveTo").map((call) => call.slice(1));
  assert.deepEqual(stillPaused, paused, "暂停后位置不再变化");

  calls.length = 0;
  layer.draw(ctx, "effect:rain", { ...state, visible: false }, 6000);
  assert.deepEqual(calls, [], "停用的层什么都不画");
});

test("the renderer paints particles above pictures and below the dialogue", () => {
  const { calls, ctx } = fakeCtx();
  const canvas = { width: 1920, height: 1080, getContext: () => ctx };
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", { width: 1920, height: 1080 }]]),
  });
  renderer.render(
    {
      background: { path: "bg.png", visible: true },
      "effect:rain": {
        kind: "rain",
        scale: 1,
        size: 1,
        density: 0.05,
        speed: 1,
        opacity: 1,
        visible: true,
        playing: true,
        epoch: 0,
      },
      dialogue: { text: "你好", visible: true },
    },
    0,
  );

  const imageAt = calls.findIndex((call) => call[0] === "arc" || call[0] === "moveTo");
  const textAt = calls.findIndex((call) => call[0] === "fillText");
  assert.ok(imageAt >= 0, "粒子画出来了");
  assert.ok(imageAt < textAt, "粒子在对话盒下面");
});

test("an effect kind that no longer exists is refused by the recorder", () => {
  const { recorder } = harness();
  assert.throws(
    () => recorder.effect(["prism", 1, 1.2, 1.4, 1, 0.9], { assignee: "gleam" }),
    /rain 或 snow/,
  );
});
