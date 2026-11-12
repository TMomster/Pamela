// 舞台预览测试。
// Run directly: node ui/tests/stage-preview.test.js
// 直接运行：node ui/tests/stage-preview.test.js

import assert from "node:assert/strict";
import test from "node:test";

import { createStage } from "../stage.js";

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

test("applyPreviewState poses a key frame onto the preview object", () => {
  inFakeDom(() => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => null,
    });
    assert.doesNotThrow(() => {
      stage.applyPreviewState("background", {
        x: 10,
        y: 20,
        rotation: 30,
        scale: 1.5,
        scaleX: 2,
        scaleY: 0.5,
        alpha: 0.4,
      });
    });
  });
});

test("applyPreviewState ignores an object the stage does not hold", () => {
  inFakeDom(() => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => null,
    });
    assert.doesNotThrow(() => {
      stage.applyPreviewState("no-such-slot", { x: 1, rotation: 90 });
    });
  });
});

// `playKey` lives outside `createStage`, so it must ask the stage for the spin
// it adds back when a key walk ends. Reaching for the closure's `slotOf` there
// is a ReferenceError that only shows up once a script actually calls `key()`.
test("spinOf is on the stage, and an unknown target has no spin", () => {
  inFakeDom(() => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => null,
    });
    assert.equal(typeof stage.spinOf, "function");
    assert.equal(stage.spinOf("background"), 0);
    assert.equal(stage.spinOf("no-such-slot"), 0);
  });
});

/** A stand-in `<img>` whose bitmap reports a known size and decodes at once. */
function fakeImage(width = 800, height = 600) {
  const node = fakeElement();
  node.naturalWidth = width;
  node.naturalHeight = height;
  node.decode = () => Promise.resolve();
  return node;
}

/** Keeps the fake `document` in place until the asynchronous load has settled. */
async function inFakeDomAsync(body) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => (tag === "img" ? fakeImage() : fakeElement()),
    createElementNS: () => fakeElement(),
  };
  try {
    return await body();
  } finally {
    globalThis.document = previous;
  }
}

// The key frame editor opens while the picture is still decoding. At that point
// `objectBox` can only answer the frame (the whole editing area), so the outline
// it draws is wrong until the first drag happens to re-render it. The stage now
// tells its host the moment the real rectangle is known.
test("onObjectBox fires when the bitmap's real rectangle is known", async () => {
  await inFakeDomAsync(async () => {
    const noticed = [];
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => "data:image/png;base64,x",
      onObjectBox: (name) => noticed.push(name),
    });

    stage.setCharacter("ch", "ch.png");
    const before = stage.objectBox("ch");
    assert.ok(before, "对象一启用就带 box，只是暂时是整个 frame");
    assert.equal(before.width, 1920, "解码前只能按整个舞台回答");

    // `load` resolves the asset and decodes over a short promise chain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(noticed, ["ch"], "通知带上了对象名");
    const after = stage.objectBox("ch");
    assert.equal(after.width, 1440, "800×600 按 contain 放进 1920×1080");
    assert.equal(after.height, 1080);
    assert.ok(after.width < before.width, "轮廓不再等于整个编辑区");
  });
});

test("a host that ignores onObjectBox keeps working", async () => {
  await inFakeDomAsync(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => "data:image/png;base64,x",
    });
    assert.doesNotThrow(() => stage.setCharacter("ch", "ch.png"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stage.objectBox("ch").width, 1440);
  });
});
