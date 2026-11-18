// `hide().enable().show(ms)` 写在同一条链里时，show 不能变成瞬现。
//
// 根因：链式调用逐环等待，但 `enable()` 过去不报告它启动的异步加载，于是
// `show(ms)` 紧接着在图片还隐藏、还没解码时执行 —— CSS 透明度过渡走在一张
// 看不见的图上，等它露面时动画已经结束。修复是让 `enable()` 把图片就绪交给
// 解释器等待，下一环 `show(ms)` 便在一张可见、已解码的图上起跑渐显。

import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../pamela.js";
import {
  createStage,
  createStageGlobals,
  createStageObjects,
} from "../stage.js";

/** 一个可手动兑现/拒绝的 Promise，用来卡住图片解码的时机。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 够 createStage 用的 stand-in 元素，带父子链和图片解码接口。 */
function fakeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    dataset: {},
    style: {},
    childNodes: [],
    parentNode: null,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    replaceChildren(...children) {
      node.childNodes = children;
      for (const child of children) {
        if (child) {
          child.parentNode = node;
        }
      }
    },
    append(child) {
      node.childNodes.push(child);
      child.parentNode = node;
    },
    replaceChild(fresh, old) {
      const index = node.childNodes.indexOf(old);
      if (index >= 0) {
        node.childNodes[index] = fresh;
      }
      fresh.parentNode = node;
    },
    removeAttribute() {},
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener() {},
    decode: () => Promise.resolve(),
    naturalWidth: 100,
    naturalHeight: 100,
    width: 0,
    height: 0,
    src: "",
    alt: "",
    draggable: false,
    hidden: false,
    textContent: "",
    get offsetWidth() {
      return 0;
    },
    get offsetHeight() {
      return 0;
    },
    clientWidth: 0,
    clientHeight: 0,
    scrollWidth: 0,
    scrollHeight: 0,
  };
  return node;
}

/** 让若干轮微任务跑完。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 在假 DOM 上搭一个舞台：resolveAsset 由测试控制，图片元素的 style.opacity
 * 写入被记录下来，用来判断 show 到底在什么时候起跑。
 */
function setup() {
  const asset = deferred();
  const surface = fakeNode("div");
  const writesByNode = new WeakMap();
  globalThis.document = {
    createElement: (tag) => {
      const node = fakeNode(tag);
      const writes = [];
      writesByNode.set(node, writes);
      node.style = new Proxy(node.style, {
        set(target, property, value) {
          if (property === "opacity") {
            writes.push(value);
          }
          target[property] = value;
          return true;
        },
      });
      return node;
    },
  };
  const stage = createStage({
    element: fakeNode("div"),
    surface,
    resolveAsset: () => asset.promise,
  });
  const constructs = createStageObjects(stage);
  const constructors = {};
  for (const [kind, make] of Object.entries(constructs)) {
    constructors[kind] = (args, context) => make(args, context);
  }
  const picture = () => surface.childNodes[1]?.childNodes[0];
  const writes = () => writesByNode.get(picture()) ?? [];
  return {
    asset,
    stage,
    globals: createStageGlobals(stage),
    constructors,
    picture,
    writes,
  };
}

test("一条链 hide().enable().show(ms)：show 等到图片露面后才起跑", async () => {
  const previous = globalThis.document;
  try {
    const { asset, globals, constructors, picture, writes } = setup();
    const running = run('ch = Character("hero.png")\nch.hide().enable().show(40)', {
      globals,
      constructors: { Character: constructors.Character },
    });

    // 让 enable 的机会跑起来，但图片还没兑现。
    await tick();
    assert.ok(picture(), "enable 已经建好图片元素");
    assert.equal(picture().style.visibility, "hidden", "图还没解码，仍隐藏");
    const before = writes().length;

    // 兑现图片：reveal 之后，链才继续到 show。
    asset.resolve("data:image/png;base64,AAAA");
    const result = await running;

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(picture().style.visibility, "", "图已露面");
    assert.equal(picture().style.opacity, "", "show 把透明度带到 1");
    // show 起跑时图已可见：它写下的过渡一定晚于 reveal。若没有等待，show
    // 会在这之前就把 opacity 写成 1（reveal 前就能看到这次写入）。
    const revealWrites = writes().slice(before);
    assert.ok(revealWrites.length >= 1, "show 的透明度写入发生在露面之后");
  } finally {
    globalThis.document = previous;
  }
});

test("图片加载失败时不会让 enable 后的链永久挂起", async () => {
  const previous = globalThis.document;
  try {
    const { asset, globals, constructors } = setup();
    const running = run('ch = Character("hero.png")\nch.hide().enable().show(40)', {
      globals,
      constructors: { Character: constructors.Character },
    });
    await tick();
    asset.reject(new Error("missing"));
    const result = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve({ error: new Error("stuck") }), 200)),
    ]);
    assert.notEqual(result.error?.message, "stuck", "链在失败后被放行，而不是卡住");
  } finally {
    globalThis.document = previous;
  }
});
