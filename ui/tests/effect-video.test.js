// 内置特效与视频的舞台测试。
// Tests for the built-in Effect and the two-track Video.

import assert from "node:assert/strict";
import test from "node:test";

import { createEffectFactory, EFFECT_KINDS } from "../effect.js";
import { run } from "../pamela.js";
import { ASSET_KINDS, isVideoPath } from "../project-actions.js";
import { createStageGlobals, createStageObjects } from "../stage.js";
import { createVideoFactory } from "../video.js";

/** What the canvas painter saw in the frame it drew last. */
const drawing = { lines: 0, width: 0, radius: 0, arcs: 0 };

/** A stand-in element with just the DOM an effect or a video touches. */
function fakeNode(tag) {
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    style: {},
    childNodes: [],
    width: 0,
    height: 0,
    src: "",
    muted: true,
    volume: 1,
    loop: false,
    playsInline: false,
    playbackRate: 1,
    currentTime: 0,
    duration: 0,
    plays: 0,
    pauses: 0,
    append(...children) {
      node.childNodes.push(...children);
    },
    replaceChildren(...children) {
      node.childNodes = [...children];
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    removeAttribute(name) {
      delete node[name];
    },
    load() {},
    play() {
      node.plays += 1;
      return Promise.resolve();
    },
    pause() {
      node.pauses += 1;
    },
    querySelector() {
      return null;
    },
    getContext(kind) {
      return kind === "2d" ? context2d : null;
    },
  };
  return node;
}

/** A 2d context that records one frame's worth of particles. */
const context2d = {
  clearRect() {
    drawing.lines = 0;
    drawing.arcs = 0;
  },
  beginPath() {},
  moveTo() {
    drawing.lines += 1;
  },
  lineTo() {},
  stroke() {},
  fill() {},
  createRadialGradient() {
    return { addColorStop() {} };
  },
  save() {},
  restore() {},
  arc(_x, _y, radius) {
    drawing.arcs += 1;
    drawing.radius = radius;
  },
  set lineWidth(value) {
    drawing.width = value;
  },
  get lineWidth() {
    return drawing.width;
  },
};

/**
 * A NodeList the way a webview gives one: indexable and iterable, but with no
 * Array methods. A fake layer backed by a plain array once hid a `.filter` bug.
 */
function nodeList(nodes) {
  return {
    ...nodes,
    length: nodes.length,
    *[Symbol.iterator]() {
      yield* nodes;
    },
  };
}

/** A stage layer that keeps its children in a live, array-like NodeList. */
function fakeLayer() {
  const layer = {
    childNodes: nodeList([]),
    append(...children) {
      layer.childNodes = nodeList([...layer.childNodes, ...children]);
    },
    replaceChildren(...children) {
      layer.childNodes = nodeList(children);
    },
    querySelector() {
      return null;
    },
  };
  return layer;
}

/**
 * Runs `body` with the minimal document the two factories need.
 * An async body keeps the fake document until its promise settles: a script
 * creates its objects after an await, when a plain `finally` would already have
 * put the real (absent) document back.
 */
function withFakeDom(body) {
  const previous = globalThis.document;
  const made = [];
  globalThis.document = {
    // No createElementNS on purpose: SVG tint is optional, and a host without
    // it must still answer every Video method without throwing.
    createElement(tag) {
      const node = fakeNode(tag);
      made.push(node);
      return node;
    },
  };
  const restore = () => {
    globalThis.document = previous;
  };
  try {
    const result = body(made);
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/** The stage half a script reaches through `Effect(…)` / `Video(…)`. */
function scriptStage(made) {
  const effectLayer = fakeLayer();
  const videoLayer = fakeLayer();
  const effect = createEffectFactory({
    layer: effectLayer,
    random: () => 0.5,
    size: { width: 800, height: 450 },
  });
  const video = createVideoFactory({
    layer: videoLayer,
    resolveAsset: (path) => Promise.resolve(`data:video/mp4;base64,${path}`),
    size: { width: 800, height: 450 },
  });
  const stage = { effect, video };
  return { stage, effectLayer, videoLayer, made };
}

/** Lets a video's resolveAsset → play chain settle. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("Effect knows only the two built-in kinds", () => {
  assert.deepEqual([...EFFECT_KINDS], ["rain", "snow"]);
  withFakeDom(() => {
    const factory = createEffectFactory({ layer: fakeLayer(), random: () => 0.5 });
    assert.throws(() => factory(["hail"], {}), /rain 或 snow/);
    assert.throws(() => factory(["prism"], {}), /rain 或 snow/);
    assert.throws(() => factory([], {}), /rain 或 snow/);
  });
});

test("enable mounts one canvas, disable and clear take it away", () => {
  withFakeDom((made) => {
    const layer = fakeLayer();
    const factory = createEffectFactory({ layer, random: () => 0.5 });
    const effect = factory(["rain"], {});
    assert.equal(layer.childNodes.length, 0, "a new effect is not on the stage yet");

    effect.enable();
    assert.equal(layer.childNodes.length, 1);
    assert.equal(layer.childNodes[0].className, "stage__effect");
    assert.equal(made[0].width, 1920, "the canvas is the stage's logical size");

    effect.disable();
    assert.equal(layer.childNodes.length, 0);
    effect.enable();
    factory.clear();
    assert.equal(layer.childNodes.length, 0, "clear stops the loop and drops the canvas");
  });
});

test("an effect fades, scales its picture and sizes its particles", () => {
  withFakeDom(() => {
    const layer = fakeLayer();
    const factory = createEffectFactory({ layer, random: () => 0.5 });
    const effect = factory(["rain"], {});
    effect.enable();
    const node = layer.childNodes[0];
    effect.disable();
    effect.enable();
    assert.equal(layer.childNodes[0], node, "enable after disable reuses the canvas");

    effect.hide(0);
    assert.equal(node.style.opacity, "0", "hide is the picture's fade-out");
    effect.show(0);
    assert.equal(node.style.opacity, "", "show fades back to full opacity");

    effect.scaleTo(2, 0);
    assert.match(node.style.transform, /scale\(2\)/, "scale is the whole particle picture");

    effect.sizeTo(3, 0);
    assert.ok(Math.abs(drawing.width - 4.8) < 1e-9, "size changes each particle, not the layer");

    effect.densityTo(0.5, 0);
    assert.equal(drawing.lines, 120, "density changes how many particles are drawn");
    factory.clear();
  });
});

test("an effect's speed, pause and play keep the canvas in place", () => {
  withFakeDom(() => {
    const layer = fakeLayer();
    const factory = createEffectFactory({ layer, random: () => 0.5 });
    const effect = factory(["snow"], {});
    effect.enable();
    assert.doesNotThrow(() => {
      effect.speedTo(1.5, 0).speed(2, 0).pause().play();
      factory.pauseAll();
    });
    assert.equal(layer.childNodes.length, 1, "pausing freezes rather than removing");
    factory.clear();
  });
});

test("Video starts muted, and mute() with no argument means true", () => {
  withFakeDom((made) => {
    const layer = fakeLayer();
    const factory = createVideoFactory({
      layer,
      resolveAsset: () => Promise.resolve("data:video/mp4;base64,x"),
    });
    const video = factory(["clip.mp4"], {});
    const element = made[0];
    assert.equal(element.muted, true, "the default keeps autoplay allowed");
    video.mute(false);
    assert.equal(element.muted, false);
    video.mute();
    assert.equal(element.muted, true);
    video.audio.disable();
    assert.equal(element.muted, true, "the audio track can be silenced on its own");
    video.audio.enable();
    video.mute(false);
    assert.equal(element.muted, false);
    factory.clear();
  });
});

test("Video's two tracks own different methods", () => {
  withFakeDom(() => {
    const factory = createVideoFactory({
      layer: fakeLayer(),
      resolveAsset: () => Promise.resolve("data:video/mp4;base64,x"),
    });
    const video = factory(["clip.mp4"], {});
    assert.equal(video.kind, "Video");
    assert.equal(video.media.kind, "VideoMedia");
    assert.equal(video.audio.kind, "VideoAudio");
    assert.equal(video.media.mute, undefined, "sound has no place on the picture track");
    assert.equal(video.audio.move, undefined, "position has no place on the sound track");
    assert.equal(typeof video.media.enable, "function");
    assert.equal(typeof video.audio.mute, "function");
    factory.clear();
  });
});

test("enable restarts, play resumes from the current position, pause freezes", async () => {
  await withFakeDom(async (made) => {
    const layer = fakeLayer();
    const factory = createVideoFactory({
      layer,
      resolveAsset: (path) => Promise.resolve(`data:video/mp4;base64,${path}`),
    });
    const video = factory(["clip.mp4"], {});
    const element = made[0];
    video.enable();
    await tick();
    assert.equal(element.src, "data:video/mp4;base64,clip.mp4");
    assert.equal(element.plays, 1);
    assert.equal(element.currentTime, 0, "enable starts from the beginning");
    assert.equal(layer.childNodes.length, 1);

    element.currentTime = 5;
    video.play();
    await tick();
    assert.equal(element.currentTime, 5, "play does not move the playhead");

    video.pause();
    assert.ok(element.pauses >= 1);
    factory.clear();
    assert.ok(element.pauses >= 2, "clear stops playback too");
    assert.equal(layer.childNodes.length, 0);
  });
});

test("Video delegates picture calls to media and writes CSS filters", () => {
  withFakeDom((made) => {
    const layer = fakeLayer();
    const factory = createVideoFactory({
      layer,
      resolveAsset: () => Promise.resolve("data:video/mp4;base64,x"),
      size: { width: 800, height: 450 },
    });
    const video = factory(["clip.mp4"], {});
    const element = made[0];
    video.move(100, 50, 0, 0);
    assert.equal(element.style.left, "62.5%", "x is a percentage of the logical width");
    assert.ok(element.style.top);
    video.media.move(-100, -50, 0, 0);
    assert.equal(element.style.left, "50%", "the media track moves the same element");
    video.moveTo(0, 0, 0, 0);
    assert.equal(element.style.left, "50%", "the centre of the stage is 50%");

    video.blur(4, 0);
    assert.match(element.style.filter, /blur\(4px\)/);
    video.hide(0);
    assert.equal(element.style.opacity, "0", "fade in/out is the picture's opacity");
    video.show(0);
    assert.equal(element.style.opacity, "");

    video.speedTo(2, 0);
    assert.equal(element.playbackRate, 2, "1.0 is normal speed");
    video.speed(2, 0);
    assert.equal(element.playbackRate, 4, "speed is a relative multiplier");
    factory.clear();
  });
});

test("a .pe script reaches both types, their Chinese names and the sub-tracks", async () => {
  await withFakeDom(async (made) => {
    const { stage, effectLayer, videoLayer } = scriptStage(made);
    const result = await run(
      [
        '雨 = 特效("rain")',
        "雨.启用()",
        "雨.渐出(0)",
        "雨.暂停()",
        '片 = 视频("clip.mp4")',
        "片.画面轨.启用()",
        "片.声音轨.静音(false)",
        "片.移动到(100, 0, 0)",
        "片.速度到(1.5, 0)",
      ].join("\n"),
      {
        constructors: createStageObjects(stage),
        globals: createStageGlobals(stage),
      },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(effectLayer.childNodes.length, 1, "the rain is drawn");
    assert.equal(videoLayer.childNodes.length, 1, "the video is on the stage");
    assert.equal(videoLayer.childNodes[0].muted, false, "静音(false) unmuted it");
    stage.effect.clear();
    stage.video.clear();
  });
});

test("a retired effect name is refused instead of drawing nothing", async () => {
  await withFakeDom(async (made) => {
    const { stage, effectLayer } = scriptStage(made);
    const gone = await run('光 = 特效("prism")', {
      constructors: createStageObjects(stage),
      globals: createStageGlobals(stage),
    });
    assert.ok(gone.error, "prism 已移除，不该再被当成特效名");
    assert.match(gone.error.message, /rain 或 snow/);
    assert.equal(effectLayer.childNodes.length, 0, "没有挂上任何画布");

    // 连带的 `色散` 也是删掉的：既不认作方法，也不认作构造参数。
    const method = await run('光 = 特效("rain")\n光.色散(2, 0)', {
      constructors: createStageObjects(stage),
      globals: createStageGlobals(stage),
    });
    assert.ok(method.error);
    const built = await run('光 = 特效("rain", 色散 = 1.2)', {
      constructors: createStageObjects(stage),
      globals: createStageGlobals(stage),
    });
    assert.ok(built.error);
    stage.effect.clear();
  });
});

test("a video and an effect retire on a webview-like NodeList layer", () => {
  withFakeDom(() => {
    const effectLayer = fakeLayer();
    const videoLayer = fakeLayer();
    const effect = createEffectFactory({ layer: effectLayer, random: () => 0.5 });
    const video = createVideoFactory({
      layer: videoLayer,
      resolveAsset: () => Promise.resolve("data:video/mp4;base64,x"),
    });
    assert.equal(effectLayer.childNodes.filter, undefined, "a NodeList has no filter");

    effect(["rain"], { assignee: "weather" }).enable();
    assert.equal(effectLayer.childNodes.length, 1);
    // Re-creating the same name retires the old object, which drops its node.
    effect(["snow"], { assignee: "weather" });
    assert.equal(effectLayer.childNodes.length, 0, "the rain canvas is gone");
    effect.clear();

    video(["clip.mp4"], { assignee: "ch" }).enable();
    assert.equal(videoLayer.childNodes.length, 1);
    video(["clip.mp4"], { assignee: "ch" });
    assert.equal(videoLayer.childNodes.length, 0, "the old video is gone");
    video.clear();
  });
});

test("an enormous density is clamped instead of allocating forever", () => {
  withFakeDom(() => {
    const factory = createEffectFactory({ layer: fakeLayer(), random: () => 0.5 });
    const effect = factory(["rain", 1, 1, 1e9], {});
    effect.enable();
    assert.ok(drawing.lines <= 4000, `粒子数被限制，实际 ${drawing.lines}`);
    factory.clear();
  });
});

test("a failed video read is retried instead of cached forever", async () => {
  await withFakeDom(async (made) => {
    let calls = 0;
    const factory = createVideoFactory({
      layer: fakeLayer(),
      resolveAsset: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("missing"))
          : Promise.resolve("data:video/mp4;base64,x");
      },
    });
    const video = factory(["clip.mp4"], {});
    video.play();
    await tick();
    assert.equal(made[0].src || "", "", "第一次读取失败");
    video.play();
    await tick();
    assert.equal(made[0].src, "data:video/mp4;base64,x", "第二次读取重新解析");
    factory.clear();
  });
});

test("the video folder and its extensions are part of the asset kinds", () => {
  assert.ok(ASSET_KINDS.includes("Video"));
  assert.equal(isVideoPath("assets/Video/opening.mp4"), true);
  assert.equal(isVideoPath("assets/Video/opening.WEBM"), true);
  assert.equal(isVideoPath("assets/Video/opening.mkv"), false);
  assert.equal(isVideoPath("assets/Audio/bgm.mp3"), false, "a sound is not a video");
});
