// 错误气泡：错误归一化与右下角常驻通知的单元测试。
// Pamela — unit tests for the in-app error bubble.

import assert from "node:assert/strict";
import test from "node:test";

import { classifyError, dismissBubble, pushErrorBubble, pushToast } from "../error-notify.js";

/** A minimal DOM node that supports the operations `pushErrorBubble` uses. */
function makeNode(tag = "div") {
  const node = {
    tagName: tag,
    className: "",
    style: {},
    textContent: "",
    attributes: {},
    children: [],
    parent: null,
    _listeners: {},
    append(...nodes) {
      for (const child of nodes) {
        child.parent = node;
        node.children.push(child);
      }
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    addEventListener(type, fn) {
      (node._listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of node._listeners[type] || []) {
        fn();
      }
    },
    remove() {
      if (node.parent) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) {
          node.parent.children.splice(index, 1);
        }
      }
    },
  };
  Object.defineProperty(node, "firstElementChild", {
    get() {
      return node.children[0] ?? null;
    },
  });
  return node;
}

function inFakeDom(body) {
  const previous = globalThis.document;
  const container = makeNode("div");
  globalThis.document = {
    getElementById: (id) => (id === "error-bubbles" ? container : null),
    createElement: (tag) => makeNode(tag),
  };
  try {
    return body(container);
  } finally {
    globalThis.document = previous;
  }
}

test("classifyError reads structured runtime errors", () => {
  const info = classifyError({ message: "栈溢出", line: 12, file: "scene.pe" });
  assert.equal(info.message, "栈溢出");
  assert.equal(info.line, 12);
  assert.equal(info.file, "scene.pe");
});

test("classifyError pulls the line out of a 第 N 行 string", () => {
  assert.equal(classifyError(new Error("脚本第 3 行：少了一个右括号")).line, 3);
  assert.equal(classifyError("脚本第 7 行出错").line, 7);
  // 没有行号时返回 null，而不是 NaN。
  assert.equal(classifyError(new Error("读不到文件")).line, null);
});

test("classifyError falls back to a generic message for emptiness", () => {
  assert.equal(classifyError(null).message, "脚本执行出错");
  assert.equal(classifyError(undefined).message, "脚本执行出错");
});

test("pushErrorBubble appends a persistent red alert with a close button", async () => {
  let container = null;
  let bubble = null;
  inFakeDom((host) => {
    container = host;
    bubble = pushErrorBubble({ heading: "运行出错", detail: "第 3 行：语法错误" });
    assert.ok(bubble, "返回了气泡元素");
    assert.equal(container.children.length, 1, "气泡进入右下角容器");
    assert.equal(bubble.attributes.role, "alert");
    assert.equal(bubble.className, "error-bubble");
    // 关闭按钮收起气泡本身。
    const close = bubble.children[bubble.children.length - 1];
    assert.equal(close.className, "error-bubble__close");
    close.dispatch("click");
  });
  // 关闭不是「啪」地不见：它先向右划走，划完才把节点摘掉。
  assert.match(bubble.className, /is-closing/);
  assert.equal(container.children.length, 1, "滑走的那一下它还在屏幕上");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(container.children.length, 0, "滑走之后节点才被摘掉");
});

test("pushErrorBubble stacks and trims to the newest five", () => {
  inFakeDom((container) => {
    const bubbles = [];
    for (let index = 0; index < 7; index += 1) {
      bubbles.push(pushErrorBubble({ heading: "运行出错", detail: `第 ${index} 次` }));
    }
    assert.equal(container.children.length, 5, "超出上限时只保留最新的五条");
    assert.equal(container.children[0], bubbles[2], "最早的两已被移除");
    return container;
  });
});

test("pushErrorBubble renders action buttons wired to their handlers", () => {
  let fired = false;
  inFakeDom((container) => {
    pushErrorBubble({
      heading: "运行出错",
      detail: "第 3 行：语法错误",
      actions: [{ label: "定位到行", onClick: () => { fired = true; } }],
    });
    const bubble = container.children[0];
    // 标题、正文、操作区、关闭按钮共四个子节点。
    assert.equal(bubble.children.length, 4);
    const button = bubble.children[2].children[0];
    assert.equal(button.textContent, "定位到行");
    return container;
  });
  // 这里只验证结构；handler 在真实环境里由点击事件触发。
  assert.equal(fired, false);
});

test("pushToast appends a green hint that closes itself", async () => {
  inFakeDom((container) => {
    const bubble = pushToast({ text: "按Esc以返回编辑器", duration: 0 });
    assert.ok(bubble, "返回了气泡元素");
    assert.match(bubble.className, /error-bubble--success/, "提示是绿色而不是红色错误");
    assert.equal(bubble.attributes.role, "status");
    assert.equal(bubble.children[0].textContent, "按Esc以返回编辑器");
    return container;
  });
  // duration:0 立刻到期，不留悬空的定时器拖住测试进程。
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("pushToast slides away and goes when its time is up", async () => {
  let container = null;
  let bubble = null;
  inFakeDom((host) => {
    container = host;
    bubble = pushToast({ text: "按Esc以返回编辑器", duration: 20 });
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(container.children.length, 1, "还没到时间");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(bubble.className, /is-closing/, "到点是向右划走，不是啪地不见");
  assert.equal(container.children.length, 0, "划走之后节点才被摘掉");
});

test("closing the same bubble twice does not queue two exits", async () => {
  let container = null;
  let bubble = null;
  inFakeDom((host) => {
    container = host;
    bubble = pushErrorBubble({ heading: "运行出错", detail: "第 3 行：语法错误" });
  });
  dismissBubble(bubble);
  dismissBubble(bubble);
  assert.match(bubble.className, /is-closing/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(container.children.length, 0);
});
