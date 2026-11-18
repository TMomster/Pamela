// 导出与播放器的命令面必须一致：播放器能调的方法，录制端也要有。
// Every method a stage object answers to must also exist on its recording stand-in,
// or a script that plays fine starts failing (or silently doing nothing) on export.
import assert from "node:assert/strict";
import test from "node:test";

import { createStage, createStageGlobals, createStageObjects } from "../stage.js";
import {
  createRecordingObjects,
  createRecordingStage,
} from "../export-stage.js";
import { createVirtualClock } from "../export-clock.js";
import { createTimeline } from "../export-timeline.js";
import { createAudioRecorder } from "../export-audio.js";
import { createVideoRecorder } from "../export-video.js";
import { BUILTIN_GLOBALS, BULK_METHODS } from "../pamela.js";

/** 播放器对象身上不属于剧本 API 的成员：类构造器与内部实现。 */
const INTERNAL = new Set([
  "constructor",
  "applyLookValues",
  "applyTintValues",
  "place",
]);

function fakeElement() {
  const classes = new Set();
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: new Proxy({}, { set(target, key, value) { target[key] = value; return true; } }),
    get offsetWidth() { return 0; },
    childNodes: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name) { if (classes.has(name)) classes.delete(name); else classes.add(name); },
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
    play() { node.paused = false; return Promise.resolve(); },
    pause() { node.paused = true; },
    removeAttribute(name) { if (name === "src") node.src = ""; },
    setAttribute(name, value) { node[name] = value; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatch(type, event) { listeners.get(type)?.(event); },
  };
  return node;
}

/** 对象身上可调用的方法名：跟着原型链走，getter 也会读一次。 */
function methodNames(object) {
  const names = new Set();
  let current = object;
  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor) {
        continue;
      }
      if (typeof descriptor.value === "function") {
        names.add(key);
      } else if (typeof descriptor.get === "function") {
        try {
          if (typeof object[key] === "function") {
            names.add(key);
          }
        } catch {
          // 读不出来的 getter 不算一个方法。
        }
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return names;
}

/** 建一套播放器与一套录制端，两者的假 DOM 相同。 */
function harness() {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:,"),
    });
    const clock = createVirtualClock();
    const timeline = createTimeline();
    const recordingStage = createRecordingStage({ clock, timeline });
    const recording = createRecordingObjects({
      clock,
      timeline,
      recordingStage,
      assets: new Map(),
      audioRecorder: createAudioRecorder({ clock }),
      videoRecorder: createVideoRecorder({ clock }),
    });
    return {
      player: createStageObjects(stage),
      playerGlobals: createStageGlobals(stage)({ pending: [] }),
      recording,
      recordingGlobals: createStageGlobals(recordingStage, recording)({ pending: [] }),
      restore() {
        globalThis.document = previous;
      },
    };
  } catch (error) {
    globalThis.document = previous;
    throw error;
  }
}

const CASES = [
  ["Background", ["bg.png"]],
  ["Character", ["ch.png"]],
  ["Text", ["字"]],
  ["Audio", ["a.wav"]],
  ["Effect", ["rain", 1, 1, 1, 1, 1]],
  ["Video", ["v.mp4"]],
  ["Light", []],
  ["Camera", []],
];

test("every player method exists on the recording object of the same type", () => {
  const { player, recording, restore } = harness();
  try {
    for (const [kind, args] of CASES) {
      const context = { assignee: kind.toLowerCase(), pending: [] };
      const before = methodNames(player[kind](args, { ...context }));
      const after = methodNames(recording[kind](args, { ...context }));
      const missing = [...before]
        .filter((name) => !INTERNAL.has(name) && !after.has(name))
        .sort();
      assert.deepEqual(missing, [], `${kind} 的导出对象缺少这些方法：${missing.join("、")}`);
    }
  } finally {
    restore();
  }
});

test("the stage and the dialogue answer the same script vocabulary on both sides", () => {
  const { playerGlobals, recordingGlobals, restore } = harness();
  try {
    const vocabulary = new Set([...BUILTIN_GLOBALS, ...Object.keys(BULK_METHODS)]);
    const playerStage = methodNames(playerGlobals.stage);
    const recordStage = methodNames(recordingGlobals.stage);
    const missing = [...playerStage]
      .filter((name) => vocabulary.has(name) && !recordStage.has(name))
      .sort();
    assert.deepEqual(missing, [], `录制舞台缺少：${missing.join("、")}`);

    const playerDialog = methodNames(playerGlobals.dialog);
    const recordDialog = methodNames(recordingGlobals.dialog);
    assert.deepEqual(
      [...playerDialog].filter((name) => !recordDialog.has(name)).sort(),
      [],
      "对话框的方法必须一一对应",
    );
  } finally {
    restore();
  }
});

test("a video's two control tracks answer what the player's do", () => {
  const { player, recording, restore } = harness();
  try {
    const before = player.Video(["v.mp4"], { assignee: "pv", pending: [] });
    const after = recording.Video(["v.mp4"], { assignee: "rv", pending: [] });
    for (const track of ["media", "audio"]) {
      const missing = [...methodNames(before[track])]
        .filter((name) => !methodNames(after[track]).has(name))
        .sort();
      assert.deepEqual(missing, [], `Video.${track} 缺少：${missing.join("、")}`);
    }
  } finally {
    restore();
  }
});

test("audio's enable / disable are the player's play / stop", () => {
  const { player, recording, restore } = harness();
  try {
    const before = methodNames(player.Audio(["a.wav"], { assignee: "p", pending: [] }));
    const after = methodNames(recording.Audio(["a.wav"], { assignee: "r", pending: [] }));
    for (const name of ["enable", "disable"]) {
      assert.equal(before.has(name), true, `播放器本来就有 ${name}`);
      assert.equal(after.has(name), true, `导出对象也要有 ${name}`);
    }
  } finally {
    restore();
  }
});

test("a text has no tint or key frame methods, exactly like on the stage", () => {
  const { player, recording, restore } = harness();
  try {
    const before = methodNames(player.Text(["字"], { assignee: "p", pending: [] }));
    const after = methodNames(recording.Text(["字"], { assignee: "r", pending: [] }));
    for (const name of ["hex", "rgb", "rgbTo", "key", "crossFade"]) {
      assert.equal(before.has(name), false, `播放器的 Text 没有 ${name}`);
      assert.equal(after.has(name), false, `导出对象也不能多出 ${name}`);
    }
  } finally {
    restore();
  }
});
