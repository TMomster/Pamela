// 播放器开始画面：黑屏等一次左键或空格，然后才演出。
// Pamela — the player's start gate waits for one left click or Space.

import assert from "node:assert/strict";
import test from "node:test";

import { PLAYER_START_HINT, createPlayerStart } from "../player-start.js";

function fakeNode(tag = "div") {
  const node = {
    tagName: tag,
    className: "",
    textContent: "",
    hidden: false,
    attributes: {},
    children: [],
    parent: null,
    listeners: {},
    append(...nodes) {
      for (const child of nodes) {
        child.parent = node;
        node.children.push(child);
      }
    },
    setAttribute(name, value) { node.attributes[name] = value; },
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      node.listeners[type] = (node.listeners[type] || []).filter((entry) => entry !== fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(node.listeners[type] || [])]) {
        fn(event);
      }
    },
    focus() {},
    remove() {
      if (node.parent) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
      }
    },
  };
  return node;
}

/** Installs a document that can build SVG icons and hear captured key presses. */
function inFakeDom(body) {
  const previous = globalThis.document;
  const listeners = {};
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    createElementNS: (_ns, tag) => fakeNode(tag),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== fn);
    },
    key(type, event) {
      for (const fn of [...(listeners[type] || [])]) fn(event);
    },
    listenerCount: (type) => (listeners[type] || []).length,
  };
  try {
    return body(globalThis.document);
  } finally {
    globalThis.document = previous;
  }
}

test("the gate starts hidden and carries the play button and the hint", () => {
  inFakeDom(() => {
    const host = fakeNode();
    const gate = createPlayerStart({ host });
    assert.equal(gate.element.hidden, true);
    assert.equal(gate.isOpen(), false);
    assert.equal(host.children.length, 1);
    const [button, hint] = gate.element.children;
    assert.equal(button.className, "player-start__button");
    assert.equal(hint.textContent, PLAYER_START_HINT);
  });
});

test("one left click starts the run and closes the gate", () => {
  inFakeDom(() => {
    let starts = 0;
    const gate = createPlayerStart({ host: fakeNode(), onStart: () => { starts += 1; } });
    gate.open();
    assert.equal(gate.isOpen(), true);
    assert.equal(gate.element.hidden, false);

    gate.element.dispatch("click", { button: 2, preventDefault() {} });
    assert.equal(starts, 0, "右键不开始");

    gate.element.dispatch("click", { button: 0, preventDefault() {}, stopPropagation() {} });
    assert.equal(starts, 1);
    assert.equal(gate.isOpen(), false);
    assert.equal(gate.element.hidden, true);
    gate.element.dispatch("click", { button: 0, preventDefault() {}, stopPropagation() {} });
    assert.equal(starts, 1, "只触发一次");
  });
});

test("Space starts the run and keydown listener is removed on close", () => {
  inFakeDom((doc) => {
    let starts = 0;
    const gate = createPlayerStart({ host: fakeNode(), onStart: () => { starts += 1; } });
    gate.open();
    assert.equal(doc.listenerCount("keydown"), 1);
    const prevented = [];
    doc.key("keydown", {
      key: " ",
      repeat: false,
      preventDefault: () => prevented.push("space"),
      stopPropagation() {},
    });
    assert.equal(starts, 1);
    assert.deepEqual(prevented, ["space"]);
    assert.equal(gate.isOpen(), false);
    assert.equal(doc.listenerCount("keydown"), 0, "开始后不再抢空格");
  });
});

test("Esc and other keys do not start the run; closing removes the listener", () => {
  inFakeDom((doc) => {
    let starts = 0;
    const gate = createPlayerStart({ host: fakeNode(), onStart: () => { starts += 1; } });
    gate.open();
    doc.key("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
    doc.key("keydown", { key: "a", preventDefault() {}, stopPropagation() {} });
    assert.equal(starts, 0);
    gate.close();
    assert.equal(doc.listenerCount("keydown"), 0);
    assert.equal(gate.isOpen(), false);
  });
});
