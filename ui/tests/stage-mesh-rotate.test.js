// 自由变形后继续 rotate：网格要真的转动，而不是停在原地。
// After a free transform, a rotate must spin the mesh instead of freezing it.

import assert from "node:assert/strict";
import test from "node:test";

import { createStage } from "../stage.js";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

/** A stand-in element with the bits the stage and the mesh need in node. */
function fakeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    dataset: {},
    style: {},
    childNodes: [],
    parentNode: null,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    replaceChildren(...children) {
      node.childNodes = children;
      for (const child of children) if (child) child.parentNode = node;
    },
    append(child) {
      node.childNodes.push(child);
      if (child) child.parentNode = node;
    },
    replaceChild(fresh, old) {
      const i = node.childNodes.indexOf(old);
      if (i >= 0) node.childNodes[i] = fresh;
      if (fresh) fresh.parentNode = node;
      if (old) old.parentNode = null;
      return old;
    },
    decode: () => Promise.resolve(),
    naturalWidth: 200,
    naturalHeight: 200,
    width: 0,
    height: 0,
    src: "",
    alt: "",
    draggable: false,
    hidden: false,
    textContent: "",
    setAttribute(name, value) { node[name] = value; },
    removeAttribute(name) { delete node[name]; },
    addEventListener() {},
    get offsetWidth() { return 0; },
    get offsetHeight() { return 0; },
    clientWidth: 0,
    clientHeight: 0,
    scrollWidth: 0,
    scrollHeight: 0,
  };
  if (node.tagName === "CANVAS") {
    node.ctx = {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData() {},
    };
    node.getContext = () => node.ctx;
  }
  return node;
}

/** Runs a body with a minimal DOM, held until the loads have settled. */
async function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    createElementNS: (_namespace, tag) => fakeNode(tag),
    createTextNode: (text) => ({ textContent: text }),
  };
  try {
    return await body();
  } finally {
    globalThis.document = previous;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function build() {
  const surface = fakeNode("div");
  const stage = createStage({
    element: fakeNode("div"),
    surface,
    resolveAsset: () => Promise.resolve(PNG_URL),
  });
  return { stage, surface };
}

/** The mesh node the character in `surface` draws through. */
function meshOf(surface) {
  const layer = surface.childNodes[1];
  return layer.childNodes.find((child) => child.className === "stage__mesh");
}

test("a rotate after a free transform actually turns the mesh points", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build();
    stage.setCharacter("ch", "hero.png");
    await settle();

    // Deform: pull the top-right point somewhere off its original corner.
    stage.transformCharacterPoint("ch", "upright", 400, 400, 0);

    const mesh = meshOf(surface);
    assert.ok(mesh, "deforming should have switched the picture to a mesh");
    const before = mesh.childNodes[0].style.clipPath;
    assert.ok(before, "a deformed piece carries a clip-path");

    // A 180° turn is not a whole spin of 360°, so the points must move.
    stage.transformCharacter("ch", 180, 1, 0);
    const after = mesh.childNodes[0].style.clipPath;
    assert.notEqual(after, before, "the mesh should rotate instead of freezing");
  });
});

test("a whole turn still animates the mesh rather than sitting still", async () => {
  await inFakeDom(async () => {
    const { stage, surface } = build();
    stage.setCharacter("ch", "hero.png");
    await settle();
    stage.transformCharacterPoint("ch", "upright", 400, 400, 0);

    const mesh = meshOf(surface);
    const piece = mesh.childNodes[0];
    const start = piece.style.clipPath;

    // Start a 360° spin; half a turn in the points must be upside down.
    const running = stage.transformCharacter("ch", 360, 1, 60);
    assert.ok(running, "a timed turn answers a promise to wait for");

    await new Promise((resolve) => setTimeout(resolve, 30));
    const midway = piece.style.clipPath;
    assert.notEqual(midway, start, "halfway through a spin the mesh has moved");

    await running;
    const end = piece.style.clipPath;
    assert.notEqual(end, start, "the mesh lands having travelled the turn");
  });
});
