// 离屏 Canvas2D 渲染后端：把时间线求值出的状态画成一帧。
// Pamela — the offscreen Canvas2D backend: state + assets → one frame.
//
// 范围：背景、角色（pose / alpha / 滤镜 / 调色 / 8 点自由变形）、视频画面、
// 文字、粒子、对话盒与打字机字数。层序与舞台一致：
// 角色 → 视频 → 粒子 → 文字 → 对话盒。
// 视频按播放头 seek 到素材的某一刻，粒子按固定步长推进（见 export-effect.js）；
// 8 点网格用与 `stage.js` 相同的三角剖分贴图，几何一致、实现不同。
//
// 坐标系沿用 `stage.js`：1920×1080 逻辑空间、中心为原点、y 轴向上。

import { axesOf, paintAxes } from "./axes.js";
import { draw as drawPlate, hasPlate, styleFor } from "./dialog-plate.js";
import { createEffectLayer } from "./export-effect.js";
import { paintGuideline } from "./guideline.js";
import { drawPamelaIntro, pamelaIntroState } from "./pamela-intro.js";
import {
  CAMERA_DISTANCE,
  CORNERS,
  depthScale,
  isFlatPose,
  orientationOf,
  projectPose,
  quadTriangles,
  sceneOrder,
} from "./space.js";
import { antialiasBitmap, antialiasIsOn } from "./antialias.js";
import { lookFilter } from "./filters.js";
import { gifFrameAt } from "./gif.js";
import { lightOrientation, lightShadeOf, normalizeLight, paintLights } from "./light.js";
import { spriteFrameAt } from "./sprite-group.js";
import { TEXT_FONT_WEIGHT, textFontStack } from "./text-font.js";

export const LOGICAL_SIZE = Object.freeze({ width: 1920, height: 1080 });

/** 静态位图直接画；GIF 帧集按虚拟时间（或 `step` 定格）挑一帧。 */
function bitmapAt(asset, t, freeze) {
  if (!asset || asset.kind !== "gif" || !Array.isArray(asset.frames)) {
    return asset;
  }
  const index = gifFrameAt(asset, t, freeze);
  return index >= 0 ? asset.frames[index] : null;
}

/**
 * 这一层在这一刻该画哪一张图。
 *
 * 逐帧图片组不往时间线上逐帧写记录：状态里留下列表、速度与起播时刻，这里按
 * 时间算出第几张。一遍播完停最后一张，循环播放取模绕回开头 —— 与舞台的播放
 * 器同一份算法（见 `sprite-group.js`）。
 *
 * @param {object} picture One layer's state at this moment.
 * @param {number} t Milliseconds from the start of the recording.
 * @returns {string}
 */
function spritePathAt(picture, t) {
  const group = picture.group;
  if (!picture.groupPlaying || !Array.isArray(group) || group.length === 0) {
    return picture.path;
  }
  const at = spriteFrameAt(
    t - (picture.groupStart ?? 0),
    Number(picture.groupFps) || 0,
    group.length,
    Boolean(picture.groupLoop),
  );
  return at >= 0 ? group[at] : picture.path;
}

const DIALOG_BOX = Object.freeze({ x: 120, y: 820, width: 1680, height: 210 });
const TEXT_FONT = '"Source Han Sans CN", "Microsoft YaHei", sans-serif';
const TEXT_SIZE = 32;
/** A Text object's authored size and leading, matching `.stage__text`. */
const TEXT_OBJECT_SIZE = 48;
const TEXT_OBJECT_LINE_HEIGHT = 1.3;

function clamp(value, low, high) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : low;
}

/** CSS `object-fit` 的三种语义，返回以中心为原点绘制所需的矩形。 */
export function fitRect(sourceW, sourceH, boxW, boxH, mode = "contain") {
  if (!(sourceW > 0 && sourceH > 0)) {
    return null;
  }
  if (mode === "fill") {
    return { dw: boxW, dh: boxH, dx: 0, dy: 0 };
  }
  const ratio =
    mode === "cover"
      ? Math.max(boxW / sourceW, boxH / sourceH)
      : Math.min(boxW / sourceW, boxH / sourceH);
  const dw = sourceW * ratio;
  const dh = sourceH * ratio;
  return { dw, dh, dx: (boxW - dw) / 2, dy: (boxH - dh) / 2 };
}

/**
 * 手写 CJK 断行：DOM 的 `pre-wrap` / `word-break` 在 `fillText` 里没有等价物。
 * `measure` 由调用方注入，便于纯逻辑测试。
 */
export function wrapText(text, measure, maxWidth) {
  const lines = [];
  let line = "";
  for (const char of String(text ?? "")) {
    if (char === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    const candidate = line + char;
    if (line && measure(candidate) > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line = candidate;
    }
  }
  if (line || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}

/** 把 `filters.js` 的 look 对象转成 Canvas 的 filter 字符串。 */
export function lookString(look) {
  if (!look || typeof look !== "object") {
    return "";
  }
  try {
    return lookFilter(look) || "";
  } catch {
    return "";
  }
}

// --- 8 点自由变形：与 stage.js 的 mesh 共用同一张三角剖分表 ---
// 舞台用八片 clip-path + CSS matrix 贴图；Canvas 用同样的八个三角形，每片
// 先 clip 到目标三角形，再用仿射矩阵把整张位图投过去。

/** 八个控制点在矩形上的位置：x 向右、y 向上，-1/0/1 是三个档位。 */
export const MESH_HANDLES = Object.freeze({
  upleft: [-1, 1],
  up: [0, 1],
  upright: [1, 1],
  right: [1, 0],
  downright: [1, -1],
  down: [0, -1],
  downleft: [-1, -1],
  left: [-1, 0],
});

/** 九个节点在图片自身的归一化坐标（u 向右、v 向下）。 */
const MESH_NODES = Object.freeze({
  upleft: [0, 0],
  up: [0.5, 0],
  upright: [1, 0],
  right: [1, 0.5],
  downright: [1, 1],
  down: [0.5, 1],
  downleft: [0, 1],
  left: [0, 0.5],
  centre: [0.5, 0.5],
});

/** 四个象限各切两刀，全部在 centre 缝合；顺序与 stage.js 一致。 */
const MESH_TRIANGLES = Object.freeze([
  ["upleft", "up", "centre"],
  ["upleft", "centre", "left"],
  ["upright", "right", "centre"],
  ["upright", "centre", "up"],
  ["downright", "down", "centre"],
  ["downright", "centre", "right"],
  ["downleft", "left", "centre"],
  ["downleft", "centre", "down"],
]);

/** clip 三角形外扩半像素，盖住相邻片的抗锯齿接缝（同 stage.js）。 */
const MESH_BLEED = 0.5;

/** 未变形时控制点相对图片中心的位置；舞台坐标，y 向上。 */
export function meshBasePoint(handle, rect) {
  const signs = MESH_HANDLES[handle];
  if (!signs || !rect) {
    return { x: 0, y: 0 };
  }
  return { x: (signs[0] * rect.dw) / 2, y: (signs[1] * rect.dh) / 2 };
}

function meshOffset(picture, handle, axis) {
  const value = Number(picture?.[`mesh_${handle}_${axis}`]);
  return Number.isFinite(value) ? value : 0;
}

/** 只要有一个控制点离开原位，就改走网格绘制。 */
function hasMesh(picture) {
  return Object.keys(MESH_HANDLES).some(
    (handle) => meshOffset(picture, handle, "dx") !== 0 || meshOffset(picture, handle, "dy") !== 0,
  );
}

/**
 * 八个节点在画布像素坐标里的位置（左上原点、y 向下）。
 *
 * 与 `stage.js::pointsOf` 同一个公式：P = (x,y) + R(θ)·(s·B·(ax,ay))，其中
 * B 是 contain 到逻辑画幅后的图片矩形。脚本的 `by(dx,dy)` 是加在 P 上的
 * **世界位移**，不能再经过 R·S —— 旧实现把它加在 ctx.translate/rotate/scale
 * 之后的局部坐标里，scale(0.5) 时幅度被砍半，rotation 时方向还会偏。
 * 因此网格路径不套 ctx 的 pose 变换，pose 在这里一次算完。
 */
export function meshNodes(picture, rect, size = LOGICAL_SIZE, perspective = false) {
  const width = Number(size?.width) || LOGICAL_SIZE.width;
  const height = Number(size?.height) || LOGICAL_SIZE.height;
  const radians = (clamp(picture.rotation ?? 0, -1e6, 1e6) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scale = clamp(picture.scale ?? 1, 0.001, 1e3);
  const originX = clamp(picture.x ?? 0, -1e6, 1e6);
  const originY = clamp(picture.y ?? 0, -1e6, 1e6);

  // 转过身的对象：节点先被朝向整体转过去，再由相机投到画面上。躺着的对象
  // 保持原来的算法（它就是这套投影的特例，省掉两次乘法）。
  const pose = picturePose(picture);
  const flatPose = isFlatPose(pose);
  const turned = flatPose ? null : orientationOf(pose).matrix;
  const depth = clamp(picture.z ?? 0, -1e9, 1e9);
  const place = (stageX, stageY) => {
    if (!turned) {
      return { x: width / 2 + stageX, y: height / 2 - stageY };
    }
    const lx = stageX - pose.x;
    const ly = stageY - pose.y;
    const wx = turned[0] * lx + turned[1] * ly + pose.x;
    const wy = turned[3] * lx + turned[4] * ly + pose.y;
    const wz = turned[6] * lx + turned[7] * ly + depth;
    // 正交空间里不按深度缩放：转过身的物体仍被压短，但不会朝灭点收过去。
    const flat = perspective
      ? CAMERA_DISTANCE / Math.max(1, CAMERA_DISTANCE + wz)
      : 1;
    return { x: width / 2 + wx * flat, y: height / 2 - wy * flat };
  };

  const nodes = {};
  for (const handle of Object.keys(MESH_HANDLES)) {
    const base = meshBasePoint(handle, rect);
    const lx = base.x * scale;
    const ly = base.y * scale;
    const stageX = originX + lx * cos + ly * sin + meshOffset(picture, handle, "dx");
    const stageY = originY - lx * sin + ly * cos + meshOffset(picture, handle, "dy");
    nodes[handle] = place(stageX, stageY);
  }
  const corners = ["upleft", "upright", "downright", "downleft"];
  nodes.centre = {
    x: corners.reduce((sum, name) => sum + nodes[name].x, 0) / corners.length,
    y: corners.reduce((sum, name) => sum + nodes[name].y, 0) / corners.length,
  };
  return nodes;
}

/** 三点到三点的仿射矩阵；与 `stage.js::affineFor` 同式。 */
function affineFor(source, target) {
  const [s1, s2, s3] = source;
  const [t1, t2, t3] = target;
  const u = { x: s2.x - s1.x, y: s2.y - s1.y };
  const v = { x: s3.x - s1.x, y: s3.y - s1.y };
  const U = { x: t2.x - t1.x, y: t2.y - t1.y };
  const V = { x: t3.x - t1.x, y: t3.y - t1.y };
  const det = u.x * v.y - u.y * v.x;
  if (Math.abs(det) < 1e-9) {
    return null;
  }
  const a = (U.x * v.y - V.x * u.y) / det;
  const c = (u.x * V.x - v.x * U.x) / det;
  const b = (U.y * v.y - V.y * u.y) / det;
  const d = (u.x * V.y - v.x * U.y) / det;
  return {
    a,
    b,
    c,
    d,
    e: t1.x - (a * s1.x + c * s1.y),
    f: t1.y - (b * s1.x + d * s1.y),
  };
}

/** 沿重心外扩，盖住两片之间的发丝缝。 */
function bleedTriangle(points, amount) {
  const middle = {
    x: (points[0].x + points[1].x + points[2].x) / 3,
    y: (points[0].y + points[1].y + points[2].y) / 3,
  };
  return points.map((point) => {
    const dx = point.x - middle.x;
    const dy = point.y - middle.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + (dx / length) * amount, y: point.y + (dy / length) * amount };
  });
}

/** 一张画面在时间线上的姿态：位置、深度、三个转角与缩放。 */
function picturePose(picture) {
  return {
    x: clamp(picture.x ?? 0, -1e6, 1e6),
    y: clamp(picture.y ?? 0, -1e6, 1e6),
    z: picture.z,
    rotation: clamp(picture.rotation ?? 0, -1e6, 1e6),
    rotateH: Number(picture.rotateH) || 0,
    rotateV: Number(picture.rotateV) || 0,
    scale: clamp(picture.scale ?? 1, 0.001, 1e3),
    scaleX: Number(picture.scaleX) || 1,
    scaleY: Number(picture.scaleY) || 1,
  };
}

/**
 * 一张画面投到画布上的四个角（画布像素、y 向下），顺时针，从左上起。
 *
 * 与舞台写 `matrix3d` 用的是同一套数（`ui/space.js::projectPose`），所以预览
 * 里看到的形状就是成片里的形状。
 */
function pictureCorners(picture, rect, size, perspective = false) {
  const projected = projectPose(
    picturePose(picture),
    { w: rect.dw, h: rect.dh },
    { perspective },
  );
  return CORNERS.map((handle) => {
    const at = projected.corners[handle];
    return { x: size.width / 2 + at.x, y: size.height / 2 - at.y };
  });
}

/**
 * 把一张位图铺到一个透视后的四边形上。
 *
 * `drawImage` 只能做仿射，所以四边形按 `QUAD_TRIANGLES` 拆成两片，各算一个
 * 仿射、各自裁剪着画。顶点略微外扩，盖住两片之间那条发丝缝 —— 与八点网格
 * 同一种画法。
 */
function drawQuad(ctx, bitmap, rect, corners) {
  const source = [
    { x: -rect.dw / 2, y: -rect.dh / 2 },
    { x: rect.dw / 2, y: -rect.dh / 2 },
    { x: rect.dw / 2, y: rect.dh / 2 },
    { x: -rect.dw / 2, y: rect.dh / 2 },
  ];
  for (const piece of quadTriangles(source, corners)) {
    ctx.save();
    ctx.beginPath();
    const grown = bleedTriangle(piece.target, MESH_BLEED);
    ctx.moveTo(grown[0].x, grown[0].y);
    ctx.lineTo(grown[1].x, grown[1].y);
    ctx.lineTo(grown[2].x, grown[2].y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(piece.a, piece.b, piece.c, piece.d, piece.e, piece.f);
    ctx.drawImage(bitmap, -rect.dw / 2, -rect.dh / 2, rect.dw, rect.dh);
    ctx.restore();
  }
}

/**
 * 文字与粒子这类画不成四边形的东西用的近似：把姿态在中心处展开成一次仿射。
 *
 * 对躺在 W 面里的对象它是精确的（就是 `rotate` + `scale`）；转出画面之后它是
 * 一阶近似 —— Canvas2D 没有能把字形扭成透视的工具，近处的放大、远侧的缩短
 * 只能体现在这个线性部分上。
 */
function transformPose(ctx, picture, size, perspective = false) {
  const pose = picturePose(picture);
  const { matrix } = orientationOf(pose);
  const flat = depthScale(pose.z, perspective);
  ctx.translate(size.width / 2 + pose.x * flat, size.height / 2 - pose.y * flat);
  // 画布自身的局部坐标是 y 向下的，所以列向量要换个号：源的 +y 在画面上是
  // 往上，而画布的 +y 是往下。躺在 W 面里时这一组数正好是 `rotate` + `scale`。
  ctx.transform(
    flat * matrix[0],
    -flat * matrix[3],
    -flat * matrix[1],
    flat * matrix[4],
    0,
    0,
  );
}

/** 用八个三角形把位图投到变形后的网格上；节点已是画布像素坐标。 */
function drawMesh(ctx, bitmap, rect, picture, size, perspective = false) {
  const nodes = meshNodes(picture, rect, size, perspective);
  // 深度只缩放位置：八个控制点始终是舞台平面上的作者坐标。
  const flat = depthScale(picture.z, perspective);
  if (flat !== 1) {
    for (const key of Object.keys(nodes)) {
      const node = nodes[key];
      nodes[key] = {
        x: size.width / 2 + (node.x - size.width / 2) * flat,
        y: size.height / 2 + (node.y - size.height / 2) * flat,
      };
    }
  }
  for (const triangle of MESH_TRIANGLES) {
    const source = triangle.map((name) => {
      const [u, v] = MESH_NODES[name];
      return { x: (u - 0.5) * rect.dw, y: (v - 0.5) * rect.dh };
    });
    const target = triangle.map((name) => nodes[name]);
    const matrix = affineFor(source, target);
    if (!matrix) {
      continue;
    }
    ctx.save();
    ctx.beginPath();
    const grown = bleedTriangle(target, MESH_BLEED);
    ctx.moveTo(grown[0].x, grown[0].y);
    ctx.lineTo(grown[1].x, grown[1].y);
    ctx.lineTo(grown[2].x, grown[2].y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.drawImage(bitmap, -rect.dw / 2, -rect.dh / 2, rect.dw, rect.dh);
    ctx.restore();
  }
}

/** 位图、GIF 帧与视频元素都报得出自己的像素尺寸，但字段名各不相同。 */
function sourceSize(bitmap, intrinsic, fallback) {
  return {
    width: intrinsic?.width || bitmap.videoWidth || bitmap.width || bitmap.naturalWidth || fallback.width,
    height: intrinsic?.height || bitmap.videoHeight || bitmap.height || bitmap.naturalHeight || fallback.height,
  };
}

/**
 * 滤镜与调色在时间线里另存一组扁平数值（`look_blur`、`tint_r` …），
 * 这样过渡能像位移一样插值；没有扁平值时才退回整组对象。
 */
function lookOf(picture) {
  if (picture?.look_blur !== undefined || picture?.look_brightness !== undefined) {
    return {
      blur: Number(picture.look_blur) || 0,
      brightness: picture.look_brightness === undefined ? 1 : Number(picture.look_brightness),
      contrast: picture.look_contrast === undefined ? 1 : Number(picture.look_contrast),
      saturate: picture.look_saturate === undefined ? 1 : Number(picture.look_saturate),
    };
  }
  return picture?.look ?? null;
}

/** 舞台的调色是「每个通道加一个偏移」，画布没有对应 filter，只能按像素加。 */
function tintOf(picture) {
  let r = 0;
  let g = 0;
  let b = 0;
  if (picture?.tint_r !== undefined || picture?.tint_g !== undefined || picture?.tint_b !== undefined) {
    r = Number(picture.tint_r) || 0;
    g = Number(picture.tint_g) || 0;
    b = Number(picture.tint_b) || 0;
  } else {
    const tint = picture?.tint;
    if (!tint || typeof tint !== "object") {
      return null;
    }
    r = Number(tint.r) || 0;
    g = Number(tint.g) || 0;
    b = Number(tint.b) || 0;
  }
  return r || g || b ? { r, g, b } : null;
}

/** 离屏画布：优先 OffscreenCanvas，退回 document.createElement。 */
function defaultScratch(width, height) {
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function channel(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * 把一帧位图（或视频帧）按通道偏移染色，返回可直接 drawImage 的画布。
 *
 * 只在调色不为零时调用；1920×1080 的一层每帧要过两百万像素，所以带调色
 * 的成片会明显慢一些——这与舞台无关，是画布没有矩阵滤镜的代价。
 */
function tintedBitmap(createScratch, bitmap, width, height, tint) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scratch = createScratch(w, h);
  const sctx = scratch?.getContext?.("2d");
  if (!sctx) {
    return null;
  }
  sctx.clearRect(0, 0, w, h);
  sctx.drawImage(bitmap, 0, 0, w, h);
  const frame = sctx.getImageData(0, 0, w, h);
  const pixels = frame?.data;
  if (!pixels) {
    return null;
  }
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = channel(pixels[index] + tint.r);
    pixels[index + 1] = channel(pixels[index + 1] + tint.g);
    pixels[index + 2] = channel(pixels[index + 2] + tint.b);
  }
  sctx.putImageData(frame, 0, 0);
  return scratch;
}

/**
 * 处理过的位图，按「哪张图 + 哪一档强度」缓存。
 *
 * 导出是逐帧重画的：同一张角色图会在几百帧里被画几百次，处理一次要读整张位图
 * 的像素，绝不能每帧再来一遍。位图本身是稳定对象（静态图是解码结果，GIF 是逐帧
 * 的 canvas），所以拿它当键；`WeakMap` 让它随位图一起被回收。
 *
 * 缓存跨渲染器共享：同一张图在任何一帧里的处理结果都一样，没必要各存一份。
 */
const antialiasCache = new WeakMap();

/**
 * 这张位图在当前强度下处理过的版本；不需要处理或处理不了时交出 `null`。
 *
 * @param {object} bitmap
 * @param {{ width: number, height: number }} size 位图自己的尺寸。
 * @param {{ smooth: number, edges: number }} modes
 * @returns {object | null} 一张同尺寸的画布。
 */
function antialiasedFor(bitmap, size, modes) {
  if (!antialiasIsOn(modes)) {
    return null;
  }
  const key = `${modes.smooth}|${modes.edges}`;
  const cached = antialiasCache.get(bitmap);
  if (cached && cached.key === key) {
    return cached.canvas;
  }
  const result = antialiasBitmap(bitmap, size.width, size.height, modes, defaultScratch);
  if (!result?.canvas) {
    return null;
  }
  antialiasCache.set(bitmap, { key, canvas: result.canvas });
  return result.canvas;
}

function drawPicture(
  ctx,
  picture,
  bitmap,
  size,
  mode,
  intrinsic = null,
  createScratch = null,
  metrics = null,
  /** 环境亮度：与画面自己的 look 相乘，1 为原样。 */
  ambient = 1,
  /** 舞台是否开着透视；关着时按正交投影画，深度不改变大小。 */
  perspective = false,
  /** 逆光暗部：这一张画面自己该被压暗多少，1 为原样（见 `lightShadeOf`）。 */
  shade = 1,
) {
  if (picture.visible === false) {
    return;
  }
  const source = sourceSize(bitmap, intrinsic, size);
  const rect = fitRect(source.width, source.height, size.width, size.height, mode);
  if (!rect) {
    return;
  }
  // 抗锯齿：强度 0–2。0（或没写）表示不处理 —— 角色那一档默认就是 0。
  const modes = {
    smooth: Number(picture.smooth) || 0,
    edges: Number(picture.edgeSmooth) || 0,
  };
  let image = bitmap;
  const soft = antialiasedFor(bitmap, source, modes);
  if (soft) {
    image = soft;
  }
  const tint = tintOf(picture);
  if (tint && createScratch) {
    const tinted = metrics
      ? metrics.call("tint", () => tintedBitmap(createScratch, image, rect.dw, rect.dh, tint))
      : tintedBitmap(createScratch, image, rect.dw, rect.dh, tint);
    if (!tinted) {
      return;
    }
    image = tinted;
  }
  ctx.save();
  // 关着的那一档（强度 0）按最近的像素取，成片的边才和舞台上一样是硬的；开着
  // 的时候像素已经处理过了，不该再让浏览器取整。没写这个字段的对象（背景、视频）
  // 保持默认的平滑。
  ctx.imageSmoothingEnabled = !(picture.smooth === 0 || picture.smooth === false);
  ctx.globalAlpha = clamp(picture.opacity ?? 1, 0, 1);
  // 环境亮度与逆光暗部都乘在这个 `brightness` 上，和舞台写进元素 filter 的
  // 是同一个乘积（舞台那边在 `paintFilters` 里合）。
  const brightness = ambient * clamp(shade, 0, 1);
  const filter = [lookString(lookOf(picture)), brightness !== 1 ? `brightness(${brightness})` : ""]
    .filter(Boolean)
    .join(" ");
  if (filter) {
    ctx.filter = filter;
  }
  if (hasMesh(picture)) {
    // 网格节点自带 pose：这里不能再 translate/rotate/scale，否则控制点偏移
    // 会被二次缩放/旋转（舞台的 by(dx,dy) 是与 pose 无关的世界位移）。
    drawMesh(ctx, image, rect, picture, size, perspective);
  } else if (!isFlatPose(picturePose(picture))) {
    // 转出 W 面：四边形逐片仿射贴图，近大远小与透视缩短都按同一套投影来。
    drawQuad(ctx, image, rect, pictureCorners(picture, rect, size, perspective));
  } else {
    // 深度：z 越大越靠画面深处，位置朝中心收敛、尺寸同比缩小（z=0 时是 1）。
    // 正交空间里 flat 恒为 1，位置与尺寸都不随 z 变。
    const flat = depthScale(picture.z, perspective);
    ctx.translate(
      size.width / 2 + clamp(picture.x ?? 0, -1e6, 1e6) * flat,
      size.height / 2 - clamp(picture.y ?? 0, -1e6, 1e6) * flat,
    );
    ctx.rotate((clamp(picture.rotation ?? 0, -1e6, 1e6) * Math.PI) / 180);
    const scale = clamp(picture.scale ?? 1, 0.001, 1e3) * flat;
    ctx.scale(scale, scale);
    ctx.drawImage(image, -rect.dw / 2, -rect.dh / 2, rect.dw, rect.dh);
  }
  ctx.restore();
}

/** The stage never shrinks type below 14px; the frame follows the same floor. */
const MIN_DIALOGUE_FONT = 14;

/** Fits the style's logical canvas into the output frame. */
function plateScale(plate, width, height) {
  const logicalW = Number(plate?.canvas?.width) || LOGICAL_SIZE.width;
  const logicalH = Number(plate?.canvas?.height) || LOGICAL_SIZE.height;
  return Math.min(width / logicalW, height / logicalH);
}

/** A style font record → a Canvas font string. */
function styleFontString(font, size) {
  const family = font?.family || "sans-serif";
  const weight = font?.weight ?? 400;
  const italic = font?.italic ? "italic " : "";
  return `${italic}${weight} ${size}px "${family}", sans-serif`;
}

/** The characters the typewriter tween has revealed at this frame. */
function shownDialogueText(dialogue) {
  const text = typeof dialogue?.text === "string" ? dialogue.text : "";
  if (typeof dialogue?.revealed !== "number") {
    return text;
  }
  return [...text].slice(0, Math.max(0, Math.floor(dialogue.revealed))).join("");
}

/**
 * Wraps a line, then shrinks the type until the whole line fits its box.
 * The stage does the same with `fitText`; without this, every line after the
 * fourth used to be dropped in silence.
 */
function fitDialogueLines(ctx, shown, measureText, width, height, baseSize, leadingRatio, makeFont, floor) {
  let size = baseSize;
  let lines = [];
  let leading = size * leadingRatio;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    ctx.font = makeFont(size);
    lines = wrapText(shown, measureText, width);
    leading = size * leadingRatio;
    if (lines.length * leading <= height || size <= floor) {
      break;
    }
    size = Math.max(floor, size * 0.94);
  }
  return {
    lines,
    size,
    leading,
    maxLines: Math.max(1, Math.floor((height + 1e-6) / leading)),
  };
}

/** Horizontal/vertical placement inside a box, mirroring the stage's flex. */
function alignedOrigin(box, align, valign, blockHeight) {
  const textAlign = align === "center" || align === "right" ? align : "left";
  const x = textAlign === "center"
    ? box.x + box.width / 2
    : textAlign === "right" ? box.x + box.width : box.x;
  const inset = Math.max(0, box.height - blockHeight);
  const y = valign === "middle"
    ? box.y + inset / 2
    : valign === "bottom" ? box.y + inset : box.y;
  return { x, y, textAlign };
}

function numberOr(value, fallback) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value)
    : fallback;
}

/** The built-in box, kept byte-for-byte for projects whose style is unreadable. */
function drawBuiltInDialogue(ctx, dialogue, scale, measureText) {
  const box = {
    x: DIALOG_BOX.x * scale,
    y: DIALOG_BOX.y * scale,
    width: DIALOG_BOX.width * scale,
    height: DIALOG_BOX.height * scale,
  };
  const padding = 24 * scale;
  const nameSize = 40 * scale;
  const textSize = TEXT_SIZE * scale;
  ctx.save();
  ctx.fillStyle = "rgba(6, 8, 14, 0.82)";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.textBaseline = "top";

  if (dialogue.name) {
    ctx.fillStyle = "#ffd479";
    ctx.font = `bold ${nameSize}px ${TEXT_FONT}`;
    // The fourth argument stops a long name running off the box.
    ctx.fillText(String(dialogue.name), box.x + padding, box.y + 14 * scale, box.width - padding * 2);
  }

  const top = box.y + (dialogue.name ? 70 : 24) * scale;
  const available = Math.max(1, box.y + box.height - top - padding * 0.5);
  const makeFont = (size) => `${size}px ${TEXT_FONT}`;
  const fitted = fitDialogueLines(
    ctx, shownDialogueText(dialogue), measureText, box.width - padding * 2,
    available, textSize, 1.4, makeFont, MIN_DIALOGUE_FONT * scale,
  );
  ctx.fillStyle = "#ffffff";
  ctx.font = makeFont(fitted.size);
  for (let index = 0; index < Math.min(fitted.lines.length, fitted.maxLines); index += 1) {
    ctx.fillText(fitted.lines[index], box.x + padding, top + index * fitted.leading);
  }
  ctx.restore();
}

/** Draws a line with the boxes, fonts and colours the style file declares. */
function drawStyledDialogue(ctx, dialogue, scale, measureText, style, platePainted) {
  const speaker = style.speaker ?? {};
  const body = style.text ?? {};
  ctx.save();
  if (!platePainted) {
    // No layers to paint: keep a plain plate so the words stay readable.
    ctx.fillStyle = "rgba(6, 8, 14, 0.82)";
    ctx.fillRect(
      DIALOG_BOX.x * scale, DIALOG_BOX.y * scale,
      DIALOG_BOX.width * scale, DIALOG_BOX.height * scale,
    );
  }

  if (dialogue.name) {
    const size = numberOr(speaker.font?.size, 40) * scale;
    const box = {
      x: numberOr(speaker.x, 180) * scale,
      y: numberOr(speaker.y, 786) * scale,
      width: numberOr(speaker.width, 520) * scale,
      height: numberOr(speaker.height, 64) * scale,
    };
    const at = alignedOrigin(box, speaker.align, speaker.valign, size * 1.4);
    ctx.font = styleFontString(speaker.font, size);
    ctx.fillStyle = speaker.font?.color ?? "#ffd479";
    ctx.textAlign = at.textAlign;
    ctx.textBaseline = "top";
    ctx.fillText(String(dialogue.name), at.x, at.y, box.width);
  }

  const box = {
    x: numberOr(body.x, 180) * scale,
    y: numberOr(body.y, 862) * scale,
    width: numberOr(body.width, 1560) * scale,
    height: numberOr(body.height, 170) * scale,
  };
  const baseSize = numberOr(body.font?.size, 32) * scale;
  const leadingRatio = numberOr(body.lineHeight, 1.4) || 1.4;
  const makeFont = (size) => styleFontString(body.font, size);
  const fitted = fitDialogueLines(
    ctx, shownDialogueText(dialogue), measureText, box.width, box.height,
    baseSize, leadingRatio, makeFont, MIN_DIALOGUE_FONT * scale,
  );
  const drawn = Math.min(fitted.lines.length, fitted.maxLines);
  const at = alignedOrigin(box, body.align, body.valign, drawn * fitted.leading);
  ctx.font = makeFont(fitted.size);
  ctx.fillStyle = body.font?.color ?? "#f2f2f2";
  ctx.textAlign = at.textAlign;
  ctx.textBaseline = "top";
  for (let index = 0; index < drawn; index += 1) {
    ctx.fillText(fitted.lines[index], at.x, at.y + index * fitted.leading, box.width);
  }
  ctx.restore();
}

function drawDialogue(ctx, dialogue, size, measureText, plate = null, platePainted = false) {
  if (!dialogue || dialogue.visible === false) {
    return;
  }
  // Authored boxes live in the style's logical canvas, while the painter works
  // in output-canvas pixels. Box, padding and type all scale together: at 720p
  // an unscaled y=820 used to sit below the picture and lose the whole line.
  const scale = plateScale(
    plate,
    Number(size?.width) || LOGICAL_SIZE.width,
    Number(size?.height) || LOGICAL_SIZE.height,
  );
  // The stage picks a slot from the name alone (`slotFor`), so the frame does
  // the same. A character whose name is the empty string reads as narration —
  // the same edge the stage's own `slotFor` has.
  const slot = dialogue.name ? "dialog" : "narration";
  const style = plate ? styleFor(plate, slot) : null;
  if (style?.text) {
    drawStyledDialogue(ctx, dialogue, scale, measureText, style, platePainted);
  } else {
    drawBuiltInDialogue(ctx, dialogue, scale, measureText);
  }
}

/**
 * 画一个 Text 对象：内容、字号与颜色来自构造参数，其余 pose 与图片一致。
 *
 * 文字以自身中心对齐脚本坐标，与舞台上的 `translate(-50%, -50%)` 相同；
 * 换行只认作者写下的 `\n`，不做自动折行，所以成片与预览的断行一致。
 */
function drawText(ctx, item, size, ambient = 1, perspective = false) {
  if (!item || item.visible === false) {
    return;
  }
  const content = typeof item.text === "string" ? item.text : "";
  if (!content) {
    return;
  }
  const fontSize = clamp(item.size ?? TEXT_OBJECT_SIZE, 1, 400);
  const lineHeight = fontSize * TEXT_OBJECT_LINE_HEIGHT;
  const lines = content.split("\n");
  const top = -((lines.length - 1) * lineHeight) / 2;
  ctx.save();
  ctx.globalAlpha = clamp(item.opacity ?? 1, 0, 1);
  if (ambient !== 1) {
    ctx.filter = `brightness(${ambient})`;
  }
  // 颜色是一段过渡时，时间线给出的是三个通道的插值；能插值就用它，否则
  // 用作者写的 CSS 颜色（`tomato` 之类拆不出通道的颜色只到点换色）。
  const interpolated = item.colorIsRgb === true && Number.isFinite(item.color_r)
    ? `rgb(${Math.round(item.color_r)}, ${Math.round(item.color_g ?? 0)}, ${Math.round(item.color_b ?? 0)})`
    : null;
  ctx.fillStyle = interpolated ?? item.color ?? "#ffffff";
  // 与舞台同一个字体栈：西文默认 JetBrains Mono，中文默认思源黑体；作者
  // 指定的字体会排在最前，同时覆盖两种文字。字重写在字号前面，是 canvas
  // `font` 简写的顺序。
  const weight = item.fontWeight ?? TEXT_FONT_WEIGHT;
  ctx.font = `${weight} ${fontSize}px ${textFontStack(item.fontFamily)}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // 姿态一次算完：深度、三个转角与缩放都在这一个矩阵里，和图片同一套投影。
  transformPose(ctx, item, size, perspective);
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(lines[index], 0, top + index * lineHeight);
  }
  ctx.restore();
}

/**
 * 一帧只遍历一次状态，把五类层分开。
 *
 * 旧实现在 `paint` 里对 state 做三次 `Object.entries`、在 `render` 里再做一次
 * `filter`，每层还重复 `startsWith`；这里合并成一次，分类结果同时供取帧与绘制用。
 * 分类规则与旧循环逐条对应，层序不变。
 */
function classifyState(state) {
  const pictures = [];
  const videos = [];
  const effects = [];
  const texts = [];
  const lights = [];
  let ambient = null;
  let dialogue = null;
  // 舞台级的两把尺子：透视默认关（正交空间），参考线默认关。
  let perspective = false;
  let guideline = null;
  /** `stage.pamela()` 的开场动画，盖在所有图层之上。 */
  let pamelaIntro = null;
  for (const [target, value] of Object.entries(state ?? {})) {
    if (target === "dialogue") {
      dialogue = value;
    } else if (target === "pamelaIntro") {
      // 它不是一张图片：记下开始时刻，由 paint 按当前 t 现算动画状态。
      pamelaIntro = value?.active === true ? value : null;
    } else if (target === "ambient") {
      // 环境亮度不是对象：它只是每层画面的一个乘数。
      ambient = value;
    } else if (target === "perspective") {
      // 透视不是对象：它改的是整幅画面的投影。
      perspective = value?.value === true;
    } else if (target === "guideline") {
      guideline = value;
    } else if (target.startsWith("light:")) {
      // 灯先于图片分出来，否则会被当成一张找不到素材的图片静默丢掉。
      if (value && typeof value === "object") {
        lights.push([target, value]);
      }
    } else if (target.startsWith("effect:")) {
      effects.push([target, value]);
    } else if (target.startsWith("video:")) {
      if (value && typeof value === "object" && value.visible !== false && Boolean(value.path)) {
        videos.push([target, value]);
      }
    } else if (target.startsWith("text:")) {
      // 文字没有位图：必须在 pictures 的兜底之前分出来，否则会被当成
      // 一张找不到素材的图片而静默丢掉。
      if (value && typeof value === "object" && value.visible !== false) {
        texts.push([target, value]);
      }
    } else if (!target.startsWith("gif:") && value && typeof value === "object") {
      pictures.push([target, value]);
    }
  }
  return {
    pictures, videos, effects, texts, lights,
    ambient, dialogue, perspective, guideline, pamelaIntro,
  };
}

/**
 * 这一帧里开着 `crood` 的对象，各自一套三轴。
 *
 * 状态里的姿态就是舞台图层 frame 里的那一组数；`axesOf()` 与舞台的覆盖层
 * 共用，所以预览与成片看到的轴方向、透视长度完全一致。音频和粒子在
 * `classifyState` 里就没有这类状态，自然也不会有轴。
 */
function axesFramesOf(groups) {
  const frames = [];
  const add = (target, value) => {
    if (value?.crood !== true || value.visible === false) {
      return;
    }
    const at = String(target).indexOf(":");
    const label = at < 0 ? String(target) : String(target).slice(at + 1);
    frames.push(axesOf(value, { key: target, label, perspective: groups.perspective === true }));
  };
  for (const [target, picture] of groups.pictures) add(target, picture);
  for (const [target, video] of groups.videos) add(target, video);
  for (const [target, item] of groups.texts) add(target, item);
  for (const [target, lamp] of groups.lights) {
    // 灯的 `rotate` 在时间线上记作 `rotation`，而它是画面里的那次转动，
    // 不在 `orientationOf` 的三个角里：三根轴算好再交出去，成片里的轴才与
    // 那束光同向。
    if (!lamp) {
      add(target, lamp);
      continue;
    }
    const pose = { ...lamp, rotate: lamp.rotation ?? 0 };
    add(target, { ...pose, orientation: lightOrientation(pose) });
  }
  return frames;
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement|OffscreenCanvas} options.canvas 目标画布
 * @param {Map<string, unknown>} [options.assets] 资源名 → 已解码位图
 * @param {{width: number, height: number}} [options.size]
 * @param {object} [options.video] 视频帧来源，见下面 `video` 的说明
 * @param {(width: number, height: number) => object} [options.createScratch]
 *   调色用的离屏画布；缺省时按 (w,h) 池化复用
 * @returns {{ canvas: object, render: (state: object, t: number) => object|Promise<object> }}
 */
export function createCanvasRenderer({
  canvas,
  assets = new Map(),
  /**
   * The dialogue style document. When it has layers, the frame's plate is
   * painted by the very same `draw()` the stage and the designer use, and the
   * text takes its boxes and fonts from `styles[slot]`. Null keeps the old
   * built-in box for projects whose style file could not be read.
   */
  plate = null,
  size = LOGICAL_SIZE,
  background = "#050505",
  /**
   * 视频帧的来源：`frames.seek(path, seconds)` 交出可画的元素，
   * `playheads.mediaTimeAt(target, t)` 把时间线时刻换成素材时刻。
   * 没有它时视频对象仍然是空层（与接线前的导出一致）。
   */
  video = null,
  /** 调色用的离屏画布；测试可注入。缺省时按 (w,h) 池化复用。 */
  createScratch = null,
  /** 分项计时（seek / 调色）；null 表示不计时。 */
  metrics = null,
}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("无法创建离屏 2D 上下文");
  }
  const width = Number(size.width) || LOGICAL_SIZE.width;
  const height = Number(size.height) || LOGICAL_SIZE.height;
  // 粒子层的模拟状态挂在这里：跨帧推进，导出结束随 renderer 一起丢掉。
  const effects = createEffectLayer({ width, height });

  // 调色画布按尺寸复用：旧实现每个调色层每帧都新建一张（1080p 时尤其浪费）。
  // tintedBitmap 每次会 clearRect 重画，且 drawImage 在返回前同步消费，复用是安全的。
  const scratchPool = new Map();
  const scratchFor =
    createScratch ??
    ((w, h) => {
      const key = `${w}x${h}`;
      if (scratchPool.has(key)) {
        return scratchPool.get(key);
      }
      const scratch = defaultScratch(w, h);
      if (scratch) {
        scratchPool.set(key, scratch);
      }
      return scratch;
    });

  // 打字机逐字显示时，前缀文本每帧被反复 measureText；同一段台词内缓存宽度。
  // 长台词会逐档缩小字号重排，键里必须带上当前字体，否则读到旧字号的宽度。
  let measuredText = null;
  const textWidths = new Map();
  const measureText = (part) => {
    const key = `${ctx.font}\u0000${part}`;
    let cached = textWidths.get(key);
    if (cached === undefined) {
      cached = ctx.measureText(part).width;
      textWidths.set(key, cached);
    }
    return cached;
  };

  /**
   * 静止帧判据：状态与上一帧完全一致、且没有按虚拟时间变化的层。
   * 粒子按 t 推进、GIF 按 t 选帧、视频播放头按 t 走，三者任一存在都不能复用。
   * 返回 null 表示「这帧不可复用」，否则返回可比较的状态签名。
   */
  function staticFrameSignature(groups, state) {
    // 开场动画每一帧都不同，时间线里只有一条不变的 set，不能按静帧复用。
    if (groups.pamelaIntro || groups.effects.length > 0 || groups.videos.length > 0) {
      return null;
    }
    for (const [, picture] of groups.pictures) {
      // 逐帧图片组每一刻都可能是另一张，和 GIF 一样不算静帧。
      if (picture?.groupPlaying && Array.isArray(picture.group) && picture.group.length > 0) {
        return null;
      }
      const asset = picture?.path ? assets.get(picture.path) : null;
      if (asset?.kind === "gif") {
        return null;
      }
    }
    return JSON.stringify(state ?? {});
  }
  let lastStaticSignature = null;

  // 灯层的四张离屏画布各司其职：灯层本身、单灯的临时层（柔光与挖洞）、轮廓
  // 光剪影、受光对象（贴图乘光色）。不能共用——调色用的池子按尺寸发同一张。
  let lightCanvas = null;
  let lightHalo = null;
  let lightRim = null;
  let lightLit = null;
  const ensureLightCanvases = () => {
    if (!lightCanvas) {
      lightCanvas = defaultScratch(width, height);
      lightHalo = defaultScratch(width, height);
      lightRim = defaultScratch(width, height);
      lightLit = defaultScratch(width, height);
    }
    return Boolean(lightCanvas && lightHalo && lightRim && lightLit);
  };

  /** 被灯照到的对象，按 `ui/light.js` 的剪影格式交出几何与位图。 */
  function litObjectsAt(groups, t) {
    const list = [];
    for (const [target, picture] of groups.pictures) {
      const picturePath = spritePathAt(picture, t);
      if (!picturePath || picture.visible === false) {
        continue;
      }
      const bitmap = bitmapAt(assets.get(picturePath), t, picture.frame);
      if (!bitmap) {
        continue;
      }
      const source = sourceSize(bitmap, null, { width, height });
      const mode = target === "background" ? "cover" : "contain";
      const rect = fitRect(source.width, source.height, width, height, mode);
      if (!rect) {
        continue;
      }
      // 灯光剪影跟着透视走：远处的对象在画面里更小、更靠中心；转过身之后
      // 交出去的是投影后的四个角，边光才贴着它真正的轮廓。
      const pose = picturePose(picture);
      const flat = depthScale(pose.z, groups.perspective === true);
      // 透光：角色默认挡光，其余类型默认让光穿过去（与 `ui/export-stage.js`
      // 写下的默认值一致；旧状态里没有这个字段时按类型补上）。
      const passLight = picture.lightPass === undefined
        ? !target.startsWith("character:")
        : picture.lightPass === true;
      const entry = {
        key: target,
        bitmap,
        x: pose.x * flat,
        y: pose.y * flat,
        z: Number(picture.z) || 0,
        w: rect.dw * flat,
        h: rect.dh * flat,
        rotation: pose.rotation,
        scale: pose.scale,
        scaleX: pose.scaleX,
        scaleY: pose.scaleY,
        // 逆光的轮廓光强度，0 = 不勾边。背景默认 0：整帧的边光只会糊成一片。
        // 被照亮的那块仍按自身像素提亮，见 `ui/light.js`。
        rim: Number(picture.rim) || 0,
        // 透光的对象不按深度挡灯（见 `ui/light.js` 的 `holesOf`）。
        cast: !passLight,
      };
      if (!isFlatPose(pose)) {
        const projected = projectPose(
          pose,
          { w: rect.dw, h: rect.dh },
          { perspective: groups.perspective === true },
        );
        entry.x = projected.center.x;
        entry.y = projected.center.y;
        entry.w = rect.dw;
        entry.h = rect.dh;
        entry.rotation = 0;
        entry.scale = 1;
        entry.scaleX = 1;
        entry.scaleY = 1;
        entry.corners = CORNERS.map((handle) => projected.corners[handle]);
      }
      list.push(entry);
    }
    return list;
  }

  /** 画灯层，再以 `screen` 叠到画面上：灯只提亮，不压暗。 */
  function paintLightLayer(groups, t) {
    const entries = groups.lights ?? [];
    if (!entries.length) {
      return;
    }
    if (!ensureLightCanvases()) {
      return;
    }
    const lightContext = lightCanvas.getContext?.("2d");
    if (!lightContext) {
      return;
    }
    const lights = [];
    for (const [, value] of entries) {
      if (!value || value.visible === false) {
        continue;
      }
      const params = normalizeLight({ ...value, rotate: value.rotation ?? 0 });
      lights.push({ ...params, excluded: new Set(value.excluded ?? []) });
    }
    if (!lights.length) {
      return;
    }
    const painted = paintLights(lightContext, lights, {
      size: { width, height },
      scale: 1,
      objects: litObjectsAt(groups, t),
      scratch: { light: lightHalo, rim: lightRim, lit: lightLit },
    });
    if (!painted) {
      return;
    }
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.filter = "none";
    ctx.drawImage(lightCanvas, 0, 0);
    ctx.restore();
  }

  /** 层序：角色 → 视频 → 粒子 → 文字 → 灯 → 对话盒。 */
  function paint(groups, t, frames) {
    const ambient = clamp(groups.ambient?.value ?? 1, 0, 2);
    // 舞台的透视开关：整帧只读一次，所有层用同一个投影。
    const perspective = groups.perspective === true;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    // 逆光压出来的暗部：舞台上算的是每个对象写进 `filter` 的亮度系数，成片
    // 这里算同一份，乘在 `drawPicture` 的 `brightness` 上，两边才不会一个暗
    // 一个亮。没挡光的（背景、`translucent(true)`）不吃自己的影子。
    const shadeLights = [];
    for (const [, value] of groups.lights ?? []) {
      if (!value || value.visible === false) {
        continue;
      }
      shadeLights.push({
        ...normalizeLight({ ...value, rotate: value.rotation ?? 0 }),
        excluded: new Set(value.excluded ?? []),
      });
    }
    const shadeOf = (picture, bitmap, target) => {
      if (!shadeLights.length || target === "background") {
        return 1;
      }
      const passLight = picture.lightPass === undefined
        ? !target.startsWith("character:")
        : picture.lightPass === true;
      if (passLight) {
        return 1;
      }
      const source = sourceSize(bitmap, null, { width, height });
      const rect = fitRect(source.width, source.height, width, height, "contain");
      if (!rect) {
        return 1;
      }
      const pose = picturePose(picture);
      const flat = depthScale(pose.z, perspective);
      const scale = pose.scale ?? 1;
      return lightShadeOf(
        shadeLights,
        {
          x: (pose.x || 0) * flat,
          y: (pose.y || 0) * flat,
          w: rect.dw * scale * flat,
          h: rect.dh * scale * flat,
        },
        Number(picture.z) || 0,
        target,
      );
    };

    // 背景与角色放进同一套顺序：z 决定谁在前，z 相同时背景在下、角色在上，
    // 同 z 同层保持状态里的先后。与舞台写在元素上的 z-index 是同一个真源。
    const pictures = sceneOrder(
      [...groups.pictures].map(([target, picture]) => ({
        kind: target === "background" ? "background" : "character",
        z: picture?.z,
        target,
        picture,
      })),
    );
    for (const { target, picture } of pictures) {
      const picturePath = spritePathAt(picture, t);
      const asset = picturePath ? assets.get(picturePath) : null;
      const bitmap = bitmapAt(asset, t, picture.frame);
      if (!bitmap) {
        continue;
      }
      drawPicture(
        ctx,
        picture,
        bitmap,
        { width, height },
        target === "background" ? "cover" : "contain",
        null,
        scratchFor,
        metrics,
        ambient,
        perspective,
        shadeOf(picture, bitmap, target),
      );
    }

    // 视频画面用 `object-fit: contain`，与 `.stage__video` 的样式一致。
    for (const [picture, frame] of frames) {
      drawPicture(
        ctx,
        picture,
        frame.element,
        { width, height },
        "contain",
        { width: frame.width, height: frame.height },
        scratchFor,
        metrics,
        ambient,
        perspective,
      );
    }

    // 粒子在视频之上、对话盒之下，与舞台的层序一致。
    for (const [target, effect] of groups.effects) {
      if (effect && typeof effect === "object") {
        effects.draw(ctx, target, effect, t);
      }
    }

    // 文字层在粒子之上、对话盒之下，与 `.stage__layer--text` 的 z-index 一致。
    for (const [, item] of groups.texts) {
      drawText(ctx, item, { width, height }, ambient, perspective);
    }

    // 灯层在文字之上、对话盒之下，与 `.stage__layer--light` 一致。
    paintLightLayer(groups, t);

    const text = typeof groups.dialogue?.text === "string" ? groups.dialogue.text : "";
    if (text !== measuredText) {
      measuredText = text;
      textWidths.clear();
    }
    // The stage picks its slot from the name alone, so the frame does too.
    const slot = groups.dialogue?.name ? "dialog" : "narration";
    const platePainted = Boolean(plate && hasPlate(plate, slot));
    if (platePainted) {
      ctx.save();
      const fitted = plateScale(plate, width, height);
      ctx.scale(fitted, fitted);
      // Over the frame, not over a fresh canvas: `clear` stays false.
      drawPlate(ctx, plate, assets, slot, false);
      ctx.restore();
    }
    drawDialogue(ctx, groups.dialogue, { width, height }, measureText, plate, platePainted);

    // 参考线在坐标轴之下：与舞台的 `.stage__guideline` 同一套几何。
    if (groups.guideline?.value === true) {
      paintGuideline(ctx, {
        size: { width, height },
        interval: groups.guideline.interval,
        perspective,
      });
    }

    // 坐标轴是盖在最上面的调试层：与舞台的 `.stage__axes` 同一套画法。
    paintAxes(ctx, axesFramesOf(groups), { size: { width, height } });

    // `stage.pamela()`：与真舞台共用一份时间线，逐帧现算，盖住整个镜头。
    if (groups.pamelaIntro) {
      const intro = groups.pamelaIntro;
      drawPamelaIntro(
        ctx,
        { width, height },
        pamelaIntroState(t - (Number(intro.start) || 0), Number(intro.total) || 3000),
      );
    }
    ctx.restore();
    return canvas;
  }

  return {
    canvas,
    /**
     * 画出 t 时刻的一帧；返回同一个 canvas，供 `new VideoFrame(canvas)` 用。
     *
     * 有可见视频时返回 Promise（取帧要等 seek），否则同步返回，纯图片的
     * 导出路径与从前一样。
     */
    render(state, t = 0) {
      const groups = classifyState(state);
      if (!video || groups.videos.length === 0) {
        const signature = staticFrameSignature(groups, state);
        const reuse = signature !== null && signature === lastStaticSignature;
        lastStaticSignature = signature;
        // 只跳过重画：画布内容不变，帧循环仍照常 encode + append，因此帧数、
        // 时长与音画都不变（src/mp4.rs 的 stts 是单段等长，不能少一帧；
        // 也不能重复 append 上一帧的编码字节，那会打乱 H.264 参考帧管理）。
        if (reuse) {
          metrics?.note("reuse");
        }
        const draw = () => (reuse ? canvas : paint(groups, t, []));
        // 同步路径必须保持同步：计时包装对同步函数原样返回。
        return metrics ? metrics.call("render", draw) : draw();
      }
      lastStaticSignature = null;
      const withVideo = async () => {
        const frames = [];
        for (const [target, picture] of groups.videos) {
          if (picture.visible === false || !picture.path) {
            continue;
          }
          try {
            const raw = (video.playheads?.mediaTimeAt(target, t) ?? 0) / 1000;
            let seconds = raw;
            // 循环播放按素材长度取余，否则会停在最后一帧。
            if (raw > 0 && video.playheads?.loopsAt?.(target, t)) {
              const loaded = await video.frames.load(picture.path);
              const length = Number(loaded?.duration) || 0;
              if (length > 0) {
                seconds = raw % length;
              }
            }
            const frame = metrics
              ? await metrics.call("seek", () => video.frames.seek(picture.path, seconds))
              : await video.frames.seek(picture.path, seconds);
            if (frame) {
              frames.push([picture, frame]);
            }
          } catch {
            // 读不出来 / 解不开就跳过这一层，与缺图一致。
          }
        }
        return paint(groups, t, frames);
      };
      return metrics ? metrics.call("render", withVideo) : withVideo();
    },
  };
}
