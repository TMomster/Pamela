// `stage.pamela()`：开场动画的时间线与逐帧绘制。
// Pamela — the opening animation's timeline and its offline frame drawing.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PAMELA_INTRO_MS,
  PAMELA_INTRO_SUBTEXT,
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

/** 取字号，`600 63.9px "JetBrains Mono"` → 63.9。 */
function fontSizeOf(font) {
  return Number(/([\d.]+)px/.exec(font)?.[1]);
}

test("the opening lasts about three and a half seconds and ends fully faded out", () => {
  assert.equal(PAMELA_INTRO_MS, 3500);
  const end = pamelaIntroState(3500);
  assert.equal(end.done, true);
  assert.equal(end.overall, 0);
  assert.equal(pamelaIntroState(5000).done, true, "超出时长也停在终态");
});

test("black fades in, the icon fades in and stops left of centre, then the text is revealed", () => {
  const start = pamelaIntroState(0);
  assert.equal(start.black, 0);
  assert.equal(start.icon, 0);
  assert.equal(start.overall, 1);

  const blackDone = pamelaIntroState(467);
  assert.equal(blackDone.black, 1);
  assert.equal(blackDone.iconX, 0.5, "图标还没开始左移");

  const iconDone = pamelaIntroState(875);
  assert.equal(iconDone.icon, 1);
  assert.equal(iconDone.iconX, 0.5, "图标刚亮起，还没左移");

  const parked = pamelaIntroState(1400);
  assert.ok(Math.abs(parked.iconX - 0.35) < 1e-9, "图标停在左侧位置");
  assert.equal(pamelaIntroState(2300).iconX, parked.iconX, "停住之后不再移动");

  const revealed = pamelaIntroState(2217);
  assert.equal(revealed.reveal, 1);
  assert.equal(revealed.text, 1);
  assert.ok(revealed.textX > revealed.iconX, "文字从图标右边出现");
});

test("the icon-to-text gap is short, so the two lines have a longer hold", () => {
  const textStart = 1400; // 1200 × 3500/3000
  const before = pamelaIntroState(textStart);
  assert.equal(before.text, 0);
  assert.equal(before.icon, 1, "文字出场时图标已经淡入完毕");
  assert.ok(Math.abs(before.iconX - 0.35) < 1e-9, "图标也已经停住");

  assert.ok(pamelaIntroState(textStart + 1).text > 0, "紧接着文字开始出现");
  const stillOn = pamelaIntroState(2800);
  assert.equal(stillOn.text, 1);
  assert.equal(stillOn.overall, 1, "淡出还没开始，两行文字仍完整可见");
});

test("the line under the title starts fading in with the title and fades in, not out", () => {
  const before = pamelaIntroState(1399);
  assert.equal(before.text, 0);
  assert.equal(before.subtext, 0, "小字不早于标题出现");

  const midway = pamelaIntroState(1600);
  assert.ok(midway.subtext > 0 && midway.subtext < 1, "小字是渐显");
  assert.ok(Math.abs(midway.subtext - midway.text) < 1e-9, "与标题同步出场");

  assert.equal(pamelaIntroState(1750).subtext, 1);
});

test("a shorter total duration scales every phase with it", () => {
  const half = pamelaIntroState(1750, 1750);
  assert.equal(half.done, true);
  assert.equal(half.overall, 0);
  assert.equal(pamelaIntroState(234, 1750).black, 1);
});

test("drawPamelaIntro covers the whole frame and writes both lines in JetBrains Mono", () => {
  const ctx = fakeCtx();
  drawPamelaIntro(ctx, { width: 1920, height: 1080 }, pamelaIntroState(2600));
  assert.equal(ctx.calls.rects.length, 1, "一张铺满画幅的黑幕");
  assert.deepEqual(ctx.calls.rects[0], { x: 0, y: 0, w: 1920, h: 1080, alpha: 1 });
  assert.equal(ctx.calls.texts.length, 2);

  const [title, subtext] = ctx.calls.texts;
  assert.equal(title.text, PAMELA_INTRO_TEXT);
  assert.equal(subtext.text, PAMELA_INTRO_SUBTEXT);
  assert.match(title.font, /JetBrains Mono/, "文字用项目内置字体");
  assert.match(subtext.font, /JetBrains Mono/, "小字用同一套字体");
  assert.ok(title.x > 0 && subtext.x === title.x, "两行左对齐，都在图标右边");
  assert.ok(subtext.y > title.y, "小字排在标题下方");
  assert.ok(fontSizeOf(subtext.font) < fontSizeOf(title.font), "小字比标题小");
});

test("a finished or absent intro paints nothing", () => {
  const ctx = fakeCtx();
  drawPamelaIntro(ctx, { width: 1920, height: 1080 }, pamelaIntroState(3500));
  drawPamelaIntro(ctx, { width: 1920, height: 1080 }, null);
  assert.equal(ctx.calls.rects.length, 0);
  assert.equal(ctx.calls.texts.length, 0);
});
