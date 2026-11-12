// 帮助示意图的内联测试。
// Tests for the diagrams compiled into the reader.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { figureMarkup, figureSource } from "../help-figures.js";

const PREFIX = "data:image/svg+xml;charset=utf-8,";
const SVG_FILE = new URL("../coordinate-system.svg", import.meta.url);

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
