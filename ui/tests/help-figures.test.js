// 帮助示意图的内联测试。
// Tests for the diagrams compiled into the reader.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { figureMarkup, figureSource } from "../help-figures.js";

const PREFIX = "data:image/svg+xml;charset=utf-8,";
const PNG_PREFIX = "data:image/png;base64,";
const SVG_FILE = new URL("../coordinate-system.svg", import.meta.url);
const PNG_FILE = new URL("../stage-vertices.png", import.meta.url);

test("示意图给的是 data: URI，不指向任何文件路径", () => {
  const src = figureSource("coordinate-system.svg");
  assert.ok(src.startsWith(PREFIX), "以 data: URI 开头");
  const markup = decodeURIComponent(src.slice(PREFIX.length));
  assert.ok(markup.startsWith("<svg"), "解码后是完整的 SVG");
  assert.ok(markup.endsWith("</svg>"), "SVG 没有被截断");
  assert.ok(markup.includes("（平轴）"), "中文标注仍在");
});

test("带不带路径都认，只按文件名找图", () => {
  const bare = figureSource("coordinate-system.svg");
  assert.equal(figureSource("../help/coordinate-system.svg"), bare);
  assert.equal(figureSource("./coordinate-system.svg"), bare);
});

test("舞台坐标图是编进软件的 PNG，不按路径寻址", () => {
  const src = figureSource("stage-vertices.png");
  assert.ok(src.startsWith(PNG_PREFIX), "位图用 base64 的 data URI");
  assert.ok(!src.includes("help/"), "img 不指向任何文件夹");
  const bytes = Buffer.from(src.slice(PNG_PREFIX.length), "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "是完整的 PNG");
  assert.deepEqual(bytes, readFileSync(PNG_FILE), "内联的字节与 ui/stage-vertices.png 一致");

  assert.equal(figureSource("../help/stage-vertices.png"), src, "带路径也认同一张位图");
});

test("没有的图交回空串，由调用方保留原地址", () => {
  assert.equal(figureSource("missing.svg"), "");
  assert.equal(figureSource(""), "");
  assert.equal(figureSource(undefined), "");
});

test("内联的源码与 ui/coordinate-system.svg 完全一致", () => {
  const file = readFileSync(SVG_FILE, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
  assert.equal(
    figureMarkup("coordinate-system.svg"),
    file,
    "改了 SVG 源文件就要同步 help-figures.js",
  );
});
