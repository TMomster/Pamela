// 模态对话框 DOM 接线测试。
// Tests for the modal dialogs' DOM wiring.

import assert from "node:assert/strict";
import test from "node:test";

import { showMessage } from "../modal.js";

/** A node just rich enough for `showMessage` to assemble and settle a dialog. */
function fakeNode() {
  const node = {
    className: "",
    textContent: "",
    style: {},
    attrs: {},
    children: [],
    handlers: {},
    removed: 0,
    focused: false,
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    },
    append(...items) {
      this.children.push(...items);
    },
    addEventListener(type, fn) {
      (this.handlers[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn);
    },
    remove() {
      this.removed += 1;
    },
    focus() {
      this.focused = true;
    },
    click() {
      for (const fn of this.handlers.click ?? []) {
        fn({ target: this, preventDefault() {} });
      }
    },
  };
  return node;
}

/** Installs a fake document for the duration of one test and restores it. */
function withFakeDom(run) {
  const previous = globalThis.document;
  const appended = [];
  const listeners = new Map();
  globalThis.document = {
    createElement: fakeNode,
    body: { append: (node) => appended.push(node) },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  const restore = () => {
    if (previous === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous;
    }
  };
  let result;
  try {
    result = run({ appended, listeners });
  } catch (error) {
    restore();
    throw error;
  }
  return Promise.resolve(result).finally(restore);
}

test("showMessage mounts title, body and one confirm button", async () => {
  await withFakeDom(async ({ appended }) => {
    const pending = showMessage({ title: "关于 Pamela", body: "正文内容" });
    assert.equal(appended.length, 1);
    const overlay = appended[0];
    assert.equal(overlay.className, "modal-overlay");

    const dialog = overlay.children[0];
    assert.equal(dialog.className, "modal");
    assert.equal(dialog.attrs.role, "dialog");
    assert.equal(dialog.attrs["aria-modal"], "true");

    const [heading, text, actions] = dialog.children;
    assert.equal(heading.textContent, "关于 Pamela");
    assert.equal(text.textContent, "正文内容");
    const button = actions.children[0];
    assert.equal(button.textContent, "确定");
    assert.equal(button.focused, true);

    button.click();
    await pending;
    assert.equal(overlay.removed, 1);
  });
});

test("Escape settles the dialog and removes the key listener", async () => {
  await withFakeDom(async ({ appended, listeners }) => {
    const pending = showMessage({ title: "t", body: "b" });
    const keys = listeners.get("keydown") ?? [];
    assert.equal(keys.length, 1);
    let prevented = false;
    keys[0]({ key: "Escape", preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    await pending;
    assert.equal(appended[0].removed, 1);
    assert.equal((listeners.get("keydown") ?? []).length, 0);
  });
});

test("settling twice does not remove the overlay twice", async () => {
  await withFakeDom(async ({ appended }) => {
    const pending = showMessage({ title: "t", body: "b" });
    const button = appended[0].children[0].children[2].children[0];
    button.click();
    button.click();
    await pending;
    assert.equal(appended[0].removed, 1);
  });
});
