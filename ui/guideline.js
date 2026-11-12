// 空间参考线：舞台平面上的 H / V 两组线，加上透视下每个深度截面各一圈网格。
// Pamela — the spatial reference grid, drawn from the same projection as the scene.
//
// 参考线不是画面的装饰，而是让人看懂「深度」这一根轴的东西：
//
// - 舞台平面（z = 0）上，沿 H（横向）与 V（纵向）每隔 interval 画一条 ——
//   这两组线在画面上就是横线与纵线；
// - 每往深处一个截面（z = k·interval），就把同一圈横纵线按那个深度再投影
//   一遍：位置朝中心收、整体缩小。一圈套一圈，就是一条通往灭点的隧道，画面
//   上任何位置都能读出远近，而不只是某一条带子；
// - 透视关着时这些截面一圈也不画：正交投影下深度不改变位置，每个截面都与
//   舞台平面完全重合，画出来只是同一圈线叠上几十遍。
//
// 为什么不能把网格铺在 H 面（y = 0）或 V 面（x = 0）上：这两个面与视线平行，
// 整个面都投影成一条中心线。铺在 H 面上的线端点 v 恒为 0，于是全部落进水平
// 中轴、被中轴线吃掉 —— 透视明明开着，网格看上去却仍是平的。
//
// 舞台（DOM）与导出（离屏 Canvas2D）都调用 `guidelineLines` + `paintGuideline`，
// 两个后端的参考线因此不会分叉。

import { CAMERA_DISTANCE, projectPoint } from "./space.js";

/** 默认间隔：每 100 坐标一条。 */
export const GUIDELINE_INTERVAL = 100;

/** 间隔的下限：再密就糊成一片，读不出格点。 */
export const GUIDELINE_MIN_INTERVAL = 10;

/** 一条沿深度方向的参考线画到多深：一个相机距离，正好缩到一半。 */
export const GUIDELINE_REACH = CAMERA_DISTANCE;

/**
 * 最多画几圈深度截面。
 *
 * 间隔调到 10 时「每 10 一格 × 200 个深度」是几万条线，画面糊成一片、重画也
 * 会卡；截面数量封顶之后，间隔只决定每一圈网格的疏密，隧道的圈数保持稳定。
 * 间隔 100 时一个相机距离正好 20 圈，就是这个上限。
 */
export const GUIDELINE_MAX_SECTIONS = 20;

/**
 * 把作者写的间隔收成一个可用的整数。
 *
 * 缺省是 100；小于 10 的按 10 算（约定里「最小为 10」），小数四舍五入——
 * 参考线落在非整数坐标上没有意义。非数字是脚本错误，和其余数值参数一致。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function guidelineInterval(value) {
  if (value === undefined || value === null) {
    return GUIDELINE_INTERVAL;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("参考线间隔需要 ≥ 10 的整数");
  }
  return Math.max(GUIDELINE_MIN_INTERVAL, Math.round(number));
}

/**
 * 一幅参考线的全部线段，舞台逻辑坐标（原点在中心、y 向上）。
 *
 * 两组来源：
 *
 * 1. 舞台平面上的竖线：`h = k·间隔`，从画面下边到上边；横线：`v = k·间隔`，
 *    从画面左边到右边。关掉透视时能看到的就只有这两组；
 * 2. 深度截面（只有透视开着时才有）：`z = k·间隔`，每个截面上都是同一圈横纵
 *    线，只是按该深度收向灭点、整体缩小。从 z = 0 一路到 `GUIDELINE_REACH`，
 *    一圈套一圈 —— 所以整幅画面都有深度可读，而不只是某一条带子。
 *
 * 每一段都经过 `projectPoint`：同一圈网格，深度越大在画面上越小、越靠中心。
 * 截面数量按 `GUIDELINE_MAX_SECTIONS` 封顶，间隔只在同一圈内加密。
 *
 * @param {object} [options]
 * @param {number} [options.width] 逻辑画幅宽，缺省 1920。
 * @param {number} [options.height] 逻辑画幅高，缺省 1080。
 * @param {number} [options.interval] 间隔，缺省 100、最小 10。
 * @param {boolean} [options.perspective] 是否按透视投影。
 * @returns {Array<{ from: {x:number,y:number}, to: {x:number,y:number},
 *   strong: boolean, kind: "plane" | "depth" }>} `kind` 只供读者与测试分辨这
 *   条线属于舞台平面还是某个深度截面，绘制时不看它。
 */
export function guidelineLines({
  width = 1920,
  height = 1080,
  interval = GUIDELINE_INTERVAL,
  perspective = false,
} = {}) {
  const step = guidelineInterval(interval);
  const halfW = (Number(width) || 1920) / 2;
  const halfH = (Number(height) || 1080) / 2;
  const lines = [];
  const at = (x, y, z) => projectPoint({ x, y, z }, { perspective });

  // 一侧的格点编号：从 0 往两边数，两端都落在画幅内。
  const span = (half) => {
    const count = Math.floor(half / step);
    const values = [];
    for (let index = -count; index <= count; index += 1) {
      values.push(index * step);
    }
    return values;
  };

  // 舞台平面上的竖线与横线：横纵两组，就是关掉透视时能看到的全部。
  for (const x of span(halfW)) {
    lines.push({
      from: at(x, -halfH, 0),
      to: at(x, halfH, 0),
      strong: x === 0,
      kind: "plane",
    });
  }
  for (const y of span(halfH)) {
    lines.push({
      from: at(-halfW, y, 0),
      to: at(halfW, y, 0),
      strong: y === 0,
      kind: "plane",
    });
  }

  // 深度截面只在透视里成立：正交空间里深度不改变画面上的位置，每一圈截面都
  // 与舞台平面完全重合，画出来只是同一圈线叠上几十遍。
  if (!perspective) {
    return lines;
  }

  const verticals = span(halfW);
  const horizontals = span(halfH);
  // 第 0 圈就是舞台平面自己，已经有了；往深处最多再画 `GUIDELINE_MAX_SECTIONS` 圈。
  const far = Math.floor(GUIDELINE_REACH / step);
  const stride = Math.max(1, Math.ceil(far / GUIDELINE_MAX_SECTIONS));
  for (let index = stride; index <= far; index += stride) {
    const depth = index * step;
    for (const x of verticals) {
      // h = 0 的那条与舞台平面的中轴线重合，画几十遍只会把中轴烧成一根白线。
      if (x === 0) {
        continue;
      }
      lines.push({
        from: at(x, -halfH, depth),
        to: at(x, halfH, depth),
        strong: false,
        kind: "depth",
      });
    }
    for (const y of horizontals) {
      if (y === 0) {
        continue;
      }
      lines.push({
        from: at(-halfW, y, depth),
        to: at(halfW, y, depth),
        strong: false,
        kind: "depth",
      });
    }
  }

  return lines;
}

/** 参考线的画法：普通线淡、轴上的线（h = 0 / v = 0）略亮。 */
const LINE_STYLE = Object.freeze({
  normal: { color: "rgba(140, 200, 255, 0.22)", width: 1 },
  strong: { color: "rgba(200, 230, 255, 0.45)", width: 1.4 },
});

/**
 * 把一幅参考线画到一张 Canvas2D 上。
 *
 * 画布坐标与舞台坐标的换算只在这里做一次：`x = (宽/2 + 逻辑x) * scale`、
 * `y = (高/2 - 逻辑y) * scale`。调用方负责清空画布——舞台的覆盖层只在设置变化
 * 时重画，导出是整帧重画，两边的清法不一样。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} [options]
 * @param {{width:number,height:number}} [options.size] 逻辑画幅。
 * @param {number} [options.scale] 画布像素 / 逻辑像素。
 * @param {number} [options.interval] 间隔。
 * @param {boolean} [options.perspective] 是否按透视投影。
 * @returns {boolean} 是否真的画了东西；没有可用的 2D 上下文时安静地返回 false。
 */
export function paintGuideline(ctx, options = {}) {
  if (!ctx || typeof ctx.beginPath !== "function" || typeof ctx.stroke !== "function") {
    return false;
  }
  const size = options.size ?? { width: 1920, height: 1080 };
  const width = Number(size.width) || 1920;
  const height = Number(size.height) || 1080;
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 1;
  const lines = guidelineLines({
    width,
    height,
    interval: options.interval,
    perspective: options.perspective === true,
  });
  if (!lines.length) {
    return false;
  }
  const pixel = (point) => ({
    x: (width / 2 + point.x) * scale,
    y: (height / 2 - point.y) * scale,
  });

  ctx.save?.();
  ctx.setTransform?.(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.lineCap = "butt";
  ctx.setLineDash?.([]);

  for (const line of lines) {
    const from = pixel(line.from);
    const to = pixel(line.to);
    // 退化成一个点的线没有长度，也就不该落下一个点（正交空间里沿 D 的线就是）。
    if (Math.hypot(to.x - from.x, to.y - from.y) < 0.5) {
      continue;
    }
    const style = line.strong ? LINE_STYLE.strong : LINE_STYLE.normal;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = Math.max(1, style.width * scale);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  ctx.restore?.();
  return true;
}

/**
 * 舞台上的参考线覆盖层。
 *
 * 与坐标轴不同，参考线不随对象动：它只在 `stage.perspective()` /
 * `stage.guideline()` 改设置时重画一次，没有逐帧循环。
 *
 * @param {object} [options]
 * @param {{width:number,height:number}} [options.size] 逻辑画幅。
 * @param {number} [options.scale] 画布像素 / 逻辑像素。
 * @returns {{ node: object, update: (state: object) => void, clear: () => void,
 *   destroy: () => void, isVisible: () => boolean }}
 */
export function createGuidelineLayer({
  size = { width: 1920, height: 1080 },
  scale = 0.5,
} = {}) {
  const node = document.createElement("canvas");
  node.className = "stage__guideline";
  node.width = Math.max(1, Math.round(size.width * scale));
  node.height = Math.max(1, Math.round(size.height * scale));
  const context = typeof node.getContext === "function" ? node.getContext("2d") : null;
  let visible = false;

  const clear = () => {
    if (context && typeof context.clearRect === "function") {
      context.save?.();
      context.setTransform?.(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, node.width, node.height);
      context.restore?.();
    }
  };

  const update = (state = {}) => {
    visible = Boolean(state.enabled);
    clear();
    if (!visible) {
      return false;
    }
    return paintGuideline(context, {
      size,
      scale: node.width / (size.width || 1),
      interval: state.interval,
      perspective: state.perspective === true,
    });
  };

  return {
    node,
    update,
    clear: () => {
      visible = false;
      clear();
    },
    destroy: () => {
      visible = false;
      clear();
    },
    isVisible: () => visible,
  };
}
