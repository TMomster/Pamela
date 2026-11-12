// 阅读器正文宽度控件的测试。
// Tests for the reader's measure control.

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampMeasure,
  createReaderMeasure,
  measureFromDrag,
  READER_MEASURE,
} from "../reader-width.js";

/** A stand-in element, enough to build and drive the control in node. */
function fakeNode(tag = "div") {
  const classes = new Set();
  const listeners = new Map();
  const attributes = {};
  const properties = new Map();

  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    rect: { width: 0 },
    style: {
      setProperty(name, value) {
        properties.set(name, String(value));
      },
      getPropertyValue(name) {
        return properties.get(name) ?? "";
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
    getProperty(name) {
      return properties.get(name) ?? "";
    },
  };

  return node;
}

/** A stand-in `window` that records the listeners a drag installs. */
function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
    listening(type) {
      return listeners.has(type);
    },
  };
}

/**
 * Builds the control against fake globals.
 *
 * `chPx` is what one `ch` measures in pixels — the probe's width, which the
 * control reads to turn pointer pixels into `ch`.
 */
function harness({ chPx = 10 } = {}) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const body = fakeNode("body");
  globalThis.document = { createElement: (tag) => fakeNode(tag), body };
  globalThis.window = fakeWindow();

  const view = fakeNode("div");
  const control = createReaderMeasure({ view });
  const probe = control.element.children[0];
  probe.rect = { width: chPx };

  return {
    control,
    view,
    body,
    win: globalThis.window,
    restore() {
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
    },
  };
}

test("栏宽夹取在允许范围内，并把非数字退回默认值", () => {
  assert.equal(clampMeasure(10), READER_MEASURE.min);
  assert.equal(clampMeasure(9999), READER_MEASURE.max);
  assert.equal(clampMeasure(77.6), 78);
  assert.equal(clampMeasure("64"), 64);
  assert.equal(clampMeasure(undefined), READER_MEASURE.default);
  assert.equal(clampMeasure("宽"), READER_MEASURE.default);
});

test("拖动换算成栏宽：居中栏两边同时移动，一像素对应两倍宽度变化", () => {
  assert.equal(measureFromDrag(78, 20, 10), 82);
  assert.equal(measureFromDrag(78, -20, 10), 74);
  assert.equal(measureFromDrag(78, 2, 8), 79);
  // 量尺读不出宽度时按兜底值换算，而不是除以零。
  assert.equal(measureFromDrag(78, 8, 0), 80);
  assert.equal(measureFromDrag(READER_MEASURE.max, 500, 10), READER_MEASURE.max);
  assert.equal(measureFromDrag(READER_MEASURE.min, -500, 10), READER_MEASURE.min);
});

test("控件建好即写入默认栏宽，并对外说明取值范围", () => {
  const { control, view, restore } = harness();
  try {
    const bar = control.element;
    assert.equal(control.measure(), READER_MEASURE.default);
    assert.equal(view.getProperty("--reader-measure"), `${READER_MEASURE.default}ch`);
    assert.equal(bar.getAttribute("role"), "separator");
    assert.equal(bar.getAttribute("aria-orientation"), "horizontal");
    assert.equal(bar.getAttribute("aria-label"), "正文宽度");
    assert.equal(bar.getAttribute("aria-valuemin"), String(READER_MEASURE.min));
    assert.equal(bar.getAttribute("aria-valuemax"), String(READER_MEASURE.max));
    assert.equal(bar.getAttribute("aria-valuenow"), String(READER_MEASURE.default));
    assert.ok(bar.title.includes("拖动"));
  } finally {
    restore();
  }
});

test("拖动横条改变栏宽，松手后收起拖动状态与监听", () => {
  const { control, view, body, win, restore } = harness({ chPx: 10 });
  try {
    const bar = control.element;
    let prevented = 0;

    bar.dispatch("pointerdown", {
      button: 0,
      clientX: 100,
      preventDefault() {
        prevented += 1;
      },
    });
    assert.equal(prevented, 1);
    assert.equal(bar.classList.contains("is-dragging"), true);
    assert.equal(body.classList.contains("is-resizing"), true);
    assert.equal(win.listening("pointermove"), true);

    win.dispatch("pointermove", { clientX: 120 });
    assert.equal(control.measure(), 82);
    assert.equal(view.getProperty("--reader-measure"), "82ch");
    assert.equal(bar.getAttribute("aria-valuenow"), "82");

    win.dispatch("pointerup", {});
    assert.equal(bar.classList.contains("is-dragging"), false);
    assert.equal(body.classList.contains("is-resizing"), false);
    assert.equal(win.listening("pointermove"), false);
  } finally {
    restore();
  }
});

test("拖过界时停在允许范围的两端", () => {
  const { control, win, restore } = harness({ chPx: 10 });
  try {
    control.element.dispatch("pointerdown", { button: 0, clientX: 0, preventDefault() {} });
    win.dispatch("pointermove", { clientX: 5000 });
    assert.equal(control.measure(), READER_MEASURE.max);

    win.dispatch("pointermove", { clientX: -5000 });
    assert.equal(control.measure(), READER_MEASURE.min);
  } finally {
    restore();
  }
});

test("只有主键开始拖动，右键与中键不动栏宽", () => {
  const { control, win, restore } = harness();
  try {
    for (const button of [1, 2]) {
      control.element.dispatch("pointerdown", { button, clientX: 0, preventDefault() {} });
      assert.equal(win.listening("pointermove"), false, `button ${button} 不应开始拖动`);
    }
    assert.equal(control.measure(), READER_MEASURE.default);
  } finally {
    restore();
  }
});

test("双击与 Home 复位，方向键按步长微调", () => {
  const { control, restore } = harness();
  try {
    const bar = control.element;
    const key = (name) => {
      let prevented = 0;
      bar.dispatch("keydown", {
        key: name,
        preventDefault() {
          prevented += 1;
        },
      });
      return prevented;
    };

    control.apply(100);
    assert.equal(control.measure(), 100);

    bar.dispatch("dblclick", {});
    assert.equal(control.measure(), READER_MEASURE.default);

    assert.equal(key("ArrowRight"), 1);
    assert.equal(control.measure(), READER_MEASURE.default + 2);
    assert.equal(key("ArrowLeft"), 1);
    assert.equal(control.measure(), READER_MEASURE.default);

    control.apply(90);
    assert.equal(key("Home"), 1);
    assert.equal(control.measure(), READER_MEASURE.default);

    // 其他按键不改变栏宽，也不拦截默认行为。
    assert.equal(key("a"), 0);
    assert.equal(control.measure(), READER_MEASURE.default);
  } finally {
    restore();
  }
});
