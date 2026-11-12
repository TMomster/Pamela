// 舞台标签关闭的回归测试：手动关闭与出错崩溃后自动关闭。
// Regression guards for closing the stage tab, by hand and after a crash.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createStage } from "../stage.js";

const ui = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFileSync(path.join(ui, name), "utf8");

test("错误上报读取解构出的 path，不再因未定义变量抛 ReferenceError", () => {
  const main = read("main.js");
  assert.match(main, /function reportScriptError\(error, \{ path \} = \{\}\)/);
  assert.match(main, /const target = info\.file \|\| path;/);
  assert.doesNotMatch(main, /const target = info\.file \|\| options/);
  // 跳转失败也不能变成新的未处理 rejection，否则清理链会再次断掉。
  assert.match(main, /void openFile\(target\)\.catch\(\(\) => \{\}\)/);
});

test("关闭舞台时任何清理步骤抛错，会话状态仍会在 finally 里复位", () => {
  const main = read("main.js");
  const discard = main.slice(
    main.indexOf("function discardStage()"),
    main.indexOf("function stopRun()"),
  );
  assert.ok(discard.length > 0);
  assert.match(main, /function discardStageSafely\(step\)/);
  // 连舞台自身的 clear 都是隔离的：坏掉的舞台不能跳过后面的状态复位。
  assert.match(discard, /discardStageSafely\(\(\) => stage\?\.clear\(\)\)/);
  assert.match(discard, /\} finally \{/);
  const final = discard.slice(discard.indexOf("} finally {"));
  assert.match(final, /runCount \+= 1;/);
  assert.match(final, /session\.running = false;/);
  assert.match(final, /session\.stageName = null;/);
  assert.match(final, /session\.view = /);
});

test("点 × 关标签时，即使重绘抛错也会先移除标签节点", () => {
  const main = read("main.js");
  const close = main.slice(
    main.indexOf("function closeStage()"),
    main.indexOf("function isEditorDirty()"),
  );
  assert.ok(close.length > 0);
  assert.match(close, /\} finally \{/);
  assert.match(close, /\.tab--stage/);
  assert.match(close, /dom\.stageView\.hidden = true/);
  assert.match(close, /discardStageSafely\(refreshEditor\)/);
});

test("运行出错或舞台崩溃都会自动关闭标签", () => {
  const main = read("main.js");
  // 脚本错误：报告之后关掉舞台，标签不会留在标签条上。
  assert.match(
    main,
    /if \(result\.error\) \{[\s\S]*?reportScriptError\(result\.error, \{ path \}\);[\s\S]*?closeStage\(\);/,
  );
  // 运行链上抛出的异常：连错误上报失败也保证关标签。
  assert.match(
    main,
    /async function performScript\(source, options\) \{[\s\S]*?catch \(error\) \{[\s\S]*?\} finally \{\s*closeStage\(\);/,
  );
  // 舞台的帧回调 / 媒体事件抛错时，没有 Promise 链可以兜底，靠全局监听。
  assert.match(main, /window\.addEventListener\("error", closeCrashedStage\)/);
  assert.match(main, /window\.addEventListener\("unhandledrejection", closeCrashedStage\)/);
});

/** A stand-in element, with just enough of the DOM for `createStage`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: {},
    childNodes: [],
    classList: { toggle() {} },
    get offsetWidth() {
      return 0;
    },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    replaceChildren(...children) {
      node.childNodes = children;
    },
    append(child) {
      node.childNodes.push(child);
    },
    hidden: false,
    textContent: "",
    removeAttribute(name) {
      node[name] = "";
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
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
  return node;
}

/** Runs `body` with a minimal `document`, so a stage can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

test("舞台某层已损坏时，clear 仍能清完其余子系统并可再次开演", () => {
  inFakeDom(() => {
    const surface = fakeElement();
    const stage = createStage({
      element: fakeElement(),
      surface,
      resolveAsset: () => null,
    });
    const backgroundNode = surface.childNodes[0];
    const characterNode = surface.childNodes[1];
    const original = characterNode.replaceChildren.bind(characterNode);
    let characterCleared = false;
    characterNode.replaceChildren = (...children) => {
      characterCleared = true;
      return original(...children);
    };
    backgroundNode.replaceChildren = () => {
      throw new Error("layer is gone");
    };

    const reported = [];
    const previousError = console.error;
    console.error = (...args) => reported.push(args);
    try {
      assert.doesNotThrow(() => stage.clear());
      // A re-launch resets the very same stage instance; a half-cleared one
      // used to throw here.
      assert.doesNotThrow(() => stage.reset("again"));
    } finally {
      console.error = previousError;
    }
    assert.equal(characterCleared, true);
    assert.ok(
      reported.some(([, error]) => error?.message === "layer is gone"),
      "the broken layer should be reported, not swallowed silently",
    );
  });
});
