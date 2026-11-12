// 菜单栏启用与禁用状态测试。
// Tests for the menu bar's enabled/disabled state.
// 回归场景：分隔符之后的最末一项若被错误配对，会一直处于禁用状态。

import assert from "node:assert/strict";
import test from "node:test";

import { createMenuBar } from "../render.js";
import { MENUS } from "../menus.js";

/** A stand-in element, enough for the menu bar to be built in node. */
function fakeNode(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    type: "",
    textContent: "",
    disabled: false,
    childNodes: [],
    attributes: {},
    // A real element keeps `className` and `classList` in step, and the menu
    // code relies on that: it sets `className` while building and asks
    // `classList` afterwards.
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      for (const name of String(value ?? "").split(/\s+/)) {
        if (name) classes.add(name);
      }
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
      toggle(name, on) {
        if (on === undefined) {
          classes.has(name) ? classes.delete(name) : classes.add(name);
        } else if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return classes.has(name);
      },
    },
    append(...children) {
      node.childNodes.push(...children);
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
      if (name === "class") node.className = value;
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event ?? { stopPropagation() {}, target: node });
    },
    focus() {},
    contains(other) {
      return other === node;
    },
    querySelectorAll(selector) {
      const wanted = selector.replace(/^\./, "");
      const out = [];
      const walk = (n) => {
        for (const child of n.childNodes ?? []) {
          if (child.classList?.contains(wanted)) out.push(child);
          walk(child);
        }
      };
      walk(node);
      return out;
    },
  };
  return node;
}

/** Runs `body` with a minimal `document`, so the menu bar can be built. */
function withFakeDom(body) {
  const previous = globalThis.document;
  const listeners = new Map();
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    body: fakeNode("body"),
  };
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

/** The popup of one menu, by its id in `MENUS`. */
function popupOf(bar, menuId) {
  // The bar builds one wrapper per menu, in order, each holding a title and a
  // popup; the popup is the one with `.menu`.
  const wraps = bar.element.childNodes;
  const index = MENUS.findIndex((entry) => entry.id === menuId);
  assert.notEqual(index, -1, `菜单 ${menuId} 不存在`);
  const wrap = wraps[index];
  return wrap.childNodes.find((child) => child.classList.contains("menu"));
}

/** Every clickable item of a menu, as `{ label, node }`. */
function itemsOf(bar, menuId) {
  return popupOf(bar, menuId)
    .querySelectorAll(".menu__item")
    .map((node) => ({
      node,
      label: node.childNodes[0]?.textContent ?? "",
    }));
}

test("菜单：分隔符之后的项也拿到自己的启用状态，不串位", () => {
  withFakeDom(() => {
    const bar = createMenuBar({ onCommand: () => {} });

    // No project, no run: only the entries that need neither are enabled.
    bar.setContext({ hasProject: false, hasOpenFile: false, running: false });

    const items = itemsOf(bar, "stage");
    const byLabel = new Map(items.map((entry) => [entry.label, entry]));

    // 演出 has separators before 自动播放, before 存档, and before 新建关键帧.
    assert.equal(
      byLabel.get("自动播放").node.classList.contains("is-disabled"),
      true,
      "没有运行时，自动播放该是灰的",
    );
    assert.equal(
      byLabel.get("存档（当前节点）…").node.classList.contains("is-disabled"),
      true,
      "没有项目时，存档该是灰的",
    );
    // 回归场景：分隔符之后的最末一项若被错误配对，会一直处于禁用状态。
    const last = byLabel.get("读档…");
    assert.ok(last, "读档… 必须在菜单里");
    assert.equal(
      last.node.classList.contains("is-disabled"),
      true,
      "没有项目时，读档该是灰的",
    );
  });
});

test("菜单：有项目后，分隔符之后的项会真的亮起来", () => {
  withFakeDom(() => {
    const bar = createMenuBar({ onCommand: () => {} });
    bar.setContext({ hasProject: true, hasOpenFile: false, running: false });

    const items = itemsOf(bar, "stage");
    const byLabel = new Map(items.map((entry) => [entry.label, entry]));

    // This is the assertion that would have caught the bug: with a project the
    // last entry must become clickable, and before the fix it never did.
    assert.equal(
      byLabel.get("读档…").node.classList.contains("is-disabled"),
      false,
      "有项目后读档必须可用",
    );
    assert.equal(
      byLabel.get("存档（当前节点）…").node.classList.contains("is-disabled"),
      false,
      "有项目后存档必须可用",
    );
    // Still no run, so the playback words stay grey — and they must be grey for
    // their own reason, not because they read a neighbour's state.
    assert.equal(
      byLabel.get("自动播放").node.classList.contains("is-disabled"),
      true,
      "没有运行时自动播放仍是灰的",
    );
  });
});

test("菜单：每个项的启用状态都对应它自己的命令", () => {
  withFakeDom(() => {
    const bar = createMenuBar({ onCommand: () => {} });
    // A context where the answer differs per command, so a shifted pairing
    // would show up as a disagreement rather than passing by luck.
    bar.setContext({ hasProject: true, hasOpenFile: true, running: true });

    for (const menu of MENUS) {
      const popup = popupOf(bar, menu.id);
      const nodes = popup.querySelectorAll(".menu__item");
      // One node per row, including submenu parents and their children.
      const rows = (items) =>
        items.flatMap((item) =>
          item.separator ? [] : item.submenu ? [item, ...rows(item.submenu)] : [item],
        );
      assert.equal(nodes.length, rows(menu.items).length, `${menu.id} 的项数与节点数必须一致`);

      for (const node of nodes) {
        assert.ok(
          node.getAttribute("aria-disabled") === "true" ||
            node.getAttribute("aria-disabled") === "false",
          `${menu.id} 的每一项都该有 aria-disabled`,
        );
      }
    }
  });
});
