// 资源栏分隔条的宽度、折叠与拖动测试。
// Tests for the resource panel splitter.

import assert from "node:assert/strict";
import test from "node:test";

import { currentResourceWidth, setupSplitter } from "../panel-splitter.js";

const VAR = "--pamela-resource-width";

function stubBrowser({ viewport = 1200, width = 240 } = {}) {
  const written = new Map();
  const windowListeners = new Map();
  // The CSS variable is the storage the real splitter reads back, so the stub
  // has to reflect what was written rather than answer a fixed value.
  let current = width;

  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (name, value) => {
          written.set(name, value);
          if (name === VAR) {
            current = Number.parseFloat(value);
          }
        },
      },
    },
    body: { classList: { add() {}, remove() {} } },
    createElementNS: () => ({
      setAttribute() {},
      appendChild() {},
      append() {},
      style: {},
    }),
  };

  globalThis.window = {
    innerWidth: viewport,
    addEventListener: (type, handler) => windowListeners.set(type, handler),
    removeEventListener: (type) => windowListeners.delete(type),
  };

  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => (name === VAR ? String(current) : ""),
  });

  return { written, windowListeners };
}

function fakeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    hidden: false,
    title: "",
    classes,
    classList: {
      toggle(name, on) {
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    addEventListener: (type, handler) => listeners.set(type, handler),
    dispatch: (type, event = {}) => listeners.get(type)?.(event),
    setAttribute(name, value) {
      this[name] = value;
    },
    replaceChildren() {},
  };
}

test("the splitter writes the width it starts from", () => {
  const { written } = stubBrowser();
  const panel = fakeElement();
  const splitter = fakeElement();

  setupSplitter(panel, splitter);

  assert.equal(currentResourceWidth(), 240);
  assert.equal(written.get(VAR), "240px");
});

test("arrow keys step by 16 pixels and are clamped", () => {
  const { written } = stubBrowser();
  const panel = fakeElement();
  const splitter = fakeElement();
  setupSplitter(panel, splitter);

  const preventDefault = () => {};
  splitter.dispatch("keydown", { key: "ArrowRight", preventDefault });
  assert.equal(written.get(VAR), "256px");

  splitter.dispatch("keydown", { key: "ArrowLeft", preventDefault });
  assert.equal(written.get(VAR), "240px");

  // The viewport leaves 360px for the editor: 1200 - 360 = 840 is the ceiling.
  for (let step = 0; step < 60; step += 1) {
    splitter.dispatch("keydown", { key: "ArrowRight", preventDefault });
  }
  assert.equal(written.get(VAR), "840px");

  splitter.dispatch("keydown", { key: "Home", preventDefault });
  assert.equal(written.get(VAR), "840px");
});

test("dragging follows the pointer and stops on pointerup", () => {
  const { written, windowListeners } = stubBrowser();
  const panel = fakeElement();
  const splitter = fakeElement();
  setupSplitter(panel, splitter);

  splitter.dispatch("pointerdown", { button: 0, clientX: 300, preventDefault() {} });
  assert.ok(splitter.classes.has("is-dragging"));
  assert.ok(windowListeners.has("pointermove"));

  windowListeners.get("pointermove")({ clientX: 340 });
  assert.equal(written.get(VAR), "280px");

  windowListeners.get("pointerup")();
  assert.equal(splitter.classes.has("is-dragging"), false);
  assert.equal(windowListeners.has("pointermove"), false);
});

test("the toggle collapses the panel without losing the dragged width", () => {
  const { written } = stubBrowser({ width: 320 });
  const panel = fakeElement();
  const splitter = fakeElement();
  const toggle = fakeElement();
  setupSplitter(panel, splitter, toggle);

  assert.equal(written.get(VAR), "320px");

  toggle.dispatch("click");
  assert.ok(panel.classes.has("is-collapsed"));
  assert.equal(splitter.hidden, true);
  assert.equal(toggle["aria-expanded"], "false");
  assert.equal(written.get(VAR), "320px");

  toggle.dispatch("click");
  assert.equal(panel.classes.has("is-collapsed"), false);
  assert.equal(splitter.hidden, false);
  assert.equal(toggle["aria-expanded"], "true");
});
