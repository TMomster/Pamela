// 舞台上的逐帧图片组：空定义、换帧与暂停。
// Tests for sprite groups on the real stage, over the fake DOM.

import assert from "node:assert/strict";
import test from "node:test";

import { createStage, createStageObjects } from "../stage.js";

/** A stand-in element with the parent links the stage's swaps need. */
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
      if (child) {
        child.parentNode = node;
      }
    },
    replaceChild(fresh, old) {
      const index = node.childNodes.indexOf(old);
      if (index >= 0) {
        node.childNodes[index] = fresh;
      }
      if (fresh) {
        fresh.parentNode = node;
      }
      if (old) {
        old.parentNode = null;
      }
      return old;
    },
    decode: () => Promise.resolve(),
    naturalWidth: 2,
    naturalHeight: 2,
    width: 0,
    height: 0,
    src: "",
    alt: "",
    draggable: false,
    hidden: false,
    textContent: "",
    setAttribute(name, value) {
      node[name] = value;
    },
    removeAttribute(name) {
      delete node[name];
    },
    addEventListener() {},
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

async function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    createElementNS: (_namespace, tag) => fakeNode(tag),
    createTextNode: (text) => ({ textContent: text }),
  };
  try {
    return await body();
  } finally {
    globalThis.document = previous;
  }
}

/** A stage whose reader turns a picture path into a URL a test can read back. */
function build() {
  const surface = fakeNode("div");
  const stage = createStage({
    element: fakeNode("div"),
    surface,
    resolveAsset: (path) => Promise.resolve(`asset://${path}`),
  });
  return { stage, surface, objects: createStageObjects(stage) };
}

/** A run context: `fps` reports its wait here, as the interpreter does. */
const runContext = () => ({ pending: [], assignee: "cg" });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("an empty definition holds a blank slot, and group fills it in", async () => {
  await inFakeDom(async () => {
    const { surface, objects } = build();
    const layer = surface.childNodes[1];

    const cg = objects.Character([""], runContext());
    cg.enable();
    const picture = layer.childNodes[0];
    assert.equal(picture.tagName, "IMG");
    assert.equal(picture.src, undefined, "空定义不画图");

    cg.group("a.png", "b.png");
    await settle();
    assert.equal(layer.childNodes[0], picture, "换图不该换掉元素，位置与过渡要留着");
    assert.equal(picture.src, "asset://a.png", "group 之后停在第 1 张");
  });
});

test("fps plays the group in order, and pause holds a named picture", async () => {
  await inFakeDom(async () => {
    const { surface, objects } = build();
    const layer = surface.childNodes[1];

    const cg = objects.Character([""], runContext());
    cg.group("a.png", "b.png", "c.png");
    cg.enable();
    const picture = layer.childNodes[0];
    await settle();
    assert.equal(picture.src, "asset://a.png");

    cg.fps(144); // 两帧各约 7 毫秒
    await pause(40);
    assert.equal(picture.src, "asset://c.png", "一遍播完停在最后一张");

    cg.pause(1);
    await settle();
    assert.equal(picture.src, "asset://b.png", "暂停可以指定组里的某一张");

    cg.pause("extra.png");
    await settle();
    assert.equal(picture.src, "asset://extra.png", "也可以停在组外的一张图");
    assert.deepEqual(cg.sprite.paths(), ["a.png", "b.png", "c.png"], "组本身没变");
  });
});

test("a loop keeps changing pictures until it is paused", async () => {
  await inFakeDom(async () => {
    const { surface, objects } = build();
    const layer = surface.childNodes[1];

    const cg = objects.Character([""], runContext());
    cg.group("a.png", "b.png");
    cg.enable();
    const picture = layer.childNodes[0];

    cg.fps(144, true);
    await pause(40);
    const during = picture.src;
    cg.pause();
    await settle();
    const stopped = picture.src;
    await pause(30);
    assert.equal(picture.src, stopped, "暂停之后不再换图");
    assert.ok(["asset://a.png", "asset://b.png"].includes(during));
  });
});

test("rebuilding a variable stops the old playback on that slot", async () => {
  await inFakeDom(async () => {
    const { surface, objects } = build();
    const layer = surface.childNodes[1];

    const first = objects.Character([""], runContext());
    first.group("a.png", "b.png");
    first.enable();
    first.fps(144, true);
    await pause(20);

    const second = objects.Character(["still.png"], runContext());
    second.enable();
    await settle();
    const picture = layer.childNodes[0];
    assert.equal(picture.src, "asset://still.png");

    const count = layer.childNodes.length;
    await pause(30);
    assert.equal(picture.src, "asset://still.png", "旧播放器已经停下，不会把图换回去");
    assert.equal(layer.childNodes.length, count);
  });
});
