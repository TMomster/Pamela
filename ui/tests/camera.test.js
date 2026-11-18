// Camera 类型测试：默认兼容性、取景数学、激活语义。
// Tests for the Camera type: defaults, framing, and activation.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CAMERA,
  DEFAULT_FOV,
  depthScale,
  normalizeCamera,
  projectPoint,
  projectPose,
} from "../space.js";
import { createStage, createStageGlobals, createStageObjects } from "../stage.js";

function fakeElement() {
  const classes = new Set();
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    log: [],
    style: new Proxy({}, {
      set(target, key, value) {
        target[key] = value;
        node.log.push(`style.${key}`);
        return true;
      },
    }),
    get offsetWidth() {
      node.log.push("layout");
      return 0;
    },
    childNodes: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name) {
        if (classes.has(name)) classes.delete(name);
        else classes.add(name);
      },
    },
    get firstChild() { return node.childNodes[0] ?? null; },
    replaceChildren(...children) { node.childNodes = children; },
    append(child) { node.childNodes.push(child); },
    decode() { return Promise.resolve(); },
    hidden: false,
    alt: "",
    draggable: false,
    src: "",
    textContent: "",
    volume: 1,
    loop: false,
    currentTime: 0,
    paused: true,
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
    play() {
      node.paused = false;
      return Promise.resolve();
    },
    pause() {
      node.paused = true;
    },
    removeAttribute(name) {
      if (name === "src") node.src = "";
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
  };
  return node;
}

function makeStage() {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  const surface = fakeElement();
  const element = fakeElement();
  const stage = createStage({
    element,
    surface,
    resolveAsset: () => Promise.resolve("data:,"),
  });
  return {
    stage,
    restore() {
      globalThis.document = previous;
    },
  };
}

test("缺省相机逐像素复刻旧投影", () => {
  assert.equal(DEFAULT_CAMERA.z, -2000);
  assert.ok(Math.abs(DEFAULT_FOV - 30.21915) < 0.00001);
  assert.equal(depthScale(0), 1);
  const at = projectPoint({ x: 300, y: 120, z: 0 });
  assert.equal(at.x, 300);
  assert.equal(at.y, 120);
  assert.equal(at.scale, 1);
});

test("FOV 越大，同一世界坐标在画面上越靠中心", () => {
  const narrow = projectPoint({ x: 960, y: 0, z: 0 });
  const wide = projectPoint(
    { x: 960, y: 0, z: 0 },
    { camera: normalizeCamera({ fov: 60 }) },
  );
  assert.ok(wide.x < narrow.x);
});

test("相机后退扩大可见范围，但世界坐标不变", () => {
  const at = projectPoint(
    { x: 960, y: 0, z: 0 },
    { camera: normalizeCamera({ z: -4000 }) },
  );
  assert.equal(at.x, 480);
  assert.equal(at.scale, 0.5);
});

test("转动相机改变取景，负 k1 把边缘拉向中心", () => {
  const turned = projectPoint(
    { x: 1000, y: 0, z: 0 },
    { camera: normalizeCamera({ rotateH: 30 }) },
  );
  assert.notEqual(turned.x, 1000);
  const barrel = projectPoint(
    { x: 960, y: 540, z: 0 },
    { camera: normalizeCamera({ k1: -0.1 }) },
  );
  assert.ok(barrel.x < 960);
  assert.ok(barrel.y < 540);
  const corners = projectPose(
    { x: 0, y: 0, z: 0 },
    { w: 1920, h: 1080 },
    { camera: normalizeCamera({ k1: -0.2 }) },
  ).corners;
  assert.ok(corners.upright.x < 960, "平躺的画面四角也走径向畸变");
  assert.ok(corners.upright.y < 540);
});

test("Camera 可多次构造，同一时刻只有一台激活", () => {
  const { stage, restore } = makeStage();
  try {
    const objects = createStageObjects(stage);
    const first = objects.Camera([], { assignee: "a" });
    const second = objects.Camera([], { assignee: "b" });
    assert.equal(stage.cameraIsActive(first), false);
    assert.equal(stage.cameraIsActive(second), false);

    first.enable();
    assert.equal(stage.cameraIsActive(first), true);
    assert.equal(stage.activeCameraState().fov, DEFAULT_FOV);
    first.fov(60);
    assert.equal(stage.activeCameraState().fov, 60);

    second.enable();
    assert.equal(stage.cameraIsActive(first), false);
    assert.equal(stage.cameraIsActive(second), true);

    second.disable();
    assert.equal(stage.cameraIsActive(second), false);
    assert.equal(stage.activeCameraState().fov, DEFAULT_FOV);
  } finally {
    restore();
  }
});

test("脚本里的 stage.Camera 与全局 Camera 是同一个构造器", () => {
  const { stage, restore } = makeStage();
  try {
    const globals = createStageGlobals(stage)({});
    const camera = globals.stage.Camera(0, 0, -3000, 60);
    camera.enable();
    assert.equal(stage.activeCameraState().z, -3000);
    assert.equal(stage.activeCameraState().fov, 60);
  } finally {
    restore();
  }
});
