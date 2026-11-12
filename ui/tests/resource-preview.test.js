// 资源树悬停预览的缓存与项目切换测试。
// Tests for the resource panel's hover preview.

import assert from "node:assert/strict";
import test from "node:test";

import { createResourcePreview } from "../resource-preview.js";

const HOVER_DELAY = 220;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeTree() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) {
        handler(event);
      }
    },
  };
}

function fakeRow(path) {
  const row = { dataset: { path } };
  row.closest = () => row;
  row.getBoundingClientRect = () => ({ left: 20, right: 200, top: 100, width: 180, height: 20 });
  return row;
}

function stubDocument() {
  const boxes = [];
  globalThis.document = {
    createElement() {
      const node = {
        className: "",
        style: {},
        children: [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 90 }),
        append(...kids) {
          node.children.push(...kids);
        },
        addEventListener() {},
        remove() {
          node.removed = true;
        },
      };
      boxes.push(node);
      return node;
    },
    body: { append() {} },
  };
  return boxes;
}

function stubWindow() {
  const listeners = new Map();
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  return listeners;
}

function harness() {
  stubDocument();
  stubWindow();
  const tree = fakeTree();
  const reads = [];
  const preview = createResourcePreview({
    dom: { resourceBody: tree },
    getActions: () => ({
      readImage: async (path) => {
        reads.push(path);
        return `data:image/png;base64,${path}`;
      },
    }),
  });
  preview.wire();
  return { tree, reads, preview };
}

test("a hovered picture is read once and then served from the cache", async () => {
  const { tree, reads } = harness();
  const row = fakeRow("assets/Character/ch.png");

  tree.dispatch("pointerover", { target: row });
  await wait(HOVER_DELAY + 40);
  assert.deepEqual(reads, ["assets/Character/ch.png"]);

  tree.dispatch("pointerout", { target: row, relatedTarget: null });
  tree.dispatch("pointerover", { target: row });
  await wait(HOVER_DELAY + 40);
  assert.equal(reads.length, 1);
});

test("changing the project drops the cache", async () => {
  const { tree, reads, preview } = harness();
  const row = fakeRow("assets/Character/ch.png");
  const projectOne = { name: "one" };
  const projectTwo = { name: "two" };

  preview.sync(projectOne);
  tree.dispatch("pointerover", { target: row });
  await wait(HOVER_DELAY + 40);
  assert.equal(reads.length, 1);

  // Same object: the cache survives a repaint of the same project.
  preview.sync(projectOne);
  tree.dispatch("pointerout", { target: row, relatedTarget: null });
  tree.dispatch("pointerover", { target: row });
  await wait(HOVER_DELAY + 40);
  assert.equal(reads.length, 1);

  preview.sync(projectTwo);
  tree.dispatch("pointerout", { target: row, relatedTarget: null });
  tree.dispatch("pointerover", { target: row });
  await wait(HOVER_DELAY + 40);
  assert.equal(reads.length, 2);
});

test("a path that is not an image never reaches the backend", async () => {
  const { tree, reads } = harness();
  const row = fakeRow("scripts/main.pe");

  tree.dispatch("pointerover", { target: row });
  await wait(HOVER_DELAY + 40);
  assert.deepEqual(reads, []);
});

test("dragging and scrolling take the preview away", async () => {
  const boxes = stubDocument();
  stubWindow();
  const tree = fakeTree();
  const preview = createResourcePreview({
    dom: { resourceBody: tree },
    getActions: () => ({ readImage: async (path) => `data:,${path}` }),
  });
  preview.wire();

  tree.dispatch("pointerover", { target: fakeRow("assets/a.png") });
  await wait(HOVER_DELAY + 40);
  const box = boxes.find((node) => node.className === "tree-preview");
  assert.ok(box, "the preview box must exist");
  assert.equal(box.removed, undefined);

  tree.dispatch("dragstart", {});
  assert.equal(box.removed, true);
});

test("wiring without a resource panel is a no-op", () => {
  globalThis.window = { addEventListener() {} };
  const preview = createResourcePreview({ dom: {}, getActions: () => null });
  assert.doesNotThrow(() => preview.wire());
});
