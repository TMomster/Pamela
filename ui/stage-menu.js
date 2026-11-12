// 舞台右下角的演出菜单：平时藏在画面里，指针走到右下角才滑出来。
// Pamela — the stage's text menu: it lives inside the picture, and it slides
// out only while the pointer is in the picture's bottom-right corner.
//
// 为什么它住在画面里：菜单是画面的一部分，不是窗口的一部分。挂在 `.stage__frame`
// 外面的时候，编辑器里它落在画面下方的黑边之外，全屏里它又贴着窗口的边缘——
// 同一套菜单在两种模式下位置不同、字号不同，看起来像两样东西。搬进画面之后，
// 它永远贴着画面的右下角，字号也按画面宽度算，窗口多大、画面多大都是同一副样子。
//
// 为什么平时藏着：画面上除了对话框就是画面。菜单贴着右下角，平时不出声；指针
// 走过去它才滑出来，指针离开它再滑回去——和视觉小说把菜单收在角落里的做法一样。

import { STAGE_WIDTH } from "./stage.js";

/**
 * 画面全宽（1920）时的菜单字号。
 *
 * 字号跟着画面走，而不是跟着窗口走：编辑器里画面小，菜单字也小；全屏时画面铺满
 * 屏幕，字也按比例变大。两种模式里菜单占画面的比例一样，看起来是同一块画面。
 */
export const MENU_FONT_AT_FULL_WIDTH = 22;

/** 字号的上下限：窗口再小也要看得清，窗口再大也不至于变成横幅。 */
export const MENU_FONT_MIN = 10;
export const MENU_FONT_MAX = 30;

/**
 * 触发区：画面右下角多大一块地方算数。
 *
 * 是画面的四分之一宽、八分之一高。这块地方足够大，指针朝右下角走就能碰到；又
 * 不至于大到把整块对话框都圈进去——指针只是停在画面中间读台词时，菜单不该冒
 * 出来。
 */
export const ZONE_WIDTH_SHARE = 0.25;
export const ZONE_HEIGHT_SHARE = 0.12;

/** 触发区至少要盖住菜单本身，否则菜单会露在触发区外面。 */
export const ZONE_MARGIN = 16;

/**
 * 触发区：画面右下角的矩形。
 *
 * @param {{left: number, top: number, right: number, bottom: number, width: number, height: number}} frame 画面的盒子。
 * @param {number} menuWidth 菜单自己的宽度。
 * @param {number} menuHeight 菜单自己的高度。
 * @returns {{left: number, top: number, right: number, bottom: number}} 触发区。
 */
export function menuZone(frame, menuWidth = 0, menuHeight = 0) {
  const width = Math.max(frame.width * ZONE_WIDTH_SHARE, menuWidth + ZONE_MARGIN);
  const height = Math.max(frame.height * ZONE_HEIGHT_SHARE, menuHeight + ZONE_MARGIN);
  return {
    left: frame.right - width,
    top: frame.bottom - height,
    right: frame.right,
    bottom: frame.bottom,
  };
}

/**
 * 指针在这块地方里吗？
 *
 * @param {number} x 指针的横坐标（视口坐标）。
 * @param {number} y 指针的纵坐标（视口坐标）。
 * @param {{left: number, top: number, right: number, bottom: number}} zone 触发区。
 * @returns {boolean}
 */
export function inZone(x, y, zone) {
  return x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
}

/**
 * 画面这么宽时，菜单该用多大的字。
 *
 * @param {number} frameWidth 画面的宽度（像素）。
 * @returns {number} 字号（像素）。
 */
export function menuFontSize(frameWidth) {
  const size = (frameWidth / STAGE_WIDTH) * MENU_FONT_AT_FULL_WIDTH;
  return Math.min(MENU_FONT_MAX, Math.max(MENU_FONT_MIN, size));
}

/**
 * 让舞台右下角的菜单随指针进出。
 *
 * 指针走到画面右下角，`.stage` 挂上 `is-menu-open`，菜单从画面下缘滑进画内；
 * 指针离开那块地方，菜单滑回去。CSS 只管动画，开合由这里决定。
 *
 * 焦点不算数：这里只听指针，不听 focus。点过按钮之后焦点会留在那个字上，要是
 * 焦点也算一份「菜单该露出来」，菜单就再也不肯收回去了。样式那边同样没有
 * `:focus-within` 那一支，两边都要守住这条。
 *
 * @param {object} options
 * @param {HTMLElement} options.stage `#stage-view`，`is-menu-open` 挂在它身上。
 * @param {HTMLElement} options.frame `.stage__frame`，菜单住在它里面。
 * @param {HTMLElement} options.menu `.stage__menu`，被滑进滑出的那排字。
 * @returns {{open: () => void, close: () => void, isOpen: () => boolean}}
 */
export function createStageMenu({ stage, frame, menu }) {
  if (!stage || !frame || !menu) {
    throw new Error("createStageMenu 需要一个舞台、画面和菜单");
  }

  let open = false;

  const setOpen = (on) => {
    if (on === open) {
      return;
    }
    open = on;
    stage.classList.toggle("is-menu-open", on);
  };

  /**
   * 菜单自己的尺寸。
   *
   * 用 `offsetWidth` 而不是 `getBoundingClientRect()`：菜单收起时带着
   * `translateY`，量矩形会量到滑下去的位置上去。`offsetWidth` 量的是排版盒子，
   * 不受 transform 影响。
   */
  const menuBox = () => ({ width: menu.offsetWidth, height: menu.offsetHeight });

  const onMove = (event) => {
    const rect = frame.getBoundingClientRect();
    // 画面没有尺寸的时候（标签页还没打开、窗口被压扁）没有右下角可言。
    if (!rect.width || !rect.height) {
      setOpen(false);
      return;
    }
    const box = menuBox();
    setOpen(inZone(event.clientX, event.clientY, menuZone(rect, box.width, box.height)));
  };

  // 指针走出画面，菜单就回去。菜单是画面的后代，指针移到菜单上不算离开。
  const onLeave = () => setOpen(false);

  frame.addEventListener("pointermove", onMove);
  frame.addEventListener("pointerleave", onLeave);
  frame.addEventListener("pointercancel", onLeave);

  /**
   * 字号跟着画面宽度走。
   *
   * 画面被拉宽拉窄时菜单跟着变，编辑器里和全屏里是同一个比例。画面还没量到
   * 尺寸时（刚建好还没排版）不动它，CSS 里那份兜底值先用着。
   */
  const fitFont = () => {
    const width = frame.clientWidth;
    if (!width) {
      return;
    }
    frame.style.setProperty("--stage-menu-size", `${menuFontSize(width)}px`);
  };

  fitFont();
  // 没有 ResizeObserver 的环境（测试里搭的假 DOM）就只在建好时量一次。
  let observer = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(fitFont);
    observer.observe(frame);
  }

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    dispose: () => {
      observer?.disconnect();
      observer = null;
      frame.removeEventListener("pointermove", onMove);
      frame.removeEventListener("pointerleave", onLeave);
      frame.removeEventListener("pointercancel", onLeave);
      setOpen(false);
    },
  };
}
