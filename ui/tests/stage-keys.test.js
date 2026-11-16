// 舞台键盘快捷键的测试：推进、自动、全屏、存读档、设置、按住快进、回看。
// Tests for the stage's keyboard shortcuts.

import assert from "node:assert/strict";
import test from "node:test";

import { ADVANCE_KEYS, createStageKeys, isTextEntry } from "../stage-keys.js";

/** A document that records its listeners and can deliver key events. */
function fakeDoc({ modal = false } = {}) {
  const listeners = {};
  return {
    listeners,
    querySelector: (selector) => (selector === ".modal-overlay" && modal ? {} : null),
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== fn);
    },
    /** Delivers one event; answers whether `preventDefault` was called. */
    key(type, event = {}) {
      let prevented = false;
      const full = {
        repeat: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        defaultPrevented: false,
        ...event,
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const fn of [...(listeners[type] || [])]) {
        fn(full);
      }
      return prevented;
    },
  };
}

/** Builds the shortcut layer over a recording stage and a fake document. */
function harness({ active = true, canAdvance = true, modal = false } = {}) {
  const calls = [];
  const stage = {
    advance: () => calls.push("advance"),
    setSkipHold: (on) => calls.push(`skip:${on}`),
  };
  const doc = fakeDoc({ modal });
  const keys = createStageKeys({
    doc,
    getStage: () => stage,
    isActive: () => active,
    canAdvance: () => canAdvance,
    toggleAuto: () => calls.push("auto"),
    toggleFullscreen: () => calls.push("fullscreen"),
    openSave: () => calls.push("save"),
    openLoad: () => calls.push("load"),
    openSettings: () => calls.push("settings"),
    toggleBacklog: () => calls.push("backlog"),
  });
  return { calls, doc, keys };
}

test("advance keys are Space, Down and Enter", () => {
  assert.ok(ADVANCE_KEYS.includes(" "));
  assert.ok(ADVANCE_KEYS.includes("ArrowDown"));
  assert.ok(ADVANCE_KEYS.includes("Enter"));
});

test("Space, Down and Enter advance the line and swallow the key", () => {
  const { calls, doc } = harness();
  for (const key of [" ", "ArrowDown", "Enter", "NumpadEnter"]) {
    assert.equal(doc.key("keydown", { key }), true, `${key} 应 preventDefault`);
    assert.deepEqual(calls, ["advance"]);
    calls.length = 0;
  }
});

test("advance is left to the panel when the scene is covered", () => {
  const { calls, doc } = harness({ canAdvance: false });
  assert.equal(doc.key("keydown", { key: " " }), false);
  assert.deepEqual(calls, []);
});

test("letters open the stage menu's panels", () => {
  const { calls, doc } = harness();
  const cases = { a: "auto", f: "fullscreen", s: "save", d: "load", o: "settings" };
  for (const [key, action] of Object.entries(cases)) {
    assert.equal(doc.key("keydown", { key }), true, `${key} 应 preventDefault`);
    assert.deepEqual(calls, [action]);
    calls.length = 0;
  }
});

test("a shortcut with a modifier belongs to the editor, not the stage", () => {
  const { calls, doc } = harness();
  for (const event of [
    { key: "s", ctrlKey: true },
    { key: "S", shiftKey: true },
    { key: "a", altKey: true },
    { key: "f", metaKey: true },
  ]) {
    doc.key("keydown", event);
  }
  assert.deepEqual(calls, []);
});

test("Up toggles the backlog once per press", () => {
  const { calls, doc } = harness();
  assert.equal(doc.key("keydown", { key: "ArrowUp" }), true);
  assert.deepEqual(calls, ["backlog"]);
  calls.length = 0;
  doc.key("keydown", { key: "ArrowUp", repeat: true });
  assert.deepEqual(calls, [], "按住不放不反复开合");
});

test("holding Ctrl fast-forwards and releasing it stops", () => {
  const { calls, doc } = harness();
  doc.key("keydown", { key: "Control" });
  doc.key("keydown", { key: "Control", repeat: true });
  doc.key("keyup", { key: "Control" });
  assert.deepEqual(calls, ["skip:true", "skip:false"]);

  // 已经松开的重复事件不会重复写入。
  doc.key("keyup", { key: "Control" });
  assert.deepEqual(calls, ["skip:true", "skip:false"]);
});

test("Ctrl is not a stage key while the stage is off screen, but it is released", () => {
  const { calls, doc } = harness({ active: false });
  doc.key("keydown", { key: "Control" });
  assert.deepEqual(calls, []);
  doc.key("keyup", { key: "Control" });
  assert.deepEqual(calls, []);
});

test("nothing happens while the stage is off screen", () => {
  const { calls, doc } = harness({ active: false });
  for (const key of [" ", "ArrowDown", "ArrowUp", "a", "f", "s", "d", "o"]) {
    doc.key("keydown", { key });
  }
  assert.deepEqual(calls, []);
});

test("keys typed into a field stay in the field", () => {
  const { calls, doc } = harness();
  const input = { tagName: "INPUT" };
  doc.key("keydown", { key: " ", target: input });
  doc.key("keydown", { key: "s", target: input });
  doc.key("keydown", { key: "Control", target: input });
  assert.deepEqual(calls, []);
  assert.equal(isTextEntry(input), true);
});

test("the hidden editor behind the stage does not own the keys", () => {
  // 运行剧本时编辑区被 hidden 收起，焦点可能还留在里面；`closest` 说它在隐藏
  // 的子树里，键就该归舞台。
  const hiddenField = { tagName: "TEXTAREA", closest: () => ({}) };
  assert.equal(isTextEntry(hiddenField), false);
});

test("a window-level dialog owns the keys while it is up", () => {
  const { calls, doc } = harness({ modal: true });
  doc.key("keydown", { key: " " });
  doc.key("keydown", { key: "a" });
  doc.key("keydown", { key: "Control" });
  assert.deepEqual(calls, []);
});

test("a key already answered closer to the target is left alone", () => {
  const { calls, doc } = harness();
  doc.key("keydown", { key: " ", defaultPrevented: true });
  doc.key("keydown", { key: "a", defaultPrevented: true });
  assert.deepEqual(calls, []);
});

test("dispose removes every listener and drops a held skip", () => {
  const { calls, doc, keys } = harness();
  doc.key("keydown", { key: "Control" });
  keys.dispose();
  assert.equal(keys.isHoldingSkip(), false);
  assert.deepEqual(calls, ["skip:true", "skip:false"]);
  doc.key("keydown", { key: " " });
  assert.deepEqual(calls, ["skip:true", "skip:false"]);
  assert.equal(doc.listeners.keydown.length, 0);
  assert.equal(doc.listeners.keyup.length, 0);
});
