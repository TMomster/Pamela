// 样式表守卫测试：装饰元素不得进入点击路径。
// Guards for the stylesheet rules that keep decoration out of the click path.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PANELS = readFileSync(new URL("../styles/panels.css", import.meta.url), "utf8");

/** The body of one rule, found by its selector at the start of a line. */
function rule(selector) {
  const start = PANELS.indexOf(selector + " {");
  assert.notEqual(start, -1, "expected a rule for " + selector);
  const end = PANELS.indexOf("}", start);
  return PANELS.slice(start, end);
}

/**
 * The body of the first rule whose selector list *contains* `selector`.
 *
 * `.rule()` above matches the selector exactly, which is what a single-class
 * rule needs; a state that shares its block with a hover (`.x.is-active,
 * .x.is-active:hover { … }`) is found by this one instead.
 */
function ruleContaining(selector) {
  const start = PANELS.indexOf(selector);
  assert.notEqual(start, -1, "expected a rule mentioning " + selector);
  const open = PANELS.indexOf("{", start);
  const end = PANELS.indexOf("}", open);
  return PANELS.slice(open, end);
}

test("the empty-stage hint is painted under the layers and takes no clicks", () => {
  const hint = rule(".stage.is-empty .stage__frame::before");
  assert.match(hint, /pointer-events:\s*none/);
  // A `::after` would be generated above the layer stack.
  assert.equal(PANELS.includes(".stage.is-empty .stage__frame::after"), false);
});

test("the choice layer is inert until it has a question, and the buttons are not", () => {
  assert.match(rule(".stage__layer--choice"), /pointer-events:\s*none/);
  assert.match(rule(".stage__choice"), /pointer-events:\s*auto/);
});

test("the stage menu draws no button chrome, only words on the picture", () => {
  // The two rules that make it a text menu rather than a control bar: no plate
  // behind a word, and no outline or box when it is selected. Both were the
  // point of the redesign, and both are one careless rule away from coming back.
  const menu = rule(".stage__menu");
  assert.match(menu, /background:\s*none/);
  assert.match(menu, /border:\s*0/);

  const item = rule(".stage__menu-item");
  assert.match(item, /background:\s*none/);
  assert.match(item, /border:\s*0/);
  // Readability over a bright backdrop comes from a shadow, not a plate.
  assert.match(item, /text-shadow:/);

  // The selected word is stroked, not boxed: its state lives in `text-shadow`
  // offsets in the accent colour. The rule shares its block with the hover and
  // focus states, so it is found by the selector it contains.
  const active = ruleContaining(".stage__menu-item.is-active");
  assert.match(active, /text-shadow:/);
  assert.match(active, /var\(--pamela-accent\)/);
  assert.equal(
    /background:\s*(?!none)/.test(active),
    false,
    "the selected word must stay transparent",
  );
});

test("stage fullscreen hides the shell, not just the title bar", () => {
  // The window goes fullscreen to cover the taskbar, but what the player is
  // meant to see is the *stage*. So every piece of editor chrome around it has
  // to go — and each one is easy to forget on its own.
  const APP = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const start = APP.indexOf(".app.is-stage-fullscreen .titlebar");
  assert.notEqual(start, -1, "expected the stage-fullscreen shell rules");
  const end = APP.indexOf("}", start);
  const hidden = APP.slice(start, end);

  for (const selector of [
    ".titlebar",
    "#menubar",
    ".statusbar",
    ".panel--resources",
    ".splitter",
    ".tabs",
  ]) {
    assert.ok(hidden.includes(selector), `stage fullscreen must hide ${selector}`);
  }
  assert.match(hidden, /display:\s*none/);

  // And the scene takes the whole screen: no padding left over from the window
  // frame that is no longer there.
  const stage = APP.indexOf(".app.is-stage-fullscreen .stage {");
  assert.notEqual(stage, -1);
  assert.match(APP.slice(stage, APP.indexOf("}", stage)), /padding:\s*0/);
});

test("the stage menu rides in the picture's corner and waits for the pointer", () => {
  // The words sit in the picture's own bottom-right corner — inside the frame,
  // not under it — so the editor and the fullscreen show the same menu.
  const menu = rule(".stage__menu");
  assert.match(menu, /position:\s*absolute/);
  assert.match(menu, /right:\s*12px/);
  assert.match(menu, /bottom:\s*5px/);

  // Hidden until the pointer goes to that corner, and then it slides up out of
  // the picture's bottom edge (`ui/stage-menu.js` owns the open/close).
  assert.match(menu, /opacity:\s*0/);
  assert.match(menu, /transform:\s*translateY\(100%\)/);
  assert.match(menu, /pointer-events:\s*none/);
  // Hidden outright as well, so the words are not a tab stop and not in the
  // accessibility tree while they cannot be seen.
  assert.match(menu, /visibility:\s*hidden/);

  const open = ruleContaining(".stage.is-menu-open .stage__menu");
  assert.match(open, /opacity:\s*1/);
  assert.match(open, /transform:\s*none/);
  assert.match(open, /pointer-events:\s*auto/);
  assert.match(open, /visibility:\s*visible/);

  // The pointer is the only thing that opens the menu. A `:focus-within` branch
  // would keep it out after a click — the focus stays on the word that was
  // pressed — and the menu would never collapse again.
  assert.equal(PANELS.includes(".stage__menu:focus-within"), false);
  assert.equal(open.includes("focus-within"), false);

  // The size is the picture's own, not the window's: `ui/stage-menu.js` measures
  // the picture and sets the variable, so the words keep the same share of it
  // in the editor and in the fullscreen. The declaration in the stylesheet is
  // only the fallback for the moment before the first measurement.
  assert.match(menu, /font-size:\s*var\(--stage-menu-size\)/);
  assert.match(rule(".stage"), /--stage-menu-size:/);

  // The row's bottom edge is what the 5px is measured to, so the items may not
  // add leading below their glyphs — that would silently push the visible text
  // off the offset the layout asked for.
  const item = rule(".stage__menu-item");
  assert.match(item, /line-height:\s*1;/);
  assert.match(item, /padding:\s*0;/);
});

test("fullscreen does not get a second set of rules for the stage menu", () => {
  // The menu lives in the picture and sizes itself from the picture, so a
  // fullscreen-only override would be the one place left where the editor and
  // the fullscreen could drift apart again.
  const APP = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  assert.equal(APP.includes(".app.is-stage-fullscreen .stage__menu"), false);
});

test("the resource panel folds with an animation, and the tree fades out", () => {
  // 收起与展开是一段动画：宽度有过渡。
  const panel = rule(".panel--resources");
  assert.match(panel, /transition:\s*width/);

  // 拖分隔条时宽度直接跟着指针走，不能慢半拍地跟。
  const dragging = ruleContaining("body.is-resizing .panel--resources");
  assert.match(dragging, /transition:\s*none/);

  // 树在收起时淡出，而不是啪地不见；`visibility` 等淡完才真的藏起来。
  const tree = rule(".panel--resources .panel__body");
  assert.match(tree, /opacity:\s*1/);
  const collapsed = ruleContaining(".panel--resources.is-collapsed .panel__body");
  assert.match(collapsed, /opacity:\s*0/);
  assert.match(collapsed, /visibility:\s*hidden/);
});

test("a notice slides in from the right and slides away to the right", () => {
  const APP = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

  // 展示时从屏幕右缘之外划进来。
  assert.match(APP, /animation:\s*pamela-bubble-in/);
  // 关闭时向右划走，划完留在画外（`forwards`）。
  assert.match(
    APP,
    /\.error-bubble\.is-closing \{[^}]*animation:\s*pamela-bubble-out[^}]*forwards/,
  );

  const start = APP.indexOf("@keyframes pamela-bubble-in");
  const end = APP.indexOf("@keyframes pamela-bubble-out");
  assert.ok(start !== -1 && end > start, "两个方向的关键帧都在");
  const inAnimation = APP.slice(start, end);
  assert.match(inAnimation, /translateX\(calc\(100% \+ 16px\)\)/, "起点在屏幕右缘之外");
  assert.match(inAnimation, /translateX\(0\)/, "终点是原位");

  const outAnimation = APP.slice(end);
  assert.match(outAnimation, /translateX\(calc\(100% \+ 16px\)\)/, "走的时候向右");
});

test("the slot panel is one layer over the scene, above the dialogue box", () => {
  // The save/load grid covers the frame and takes clicks, so it has to sit
  // above the choice layer and the dialogue box or a question would show
  // through it.
  const slots = rule(".slots");
  assert.match(slots, /position:\s*absolute/);
  assert.match(slots, /inset:\s*0/);
  // `hidden` has to win over the `display` the layer sets, or the closed panel
  // would cover the scene for the rest of the session.
  assert.match(rule(".slots[hidden]"), /display:\s*none/);

  // Three columns is the page shape; the slot is a framed picture, and an empty
  // one keeps the same frame so the grid does not collapse into text rows.
  assert.match(rule(".slots__grid"), /grid-template-columns:\s*repeat\(3/);
  assert.match(rule(".slots__shot"), /aspect-ratio:\s*16\s*\/\s*9/);
});

test("the backlog is a scrim over the scene, not a card in it", () => {
  // The redesign's whole point: the lines are read *on the picture*, so the
  // layer covers the frame with a translucent veil rather than floating a
  // bordered panel on top of it. A card would put a second frame inside the
  // frame and hide the scene the player is scrolling back through.
  const backlog = rule(".backlog");
  assert.match(backlog, /position:\s*absolute/);
  assert.match(backlog, /inset:\s*0/);
  // Translucent, not solid — the scene has to stay visible behind the text.
  assert.match(backlog, /background:\s*rgba\([^)]*0\.\d+\)/);
  assert.equal(/border:\s*1px/.test(backlog), false, "the scrim must not be a bordered card");
  assert.equal(/border-radius/.test(backlog), false, "the scrim must not be a rounded card");

  // The lines themselves are bare white text with a shadow ring, the same way
  // the dialogue box and the stage menu keep their glyphs readable — never on a
  // plate of their own.
  const row = rule(".backlog__row");
  assert.match(row, /color:\s*#fff/);
  assert.match(row, /text-shadow:/);
  assert.equal(/background:\s*(?!none)/.test(row), false, "a line must not draw a plate");

  // The body is the scroller the wheel gesture is read from.
  assert.match(rule(".backlog__body"), /overflow-y:\s*auto/);
});

// --- key frame editor drawing area ---

test("绘制区铺满它所在的层，而不是靠 flex 撑高", () => {
  // Regression case: the canvas used to be a flex child (`flex: 1`). When the
  // bars moved out of the layer, the layer stopped being a flex container, so
  // `flex: 1` did nothing and the canvas collapsed to zero height — taking the
  // object outline, the points and the path with it. Everything stayed in the
  // DOM; nothing was visible or clickable. No other test could see it.
  const canvas = rule(".path-editor__canvas");
  assert.match(canvas, /position:\s*absolute/);
  assert.match(canvas, /inset:\s*0/);
  assert.doesNotMatch(canvas, /flex:\s*1/, "靠 flex 撑高会在父级不再是 flex 时塌掉");
});

test("绘制层铺满取景框，且不遮住舞台画面", () => {
  const layer = rule(".path-editor");
  assert.match(layer, /position:\s*absolute/);
  assert.match(layer, /inset:\s*0/);
  // The scene being animated is the real stage underneath: blurring or covering
  // it hides the very picture the author places points against.
  assert.doesNotMatch(layer, /backdrop-filter/, "不要再给舞台加模糊");
  assert.doesNotMatch(layer, /background:\s*rgba\(6, 8, 12/, "不要再给舞台加暗底");
});

test("编辑时的控制条在取景框之外，取景框自己让出空间", () => {
  // The bars are the stage's own children while editing, and the frame yields
  // the room for them by flexing rather than by a fixed height that would have
  // to be kept in step with their contents.
  const stage = rule(".stage.is-path-editing");
  assert.match(stage, /flex-direction:\s*column/);
  const frame = ruleContaining(".stage.is-path-editing .stage__frame");
  assert.match(frame, /flex:\s*1/, "取景框必须自己让出控制条的高度");
  assert.match(frame, /height:\s*auto/, "写死 100% 会把控制条挤出可视区");
});
