// 三个面上的转角：舞台那一侧的落点、矩阵与快路径。
// The stage side of the H/V/W turns: where an object lands, and the fast path.

import assert from "node:assert/strict";
import test from "node:test";

import { PARAM_SPECS } from "../pamela.js";
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

const picturesOf = (created, className) =>
  created.filter((node) => node.className === className);

/** `matrix3d(...)` 里的 16 个数，按 CSS 的列主序。 */
const matrixOf = (transform) => {
  const open = transform.indexOf("matrix3d(");
  if (open < 0) {
    return null;
  }
  return transform
    .slice(open + 9, transform.indexOf(")", open))
    .split(",")
    .map((part) => Number(part));
};

test("一个没转过身的角色仍然是那条老 transform", () => {
  inFakeDom(() => {
    const { stage, created } = domStage();
    const hero = createStageObjects(stage).Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    const [picture] = picturesOf(created, "stage__character");
    assert.equal(picture.style.transform, "translate(-50%, -50%) rotate(0deg) scale(1)");
    assert.equal(picture.style.left, "50%");
    assert.equal(picture.style.top, "50%");
  });
});

test("沿三个面转过之后，transform 换成一次投影", () => {
  inFakeDom(() => {
    const { stage, created } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();

    hero.rotateH(50);
    const [ortho] = picturesOf(created, "stage__character");
    const orthoMatrix = matrixOf(ortho.style.transform);
    assert.ok(orthoMatrix, "转出 W 面要写 matrix3d");
    assert.equal(orthoMatrix[3], 0, "没开透视时没有近大远小的项");

    // 打开空间透视，同一个姿态按带灭点的投影重画。
    stage.setPerspective(true);
    const [picture] = picturesOf(created, "stage__character");
    const matrix = matrixOf(picture.style.transform);
    assert.ok(matrix, "转出 W 面要写 matrix3d");
    assert.equal(matrix.length, 16);
    // 第四行的两个透视项不为零：这就是「近大远小」，纯仿射写不出来。
    assert.notEqual(matrix[3], 0);
    assert.notEqual(matrix[11], 1, "第三行第三列的 w 是 CD + z");

    // 转回 W 面里，又回到那条老路 —— 快路径不是只给「从没写过」的对象。
    hero.rotateHTo(0);
    assert.equal(
      picturesOf(created, "stage__character")[0].style.transform,
      "translate(-50%, -50%) rotate(0deg) scale(1)",
    );
  });
});

test("rotateH 与 rotateV 各自累加，…To 才是赋值", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const hero = createStageObjects(stage).Character(["hero.png"], { assignee: "hero" });
    assert.equal(hero.angleH, 0, "默认躺在 W 面里");
    assert.equal(hero.angleV, 0);

    hero.rotateH(30).rotateH(20);
    assert.equal(hero.angleH, 50);
    hero.rotateHTo(15);
    assert.equal(hero.angleH, 15);

    hero.rotateV(-40).rotateV(10);
    assert.equal(hero.angleV, -30);
    hero.rotateVTo(0);
    assert.equal(hero.angleV, 0);

    // 三个角互不干扰：W 面的自转还是原来那一支。
    hero.rotate(90);
    assert.equal(hero.rotation, 90);
    assert.equal(hero.angleH, 15);
  });
});

test("构造时可以直接给两个转角", () => {
  inFakeDom(() => {
    const { stage, created } = domStage();
    const objects = createStageObjects(stage);
    // 参数按 PARAM_SPECS 的位置传：两个转角排在最后，位置随时可以变，
    // 所以这里按名字查。
    const args = new Array(PARAM_SPECS.Character.length).fill(undefined);
    args[0] = "hero.png";
    args[PARAM_SPECS.Character.indexOf("rotateH")] = 35;
    args[PARAM_SPECS.Character.indexOf("rotateV")] = -20;

    const hero = objects.Character(args, { assignee: "hero" });
    hero.enable();
    assert.equal(hero.angleH, 35);
    assert.equal(hero.angleV, -20);
    // 一建出来就是转过的姿态，不需要额外调用。
    assert.ok(matrixOf(picturesOf(created, "stage__character")[0].style.transform));
  });
});

test("换一张表情不会把角色转回正面", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    hero.rotateH(40).rotateV(25);

    // 换表情就是重建同一个槽位上的变量：姿态跟着槽位一起交给新的那一份。
    const rebuilt = objects.Character(["calm.png"], { assignee: "hero" });
    assert.equal(rebuilt.angleH, 40);
    assert.equal(rebuilt.angleV, 25);
  });
});
