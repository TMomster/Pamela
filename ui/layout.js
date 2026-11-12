// 资源面板的尺寸计算。
// Pamela — resource panel sizing.
/**
 * Default width of the resource panel, in CSS pixels. Kept in step with the
 * `--pamela-resource-width` fallback in `styles/app.css`.
 */

export const DEFAULT_RESOURCE_WIDTH = 240;

/** Dragging is clamped so neither panel can be collapsed by accident. */
export const MIN_RESOURCE_WIDTH = 160;

export function clampResourceWidth(width, viewportWidth, {
  min = MIN_RESOURCE_WIDTH,
  reserve = 360,
} = {}) {
  const rounded = Math.round(Number.isFinite(width) ? width : DEFAULT_RESOURCE_WIDTH);

  // Always leave room for the editor, but never let the floor exceed the
  // ceiling on a very narrow window.
  const ceiling = Math.max(min, viewportWidth - reserve);
  return Math.min(Math.max(rounded, min), ceiling);
}

/**
 * Computes the resource panel width for a drag that started at
 * `startWidth` when the pointer started at `startX` and is now at `x`.
 *
 * The pointer offset is used directly because the splitter sits immediately
 * right of the panel, so a delta of the pointer equals a delta of the width.
 */
export function widthFromDrag(startWidth, startX, x, viewportWidth, limits) {
  const delta = (Number.isFinite(x) ? x : startX) - startX;
  return clampResourceWidth(startWidth + delta, viewportWidth, limits);
}
