// `flush` 把一个方法写下的效果复原。测试覆盖语言侧的读取（裸名字、多个名字、
// 时长）与舞台侧的结果（倍率、转角、位置、调色、滤镜、自由变换）。
// Tests for `flush`, the call that undoes what a method wrote.

import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../pamela.js";
import { createStage, createStageGlobals, createStageObjects } from "../stage.js";

/** A stand-in element, with just enough of the DOM for `createStage`. */
function fakeElement() {
  return {
    className: "",
    dataset: {},
    style: {},
    childNodes: [],
    classList: { toggle() {} },
    get firstChild() {
      return null;
    },
    replaceChildren(...children) {
      this.childNodes = children;
    },
    append(child) {
      this.childNodes.push(child);
    },
    decode() {
      return Promise.resolve();
    },
    hidden: false,
    alt: "",
    draggable: false,
    src: "",
    textContent: "",
    // 位图的尺寸：自由变换的框要等它解码后量出来，否则拉点的调用会一直等下去。
    naturalWidth: 1080,
    naturalHeight: 1920,
    width: 1080,
    height: 1920,
    removeAttribute() {},
    setAttribute(name, value) {
      this[name] = value;
    },
    addEventListener() {},
    offsetWidth: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
}

/** Runs `body` with a minimal `document`, so a stage can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  const result = body();
  if (result && typeof result.then === "function") {
    return result.finally(() => {
      globalThis.document = previous;
    });
  }
  globalThis.document = previous;
  return result;
}

/**
 * A stage over the fake DOM, plus every element the objects create.
 *
 * The patch of `createElement` is installed after the stage itself is built, so
 * `created` holds the pictures and meshes a script puts on the stage, in order.
 */
function domStage() {
  const surface = fakeElement();
  const stage = createStage({
    element: fakeElement(),
    surface,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
  });
  const created = [];
  globalThis.document.createElement = (tag) => {
    const node = fakeElement();
    node.tagName = String(tag).toUpperCase();
    created.push(node);
    return node;
  };
  return { stage, created };
}

/** The objects a script makes, kept so a test can read their state back. */
function trackedObjects(stage) {
  const objects = createStageObjects(stage);
  const made = {};
  const constructors = {};
  for (const [kind, make] of Object.entries(objects)) {
    constructors[kind] = (args, context) => {
      const object = make(args, context);
      made[context?.assignee ?? kind] = object;
      return object;
    };
  }
  return { constructors, made };
}

/** Runs a script against a real stage over the fake DOM. */
function playwright(script) {
  return inFakeDom(async () => {
    const { stage, created } = domStage();
    const { constructors, made } = trackedObjects(stage);
    const result = await run(script, {
      globals: createStageGlobals(stage),
      constructors,
    });
    assert.equal(result.error, undefined, result.error?.message);
    return { stage, created, made, result };
  });
}

test("flush(scale) 把倍率归 1，别处写下的效果留着", async () => {
  const { made } = await playwright(
    [
      'ch = Character("hero.png")',
      "ch.scale(2).blur(4)",
      "ch.flush(scale)",
      "ch.size",
    ].join("\n"),
  );
  assert.equal(made.ch.size, 1, "倍率回到原样");
  assert.equal(made.ch.look.blur, 4, "只清掉写出的那一种");
});

test("flush(rgb) 把调色撤回没有偏移，也认 hex 这个名字", async () => {
  const { made } = await playwright(
    [
      'ch = Character("hero.png")',
      "ch.rgbTo(60, 10, 0)",
      "ch.flush(rgb)",
      'ch.hex("00FF00")',
      "ch.flush(hex)",
    ].join("\n"),
  );
  assert.deepEqual(made.ch.tint, { r: 0, g: 0, b: 0 });
});

test("一个名字复原一个轴：flush(x) 只把横坐标归零", async () => {
  const { made } = await playwright(
    [
      'ch = Character("hero.png")',
      "ch.move(320, -180)",
      "ch.flush(x)",
    ].join("\n"),
  );
  assert.equal(made.ch.px, 0, "横坐标回到原点");
  assert.equal(made.ch.py, -180, "纵坐标不动");
});

test("不写名字时整个对象复原：位置、转角、倍率、透明度、调色、滤镜", async () => {
  const { made } = await playwright(
    [
      'ch = Character("hero.png")',
      "ch.move(320, -180).rotate(35).scale(2).alpha(0.4)",
      "ch.rgbTo(60, 0, 0).blur(4).saturate(0)",
      "ch.flush()",
    ].join("\n"),
  );
  const hero = made.ch;
  assert.equal(hero.px, 0);
  assert.equal(hero.py, 0);
  assert.equal(hero.rotation, 0);
  assert.equal(hero.size, 1);
  assert.equal(hero.opacity, 1);
  assert.deepEqual(hero.tint, { r: 0, g: 0, b: 0 });
  assert.deepEqual(hero.look, { blur: 0, brightness: 1, contrast: 1, saturate: 1 });
});

test("多个名字一起复原，同一个时长分别交给每一个", async () => {
  const { made } = await playwright(
    [
      'ch = Character("hero.png")',
      "ch.scale(2).rotate(90).rotateH(30)",
      "ch.flush(scale, rotate, rotateH)",
    ].join("\n"),
  );
  assert.equal(made.ch.size, 1);
  assert.equal(made.ch.rotation, 0);
  assert.equal(made.ch.angleH, 0);
});

test("flush(transform) 把八点自由变换拉回框上，换回普通图片", async () => {
  const { created, made } = await playwright(
    [
      'ch = Character("hero.png")',
      "ch.enable()",
      "ch.transform.upleft(40, 40)",
      "ch.flush(transform)",
    ].join("\n"),
  );
  const picture = created.find((node) => node.className === "stage__character");
  const mesh = created.find((node) => node.className === "stage__mesh");
  assert.ok(picture, "角色有自己的图片");
  assert.ok(mesh, "拉动一个点以后有网格");
  assert.equal(picture.style.display, "", "复原以后画的是普通图片");
  assert.equal(mesh.style.display, "none", "网格收起来");
  assert.equal(made.ch.placed, true);
});

test("背景叫不出角色的自由变换：名字按种类认，报错时列出能用的", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const { constructors } = trackedObjects(stage);
    const result = await run(
      ['bg = Background("street.png")', "bg.flush(transform)"].join("\n"),
      { globals: createStageGlobals(stage), constructors },
    );
    assert.ok(result.error);
    assert.match(result.error.message, /Background 没有可清除的 transform/);
    assert.match(result.error.message, /可用：move/);
  });
});

test("引号里的名字不是名字：flush(\"scale\") 被拒绝", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const { constructors } = trackedObjects(stage);
    const result = await run(
      ['ch = Character("hero.png")', 'ch.flush("scale")'].join("\n"),
      { globals: createStageGlobals(stage), constructors },
    );
    assert.ok(result.error);
    assert.match(result.error.message, /不带引号的效果名/);
  });
});

test("不是内置方法的名字照旧报未定义，而不是当成效果", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const { constructors } = trackedObjects(stage);
    const result = await run(
      ['ch = Character("hero.png")', "ch.flush(shrink)"].join("\n"),
      { globals: createStageGlobals(stage), constructors },
    );
    assert.ok(result.error);
    assert.match(result.error.message, /shrink/);
  });
});

test("文字的滤镜能清除，flush(color) 回默认色，flush(rgb) 仍报没有", async () => {
  const { made } = await playwright(
    [
      't = Text("你好")',
      't.color("#ff0000")',
      't.blur(4)',
      "t.flush(color, blur)",
    ].join("\n"),
  );
  assert.equal(made.t.textColor, "#ffffff");
  assert.equal(made.t.look.blur, 0);

  await inFakeDom(async () => {
    const { stage } = domStage();
    const { constructors } = trackedObjects(stage);
    const result = await run(['t = Text("你好")', "t.flush(rgb)"].join("\n"), {
      globals: createStageGlobals(stage),
      constructors,
    });
    assert.ok(result.error);
    assert.match(result.error.message, /没有可清除的 rgb/);
  });
});

test("舞台批量清除：stage.flush(scale, rotate, blur : ch, bg) 分给每个对象", async () => {
  // 三个名字超过签名里的两格：名字是「收下剩余参数」的那一格，没有上限。
  const { made } = await playwright(
    [
      'ch = Character("hero.png")',
      'bg = Background("street.png")',
      "ch.scale(2).rotate(90).blur(4)",
      "bg.scale(2).rotate(90).blur(4)",
      "stage.flush(scale, rotate, blur : ch, bg)",
    ].join("\n"),
  );
  assert.equal(made.ch.size, 1);
  assert.equal(made.ch.rotation, 0);
  assert.equal(made.ch.look.blur, 0);
  assert.equal(made.bg.size, 1);
  assert.equal(made.bg.rotation, 0);
  assert.equal(made.bg.look.blur, 0);
});

test("组也能清除：ary.flush(scale) 分给每个成员", async () => {
  const { made } = await playwright(
    [
      'ch = Character("hero.png")',
      'bg = Background("street.png")',
      "ary = Array(ch, bg)",
      "ch.scale(2)",
      "bg.scale(2)",
      "ary.flush(scale)",
    ].join("\n"),
  );
  assert.equal(made.ch.size, 1);
  assert.equal(made.bg.size, 1);
});

/**
 * A stage stand-in that records the time each call was given.
 *
 * Nothing here animates, so `flush(scale) @ 400` can be held to handing 400 to
 * the frame call without the test waiting 400ms for it.
 */
function recordingStage() {
  const calls = [];
  return {
    calls,
    setCharacter: (slot, path) => calls.push({ method: "setCharacter", slot, path }),
    characterState: () => null,
    rememberCharacterName: () => {},
    registerSprite: () => {},
    transformCharacter: (slot, rotation, scale, time) =>
      calls.push({ method: "transformCharacter", slot, rotation, scale, time }),
    moveCharacter: (slot, x, y, z, time) =>
      calls.push({ method: "moveCharacter", slot, x, y, z, time }),
    applyTint: (target, r, g, b, time) =>
      calls.push({ method: "applyTint", target, r, g, b, time }),
    applyLook: (target, look, time) => calls.push({ method: "applyLook", target, look, time }),
    setCharacterAlpha: (slot, value, time) =>
      calls.push({ method: "setCharacterAlpha", slot, value, time }),
    resetCharacterPoints: (slot, time) =>
      calls.push({ method: "resetCharacterPoints", slot, time }),
  };
}

/** Runs `script` against the recording stage and returns what it recorded. */
async function record(script) {
  const stage = recordingStage();
  const objects = createStageObjects(stage);
  const result = await run(script, { constructors: objects, globals: { stage } });
  assert.equal(result.error, undefined, result.error?.message);
  return stage.calls;
}

test("@ 写在多个名字后面，时长落在每个复原动作上", async () => {
  const calls = await record(
    [
      'ch = Character("hero.png")',
      "ch.enable()",
      "ch.flush(scale, rotate) @ 30",
    ].join("\n"),
  );
  // `enable()` 也走过一次成帧，所以要复原的是最后两次转帧。
  const times = calls
    .filter((call) => call.method === "transformCharacter")
    .map((call) => call.time);
  assert.deepEqual(times.slice(-2), [30, 30], "倍率与转角各等 30 毫秒");
});

test("位置写法与 @ 写法落到同一处：flush(rgb, 5000) 等价于 flush(rgb) @ 5000", async () => {
  const positional = await record(
    ['ch = Character("hero.png")', "ch.enable()", "ch.flush(rgb, 5000)"].join("\n"),
  );
  const companion = await record(
    ['ch = Character("hero.png")', "ch.enable()", "ch.flush(rgb) @ 5000"].join("\n"),
  );
  const tint = (calls) => calls.filter((call) => call.method === "applyTint").at(-1);
  assert.deepEqual(tint(positional), tint(companion));
  assert.equal(tint(positional).time, 5000);
});

test("@ 与按位置写出的时长同时出现时报重复", async () => {
  const stage = recordingStage();
  const result = await run(
    ['ch = Character("hero.png")', "ch.flush(scale, 100) @ 30"].join("\n"),
    { constructors: createStageObjects(stage), globals: { stage } },
  );
  assert.ok(result.error);
  assert.match(result.error.message, /flush 使用了重复的时间参数/);
});
