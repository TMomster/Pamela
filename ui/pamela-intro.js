// `stage.pamela()` 的开场动画：黑幕、图标左移、文字展开、整体淡出。
// Pamela — the opening animation shared by the live stage and the MP4 export.
//
// 这里只放与时间有关的状态和一套「把某一刻画出来」的函数。舞台用 canvas 画在
// 最上层，导出逐帧用同一个函数画到离屏画布，因此两边看到的动画完全一致。

/** 整段动画的时长。 */
export const PAMELA_INTRO_MS = 3000;

/** 图标右侧显示的文字。 */
export const PAMELA_INTRO_TEXT = "Made with Pamela";

/** `icons/flower_icon.svg` 的花形，按原色（白花、黑心）绘制。 */
export const PAMELA_ICON_PATH =
  "M264,124a59.93,59.93,0,0,0-68.1-59.44,60,60,0,0,0-119.79,0A60,60,0,0,0,38.74,176.38," +
  "60,60,0,0,0,136,244.78a60,60,0,0,0,97.26-68.4A60,60,0,0,0,264,124Zm-119.9,3.44a59.63," +
  "59.63,0,0,0,6.64,24.18A60.23,60.23,0,0,0,136,163.22a60.23,60.23,0,0,0-14.74-11.6," +
  "59.63,59.63,0,0,0,6.64-24.18,58.92,58.92,0,0,0,16.21,0Z";

/** 花心的圆，与 SVG 的 `circle` 同一组数（viewBox 为 272×272）。 */
export const PAMELA_ICON_CENTER = Object.freeze({ x: 136, y: 144, r: 42 });

/** 图标停下的位置，以画幅宽度为单位。 */
const ICON_START_X = 0.5;
const ICON_END_X = 0.35;
/** 文字左边缘相对图标中心再向右让出的比例。 */
const TEXT_GAP_X = 0.045;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** 一次 0–1 的线性推进。 */
function ramp(t, start, end) {
  return clamp01((t - start) / (end - start));
}

/** 图标左移用三次缓出，到位后停住。 */
function easeOut(x) {
  return 1 - (1 - x) ** 3;
}

/**
 * 某一刻的画面状态。
 *
 * 位置全部是画幅宽高的比例，与具体分辨率无关；`overall` 是整块覆盖层的
 * 透明度，黑幕淡入与最后的整幅淡出是两个独立阶段。
 *
 * @param {number} elapsed 从动画开始算起的毫秒数。
 * @param {number} [total] 动画总时长，默认 3000 毫秒。
 */
export function pamelaIntroState(elapsed, total = PAMELA_INTRO_MS) {
  const span = Number(total) > 0 ? Number(total) : PAMELA_INTRO_MS;
  const scale = span / PAMELA_INTRO_MS;
  const t = Math.min(span, Math.max(0, Number(elapsed) || 0));
  const at = (start, end) => ramp(t, start * scale, end * scale);

  const black = at(0, 400);
  const icon = at(350, 850);
  const move = easeOut(at(850, 1450));
  const iconX = ICON_START_X + (ICON_END_X - ICON_START_X) * move;
  const reveal = at(1450, 2150);
  const text = at(1450, 1750);
  const overall = 1 - at(2450, 3000);

  return {
    black,
    icon,
    iconX,
    textX: iconX + TEXT_GAP_X,
    text,
    reveal,
    overall,
    done: t >= span,
  };
}

/** SVG 的 path 只建一次，Node 下没有 `Path2D` 时跳过图形本身。 */
let iconPath = null;
function iconPath2D() {
  if (!iconPath && typeof Path2D === "function") {
    iconPath = new Path2D(PAMELA_ICON_PATH);
  }
  return iconPath;
}

/**
 * 把某一刻的开场动画画在一张已经铺满画幅的画布上。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, height: number }} size 逻辑画幅尺寸。
 * @param {ReturnType<typeof pamelaIntroState>} state
 */
export function drawPamelaIntro(ctx, size, state) {
  if (!ctx || !state || state.overall <= 0) {
    return;
  }
  const width = Number(size?.width) || 1920;
  const height = Number(size?.height) || 1080;
  ctx.save();
  ctx.globalAlpha = state.overall;
  ctx.filter = "none";

  if (state.black > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${state.black})`;
    ctx.fillRect(0, 0, width, height);
  }

  const iconSize = width * 0.05;
  if (state.icon > 0) {
    ctx.save();
    ctx.globalAlpha *= state.icon;
    ctx.translate(width * state.iconX - iconSize / 2, height / 2 - iconSize / 2);
    ctx.scale(iconSize / 272, iconSize / 272);
    const path = iconPath2D();
    if (path) {
      ctx.fillStyle = "#ffffff";
      ctx.fill(path);
    }
    ctx.beginPath();
    ctx.arc(PAMELA_ICON_CENTER.x, PAMELA_ICON_CENTER.y, PAMELA_ICON_CENTER.r, 0, Math.PI * 2);
    ctx.fillStyle = "#000000";
    ctx.fill();
    ctx.restore();
  }

  if (state.text > 0 && state.reveal > 0 && typeof ctx.measureText === "function") {
    ctx.save();
    ctx.globalAlpha *= state.text;
    const fontSize = width * 0.0333;
    ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
    ctx.textBaseline = "middle";
    const left = width * state.textX;
    const length = ctx.measureText(PAMELA_INTRO_TEXT).width;
    ctx.beginPath();
    ctx.rect(left, 0, Math.max(0, length * state.reveal), height);
    ctx.clip();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(PAMELA_INTRO_TEXT, left, height / 2);
    ctx.restore();
  }

  ctx.restore();
}
