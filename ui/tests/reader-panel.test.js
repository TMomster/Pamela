// 内建阅读器的模式切换测试。
// Tests for the built-in reader panel.

import assert from "node:assert/strict";
import test from "node:test";

import { createReaderPanel } from "../reader-panel.js";
import { readerSet } from "../reader.js";

function harness() {
  const dom = {};
  const session = { reader: null };
  const calls = { resource: 0, editor: 0 };
  const panel = createReaderPanel({
    dom,
    session,
    refreshResourcePanel: () => {
      calls.resource += 1;
    },
    refreshEditor: () => {
      calls.editor += 1;
    },
  });
  return { dom, session, calls, panel };
}

/** A stand-in element, enough to render an article into a fake view. */
function fakeNode(tag = "div") {
  const classes = new Set();
  const listeners = new Map();
  const attributes = {};
  const properties = new Map();

  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: "",
    title: "",
    tabIndex: 0,
    children: [],
    scrollTop: 0,
    rect: { width: 0 },
    style: {
      setProperty(name, value) {
        properties.set(name, String(value));
      },
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    append(...kids) {
      node.children.push(...kids);
    },
    replaceChildren(...kids) {
      node.children = [...kids];
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
    getBoundingClientRect() {
      return node.rect;
    },
    focus() {},
    getProperty(name) {
      return properties.get(name) ?? "";
    },
  };

  return node;
}

/**
 * Renders one article into a fake view.
 *
 * Returns the panel, the view and a restore hook, since the reader builds its
 * DOM through `document`.
 */
function renderHarness(setName, articleId) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    body: fakeNode("body"),
  };

  const view = fakeNode("div");
  const panel = createReaderPanel({
    dom: { readerView: view },
    session: { reader: null },
    refreshResourcePanel() {},
    refreshEditor() {},
  });
  panel.open(setName, articleId);
  panel.render();

  return {
    panel,
    view,
    restore() {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    },
  };
}

test("open falls back to the set's first article", () => {
  const { session, calls, panel } = harness();
  panel.open("help", "no-such-article");

  const first = readerSet("help").articles[0];
  assert.deepEqual(session.reader, { setName: "help", articleId: first.id });
  assert.equal(calls.resource, 1);
  assert.equal(calls.editor, 1);
});

test("open with an unknown set leaves the editor alone", () => {
  const { session, calls, panel } = harness();
  panel.open("no-such-set");

  assert.equal(session.reader, null);
  assert.equal(calls.resource, 0);
  assert.equal(calls.editor, 0);
});

test("close is a no-op when the reader is not open", () => {
  const { session, calls, panel } = harness();
  panel.close();

  assert.equal(session.reader, null);
  assert.equal(calls.resource, 0);
  assert.equal(calls.editor, 0);
});

test("close hands the editor area back and repaints both panels", () => {
  const { session, calls, panel } = harness();
  panel.open("about");
  calls.resource = 0;
  calls.editor = 0;

  panel.close();

  assert.equal(session.reader, null);
  assert.equal(calls.resource, 1);
  assert.equal(calls.editor, 1);
});

test("leave reports whether it was open and can skip the editor repaint", () => {
  const { session, calls, panel } = harness();

  assert.equal(panel.leave(), false);

  panel.open("help");
  calls.resource = 0;
  calls.editor = 0;
  assert.equal(panel.leave({ repaint: false }), true);

  assert.equal(session.reader, null);
  assert.equal(calls.resource, 1);
  assert.equal(calls.editor, 0);
});

test("label names the set and the article, and is empty when closed", () => {
  const { panel } = harness();
  assert.equal(panel.label(), "");

  panel.open("help", "no-such-article");
  const first = readerSet("help").articles[0];
  assert.equal(panel.label(), `帮助 · ${first.title}`);
});

test("toc answers null for an unknown set instead of building a list", () => {
  const { panel } = harness();
  assert.equal(panel.toc("no-such-set", ""), null);
});

test("正文上方的宽度控件随文章重画，栏宽跨文章保持", () => {
  const { panel, view, restore } = renderHarness("help", "");
  try {
    const bar = view.children[0];
    assert.equal(bar.className, "reader__measure", "控件排在正文之前");
    assert.equal(view.children.length, 2);

    bar.dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
    const widened = view.getProperty("--reader-measure");
    assert.notEqual(widened, "78ch");

    const next = readerSet("help").articles[1].id;
    panel.open("help", next);
    panel.render();

    assert.equal(view.children[0], bar, "控件只建一次，不随文章重建");
    assert.equal(view.getProperty("--reader-measure"), widened, "换文章不改栏宽");
  } finally {
    restore();
  }
});
