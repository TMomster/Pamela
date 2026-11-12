// `ui/antialias.js`：两档强度的读法，以及整图 / 只边缘两种画法。
// Tests for the bitmap anti-aliasing: how a strength is read, and what each mode paints.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIALIAS_MAX,
  antialiasAmount,
  antialiasBitmap,
  antialiasIsOn,
  antialiasRadius,
} from "../antialias.js";

/** A canvas stand-in that records what was drawn on it, and with which filter. */
function fakeCanvas(width = 0, height = 0) {
  const calls = [];
  const context = {
    filter: "none",
    imageSmoothingEnabled: true,
    drawImage(...args) {
      calls.push({ what: "drawImage", args, filter: context.filter });
    },
    clearRect() {},
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(Math.max(1, w * h * 4));
      // 一张「里实外虚」的 alpha：只为了看它有没有被换成模糊过的那一份。
      for (let index = 3; index < data.length; index += 4) {
        data[index] = 200;
      }
      return { data };
    },
    putImageData() {
      calls.push({ what: "putImageData", filter: context.filter });
    },
  };
  return { width, height, calls, context, getContext: () => context };
}

/** A factory that hands out fake canvases and keeps them, newest last. */
function factory() {
  const made = [];
  const create = (width, height) => {
    const canvas = fakeCanvas(width, height);
    made.push(canvas);
    return canvas;
  };
  return { made, create };
}

const source = { width: 100, height: 50 };

test("强度读成 0–2 的数：超界夹取，非数字报错", () => {
  assert.equal(antialiasAmount("抗锯齿", 0), 0);
  assert.equal(antialiasAmount("抗锯齿", 1.5), 1.5);
  assert.equal(antialiasAmount("抗锯齿", 9), ANTIALIAS_MAX, "超界夹到 2");
  assert.equal(antialiasAmount("抗锯齿", -3), 0, "负数就是关");
  assert.equal(antialiasAmount("抗锯齿", "0.5"), 0.5, "文本形状的数字照收");
  assert.throws(() => antialiasAmount("抗锯齿", "软一点"), /抗锯齿强度需要 0–2 的数字/);
  assert.throws(() => antialiasAmount("边缘抗锯齿", undefined), /边缘抗锯齿强度需要 0–2 的数字/);
});

test("半径按源位图的像素算，0 就是 0", () => {
  assert.equal(antialiasRadius(0), 0);
  assert.equal(antialiasRadius(1), 3, "1 档 3 个像素");
  assert.equal(antialiasRadius(2), 6, "2 档 6 个像素");
  assert.equal(antialiasRadius(9), 6, "超界按 2 档算");
  assert.equal(antialiasRadius(-1), 0);
  assert.equal(antialiasRadius("nope"), 0);
});

test("两档都关时这一步整个跳过", () => {
  assert.equal(antialiasIsOn({ smooth: 0, edges: 0 }), false);
  assert.equal(antialiasIsOn({}), false);
  assert.equal(antialiasIsOn(null), false);
  assert.equal(antialiasIsOn({ smooth: 0.2 }), true);
  assert.equal(antialiasIsOn({ edges: 0.2 }), true);
});

test("整图那一档：留边画一遍模糊，再裁回原尺寸", () => {
  const { made, create } = factory();
  const result = antialiasBitmap(source, 100, 50, { smooth: 1 }, create);

  assert.equal(result.width, 100);
  assert.equal(result.height, 50);
  assert.equal(result.canvas.width, 100, "交出去的是原尺寸的画布");

  // 留边 3 + 2 = 5，所以处理用的画布是 110×60，裁回来的那张是 100×50。
  assert.equal(made.length, 2);
  assert.equal(made[0].width, 110);
  assert.equal(made[0].height, 60);
  const draw = made[0].calls.find((call) => call.what === "drawImage");
  assert.match(draw.filter, /^blur\(3\.00px\)$/, "画的时候带着 3px 的模糊");
  assert.deepEqual(draw.args, [source, 5, 5, 100, 50], "位图画在留出来的中间");
  assert.equal(made[0].context.filter, "none", "画完把滤镜摘掉");
});

test("边缘那一档：颜色留在原处，只把 alpha 换成模糊过的那一份", () => {
  const { made, create } = factory();
  const result = antialiasBitmap(source, 100, 50, { edges: 1 }, create);

  assert.equal(result.canvas.width, 100);
  assert.equal(made.length, 3, "留边、遮罩、裁回，三张");

  const [padded, mask] = made;
  // 遮罩那张也带模糊：它的 alpha 就是摊平后的过渡带。
  const maskDraw = mask.calls.find((call) => call.what === "drawImage");
  assert.match(maskDraw.filter, /^blur\(3\.00px\)$/);
  assert.ok(
    padded.calls.some((call) => call.what === "putImageData"),
    "原图那张被写回过：说明 alpha 换过了",
  );
  assert.equal(padded.context.filter, "none");
});

test("两档一起写：按整图那一档画，半径取大的那个", () => {
  const { made, create } = factory();
  const result = antialiasBitmap(source, 100, 50, { smooth: 1, edges: 2 }, create);

  assert.equal(result.canvas.width, 100);
  assert.equal(made.length, 2, "只有整图那一遍，没有遮罩");
  const draw = made[0].calls.find((call) => call.what === "drawImage");
  assert.match(draw.filter, /^blur\(6\.00px\)$/, "取边缘那一档更大的半径");
});

test("拿不到画布就不处理：调用方按原图继续画", () => {
  assert.equal(antialiasBitmap(source, 100, 50, { smooth: 1 }, null), null);
  assert.equal(antialiasBitmap(source, 100, 50, { smooth: 1 }, () => null), null);
  assert.equal(
    antialiasBitmap(source, 100, 50, { smooth: 1 }, () => ({ getContext: () => null })),
    null,
  );
});

test("强度是 0 时不建画布，也不碰位图", () => {
  const { made, create } = factory();
  assert.equal(antialiasBitmap(source, 100, 50, { smooth: 0, edges: 0 }, create), null);
  assert.equal(antialiasBitmap(source, 0, 0, { smooth: 1 }, create), null, "没有尺寸就不画");
  assert.equal(made.length, 0);
});
