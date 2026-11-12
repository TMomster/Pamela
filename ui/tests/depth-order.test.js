// 深度排序：背景与角色共用一套顺序，结果写在元素的 z-index 上。
// Tests for the scene-level depth order the stage writes as z-index.

import assert from "node:assert/strict";
import test from "node:test";

import { createStage, createStageObjects } from "../stage.js";

/** A stand-in element, with just enough of the DOM for `createStage`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: new Proxy(
      {},
      {
        set(target, key, value) {
          target[key] = value;
          return true;
        },
      },
    ),
    get offsetWidth() {
      return 0;
    },
    childNodes: [],
    classList: { toggle() {} },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    replaceChildren(...children) {
      node.childNodes = children;
    },
    append(child) {
      node.childNodes.push(child);
    },
    decode() {
      return Promise.resolve();
    },
    hidden: false,
    alt: "",
    draggable: false,
    src: "",
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

/** A stage over the fake DOM, recording every element the objects build. */
function domStage() {
  const surface = fakeElement();
  const stage = createStage({
    element: fakeElement(),
    surface,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
  });
  const created = [];
  const make = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const node = make(tag);
    created.push(node);
    return node;
  };
  return { stage, surface, created };
}

/** 背景层与角色层在 `surface.childNodes` 里的位置，建台时固定。 */
const backdropLayer = (surface) => surface.childNodes[0];
const characterLayer = (surface) => surface.childNodes[1];

const zOf = (node) => Number(node.style.zIndex);

/** The image elements in creation order — the mesh pieces have their own class. */
const picturesOf = (created, className) =>
  created.filter((node) => node.className === className);

test("a backdrop can stand in front of a character, and be pushed back again", () => {
  inFakeDom(() => {
    const { stage, surface, created } = domStage();
    const objects = createStageObjects(stage);
    const bg = objects.Background(["street.png"], { assignee: "bg" });
    bg.enable();
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();

    const [backdrop] = picturesOf(created, "stage__background");
    const [picture] = picturesOf(created, "stage__character");
    assert.equal(typeof bg.z, "function", "深度字段不能盖住 z() 方法");

    // z=0 时背景在下：这是没写过 z 的剧本原来的观感。
    assert.ok(zOf(backdrop) < zOf(picture));

    // 背景朝观众拉近，就盖到角色前面。
    bg.zTo(-80);
    assert.ok(zOf(backdrop) > zOf(picture), "负 z 的背景要盖住角色");

    // 再推回去，又回到角色后面。
    bg.zTo(600);
    assert.ok(zOf(backdrop) < zOf(picture), "正 z 更大时角色在前");
  });
});

test("swapping two characters' depth swaps their z-index, not their entry order", () => {
  inFakeDom(() => {
    const { stage, created } = domStage();
    const objects = createStageObjects(stage);
    const first = objects.Character(["first.png"], { assignee: "first" });
    first.enable();
    const second = objects.Character(["second.png"], { assignee: "second" });
    second.enable();

    const [firstPicture, secondPicture] = picturesOf(created, "stage__character");
    assert.ok(zOf(firstPicture) < zOf(secondPicture), "同 z 时按入场序");

    second.zTo(200);
    assert.ok(zOf(secondPicture) < zOf(firstPicture), "推远的角色先画");

    second.zTo(0);
    first.zTo(200);
    assert.ok(zOf(firstPicture) < zOf(secondPicture), "换回来时序号也跟着换");
  });
});

test("front() wins when the depth is equal", () => {
  inFakeDom(() => {
    const { stage, created } = domStage();
    const objects = createStageObjects(stage);
    const a = objects.Character(["a.png"], { assignee: "a" });
    a.enable();
    const b = objects.Character(["b.png"], { assignee: "b" });
    b.enable();

    const [aPicture, bPicture] = picturesOf(created, "stage__character");
    assert.ok(zOf(aPicture) < zOf(bPicture));

    a.front();
    assert.ok(zOf(aPicture) > zOf(bPicture), "置前压过同 z 的入场序");

    a.back();
    assert.ok(zOf(aPicture) < zOf(bPicture), "置后又回到最下面");
  });
});

test("a character's mesh keeps the same number as its picture", () => {
  inFakeDom(() => {
    const { stage, surface, created } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    hero.zTo(300);

    const [picture] = picturesOf(created, "stage__character");
    const mesh = characterLayer(surface).childNodes.find(
      (node) => node.className === "stage__mesh",
    );
    assert.ok(mesh, "角色入场时就建好了网格");
    assert.equal(zOf(mesh), zOf(picture), "两者只会显示一个，序号必须一致");
  });
});

test("a stage with no depth at all keeps the backdrop under the characters", () => {
  inFakeDom(() => {
    const { stage, surface, created } = domStage();
    const objects = createStageObjects(stage);
    objects.Background(["street.png"], { assignee: "bg" }).enable();
    objects.Character(["a.png"], { assignee: "a" }).enable();
    objects.Character(["b.png"], { assignee: "b" }).enable();

    const [backdrop] = picturesOf(created, "stage__background");
    const [aPicture, bPicture] = picturesOf(created, "stage__character");
    assert.equal(zOf(backdrop), 0);
    assert.equal(zOf(aPicture), 1);
    assert.equal(zOf(bPicture), 2);
    assert.equal(
      characterLayer(surface).childNodes.length,
      4,
      "两张立绘各带一个网格，序号的改动不删元素",
    );
    assert.equal(backdropLayer(surface).childNodes.length, 1);
  });
});

test("a backdrop starts one step deeper than a character, so it is never on top", () => {
  inFakeDom(() => {
    const { stage, created } = domStage();
    const objects = createStageObjects(stage);
    const bg = objects.Background(["street.png"], { assignee: "bg" });
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    assert.equal(bg.depth, 1, "背景默认比角色远一层");
    assert.equal(hero.depth, 0);

    bg.enable();
    hero.enable();
    const [backdrop] = picturesOf(created, "stage__background");
    const [picture] = picturesOf(created, "stage__character");
    assert.ok(zOf(backdrop) < zOf(picture), "角色一建出来就在背景前面");
  });
});

test("h / v are the same calls as x / y on every object that has a position", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const bg = objects.Background(["a.png"], { assignee: "bg" });
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    const label = objects.Text(["字"], { assignee: "label" });
    const lamp = objects.Light([], { assignee: "lamp" });

    for (const object of [bg, hero, label, lamp]) {
      for (const name of ["h", "hTo", "v", "vTo"]) {
        assert.equal(typeof object[name], "function", `每个可移动对象都要有 ${name}`);
      }
    }

    hero.enable();
    hero.h(40);
    assert.equal(hero.px, 40, "h 与 x 落在同一个位置");
    hero.v(-30);
    assert.equal(hero.py, -30, "v 与 y 落在同一个位置");
    hero.hTo(10);
    assert.equal(hero.px, 10);
    assert.equal(hero.py, -30, "hTo 不动 V");
    hero.vTo(0);
    assert.equal(hero.py, 0);
    assert.equal(hero.depth, 0, "横纵移动不动深度");
  });
});

test("z is relative and accumulates; zTo is absolute", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    assert.equal(hero.depth, 0, "a new character starts at depth 0");
    hero.z(100);
    assert.equal(hero.depth, 100, "z(100) pushes depth to 100 (relative)");
    hero.z(50);
    assert.equal(hero.depth, 150, "z(50) accumulates on top of the current depth");
    hero.zTo(0);
    assert.equal(hero.depth, 0, "zTo(0) snaps the depth back to 0 (absolute)");
  });
});

test("x and y move relatively; xTo and yTo set absolutely", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    assert.equal(hero.px, 0);
    assert.equal(hero.py, 0);
    hero.x(40);
    assert.equal(hero.px, 40, "x(40) shifts right by 40");
    hero.y(-30);
    assert.equal(hero.py, -30, "y(-30) shifts up by -30");
    hero.xTo(10);
    assert.equal(hero.px, 10, "xTo(10) snaps x to 10");
    assert.equal(hero.py, -30, "xTo leaves y untouched");
    hero.yTo(0);
    assert.equal(hero.py, 0, "yTo(0) snaps y to 0");
  });
});
