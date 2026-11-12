// 对话框底板共享绘制测试。
// Tests for the plate painter shared by the stage and the designer.

import assert from "node:assert/strict";
import test from "node:test";

import { draw, hasPlate, plateLayers, styleFor } from "../dialog-plate.js";

/** A 2d context stand-in that records every call, so drawing can be asserted. */
function fakeContext() {
  const calls = [];
  const state = { canvas: { width: 1920, height: 1080 } };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) {
        return target[key];
      }
      return (...args) => {
        calls.push([String(key), ...args]);
        return undefined;
      };
    },
    set(target, key, value) {
      calls.push([`set:${String(key)}`, value]);
      target[key] = value;
      return true;
    },
  });
  return { ctx, calls };
}

function document() {
  const rect = (id, visible = true) => ({
    id,
    type: "rect",
    visible,
    opacity: 1,
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    radius: 0,
    fill: "#101018",
  });
  return {
    version: 2,
    canvas: { width: 1920, height: 1080 },
    active: "dialog",
    styles: {
      dialog: { layers: [rect("a"), rect("b", false)] },
      narration: { layers: [rect("c")] },
    },
  };
}

test("styleFor reads a named slot, and a bare style set as itself", () => {
  const doc = document();
  assert.equal(styleFor(doc, "dialog"), doc.styles.dialog);
  assert.equal(styleFor(doc, "narration"), doc.styles.narration);
  assert.equal(styleFor(doc.styles.dialog, "dialog"), doc.styles.dialog);
  assert.deepEqual(styleFor(null), {});
});

test("plateLayers skips hidden layers, so a plate with none is empty", () => {
  const doc = document();
  assert.deepEqual(plateLayers(doc, "dialog").map((layer) => layer.id), ["a"]);
  assert.equal(hasPlate(doc, "dialog"), true);
  assert.equal(hasPlate(doc, "narration"), true);

  doc.styles.dialog.layers[0].visible = false;
  assert.equal(hasPlate(doc, "dialog"), false);
});

test("draw clears the canvas at the document's size and paints one slot", () => {
  const { ctx, calls } = fakeContext();
  draw(ctx, document(), new Map(), "dialog");

  assert.ok(calls.some(([name, , , w, h]) => name === "clearRect" && w === 1920 && h === 1080));
  // One visible rect: one path and one fill. The hidden layer is never drawn.
  assert.equal(calls.filter(([name]) => name === "fill").length, 1);
  assert.equal(calls.filter(([name]) => name === "set:fillStyle").length, 1);
});

test("draw uses the slot it is given, not the document's active one", () => {
  const { ctx, calls } = fakeContext();
  const doc = document();
  doc.styles.dialog.layers[0].fill = "#111111";
  doc.styles.narration.layers[0].fill = "#222222";

  draw(ctx, doc, new Map(), "narration");
  assert.ok(calls.some(([name, value]) => name === "set:fillStyle" && value === "#222222"));
  assert.ok(!calls.some(([name, value]) => name === "set:fillStyle" && value === "#111111"));
});

test("draw takes an image layer's bitmap from the map by its source", () => {
  const { ctx, calls } = fakeContext();
  const doc = document();
  const bitmap = { tag: "bitmap" };
  doc.styles.dialog.layers = [
    {
      id: "i",
      type: "image",
      visible: true,
      opacity: 1,
      source: "assets/ui/frame.png",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    },
  ];

  draw(ctx, doc, new Map([["assets/ui/frame.png", bitmap]]), "dialog");
  assert.ok(calls.some(([name, image]) => name === "drawImage" && image === bitmap));

  calls.length = 0;
  draw(ctx, doc, new Map(), "dialog");
  assert.ok(!calls.some(([name]) => name === "drawImage"), "a missing bitmap is skipped, not thrown");
});

test("a bare style set is drawn too, using the context's own size", () => {
  const { ctx, calls } = fakeContext();
  draw(ctx, { layers: [{ id: "a", type: "rect", visible: true, x: 0, y: 0, width: 10, height: 10 }] });
  assert.ok(calls.some(([name, , , w, h]) => name === "clearRect" && w === 1920 && h === 1080));
  assert.equal(calls.filter(([name]) => name === "rect").length, 1);
});

test("draw can lay a plate over a frame it did not clear", () => {
  const { ctx, calls } = fakeContext();
  const doc = document();
  draw(ctx, doc, new Map(), "dialog", false);
  assert.ok(!calls.some(([name]) => name === "clearRect"), "the frame underneath survives");
  assert.equal(calls.filter(([name]) => name === "fill").length, 1, "the visible layer still draws");

  calls.length = 0;
  draw(ctx, doc, new Map(), "dialog");
  assert.ok(calls.some(([name]) => name === "clearRect"), "the default still owns a clean plate canvas");
});
