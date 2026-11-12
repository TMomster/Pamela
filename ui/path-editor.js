// 关键帧编辑器。
// Pamela — the key frame editor.
// 预览播放始终从当前关键帧组首帧开始，起点取 `path.start`。

import {
  buildPathFile,
  frameAt,
  keyframesOf,
  normalizePath,
  pathDuration,
  pathFileFor,
  pathFromKeyframes,
  pointAt,
  samplePath,
  sampleSegment,
  segmentControls,
  segmentFromLink,
} from "./path.js";
import { openContextMenu } from "./context-menu.js";
import { createIcon } from "./icons.js";
import { STAGE_HEIGHT, STAGE_WIDTH } from "./stage.js";

/** How close, in per-cent of the frame, a pointer has to be to grab a point. */
const GRAB_PERCENT = 1.6;

/** How far a freehand sample has to stray before it counts as a new point. */
const FREEHAND_TOLERANCE = 0.6;

/** How close, in per-cent of the frame, the pointer has to be to the drawn line. */
const LINE_GRAB_PERCENT = 1.1;

/** How many samples one run is measured at when the pointer is looking for it. */
const LINE_HIT_STEPS = 16;

/** How far, in stage units, the pointer must travel before a press bends a line. */
const BEND_DEAD_ZONE = 3;

/** How close, in stage units, a pointer has to be to take hold of a handle. */
const HANDLE_HIT = 18;

/** How close, in stage units, a pointer has to be to grab a bend point or frame. */
const POINT_HIT = 22;

/** How close, in stage units, a right-click has to be to a connection line. */
const LINE_HIT = 28;

/**
 * 旋转手柄相对轮廓上缘的偏移量。
 */
const ROTATE_GAP = 46;

/** The outline's size when no object box is available to measure. */
const FALLBACK_BOX = { width: STAGE_WIDTH / 5, height: STAGE_HEIGHT / 3 };

/** The duration a newly committed frame's connection gets, in ms. */
const DEFAULT_LINK_TIME = 1000;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Builds an SVG element, falling back to a plain element where the namespace
 * call is unavailable — the stand-ins the node tests build have no
 * `createElementNS`, and the editor must still be construction-safe there.
 */
const createSvg = (name) =>
  typeof document.createElementNS === "function"
    ? document.createElementNS(SVG_NS, name)
    : document.createElement(name);

/** The frame clock, when there is one; a preview does not run without it. */
const raf =
  typeof requestAnimationFrame === "function" ? (step) => requestAnimationFrame(step) : null;
const cancelRaf =
  typeof cancelAnimationFrame === "function"
    ? (id) => cancelAnimationFrame(id)
    : () => {};

/** The clock the preview is measured against. */
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The SVG view box the drawing is laid out in.
 *
 * It is the stage's own space: the origin is the centre of the 1920×1080
 * frame and y points down, because the drawing code flips y (`-y`) as it writes
 * each point. A box starting at `0 0` would put the stage's centre at the
 * picture's top-left corner — the stage coordinate (0, 0) would draw in the
 * corner — which is exactly the mismatch between the layer and the picture.
 *
 * Kept as a function so the two coordinate systems can be checked against each
 * other in a test rather than manually.
 *
 * @returns {string} For example `-960 -540 1920 1080`.
 */
export function pathViewBox() {
  return `${-STAGE_WIDTH / 2} ${-STAGE_HEIGHT / 2} ${STAGE_WIDTH} ${STAGE_HEIGHT}`;
}

/**
 * Stage coordinates to a position in the frame, as CSS percentages.
 *
 * The frame is centred on the origin with y up, so a point's `top` is measured
 * downward from the middle and its sign is flipped here — the one place the two
 * conventions meet.
 *
 * @param {number} x Stage units right of the centre.
 * @param {number} y Stage units above the centre.
 * @returns {{ left: number, top: number }} Percentages of the frame.
 */
export function stageToPercent(x, y) {
  return {
    left: 50 + (x / STAGE_WIDTH) * 100,
    top: 50 - (y / STAGE_HEIGHT) * 100,
  };
}

/**
 * The same stage point as a fraction of the SVG's own box.
 *
 * It reads the box back from `pathViewBox` rather than assuming it, so this and
 * the drawn layer cannot drift apart: if the box is ever changed, the check
 * that the two systems agree fails instead of quietly comparing a constant
 * against itself.
 *
 * @param {number} x
 * @param {number} y
 * @returns {{ left: number, top: number }} Fractions, 0–1.
 */
export function stageToViewBox(x, y) {
  const [minX, minY, width, height] = pathViewBox().split(" ").map(Number);
  return {
    left: (x - minX) / width,
    top: (-y - minY) / height,
  };
}

/**
 * A position in the frame, as percentages, back to stage coordinates.
 *
 * @param {number} left Percentage from the left edge.
 * @param {number} top Percentage from the top edge.
 * @returns {{ x: number, y: number }}
 */
export function percentToStage(left, top) {
  return {
    x: ((left - 50) / 100) * STAGE_WIDTH,
    y: ((50 - top) / 100) * STAGE_HEIGHT,
  };
}

/**
 * The point of `segment` nearest `(x, y)`, if one is close enough to grab.
 *
 * The grab radius is given in per-cent of the frame so it stays the same size
 * on screen whatever the window — a handle is grabbed with a pointer, not with
 * the picture's own units.
 *
 * @param {{ points: [number, number][] }} segment
 * @param {number} x Stage units.
 * @param {number} y Stage units.
 * @param {number} [radius] Per-cent of the frame.
 * @returns {number} The point's index, or -1.
 */
export function hitPoint(segment, x, y, radius = GRAB_PERCENT) {
  const points = segment?.points ?? [];
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const at = stageToPercent(points[index][0], points[index][1]);
    const here = stageToPercent(x, y);
    const distance = Math.hypot(at.left - here.left, at.top - here.top);
    if (distance <= radius && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Inserts a point into a segment at `index`, keeping the list flat.
 *
 * @param {{ points: [number, number][] }} segment
 * @param {number} index Where to insert; the end by default.
 * @param {number} x
 * @param {number} y
 * @returns {[number, number][]} The new point list.
 */
export function insertPoint(segment, index, x, y) {
  const points = (segment?.points ?? []).map((p) => [p[0], p[1]]);
  const at = Number.isInteger(index) && index >= 0 && index <= points.length ? index : points.length;
  points.splice(at, 0, [x, y]);
  return points;
}

/**
 * Removes the point at `index`, protecting the last one.
 *
 * @param {{ points: [number, number][] }} segment
 * @param {number} index
 * @returns {[number, number][]}
 */
export function removePoint(segment, index) {
  const points = (segment?.points ?? []).map((p) => [p[0], p[1]]);
  if (points.length <= 1 || index < 0 || index >= points.length) {
    return points;
  }
  points.splice(index, 1);
  return points;
}

/**
 * Drops the points a freehand stroke does not need (Ramer–Douglas–Peucker).
 *
 * @param {[number, number][]} points
 * @param {number} [tolerance] Stage units.
 * @returns {[number, number][]} At least two points when the input had two.
 */
export function simplifyFreehand(points, tolerance = FREEHAND_TOLERANCE) {
  if (!Array.isArray(points) || points.length <= 2) {
    return (points ?? []).map((p) => [p[0], p[1]]);
  }

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const distance = (point, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      return Math.hypot(point[0] - a[0], point[1] - a[1]);
    }
    return Math.abs(dy * point[0] - dx * point[1] + b[0] * a[1] - b[1] * a[0]) / length;
  };

  const walk = (from, to) => {
    let worst = -1;
    let worstDistance = 0;
    for (let index = from + 1; index < to; index += 1) {
      const off = distance(points[index], points[from], points[to]);
      if (off > worstDistance) {
        worst = index;
        worstDistance = off;
      }
    }
    if (worst !== -1 && worstDistance > tolerance) {
      keep[worst] = true;
      walk(from, worst);
      walk(worst, to);
    }
  };
  walk(0, points.length - 1);

  const kept = points.filter((_, index) => keep[index]);
  return kept.length >= 2 ? kept : [points[0], points[points.length - 1]];
}

/**
 * The control point of a curve nearest `(x, y)`, if one is close enough to grab.
 *
 * @param {{ type: string, points: [number, number][], control?: [number, number][][] | null }} segment
 * @param {number} x Stage units.
 * @param {number} y Stage units.
 * @param {number} [radius] Per-cent of the frame.
 * @returns {{ run: number, side: number } | null}
 */
export function hitControl(segment, x, y, radius = GRAB_PERCENT) {
  if (segment?.type !== "curve") {
    return null;
  }
  const pairs = curveHandles(segment);
  const here = stageToPercent(x, y);
  let best = null;
  let bestDistance = Infinity;
  pairs.forEach((pair, run) => {
    pair.forEach(([cx, cy], side) => {
      const at = stageToPercent(cx, cy);
      const distance = Math.hypot(at.left - here.left, at.top - here.top);
      if (distance <= radius && distance < bestDistance) {
        best = { run, side };
        bestDistance = distance;
      }
    });
  });
  return best;
}

/**
 * The point opposite `point` about `centre`.
 *
 * This is what "symmetric" means for a pair of handles: the two sides of a
 * cubic sit at equal distances from the middle of its chord, so moving one
 * moves the other to the mirrored spot.
 *
 * @param {{ x: number, y: number }} point
 * @param {{ x: number, y: number }} centre
 * @returns {{ x: number, y: number }}
 */
export function mirrorPoint(point, centre) {
  const x = Number(point?.x) || 0;
  const y = Number(point?.y) || 0;
  const cx = Number(centre?.x) || 0;
  const cy = Number(centre?.y) || 0;
  return { x: 2 * cx - x, y: 2 * cy - y };
}

/**
 * Moves one bend and, when asked, its partner on the other side of the link.
 *
 * A link with two bends has two sides; dragging one with the mirror on drags
 * its counterpart about the link's chord midpoint, so an S-curve stays an
 * S-curve instead of needing two separate drags. A single bend has no partner
 * and simply moves. The middle bend of three is its own partner, so it moves
 * alone.
 *
 * @param {{ x: number, y: number }[]} bends
 * @param {number} index Which bend the pointer holds.
 * @param {{ x: number, y: number }} to Where it went.
 * @param {{ x: number, y: number }} centre The chord's midpoint.
 * @returns {{ x: number, y: number }[]} A new list; the input is untouched.
 */
export function mirrorBends(bends, index, to, centre) {
  const list = Array.isArray(bends)
    ? bends.map((bend) => ({ x: Number(bend?.x) || 0, y: Number(bend?.y) || 0 }))
    : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return list;
  }
  const held = { x: Number(to?.x) || 0, y: Number(to?.y) || 0 };
  list[index] = held;
  const partner = list.length - 1 - index;
  if (partner !== index) {
    list[partner] = mirrorPoint(held, centre);
  }
  return list;
}

/**
 * The point a path has reached, measured from where the object actually is.
 *
 * The runtime plays a key relative to the object's current position
 * (`stage.js`: `shiftX = entry.x - path.start.x`), because a script may have
 * moved the object since the animation was drawn. The editor's 预览播放 used to
 * apply `pointAt` absolutely, so its preview started at the number in the file
 * rather than at the object on screen. This is the same shift, as a pure
 * function, so preview and performance agree.
 *
 * `origin` must be read once, before the walk begins: `applyPreviewState`
 * moves the object on every frame, and re-reading it would make the shift chase
 * the object and drift outwards.
 *
 * @param {object} path From `pathFromKeyframes`.
 * @param {number} elapsed Milliseconds since the walk started.
 * @param {{ x: number, y: number } | null} [origin] The object's true centre.
 * @returns {{ x: number, y: number, done: boolean }}
 */
export function shiftedPointAt(path, elapsed, origin = null) {
  const at = pointAt(path, elapsed);
  const start = path?.start ?? { x: 0, y: 0 };
  const baseX = Number(start.x) || 0;
  const baseY = Number(start.y) || 0;
  const fromX = Number(origin?.x);
  const fromY = Number(origin?.y);
  const shiftX = (Number.isFinite(fromX) ? fromX : baseX) - baseX;
  const shiftY = (Number.isFinite(fromY) ? fromY : baseY) - baseY;
  return { x: at.x + shiftX, y: at.y + shiftY, done: at.done };
}

/**
 * Moves one control point of a curve and records it on the segment.
 *
 * `symmetric` is the opt-in "lock both sides" drag: the handle that was not
 * grabbed moves to the mirror of the one that was, about the run's chord
 * midpoint. The default keeps the old behaviour — one side moves, the other
 * holds — because that is what an author expects from a free handle.
 *
 * @param {object} segment The segment being edited; changed in place.
 * @param {{ run: number, side: number }} grip From `hitControl`.
 * @param {{ x: number, y: number }} to Stage units.
 * @param {{ symmetric?: boolean }} [options]
 */
export function applyControlDrag(segment, grip, to, { symmetric = false } = {}) {
  if (segment?.type !== "curve" || !grip) {
    return;
  }
  const pairs = curveHandles(segment).map((pair) => [
    [pair[0][0], pair[0][1]],
    [pair[1][0], pair[1][1]],
  ]);
  const pair = pairs[grip.run];
  if (!pair) {
    return;
  }
  pair[grip.side] = [to.x, to.y];
  if (symmetric) {
    const points = segment?.points ?? [];
    const from = points[grip.run * 2];
    const end = points[grip.run * 2 + 2];
    if (from && end) {
      const centre = { x: (from[0] + end[0]) / 2, y: (from[1] + end[1]) / 2 };
      const mirrored = mirrorPoint(to, centre);
      pair[grip.side === 0 ? 1 : 0] = [mirrored.x, mirrored.y];
    }
  }
  segment.control = pairs;
}

/**
 * The control points of a curve segment, for drawing its handles.
 *
 * @param {{ points: [number, number][], control?: [number, number][][] | null }} segment
 * @returns {[[number, number], [number, number]][]} One pair per cubic.
 */
export function curveHandles(segment) {
  return segment?.type === "curve" ? segmentControls(segment) : [];
}

/** One point on the cubic `p0 → c1 → c2 → p1` at `t`, 0 to 1. */
function cubicPoint(p0, [c1, c2], p1, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

/**
 * The piece of `segment` whose drawn line passes nearest `(x, y)`.
 *
 * @param {{ type: string, points: [number, number][], control?: [number, number][][] | null }} segment
 * @param {number} x Stage units.
 * @param {number} y Stage units.
 * @param {number} [radius] Per-cent of the frame.
 * @returns {{ run: number, t: number } | null}
 */
export function hitLine(segment, x, y, radius = LINE_GRAB_PERCENT) {
  const points = segment?.points ?? [];
  if (points.length < 2) {
    return null;
  }
  const curve = segment.type === "curve" && points.length >= 3;
  const controls = curve ? segmentControls(segment) : [];
  const runs = curve
    ? Math.max(0, Math.floor((points.length - 1) / 2))
    : points.length - 1;
  const here = stageToPercent(x, y);
  let best = null;
  let bestDistance = Infinity;

  for (let run = 0; run < runs; run += 1) {
    const from = points[curve ? run * 2 : run];
    const to = points[curve ? run * 2 + 2 : run + 1];
    const pair = curve ? controls[run] ?? [points[run * 2 + 1], points[run * 2 + 1]] : null;
    for (let step = 0; step <= LINE_HIT_STEPS; step += 1) {
      const t = step / LINE_HIT_STEPS;
      const at = pair
        ? cubicPoint(from, pair, to, t)
        : [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const screen = stageToPercent(at[0], at[1]);
      const distance = Math.hypot(screen.left - here.left, screen.top - here.top);
      if (distance <= radius && distance < bestDistance) {
        best = { run, t };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/**
 * Prepares `segment` so the grabbed stretch can be bent.
 *
 * @param {{ type: string, points: [number, number][], control?: [number, number][][] | null }} segment
 * @param {{ run: number, t: number }} grip From {@link hitLine}.
 * @returns {{ run: number, t: number } | null} The grip, now on a cubic.
 */
export function beginBend(segment, grip) {
  const points = segment?.points ?? [];
  if (!grip || points.length < 2) {
    return null;
  }

  if (segment.type === "curve" && points.length >= 3) {
    if (Array.isArray(segment.control) && segment.control[grip.run]) {
      const control = segment.control.slice();
      control[grip.run] = null;
      segment.control = control.some(Boolean) ? control : null;
    }
    return grip;
  }

  const expanded = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    expanded.push([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], to);
  }
  segment.points = expanded;
  segment.type = "curve";
  return grip;
}

/**
 * Bends the grabbed run so the spot the author took hold of follows the pointer.
 *
 * @param {{ type: string, points: [number, number][] }} segment Changed in place.
 * @param {{ run: number, t: number }} grip From {@link beginBend}.
 * @param {{ x: number, y: number }} to Stage units.
 */
export function dragBend(segment, grip, to) {
  const points = segment?.points ?? [];
  const run = grip?.run;
  if (segment?.type !== "curve" || !Number.isInteger(run) || run < 0) {
    return;
  }
  const from = points[run * 2];
  const end = points[run * 2 + 2];
  if (!from || !end) {
    return;
  }
  const t = Math.min(0.98, Math.max(0.02, Number(grip.t) || 0.5));
  const u = 1 - t;
  const pull = 3 * u * t;
  points[run * 2 + 1] = [
    (to.x - u * u * u * from[0] - t * t * t * end[0]) / pull,
    (to.y - u * u * u * from[1] - t * t * t * end[1]) / pull,
  ];
}

// --- the eight-handle free transform ---
//
// A handle is named by which side of the outline it sits on. The pair is the
// sign of the axis it pulls: dragging `upleft` grows the object about its
// bottom-right corner, dragging `right` stretches only the width. A corner
// scales uniformly; a side handle stretches one axis on its own ("变形").

/** The eight handles, as `(horizontal, vertical)` side signs. */
export const HANDLE_DIRECTIONS = Object.freeze({
  upleft: [-1, -1],
  up: [0, -1],
  upright: [1, -1],
  right: [1, 0],
  downright: [1, 1],
  down: [0, 1],
  downleft: [-1, 1],
  left: [-1, 0],
});

/**
 * The eight handle positions and the rotate handle, in a box's local space.
 *
 * Local y grows downward, the way the SVG's own box does. Rotation is applied
 * to the group these are drawn in, so a turned object's handles turn with it.
 *
 * @param {number} width
 * @param {number} height
 * @returns {{ handles: { name: string, x: number, y: number }[], rotate: { x: number, y: number } }}
 */
export function handlePositions(width, height) {
  const halfW = Math.abs(width) / 2;
  const halfH = Math.abs(height) / 2;
  const handles = Object.entries(HANDLE_DIRECTIONS).map(([name, [ax, ay]]) => ({
    name,
    x: ax * halfW,
    y: ay * halfH,
  }));
  return { handles, rotate: { x: 0, y: -halfH - ROTATE_GAP } };
}

/**
 * Rotates a point out of the object's local box onto the drawing plane.
 *
 * @param {{ x: number, y: number }} local
 * @param {{ x: number, y: number }} centre SVG-space centre of the object.
 * @param {number} degrees SVG's clockwise rotation.
 * @returns {{ x: number, y: number }}
 */
export function outOfBox(local, centre, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: centre.x + local.x * cos - local.y * sin,
    y: centre.y + local.x * sin + local.y * cos,
  };
}

/** The inverse of `outOfBox`: a drawing-plane point back into the local box. */
export function intoBox(point, centre, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/**
 * Which part of the object the pointer took hold of.
 *
 * Answers in priority order — the rotate handle is the smallest, most
 * deliberate target, then the eight handles, then the body. `null` means the
 * press belongs to the path (a frame marker, a bend, or empty space).
 *
 * @param {{ x: number, y: number }} pointer Stage coordinates.
 * @param {object} live The object state being edited.
 * @param {{ width: number, height: number }} box The outline's unscaled size.
 * @returns {{ kind: string, name?: string } | null}
 */
export function hitObject(pointer, live, box) {
  const centre = { x: live.x, y: -live.y };
  const width = box.width * live.scale * live.scaleX;
  const height = box.height * live.scale * live.scaleY;
  const { handles, rotate } = handlePositions(width, height);
  const at = { x: pointer.x, y: -pointer.y };

  const rotated = outOfBox(rotate, centre, live.rotation);
  if (Math.hypot(at.x - rotated.x, at.y - rotated.y) <= HANDLE_HIT) {
    return { kind: "rotate" };
  }
  for (const handle of handles) {
    const point = outOfBox(handle, centre, live.rotation);
    if (Math.hypot(at.x - point.x, at.y - point.y) <= HANDLE_HIT) {
      return { kind: "handle", name: handle.name };
    }
  }
  const local = intoBox(at, centre, live.rotation);
  if (Math.abs(local.x) <= Math.abs(width) / 2 && Math.abs(local.y) <= Math.abs(height) / 2) {
    return { kind: "move" };
  }
  return null;
}

/**
 * Applies a handle drag to an object state, about the side opposite the handle.
 *
 * A corner keeps the aspect ratio (uniform `scale`); a side handle stretches
 * just its own axis (`scaleX` / `scaleY`). The far side stays put because the
 * centre is moved by half the size change, rotated back onto the stage.
 *
 * @param {object} start The object state when the drag began.
 * @param {object} box The outline's unscaled size.
 * @param {string} name Which handle is held.
 * @param {{ x: number, y: number }} to Stage coordinates of the pointer.
 * @returns {object} A new object state.
 */
export function resizeFromHandle(start, box, name, to) {
  const direction = HANDLE_DIRECTIONS[name];
  if (!direction) {
    return { ...start };
  }
  const [ax, ay] = direction;
  const centre = { x: start.x, y: -start.y };
  const local = intoBox({ x: to.x, y: -to.y }, centre, start.rotation);
  const width0 = box.width * start.scale * start.scaleX;
  const height0 = box.height * start.scale * start.scaleY;
  // The anchor is the side opposite the handle, not the centre: that is what
  // makes a resize feel like pulling one corner of a picture frame away while
  // the far corner stays held fixed.
  const anchorX = (-ax * width0) / 2;
  const anchorY = (-ay * height0) / 2;
  const byX = ax !== 0 ? ((local.x - anchorX) * ax) / (Math.abs(width0) || 1) : 0;
  const byY = ay !== 0 ? ((local.y - anchorY) * ay) / (Math.abs(height0) || 1) : 0;

  if (ax !== 0 && ay !== 0) {
    // A corner: one uniform scale from whichever axis the pointer moved more.
    const factor = Math.max(0.05, byX, byY);
    const scale = start.scale * factor;
    // The opposite corner is the anchor: it must not move as the box grows.
    const grownW = box.width * scale * start.scaleX;
    const grownH = box.height * scale * start.scaleY;
    const shift = outOfBox(
      { x: (ax * (grownW - width0)) / 2, y: (ay * (grownH - height0)) / 2 },
      { x: 0, y: 0 },
      start.rotation,
    );
    return { ...start, scale, x: start.x + shift.x, y: start.y - shift.y };
  }

  if (ax !== 0) {
    const axis = Math.max(0.05, byX);
    const scaleX = start.scaleX * axis;
    const grownW = box.width * start.scale * scaleX;
    const shift = outOfBox(
      { x: (ax * (grownW - width0)) / 2, y: 0 },
      { x: 0, y: 0 },
      start.rotation,
    );
    return { ...start, scaleX, x: start.x + shift.x, y: start.y - shift.y };
  }
  if (ay !== 0) {
    const axis = Math.max(0.05, byY);
    const scaleY = start.scaleY * axis;
    const grownH = box.height * start.scale * scaleY;
    const shift = outOfBox(
      { x: 0, y: (ay * (grownH - height0)) / 2 },
      { x: 0, y: 0 },
      start.rotation,
    );
    return { ...start, scaleY, x: start.x + shift.x, y: start.y - shift.y };
  }
  return { ...start };
}

/**
 * Turns an object state so the pointer sits on the rotate handle.
 *
 * @param {object} start
 * @param {{ x: number, y: number }} to Stage coordinates.
 * @returns {object} A new object state.
 */
export function rotateFromHandle(start, to) {
  const dx = to.x - start.x;
  const dy = -to.y - -start.y;
  // The handle starts straight up in SVG space, which is -90° from the +x axis.
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  return { ...start, rotation: degrees };
}

/**
 * Builds the key frame editor over a mount element.
 *
 * @param {object} options
 * @param {HTMLElement} options.mount
 * @param {(message: string, kind?: "error" | "info") => void} [options.onStatus]
 * @param {(file: object) => Promise<void> | void} [options.onSave]
 * @param {() => void} [options.onClose]
 * @param {() => void} [options.onBack]
 * @param {(frame: HTMLElement, surface: HTMLElement) => object} [options.buildStage]
 * @param {() => { x: number, y: number, width: number, height: number } | null} [options.objectBox]
 */
export function createPathEditor({
  mount,
  onStatus = () => {},
  onSave = () => {},
  onClose = () => {},
  onBack = () => {},
  buildStage = null,
  objectBox = null,
}) {
  if (!mount) {
    throw new Error("关键帧编辑器需要一个挂载元素");
  }

  const node = document.createElement("div");
  node.className = "path-editor";
  node.hidden = true;

  const toolbar = document.createElement("div");
  toolbar.className = "path-editor__toolbar";

  const preview = document.createElement("div");
  preview.className = "path-editor__viewport";
  const frame = document.createElement("div");
  frame.className = "path-editor__frame";
  const surface = document.createElement("div");
  surface.className = "path-editor__surface";
  const canvas = document.createElement("div");
  canvas.className = "path-editor__canvas";
  const svg = createSvg("svg");
  svg.setAttribute("class", "path-editor__lines");
  svg.setAttribute("viewBox", pathViewBox());
  svg.setAttribute("preserveAspectRatio", "none");

  const dock = document.createElement("div");
  dock.className = "path-editor__dock";
  dock.hidden = true;
  const timeline = document.createElement("div");
  timeline.className = "path-editor__timeline";
  const framesPanel = document.createElement("div");
  framesPanel.className = "path-editor__frames";
  dock.append(timeline, framesPanel);

  frame.append(surface, canvas);
  canvas.append(svg);
  preview.append(frame);
  node.append(toolbar, preview, dock);
  mount.append(node);

  for (const type of ["click", "pointerdown", "pointerup", "dblclick", "wheel"]) {
    node.addEventListener(type, (event) => event.stopPropagation());
  }

  let previewStage = null;
  const ensureStage = () => {
    if (!previewStage && buildStage) {
      previewStage = buildStage(frame, surface);
    }
    return previewStage;
  };

  /** The key frame list, each one a complete snapshot of the object. */
  let keyframes = [];
  /** Which frame is selected; the object is drawn from `live`, a copy of it. */
  let selected = 0;
  /** The object state currently being dragged, before it is committed. */
  let live = null;
  /** Whether `live` has moved away from the frame it came from. */
  let pending = false;
  /** The drag in progress, or null. */
  let drag = null;
  /** The id and name the file is written under. */
  let fileId = "";
  let fileName = "";
  /** The object whose key this is. */
  let objectName = "";
  let timelineOpen = false;
  let dirty = false;

  const history = { past: [], future: [] };

  const readObjectBox = () => {
    if (typeof objectBox === "function") {
      return objectBox() ?? null;
    }
    if (!objectName) {
      return null;
    }
    return previewStage?.objectBox?.(objectName) ?? null;
  };

  const baseBox = () => {
    const box = readObjectBox();
    return box && Number.isFinite(box.width) && Number.isFinite(box.height)
      ? { width: Math.max(1, Math.abs(box.width)), height: Math.max(1, Math.abs(box.height)) }
      : { ...FALLBACK_BOX };
  };

  /**
   * Binds the route to the object's position without changing its shape.
   *
   * Frame 0 must start where the object stands, but the motion the author drew
   * lives in the *differences* between frames. Rebinding only frame 0 rewrites
   * those differences. In particular, `syncPreview` pushes the selected frame's
   * pose onto the preview stage, so `readObjectBox()` stops describing the
   * object's start: saving while frame 2 is selected used to drag the start down
   * onto frame 2 and leave the walk with no step at all (or a reversed one).
   * Sliding every frame by the same delta keeps the drawn motion intact — the
   * stage shifts the whole route back onto the live object anyway.
   *
   * @param {{ x: number, y: number } | null} box The object's true position.
   * @returns {undefined}
   */
  const rebaseTo = (box) => {
    if (!box || !keyframes.length) {
      return;
    }
    const dx = Number(box.x) - keyframes[0].x;
    const dy = Number(box.y) - keyframes[0].y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
      return;
    }
    for (const frame of keyframes) {
      frame.x += dx;
      frame.y += dy;
    }
  };

  const setStatus = (message, kind) => onStatus(message, kind);
  const touched = () => {
    dirty = true;
  };

  const pathNow = () => pathFromKeyframes(fileId, fileName, keyframes);
  const value = () => (keyframes.length ? buildPathFile(pathNow()) : null);

  const snapshot = () => ({
    keyframes: JSON.parse(JSON.stringify(keyframes)),
    selected,
    live: live ? { ...live } : null,
    pending,
  });

  const record = () => {
    history.past.push(snapshot());
    if (history.past.length > 100) {
      history.past.shift();
    }
    history.future = [];
  };

  const restore = (state) => {
    keyframes = state.keyframes;
    selected = Math.min(state.selected, Math.max(0, keyframes.length - 1));
    live = state.live ? { ...state.live } : null;
    pending = state.pending;
    dirty = true;
    render();
  };

  const undo = () => {
    if (!history.past.length) {
      return false;
    }
    const before = history.past.pop();
    history.future.push(snapshot());
    restore(before);
    setStatus("已撤销");
    return true;
  };

  const redo = () => {
    if (!history.future.length) {
      return false;
    }
    const next = history.future.pop();
    history.past.push(snapshot());
    restore(next);
    setStatus("已重做");
    return true;
  };

  const clearHistory = () => {
    history.past = [];
    history.future = [];
  };

  /** A fresh copy of a frame, used as the draggable object state. */
  const stateOf = (frame) => ({
    x: frame.x,
    y: frame.y,
    rotation: frame.rotation,
    scale: frame.scale,
    alpha: frame.alpha,
    scaleX: frame.scaleX ?? 1,
    scaleY: frame.scaleY ?? 1,
  });

  const selectFrame = (index) => {
    if (!keyframes.length || index < 0 || index >= keyframes.length) {
      return;
    }
    selected = index;
    live = stateOf(keyframes[index]);
    pending = false;
    render();
  };

  /**
   * Commits the object's current state as a key frame.
   *
   * The new frame is inserted after the selected one and joined by a straight
   * line. If there was already a frame after it, that connection is split in
   * two so the route still visits every frame in order.
   */
  const commitFrame = () => {
    if (!live || !keyframes.length) {
      return false;
    }
    if (!pending) {
      setStatus("先拖动对象，再双击建立关键帧");
      return false;
    }
    record();
    const at = selected + 1;
    const following = keyframes[at];
    const oldLink = following?.link ?? null;
    const half = oldLink ? Math.max(1, Math.round((oldLink.time || DEFAULT_LINK_TIME) / 2)) : DEFAULT_LINK_TIME;
    const made = {
      ...stateOf(live),
      link: { time: half, bends: [] },
    };
    keyframes.splice(at, 0, made);
    if (following) {
      following.link = { time: half, bends: oldLink?.bends ?? [] };
    }
    selected = at;
    pending = false;
    touched();
    setStatus(`已建立第 ${at + 1} 个关键帧，两点之间以直线连接`);
    render();
    return true;
  };

  /** Removes the selected frame. The first frame is the object's start and stays. */
  const deleteFrame = () => {
    if (selected <= 0 || keyframes.length <= 1) {
      setStatus("起始关键帧不能删除", { error: true });
      return false;
    }
    record();
    keyframes.splice(selected, 1);
    if (selected > 0 && selected >= keyframes.length) {
      selected = keyframes.length - 1;
    }
    live = stateOf(keyframes[selected]);
    pending = false;
    touched();
    setStatus("已删除该关键帧，前后两点重新连成一条直线");
    render();
    return true;
  };

  /** The connection into a frame, or null for the start. */
  const linkAt = (index) => keyframes[index]?.link ?? null;

  /**
   * Adds a bend point on a connection, at the spot on the line nearest `at`.
   *
   * A newly added bend sits exactly on the straight chord, so adding one does
   * not move the route — the author then drags it to shape the curve.
   */
  const addBend = (index, at) => {
    const link = linkAt(index);
    if (!link) {
      return false;
    }
    const from = keyframes[index - 1];
    const to = keyframes[index];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const count = (link.bends?.length ?? 0) + 1;
    let bend;
    if (count === 1 && at) {
      // The first bend appears exactly where the author right-clicked, projected
      // onto the chord — so it is a handle *on the line*, not a shape change.
      const length = dx * dx + dy * dy;
      const t = length > 0
        ? Math.max(0, Math.min(1, ((at.x - from.x) * dx + (at.y - from.y) * dy) / length))
        : 0.5;
      bend = { x: from.x + dx * t, y: from.y + dy * t };
    } else {
      // More bends split the chord into evenly spaced cubics. The new handle
      // belongs to the last of those, so it starts on that piece's own midpoint
      // rather than on the middle of the whole line (which would restore the curve
      // sideways the moment the connection points were re-spaced).
      const previous = {
        x: from.x + (dx * (count - 1)) / count,
        y: from.y + (dy * (count - 1)) / count,
      };
      bend = { x: (previous.x + to.x) / 2, y: (previous.y + to.y) / 2 };
    }
    record();
    link.bends = [...(link.bends ?? []), bend];
    touched();
    setStatus(`这条连接现在有 ${link.bends.length} 个弯曲点`);
    render();
    return true;
  };

  /** Removes one bend; with none left the connection is a straight line again. */
  const removeBend = (index, bendIndex) => {
    const link = linkAt(index);
    if (!link || !link.bends?.length) {
      return false;
    }
    record();
    const at = Number.isInteger(bendIndex) ? bendIndex : link.bends.length - 1;
    link.bends = link.bends.filter((_, i) => i !== at);
    touched();
    setStatus(link.bends.length ? `还剩 ${link.bends.length} 个弯曲点` : "没有弯曲点，这条连接是直线");
    render();
    return true;
  };

  /** Turns a connection back into a straight line in one step. */
  const straighten = (index) => {
    const link = linkAt(index);
    if (!link || !link.bends?.length) {
      return false;
    }
    record();
    link.bends = [];
    touched();
    setStatus("这条连接已改回直线");
    render();
    return true;
  };

  // --- 预览播放 ---

  let previewAt = null;
  let previewFrame = null;
  let previewStarted = 0;
  // The interpolated pose the walk is at right now. `drawObject` rides this so
  // the whole object — outline, rotate stem and handles — walks with the real
  // image instead of the editing box freezing on the selected frame.
  let previewState = null;
  // The two nodes a walking frame touches, kept across frames so the walk does
  // not rebuild the outline's whole group (or the route behind it) every frame.
  let objectGroup = null;
  let previewDot = null;

  const stopPreview = () => {
    if (previewFrame != null) {
      cancelRaf(previewFrame);
      previewFrame = null;
    }
    previewAt = null;
    previewState = null;
    render();
  };

  const togglePreview = () => {
    if (!keyframes.length) {
      return;
    }
    if (previewAt) {
      stopPreview();
      return;
    }
    const path = pathNow();
    const total = pathDuration(path);
    if (total <= 0) {
      setStatus("这条路径没有时长可走", { error: true });
      return;
    }
    previewStarted = clock();
    // 预览播放始终从当前关键帧组的首帧开始，与当前选中帧无关；起点取 `path.start`。
    // `shiftedPointAt` 不加任何偏移，对象正好落在第 0 帧。
    // 只在此读取一次：`applyPreviewState` 每帧都在移动对象，若在 step() 里重读
    // 若在 `step()` 内重读起点，会被本次预览写入的位置覆盖，导致起点随选中帧偏移。
    const origin = path?.start ?? { x: 0, y: 0 };
    const step = () => {
      const elapsed = clock() - previewStarted;
      const at = shiftedPointAt(path, elapsed, origin);
      const frame = frameAt(path, elapsed);
      previewAt = { x: at.x, y: at.y };
      // The single pose both the real image and the on-canvas outline read from,
      // so the group walks as one instead of the picture leaving its box behind.
      previewState = {
        x: at.x,
        y: at.y,
        rotation: frame.rotation ?? live.rotation,
        scale: frame.scale ?? live.scale,
        scaleX: frame.scaleX ?? live.scaleX,
        scaleY: frame.scaleY ?? live.scaleY,
        alpha: frame.alpha ?? live.alpha,
      };
      if (previewStage?.applyPreviewState && origin) {
        // The real object walks the path too, so the author sees the key frame
        // land exactly where the outline does — starting where it really is.
        previewStage.applyPreviewState(objectName, previewState);
      }
      // Only the two nodes that move are touched: the route, the frame markers
      // and the panels do not change while the object walks, and rebuilding
      // them once per frame made a long path drop frames.
      renderPreviewFrame();
      if (at.done) {
        previewFrame = null;
        renderToolbar();
        return;
      }
      previewFrame = raf ? raf(step) : setTimeout(step, 16);
    };
    const first = shiftedPointAt(path, 0, origin);
    previewAt = { x: first.x, y: first.y };
    // One full paint so the static half is current before the walk starts.
    render();
    step();
  };

  /** A stage point from a pointer event, in the stage's own coordinates. */
  const pointFromEvent = (event) => {
    const box = canvas.getBoundingClientRect();
    const width = box.width || 1;
    const height = box.height || 1;
    const left = ((event.clientX - box.left) / width) * 100;
    const top = ((event.clientY - box.top) / height) * 100;
    return percentToStage(left, top);
  };

  /** Wraps a number box with Pamela's own up/down arrows. */
  const withStepper = (input, step) => {
    const wrap = document.createElement("span");
    wrap.className = "path-editor__stepper";
    const nudge = (direction) => {
      const min = Number(input.min);
      const current = Number(input.value) || 0;
      let next = current + direction * step;
      if (Number.isFinite(min)) {
        next = Math.max(min, next);
      }
      input.value = String(next);
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    const arrows = document.createElement("span");
    arrows.className = "path-editor__stepper-arrows";
    for (const [name, direction] of [
      ["chevron-up", 1],
      ["chevron-down", -1],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "path-editor__stepper-button";
      button.title = direction > 0 ? "增加" : "减少";
      button.setAttribute("aria-label", button.title);
      button.append(createIcon(name));
      button.addEventListener("click", () => nudge(direction));
      arrows.append(button);
    }
    wrap.append(input, arrows);
    return wrap;
  };

  const showChrome = (on) => {
    dock.hidden = !(on && timelineOpen);
  };

  /** Rebuilds the toolbar for the current state. */
  const renderToolbar = () => {
    toolbar.replaceChildren();
    if (!keyframes.length) {
      return;
    }
    const add = (icon, title, onClick, active = false, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `path-editor__button${active ? " is-active" : ""}`;
      const glyph = createIcon(icon);
      if (glyph) {
        button.append(glyph);
      } else {
        button.textContent = icon;
      }
      button.title = title;
      button.setAttribute("aria-label", title);
      if (disabled) {
        button.disabled = true;
      }
      button.addEventListener("click", onClick);
      toolbar.append(button);
      return button;
    };
    const label = (text, title) => {
      const span = document.createElement("span");
      span.className = "path-editor__label";
      span.textContent = text;
      if (title) {
        span.title = title;
      }
      toolbar.append(span);
      return span;
    };

    add("save", "保存", () => save());
    add("arrow-left", "返回脚本", () => back());
    add("undo", "撤销", () => undo(), false, !history.past.length);
    add("redo", "重做", () => redo(), false, !history.future.length);

    const gap = document.createElement("span");
    gap.className = "path-editor__gap";
    toolbar.append(gap);

    label(`${selected + 1}/${keyframes.length}`, `第 ${selected + 1} / ${keyframes.length} 帧`);
    add("chevron-left", "上一帧", () => selectFrame(selected - 1), false, selected <= 0);
    add("chevron-right", "下一帧", () => selectFrame(selected + 1), false, selected >= keyframes.length - 1);
    label(
      pending ? "● 双击记录" : "拖动 · 双击记录",
      "Shift 拖弯曲点：两侧对称",
    );

    const link = linkAt(selected);
    if (link) {
      const time = document.createElement("input");
      time.type = "number";
      time.className = "path-editor__time";
      time.min = "0";
      time.step = "50";
      time.value = String(link.time || 0);
      time.title = "时长（毫秒）";
      time.addEventListener("change", () => {
        const next = Number(time.value);
        if (Number.isFinite(next) && next >= 0) {
          record();
          link.time = next;
          touched();
          render();
        }
      });
      toolbar.append(withStepper(time, 50));
      add("curve", "转为曲线", () => addBend(selected, midpointOf(selected)), false, false);
      add("line", "改回直线", () => straighten(selected), false, !link.bends?.length);
      add("trash", "删除这一帧", () => deleteFrame(), false, selected <= 0);
    }

    const gap2 = document.createElement("span");
    gap2.className = "path-editor__gap";
    toolbar.append(gap2);
    add("play", "试走", () => togglePreview(), Boolean(previewAt));
    add("grid", "时间轴", () => {
      timelineOpen = !timelineOpen;
      render();
    }, timelineOpen);
  };

  /** The middle of a connection, used as the place a new bend starts from. */
  const midpointOf = (index) => {
    const from = keyframes[index - 1];
    const to = keyframes[index];
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  };

  /**
   * 停靠面板中仅保留不透明度的数值输入框；缩放与旋转由手柄控制。
   */
  const frameField = (caption, value, step, min, max, onChange) => {
    const wrap = document.createElement("label");
    wrap.className = "path-editor__field";
    const text = document.createElement("span");
    text.textContent = caption;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "path-editor__time";
    input.step = String(step);
    input.min = String(min);
    input.max = String(max);
    input.value = String(value ?? 1);
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (!Number.isFinite(next) || !live) {
        return;
      }
      record();
      const clamped = Math.min(max, Math.max(min, next));
      onChange(clamped);
      touched();
      render();
    });
    wrap.append(text, input);
    return wrap;
  };

  const renderFrames = () => {
    framesPanel.replaceChildren();
    if (!keyframes.length || !timelineOpen || !live) {
      return;
    }
    // 旋转与缩放由轮廓的八向手柄控制，不使用数值输入框。
    // 旋转与缩放由轮廓的八向手柄控制，不使用数值输入框。
    // handles and the rotate handle are the key constraint of this editor. Opacity
    // has no handle, so it keeps its field.
    framesPanel.append(
      frameField("透明度", live.alpha, 0.1, 0, 1, (value) => {
        live.alpha = value;
        pending = true;
      }),
    );
    const hint = document.createElement("span");
    hint.className = "path-editor__label";
    hint.textContent = "拖动对象移动 · 八向手柄缩放/变形 · 上方圆点旋转 · 双击对象记录关键帧";
    hint.title = "右键连接线：曲线 / 弯曲点";
    framesPanel.append(hint);
  };

  /** The timeline: one block per frame, as wide as its share of the run. */
  const renderTimeline = () => {
    timeline.replaceChildren();
    if (!keyframes.length || !timelineOpen) {
      return;
    }
    const total = keyframes.reduce((sum, kf, index) => sum + (index > 0 ? linkAt(index)?.time || 0 : 0), 0);
    keyframes.forEach((kf, index) => {
      const span = index > 0 ? linkAt(index)?.time || 0 : 0;
      const share = total > 0 ? (span / total) * 100 : 100 / keyframes.length;
      const block = document.createElement("button");
      block.type = "button";
      block.className = `path-editor__clip${index === selected ? " is-active" : ""}`;
      block.style.width = `${Math.max(4, share)}%`;
      block.title = `第 ${index + 1} 帧 · ${Math.round(span)} 毫秒`;
      block.textContent = String(index + 1);
      block.addEventListener("click", () => selectFrame(index));
      timeline.append(block);
    });
  };

  // --- drawing ---

  const circleAt = (x, y, radius, className, extra) => {
    const circle = createSvg("circle");
    circle.setAttribute("cx", String(x));
    circle.setAttribute("cy", String(-y));
    circle.setAttribute("r", String(radius));
    circle.setAttribute("class", className);
    if (extra?.title) {
      const title = createSvg("title");
      title.textContent = extra.title;
      circle.append(title);
    }
    return circle;
  };

  const lineElement = (x1, y1, x2, y2, className) => {
    const line = createSvg("line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(-y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(-y2));
    line.setAttribute("class", className);
    return line;
  };

  const polyline = (points, className) => {
    const element = createSvg("polyline");
    element.setAttribute("points", points.map(([x, y]) => `${x},${-y}`).join(" "));
    element.setAttribute("class", className);
    return element;
  };

  /** One connection as the segment the runtime walks. */
  const connectionSegment = (index) => {
    const from = keyframes[index - 1];
    const to = keyframes[index];
    return segmentFromLink(from, to, linkAt(index));
  };

  /** The bend points as they are drawn: on the line, one per cubic. */
  const bendPoints = (index) => {
    const segment = connectionSegment(index);
    if (segment.type !== "curve") {
      return [];
    }
    const controls = segmentControls(segment);
    const points = segment.points;
    const out = [];
    for (let run = 0; run < controls.length; run += 1) {
      const from = points[run * 2];
      const to = points[run * 2 + 2];
      if (!from || !to) {
        continue;
      }
      const [x, y] = cubicPoint(from, controls[run], to, 0.5);
      out.push({ x, y, run });
    }
    return out;
  };

  /**
   * Pushes the live object pose onto the preview stage, so the real picture
   * follows the transform box as the author drags, turns or stretches it. The
   * preview is a stage of its own; this only fires when that stage actually holds
   * the keyed object, so it never reaches for anything else that happens to be on
   * it. With no preview stage, or before the object has loaded, this is a no-op —
   * the on-canvas outline still shows where the key frame lands.
   */
  const syncPreview = () => {
    if (!previewStage || !live || !objectName || !previewStage.applyPreviewState) {
      return;
    }
    if (previewAt) {
      // While the walk is playing, `togglePreview` drives the real object; don't
      // restore it back to `live` on the render that step() asks for.
      return;
    }
    if (!readObjectBox()) {
      return;
    }
    previewStage.applyPreviewState(objectName, live);
  };

  /** The object's outline, handles and rotate handle, all in one rotated group. */
  const drawObject = () => {
    if (!live) {
      return;
    }
    // While the trial walk plays, the whole group rides the path with the real
    // image (see `togglePreview`). Without this, the editing box freezes on the
    // selected frame and the picture walks out from under it.
    const pose = previewAt ? (previewState ?? live) : live;
    const box = baseBox();
    const width = box.width * pose.scale * pose.scaleX;
    const height = box.height * pose.scale * pose.scaleY;
    const cx = pose.x;
    const cy = -pose.y;
    const { handles, rotate } = handlePositions(width, height);
    // The group is built once and then moved. A walking frame changes the pose
    // of the same box — rebuilding it left the previous copy behind and made
    // every frame allocate a dozen elements for a picture that had only moved.
    if (!objectGroup) {
      objectGroup = createSvg("g");
      objectGroup.setAttribute("class", "path-editor__object");
      const outline = createSvg("rect");
      outline.setAttribute("class", "path-editor__outline");
      objectGroup.append(outline);
      // The stem runs from the outline's top edge out to the rotate handle — the
      // "由" shaped box a picture editor draws. Everything here is inside the
      // rotated group, so the handle follows the object's angle.
      objectGroup.append(
        lineElement(cx, pose.y, cx + rotate.x, pose.y - rotate.y, "path-editor__rotate-stem"),
      );
      objectGroup.append(
        circleAt(cx + rotate.x, pose.y - rotate.y, 9, "path-editor__handle path-editor__handle--rotate", {
          title: "拖动旋转对象",
        }),
      );
      for (const handle of handles) {
        const boxEl = createSvg("rect");
        boxEl.setAttribute("width", "14");
        boxEl.setAttribute("height", "14");
        boxEl.setAttribute("class", "path-editor__handle");
        boxEl.setAttribute("data-handle", handle.name);
        const title = createSvg("title");
        title.textContent = "拖动缩放 / 变形";
        boxEl.append(title);
        objectGroup.append(boxEl);
      }
      svg.append(objectGroup);
    }

    objectGroup.setAttribute("transform", `rotate(${pose.rotation} ${cx} ${cy})`);
    const outline = objectGroup.childNodes[0];
    outline.setAttribute("x", String(cx - width / 2));
    outline.setAttribute("y", String(cy - height / 2));
    outline.setAttribute("width", String(Math.abs(width)));
    outline.setAttribute("height", String(Math.abs(height)));
    outline.setAttribute("class", `path-editor__outline${pending ? " is-pending" : ""}`);

    const stem = objectGroup.childNodes[1];
    stem.setAttribute("x1", String(cx));
    stem.setAttribute("y1", String(-pose.y));
    stem.setAttribute("x2", String(cx + rotate.x));
    stem.setAttribute("y2", String(-(pose.y - rotate.y)));

    const rotateHandle = objectGroup.childNodes[2];
    rotateHandle.setAttribute("cx", String(cx + rotate.x));
    rotateHandle.setAttribute("cy", String(-(pose.y - rotate.y)));

    handles.forEach((handle, index) => {
      const boxEl = objectGroup.childNodes[3 + index];
      if (!boxEl) {
        return;
      }
      boxEl.setAttribute("x", String(cx + handle.x - 7));
      boxEl.setAttribute("y", String(cy + handle.y - 7));
    });
  };

  /**
   * Repaints what a walking frame changes, and nothing else.
   *
   * A trial walk calls this once per frame instead of `render`: the route, the
   * bend points, the frame markers and the two panels are the same all the way
   * through, and rebuilding them (plus resampling the whole route) was the
   * expensive half of a preview.
   */
  const renderPreviewFrame = () => {
    drawObject();
    if (!previewAt) {
      return;
    }
    if (!previewDot) {
      previewDot = circleAt(previewAt.x, previewAt.y, 16, "path-editor__preview");
      svg.append(previewDot);
    }
    previewDot.setAttribute("cx", String(previewAt.x));
    previewDot.setAttribute("cy", String(-previewAt.y));
  };

  const render = () => {
    renderToolbar();
    showChrome(!node.hidden);
    renderTimeline();
    renderFrames();
    svg.replaceChildren();
    // The clear drops both nodes; the next `drawObject` builds them again.
    objectGroup = null;
    previewDot = null;
    if (!keyframes.length) {
      return;
    }

    // The whole route, faint; each connection brighter, the selected one lit.
    const path = pathNow();
    svg.append(polyline(samplePath(path), "path-editor__line path-editor__line--path"));
    for (let index = 1; index < keyframes.length; index += 1) {
      const segment = connectionSegment(index);
      svg.append(
        polyline(
          sampleSegment(segment),
          `path-editor__line path-editor__line--segment${index === selected ? " is-active" : ""}`,
        ),
      );
    }

    // Bend points sit on the line and are what the author drags to shape a curve.
    for (let index = 1; index < keyframes.length; index += 1) {
      for (const bend of bendPoints(index)) {
        svg.append(
          circleAt(bend.x, bend.y, 9, "path-editor__point path-editor__point--bend", {
            title: "拖动这个弯曲点调整曲度；右键连线可增删弯曲点",
          }),
        );
      }
    }

    // Every committed key frame is a marker; the selected one is filled.
    keyframes.forEach((kf, index) => {
      svg.append(
        circleAt(
          kf.x,
          kf.y,
          index === selected ? 15 : 11,
          `path-editor__point${index === 0 ? " path-editor__point--start" : ""}${index === selected ? " is-active" : ""}`,
          { title: `第 ${index + 1} 个关键帧` },
        ),
      );
    });

    drawObject();
    syncPreview();
    if (previewAt) {
      previewDot = circleAt(previewAt.x, previewAt.y, 16, "path-editor__preview");
      svg.append(previewDot);
    } else {
      previewDot = null;
    }
  };

  // --- pointer interaction ---

  /** Which bend point is under the pointer, across every connection. */
  const hitBend = (at) => {
    for (let index = 1; index < keyframes.length; index += 1) {
      const bends = bendPoints(index);
      for (const bend of bends) {
        if (Math.hypot(at.x - bend.x, at.y - bend.y) <= POINT_HIT) {
          return { index, run: bend.run };
        }
      }
    }
    return null;
  };

  /** Which key frame marker is under the pointer. */
  const hitFrame = (at) => {
    for (let index = 0; index < keyframes.length; index += 1) {
      const kf = keyframes[index];
      if (Math.hypot(at.x - kf.x, at.y - kf.y) <= POINT_HIT) {
        return index;
      }
    }
    return -1;
  };

  /** Which connection's drawn line is under the pointer (for the right-click menu). */
  const hitConnection = (at) => {
    let best = -1;
    let bestDistance = LINE_HIT;
    for (let index = 1; index < keyframes.length; index += 1) {
      for (const [x, y] of sampleSegment(connectionSegment(index))) {
        const distance = Math.hypot(at.x - x, at.y - y);
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
    }
    return best;
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (!keyframes.length || event.button !== 0 || !live) {
      return;
    }
    const at = pointFromEvent(event);
    const box = baseBox();
    const grip = hitObject(at, live, box);

    // A press on a committed frame selects it, so dragging can start from its
    // own state. The frame marker wins over the body when both are under the
    // pointer only for frames other than the one being edited.
    const marker = hitFrame(at);
    if (marker !== -1 && marker !== selected && !grip) {
      selectFrame(marker);
      return;
    }

    const bend = hitBend(at);
    if (bend && !grip) {
      record();
      drag = {
        kind: "bend",
        ...bend,
        origin: at,
        stamp: history.past.length,
        changed: false,
        // Shift is the shortcut for "drag both sides": the bend opposite the
        // grabbed one mirrors it about the link's middle.
        mirror: Boolean(event.shiftKey),
      };
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    if (!grip) {
      return;
    }
    record();
    drag = {
      kind: grip.kind,
      name: grip.name,
      origin: at,
      start: { ...live },
      box,
      stamp: history.past.length,
      changed: false,
    };
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!keyframes.length || !live) {
      return;
    }
    const at = pointFromEvent(event);
    if (drag) {
      // A press that never really moved is not an edit: it must not dirty the
      // file or leave a no-op step in the undo stack.
      if (!drag.changed && Math.hypot(at.x - drag.origin.x, at.y - drag.origin.y) < BEND_DEAD_ZONE) {
        return;
      }
      if (drag.kind === "move") {
        live = {
          ...live,
          x: drag.start.x + (at.x - drag.origin.x),
          y: drag.start.y + (at.y - drag.origin.y),
        };
      } else if (drag.kind === "handle") {
        live = resizeFromHandle(drag.start, drag.box, drag.name, at);
      } else if (drag.kind === "rotate") {
        live = rotateFromHandle(drag.start, at);
      } else if (drag.kind === "bend") {
        const link = linkAt(drag.index);
        if (link?.bends?.[drag.run] && drag.mirror && link.bends.length > 1) {
          link.bends = mirrorBends(link.bends, drag.run, at, midpointOf(drag.index));
        } else if (link?.bends?.[drag.run]) {
          link.bends[drag.run] = { x: at.x, y: at.y };
        }
      }
      drag.changed = true;
      pending = true;
      touched();
      render();
      canvas.style.cursor = drag.kind === "move" ? "grabbing" : "";
      return;
    }
    // The cursor says what a press would do before the press happens.
    const grip = hitObject(at, live, baseBox());
    canvas.style.cursor = grip?.kind === "move" ? "grab" : grip ? "pointer" : "";
  });

  canvas.addEventListener("pointerup", (event) => {
    if (drag && !drag.changed && history.past.length === drag.stamp) {
      history.past.pop();
    }
    drag = null;
    canvas.style.cursor = "";
    canvas.releasePointerCapture?.(event.pointerId);
  });

  canvas.addEventListener("dblclick", (event) => {
    if (!keyframes.length || !live) {
      return;
    }
    const at = pointFromEvent(event);
    // Double-clicking the object is the one way a key frame is made. Pressing
    // empty space does nothing, which is the whole difference from the old
    // "click to drop a waypoint" editor.
    if (hitObject(at, live, baseBox())) {
      commitFrame();
    }
  });

  // --- right-click: the connection ---

  canvas.addEventListener("contextmenu", (event) => {
    if (!keyframes.length) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const at = pointFromEvent(event);
    const index = hitConnection(at);
    const items = [];
    if (index !== -1) {
      const link = linkAt(index);
      const bends = link?.bends ?? [];
      items.push({
        label: bends.length ? `这条连接：曲线（${bends.length} 个弯曲点）` : "这条连接：直线",
        disabled: true,
      });
      items.push({
        label: bends.length ? "改回直线（移除全部弯曲点）" : "建立为曲线路径（增加弯曲点）",
        command: bends.length ? "path.straighten" : "path.curve",
      });
      items.push({ label: "增加弯曲点", command: "path.addBend" });
      items.push({ label: "移除弯曲点", command: "path.removeBend", disabled: !bends.length });
      items.push({
        label: "Shift 拖动：两侧对称",
        disabled: true,
      });
      items.push({ separator: true });
    }
    items.push({ label: "删除这个关键帧", command: "path.deleteFrame", disabled: selected <= 0 });
    items.push({ separator: true }, { label: "撤销", command: "path.undo", disabled: !history.past.length });

    openContextMenu({ x: event.clientX, y: event.clientY, items })
      .then((command) => {
        if (!command) {
          return;
        }
        if (command === "path.curve") {
          addBend(index, at);
        } else if (command === "path.straighten") {
          straighten(index);
        } else if (command === "path.addBend") {
          addBend(index, at);
        } else if (command === "path.removeBend") {
          removeBend(index);
        } else if (command === "path.deleteFrame") {
          deleteFrame();
        } else if (command === "path.undo") {
          undo();
        }
      })
      .catch((error) => setStatus(String(error?.message ?? error), "error"));
  });

  // Ctrl+Z / Ctrl+Y anywhere while the editor is open. A field keeps the
  // webview's own text undo, which is what Ctrl+Z means while typing in one.
  const onUndoKey = (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || node.hidden || event.defaultPrevented) {
      return;
    }
    if (event.target?.closest?.("input, textarea, select")) {
      return;
    }
    const key = String(event.key).toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    } else if (key === "y" && !event.shiftKey) {
      event.preventDefault();
      redo();
    }
  };
  document.addEventListener?.("keydown", onUndoKey);

  // --- open / save / close ---

  /** Opens a key frame file for editing. */
  const load = (id, document_, name = "") => {
    objectName = name;
    const normalized = normalizePath({ ...document_, id: document_?.id ?? id });
    if (!normalized) {
      setStatus("这份关键帧文件读不出来", { error: true });
      return false;
    }
    fileId = normalized.id;
    fileName = normalized.name;
    keyframes = keyframesOf(normalized);
    // A key animates the object where it already stands, so the route begins at
    // its real centre rather than at a number that happened to be in the file.
    // Every frame slides by the same delta, so the steps the author drew survive
    // the re-binding (see `rebaseTo`).
    rebaseTo(readObjectBox());
    selected = 0;
    live = stateOf(keyframes[0]);
    pending = false;
    drag = null;
    dirty = false;
    clearHistory();
    node.hidden = false;
    showChrome(true);
    render();
    return true;
  };

  const save = async () => {
    if (!keyframes.length) {
      return;
    }
    // The start was bound when the file was opened. Re-reading `objectBox()` here
    // would bind it to whichever frame the preview is currently showing — the
    // editor's own `syncPreview` moves the preview object onto the selected
    // frame — and that would rewrite the steps between frames on every save.
    // The stage shifts the whole route onto the live object at play time, so the
    // absolute start needs no second binding.
    const file = value();
    // The host answers the file it wrote, which is not always the one derived
    // from the id: a generated key frame is `data/ch-main-pe-1.keyframes`, and
    // reporting the derived `data/key-…` name would name a file that is not there.
    const written = await onSave(file);
    dirty = false;
    clearHistory();
    setStatus(`已保存 ${typeof written === "string" && written ? written : pathFileFor(file.id)}`);
    renderToolbar();
  };

  /** Leaves the editor and hands the author back to the script. */
  const back = async () => {
    if (!keyframes.length) {
      return;
    }
    if (dirty) {
      await save();
    }
    const id = fileId;
    close();
    onBack?.(id);
  };

  const close = () => {
    keyframes = [];
    live = null;
    pending = false;
    drag = null;
    dirty = false;
    clearHistory();
    node.hidden = true;
    showChrome(false);
    stopPreview();
    // 关闭时连同观察器与声音一起释放；下次打开会重新建一个自己的舞台。
    previewStage?.destroy?.();
    previewStage = null;
    onClose();
  };

  const isOpen = () => !node.hidden;
  const isDirty = () => dirty && keyframes.length > 0;
  const dockOpen = () => timelineOpen;

  return {
    node,
    toolbar,
    dock,
    load,
    save,
    back,
    close,
    /**
     * The host renamed (or copied) the file this editor has open. Its id and
     * name live inside the editor too — a save builds the document from them —
     * so they have to follow the file or the next save would write the old id
     * back into the renamed file.
     */
    rehome: (id, name) => {
      fileId = String(id ?? "");
      fileName = String(name ?? "");
    },
    /**
     * Re-measures the object after its bitmap has been decoded.
     *
     * The host opens the editor as soon as the preview has travelled to the key
     * line, but the picture is still being decoded at that moment — so `objectBox`
     * answers the whole frame and the outline drawn at `load()` is the size of
     * the entire editing area. The stage calls `onObjectBox` once it knows the
     * real rectangle; re-rendering here picks that up without waiting for the
     * author to drag something.
     */
    refresh: () => {
      if (isOpen() && live) {
        render();
      }
    },
    undo,
    redo,
    ensureStage,
    /** The object-state key frames as they stand now. */
    keyframes: () => JSON.parse(JSON.stringify(keyframes)),
    /** Commits the current object state as a new frame (what a double-click does). */
    commitFrame,
    /** Deletes the selected frame. */
    deletePoint: () => deleteFrame(),
    /** Adds a bend point on the selected connection, nearest `at`. */
    addPoint: (at) => addBend(selected, at ?? midpointOf(selected)),
    /** Adds a bend displaced from the line, for a caller without a pointer. */
    bend: (at, amount) => {
      const link = linkAt(selected);
      if (!link) {
        return false;
      }
      const spot = at ?? midpointOf(selected);
      return addBend(selected, { x: spot.x, y: spot.y + (Number(amount) || 0) });
    },
    /** Removes a bend point, or all of them when none is named. */
    removePoint: (bendIndex) => removeBend(selected, bendIndex),
    /** Turns the selected connection back into a straight line. */
    straighten: () => straighten(selected),
    /** Selects a frame, so a caller can edit it without a pointer. */
    selectFrame,
    /** Reads the object state currently being dragged. */
    liveState: () => (live ? { ...live } : null),
    /** Applies a state to the live object, as a drag would. */
    setLiveState: (state) => {
      if (!live) {
        return;
      }
      live = { ...live, ...state };
      pending = true;
      touched();
    },
    isOpen,
    isDirty,
    value,
    dockOpen,
    render,
  };
}
