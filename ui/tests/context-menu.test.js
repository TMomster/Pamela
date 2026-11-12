// 应用内右键菜单 DOM 接线测试。
// Tests for the in-app context menu's DOM wiring.

import assert from "node:assert/strict";
import test from "node:test";

import { openContextMenu } from "../context-menu.js";

/** A DOM stand-in with just the pieces `openContextMenu` touches. */
function fakeContextDom() {
  const docListeners = new Map();
  const winListeners = new Map();
  const appended = [];
  let activeElement = null;

  function flat(root) {
    return [root, ...root.children.flatMap(flat)];
  }

  function make() {
    const node = {
      className: "",
      textContent: "",
      style: {},
      attrs: {},
      children: [],
      handlers: {},
      classes: new Set(),
      removed: false,
      focused: false,
      setAttribute(key, value) {
        this.attrs[key] = String(value);
      },
      classList: {
        add(name) {
          node.classes.add(name);
        },
        contains(name) {
          return node.classes.has(name);
        },
      },
      append(...items) {
        this.children.push(...items);
      },
      addEventListener(type, fn) {
        (this.handlers[type] ??= []).push(fn);
      },
      remove() {
        this.removed = true;
      },
      focus() {
        this.focused = true;
        activeElement = node;
      },
      contains(target) {
        return flat(node).includes(target);
      },
      getBoundingClientRect() {
        return { width: 120, height: 60 };
      },
      querySelectorAll(selector) {
        if (!selector.includes("menu__item")) {
          return [];
        }
        return flat(node).filter(
          (child) => child.className === "menu__item" && !child.classes.has("is-disabled"),
        );
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
      click() {
        for (const fn of this.handlers.click ?? []) {
          fn({ target: node, preventDefault() {} });
        }
      },
    };
    return node;
  }

  const document = {
    createElement: make,
    body: { append: (node) => appended.push(node) },
    addEventListener(type, fn) {
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      docListeners.set(type, (docListeners.get(type) ?? []).filter((f) => f !== fn));
    },
    get activeElement() {
      return activeElement;
    },
  };
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener(type, fn) {
      winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      winListeners.set(type, (winListeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  return { document, window, appended, docListeners, winListeners };
}

/** Installs the fake DOM for one test and always puts the globals back. */
function withFakeDom(run) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const fake = fakeContextDom();
  globalThis.document = fake.document;
  globalThis.window = fake.window;
  const restore = () => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  };
  let result;
  try {
    result = run(fake);
  } catch (error) {
    restore();
    throw error;
  }
  return Promise.resolve(result).finally(restore);
}

test("the menu draws items, separators and disabled entries", async () => {
  await withFakeDom(async ({ appended }) => {
    const pending = openContextMenu({
      x: 10,
      y: 10,
      items: [
        { label: "复制", command: "copy" },
        { separator: true },
        { label: "删除", command: "delete", disabled: true },
      ],
    });
    const menu = appended[0];
    assert.equal(menu.className, "menu menu--context");
    assert.equal(menu.attrs.role, "menu");
    assert.equal(menu.children.length, 3);
    assert.equal(menu.children[0].textContent, "复制");
    assert.equal(menu.children[1].attrs.role, "separator");
    assert.equal(menu.children[2].classes.has("is-disabled"), true);
    assert.equal(menu.children[2].attrs["aria-disabled"], "true");
    assert.equal(menu.children[2].handlers.click, undefined, "a disabled item must not be clickable");
    assert.equal(menu.children[0].focused, true);
    assert.ok(Number.parseFloat(menu.style.left) >= 4);

    menu.children[0].click();
    assert.equal(await pending, "copy");
    assert.equal(menu.removed, true);
  });
});

test("a font item previews its family in the name and the sample", async () => {
  await withFakeDom(async ({ appended }) => {
    const pending = openContextMenu({
      x: 10,
      y: 10,
      items: [
        {
          label: "宋体",
          command: "宋体",
          fontFamily: '"宋体", sans-serif',
          sample: "示例字体Abc",
        },
      ],
    });
    const item = appended[0].children[0];
    assert.equal(item.children.length, 2);
    assert.equal(item.children[0].textContent, "宋体");
    assert.equal(item.children[1].textContent, "示例字体Abc");
    assert.equal(item.children[0].style.fontFamily, '"宋体", sans-serif');
    assert.equal(item.children[1].style.fontFamily, '"宋体", sans-serif');

    item.click();
    assert.equal(await pending, "宋体");
  });
});

test("Escape dismisses the menu with null", async () => {
  await withFakeDom(async ({ docListeners, winListeners, appended }) => {
    const pending = openContextMenu({ x: 10, y: 10, items: [{ label: "A", command: "a" }] });
    const keys = docListeners.get("keydown") ?? [];
    assert.equal(keys.length, 1);
    let prevented = false;
    keys[0]({ key: "Escape", preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(await pending, null);
    assert.equal(appended[0].removed, true);
    assert.equal((docListeners.get("keydown") ?? []).length, 0);
    assert.equal((winListeners.get("blur") ?? []).length, 0);
  });
});

test("a pointer-down outside the menu closes it and drops its listeners", async () => {
  await withFakeDom(async ({ docListeners, appended }) => {
    const pending = openContextMenu({ x: 10, y: 10, items: [{ label: "A", command: "a" }] });
    const outside = docListeners.get("pointerdown") ?? [];
    assert.equal(outside.length, 1);
    outside[0]({ target: null });
    assert.equal(await pending, null);
    assert.equal(appended[0].removed, true);
    assert.equal((docListeners.get("pointerdown") ?? []).length, 0);
  });
});

test("the menu flips back from the right and bottom edges", async () => {
  await withFakeDom(async ({ appended }) => {
    const pending = openContextMenu({ x: 790, y: 590, items: [{ label: "A", command: "a" }] });
    const menu = appended[0];
    assert.ok(Number.parseFloat(menu.style.left) <= 800 - 120 - 4);
    assert.ok(Number.parseFloat(menu.style.top) <= 600 - 60 - 4);
    menu.children[0].click();
    await pending;
  });
});

test("a wheel over a long menu scrolls it; a wheel outside dismisses", async () => {
  await withFakeDom(async ({ appended, winListeners }) => {
    const pending = openContextMenu({ x: 10, y: 10, items: [{ label: "A", command: "a" }] });
    let settled = null;
    void pending.then((value) => {
      settled = value;
    });
    const menu = appended[0];
    const wheel = (winListeners.get("wheel") ?? [])[0];
    assert.ok(wheel, "the menu watches the wheel");

    wheel({ target: menu.children[0] });
    await Promise.resolve();
    assert.equal(settled, null, "滚动字体列表时菜单不能自己关掉");

    wheel({ target: {} });
    assert.equal(await pending, null);
  });
});
