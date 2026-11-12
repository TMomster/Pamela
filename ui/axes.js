// 对象的三维坐标轴：几何、绘制与舞台上的覆盖层。
// Pamela — an object's own 3D axes: geometry, painting, and the stage overlay.
//
// `crood(true)` 打开之后，每个对象身上会画出它自己的三根轴：x 平轴、y 升轴、
// z 推轴。三根轴就是 `orientationOf()` 给出的 right / up / normal，跟着
// (rotate, rotateH, rotateV) 一起转；端点各自按 `projectPoint()` 做透视，所以
// 转出 W 面时近端长、远端短，z 轴会朝画面中心收过去。
//
// 舞台（DOM）与导出（离屏 Canvas2D）都调用这里的 `axesOf` + `paintAxes`，
// 两个后端看到的轴不会分叉。覆盖层是一张固定分辨率的 canvas，用 CSS 拉伸到
// 整个画幅，因此不需要跟着窗口尺寸重算。

import { orientationOf, projectPoint } from "./space.js";

/** 一根轴在舞台逻辑坐标里的长度；随对象缩放，但夹在能看清的范围内。 */
export const AXIS_LENGTH = 240;

/** 三根轴的画法。颜色与坐标图里的三个圈相呼应：橙、绿、蓝。 */
export const AXIS_STYLE = Object.freeze({
  x: { key: "x", label: "x 平轴", color: "#ffa640", vector: "right" },
  y: { key: "y", label: "y 升轴", color: "#5ed67b", vector: "up" },
  z: { key: "z", label: "z 推轴", color: "#5aa9ff", vector: "normal" },
});

/** 画轴的顺序：先画指向画面深处的推轴，再画压在画面里的两根。 */
export const AXIS_KEYS = Object.freeze(["z", "y", "x"]);

/** 负方向那一小截占正方向的比例 —— 只是让人看出「轴穿过原点」。 */
const BACK_RATIO = 0.28;

/**
 * 算出一个对象此刻该画的三根轴。
 *
 * 返回的都是**舞台逻辑坐标**（原点在画幅中心、y 向上、单位同 `STAGE_WIDTH`）。
 * 每个端点单独投影：一根斜着的轴，两端各有自己的 z，统一乘一个 `depthScale`
 * 是错的。
 *
 * @param {object} pose `{ x, y, z, rotate|rotation, rotateH, rotateV, scale }`
 * @param {object} [options]
 * @param {string} [options.key] 对象键，只作标签用。
 * @param {string} [options.label] 画在原点旁边的名字。
 * @param {number} [options.length] 覆盖轴长。
 * @param {boolean} [options.perspective] 舞台是否开着透视；关着时各端点按
 *   正交投影摆放，推轴在画面上退化成一个点。
 * @returns {{ key: string, label: string, origin: {x:number,y:number},
 *   axes: Array<{key:string,label:string,color:string,
 *     from:{x:number,y:number},to:{x:number,y:number},back:{x:number,y:number}}> }}
 */
export function axesOf(pose = {}, options = {}) {
  const source = pose && typeof pose === "object" ? pose : {};
  const x = Number(source.x) || 0;
  const y = Number(source.y) || 0;
  const z = Number(source.z) || 0;
  const size = Number.isFinite(Number(source.scale)) ? Number(source.scale) : 1;
  const perspective = options.perspective !== false;
  const length = options.length > 0
    ? options.length
    : AXIS_LENGTH * Math.min(3, Math.max(0.25, size || 1));
  // 灯自带一套朝向：它的 `rotate` 是画面里的那次转动，不走 `orientationOf`
  // 的三个角（见 `ui/light.js` 的 `lightOrientation`），由调用方放进 `orientation`。
  const { right, up, normal } = source.orientation ?? orientationOf(source);
  const vectors = { right, up, normal };

  const origin = projectPoint({ x, y, z }, { perspective });
  const endpoint = (axis, sign) => projectPoint({
    x: x + sign * length * axis[0],
    y: y + sign * length * axis[1],
    z: z + sign * length * axis[2],
  }, { perspective });

  const axes = AXIS_KEYS.map((key) => {
    const style = AXIS_STYLE[key];
    const axis = vectors[style.vector];
    return {
      key,
      label: style.label,
      color: style.color,
      from: origin,
      to: endpoint(axis, 1),
      back: endpoint(axis, -BACK_RATIO),
    };
  });

  return {
    key: options.key ?? "",
    label: options.label ?? "",
    origin,
    axes,
  };
}

/**
 * 把若干对象的坐标轴画到一张 Canvas2D 上。
 *
 * 画布坐标与舞台坐标的换算只在这里做一次：`x = (宽/2 + 逻辑x) * scale`、
 * `y = (高/2 - 逻辑y) * scale`。调用方负责清空画布（导出是整帧重画，覆盖层
 * 则在每一拍自己 clearRect），因为两种场景该清的范围不一样。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<ReturnType<typeof axesOf>>} frames
 * @param {{ size: {width:number,height:number}, scale?: number }} options
 * @returns {boolean} 是否真的画了东西；没有可用的 2D 上下文时安静地返回 false。
 */
export function paintAxes(ctx, frames = [], options = {}) {
  // 测试里的假 DOM 没有 2D 上下文；一帧没有坐标轴好过一帧因此崩掉。
  if (!ctx || typeof ctx.beginPath !== "function" || typeof ctx.stroke !== "function") {
    return false;
  }
  const list = Array.isArray(frames) ? frames.filter(Boolean) : [];
  if (!list.length) {
    return false;
  }
  const { size = { width: 1920, height: 1080 } } = options;
  const width = Number(size?.width) || 1920;
  const height = Number(size?.height) || 1080;
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 1;
  const pixel = (point) => ({
    x: (width / 2 + point.x) * scale,
    y: (height / 2 - point.y) * scale,
  });

  ctx.save?.();
  ctx.setTransform?.(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const line = (from, to) => {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  for (const frame of list) {
    const from = pixel(frame.origin);
    for (const axis of frame.axes ?? []) {
      const to = pixel(axis.to);
      const back = pixel(axis.back);
      ctx.strokeStyle = axis.color;

      // 负方向那一截压暗、画细，只用来交代轴是从原点穿过去的。
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = Math.max(1, 1.4 * scale);
      ctx.setLineDash?.([5 * scale, 5 * scale]);
      line(from, back);
      ctx.setLineDash?.([]);

      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1.5, 2.4 * scale);
      line(from, to);

      // 箭头：以正方向端点为尖，沿轴往回退一小段张开一个三角形。
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const span = Math.hypot(dx, dy);
      if (span > 1 && typeof ctx.fill === "function") {
        const ux = dx / span;
        const uy = dy / span;
        const tip = Math.min(14 * scale, span * 0.3);
        ctx.fillStyle = axis.color;
        ctx.beginPath();
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(to.x - ux * tip - uy * tip * 0.45, to.y - uy * tip + ux * tip * 0.45);
        ctx.lineTo(to.x - ux * tip + uy * tip * 0.45, to.y - uy * tip - ux * tip * 0.45);
        ctx.closePath();
        ctx.fill();
      }

      if (typeof ctx.fillText === "function") {
        ctx.fillStyle = axis.color;
        ctx.font = `${Math.max(10, Math.round(17 * scale))}px sans-serif`;
        ctx.fillText(axis.label, to.x + 7 * scale, to.y - 7 * scale);
      }
    }

    // 原点一个白点；对象名跟在旁边，多个对象叠在一起时才知道谁是谁。
    if (typeof ctx.fill === "function") {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc?.(from.x, from.y, Math.max(2, 3 * scale), 0, Math.PI * 2);
      ctx.fill();
    }
    if (frame.label && typeof ctx.fillText === "function") {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = `${Math.max(10, Math.round(15 * scale))}px sans-serif`;
      ctx.fillText(frame.label, from.x + 8 * scale, from.y + 18 * scale);
    }
  }
  ctx.restore?.();
  return true;
}

/**
 * 舞台上的坐标轴覆盖层。
 *
 * 有对象开着 `crood` 时才逐帧重画：对象随时可能上台、走位或转身，逐帧读当前
 * 姿态比在几十个改动点里逐个触发重画可靠。没有轴可见时这一层完全安静。
 * CSS 过渡中的轴按对象记住的目标姿态画，图片本身仍由浏览器过渡过去。
 *
 * @param {object} options
 * @param {{width:number,height:number}} options.size 逻辑画幅。
 * @param {number} [options.scale] 画布像素 / 逻辑像素。
 * @param {() => Array<object>} [options.read] 每次重画时读取当前的坐标轴数据。
 * @param {() => boolean} [options.active] 这一帧没画到轴、但仍该继续等下一帧
 *   时为真（对象开着坐标轴却还没 `enable()` 就是这种情形）。
 * @param {(run: () => void) => void} [options.schedule] 帧调度器。
 */
export function createAxesLayer({
  size = { width: 1920, height: 1080 },
  scale = 0.5,
  read = () => [],
  active = () => false,
  schedule = (run) => setTimeout(run, 16),
}) {
  const node = document.createElement("canvas");
  node.className = "stage__axes";
  node.width = Math.max(1, Math.round(size.width * scale));
  node.height = Math.max(1, Math.round(size.height * scale));
  const context = typeof node.getContext === "function" ? node.getContext("2d") : null;
  let alive = true;
  let running = false;
  let frames = [];

  const clear = () => {
    if (context && typeof context.clearRect === "function") {
      context.save?.();
      context.setTransform?.(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, node.width, node.height);
      context.restore?.();
    }
  };

  const tick = () => {
    if (!alive) {
      return;
    }
    frames = read() || [];
    clear();
    paintAxes(context, frames, { size, scale: node.width / (size.width || 1) });
    if (frames.length || active()) {
      schedule(tick);
    } else {
      running = false;
    }
  };

  const layer = {
    node,
    /** 轴数可能变了（开关、对象增删），重新起一次逐帧循环。 */
    invalidate: () => {
      if (!alive || !context || running) {
        return;
      }
      running = true;
      schedule(tick);
    },
    clear: () => {
      frames = [];
      clear();
    },
    destroy: () => {
      alive = false;
      running = false;
      frames = [];
      clear();
    },
    isVisible: () => frames.length > 0,
  };
  // 没有 2D 上下文（node 测试、没拿到画布）时不排任何帧，循环不会空转。
  if (!context) {
    layer.invalidate = () => {};
  }
  return layer;
}
