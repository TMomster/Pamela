// 续说（csay）与自动停顿（stage.autoPause）测试。
// Tests for `csay` — a line appended to the one already on screen, without
// clearing the box — and for the pause auto mode leaves after each line.

import assert from "node:assert/strict";
import test from "node:test";

import { createDialogue } from "../dialog.js";
import { run } from "../pamela.js";
import { createStageGlobals } from "../stage.js";

/** A stand-in element, with just enough of the DOM for `createDialogue`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: {},
    childNodes: [],
    hidden: false,
    textContent: "",
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
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    removeAttribute(name) {
      node[name] = "";
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
  return node;
}

/** Runs `body` with a minimal `document`, so a box can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

/** Keeps the fake document in place while a case awaits a queued line. */
async function inFakeDomAsync(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return await body();
  } finally {
    globalThis.document = previous;
  }
}

/**
 * A box over the fake DOM, answering the parts a test looks at.
 *
 * The box appends its own children to the node it is given, in a fixed order:
 * the stand-in bar, the old stamped PNG, the name plate and the line.
 */
function box(options = {}) {
  const node = fakeElement();
  const created = createDialogue({
    element: fakeElement(),
    node,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    ...options,
  });
  const [, , speaker, text] = node.childNodes;
  return { ...created, speaker, text };
}

/** Resolves after `ms` milliseconds, so a timer the box armed can fire. */
function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A stage stand-in that records the lines and pauses a script asks for. */
function recordingStage() {
  const lines = [];
  const pauses = [];
  return {
    lines,
    pauses,
    sayLine: (name, text, opts) => {
      lines.push({ kind: "say", name, text, opts });
    },
    csayLine: (name, text, opts) => {
      lines.push({ kind: "csay", name, text, opts });
    },
    setAutoPause: (ms) => pauses.push(ms),
    setAutoVoice: () => undefined,
  };
}

// --- 续说 ---

test("续说：接在上一句后面，不清空对话框", () => {
  inFakeDom(() => {
    const b = box({ typewriter: "off" });
    b.line("小明", "你好，").catch(() => {});
    assert.equal(b.text.textContent, "你好，");
    b.settle();

    b.appendLine("小明", "我是小明").catch(() => {});
    // 上一句还在框里，新的这一段落写在它后面。
    assert.equal(b.text.textContent, "你好，我是小明");
    assert.equal(b.speaker.textContent, "小明");
    b.settle();
  });
});

test("续说：第一句就是续说时，与普通台词一样显示", () => {
  inFakeDom(() => {
    const b = box({ typewriter: "off" });
    b.appendLine(null, "没有上一句").catch(() => {});
    assert.equal(b.text.textContent, "没有上一句");
    b.settle();
  });
});

test("续说：回放记录并进上一条，不多出一行", () => {
  inFakeDom(() => {
    const b = box({ typewriter: "off" });
    b.line("小明", "你好，").catch(() => {});
    b.settle();
    b.appendLine("小明", "我是小明").catch(() => {});
    b.settle();

    assert.deepEqual(b.getHistory(), [{ name: "小明", text: "你好，我是小明" }]);
  });
});

test("续说：逐字只走新接上的一段，前面的字不重放", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "fast" });
    b.line(null, "你好，").catch(() => {});
    b.settle(); // 先把上一句写完
    b.settle(); // 再让它过去

    b.appendLine(null, "我是小明").catch(() => {});
    // 新增的四个字才开始逐字：屏幕上先保留着「你好，」。
    assert.equal(b.isTyping(), true, "新的一段在逐字");
    assert.equal(b.text.textContent, "你好，");
    await wait(200);
    assert.equal(b.text.textContent, "你好，我是小明");
    assert.equal(b.isTyping(), false);
  });
});

test("续说：time 只按新增的字数算", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.line(null, "你好，").catch(() => {});
    b.settle();

    // 四个字在 100ms 内显示完：若按整行七个字算，就会慢近一半。
    b.appendLine(null, "我是小明", { time: 100, audio: null }).catch(() => {});
    assert.equal(b.isTyping(), true, "time 强制开启逐字");
    assert.equal(b.text.textContent, "你好，", "前面的字仍显示着");
    await wait(160);
    assert.equal(b.text.textContent, "你好，我是小明");
    b.settle();
  });
});

test("续说：上一句还在等点击时，下一句排队而不是报错", async () => {
  await inFakeDomAsync(async () => {
    const b = box({ typewriter: "off" });
    const first = b.line(null, "先说一句");
    const second = b.appendLine(null, "再说一句");
    assert.equal(b.text.textContent, "先说一句");

    b.settle();
    await first;
    await wait();
    assert.equal(b.text.textContent, "先说一句再说一句");

    b.settle();
    await second;
    assert.equal(b.isWaiting(), false);
  });
});

test("续说：clear 之后不再接着上一句写", () => {
  inFakeDom(() => {
    const b = box({ typewriter: "off" });
    b.line(null, "会被清掉的一句").catch(() => {});
    b.settle();
    b.clear();
    b.appendLine(null, "新的开头").catch(() => {});
    assert.equal(b.text.textContent, "新的开头");
    b.settle();
  });
});

// --- 自动停顿 ---

test("自动停顿：默认为 800ms", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.setAuto(true);
    let resolved = false;
    b.line(null, "一字").then(() => {
      resolved = true;
    }).catch(() => {});
    await wait(300);
    assert.equal(resolved, false, "默认的 800ms 还没到");
    b.settle();
  });
});

test("自动停顿：设为 0 时说完就切句", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.setAuto(true);
    b.setAutoPause(0);
    let resolved = false;
    b.line(null, "一字").then(() => {
      resolved = true;
    }).catch(() => {});
    await wait(30);
    assert.equal(resolved, true, "没有停顿，立刻进入下一句");
  });
});

test("自动停顿：指定毫秒数决定停顿长度", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.setAuto(true);
    b.setAutoPause(300);
    let resolved = false;
    b.line(null, "一字").then(() => {
      resolved = true;
    }).catch(() => {});
    await wait(100);
    assert.equal(resolved, false, "300ms 的停顿还没走完");
    await wait(280);
    assert.equal(resolved, true, "停顿走完就切句");
  });
});

test("自动停顿：0 也管配音结束后的那口气", async () => {
  await inFakeDom(async () => {
    const b = box({
      typewriter: "off",
      getAutoVoice: () => true,
      synthVoice: () => ({ duration: 100, stop() {} }),
    });
    b.setAuto(true);
    b.setAutoPause(0);
    let resolved = false;
    b.line(null, "有配音的一句").then(() => {
      resolved = true;
    }).catch(() => {});
    await wait(60);
    assert.equal(resolved, false, "语音还没播完");
    await wait(120);
    assert.equal(resolved, true, "语音一结束就切句，不再多等 800ms");
  });
});

test("自动停顿：不给参数或给了非法值时回到 800", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.setAuto(true);
    b.setAutoPause(0);
    b.setAutoPause();
    let resolved = false;
    b.line(null, "一字").then(() => {
      resolved = true;
    }).catch(() => {});
    await wait(300);
    assert.equal(resolved, false, "缺省回到默认的 800ms");
    b.settle();
  });
});

// --- 语言里的写法 ---

test("csay 与 autoPause 在脚本里分发到舞台", async () => {
  const stage = recordingStage();
  const result = await run(
    [
      'say("你好，")',
      'csay("我是小明")',
      '舞台.续说("再来一句", 500)',
      'dialog.csay("对话框里也行", "小明")',
      "自动停顿(0)",
      'csay("带时长的续说") @ 1200',
      // `dialog.csay` 的 time 在第 3 格（文本、姓名在前），`@` 也填得对。
      'dialog.csay("带时长的对话框续说") @ 900',
    ].join("\n"),
    { globals: createStageGlobals(stage) },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.deepEqual(stage.lines, [
    { kind: "say", name: null, text: "你好，", opts: { time: 0, audio: null } },
    { kind: "csay", name: null, text: "我是小明", opts: { time: 0, audio: null } },
    { kind: "csay", name: null, text: "再来一句", opts: { time: 500, audio: null } },
    { kind: "csay", name: "小明", text: "对话框里也行", opts: { time: 0, audio: null } },
    { kind: "csay", name: null, text: "带时长的续说", opts: { time: 1200, audio: null } },
    { kind: "csay", name: null, text: "带时长的对话框续说", opts: { time: 900, audio: null } },
  ]);
  assert.deepEqual(stage.pauses, [0]);
});
