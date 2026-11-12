// 存读档插槽网格测试。
// Tests for the save/load slot grid.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSlotPanel,
  formatSavedAt,
  pageCount,
  pageOf,
  pageSlots,
  slotAction,
  slotNumber,
  slotTitle,
  SLOTS_PER_PAGE,
} from "../slots.js";

/** A save as the panel receives one. */
function save(name, extra = {}) {
  return { name, path: `saves/${name}.json`, title: "", savedAt: "", thumbnail: null, ...extra };
}

test("a page holds three columns of four, numbered across pages", () => {
  assert.equal(SLOTS_PER_PAGE, 12);
  assert.equal(slotNumber(0, 0), 1);
  assert.equal(slotNumber(0, 11), 12);
  assert.equal(slotNumber(1, 0), 13);
  assert.equal(slotNumber(2, 5), 30);
});

test("a page is always a full grid, filled or not", () => {
  const slots = pageSlots([save("a"), save("b")], 0);
  assert.equal(slots.length, SLOTS_PER_PAGE);
  assert.equal(slots[0].name, "a");
  assert.equal(slots[1].name, "b");
  assert.equal(slots[2], null);
  assert.equal(slots[11], null);
  // An empty list still answers a page: an empty project shows twelve blanks
  // rather than no grid at all.
  assert.deepEqual(pageSlots([], 0), new Array(SLOTS_PER_PAGE).fill(null));
  assert.deepEqual(pageSlots(null, 0), new Array(SLOTS_PER_PAGE).fill(null));
});

test("the second page starts where the first ends", () => {
  const saves = Array.from({ length: 20 }, (_, index) => save(`s${index}`));
  const first = pageSlots(saves, 0);
  const second = pageSlots(saves, 1);
  assert.equal(first[0].name, "s0");
  assert.equal(first[11].name, "s11");
  assert.equal(second[0].name, "s12");
  assert.equal(second[7].name, "s19");
  assert.equal(second[8], null);
  // A page past the end is empty rather than out of range.
  assert.deepEqual(pageSlots(saves, 9), new Array(SLOTS_PER_PAGE).fill(null));
});

test("the page count covers the last save and is never zero", () => {
  assert.equal(pageCount([]), 1);
  assert.equal(pageCount(null), 1);
  assert.equal(pageCount([save("a")]), 1);
  assert.equal(pageCount(new Array(SLOTS_PER_PAGE).fill(save("a"))), 1);
  assert.equal(pageCount(new Array(SLOTS_PER_PAGE + 1).fill(save("a"))), 2);
  assert.equal(pageCount(new Array(SLOTS_PER_PAGE * 3).fill(save("a"))), 3);
});

test("a save's index names the page it falls on", () => {
  assert.equal(pageOf(0), 0);
  assert.equal(pageOf(11), 0);
  assert.equal(pageOf(12), 1);
  assert.equal(pageOf(35), 2);
});

test("a slot shows the label the save was written with", () => {
  assert.equal(slotTitle(save("存档 2026-10-18 15-33", { title: "第一章 教室" })), "第一章 教室");
  // No label — an older save, or one renamed on disk: the slot name stands in
  // rather than the slot reading as empty.
  assert.equal(slotTitle(save("第一章")), "第一章");
  assert.equal(slotTitle(save("第一章", { title: "   " })), "第一章");
  assert.equal(slotTitle(null), "");
});

test("a save's time is written the way the panel shows it", () => {
  // Local time, minute precision, zero padded.
  const iso = new Date(2026, 9, 18, 15, 33).toISOString();
  assert.equal(formatSavedAt(iso), "2026-10-18 15:33");
  assert.equal(formatSavedAt(new Date(2026, 0, 2, 3, 4).toISOString()), "2026-01-02 03:04");
  // A missing or unreadable stamp is blank, never "Invalid Date".
  assert.equal(formatSavedAt(""), "");
  assert.equal(formatSavedAt(undefined), "");
  assert.equal(formatSavedAt("not a date"), "");
});

test("what a click does depends on the mode and whether the slot is filled", () => {
  // Saving over a filled slot is an overwrite, and says so.
  assert.deepEqual(slotAction("save", true), { label: "覆盖", enabled: true });
  assert.deepEqual(slotAction("save", false), { label: "保存", enabled: true });
  // Loading a filled slot reads it; an empty one has nothing to load.
  assert.deepEqual(slotAction("load", true), { label: "读取", enabled: true });
  assert.deepEqual(slotAction("load", false), { label: "空栏位", enabled: false });
});

// Below: the panel needs a real DOM to draw, so a minimal one is stood up. It
// records children and listeners, which is all the tests reach for.

/** A node with just what `slots.js` touches, and nothing it does not. */
function fakeElement(tag = "div") {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    dataset: {},
    style: {},
    className: "",
    textContent: "",
    title: "",
    hidden: false,
    disabled: false,
    type: "",
    src: "",
    alt: "",
    draggable: false,
    setAttribute() {},
    append(...nodes) {
      this.children.push(...nodes.filter(Boolean));
    },
    replaceChildren(...nodes) {
      this.children = nodes.filter(Boolean);
    },
    addEventListener(event, handler) {
      (this.listeners[event] ??= []).push(handler);
    },
    classList: {
      _set: new Set(),
      add(...names) {
        for (const name of names) {
          this._set.add(name);
        }
      },
    },
  };
  return element;
}

/** Walks a fake tree, collecting nodes where `predicate` is true. */
function findAll(node, predicate, found = []) {
  for (const child of node.children ?? []) {
    if (predicate(child)) {
      found.push(child);
    }
    findAll(child, predicate, found);
  }
  return found;
}

/** Runs `body` with a minimal `document`, so the panel can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => fakeElement(tag),
    // The panel's icon buttons are SVG; the namespace is irrelevant to a fake
    // node, only the call has to exist.
    createElementNS: (_namespace, tag) => fakeElement(tag),
  };
  try {
    body();
  } finally {
    globalThis.document = previous;
  }
}

test("a filled slot shows a delete control that fires onDelete, not onPick", () => {
  let picked = null;
  let deleted = null;
  inFakeDom(() => {
    const host = fakeElement("div");
    const panel = createSlotPanel({
      host,
      onPick: (mode, save) => {
        picked = { mode, save };
      },
      onDelete: (mode, save, page, index) => {
        deleted = { mode, save, page, index };
      },
    });
    const save = { name: "存档 A", path: "saves/A.json", title: "", savedAt: "", thumbnail: null };
    panel.open({ mode: "load", page: 0, saves: [save, null] });

    const controls = findAll(
      host,
      (el) => typeof el.className === "string" && el.className.includes("slots__delete"),
    );
    assert.equal(controls.length, 1, "one delete control for the filled slot");

    // Clicking it must delete, and must not also pick the slot it sits on.
    controls[0].listeners.click[0]({ stopPropagation() {} });
  });
  assert.equal(deleted?.save.name, "存档 A", "onDelete fired with the save");
  assert.equal(picked, null, "the slot itself was not picked");
});

test("an empty slot has no delete control", () => {
  inFakeDom(() => {
    const host = fakeElement("div");
    const panel = createSlotPanel({
      host,
      onPick() {},
      onDelete() {},
    });
    panel.open({ mode: "save", page: 0, saves: [null] });
    const controls = findAll(
      host,
      (el) => typeof el.className === "string" && el.className.includes("slots__delete"),
    );
    assert.equal(controls.length, 0);
  });
});
