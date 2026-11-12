// 对象自己的三维坐标轴：几何、绘制与覆盖层的生命周期。
// Pamela — an object's own 3D axes: geometry, painting and the overlay loop.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AXIS_KEYS,
  AXIS_LENGTH,
  AXIS_STYLE,
  axesOf,
  createAxesLayer,
  paintAxes,
} from "../axes.js";
import { orientationOf, projectPoint, turnMatrix } from "../space.js";

/** A 2D context that only records what was asked of it. */
function fakeContext(withStroke = true) {
  const calls = [];
  const ctx = {
    calls,
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {},
    beginPath() {
      calls.push(["beginPath"]);
    },
    moveTo(x, y) {
      calls.push(["moveTo", x, y]);
    },
    lineTo(x, y) {
      calls.push(["lineTo", x, y]);
    },
    closePath() {},
    arc() {},
    fill() {},
    setLineDash(dash) {
      calls.push(["setLineDash", [...dash]]);
    },
    fillText(text) {
      calls.push(["fillText", text]);
    },
    ...(withStroke
      ? {
          stroke() {
            calls.push(["stroke", this.strokeStyle, this.globalAlpha]);
          },
        }
      : {}),
  };
  return ctx;
}

/** `createAxesLayer` needs a document; a one-canvas stand-in is enough. */
function withCanvas(run) {
  const previous = globalThis.document;
  const ctx = fakeContext();
  const node = {
    className: "",
    width: 0,
    height: 0,
    getContext: () => ctx,
  };
  globalThis.document = { createElement: () => node };
  try {
    return run(node, ctx);
  } finally {
    if (previous === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous;
    }
  }
}

test("an object's three axes are the pose's right / up / normal", () => {
  const frame = axesOf({ x: 120, y: -80, z: 200 }, { key: "hero", label: "hero" });

  assert.equal(frame.key, "hero");
  assert.equal(frame.label, "hero");
  assert.deepEqual(frame.axes.map((axis) => axis.key), [...AXIS_KEYS]);
  assert.deepEqual(frame.axes.map((axis) => axis.color), [
    AXIS_STYLE.z.color, AXIS_STYLE.y.color, AXIS_STYLE.x.color,
  ]);
  assert.deepEqual(
    { x: frame.origin.x, y: frame.origin.y },
    { x: projectPoint({ x: 120, y: -80, z: 200 }).x, y: projectPoint({ x: 120, y: -80, z: 200 }).y },
  );

  // 正对观众时：x 向右、y 向上，z 指着画面深处所以投影成一个点。
  const [z, y, x] = frame.axes;
  assert.ok(x.to.x > frame.origin.x && Math.abs(x.to.y - frame.origin.y) < 1e-9);
  assert.ok(y.to.y > frame.origin.y && Math.abs(y.to.x - frame.origin.x) < 1e-9);
  // 推轴正对观众时投影成一个点；原点不居中时，更深的那一端朝画面中心收。
  assert.ok(Math.abs(z.to.x) < Math.abs(frame.origin.x));
  assert.ok(Math.abs(z.to.y) < Math.abs(frame.origin.y));
  assert.ok(z.to.scale < frame.origin.scale);
  // 负方向那一截也画出来，让轴看起来是从原点穿过去的。
  assert.ok(x.back.x < frame.origin.x);
});

test("the axes roll with rotate, but rotateV never turns them sideways", () => {
  const rolled = axesOf({ rotate: 90 });
  const [, y, x] = rolled.axes;
  assert.ok(x.to.y < rolled.origin.y, "W 面转 90 度后 x 平轴朝下");
  assert.ok(y.to.x > rolled.origin.x, "y 升轴跟着转到右边");

  const tilted = axesOf({ rotate: 90, rotateV: 90 });
  const [, , tiltedX] = tilted.axes;
  assert.ok(
    Math.abs(tiltedX.to.x - tilted.origin.x) < 1e-9,
    "V 面绕世界 x 轴转，x 分量不动，摄影机看去不会出现左右",
  );

  // 轴就是朝向矩阵的三列；这一条把 axes.js 和 space.js 钉在一起。
  const { right, up, normal } = orientationOf({ rotate: 30, rotateH: 20, rotateV: 15 });
  assert.deepEqual(turnMatrix("V", 15).length, 9);
  const vectors = { x: right, y: up, z: normal };
  for (const axis of axesOf({ rotate: 30, rotateH: 20, rotateV: 15 }).axes) {
    const vector = vectors[axis.key];
    const far = projectPoint({
      x: AXIS_LENGTH * vector[0],
      y: AXIS_LENGTH * vector[1],
      z: AXIS_LENGTH * vector[2],
    });
    assert.ok(Math.abs(axis.to.x - far.x) < 1e-9);
    assert.ok(Math.abs(axis.to.y - far.y) < 1e-9);
  }
});

test("each endpoint is projected on its own, so a depth axis shortens", () => {
  const frame = axesOf({ rotateH: 60 });
  const [z, , x] = frame.axes;
  assert.ok(z.to.x < frame.origin.x, "H 面转开后推轴在画面里指向左边（光束才是它的反向）");
  assert.notEqual(z.to.scale, frame.origin.scale, "远处那一端不再用原点的缩放");
  assert.ok(x.to.scale < frame.origin.scale, "x 轴伸进画面深处的一端被透视收短");
});

test("scale lengthens the axes, clamped so a tiny object still has visible ones", () => {
  const small = axesOf({ scale: 0.01 });
  const large = axesOf({ scale: 2 });
  const span = (frame) => Math.abs(frame.axes[2].to.x - frame.origin.x);
  assert.ok(span(large) > span(small));
  assert.ok(span(small) > 0);
});

test("paintAxes draws three coloured axes and labels them", () => {
  const ctx = fakeContext();
  const painted = paintAxes(ctx, [axesOf({}, { label: "hero" })], {
    size: { width: 1920, height: 1080 },
    scale: 0.5,
  });

  assert.equal(painted, true);
  const strokes = ctx.calls.filter((call) => call[0] === "stroke");
  // 每根轴两笔：负方向虚线 + 正方向实线。
  assert.equal(strokes.length, 6);
  assert.deepEqual(
    [...new Set(strokes.map((call) => call[1]))].sort(),
    [AXIS_STYLE.x.color, AXIS_STYLE.y.color, AXIS_STYLE.z.color].sort(),
  );
  const texts = ctx.calls.filter((call) => call[0] === "fillText").map((call) => call[1]);
  assert.ok(texts.includes("x 平轴"));
  assert.ok(texts.includes("y 升轴"));
  assert.ok(texts.includes("z 推轴"));
  assert.ok(texts.includes("hero"), "原点旁边写着对象名");
  // 像素换算：逻辑 (0, 0) 在半分辨率画布的正中央。
  const first = ctx.calls.find((call) => call[0] === "moveTo");
  assert.equal(first[1], 1920 / 2 * 0.5);
  assert.equal(first[2], 1080 / 2 * 0.5);
});

test("paintAxes quietly does nothing without a 2D context or any frames", () => {
  assert.equal(paintAxes(null, [axesOf({})], {}), false);
  assert.equal(paintAxes(fakeContext(), [], {}), false);
  assert.equal(paintAxes(fakeContext(false), [axesOf({})], {}), false);
});

test("the overlay keeps painting while a target is on, and stops when it is off", () => {
  withCanvas((node, ctx) => {
    const queue = [];
    let frames = [];
    let active = false;
    const layer = createAxesLayer({
      size: { width: 1920, height: 1080 },
      scale: 0.5,
      read: () => frames,
      active: () => active,
      schedule: (run) => queue.push(run),
    });

    assert.equal(node.className, "stage__axes");
    assert.equal(node.width, 960);
    assert.equal(node.height, 540);

    layer.invalidate();
    assert.equal(queue.length, 1, "开关一变就排一帧");
    layer.invalidate();
    assert.equal(queue.length, 1, "已经在跑时不重复排队");

    frames = [axesOf({}, { label: "hero" })];
    active = true;
    queue.shift()();
    assert.equal(layer.isVisible(), true);
    assert.equal(queue.length, 1, "还开着轴就继续逐帧重画");
    assert.ok(ctx.calls.some((call) => call[0] === "stroke"));

    // 对象开着 crood 却还没上台：这一帧没有轴，也要继续等。
    frames = [];
    queue.shift()();
    assert.equal(layer.isVisible(), false);
    assert.equal(queue.length, 1, "active 为真时循环不因空帧停掉");

    active = false;
    queue.shift()();
    assert.equal(queue.length, 0, "全部收起后不再占帧");
    assert.equal(layer.isVisible(), false);

    layer.destroy();
    layer.invalidate();
    assert.equal(queue.length, 0, "销毁后不再排帧");
  });
});

test("a document without a 2D context leaves the overlay inert", () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ className: "", width: 0, height: 0 }) };
  try {
    const layer = createAxesLayer({ size: { width: 100, height: 100 }, scale: 0.5 });
    layer.invalidate();
    assert.equal(layer.isVisible(), false);
  } finally {
    if (previous === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous;
    }
  }
});
