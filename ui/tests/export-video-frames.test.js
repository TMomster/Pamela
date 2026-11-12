// 视频取帧：暂停的元素 + seek，文件只读一次（用假元素代替浏览器）。
// Video frames for the exported movie, against a fake element.

import assert from "node:assert/strict";
import test from "node:test";

import { createVideoFrames } from "../export-video-frames.js";

class FakeVideo {
  constructor() {
    this.listeners = new Map();
    this.videoWidth = 1280;
    this.videoHeight = 720;
    this.duration = 10;
    this.muted = false;
    this.playsInline = false;
    this.preload = "";
    this._time = 0;
    this.seeks = 0;
  }

  addEventListener(name, fn) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  removeEventListener(name, fn) {
    const list = this.listeners.get(name) ?? [];
    this.listeners.set(name, list.filter((item) => item !== fn));
  }

  emit(name) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) {
      fn();
    }
  }

  set src(value) {
    this._src = value;
    queueMicrotask(() => this.emit("loadeddata"));
  }

  get src() {
    return this._src;
  }

  set currentTime(value) {
    this._time = value;
    this.seeks += 1;
    queueMicrotask(() => this.emit("seeked"));
  }

  get currentTime() {
    return this._time;
  }

  pause() {
    this.paused = true;
  }

  removeAttribute() {}

  load() {}
}

test("seek parks the element on the requested second and reads the file once", async () => {
  const reads = [];
  const element = new FakeVideo();
  const frames = createVideoFrames({
    resolveVideo: async (path) => {
      reads.push(path);
      return "data:video/mp4;base64,AA";
    },
    createElement: () => element,
    timeoutMs: 1000,
  });

  const frame = await frames.seek("opening.mp4", 2.5);
  assert.equal(frame.element, element);
  assert.equal(frame.width, 1280);
  assert.equal(frame.height, 720);
  assert.equal(frame.duration, 10);
  assert.equal(element.currentTime, 2.5);
  assert.equal(element.seeks, 1);

  // 同一时刻再要一次不必再 seek，文件也只解析一次。
  await frames.seek("opening.mp4", 2.5);
  assert.equal(element.seeks, 1);
  assert.deepEqual(reads, ["opening.mp4"]);

  await frames.seek("opening.mp4", 4);
  assert.equal(element.currentTime, 4);
  assert.equal(element.seeks, 2);
});

test("seek clamps past the end of the file", async () => {
  const element = new FakeVideo();
  const frames = createVideoFrames({
    resolveVideo: async () => "data:video/mp4;base64,AA",
    createElement: () => element,
    timeoutMs: 1000,
  });
  await frames.seek("opening.mp4", 99);
  assert.equal(element.currentTime, 9.999);

  await frames.seek("opening.mp4", -5);
  assert.equal(element.currentTime, 0);
});

test("a clip that cannot be read rejects instead of hanging", async () => {
  const frames = createVideoFrames({
    resolveVideo: async () => "",
    createElement: () => new FakeVideo(),
    timeoutMs: 50,
  });
  await assert.rejects(() => frames.seek("gone.mp4", 0), /无法加载视频/);

  const silent = createVideoFrames({
    resolveVideo: async () => "data:video/mp4;base64,AA",
    createElement: () => {
      const element = new FakeVideo();
      element.videoWidth = 0;
      element.videoHeight = 0;
      return element;
    },
    timeoutMs: 50,
  });
  await assert.rejects(() => silent.seek("cover-only.mp4", 0), /没有画面/);
});

test("clear pauses and releases the elements it loaded", async () => {
  const element = new FakeVideo();
  const frames = createVideoFrames({
    resolveVideo: async () => "data:video/mp4;base64,AA",
    createElement: () => element,
    timeoutMs: 1000,
  });
  await frames.seek("opening.mp4", 1);
  frames.clear();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(element.paused, true);
});
