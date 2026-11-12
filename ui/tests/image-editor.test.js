// `ui/image-editor.js` 纯逻辑测试。
// Tests for the pure logic in ui/image-editor.js. The DOM / canvas half is
// 运行态行为由应用内验证，本文件覆盖图层模型、几何计算与坐标换算。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clamp,
  clampAdjust,
  adjustToFilter,
  uniqueLayerId,
  imageLayer,
  textLayer,
  shapeLayer,
  layerBounds,
  hitLayer,
  documentSize,
  convolve,
  serializeLayers,
  parseLayers,
  cropHandlePositions,
  resizeCrop,
  moveCrop,
  hitCropHandle,
  pointerToDoc,
  CROP_PAD,
  CROP_HANDLES,
} from "../image-editor.js";

test("clamp keeps values inside the range", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test("clampAdjust fills defaults and clamps extremes", () => {
  assert.deepEqual(clampAdjust({}), {
    brightness: 1,
    contrast: 1,
    saturation: 1,
    hue: 0,
  });
  const a = clampAdjust({ brightness: 9, contrast: -3, hue: 400, saturation: 5 });
  assert.equal(a.brightness, 2);
  assert.equal(a.contrast, 0);
  assert.equal(a.hue, 180);
  assert.equal(a.saturation, 2);
});

test("adjustToFilter builds a canvas filter string", () => {
  const f = adjustToFilter({ brightness: 1.2, contrast: 0.8, saturation: 1.5, hue: 30 });
  assert.equal(f, "brightness(1.2) contrast(0.8) saturate(1.5) hue-rotate(30deg)");
});

test("uniqueLayerId never collides with existing ids", () => {
  const taken = [{ id: "l1" }, { id: "l2" }];
  const id = uniqueLayerId(taken);
  assert.ok(!taken.some((l) => l.id === id));
});

test("imageLayer captures geometry and defaults", () => {
  const l = imageLayer("assets/a.png", null, 100, 50);
  assert.equal(l.type, "image");
  assert.equal(l.source, "assets/a.png");
  assert.equal(l.width, 100);
  assert.equal(l.height, 50);
  assert.equal(l.opacity, 1);
  assert.deepEqual(l.adjust, { brightness: 1, contrast: 1, saturation: 1, hue: 0 });
});

test("image colour adjust lives nested under adjust, not on the layer", () => {
  const l = imageLayer("assets/a.png", null, 10, 10);
  assert.equal("brightness" in l, false, "brightness must stay on l.adjust");
  assert.equal("contrast" in l, false);
  assert.equal("saturation" in l, false);
  assert.equal(l.adjust.brightness, 1);
  assert.equal(l.adjust.contrast, 1);
  assert.equal(l.adjust.saturation, 1);
});

test("textLayer and shapeLayer carry their kind", () => {
  const t = textLayer("hi");
  assert.equal(t.type, "text");
  assert.equal(t.text, "hi");
  const s = shapeLayer("ellipse");
  assert.equal(s.type, "shape");
  assert.equal(s.shape, "ellipse");
});

test("layerBounds returns a box for every layer kind", () => {
  assert.deepEqual(layerBounds(imageLayer("a", null, 80, 40)), {
    x: 0,
    y: 0,
    width: 80,
    height: 40,
  });
  const t = textLayer("ab");
  t.x = 5;
  t.y = 6;
  t.fontSize = 10;
  const b = layerBounds(t);
  assert.equal(b.x, 5);
  assert.equal(b.width, Math.max(1, 2 * 10 * 0.6));
});

test("hitLayer respects the bounding box", () => {
  const l = imageLayer("a", null, 100, 100);
  l.x = 0;
  l.y = 0;
  assert.equal(hitLayer(l, 50, 50), true);
  assert.equal(hitLayer(l, 150, 50), false);
});

test("documentSize grows to contain all layers", () => {
  const l = imageLayer("a", null, 100, 50);
  l.x = 20;
  l.y = 10;
  assert.deepEqual(documentSize([l]), { width: 120, height: 60 });
  assert.deepEqual(documentSize([]), { width: 1, height: 1 });
});

test("convolve with identity kernel returns input unchanged", () => {
  const pixels = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
  const out = convolve(pixels, 2, 1, [0, 0, 0, 0, 1, 0, 0, 0, 0], 1, 0);
  assert.deepEqual([...out], [10, 20, 30, 255, 40, 50, 60, 255]);
});

test("convolve sums with a box kernel and divisor 1", () => {
  // A 3x3 field where every pixel is (10,10,10,255). With a uniform kernel
  // summed 9 times and no normalisation, each output channel is 9 * 10.
  const pixels = new Uint8ClampedArray(9 * 4);
  for (let i = 0; i < 9; i += 1) {
    pixels[i * 4] = 10;
    pixels[i * 4 + 1] = 10;
    pixels[i * 4 + 2] = 10;
    pixels[i * 4 + 3] = 255;
  }
  const out = convolve(pixels, 3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 1, 0);
  assert.equal(out[0], 90);
  assert.equal(out[4 * 4], 90);
});

test("serializeLayers drops the bitmap but keeps geometry", () => {
  const l = imageLayer("assets/a.png", null, 100, 50);
  const json = serializeLayers([l]);
  assert.ok(!json.includes("bitmap"));
  const back = parseLayers(json);
  assert.equal(back.length, 1);
  assert.equal(back[0].source, "assets/a.png");
  assert.equal(back[0].width, 100);
});

test("parseLayers tolerates non-array json", () => {
  assert.deepEqual(parseLayers("{}"), []);
});

test("cropHandlePositions maps the eight handles around the box", () => {
  const pos = cropHandlePositions({ x: 10, y: 20, w: 100, h: 60 });
  assert.deepEqual(pos.nw, { x: 10, y: 20 });
  assert.deepEqual(pos.n, { x: 60, y: 20 });
  assert.deepEqual(pos.ne, { x: 110, y: 20 });
  assert.deepEqual(pos.e, { x: 110, y: 50 });
  assert.deepEqual(pos.se, { x: 110, y: 80 });
  assert.deepEqual(pos.s, { x: 60, y: 80 });
  assert.deepEqual(pos.sw, { x: 10, y: 80 });
  assert.deepEqual(pos.w, { x: 10, y: 50 });
  assert.equal(CROP_HANDLES.length, 8);
});

test("resizeCrop drags a corner without flipping the box", () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  const se = resizeCrop(box, "se", 150, 140);
  assert.deepEqual(se, { x: 0, y: 0, w: 150, h: 140 });
  // 往对侧越界时夹到最小尺寸，不翻转。
  const nw = resizeCrop(box, "nw", 200, 200);
  assert.deepEqual(nw, { x: 99, y: 99, w: 1, h: 1 });
});

test("resizeCrop drags an edge handle", () => {
  const box = { x: 10, y: 10, w: 100, h: 100 };
  const e = resizeCrop(box, "e", 80, 50);
  assert.deepEqual(e, { x: 10, y: 10, w: 70, h: 100 });
  const s = resizeCrop(box, "s", 50, 200);
  assert.deepEqual(s, { x: 10, y: 10, w: 100, h: 190 });
});

test("moveCrop shifts the box without resizing", () => {
  const box = { x: 5, y: 5, w: 30, h: 30 };
  assert.deepEqual(moveCrop(box, 10, -5), { x: 15, y: 0, w: 30, h: 30 });
});

test("hitCropHandle finds the nearest handle within radius", () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(hitCropHandle(box, 100, 100, 8), "se");
  assert.equal(hitCropHandle(box, 50, 2, 8), "n");
  assert.equal(hitCropHandle(box, 50, 50, 8), null);
});

test("画布四周的留白足够贴边裁剪手柄完整显示", () => {
  // 手柄画成 16px 见方（半边 8），贴文档边缘的手柄有一半落在文档外。
  // 画布若仅取文档尺寸，留白区域之外的手柄会被裁切，因此留白必须覆盖手柄范围。
  assert.ok(CROP_PAD >= 8, `CROP_PAD(${CROP_PAD}) 不得小于手柄半边 8`);
});

test("pointerToDoc 把指针坐标换算回文档坐标", () => {
  // 未缩放时：画布像素 = 文档 + 四周各 CROP_PAD，画布左上角即文档 (-CROP_PAD,-CROP_PAD)。
  const rect = { left: 0, top: 0, width: 100 + CROP_PAD * 2, height: 50 + CROP_PAD * 2 };
  assert.deepEqual(pointerToDoc(CROP_PAD, CROP_PAD, rect, 100, 50), { x: 0, y: 0 });
  assert.deepEqual(pointerToDoc(rect.width / 2, rect.height / 2, rect, 100, 50), {
    x: 50,
    y: 25,
  });
  // 画布被 CSS 缩放一半、容器又偏移时同样成立——换算按整张画布缩放后扣掉留白。
  // 缩放一半意味着留白在屏幕上只占 CROP_PAD / 2。
  const scaled = { left: 10, top: 5, width: rect.width / 2, height: rect.height / 2 };
  assert.deepEqual(pointerToDoc(10 + CROP_PAD / 2, 5 + CROP_PAD / 2, scaled, 100, 50), {
    x: 0,
    y: 0,
  });
  assert.deepEqual(pointerToDoc(10 + CROP_PAD, 5 + CROP_PAD, scaled, 100, 50), {
    x: CROP_PAD,
    y: CROP_PAD,
  });
});
