// 台词行内颜色的解析与舞台上的分段渲染。
// Tests for the `{红}…{/红}` colour marks a dialogue line can carry.

import assert from "node:assert/strict";
import test from "node:test";

import { createDialogue } from "../dialog.js";
import { tokenize } from "../pamela.js";
import {
  colorOf,
  isColorMark,
  richTextLength,
  richTextRuns,
  stripRichText,
} from "../rich-text.js";

/** A stand-in element: just enough of the DOM for `createDialogue`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: {},
    childNodes: [],
    classList: { toggle() {} },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    replaceChildren(...children) {
      node.childNodes = children;
    },
    append(...children) {
      node.childNodes.push(...children);
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

/** Runs `body` with a minimal `document`, so a box can be built in node. */
async function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return await body();
  } finally {
    globalThis.document = previous;
  }
}

/** A box over the fake DOM, with the two text layers it was built with. */
function makeBox(options = {}) {
  const element = fakeElement();
  const node = fakeElement();
  const box = createDialogue({
    element,
    node,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    ...options,
  });
  const layer = (name) => node.childNodes.find((child) => child.className === name);
  return { box, element, node, speaker: layer("dialogue__speaker"), text: layer("dialogue__text") };
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 解析 ---

test("颜色标记拆成段：英文名、中文名与十六进制都认", () => {
  assert.deepEqual(richTextRuns("这里的{red}重要文本{/red}，红色显示"), [
    { text: "这里的", color: null },
    { text: "重要文本", color: "red" },
    { text: "，红色显示", color: null },
  ]);
  assert.deepEqual(richTextRuns("{红}红{/}{#000000}黑{/}"), [
    { text: "红", color: "red" },
    { text: "黑", color: "#000000" },
  ]);
});

test("颜色可以嵌套，{/} 回到外层颜色", () => {
  assert.deepEqual(richTextRuns("{红}一{蓝}二{/}三{/}四"), [
    { text: "一", color: "red" },
    { text: "二", color: "blue" },
    { text: "三", color: "red" },
    { text: "四", color: null },
  ]);
});

test("没闭合的标记一直用到句尾，认不出的标记原样留着", () => {
  assert.deepEqual(richTextRuns("{红}一直红下去"), [
    { text: "一直红下去", color: "red" },
  ]);
  // 不是颜色标记的花括号就是作者要写的字，不能被悄悄吃掉。
  assert.deepEqual(richTextRuns("集合{1, 2}与{ble}"), [
    { text: "集合{1, 2}与{ble}", color: null },
  ]);
});

test("colorOf 只认真正的颜色写法", () => {
  assert.equal(colorOf("红"), "red");
  assert.equal(colorOf("红色"), "red");
  assert.equal(colorOf("Gold"), "gold");
  assert.equal(colorOf("#f00"), "#f00");
  assert.equal(colorOf("#000000"), "#000000");
  assert.equal(colorOf("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
  assert.equal(colorOf("#12345"), null, "位数不对的十六进制不是颜色");
  assert.equal(colorOf("important"), null);
  assert.equal(colorOf(""), null);
});

test("isColorMark 认开始与结束标记", () => {
  assert.equal(isColorMark("red"), true);
  assert.equal(isColorMark("/red"), true);
  assert.equal(isColorMark("/"), true);
  assert.equal(isColorMark("红"), true);
  assert.equal(isColorMark("/红"), true);
  assert.equal(isColorMark("1 + 1"), false);
  assert.equal(isColorMark(""), false);
});

test("可见文字与字数都不含标记", () => {
  const line = "这里的{red}重要文本四个字{/red}，需要红色";
  assert.equal(stripRichText(line), "这里的重要文本四个字，需要红色");
  assert.equal(richTextLength(line), 15);
  assert.equal(richTextLength("{红}一{/红}"), 1);
  assert.equal(stripRichText(""), "");
});

// --- 语言层 ---

test("词法器把颜色标记当字面量，不再当成插值", () => {
  const { tokens } = tokenize('say("这里的{red}重要文本{/red}")');
  assert.equal(tokens.some((token) => token.type === "interp"), false);
  assert.equal(
    tokens.filter((token) => token.type === "string").map((token) => token.value).join(""),
    "这里的{red}重要文本{/red}",
  );
});

test("真正的插值照旧：不是颜色的花括号还是表达式", () => {
  const { tokens } = tokenize('say("血量{hp}")');
  const interp = tokens.filter((token) => token.type === "interp");
  assert.deepEqual(interp.map((token) => token.value), ["hp"]);
});

// --- 舞台 ---

test("带颜色的台词分段渲染，颜色落在各自的 span 上", async () => {
  await inFakeDom(async () => {
    const { box, text } = makeBox();
    const spoken = box.line(null, "这里的{red}重要文本{/red}，红色显示");

    const line = text.childNodes[0];
    assert.equal(line.className, "dialogue__line", "整行包在一层里，分段才不会各占一行");
    assert.deepEqual(
      line.childNodes.map((child) => child.textContent),
      ["这里的", "重要文本", "，红色显示"],
    );
    assert.equal(line.childNodes[0].style.color, undefined);
    assert.equal(line.childNodes[1].style.color, "red");

    box.settle();
    await spoken;
  });
});

test("没有颜色标记的台词仍是纯文本，排版与旧版一致", async () => {
  await inFakeDom(async () => {
    const { box, text } = makeBox();
    const spoken = box.line("艾拉", "你来了。");
    assert.equal(text.textContent, "你来了。");
    assert.equal(text.childNodes.length, 0);
    box.settle();
    await spoken;
  });
});

test("逐字显示时标记不算字：写完的整行仍是彩色分段", async () => {
  await inFakeDom(async () => {
    const { box, text } = makeBox();
    box.setStyle({ text: { typeSpeed: 40 } });
    const spoken = box.line(null, "{红}三个字{/红}");

    // 一上来是空的：三个可见字，没有一个是标记里的内容。
    assert.deepEqual(text.childNodes[0].childNodes, []);

    await wait(50);
    assert.deepEqual(
      text.childNodes[0].childNodes.map((child) => child.textContent),
      ["三"],
      "一个字就是一个字，标记不占节拍",
    );

    await wait(200);
    const line = text.childNodes[0];
    assert.deepEqual(line.childNodes.map((child) => child.textContent), ["三个字"]);
    assert.equal(line.childNodes[0].style.color, "red");
    assert.equal(box.isTyping(), false);

    box.settle();
    await spoken;
  });
});

test("点击补完整行时带着颜色补完", async () => {
  await inFakeDom(async () => {
    const { box, element, text } = makeBox();
    box.setStyle({ text: { typeSpeed: 40 } });
    const spoken = box.line(null, "前{蓝}后{/蓝}");
    element.dispatch("click");

    const line = text.childNodes[0];
    assert.deepEqual(line.childNodes.map((child) => child.textContent), ["前", "后"]);
    assert.equal(line.childNodes[1].style.color, "blue");
    assert.equal(box.isTyping(), false);

    element.dispatch("click");
    await spoken;
  });
});

test("回放记录里是去掉标记的文字", async () => {
  await inFakeDom(async () => {
    const { box } = makeBox();
    const spoken = box.line("艾拉", "{红}重要{/红}的事");
    assert.deepEqual(box.getHistory(), [{ name: "艾拉", text: "重要的事" }]);
    box.settle();
    await spoken;
  });
});
