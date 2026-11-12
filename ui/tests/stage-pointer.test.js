// 状态栏里的坐标读数：把指针位置换算成舞台坐标。
// The status bar's pointer reading: a client point back into stage units.

import assert from "node:assert/strict";
import test from "node:test";

import { pointInStage } from "../stage.js";

/** A frame box, the way `getBoundingClientRect` would report it. */
function box(left, top, width, height) {
  return { left, top, width, height };
}

test("the middle of the frame is the origin, and the edges are half the stage away", () => {
  const frame = box(100, 50, 960, 540);

  assert.deepEqual(pointInStage(580, 320, frame), { x: 0, y: 0 });
  // 舞台 1920×1080，原点在中心、y 向上：左上角是 (-960, 540)。
  assert.deepEqual(pointInStage(100, 50, frame), { x: -960, y: 540 });
  assert.deepEqual(pointInStage(1060, 590, frame), { x: 960, y: -540 });
});

test("a quarter across the frame is a quarter of the stage", () => {
  const frame = box(0, 0, 1900, 1000);

  assert.deepEqual(pointInStage(475, 250, frame), { x: -480, y: 270 });
});

test("the reading is rounded, so a still hand does not flicker", () => {
  const frame = box(0, 0, 1920, 1080);

  assert.deepEqual(pointInStage(960.4, 539.8, frame), { x: 0, y: 0 });
  assert.deepEqual(pointInStage(960.6, 539.8, frame), { x: 1, y: 0 });
});

test("outside the frame there is no reading — the frame's own edge still counts", () => {
  const frame = box(10, 20, 800, 450);

  assert.equal(pointInStage(9, 100, frame), null, "to the left");
  assert.equal(pointInStage(810.5, 100, frame), null, "to the right");
  assert.equal(pointInStage(100, 19, frame), null, "above");
  assert.equal(pointInStage(100, 471, frame), null, "below");
  assert.ok(pointInStage(10, 20, frame), "the corner is inside");
  assert.ok(pointInStage(810, 470, frame), "so is the far corner");
});

test("a frame with no size reports nothing, so a hidden tab cannot leave a reading", () => {
  assert.equal(pointInStage(0, 0, box(0, 0, 0, 0)), null);
  assert.equal(pointInStage(0, 0, box(0, 0, 800, 0)), null);
  assert.equal(pointInStage(0, 0, box(0, 0, 0, 450)), null);
});
