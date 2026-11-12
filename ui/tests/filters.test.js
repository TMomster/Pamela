// `ui/filters.js` 颜色滤镜原语测试。
// Tests for the colour filter primitives in `ui/filters.js`.

import assert from "node:assert/strict";
import test from "node:test";

import {
  LOOK_NEUTRAL,
  LOOK_PROPERTIES,
  addTint,
  clampChannel,
  lookFilter,
  lookIsNeutral,
  lookValue,
  neutralLook,
  parseHex,
  tintMatrix,
  toHex,
  withLook,
} from "../filters.js";

test("clampChannel keeps values inside 0–255 and rounds them", () => {
  assert.equal(clampChannel(0), 0);
  assert.equal(clampChannel(255), 255);
  assert.equal(clampChannel(254.6), 255);
  assert.equal(clampChannel(-3), 0);
  assert.equal(clampChannel(300), 255);
  assert.equal(clampChannel("128"), 128);
});

test("clampChannel rejects a value that is not a finite number", () => {
  assert.throws(() => clampChannel("red"));
  assert.throws(() => clampChannel(undefined));
  assert.throws(() => clampChannel(NaN));
});

test("parseHex reads three- and six-digit colours, with or without a hash", () => {
  assert.deepEqual(parseHex("FF0000"), { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseHex("#ff0000"), { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseHex("fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHex("#AbC"), { r: 170, g: 187, b: 204 });
});

test("parseHex is case-insensitive", () => {
  assert.deepEqual(parseHex("abcdef"), parseHex("ABCDEF"));
  assert.deepEqual(parseHex("Ff0000"), parseHex("ff0000"));
});

test("parseHex rejects a colour that is not three or six hex digits", () => {
  assert.throws(() => parseHex("ff"));
  assert.throws(() => parseHex("fffffff"));
  assert.throws(() => parseHex("xyz"));
  assert.throws(() => parseHex(123));
});

test("toHex formats channels as an upper-case six-digit string", () => {
  assert.equal(toHex(255, 0, 0), "FF0000");
  assert.equal(toHex(0, 0, 0), "000000");
  assert.equal(toHex(1, 2, 3), "010203");
  assert.equal(toHex(255, 255, 255), "FFFFFF");
  // Channels are clamped, so an over-range value cannot leak out.
  assert.equal(toHex(300, -5, 128), "FF0080");
});

test("addTint adds a relative offset and clamps each channel at 255", () => {
  assert.deepEqual(addTint({ r: 10, g: 20, b: 30 }, 5, 5, 5), { r: 15, g: 25, b: 35 });
});

test("addTint drops the part of an offset that would spill past 255", () => {
  // Red already at 254 plus 10 can only reach 255, never 264.
  assert.deepEqual(addTint({ r: 254, g: 0, b: 0 }, 10, 0, 0), { r: 255, g: 0, b: 0 });
  assert.deepEqual(addTint({ r: 250, g: 250, b: 250 }, 10, 10, 10), { r: 255, g: 255, b: 255 });
});

test("addTint starts from nothing when no base is given", () => {
  assert.deepEqual(addTint(null, 40, 50, 60), { r: 40, g: 50, b: 60 });
});

test("tintMatrix is the identity for a zero offset", () => {
  const values = tintMatrix(0, 0, 0);
  assert.equal(values, "1 0 0 0 0.0000 0 1 0 0 0.0000 0 0 1 0 0.0000 0 0 0 1 0");
  // Twenty numbers, the five rows of the matrix.
  assert.equal(values.split(/\s+/).filter(Boolean).length, 20);
});

test("tintMatrix writes the channel offset in the 0–1 range SVG expects", () => {
  const values = tintMatrix(255, 0, 0).split(/\s+/).filter(Boolean);
  // The last column of the first row is the red offset, divided by 255.
  assert.equal(values[4], "1.0000");
  assert.equal(values[9], "0.0000");
  assert.equal(values[14], "0.0000");
});

// --- the look ---

test("a fresh look is neutral and asks for no filter at all", () => {
  const look = neutralLook();
  assert.deepEqual(look, { ...LOOK_NEUTRAL });
  // A picture a script never filtered must carry no `filter` declaration.
  assert.equal(lookFilter(look), "");
  assert.equal(lookIsNeutral(look), true);
});

test("lookFilter writes the CSS functions the look asks for", () => {
  let look = neutralLook();
  look = withLook(look, "blur", 4);
  assert.equal(lookFilter(look), "blur(4px)");

  look = withLook(look, "saturate", 0.3);
  // The order is fixed by the module, not by the order the script set them:
  // the same look always produces the same string.
  assert.equal(lookFilter(look), "blur(4px) saturate(0.3)");

  look = withLook(look, "contrast", 1.2);
  look = withLook(look, "brightness", 0.8);
  assert.equal(lookFilter(look), "blur(4px) brightness(0.8) contrast(1.2) saturate(0.3)");
});

test("a neutral entry is dropped, so one filter does not switch off another", () => {
  let look = neutralLook();
  look = withLook(look, "blur", 6);
  // Back to sharp: the blur goes, the look is neutral again.
  look = withLook(look, "blur", 0);
  assert.equal(lookFilter(look), "");
  assert.equal(lookIsNeutral(look), true);
});

test("lookValue clamps rather than refusing, like opacity", () => {
  assert.equal(lookValue("blur", -3), 0);
  assert.equal(lookValue("blur", 500), 100);
  assert.equal(lookValue("saturate", -1), 0);
  assert.equal(lookValue("saturate", 9), 4);
  assert.throws(() => lookValue("blur", "sharp"));
  assert.throws(() => lookValue("blur", undefined));
});

test("withLook answers a new look and leaves the old one alone", () => {
  const before = neutralLook();
  const after = withLook(before, "saturate", 0);
  assert.equal(before.saturate, 1, "the original is untouched");
  assert.equal(after.saturate, 0);
  // Every other property is carried over.
  assert.equal(after.blur, 0);
  assert.equal(after.contrast, 1);
});

test("the look properties are the four a visual novel reaches for", () => {
  assert.deepEqual(LOOK_PROPERTIES, ["blur", "brightness", "contrast", "saturate"]);
});
