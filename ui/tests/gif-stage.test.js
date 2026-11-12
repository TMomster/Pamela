// 舞台 GIF 显示路径测试。
// Tests for the stage's GIF display path.

import assert from "node:assert/strict";
import test from "node:test";

import { createStage } from "../stage.js";

/** A one-frame 2x2 GIF, as the asset cache would inline it into a `data:` URL. */
const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
  0x02, 0x00, 0x02, 0x00, 0x81, 0x00, 0x00, // 2x2, GCT of 4
  0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00,
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // delay 100ms
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
  0x02, 0x03, 0x44, 0x34, 0x05, 0x00,
  0x3b,
]);

const GIF_URL = `data:image/gif;base64,${Buffer.from(GIF_BYTES).toString("base64")}`;
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

/** Packs LZW codes at a fixed width, least significant bit first, as a GIF does. */
function packCodes(codes, size = 3) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const code of codes) {
    buffer |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(buffer & 0xff);
      buffer >>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) {
    bytes.push(buffer & 0xff);
  }
  return bytes;
}

/**
 * A 2x2 gif whose frames are each one flat colour.
 *
 * Every frame carries its own colour table, so the second frame paints the whole
 * picture over the first — which is what makes "which frame is showing"
 * something a test can read back from the canvas. A clear code before every
 * pixel keeps the code width at three bits, so the packing stays simple.
 */
function buildFrames(colors) {
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x02, 0x00, 0x81, 0x00, 0x00];
  // A global colour table is required by the header above; the frames below
  // each override it with their own.
  bytes.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  for (const [r, g, b] of colors) {
    bytes.push(0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00); // delay 100ms
    bytes.push(0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x81);
    bytes.push(r, g, b, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const data = packCodes([4, 0, 4, 0, 4, 0, 4, 0, 5]);
    bytes.push(0x02, data.length, ...data, 0x00);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

const TWO_FRAME_URL = `data:image/gif;base64,${Buffer.from(
  buildFrames([
    [255, 0, 0],
    [0, 255, 255],
  ]),
).toString("base64")}`;

/** A stand-in element with the parent links the GIF canvas swap needs. */
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
  if (node.tagName === "CANVAS") {
    // The context is kept, and every frame painted through it is copied out, so
    // a test can say *which* frame the canvas is showing rather than only that
    // some frame was drawn.
    node.painted = [];
    node.ctx = {
      createImageData: (width, height) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData(data) {
        node.painted.push(Uint8ClampedArray.from(data.data));
      },
    };
    node.getContext = () => node.ctx;
  }
  return node;
}

/** Runs an async body with a minimal DOM, held until the loads have settled. */
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

/** A stage whose reader answers a data URL chosen by the path it is given. */
function build(resolveAsset = () => Promise.resolve(GIF_URL)) {
  const surface = fakeNode("div");
  const stage = createStage({ element: fakeNode("div"), surface, resolveAsset });
  return { stage, surface };
}

/** Lets the promise chain inside `load` and `decode()` run to the end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("背景 GIF 解码成画布后不再被隐藏", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build();
    stage.setBackground("bg.gif");
    await settle();

    const canvas = surface.childNodes[0].childNodes[0];
    assert.equal(canvas.tagName, "CANVAS", "GIF 应该由画布逐帧绘制");
    assert.equal(canvas.style.visibility, "", "hidden 必须被清掉，否则舞台上看不见");
    assert.equal(canvas.width, 2);
    assert.equal(canvas.height, 2);

    // Freeze it, so no playback timer outlives the test.
    stage.stepGif("background", 1);
  });
});

test("角色 GIF 显示出来，并且可以从 GIF 换回静态图", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build((path) =>
      Promise.resolve(String(path).endsWith(".gif") ? GIF_URL : PNG_URL),
    );
    const layer = surface.childNodes[1];

    stage.setCharacter("ch", "hero.gif");
    await settle();
    const canvas = layer.childNodes[0];
    assert.equal(canvas.tagName, "CANVAS");
    assert.equal(canvas.style.visibility, "");

    stage.setCharacter("ch", "hero.png");
    await settle();
    const image = layer.childNodes[0];
    assert.equal(image.tagName, "IMG", "上一张 GIF 的画布要换回 img");
    assert.equal(image.src, PNG_URL);
    assert.equal(image.style.visibility, "");
  });
});

test("GIF 上台前写的动画留在同一块画布上，不会被换元素冲掉", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build();
    const layer = surface.childNodes[1];
    stage.setCharacter("ch", "hero.gif");
    // `enable()` 之后紧接的 `scale` / `move` 与它同在一个 tick 里：此刻字节还没读完。
    // 元素一旦在解码后被换掉，这些过渡会跟着旧节点消失，动画就变成一步到位。
    const picture = layer.childNodes[0];
    assert.equal(picture.tagName, "CANVAS", "GIF 一上台就该是画布，之后不再换元素");
    stage.transformCharacter("ch", 0, 0.5, 2000);
    stage.moveCharacter("ch", 0, -300, undefined, 2000);
    await settle();

    assert.equal(layer.childNodes[0], picture, "解码完成后仍是同一个元素");
    assert.match(String(picture.style.transform), /scale\(0\.5\)/);
    assert.match(String(picture.style.transition), /transform 2000ms linear/);
    assert.match(String(picture.style.transition), /left 2000ms linear/);
    assert.equal(picture.style.visibility, "", "动画正在跑，画面也要显示出来");

    // Freeze it, so no playback timer outlives the test.
    stage.stepGif("ch", 1);
  });
});

test("GIF 字节读不出来时仍用浏览器原生动画显示", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build(() => Promise.resolve("asset://hero.gif"));
    stage.setBackground("bg.gif");
    await settle();

    const image = surface.childNodes[0].childNodes[0];
    assert.equal(image.tagName, "IMG");
    assert.equal(image.src, "asset://hero.gif");
    assert.equal(image.style.visibility, "", "回退路径也必须解除隐藏");
  });
});

test("解码前给出的 step 也会定格到指定帧", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build(() => Promise.resolve(TWO_FRAME_URL));
    // `enable()` 之后紧接的 `step` 早于资源解码完成，这一句必须不丢。
    stage.setBackground("bg.gif");
    stage.stepGif("background", 2);
    await settle();

    const canvas = surface.childNodes[0].childNodes[0];
    assert.equal(canvas.tagName, "CANVAS");
    const painted = canvas.painted.at(-1);
    assert.ok(painted, "画布画过一帧");
    assert.deepEqual([...painted.slice(0, 4)], [0, 255, 255, 255], "第 2 帧是青色");
  });
});

test("先写 step 再 enable，定格同样生效", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build(() => Promise.resolve(TWO_FRAME_URL));
    // 提示链的写法：step 与 enable 谁先谁后都不该改变结果。
    stage.stepGif("background", 2);
    stage.setBackground("bg.gif");
    await settle();

    const canvas = surface.childNodes[0].childNodes[0];
    assert.deepEqual([...canvas.painted.at(-1).slice(0, 4)], [0, 255, 255, 255]);
  });
});

test("step 的帧号超过总帧数时取模", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build(() => Promise.resolve(TWO_FRAME_URL));
    stage.setBackground("bg.gif");
    await settle();

    stage.stepGif("background", 3);
    const canvas = surface.childNodes[0].childNodes[0];
    assert.deepEqual(
      [...canvas.painted.at(-1).slice(0, 4)],
      [255, 0, 0, 255],
      "两帧的 GIF 里第 3 帧就是第 1 帧",
    );
  });
});

test("GIF 上台前设置的滤镜落在画布上", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build();
    stage.setBackground("bg.gif");
    // `enable()` 之后紧接的 `blur` 同样早于解码：滤镜写在画布本身上，解码后不能丢。
    stage.applyLook("background", { blur: 8, brightness: 1, contrast: 1, saturate: 1 }, 0);
    await settle();

    const canvas = surface.childNodes[0].childNodes[0];
    assert.equal(canvas.tagName, "CANVAS");
    assert.match(String(canvas.style.filter), /blur\(8px\)/);

    // Freeze it, so no playback timer outlives the test.
    stage.stepGif("background", 1);
  });
});

test("GIF 换上台前设置的调色落在画布上", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build();
    stage.setBackground("bg.gif");
    stage.applyTint("background", 20, 0, 0, 0);
    await settle();

    const canvas = surface.childNodes[0].childNodes[0];
    assert.match(String(canvas.style.filter), /url\(#/);

    stage.stepGif("background", 1);
  });
});
