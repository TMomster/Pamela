// Pamela 工作区布局算术测试。
// Tests for the Pamela workspace layout arithmetic.

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampResourceWidth,
  DEFAULT_RESOURCE_WIDTH,
  MIN_RESOURCE_WIDTH,
  widthFromDrag,
} from "../layout.js";

test("the default width survives clamping on a normal window", () => {
  assert.equal(clampResourceWidth(DEFAULT_RESOURCE_WIDTH, 1280), DEFAULT_RESOURCE_WIDTH);
});

test("widths below the minimum are raised to it", () => {
  assert.equal(clampResourceWidth(40, 1280), MIN_RESOURCE_WIDTH);
  assert.equal(clampResourceWidth(-500, 1280), MIN_RESOURCE_WIDTH);
});

test("widths that would squeeze the editor are capped", () => {
  assert.equal(clampResourceWidth(5000, 1280), 1280 - 360);
});

test("a narrow window never inverts the minimum and maximum", () => {
  // viewport 400 - 360 reserve = 40, below the 160 minimum: the minimum wins
  // rather than producing a negative or inverted range.
  assert.equal(clampResourceWidth(300, 400), MIN_RESOURCE_WIDTH);
});

test("non-finite input falls back to the default", () => {
  assert.equal(clampResourceWidth(Number.NaN, 1280), DEFAULT_RESOURCE_WIDTH);
  assert.equal(clampResourceWidth(undefined, 1280), DEFAULT_RESOURCE_WIDTH);
});

test("dragging right widens the panel by the pointer delta", () => {
  assert.equal(widthFromDrag(240, 100, 160, 1280), 300);
});

test("dragging left narrows the panel by the pointer delta", () => {
  assert.equal(widthFromDrag(240, 100, 40, 1280), 180);
});

test("a drag stays within the limits", () => {
  assert.equal(widthFromDrag(240, 100, -500, 1280), MIN_RESOURCE_WIDTH);
  assert.equal(widthFromDrag(240, 100, 5000, 1280), 1280 - 360);
});

test("a drag with a non-finite pointer position changes nothing", () => {
  assert.equal(widthFromDrag(240, 100, Number.NaN, 1280), 240);
});
