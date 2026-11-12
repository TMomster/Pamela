// 对话框底板的共享绘制。
// Pamela — the one plate painter, used by both the stage and the designer.

/**
 * The style set `slot` names, or the document itself when it holds just one.
 *
 * Both `dialog.js` and `dialog-editor.js` read a style this way, so a document
 * written by the designer and the same document handed to the runtime pick the
 * very same layers.
 *
 * @param {object} doc A document with `styles`, or one style set on its own.
 * @param {"dialog" | "narration"} [slot]
 * @returns {object}
 */
export function styleFor(doc, slot = doc?.active) {
  if (!doc) {
    return {};
  }
  if (!doc.styles) {
    return doc;
  }
  return doc.styles[slot] ?? doc.styles.dialog ?? {};
}

/** The layers of one slot that would actually be painted. */
export function plateLayers(doc, slot) {
  return (styleFor(doc, slot)?.layers ?? []).filter((layer) => layer.visible !== false);
}

/** Whether a slot has a plate of its own, rather than needing a stand-in. */
export function hasPlate(doc, slot) {
  return plateLayers(doc, slot).length > 0;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

/**
 * Lays a rotated layer's frame onto the canvas, so the caller draws in the
 * layer's own unrotated box and the rotation is applied around its centre.
 */
function withLayerTransform(ctx, layer) {
  ctx.save();
  ctx.globalAlpha = clamp01(layer.opacity ?? 1);
  if (layer.rotation) {
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
}

/** Rounds a rectangle, or falls back to a plain one where `roundRect` is absent. */
function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(Math.abs(radius) || 0, Math.abs(width) / 2, Math.abs(height) / 2);
  if (!r) {
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    return;
  }
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** Lays a polygon's vertices onto the context, closed back to the first one. */
function polygonPath(ctx, layer) {
  const points = layer.points ?? [];
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.closePath();
}

/** Strokes a layer's outline when it has one of any width. */
function strokeLayer(ctx, layer) {
  const width = layer.stroke?.width ?? 0;
  if (width <= 0 || !layer.stroke?.color) {
    return;
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = layer.stroke.color;
  ctx.stroke();
}

/** Draws one layer. Images come from `images`, keyed by their source path. */
function drawLayer(ctx, layer, images) {
  withLayerTransform(ctx, layer);

  if (layer.type === "rect") {
    roundedRectPath(ctx, layer.x, layer.y, layer.width, layer.height, layer.radius ?? 0);
    if (layer.fill) {
      ctx.fillStyle = layer.fill;
      ctx.fill();
    }
    strokeLayer(ctx, layer);
  } else if (layer.type === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      layer.x + layer.width / 2,
      layer.y + layer.height / 2,
      Math.abs(layer.width) / 2,
      Math.abs(layer.height) / 2,
      0,
      0,
      Math.PI * 2,
    );
    if (layer.fill) {
      ctx.fillStyle = layer.fill;
      ctx.fill();
    }
    strokeLayer(ctx, layer);
  } else if (layer.type === "polygon") {
    polygonPath(ctx, layer);
    if (layer.fill) {
      ctx.fillStyle = layer.fill;
      ctx.fill();
    }
    strokeLayer(ctx, layer);
  } else if (layer.type === "line") {
    ctx.beginPath();
    ctx.moveTo(layer.x, layer.y);
    // A line is its box's diagonal, so width and height are its run and rise.
    ctx.lineTo(layer.x + layer.width, layer.y + layer.height);
    ctx.lineWidth = Math.max(layer.thickness ?? 1, 0);
    ctx.strokeStyle = layer.color ?? "#ffffff";
    ctx.lineCap = "round";
    ctx.stroke();
  } else if (layer.type === "image") {
    const bitmap = images?.get(layer.source);
    if (bitmap) {
      ctx.drawImage(bitmap, layer.x, layer.y, layer.width, layer.height);
    }
  }

  ctx.restore();
}

/**
 * Draws the whole plate of one slot.
 *
 * The stage calls this on its own canvas with the style file's layers, and the
 * designer calls it on the plate it edits. There is no baked bitmap between
 * them: what the author draws is what the player sees.
 *
 * @param {CanvasRenderingContext2D} ctx A context sized to `doc.canvas`.
 * @param {object} doc A document, or a style set on its own.
 * @param {Map<string, CanvasImageSource>} [images] Decoded bitmaps by path.
 * @param {"dialog" | "narration"} [slot] Which slot to draw.
 * @param {boolean} [clear] Erase the canvas first. The stage and the designer
 *   own a plate-only canvas and want this; the export painter lays the plate
 *   over a frame it has already drawn and passes false.
 */
export function draw(ctx, doc, images, slot = doc?.active, clear = true) {
  const width = doc?.canvas?.width ?? ctx.canvas?.width ?? 0;
  const height = doc?.canvas?.height ?? ctx.canvas?.height ?? 0;
  if (clear) {
    ctx.clearRect(0, 0, width, height);
  }
  for (const layer of plateLayers(doc, slot)) {
    drawLayer(ctx, layer, images);
  }
}
