// @ts-check
// 阅读器正文栏宽：顶部的拖拽控件，在有限范围内调整正文宽度。
// Pamela — the reader's measure control.

/**
 * 正文栏宽的取值范围与默认值，单位为 `ch`，即当前字号下字符的宽度。
 *
 * 下限保证正文仍能成行，上限避免宽窗口下单行过长；`default` 与
 * `styles/reader.css` 中 `--reader-measure` 的回退值保持一致。
 */
export const READER_MEASURE = Object.freeze({ min: 46, max: 118, default: 78 });

/** 方向键每次调整的步长，单位 ch。 */
const KEY_STEP = 2;

/** 取不到 1ch 的实际宽度时，一 ch 按多少像素计算。 */
const FALLBACK_CH_PX = 8;

/**
 * 把任意输入夹取到允许范围，并取整到整 ch。
 *
 * @param {unknown} value 目标宽度，可以是数字或数字文本。
 * @returns {number} 落在 `READER_MEASURE.min` 与 `max` 之间的整数。
 */
export function clampMeasure(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return READER_MEASURE.default;
  }
  return Math.min(Math.max(Math.round(number), READER_MEASURE.min), READER_MEASURE.max);
}

/**
 * 拖动之后应当得到的栏宽。
 *
 * 正文栏在阅读区中居中，加宽时左右两侧同时外移，因此指针移动 `delta` 像素，
 * 栏宽变化 `2 × delta`。`chPx` 为 1ch 的实际像素宽度，由控件中的量尺取得。
 *
 * @param {number} start 拖动开始时的栏宽，单位 ch。
 * @param {number} delta 指针的水平位移，向右为正，单位像素。
 * @param {number} chPx 1ch 的像素宽度。
 * @returns {number} 夹取并取整后的栏宽，单位 ch。
 */
export function measureFromDrag(start, delta, chPx) {
  const unit = Number(chPx) > 0 ? Number(chPx) : FALLBACK_CH_PX;
  const moved = Number.isFinite(delta) ? delta : 0;
  return clampMeasure(Number(start) + (2 * moved) / unit);
}

/**
 * 建立正文宽度的拖拽控件。
 *
 * 控件是一条贴在阅读区顶部的横条，宽度与正文栏相同，右端跟随指针移动，因此
 * 拖动的距离与栏宽的变化在视觉上是一比一。双击或按 Home 复位，方向键微调。
 * 栏宽记录在控件里，切换文章时不复位。
 *
 * @param {{
 *   view: HTMLElement | null,
 * }} options `view` 是阅读区的滚动容器，栏宽以 CSS 变量写在其上。
 * @returns {{
 *   element: HTMLElement,
 *   measure: () => number,
 *   apply: (value: unknown) => number,
 * }}
 */
export function createReaderMeasure({ view }) {
  const bar = document.createElement("div");
  bar.className = "reader__measure";
  bar.tabIndex = 0;
  bar.setAttribute("role", "separator");
  bar.setAttribute("aria-orientation", "horizontal");
  bar.setAttribute("aria-label", "正文宽度");
  bar.setAttribute("aria-valuemin", String(READER_MEASURE.min));
  bar.setAttribute("aria-valuemax", String(READER_MEASURE.max));
  bar.title = "左右拖动调整正文宽度，双击复位";

  // 量尺：只有 1ch 宽，用来把指针的像素位移换算成 ch。样式见 reader.css。
  const probe = document.createElement("span");
  probe.className = "reader__measure-probe";
  bar.append(probe);

  /** @type {number} 当前的栏宽，单位 ch。 */
  let measure = READER_MEASURE.default;

  /**
   * 应用一个栏宽并回报夹取后的值。
   *
   * @param {unknown} next
   * @returns {number}
   */
  const apply = (next) => {
    measure = clampMeasure(next);
    view?.style?.setProperty("--reader-measure", `${measure}ch`);
    bar.setAttribute("aria-valuenow", String(measure));
    return measure;
  };

  const chPerPx = () => probe.getBoundingClientRect?.().width || FALLBACK_CH_PX;

  /** @type {{ start: number, x: number, chPx: number } | null} */
  let drag = null;

  const finish = () => {
    if (!drag) {
      return;
    }
    drag = null;
    bar.classList.remove("is-dragging");
    document.body?.classList?.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
  };

  /** @param {PointerEvent} event */
  function onMove(event) {
    if (!drag) {
      return;
    }
    apply(measureFromDrag(drag.start, event.clientX - drag.x, drag.chPx));
  }

  bar.addEventListener("pointerdown", (event) => {
    // 只响应主键：右键留给上下文菜单，中键留给滚动。
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    drag = { start: measure, x: event.clientX, chPx: chPerPx() };
    bar.classList.add("is-dragging");
    document.body?.classList?.add("is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });

  bar.addEventListener("dblclick", () => {
    apply(READER_MEASURE.default);
  });

  bar.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -KEY_STEP, ArrowRight: KEY_STEP }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      apply(measure + step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      apply(READER_MEASURE.default);
    }
  });

  apply(measure);

  return { element: bar, measure: () => measure, apply };
}
