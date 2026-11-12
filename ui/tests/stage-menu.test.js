// 舞台右下角菜单的测试：触发区、字号随画面走、滑出与滑回。
// Tests for the stage's corner menu: where it opens, how big it is, and when.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MENU_FONT_AT_FULL_WIDTH,
  MENU_FONT_MAX,
  MENU_FONT_MIN,
  createStageMenu,
  inZone,
  menuFontSize,
  menuZone,
} from "../stage-menu.js";

/** 一块画面盒子，像 `getBoundingClientRect` 报的那样。 */
function frameBox(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** 一个够用的假元素：类名、盒子、尺寸、监听器。 */
function fakeNode({
  box = frameBox(0, 0, 1920, 1080),
  menuWidth = 320,
  menuHeight = 20,
  clientWidth = box.width,
} = {}) {
  const listeners = new Map();
  const classes = new Set();
  const style = new Map();
  return {
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, on) => {
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return classes.has(name);
      },
    },
    offsetWidth: menuWidth,
    offsetHeight: menuHeight,
    clientWidth,
    style: {
      setProperty: (name, value) => style.set(name, value),
      getPropertyValue: (name) => style.get(name) ?? "",
    },
    getBoundingClientRect: () => box,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    /** 挂在这个元素上的监听器类型，用来盯着别把焦点也算成触发条件。 */
    listenerTypes: () => [...listeners.keys()],
  };
}

/** 一个舞台：画面、菜单、舞台本身。 */
function build({ box = frameBox(0, 0, 1920, 1080), menuWidth = 320, menuHeight = 20 } = {}) {
  const stage = fakeNode({ box });
  const frame = fakeNode({ box, menuWidth, menuHeight, clientWidth: box.width });
  const menu = fakeNode({ box, menuWidth, menuHeight });
  const controller = createStageMenu({ stage, frame, menu });
  return { stage, frame, menu, controller };
}

test("触发区是画面右下角的一块地方", () => {
  const frame = frameBox(100, 50, 1920, 1080);
  const zone = menuZone(frame, 320, 20);

  assert.equal(zone.right, frame.right, "贴着画面的右边");
  assert.equal(zone.bottom, frame.bottom, "贴着画面的下边");
  assert.ok(zone.left > frame.left, "在画面之内，不是画布之外");
  assert.ok(zone.top > frame.top, "在画面之内，不是画布之外");
  assert.ok(zone.left > frame.left + frame.width / 2, "只在右半边");
  assert.ok(zone.top > frame.top + frame.height / 2, "只在下半边");
});

test("触发区至少盖住菜单自己，菜单不会露在外面", () => {
  // 画面很小的时候，按比例算出来的触发区盖不住菜单，那块地方就得以菜单为准。
  const frame = frameBox(0, 0, 400, 225);
  const zone = menuZone(frame, 300, 20);

  assert.ok(zone.left <= frame.right - 300, "菜单左端也在触发区里");
  assert.ok(zone.top <= frame.bottom - 20, "菜单上端也在触发区里");
});

test("触发区跟着画面走，画布挪了地方也跟着挪", () => {
  const zone = menuZone(frameBox(100, 50, 1920, 1080), 320, 20);
  assert.equal(zone.right, 2020);
  assert.equal(zone.bottom, 1130);

  const moved = menuZone(frameBox(0, 0, 960, 540), 320, 20);
  assert.equal(moved.right, 960);
  assert.equal(moved.bottom, 540);
});

test("指针在右下角时菜单在，挪开了就没有", () => {
  const { stage, frame, controller } = build();

  assert.equal(controller.isOpen(), false, "一开始是藏着的");
  assert.equal(stage.classList.contains("is-menu-open"), false);

  frame.dispatch("pointermove", { clientX: 1900, clientY: 1070 });
  assert.equal(controller.isOpen(), true, "走到右下角就滑出来");
  assert.equal(stage.classList.contains("is-menu-open"), true);

  frame.dispatch("pointermove", { clientX: 900, clientY: 500 });
  assert.equal(controller.isOpen(), false, "离开那块地方就滑回去");
  assert.equal(stage.classList.contains("is-menu-open"), false);
});

test("指针走出画面，菜单也回去", () => {
  const { frame, controller } = build();

  frame.dispatch("pointermove", { clientX: 1900, clientY: 1070 });
  assert.equal(controller.isOpen(), true);

  frame.dispatch("pointerleave", {});
  assert.equal(controller.isOpen(), false);
});

test("画面没有尺寸的时候不猜，右下角不存在", () => {
  const { stage, frame, controller } = build({ box: frameBox(0, 0, 0, 0) });

  frame.dispatch("pointermove", { clientX: 10, clientY: 10 });
  assert.equal(controller.isOpen(), false);
  assert.equal(stage.classList.contains("is-menu-open"), false);
});

test("字号跟着画面宽度走：同一块画面，菜单的比例一样", () => {
  assert.equal(menuFontSize(1920), MENU_FONT_AT_FULL_WIDTH, "全宽画面上的字号");
  assert.equal(menuFontSize(960), MENU_FONT_AT_FULL_WIDTH / 2, "一半宽，字号也一半");

  // 比例不变：字占画面的几分之几，与画面多大无关。
  const share = menuFontSize(960) / 960;
  assert.equal(menuFontSize(1920) / 1920, share);
});

test("字号有上下限：小窗口也看得清，大窗口也不成横幅", () => {
  assert.equal(menuFontSize(100), MENU_FONT_MIN);
  assert.equal(menuFontSize(99999), MENU_FONT_MAX);
});

test("字号写在画面上，菜单跟着画面走", () => {
  const { frame } = build({ box: frameBox(0, 0, 960, 540) });

  assert.equal(frame.style.getPropertyValue("--stage-menu-size"), "11px");
});

test("触发区的判断就是那四个边", () => {
  const zone = { left: 10, top: 20, right: 30, bottom: 40 };

  assert.equal(inZone(20, 30, zone), true);
  assert.equal(inZone(10, 20, zone), true, "角上也算数");
  assert.equal(inZone(30, 40, zone), true);
  assert.equal(inZone(9, 30, zone), false);
  assert.equal(inZone(31, 30, zone), false);
  assert.equal(inZone(20, 19, zone), false);
  assert.equal(inZone(20, 41, zone), false);
});

test("没有舞台就直说，而不是静默什么都不做", () => {
  assert.throws(
    () => createStageMenu({ stage: null, frame: null, menu: null }),
    /需要一个舞台/,
  );
});

test("焦点不是菜单露出来的理由", () => {
  // 点过按钮之后焦点会留在那个字上。要是焦点也算一份「菜单该露出来」，指针一
  // 离开菜单就再也不肯收回去了。所以这里只听指针。
  const { frame, controller } = build();

  assert.deepEqual(
    frame.listenerTypes().sort(),
    ["pointercancel", "pointerleave", "pointermove"],
    "只听指针，不听焦点",
  );
  assert.equal(controller.isOpen(), false, "焦点在按钮上也不会把菜单叫出来");
});

test("菜单住在画面里：它在画框之内，不是画框的邻居", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const stageAt = html.indexOf('id="stage-view"');
  assert.notEqual(stageAt, -1, "舞台还在");

  const frameStart = html.indexOf('<div class="stage__frame">', stageAt);
  assert.notEqual(frameStart, -1, "画面还在");

  // 数一遍 `<div` 与 `</div>`，找到与画框配对的那个结束标签。
  const tags = /<div\b[^>]*>|<\/div>/g;
  tags.lastIndex = frameStart;
  let depth = 0;
  let frameEnd = -1;
  let match;
  while ((match = tags.exec(html))) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) {
      frameEnd = match.index;
      break;
    }
  }
  assert.notEqual(frameEnd, -1, "画框有配对的结束标签");

  const menuAt = html.indexOf('id="stage-menu"');
  assert.notEqual(menuAt, -1, "菜单还在");
  assert.ok(menuAt > frameStart && menuAt < frameEnd, "菜单必须在画框之内");
});
