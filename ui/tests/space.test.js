// 三维坐标的公共约定：x 向右、y 向上、z 朝画面深处为正。
// Tests for the one place the three axes are defined.

import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKGROUND_DEPTH,
  CAMERA_DISTANCE,
  DEPTH_LIMIT,
  ORDER_CEILING,
  SCENE_RANK,
  byDepth,
  clampDepth,
  depthScale,
  projectPoint,
  sceneOrder,
} from "../space.js";

test("the stage plane is the identity", () => {
  assert.equal(depthScale(0), 1, "z=0 must not move a picture that never asked");
  assert.equal(depthScale(undefined), 1);
  assert.equal(depthScale(Number.NaN), 1);
});

test("deeper is smaller, nearer is larger", () => {
  assert.ok(depthScale(1000) < 1);
  assert.ok(depthScale(-500) > 1);
  assert.equal(depthScale(CAMERA_DISTANCE), 0.5, "one camera distance in is half size");
  assert.ok(depthScale(4000) < depthScale(1000), "monotonic on the way in");
});

test("without perspective depth changes neither size nor position", () => {
  // 正交空间：深度只决定谁盖住谁，同一个 z 方向上的物体完全重叠。
  assert.equal(depthScale(1000, false), 1);
  assert.equal(depthScale(-500, false), 1);
  const far = projectPoint({ x: 300, y: 120, z: 2000 }, { perspective: false });
  const near = projectPoint({ x: 300, y: 120, z: -800 }, { perspective: false });
  assert.deepEqual([far.x, far.y, far.scale], [300, 120, 1]);
  assert.deepEqual([near.x, near.y, near.scale], [300, 120, 1]);
  // 打开透视以后，同样的两个点不再重合，远的朝中心收。
  const projected = projectPoint({ x: 300, y: 120, z: 2000 }, { perspective: true });
  assert.ok(projected.x < 300);
  assert.ok(projected.y < 120);
});

test("a backdrop starts one step deeper than a character, so it stays behind", () => {
  assert.equal(BACKGROUND_DEPTH, 1);
  assert.equal(SCENE_RANK.background < SCENE_RANK.character, true);
  const order = sceneOrder([
    { kind: "character", z: 0 },
    { kind: "background", z: BACKGROUND_DEPTH },
  ]);
  assert.equal(order[0].kind, "background", "背景先画，也就是垫在角色后面");
});

test("depth is clamped to what the camera can show", () => {
  assert.equal(clampDepth(99999), DEPTH_LIMIT.far);
  assert.equal(clampDepth(-99999), DEPTH_LIMIT.near);
  assert.equal(clampDepth("nope"), 0);
});

test("the layer is drawn from the back to the front", () => {
  const near = { z: -100 };
  const far = { z: 900 };
  const plane = { z: 0 };
  assert.deepEqual([far, plane, near].sort(byDepth), [far, plane, near]);
  // 没写过 z 的剧本保持原来的先后。
  const first = {};
  const second = {};
  assert.deepEqual([first, second].sort(byDepth), [first, second]);
});

test("the whole scene is ordered by depth, background below character on a tie", () => {
  const backdrop = { kind: "background", z: 600 };
  const far = { kind: "character", z: 500 };
  const hero = { kind: "character", z: -80 };
  assert.deepEqual(sceneOrder([hero, far, backdrop]), [backdrop, far, hero]);

  // z 相同时背景先画（在下），角色按传入的入场序在后。
  const plane = { kind: "background", z: 0 };
  const first = { kind: "character", z: 0 };
  const second = { kind: "character", z: 0 };
  assert.deepEqual(sceneOrder([second, first, plane]), [plane, second, first]);
  assert.ok(SCENE_RANK.background < SCENE_RANK.character);
  assert.equal(ORDER_CEILING, 999);
});
