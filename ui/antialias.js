// 位图抗锯齿：两档柔化 —— 整张图，或只柔化轮廓那一条过渡带。
// Pamela — bitmap anti-aliasing: the whole picture, or only its edge.
//
// 舞台与导出都走这里：舞台把结果换成元素显示的那一张位图（见 `stage.js` 的
// `applyAntialias`），导出在画之前处理一次并缓存（见 `export-render.js`），
// 两边用的是同一套像素，观感才不会分叉。
//
// 强度是 0–2 的浮点：0 表示关，往上越来越软。半径按源位图的像素算（不是舞台
// 逻辑像素），这样同一张图在预览和成片里软的是同一个地方。

/** 强度的上限。2 档约 6 个源像素的半径。 */
export const ANTIALIAS_MAX = 2;

/** 强度 1 对应的半径，单位是源位图的像素。 */
const RADIUS_PER_STRENGTH = 3;

/**
 * 读一处抗锯齿强度：必须是 0–2 的有限数，超界按边界夹取。
 *
 * @param {string} kind 报错时用的名字（`抗锯齿` / `边缘抗锯齿`）。
 * @param {unknown} value
 * @returns {number} 0–2。
 */
export function antialiasAmount(kind, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${kind}强度需要 0–2 的数字`);
  }
  return Math.min(ANTIALIAS_MAX, Math.max(0, number));
}

/**
 * 强度换算成的模糊半径（源位图像素）。0 就是 0：这一步整个跳过。
 *
 * @param {unknown} strength
 * @returns {number}
 */
export function antialiasRadius(strength) {
  const number = Number(strength);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.min(ANTIALIAS_MAX, number) * RADIUS_PER_STRENGTH;
}

/**
 * 这组强度要不要处理位图。
 *
 * @param {{ smooth?: unknown, edges?: unknown }} modes `smooth` 是整图，`edges` 是边缘。
 * @returns {boolean}
 */
export function antialiasIsOn(modes) {
  return antialiasRadius(modes?.smooth) > 0 || antialiasRadius(modes?.edges) > 0;
}

/**
 * 处理一张位图，交出一张同样大小的画布。
 *
 * **整图**（`smooth`）：整张图连着内部一起做一次低通，阶梯、噪点与压缩块都
 * 软掉。**边缘**（`edges`）：颜色一个像素都不动，只把 alpha 的过渡带摊平 ——
 * 轮廓上的锯齿没了，脸和字仍然是清楚的。两档都写时按整图算，半径取大的那个：
 * 整图那一档本来就把边缘包含在内了。
 *
 * 模糊会让 alpha 往画布边界外面渗，所以画布四周留了一圈 `pad`，画完再把中间
 * 那一块裁回来，交出去的仍是原图的尺寸 —— 调用方不必关心这件事。
 *
 * 拿不到画布或像素时交出 `null`，调用方按「没处理」继续画：一张图画不软不该
 * 让整帧失败。
 *
 * @param {CanvasImageSource & { width?: number, height?: number }} source
 * @param {number} width 源位图的宽（像素）。
 * @param {number} height 源位图的高（像素）。
 * @param {{ smooth?: unknown, edges?: unknown }} modes 两档强度，0–2。
 * @param {(width: number, height: number) => object | null} createCanvas
 *   建离屏画布，由调用方提供（舞台与导出各有各的复用方式）。
 * @returns {{ canvas: object, width: number, height: number } | null}
 */
export function antialiasBitmap(source, width, height, modes, createCanvas) {
  if (typeof createCanvas !== "function") {
    return null;
  }
  const smooth = antialiasRadius(modes?.smooth);
  const edges = antialiasRadius(modes?.edges);
  const radius = Math.max(smooth, edges);
  if (!(radius > 0)) {
    return null;
  }
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  if (!(Number(width) > 0) || !(Number(height) > 0)) {
    return null;
  }
  // 模糊的半径有几像素，边上就要留几像素，不然最外一圈会被自己的模糊掏空。
  const pad = Math.ceil(radius) + 2;
  const padded = createCanvas(w + pad * 2, h + pad * 2);
  const context = padded?.getContext?.("2d") ?? null;
  if (!context) {
    return null;
  }
  try {
    if (smooth > 0) {
      // 整图：一张画布，一遍模糊，连内部一起软掉。两档都在时按大的那个取半径
      // —— 整图那一档本来就把轮廓包含在内了。
      context.filter = `blur(${radius.toFixed(2)}px)`;
      context.drawImage(source, pad, pad, w, h);
      context.filter = "none";
    } else {
      // 边缘：原图铺底，只把 alpha 换成模糊过的那一份，颜色留在原处。
      context.drawImage(source, pad, pad, w, h);
      const mask = createCanvas(w + pad * 2, h + pad * 2);
      const maskContext = mask?.getContext?.("2d") ?? null;
      if (!maskContext || typeof context.getImageData !== "function") {
        // 拿不到第二张画布（或读不到像素）就只做不了这一档，交出原图。
        return crop(padded, pad, w, h, createCanvas);
      }
      maskContext.filter = `blur(${edges.toFixed(2)}px)`;
      maskContext.drawImage(source, pad, pad, w, h);
      maskContext.filter = "none";
      const frame = context.getImageData(pad, pad, w, h);
      const soft = maskContext.getImageData(pad, pad, w, h);
      const pixels = frame?.data;
      const alphas = soft?.data;
      if (!pixels || !alphas) {
        return crop(padded, pad, w, h, createCanvas);
      }
      // 只换 alpha：过渡带摊平了，内部（alpha 已是 1）与颜色都不动。
      for (let index = 3; index < pixels.length; index += 4) {
        pixels[index] = alphas[index];
      }
      context.putImageData(frame, pad, pad);
    }
    return crop(padded, pad, w, h, createCanvas);
  } catch {
    // 被污染的画布、还没解码完的位图：都当作没处理。
    return null;
  }
}

/** 把留了边的那张裁回原图的尺寸。 */
function crop(padded, pad, width, height, createCanvas) {
  const canvas = createCanvas(width, height);
  const context = canvas?.getContext?.("2d") ?? null;
  if (!context) {
    return null;
  }
  context.drawImage(padded, pad, pad, width, height, 0, 0, width, height);
  return { canvas, width, height };
}
