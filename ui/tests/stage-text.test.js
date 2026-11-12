// `ui/stage.js` 的 Text 对象：文字层、位置与样式、与图片共用的方法。
// Tests for the Text object: its own layer, the frame it shares with pictures.

import assert from "node:assert/strict";
import test from "node:test";

import { createStage, createStageGlobals, createStageObjects } from "../stage.js";
import { run } from "../pamela.js";

/** A stand-in element, with just enough of the DOM for `createStage`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    log: [],
    style: new Proxy(
      {},
      {
        set(target, key, value) {
          target[key] = value;
          node.log.push(`style.${key}`);
          return true;
        },
      },
    ),
    get offsetWidth() {
      node.log.push("layout");
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
      node.log.push(`removeAttribute:${name}`);
      if (name === "src") {
        node.src = "";
      }
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      node.log.push(`addEventListener:${type}`);
      listeners.set(type, handler);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
  return node;
}

/** Runs `body` with a minimal `document`, so the stage can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  let result;
  try {
    result = body();
  } finally {
    if (!(result && typeof result.then === "function")) {
      globalThis.document = previous;
    }
  }
  if (result && typeof result.then === "function") {
    return result.finally(() => {
      globalThis.document = previous;
    });
  }
  return result;
}

/** A stage built over a fake DOM, with the text layer picked out. */
function domStage() {
  const surface = fakeElement();
  const stage = createStage({
    element: fakeElement(),
    surface,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
  });
  return {
    stage,
    surface,
    text: surface.childNodes[6],
  };
}

test("a Text puts its words on the text layer", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const title = createStageObjects(stage).Text(
      ["第二天 · 清晨", 0, 380, 64, "#ffd479"],
      { assignee: "title" },
    );

    title.enable();

    assert.equal(text.childNodes.length, 1);
    const element = text.childNodes[0];
    assert.equal(element.className, "stage__text");
    assert.equal(element.textContent, "第二天 · 清晨");
    assert.equal(element.style.fontSize, "64px", "1920 宽的取景框里，1 逻辑像素就是 1 像素");
    assert.equal(element.style.color, "#ffd479");
    assert.equal(
      element.style.fontFamily,
      '"JetBrains Mono", "Source Han Sans CN", sans-serif',
      "西文默认 JetBrains Mono，中文默认思源黑体",
    );
    assert.equal(stage.isEmpty(), false);
    assert.equal(stage.objectNameOf(title), "title");
  });
});

test("a Text shares move, turn, scale and fade with the pictures", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const note = createStageObjects(stage).Text(["你好"], { assignee: "note" });
    note.enable();

    note.moveTo(96, -54).rotateTo(30).scaleTo(2).alpha(0.5);

    // Same arithmetic `draw` uses for a character: x / 1920 and y / 1080 as
    // percentages measured from the centre.
    const element = text.childNodes[0];
    assert.equal(element.style.left, "55%");
    assert.equal(element.style.top, "55%");
    assert.equal(element.style.transform, "translate(-50%, -50%) rotate(30deg) scale(2)");
    assert.equal(element.style.opacity, "0.5");
  });
});

test("font() sets one family for Chinese and Western alike", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const title = createStageObjects(stage).Text(["Old Bookstore 旧书店"], {
      assignee: "title",
    });
    title.enable();
    title.font("Microsoft YaHei");

    const element = text.childNodes[0];
    assert.equal(
      element.style.fontFamily,
      '"Microsoft YaHei", "JetBrains Mono", "Source Han Sans CN", sans-serif',
      "选中的字体排最前，缺字时再退回两套内置字体",
    );

    // The default is a state of its own, not the absence of a style: clearing
    // the name has to put the two built-ins back.
    title.font("");
    assert.equal(
      element.style.fontFamily,
      '"JetBrains Mono", "Source Han Sans CN", sans-serif',
    );
  });
});

test("weight() sets the font weight, and 400 is the default", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const title = createStageObjects(stage).Text(["粗体 Bold"], { assignee: "title" });
    title.enable();

    const element = text.childNodes[0];
    assert.equal(element.style.fontWeight, "400", "不写字重时是常规");

    title.weight(700);
    assert.equal(element.style.fontWeight, "700");

    // An empty call puts the regular face back, the same way font("") does.
    title.weight();
    assert.equal(element.style.fontWeight, "400");
  });
});

test("a weight set before enable is the one the text appears in", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const title = createStageObjects(stage).Text(["字"], { assignee: "title" });
    title.weight(300);
    title.enable();

    assert.equal(text.childNodes[0].style.fontWeight, "300");
  });
});

test("a font set before enable is the one the text appears in", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const title = createStageObjects(stage).Text(["字"], { assignee: "title" });
    title.font("Arial");
    title.enable();

    assert.equal(
      text.childNodes[0].style.fontFamily,
      '"Arial", "JetBrains Mono", "Source Han Sans CN", sans-serif',
    );
  });
});

test("a colour set before enable is the one the text appears in", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const title = createStageObjects(stage).Text(["字"], { assignee: "title" });
    title.color("#123456");
    title.enable();

    assert.equal(text.childNodes[0].style.color, "#123456");
    assert.equal(stage.textState("title").color, "#123456");
  });
});

test("color repaints the words, and 颜色 reaches it too", async () => {
  await inFakeDom(async () => {
    const { stage, text } = domStage();
    const result = await run(
      [
        '标题 = 文本("旧书店", 颜色 = "#f0e6d2")',
        "标题.启用()",
        '标题.颜色(色值 = "#ff6b6b")',
        '标题.文字颜色("#00ff00")',
      ].join("\n"),
      { globals: createStageGlobals(stage) },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(text.childNodes[0].style.color, "#00ff00");
  });
});

test("a colour that is not text is reported, not guessed at", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const result = await run('t = Text("字")\nt.enable()\nt.color(5)', {
      globals: createStageGlobals(stage),
    });
    assert.ok(result.error);
    assert.match(result.error.message, /颜色需要文本/);
  });
});

test("clearing the stage removes the text with the pictures", () => {
  inFakeDom(() => {
    const { stage, text } = domStage();
    const label = createStageObjects(stage).Text(["标题"], { assignee: "label" });
    label.enable();
    assert.equal(text.childNodes.length, 1);

    stage.clear();
    assert.equal(text.childNodes.length, 0);
    assert.equal(stage.isEmpty(), true);
  });
});

test("the Chinese spelling builds the same object", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const result = await run(
      [
        '标题 = 文本("旧书店", 横 = 0, 纵 = 420, 字号 = 56, 颜色 = "#f0e6d2")',
        '标题.字体("微软雅黑")',
        "标题.字重(700)",
        "标题.启用()",
        "标题.缩放到(1.2, 0)",
      ].join("\n"),
      { globals: createStageGlobals(stage) },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(stage.isEmpty(), false);
  });
});

test("bad words and a non-positive size are reported, not guessed at", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const runText = (line) =>
      run(line, { globals: createStageGlobals(stage) });

    const number = await runText("t = Text(7)");
    assert.ok(number.error);
    assert.match(number.error.message, /文本内容/);

    const zero = await runText('t = Text("字", 字号 = 0)');
    assert.ok(zero.error);
    assert.match(zero.error.message, /字号/);

    const badFont = await runText('t = Text("字")\nt.font(5)');
    assert.ok(badFont.error);
    assert.match(badFont.error.message, /字体/);

    const badWeight = await runText('t = Text("字")\nt.weight(1200)');
    assert.ok(badWeight.error);
    assert.match(badWeight.error.message, /字重/);
  });
});
