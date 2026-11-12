// `stage.pamela()`：开场动画的时间线与逐帧绘制。
// Pamela — the opening animation's timeline and its offline frame drawing.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PAMELA_INTRO_MS,
  PAMELA_INTRO_TEXT,
  drawPamelaIntro,
  pamelaIntroState,
} from "../pamela-intro.js";

/** A canvas context that only records what the animation asked it to draw. */
function fakeCtx() {
  const calls = { rects: [], texts: [], fonts: [], alphas: [] };
  return {
    calls,
    globalAlpha: 1,
    filter: "none",
    fillStyle: "",
    font: "",
    textBaseline: "",
    save() { calls.alphas.push(this.globalAlpha); },
    restore() { this.globalAlpha = 1; },
    translate() {},
    scale() {},
    beginPath() {},
    arc() {},
    rect() {},
    clip() {},
    fill() {},
    fillRect(x, y, w, h) { calls.rects.push({ x, y, w, h, alpha: this.globalAlpha }); },
    measureText(text) { return { width: text.length * 30 }; },
    fillText(text, x, y) { calls.texts.push({ text, x, y, font: this.font, alpha: this.globalAlpha }); },
  };
}

test("the opening lasts about three seconds and ends fully faded out", () => {
  assert.equal(PAMELA_INTRO_MS, 3000);
  const end = pamelaIntroState(3000);
  assert.equal(end.done, true);
  assert.equal(end.overall, 0);
  assert.equal(pamelaIntroState(5000).done, true, "超出时长也停在终态");
});

test("black fades in, the icon fades in and stops left of centre, then the text is revealed", () => {
  const start = pamelaIntroState(0);
  assert.equal(start.black, 0);
  assert.equal(start.icon, 0);
  assert.equal(start.overall, 1);

  const blackDone = pamelaIntroState(400);
  assert.equal(blackDone.black, 1);
  assert.equal(blackDone.iconX, 0.5, "图标还没开始左移");

  const iconDone = pamelaIntroState(850);
  assert.equal(iconDone.icon, 1);
  assert.equal(iconDone.iconX, 0.5);

  const parked = pamelaIntroState(1450);
  assert.ok(Math.abs(parked.iconX - 0.35) < 1e-9, "图标停在左侧位置");
  assert.equal(pamelaIntroState(2000).iconX, parked.iconX, "停住之后不再移动");

  const revealed = pamelaIntroState(2150);
  assert.equal(revealed.reveal, 1);
  assert.equal(revealed.text, 1);
  assert.ok(revealed.textX > revealed.iconX, "文字从图标右边出现");
});

test("a shorter total duration scales every phase with it", () => {
  const half = pamelaIntroState(1500, 1500);
  assert.equal(half.done, true);
  assert.equal(half.overall, 0);
  assert.equal(pamelaIntroState(200, 1500).black, 1);
});

test("drawPamelaIntro covers the whole frame and writes the line in JetBrains Mono", () => {
  const ctx = fakeCtx();
  drawPamelaIntro(ctx, { width: 1920, height: 1080 }, pamelaIntroState(2200));
  assert.equal(ctx.calls.rects.length, 1, "一张铺满画幅的黑幕");
  assert.deepEqual(ctx.calls.rects[0], { x: 0, y: 0, w: 1920, h: 1080, alpha: 1 });
  assert.equal(ctx.calls.texts.length, 1);
  assert.equal(ctx.calls.texts[0].text, PAMELA_INTRO_TEXT);
  assert.match(ctx.calls.texts[0].font, /JetBrains Mono/, "文字用项目内置字体");
  assert.ok(ctx.calls.texts[0].x > 0, "文字画在图标右边");
});

test("a finished or absent intro paints nothing", () => {
  const ctx = fakeCtx();
  drawPamelaIntro(ctx, { width: 1920, height: 1080 }, pamelaIntroState(3000));
  drawPamelaIntro(ctx, { width: 1920, height: 1080 }, null);
  assert.equal(ctx.calls.rects.length, 0);
  assert.equal(ctx.calls.texts.length, 0);
});
