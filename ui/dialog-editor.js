// 对白框设计器。
// Pamela — the dialogue box designer.
// 辅助线图层不捕获指针事件；缺少 `points` 数组时按缺省处理。

import { createDialogue, DEFAULT_STYLE, STYLE_SLOTS } from "./dialog.js";
import { draw, styleFor } from "./dialog-plate.js";
import { createHistory, record, undo as undoHistory, redo as redoHistory } from "./history.js";

// The plate painter lives with the runtime, so the designer and the stage never
// disagree about what a layer looks like. Both exports are kept here because the
// designer's own tests (and its callers) have always reached them by this path.
export { draw, styleFor } from "./dialog-plate.js";
import { createIcon } from "./icons.js";
import { openContextMenu } from "./context-menu.js";

/** What the designer calls each slot, for the style switcher. */
export const STYLE_SLOT_LABELS = { dialog: "对话", narration: "旁白" };

/** The shapes a layer may be. `image` is a bitmap placed on the plate. */
export const LAYER_TYPES = ["rect", "ellipse", "line", "polygon", "image"];

/** Labels for the layer type picker, in the order the picker offers them. */
export const LAYER_TYPE_LABELS = {
  rect: "矩形",
  ellipse: "椭圆",
  line: "线条",
  polygon: "多边形",
  image: "图片",
};

/** The glyph each style-slot tab shows. */
const SLOT_ICONS = { dialog: "message-square", narration: "message-square-quote" };

/** The glyph each layer type's add-button shows. */
const LAYER_ICONS = {
  rect: "square",
  ellipse: "circle",
  line: "line",
  polygon: "polygon",
  image: "image",
};

/** Vertices a polygon is created with when the caller does not say. */
export const DEFAULT_POLYGON_SIDES = 6;

/** The fewest sides that still enclose an area. */
export const MIN_POLYGON_SIDES = 3;

/** The most a polygon is drawn with, so the grips stay apart on screen. */
export const MAX_POLYGON_SIDES = 24;

let nextId = 0;

/** A short unique id, used to key layers in the list and the document. */
function makeId() {
  nextId += 1;
  return `l${nextId}`;
}

/**
 * An id no layer in `doc` has yet.
 *
 * `makeId` counts from one on every run, while a file names its own layers —
 * and a file an earlier run wrote is full of the very ids this one is about to
 * hand out. A layer sharing an id with another cannot be told apart from it:
 * the list marks both rows, and every look-up — the selection, the property
 * panel, the handles, the hit test — answers the first one it finds. So the
 * counter is drawn from again until it names something new.
 *
 * @returns {string}
 */
export function uniqueLayerId(doc) {
  const taken = new Set((currentStyle(doc)?.layers ?? []).map((layer) => layer.id));
  let id = makeId();
  while (taken.has(id)) {
    id = makeId();
  }
  return id;
}

/** A side count clamped to the range a polygon can usefully have. */
export function clampSides(sides) {
  const count = Math.round(Number(sides));
  if (!Number.isFinite(count)) {
    return DEFAULT_POLYGON_SIDES;
  }
  return Math.min(MAX_POLYGON_SIDES, Math.max(MIN_POLYGON_SIDES, count));
}

/**
 * A new layer of `type`, placed with a sensible size rather than at zero.
 *
 * @param {"rect" | "ellipse" | "line" | "polygon" | "image"} type
 * @param {{sides?: number}} [options] A polygon is built with this many sides.
 * @returns {object}
 */
export function createLayer(type, options = {}) {
  const base = {
    id: makeId(),
    name: LAYER_TYPE_LABELS[type] ?? type,
    type,
    visible: true,
    opacity: 1,
    x: 100,
    y: 100,
    width: 400,
    height: 200,
    rotation: 0,
  };

  if (type === "rect") {
    return { ...base, fill: "#101018", radius: 0, stroke: { color: "#ffffff", width: 0 } };
  }
  if (type === "ellipse") {
    return { ...base, fill: "#101018", stroke: { color: "#ffffff", width: 0 } };
  }
  if (type === "line") {
    // 直线没有面积，其长度等于选框对角线。
    // same width/height fields carry it.
    return { ...base, x: 100, y: 100, width: 600, height: 0, color: "#ffffff", thickness: 4 };
  }
  if (type === "polygon") {
    // A polygon is drawn from its vertices alone; the box around it is only
    // what the list, the selection and the hit test share, and is kept in step
    // with the points by `syncPolygonBox`. That call is not a formality here:
    // an even-sided polygon inscribed in a square is narrower than it, so the
    // box the vertices are built over is not the box they cover.
    const box = { x: 100, y: 100, width: 400, height: 400 };
    return syncPolygonBox({
      ...base,
      ...box,
      points: regularPolygonPoints(box, options.sides),
      fill: "#101018",
      stroke: { color: "#ffffff", width: 0 },
    });
  }
  return { ...base, x: 100, y: 100, width: 400, height: 400, source: "", opacity: 1 };
}

/**
 * One slot's own style: the plate it bakes to, the layers drawn on it, and the
 * two text blocks laid over it.
 *
 * A document keeps two of these — the box a named character speaks through and
 * the one the narrator speaks through — and they share nothing.
 *
 * @returns {object}
 */
function createStyleSet() {
  return {
    stamp: { path: "" },
    layers: [],
    speaker: structuredClone(DEFAULT_STYLE.speaker),
    text: structuredClone(DEFAULT_STYLE.text),
  };
}

/**
 * The style set a slot names, or the one `doc` is currently on.
 *
 * A bare style set — one that is not part of a document — is answered back as
 * itself, so a helper like `draw` can be handed either a whole document or a
 * single slot of one.
 *
 * @param {object} doc A document, or a style set on its own.
 * @param {"dialog" | "narration"} [slot] Defaults to `doc.active`.
 * @returns {object}
 */
/** The style set the designer is editing. */
export function currentStyle(doc) {
  return styleFor(doc, doc?.active);
}

/**
 * Copies the style being edited over another slot, whole.
 *
 * Deep rather than shared: a plate's vertices, its text blocks and its font are
 * a style's own, and a copy holding the same references would move the
 * original's corners whenever the copy's were dragged. Every field travels,
 * including the layers, so the two slots never end up sharing one plate.
 *
 * @param {object} doc
 * @param {"dialog" | "narration"} slot Where the copy lands.
 * @returns {boolean} Whether anything was copied — a slot copied onto itself
 *   is left alone.
 */
export function copyStyleTo(doc, slot) {
  if (!STYLE_SLOTS.includes(slot) || !doc?.styles || slot === doc.active) {
    return false;
  }
  doc.styles[slot] = structuredClone(currentStyle(doc));
  return true;
}

/**
 * A copy of `doc` holding only the two text blocks.
 *
 * The designer draws the plate on its own canvas with the shared painter, so
 * the runtime preview must not paint a second plate (from layers) or paste an
 * old stamped PNG over it. Only the plate goes: the geometry the runtime lays
 * the text out with is the live document's, which is what keeps the preview
 * honest.
 */
function textOnly(doc) {
  const blank = (style) => ({
    ...style,
    stamp: { ...style.stamp, path: "" },
    layers: [],
  });
  if (!doc?.styles) {
    return blank(doc);
  }
  return {
    ...doc,
    styles: {
      dialog: blank(styleFor(doc, "dialog")),
      narration: blank(styleFor(doc, "narration")),
    },
  };
}

/**
 * A document holding two empty plates, plus the defaults the runtime uses for
 * the text. Each style half is the runtime's `DEFAULT_STYLE`, copied, so a file
 * saved without touching the text still lays out the same.
 *
 * @returns {object}
 */
export function createDocument() {
  return {
    version: 2,
    canvas: { ...DEFAULT_STYLE.canvas },
    // Which slot the designer was last on. A convenience field, but one that is
    // written to the file: reopening a template lands where it was left.
    active: "dialog",
    styles: { dialog: createStyleSet(), narration: createStyleSet() },
  };
}

/**
 * The plates a built-in style lays its text over: a wide bar for the line, and
 * — when `namePlate` — a smaller plate straddling its top edge for the name.
 *
 * The plates are what give a template its box. A style with no layers would
 * leave the dialogue text sitting on whatever the stage happens to show behind
 * it, so the runtime falls back to a plain bar. Both are rounded off and
 * outlined, so the pair still reads over a background of any brightness. A
 * narration box shows no name, so it is built without the name plate.
 */
function defaultPlateLayers(namePlate) {
  const layers = [
    {
      id: makeId(),
      name: "底板",
      type: "rect",
      visible: true,
      opacity: 0.55,
      x: 140,
      y: 800,
      width: 1640,
      height: 240,
      rotation: 0,
      fill: "#000000",
      radius: 24,
      stroke: { color: "#ffffff", width: 3 },
    },
  ];
  if (namePlate) {
    // Drawn after the bar, so where the two overlap the name plate is on top.
    layers.push({
      id: makeId(),
      name: "姓名框",
      type: "rect",
      visible: true,
      opacity: 0.72,
      x: 176,
      y: 744,
      width: 400,
      height: 88,
      rotation: 0,
      fill: "#000000",
      radius: 16,
      stroke: { color: "#ffffff", width: 3 },
    });
  }
  return layers;
}

/**
 * The style a slot is given when nothing says otherwise: the runtime's defaults
 * plus a plate to lay the text over.
 *
 * The text blocks move onto the plates — the name inside the small one, the
 * line inside the bar. Kept here rather than in the runtime's defaults, which
 * stay where a style-less dialogue would put them.
 *
 * @param {"dialog" | "narration"} [slot]
 * @returns {object} A style set whose layers the runtime draws as its plate.
 */
export function createDefaultStyle(slot = "dialog") {
  const style = createStyleSet();
  style.layers = defaultPlateLayers(slot !== "narration");
  style.speaker = { ...style.speaker, x: 196, y: 756, width: 360, height: 64 };
  style.text = { ...style.text, x: 196, y: 872, width: 1520, height: 144 };
  return style;
}

/**
 * The style a project is given when it has none: both slots, each with its own
 * layers for the runtime to draw.
 *
 * @returns {object} A document ready to be written as the project's style file.
 */
export function createDefaultTemplate() {
  const doc = createDocument();
  for (const slot of STYLE_SLOTS) {
    doc.styles[slot] = createDefaultStyle(slot);
  }
  return doc;
}

/**
 * Fills in what a file left out, so an older or hand-written file still loads.
 *
 * A file from before the split names one style, and names it at the top level:
 * that one was the dialogue box, so it becomes the `dialog` slot whole. The
 * `narration` slot is then the built-in default — a bar, and no name plate —
 * rather than an empty box, which is what keeps an existing template usable.
 */
export function normaliseDocument(raw) {
  const base = createDocument();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return base;
  }

  const canvas = { ...base.canvas, ...raw.canvas };
  const named = raw.styles && typeof raw.styles === "object" ? raw.styles : null;
  if (!named) {
    return {
      version: 2,
      canvas,
      active: "dialog",
      styles: {
        dialog: normaliseStyle(raw, base.styles.dialog),
        narration: createDefaultStyle("narration"),
      },
    };
  }

  return {
    version: 2,
    canvas,
    active: raw.active === "narration" ? "narration" : "dialog",
    styles: {
      dialog: normaliseStyle(named.dialog, base.styles.dialog),
      narration: normaliseStyle(named.narration, createDefaultStyle("narration")),
    },
  };
}

/** One slot of a file, filled in from `base` — an empty or default style set. */
function normaliseStyle(raw, base) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    stamp: { ...base.stamp, ...source.stamp },
    // Ids are what the list, the selection and the handles all agree on, so a
    // layer missing one gets a fresh id rather than being keyed by index.
    layers: normaliseLayers(Array.isArray(source.layers) ? source.layers : []),
    speaker: mergeText(base.speaker, source.speaker),
    text: mergeText(base.text, source.text),
  };
}

/**
 * A file's layers, each with an id of its own.
 *
 * A file can name two layers the same — hand-edited, or written by a run whose
 * counter started where this one now is — and two layers under one id behave
 * as a single layer: both rows mark, and every look-up answers the first. So a
 * repeat keeps its shape and gets a name of its own instead of being kept.
 */
function normaliseLayers(layers) {
  const seen = new Set();
  return layers.map((layer) => {
    const next = normaliseLayer(layer);
    while (seen.has(next.id)) {
      next.id = makeId();
    }
    seen.add(next.id);
    return next;
  });
}

/** One layer read back from a file: identified, and shaped if it is a polygon. */
function normaliseLayer(layer) {
  const next = { ...layer, id: layer.id ?? makeId() };
  if (next.type === "polygon") {
    // The vertices are the shape, so they are what a file is trusted for; the
    // box is rebuilt from them rather than read, which is what keeps a file
    // whose box and points disagree drawing what its points say.
    next.points = normalisePoints(next.points, next);
    syncPolygonBox(next);
  }
  return next;
}

/** Merges a text block over its default, fonts included. */
function mergeText(base, patch) {
  return {
    ...base,
    ...patch,
    font: { ...base.font, ...patch?.font },
  };
}

/** Serialises a document back to JSON, ready for `write_file`. */
export function documentToJson(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// --- polygons ---

/**
 * The vertices of a regular `sides`-gon inscribed in `box`.
 *
 * The first vertex is placed at the top rather than at the right, so a triangle
 * points up and a square stands on a side — the way a hand-drawn one would.
 * The radius follows the box on each axis, so a wide box gives a wide polygon
 * and dragging a vertex of a circle of points is still a circle.
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} [sides]
 * @returns {{x: number, y: number}[]}
 */
export function regularPolygonPoints(box, sides) {
  const count = clampSides(sides ?? DEFAULT_POLYGON_SIDES);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;

  const points = [];
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return points;
}

/**
 * The box a point list covers.
 *
 * An empty list has no extent, so it answers a box of nothing rather than
 * infinities: the caller is drawing something that has no vertices yet.
 *
 * @param {{x: number, y: number}[]} points
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function polygonBounds(points) {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of list) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Rewrites a polygon's box from its vertices.
 *
 * A polygon has no size of its own — the vertices decide both where it is and
 * how big it is — so the box is a cache. Everything that moves a vertex calls
 * this, which is what keeps the selection box, the property fields and a
 * `resize` grip honest after a corner has been dragged on its own.
 */
export function syncPolygonBox(layer) {
  const box = polygonBounds(layer.points);
  layer.x = box.x;
  layer.y = box.y;
  layer.width = box.width;
  layer.height = box.height;
  return layer;
}

/** Whether `x`, `y` falls inside the polygon `points`. */
export function pointInPolygon(points, x, y) {
  const list = Array.isArray(points) ? points : [];
  if (list.length < 3) {
    return false;
  }

  // The usual crossing count: a ray cast to the right is crossed once per edge
  // it passes, and an odd count means the point started inside.
  let inside = false;
  for (let index = 0, previous = list.length - 1; index < list.length; previous = index, index += 1) {
    const a = list[index];
    const b = list[previous];
    const straddles = a.y > y !== b.y > y;
    if (straddles && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Moves one vertex, leaving every other vertex where it is.
 *
 * This is what "each corner is its own handle" means: the shape is redrawn from
 * wherever the dragged corner now is, and the box follows it.
 *
 * @returns {object | null} The layer, or `null` when there is no such vertex.
 */
export function moveVertex(layer, index, x, y) {
  const point = layer.points?.[index];
  if (!point) {
    return null;
  }
  point.x = x;
  point.y = y;
  return syncPolygonBox(layer);
}

/**
 * Fills in a polygon's vertices when the file does not bring usable ones.
 *
 * 手写图层缺少 `points` 数组或数组内容无效时按缺省处理。
 * rebuilt as a regular polygon over the box it does declare, so an older file
 * opens as a shape rather than as nothing at all.
 */
export function normalisePoints(raw, box) {
  const list = Array.isArray(raw) ? raw : [];
  const usable = list
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: point.x, y: point.y }));
  return usable.length >= MIN_POLYGON_SIDES ? usable : regularPolygonPoints(box, DEFAULT_POLYGON_SIDES);
}

/**
 * Rebuilds a polygon as a regular `sides`-gon over the area it already covers.
 *
 * The shape is replaced rather than nudged, which is what "12 sides" means to
 * the author: the outline keeps the room it had and gains the corners. The box
 * is only a cache of the vertices, so it is rebuilt from them afterwards.
 *
 * @returns {object | null} The layer, or `null` when it is not a polygon.
 */
export function setPolygonSides(layer, sides) {
  if (layer.type !== "polygon") {
    return null;
  }
  layer.points = regularPolygonPoints(polygonBounds(layer.points), clampSides(sides));
  return syncPolygonBox(layer);
}

// --- text regions ---

/**
 * The editor's own test backdrop.
 *
 * A style is authored against nothing: the plate, the name and the line are all
 * the designer can see, and half of what makes a box readable is what is behind
 * it. The backdrop is that — a picture the author drops under the plate to try
 * the text over something bright or busy.
 *
 * It is not part of the style and must never become part of it: the plate is
 * what the runtime draws, and a backdrop drawn into it would be pasted over
 * every scene. So it lives in the editor alone — not in the document, not in
 * the file, and changing it does not make the file dirty.
 */
export const BACKDROP_ID = "backdrop";

/** Whether `id` names the test backdrop rather than a layer or a region. */
export function isBackdropId(id) {
  return id === BACKDROP_ID;
}

/**
 * The two text blocks a style lays out, shown in the layer list as rows.
 *
 * They are the only thing a style file declares that the author can drag, so
 * they belong in the same list as the shapes — but they are not layers: they
 * are never drawn on the plate, are not layers, and they cannot be
 * added or removed, because the runtime reads both of them by name. That is
 * why they carry ids of their own rather than living in `doc.layers`, and why
 * every operation on a layer refuses them for free.
 */
export const TEXT_REGIONS = [
  { id: "region:speaker", key: "speaker", name: "姓名显示区域" },
  { id: "region:text", key: "text", name: "文本显示区域" },
];

/** The region a selection id names, or `null` when it names a layer. */
export function regionFor(id) {
  return TEXT_REGIONS.find((region) => region.id === id) ?? null;
}

/** The region with this key — `speaker` or `text` — or `null`. */
export function regionByKey(key) {
  return TEXT_REGIONS.find((region) => region.key === key) ?? null;
}

/** Whether `id` is one of the two text regions rather than a layer. */
export function isRegionId(id) {
  return Boolean(regionFor(id));
}

/**
 * The words the designer fills the two text blocks with.
 *
 * A style is a box, a font and a place, and until something is in the box an
 * author is choosing a face against an empty rectangle. These are what the
 * designer writes there, and they go through the runtime's own `sample`, so
 * what the author reads is laid out exactly as a script's line will be —
 * shrink-to-fit included.
 */
export const SAMPLE_SPEAKER = "示例姓名";
export const SAMPLE_TEXT = "示例文本：这一行用来预览字体样式。";

/**
 * The rows under "系统组件" in the layer list, in the order the list shows.
 *
 * They are the style's own text blocks plus the editor's test backdrop (see
 * `BACKDROP_ID`). What the three share is what keeps them out of the stack:
 * none of them is a layer, so none can be added, removed or restacked, and the
 * list sets them apart for that reason instead of leaving the author to find
 * out by trying.
 */
export const SYSTEM_COMPONENTS = [
  { id: "region:text", name: "文本显示区域", kind: "region", mark: "◻" },
  { id: "region:speaker", name: "姓名显示区域", kind: "region", mark: "◻" },
  { id: BACKDROP_ID, name: "背景", kind: "backdrop", mark: "▦" },
];

/**
 * The selectable thing an id names: a layer, a text region, the test backdrop,
 * or nothing.
 *
 * The panels and the handles work on any of them, so they ask this rather than
 * looking the id up in `doc.layers` and quietly doing nothing for the rest.
 *
 * @returns {{kind: "layer", layer: object} | {kind: "region", key: string, block: object}
 *   | {kind: "backdrop"} | null}
 */
export function selectionFor(doc, id) {
  // The backdrop has no document half to look up: it is the editor's own
  // picture, and no style file declares one.
  if (isBackdropId(id)) {
    return { kind: "backdrop" };
  }
  const region = regionFor(id);
  if (region) {
    return { kind: "region", key: region.key, block: currentStyle(doc)[region.key] };
  }
  const layer = id ? findLayer(doc, id) : null;
  return layer ? { kind: "layer", layer } : null;
}

/** The box a selection covers, positive on both axes. Layers and regions only. */
export function selectionBox(selection) {
  return normalBox(selection.kind === "layer" ? selection.layer : selection.block);
}

// --- geometry ---

/**
 * The eight resize grips, named by the side of the box they sit on. A name
 * carries both its axes — `nw` is the top-left corner — which is what lets
 * `resizeBox` read one without a table.
 */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** A layer's box with positive width and height, whatever the layer stores. */
export function normalBox(layer) {
  return {
    x: layer.width < 0 ? layer.x + layer.width : layer.x,
    y: layer.height < 0 ? layer.y + layer.height : layer.y,
    width: Math.abs(layer.width),
    height: Math.abs(layer.height),
  };
}

/**
 * Turns a point on the plate into the layer's own unrotated space.
 *
 * A layer is stored as an upright box plus an angle, so asking whether a point
 * is inside it — or turning a drag into a local offset — means undoing that
 * angle about the box's centre. Without a rotation the point is already local,
 * which is the case every layout in practice is in.
 */
export function toLocalPoint(layer, x, y) {
  const dx = x - (layer.x + layer.width / 2);
  const dy = y - (layer.y + layer.height / 2);
  const radians = ((layer.rotation ?? 0) * Math.PI) / 180;
  if (!radians) {
    return { x, y };
  }
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: layer.x + layer.width / 2 + dx * cos + dy * sin,
    y: layer.y + layer.height / 2 - dx * sin + dy * cos,
  };
}

/** Turns a drag offset into the layer's own unrotated axes. */
export function toLocalDelta(rotation, dx, dy) {
  const radians = ((rotation ?? 0) * Math.PI) / 180;
  if (!radians) {
    return { x: dx, y: dy };
  }
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/**
 * The angle, in degrees, from `centre` to a point on the plate.
 *
 * A rotation drag is the difference between two of these — where the pointer
 * started and where it is now — rather than the offset between them. Measuring
 * the swing is what makes the shape turn with the pointer instead of being
 * pushed sideways by it, and it is why the grip can be grabbed anywhere.
 */
export function angleFrom(centre, x, y) {
  return (Math.atan2(y - centre.y, x - centre.x) * 180) / Math.PI;
}

/**
 * The angle a rotation drag leaves behind.
 *
 * The pointer's own swing is added to the angle the shape already had, so a
 * shape grabbed at any corner keeps the turn it came with. The result is
 * normalised into (-180, 180], which is the range the field shows and the one
 * a style file reads back — a shape turned past half a turn reads as turned
 * the short way, not as 350°.
 */
export function rotationFrom(startRotation, startAngle, angle) {
  const turned = (startRotation ?? 0) + (angle - startAngle);
  const wrapped = ((turned % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * The box a drag of `handle` by `dx`, `dy` leaves behind.
 *
 * The side opposite the grip stays where it was and the grip's own sides
 * follow the pointer, which is what makes a corner drag resize rather than
 * move. Sizes are not clamped: a box turned inside out is how a line is drawn
 * the other way, and the fields can put it back.
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {string} handle One of `HANDLES`.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function resizeBox(box, handle, dx, dy) {
  const next = { ...box };
  if (handle.includes("w")) {
    next.x = box.x + dx;
    next.width = box.width - dx;
  }
  if (handle.includes("e")) {
    next.width = box.width + dx;
  }
  if (handle.includes("n")) {
    next.y = box.y + dy;
    next.height = box.height - dy;
  }
  if (handle.includes("s")) {
    next.height = box.height + dy;
  }
  return next;
}

/** How far `px`, `py` is from a line layer's own run and rise. */
function distanceToLine(layer, px, py) {
  const dx = layer.width;
  const dy = layer.height;
  const length = dx * dx + dy * dy;
  if (!length) {
    return Math.hypot(px - layer.x, py - layer.y);
  }
  const t = Math.max(0, Math.min(1, ((px - layer.x) * dx + (py - layer.y) * dy) / length));
  return Math.hypot(px - (layer.x + t * dx), py - (layer.y + t * dy));
}

/** Whether `x`, `y` falls on a layer. */
function containsPoint(layer, x, y) {
  // A line has no area, so it is picked by how close the point is to it; the
  // tolerance is a floor rather than the stroke itself, since a hairline is
  // otherwise impossible to click.
  if (layer.type === "line") {
    return distanceToLine(layer, x, y) <= Math.max(layer.thickness ?? 1, 6);
  }
  // A polygon is picked by its own outline, so the empty corner between two of
  // its vertices selects whatever is behind it rather than the shape itself.
  if (layer.type === "polygon") {
    return pointInPolygon(layer.points, x, y);
  }
  const box = normalBox(layer);
  return (
    x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
  );
}

/**
 * The topmost visible layer under a plate point.
 *
 * Layers are tested from the top of the stack down, so what is picked is what
 * is seen — the same order `draw` paints in, read backwards.
 *
 * @returns {string | null} The layer's id, or `null` for empty plate.
 */
export function hitTest(doc, x, y) {
  const { layers } = currentStyle(doc);
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer.visible === false) {
      continue;
    }
    const local = toLocalPoint(layer, x, y);
    if (containsPoint(layer, local.x, local.y)) {
      return layer.id;
    }
  }
  return null;
}

// --- document operations ---

/**
 * The document edits the designer performs, kept apart from the DOM that
 * triggers them. They mutate the document in place and answer it back, so the
 * caller can redraw without threading a return value through every handler.
 */

/** The layer with `id` in the style being edited, or `null`. */
export function findLayer(doc, id) {
  return currentStyle(doc).layers.find((layer) => layer.id === id) ?? null;
}

/** Adds a fresh layer of `type` on top of the current style, and answers it. */
export function addLayer(doc, type) {
  const layer = createLayer(type);
  // The id is redrawn rather than kept from `createLayer`: that one comes from
  // the counter alone, and a loaded document is likely to be using it already.
  layer.id = uniqueLayerId(doc);
  currentStyle(doc).layers.push(layer);
  return layer;
}

/** How far a copy lands from the layer it was taken from. */
const COPY_OFFSET = 20;

/**
 * Copies the layer with `id` and puts the copy directly above it.
 *
 * The copy is deep rather than shared. A polygon's vertices *are* the shape, so
 * a copy holding the same array would move the original's corners whenever the
 * copy's were dragged — the two would look like two layers and behave like one.
 * The copy is nudged so it does not hide exactly under the layer it came from,
 * and renamed so the list can tell them apart.
 *
 * @returns {object | null} The copy, or `null` when there is no such layer.
 */
export function duplicateLayer(doc, id) {
  const { layers } = currentStyle(doc);
  const index = layers.findIndex((layer) => layer.id === id);
  if (index === -1) {
    return null;
  }

  const copy = structuredClone(layers[index]);
  copy.id = uniqueLayerId(doc);
  const name = copy.name || LAYER_TYPE_LABELS[copy.type] || copy.type;
  copy.name = `${name} 副本`;
  copy.x += COPY_OFFSET;
  copy.y += COPY_OFFSET;
  // The box is only a cache for a polygon, so the vertices have to travel with
  // it or the copy would draw at the original's corners.
  for (const point of copy.points ?? []) {
    point.x += COPY_OFFSET;
    point.y += COPY_OFFSET;
  }
  layers.splice(index + 1, 0, copy);
  return copy;
}

/**
 * Removes the layer with `id`.
 *
 * @returns {boolean} Whether anything was removed.
 */
export function removeLayer(doc, id) {
  const { layers } = currentStyle(doc);
  const index = layers.findIndex((layer) => layer.id === id);
  if (index === -1) {
    return false;
  }
  layers.splice(index, 1);
  return true;
}

/**
 * Moves the layer with `id` one place up or down the stack.
 *
 * Later layers paint over earlier ones, so "up" means later: the layer moves
 * towards the end of the list.
 *
 * @param {number} offset `-1` to move down, `1` to move up.
 * @returns {boolean} Whether the order changed.
 */
export function moveLayer(doc, id, offset) {
  const { layers } = currentStyle(doc);
  const index = layers.findIndex((layer) => layer.id === id);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= layers.length) {
    return false;
  }
  const [layer] = layers.splice(index, 1);
  layers.splice(target, 0, layer);
  return true;
}

/**
 * Applies `patch` to the layer with `id`.
 *
 * Numbers are coerced here rather than at each field, since every numeric
 * property arrives from an `<input>` as a string.
 *
 * @returns {object | null} The updated layer, or `null` when it is not there.
 */
export function updateLayer(doc, id, patch) {
  const layer = findLayer(doc, id);
  if (!layer) {
    return null;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === "stroke" && value && typeof value === "object") {
      layer.stroke = { ...layer.stroke, ...value };
    } else {
      layer[key] = value;
    }
  }
  return layer;
}

/**
 * Moves a layer by `dx`, `dy`.
 *
 * A polygon's vertices are absolute, so they travel with the box rather than
 * being left behind by it — the box is where it is only because they are.
 */
export function translateLayer(layer, dx, dy) {
  layer.x += dx;
  layer.y += dy;
  if (layer.type === "polygon") {
    for (const point of layer.points ?? []) {
      point.x += dx;
      point.y += dy;
    }
  }
  return layer;
}

/**
 * Nudges a box onto the nearest alignment line, when one is close enough.
 *
 * A box offers three lines on each axis — its two edges and its centre — and
 * each is compared against every candidate line. The nearest win is applied as
 * a shift rather than an absolute position, so a rotated or inside-out box and
 * a whole multi-selection all move together. The lines actually hit come back
 * so the editor can draw them while the pointer is down.
 *
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {{vertical?: number[], horizontal?: number[]}} lines
 * @param {number} threshold Largest distance, in document units, that snaps.
 * @returns {{x: number, y: number, guides: {vertical: number[], horizontal: number[]}}}
 */
export function snapBox(box, lines, threshold) {
  const best = (own, candidates) => {
    let hit = null;
    for (const value of own) {
      for (const line of candidates ?? []) {
        const distance = line - value;
        if (
          Math.abs(distance) <= threshold &&
          (!hit || Math.abs(distance) < Math.abs(hit.distance))
        ) {
          hit = { distance, line };
        }
      }
    }
    return hit;
  };
  const ownX = [box.x, box.x + box.width / 2, box.x + box.width];
  const ownY = [box.y, box.y + box.height / 2, box.y + box.height];
  const vertical = best(ownX, lines.vertical);
  const horizontal = best(ownY, lines.horizontal);
  return {
    x: vertical?.distance ?? 0,
    y: horizontal?.distance ?? 0,
    guides: {
      vertical: vertical ? [vertical.line] : [],
      horizontal: horizontal ? [horizontal.line] : [],
    },
  };
}

/**
 * Puts a layer's box at `box`, scaling a polygon's vertices with it.
 *
 * The vertices are mapped proportionally from the box the layer had to the one
 * it is getting, which is what makes a grip drag resize a polygon the way it
 * resizes a rectangle: the shape keeps its proportions whatever the corner of
 * the box does. A box with no extent on an axis cannot be scaled along it, so
 * that axis is merely translated.
 */
export function resizeLayerBox(layer, box) {
  const from = { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
  if (layer.type === "polygon") {
    const scaleX = from.width ? box.width / from.width : 1;
    const scaleY = from.height ? box.height / from.height : 1;
    for (const point of layer.points ?? []) {
      point.x = box.x + (point.x - from.x) * scaleX;
      point.y = box.y + (point.y - from.y) * scaleY;
    }
  }
  layer.x = box.x;
  layer.y = box.y;
  layer.width = box.width;
  layer.height = box.height;
  return layer;
}

// --- form controls ---

/** Wraps a control in its label row. */
function field(label, control) {
  const row = document.createElement("label");
  row.className = "dialog-editor__field";
  const text = document.createElement("span");
  text.className = "dialog-editor__field-label";
  text.textContent = label;
  row.append(text, control);
  return row;
}

/**
 * One editable value.
 *
 * @param {object} spec
 * @param {string} spec.kind `number` | `color` | `checkbox` | `select` | `text`
 * @param {unknown} spec.value
 * @param {(value: unknown) => void} spec.onChange
 * @returns {HTMLElement | null} The control, or `null` for an unknown kind.
 */
function control(spec) {
  const node = document.createElement(spec.kind === "select" ? "select" : "input");

  if (spec.kind === "select") {
    for (const option of spec.options ?? []) {
      const entry = document.createElement("option");
      entry.value = String(option.value);
      entry.textContent = option.label;
      node.append(entry);
    }
    node.value = String(spec.value ?? "");
    node.addEventListener("change", () => spec.onChange(node.value));
    return node;
  }

  if (spec.kind === "checkbox") {
    node.type = "checkbox";
    node.checked = Boolean(spec.value);
    node.addEventListener("change", () => spec.onChange(node.checked));
    return node;
  }

  node.type = spec.kind === "color" ? "color" : spec.kind === "number" ? "number" : "text";
  if (spec.kind === "number") {
    node.step = String(spec.step ?? 1);
    if (spec.min !== undefined) {
      node.min = String(spec.min);
    }
    if (spec.max !== undefined) {
      node.max = String(spec.max);
    }
  }
  node.value = String(spec.value ?? "");
  // A number field is read as a number, so `x` never ends up stored as `"100"`
  // and comparing two documents stays a comparison of numbers.
  node.addEventListener("input", () =>
    spec.onChange(spec.kind === "number" ? Number(node.value) || 0 : node.value),
  );
  return node;
}

/** Two numeric fields side by side, for a position or a size. */
function pair(label, first, second) {
  const row = document.createElement("div");
  row.className = "dialog-editor__pair";
  row.append(field(label.first, control(first)), field(label.second, control(second)));
  return row;
}

const ALIGN_OPTIONS = [
  { value: "left", label: "左" },
  { value: "center", label: "中" },
  { value: "right", label: "右" },
];

const VALIGN_OPTIONS = [
  { value: "top", label: "上" },
  { value: "middle", label: "中" },
  { value: "bottom", label: "下" },
];

// --- the editor ---

/**
 * Builds the designer: a layer list, a live plate, and the properties of what
 * is selected.
 *
 * The preview is the runtime's own box — `createDialogue` over a layer above
 * the plate canvas — so what the designer shows is what a script gets, down to
 * the font scaling. Only the text is previewed that way: the plate is the
 * canvas underneath, drawn by the same `draw` the stage uses. Designer and
 * stage cannot disagree, because there is only one painter.
 *
 * Nothing here talks to the backend. Saving is reported through a callback, so
 * the module stays a piece of the view and the project actions stay in `main.js`.
 *
 * @param {object} options
 * @param {(path: string) => Promise<string>} options.resolveAsset
 * @param {() => Promise<string[]>} [options.listFonts]
 * @param {() => string[]} [options.listImages] Pictures an image layer can be
 *   given, as project-relative paths. The caller that knows the project passes
 *   its interface folder (`assets/ui/`); the default is an empty list.
 * @param {() => string[]} [options.listBackdrops] Pictures the test backdrop can
 *   be picked from. Defaults to `listImages`: a caller with one list of pictures
 *   offers both choices from it.
 * @param {() => void} [options.onChange] A document edit the caller may save.
 * @param {(message: string) => void} [options.onError]
 */
export function createDialogueEditor({
  resolveAsset,
  listFonts,
  listImages = () => [],
  listBackdrops = listImages,
  onChange = () => {},
  onError = () => {},
}) {
  const node = document.createElement("div");
  node.className = "dialog-editor";
  node.tabIndex = 0;

  const toolbar = document.createElement("div");
  toolbar.className = "dialog-editor__toolbar";

  const body = document.createElement("div");
  body.className = "dialog-editor__body";

  const list = document.createElement("aside");
  list.className = "dialog-editor__layers";

  const viewer = document.createElement("div");
  viewer.className = "dialog-editor__viewer";
  // Zoom and pan live on a wrapper. The transform stays off `.stage__frame`
  // itself: the runtime's frame must never be transformed, and keeping the two
  // separate makes it obvious which frame is the editor's own.
  const stageWrap = document.createElement("div");
  stageWrap.className = "dialog-editor__stage";
  const frame = document.createElement("div");
  frame.className = "stage__frame dialog-editor__frame";
  // The test picture, under everything. The plate is a transparent canvas, so
  // what sits behind it is what the author judges the text against. This layer
  // is chrome like the guides and the handles: the plate's layers are the only
  // thing the runtime draws.
  const backdropLayer = document.createElement("div");
  backdropLayer.className = "dialog-editor__backdrop";
  const plate = document.createElement("canvas");
  plate.className = "dialog-editor__plate";
  const overlay = document.createElement("div");
  overlay.className = "stage__layer stage__layer--dialogue";

  // A dashed outline per text block. The two regions are what the list offers
  // to drag, and without them the plate would show no sign of where the text
  // lands: the text itself is DOM the runtime fills, not something the plate
  // holds. Like the selection box, this is chrome — it is never written to the file.
  //
  // The dashes are all there is. Each block carries the sample words, so a
  // label naming the block would be pasted over the very thing it names; the
  // rows in the layer list already say which block is which. Nothing in this
  // layer captures pointer events, so a press falls through to the plate and picks
  // whatever shape is there — a region is picked from the list, and dragged
  // once it is.
  const guides = document.createElement("div");
  guides.className = "dialog-editor__regions";
  const guideNodes = new Map();
  for (const region of TEXT_REGIONS) {
    const guide = document.createElement("div");
    guide.className = "dialog-editor__region";
    guideNodes.set(region.key, guide);
    guides.append(guide);
  }

  // The selection box and its grips, above the plate. They are the designer's
  // own chrome, not part of the style: none of it is written to the file. The grips
  // are rebuilt per selection by `renderHandles`, since a polygon is dragged by
  // its own vertices rather than by the sides of its box.
  const handles = document.createElement("div");
  handles.className = "dialog-editor__handles";
  const selection = document.createElement("div");
  selection.className = "dialog-editor__selection";
  selection.hidden = true;
  handles.append(selection);

  // Editor-only chrome: a grid over the plate, and the alignment lines drawn
  // while a drag is in progress. Neither is part of a style file.
  const gridLayer = document.createElement("div");
  gridLayer.className = "dialog-editor__grid";
  gridLayer.hidden = true;
  const snapGuides = document.createElement("div");
  snapGuides.className = "dialog-editor__snap-guides";

  frame.append(backdropLayer, plate, gridLayer, overlay, guides, handles, snapGuides);
  stageWrap.append(frame);
  viewer.append(stageWrap);

  const props = document.createElement("aside");
  props.className = "dialog-editor__props";

  // --- panel headers ---
  //
  // 图层 and 属性 each get a header of their own. The layer list's carries the
  // restack / duplicate / delete actions — they sit beside the stack they act
  // on instead of on the toolbar — and both carry a collapse toggle. The panel
  // *bodies* are rebuilt on every render, so the header is built once and kept.
  const layersHead = document.createElement("div");
  layersHead.className = "dialog-editor__panel-head";
  const layersTitle = document.createElement("h3");
  layersTitle.className = "dialog-editor__panel-title";
  layersTitle.textContent = "图层";
  const layerActions = document.createElement("div");
  layerActions.className = "dialog-editor__panel-actions";
  const layersBody = document.createElement("div");
  layersBody.className = "dialog-editor__panel-body";

  const propsHead = document.createElement("div");
  propsHead.className = "dialog-editor__panel-head";
  const propsTitle = document.createElement("h3");
  propsTitle.className = "dialog-editor__panel-title";
  propsTitle.textContent = "属性";
  const propsBody = document.createElement("div");
  propsBody.className = "dialog-editor__panel-body";

  const layersToggle = panelToggle("layers", "chevrons-left", "收起图层");
  const propsToggle = panelToggle("props", "chevrons-right", "收起属性");

  // The four stack actions. Disabled when nothing is selected; kept in a list
  // so every render can refresh that without rebuilding the buttons.
  const layerActionButtons = [
    layerActionButton("arrow-up", "上移", "up"),
    layerActionButton("arrow-down", "下移", "down"),
    layerActionButton("copy", "复制", "duplicate"),
    layerActionButton("trash", "删除", "remove"),
  ];

  layersHead.append(layersTitle, layerActions, layersToggle);
  propsHead.append(propsTitle, propsToggle);
  list.append(layersHead, layersBody);
  props.append(propsHead, propsBody);

  body.append(list, viewer, props);
  node.append(toolbar, body);

  /** A collapse chevron for one panel. */
  function panelToggle(side, icon, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dialog-editor__panel-toggle";
    button.append(createIcon(icon));
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", "true");
    button.addEventListener("click", () => togglePanel(side));
    return button;
  }

  /** One icon button in the layer panel's header. */
  function layerActionButton(icon, label, command) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dialog-editor__button dialog-editor__button--compact";
    button.dataset.act = command;
    button.append(createIcon(icon));
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => runLayerCommand(command));
    layerActions.append(button);
    return button;
  }

  /** Collapses or expands the layer list or the property panel. */
  function togglePanel(side) {
    const collapsed = body.classList.toggle(`is-${side}-collapsed`);
    const panel = side === "layers" ? list : props;
    const toggle = side === "layers" ? layersToggle : propsToggle;
    panel.classList.toggle("is-collapsed", collapsed);
    if (side === "layers") {
      toggle.replaceChildren(createIcon(collapsed ? "chevrons-right" : "chevrons-left"));
    } else {
      toggle.replaceChildren(createIcon(collapsed ? "chevrons-left" : "chevrons-right"));
    }
    const label = `${collapsed ? "展开" : "收起"}${side === "layers" ? "图层" : "属性"}`;
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    // The viewer just changed width; the preview must be fitted to it again.
    fitFrame();
  }

  /** Sizes the preview frame to the room the viewer has, keeping the ratio. */
  function fitFrame() {
    const rect = viewer.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const viewerStyle = getComputedStyle(viewer);
    const padX = parseFloat(viewerStyle.paddingLeft) + parseFloat(viewerStyle.paddingRight);
    const padY = parseFloat(viewerStyle.paddingTop) + parseFloat(viewerStyle.paddingBottom);
    const availW = rect.width - padX;
    const availH = rect.height - padY;
    const canvasW = doc.canvas?.width || 16;
    const canvasH = doc.canvas?.height || 9;
    if (availW <= 0 || availH <= 0) {
      return;
    }
    // The largest box with the canvas' ratio that still fits both ways.
    let width = availW;
    let height = (width * canvasH) / canvasW;
    if (height > availH) {
      height = availH;
      width = (height * canvasW) / canvasH;
    }
    const fittedW = Math.max(1, Math.floor(width));
    const fittedH = Math.max(1, Math.floor(height));
    // The wrapper owns the fitted size so the flex centring still works when a
    // transform scales the frame beyond the viewer.
    stageWrap.style.width = `${fittedW}px`;
    stageWrap.style.height = `${fittedH}px`;
    frame.style.width = `${fittedW}px`;
    frame.style.height = `${fittedH}px`;
  }

  /** The right-click menu of the layer list: restack, copy, delete. */
  function openLayerMenu(x, y) {
    openContextMenu({
      x,
      y,
      items: [
        { label: "上移", command: "up" },
        { label: "下移", command: "down" },
        { label: "复制", command: "duplicate" },
        { separator: true },
        { label: "删除", command: "remove" },
      ],
    }).then((command) => {
      if (command) {
        runLayerCommand(command);
      }
    });
  }

  /** Runs one of the four stack actions on the current selection. */
  function runLayerCommand(command) {
    if (command === "remove") {
      removeSelected();
      return;
    }
    if (!selectedIds.size) {
      return;
    }
    if (command === "duplicate") {
      // `duplicateLayer` refuses anything that is not a layer, so the system
      // components — which cannot be added — fall through.
      recordStep();
      for (const id of selectedIds) {
        duplicateLayer(doc, id);
      }
      editList();
      return;
    }
    const step = command === "up" ? 1 : -1;
    recordStep();
    for (const id of selectedIds) {
      moveLayer(doc, id, step);
    }
    editList();
  }

  const preview = createDialogue({
    element: frame,
    node: overlay,
    resolveAsset,
    onError,
    // The plate underneath is the designer's own canvas, drawn with the same
    // painter the stage uses. Only the text is borrowed from the runtime.
    suppressFallback: true,
  });

  /** Decoded bitmaps for `image` layers, by project-relative path. */
  const images = new Map();

  /** The style file being edited, and the document read from it. */
  let stylePath = null;
  let doc = createDocument();
  let selectedIds = new Set();
  let lastSelected = null;
  let anchorId = null;
  // Editor-only viewing state: neither is written to the style file.
  let showGrid = false;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  // Built with the toolbar below; kept nullable so a view change made before
  // the toolbar exists cannot trip a temporal-dead-zone error.
  let zoomLabel = null;

  const context = () => {
    const canvas = plate.getContext("2d");
    canvas.imageSmoothingEnabled = true;
    return canvas;
  };

  /** A plate coordinate as a percentage of a canvas side, for the chrome. */
  const percent = (value, total) => (total ? (value / total) * 100 : 0);

  /**
   * The test backdrop: the path the author picked, and the data URL it read to.
   *
   * Deliberately outside `doc`. The backdrop is the editor's own picture rather
   * than a style field, so it is never serialised and never makes the file
   * dirty — which is also why it survives switching between style files.
   */
  let backdrop = "";
  let backdropUrl = "";

  /** Paths that failed to load, so `redraw` stops asking for them. */
  const broken = new Set();

  /**
   * Redraws the plate and the text over it.
   *
   * Any image layer whose bitmap is not in hand yet is fetched first; one that
   * failed is never asked for again, so a mistyped path does not refetch on
   * every keystroke, and its layer simply stays out of the drawing.
   */
  const redraw = () => {
    for (const layer of currentStyle(doc).layers) {
      if (layer.type === "image" && layer.source && !images.has(layer.source)) {
        loadBitmap(layer.source);
      }
    }

    draw(context(), doc, images);
    // The box's own geometry is written here rather than by the runtime alone,
    // so the selection follows a layer the moment its numbers change.
    renderHandles();
    // The runtime's own box, over the plate, with layers and old stamps left
    // out: this canvas is the plate while it is being edited, so the preview
    // must not paint a second one. Only the text geometry is handed over.
    preview.setStyle(textOnly(doc));
    // A style is a box, a face and a place, and an empty box shows none of the
    // three. The two blocks are filled with the sample words through the
    // runtime's own `sample`, so what the author reads is laid out exactly as a
    // script's line will be — shrink-to-fit included.
    //
    // What is previewed is the slot being edited: a narration line has no name,
    // and asking the runtime to draw one with a name would show the dialogue
    // box over the narration plate.
    if (doc.active === "narration") {
      preview.sample(null, SAMPLE_TEXT);
    } else {
      preview.sample(SAMPLE_SPEAKER, SAMPLE_TEXT);
    }
  };

  function loadBitmap(source) {
    Promise.resolve()
      .then(() => resolveAsset(source))
      .then(
        (url) =>
          new Promise((resolve, reject) => {
            const bitmap = new Image();
            bitmap.onload = () => resolve(bitmap);
            bitmap.onerror = () => reject(new Error(`无法加载图片：${source}`));
            bitmap.src = url;
          }),
      )
      .then((bitmap) => {
        images.set(source, bitmap);
        redraw();
      })
      .catch((error) => {
        // Only the drawing is held back: the layer keeps its path, so the
        // author can correct it instead of finding the layer emptied.
        broken.add(source);
        onError(error instanceof Error ? error.message : String(error));
      });
  }

  /** Monotonic document version, used to cache the dirty comparison. */
  let version = 0;

  /**
   * A document edit: the plate is redrawn and the caller told it may be dirty.
   *
   * The panels are deliberately not rebuilt here. Every field in them reports
   * through this, and replacing the input under the cursor would end the edit
   * after one keystroke.
   */
  const edit = () => {
    version += 1;
    redraw();
    onChange();
  };

  /**
   * Selection is now a set of ids, not a single one. `lastSelected` is the
   * "primary" — the layer whose values the property panel shows and edits when
   * several are selected — and `anchorId` anchors a Shift range.
   */
  const primaryId = () => {
    if (lastSelected != null && selectedIds.has(lastSelected)) {
      return lastSelected;
    }
    return selectedIds.values().next().value ?? null;
  };

  /** The order ids appear in the layer list: top of stack first, then system. */
  const layerOrderIds = () => [
    ...[...currentStyle(doc).layers].reverse().map((layer) => layer.id),
    ...SYSTEM_COMPONENTS.map((component) => component.id),
  ];

  const selectSingle = (id) => {
    selectedIds = new Set(id == null ? [] : [id]);
    lastSelected = id ?? null;
    anchorId = id ?? null;
    renderList();
    renderProps();
    renderHandles();
  };

  const toggleSelect = (id) => {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      if (lastSelected === id) {
        lastSelected = null;
      }
    } else {
      selectedIds.add(id);
      lastSelected = id;
    }
    if (anchorId == null) {
      anchorId = id;
    }
    renderList();
    renderProps();
    renderHandles();
  };

  const rangeSelect = (id) => {
    const order = layerOrderIds();
    if (anchorId == null || !order.includes(anchorId) || !order.includes(id)) {
      selectSingle(id);
      return;
    }
    const from = order.indexOf(anchorId);
    const to = order.indexOf(id);
    const [low, high] = from < to ? [from, to] : [to, from];
    for (let index = low; index <= high; index += 1) {
      selectedIds.add(order[index]);
    }
    lastSelected = id;
    renderList();
    renderProps();
    renderHandles();
  };

  // `select` stays as the single-select the canvas and toolbar reach for.
  const select = selectSingle;

  // --- undo / redo ---

  const history = createHistory();
  const recordStep = () => record(history, doc);

  // 连续编辑（拖动滑块、连续输入）只记一步撤销：第一次改动记快照，
  // 停手 300ms 后的下一次改动重新记。
  let applying = false;
  let applyingTimer = 0;
  const beginApply = () => {
    if (!applying) {
      recordStep();
      applying = true;
    }
    clearTimeout(applyingTimer);
    applyingTimer = setTimeout(() => {
      applying = false;
    }, 300);
  };

  const applyHistory = (snapshot) => {
    version += 1;
    doc = snapshot;
    for (const id of [...selectedIds]) {
      if (!findLayer(doc, id) && !SYSTEM_COMPONENTS.some((component) => component.id === id)) {
        selectedIds.delete(id);
      }
    }
    lastSelected = selectedIds.has(lastSelected) ? lastSelected : selectedIds.values().next().value ?? null;
    renderList();
    renderProps();
    renderHandles();
    redraw();
    onChange();
  };
  const undo = () => {
    const snapshot = undoHistory(history, doc);
    if (snapshot) {
      applyHistory(snapshot);
    }
  };
  const redo = () => {
    const snapshot = redoHistory(history, doc);
    if (snapshot) {
      applyHistory(snapshot);
    }
  };
  const removeSelected = () => {
    const layers = [...selectedIds].map((id) => findLayer(doc, id)).filter(Boolean);
    if (!layers.length) {
      return;
    }
    recordStep();
    for (const layer of layers) {
      removeLayer(doc, layer.id);
    }
    selectedIds.clear();
    lastSelected = null;
    anchorId = null;
    editList();
  };

  /**
   * Paints the test backdrop under the plate, or clears it.
   *
   * The path is read the way an image layer's is, so a project-relative path
   * means the same thing in both places. A picture that will not load only
   * leaves the backdrop empty and says why: nothing else in the document
   * depends on it.
   */
  const renderBackdrop = () => {
    backdropLayer.style.backgroundImage = backdropUrl ? `url("${backdropUrl}")` : "none";
  };

  /** Picks the test picture, or clears it with an empty path. */
  const setBackdrop = (path) => {
    backdrop = path ?? "";
    backdropUrl = "";
    renderBackdrop();
    if (!backdrop) {
      return;
    }

    Promise.resolve()
      .then(() => resolveAsset(backdrop))
      .then((url) => {
        // A second pick can land while this one is still reading, so a reply
        // for a picture that is no longer chosen is dropped.
        if (backdrop !== path) {
          return;
        }
        backdropUrl = url;
        renderBackdrop();
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  };

  /**
   * Places the two text regions as dashed boxes over the plate.
   *
   * The text itself is the runtime's DOM, so the plate holds no sign of where
   * it lands; these outlines are that sign, and the one whose region is
   * selected is the one drawn in the accent. Like the selection box they are
   * chrome — percentages of the frame, never written to the file — and they carry no words
   * of their own: the sample text inside each block says which block it is.
   */
  const renderRegions = () => {
    const { width, height } = doc.canvas;
    const style = currentStyle(doc);
    for (const region of TEXT_REGIONS) {
      const guide = guideNodes.get(region.key);
      const box = normalBox(style[region.key]);
      guide.style.left = `${percent(box.x, width)}%`;
      guide.style.top = `${percent(box.y, height)}%`;
      guide.style.width = `${percent(box.width, width)}%`;
      guide.style.height = `${percent(box.height, height)}%`;
      guide.classList.toggle("is-selected", selectedIds.has(region.id));
    }
  };

  /**
   * Rebuilds the selection chrome over whatever is selected.
   *
   * The box is written as percentages of the frame — the way the runtime writes
   * the dialogue boxes — so it follows the plate as the window resizes without
   * measuring anything. A hidden layer shows no box, since nothing on the plate
   * would be dragged.
   *
   * The grips are rebuilt here rather than kept around, because what they are
   * depends on the shape: a box is resized from its sides and corners, while a
   * polygon has no sides to grab and is dragged vertex by vertex instead. A
   * layer also gets a turn grip above it. A text block resizes like a box —
   * its box is part of the style the runtime reads — but does not turn, since
   * a text block has no angle to store.
   */
  function renderHandles() {
    handles.replaceChildren();
    renderRegions();

    // Every selected thing that owns a box (a layer or a text region, never the
    // backdrop) gets chrome. One selection shows the full grips; many show an
    // outline each, since grips on every one would just be visual clutter — moving is the
    // only thing several at once are good for.
    const selected = [...selectedIds]
      .map((id) => ({ id, sel: selectionFor(doc, id) }))
      .filter(({ sel }) => sel && sel.kind !== "backdrop" && !(sel.kind === "layer" && sel.layer.visible === false));

    if (!selected.length) {
      selection.hidden = true;
      return;
    }

    if (selected.length === 1) {
      handles.append(selection);
      selection.hidden = false;
      selection.replaceChildren();
      const { sel } = selected[0];
      const rotation = sel.kind === "layer" ? sel.layer.rotation ?? 0 : 0;
      const box = selectionBox(sel);
      const { width, height } = doc.canvas;
      selection.style.left = `${percent(box.x, width)}%`;
      selection.style.top = `${percent(box.y, height)}%`;
      selection.style.width = `${percent(box.width, width)}%`;
      selection.style.height = `${percent(box.height, height)}%`;
      selection.style.transform = rotation ? `rotate(${rotation}deg)` : "";

      if (sel.kind === "layer") {
        // The turn grip hangs outside the box, so that a corner grip can go on
        // resizing: a shape is turned by a grip of its own rather than by the
        // corners it is scaled from.
        const turn = document.createElement("div");
        turn.className = "dialog-editor__handle dialog-editor__handle--rotate";
        turn.dataset.rotate = "1";
        turn.title = "拖动旋转";
        selection.append(turn);
      }

      if (sel.kind === "layer" && sel.layer.type === "polygon") {
        // The vertices are the shape, so they are the handles: each is placed in
        // the box's own space, which the box's own rotation then carries.
        (sel.layer.points ?? []).forEach((point, index) => {
          const grip = document.createElement("div");
          grip.className = "dialog-editor__handle dialog-editor__handle--vertex";
          grip.dataset.vertex = String(index);
          grip.style.left = `${percent(point.x - box.x, box.width)}%`;
          grip.style.top = `${percent(point.y - box.y, box.height)}%`;
          selection.append(grip);
        });
        return;
      }

      for (const name of HANDLES) {
        const grip = document.createElement("div");
        grip.className = `dialog-editor__handle dialog-editor__handle--${name}`;
        grip.dataset.handle = name;
        selection.append(grip);
      }
      return;
    }

    selection.hidden = true;
    for (const { sel } of selected) {
      const box = selectionBox(sel);
      const { width, height } = doc.canvas;
      const outline = document.createElement("div");
      outline.className = "dialog-editor__selection dialog-editor__selection--multi";
      outline.style.left = `${percent(box.x, width)}%`;
      outline.style.top = `${percent(box.y, height)}%`;
      outline.style.width = `${percent(box.width, width)}%`;
      outline.style.height = `${percent(box.height, height)}%`;
      const rotation = sel.kind === "layer" ? sel.layer.rotation ?? 0 : 0;
      outline.style.transform = rotation ? `rotate(${rotation}deg)` : "";
      handles.append(outline);
    }
  }

  /** A change that both redraws and reshapes the layer list. */
  const editList = () => {
    renderList();
    edit();
  };

  // --- alignment ---

  /** Lines worth snapping to: the frame, both text blocks and the other layers. */
  const snapLines = (excludeIds) => {
    const vertical = [0, doc.canvas.width / 2, doc.canvas.width];
    const horizontal = [0, doc.canvas.height / 2, doc.canvas.height];
    const add = (box) => {
      const b = normalBox(box);
      vertical.push(b.x, b.x + b.width / 2, b.x + b.width);
      horizontal.push(b.y, b.y + b.height / 2, b.y + b.height);
    };
    const style = currentStyle(doc);
    if (style.speaker) {
      add(style.speaker);
    }
    if (style.text) {
      add(style.text);
    }
    for (const layer of style.layers ?? []) {
      if (layer.visible === false || excludeIds.has(layer.id)) {
        continue;
      }
      add(layer);
    }
    return { vertical, horizontal };
  };

  /** Eight screen pixels, expressed in document units at the current zoom. */
  const snapThreshold = () => {
    const rect = frame.getBoundingClientRect();
    if (!rect.width) {
      return 8;
    }
    return Math.min(24, (8 * doc.canvas.width) / rect.width);
  };

  /** The shift that snaps a dragged box, and the lines it hit. */
  const snapFor = (target, x, y, excludeIds) => {
    const box = normalBox({ x, y, width: target.width, height: target.height });
    const snapped = snapBox(box, snapLines(excludeIds), snapThreshold());
    return { x: snapped.x, y: snapped.y, guides: snapped.guides };
  };

  const clearSnapGuides = () => snapGuides.replaceChildren();

  const renderSnapGuides = (guides) => {
    clearSnapGuides();
    for (const value of guides.vertical) {
      const line = document.createElement("div");
      line.className = "dialog-editor__snap-line dialog-editor__snap-line--v";
      line.style.left = `${percent(value, doc.canvas.width)}%`;
      snapGuides.append(line);
    }
    for (const value of guides.horizontal) {
      const line = document.createElement("div");
      line.className = "dialog-editor__snap-line dialog-editor__snap-line--h";
      line.style.top = `${percent(value, doc.canvas.height)}%`;
      snapGuides.append(line);
    }
  };

  // --- zoom and pan ---

  /** Applies the view state to the wrapper; `frame` itself stays untransformed. */
  const applyView = () => {
    stageWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  };

  const renderZoomLabel = () => {
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    }
  };

  const setZoom = (next) => {
    zoom = Math.min(4, Math.max(0.25, next));
    applyView();
    renderZoomLabel();
  };

  const resetView = () => {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyView();
    renderZoomLabel();
  };

  /** Middle-drag pans the fitted frame when it is zoomed past the viewer. */
  const beginPan = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const fromX = panX;
    const fromY = panY;
    const id = event.pointerId;
    frame.setPointerCapture?.(id);
    const onMove = (moveEvent) => {
      panX = fromX + moveEvent.clientX - startX;
      panY = fromY + moveEvent.clientY - startY;
      applyView();
    };
    const finish = () => {
      frame.removeEventListener("pointermove", onMove);
      frame.removeEventListener("pointerup", finish);
      frame.removeEventListener("pointercancel", finish);
      frame.releasePointerCapture?.(id);
    };
    frame.addEventListener("pointermove", onMove);
    frame.addEventListener("pointerup", finish);
    frame.addEventListener("pointercancel", finish);
  };

  viewer.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // --- pointer ---

  /** Whole logical units, so the property fields show numbers, not decimals. */
  const round = (value) => Math.round(value);

  /**
   * Where a pointer event falls on the plate, in the document's coordinates.
   *
   * The frame keeps the canvas' aspect ratio, so one scale serves both axes.
   * A frame with no size — the view hidden — answers `null` instead of dividing
   * by zero.
   */
  const pointFrom = (event) => {
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }
    return {
      x: ((event.clientX - rect.left) / rect.width) * doc.canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * doc.canvas.height,
    };
  };

  /**
   * Runs `apply` on every pointer move until the pointer is released.
   *
   * The pointer is captured on the frame, so a drag that runs off the plate
   * keeps reporting: without it the box would stop following the cursor at the
   * frame's edge.
   */
  const drag = (event, apply) => {
    event.preventDefault();
    const id = event.pointerId;
    frame.setPointerCapture?.(id);

    const onMove = (moveEvent) => {
      const point = pointFrom(moveEvent);
      if (point) {
        apply(point);
      }
    };
    const finish = () => {
      frame.removeEventListener("pointermove", onMove);
      frame.removeEventListener("pointerup", finish);
      frame.removeEventListener("pointercancel", finish);
      frame.releasePointerCapture?.(id);
      clearSnapGuides();
    };

    frame.addEventListener("pointermove", onMove);
    frame.addEventListener("pointerup", finish);
    frame.addEventListener("pointercancel", finish);
  };

  /**
   * Puts a movable thing at `x`, `y`.
   *
   * It moves by the difference rather than being assigned to, so a polygon's
   * vertices come along: they are absolute, and the box is only where they say.
   * A text block has no vertices, so the same call is just the assignment.
   */
  const placeAt = (target, x, y) => translateLayer(target, x - target.x, y - target.y);

  /** Slides what was grabbed, so the point the drag started on stays under it. */
  const beginMove = (event, target, origin) => {
    // Moving one of several selected layers drags them all together. The
    // grabbed one leads, so its box is the one the alignment lines are measured
    // against and the whole selection moves by the same shift.
    const movers = selectedIds.size > 1 && selectedIds.has(target.id)
      ? [target, ...[...selectedIds]
          .filter((id) => id !== target.id)
          .map((id) => findLayer(doc, id))
          .filter(Boolean)]
      : [target];
    const froms = movers.map((mover) => ({ x: mover.x, y: mover.y }));
    const excluded = new Set(movers.map((mover) => mover.id).filter(Boolean));
    recordStep();
    drag(event, (point) => {
      const delta = toLocalDelta(target.rotation, point.x - origin.x, point.y - origin.y);
      const snap = snapFor(target, froms[0].x + delta.x, froms[0].y + delta.y, excluded);
      movers.forEach((mover, index) => placeAt(
        mover,
        round(froms[index].x + delta.x + snap.x),
        round(froms[index].y + delta.y + snap.y),
      ));
      renderSnapGuides(snap.guides);
      edit();
    });
  };

  /** Resizes a layer from the grip that was grabbed. */
  const beginResize = (event, layer, handle, origin) => {
    recordStep();
    const box = { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
    drag(event, (point) => {
      const delta = toLocalDelta(layer.rotation, point.x - origin.x, point.y - origin.y);
      const next = resizeBox(box, handle, delta.x, delta.y);
      // `resizeLayerBox` rather than a field assignment: a polygon's vertices
      // have to be scaled with the box, or the shape would sit still while the
      // frame drawn around it moved.
      resizeLayerBox(layer, {
        x: round(next.x),
        y: round(next.y),
        width: round(next.width),
        height: round(next.height),
      });
      edit();
    });
  };

  /** Drags one vertex of a polygon, leaving every other vertex where it is. */
  const beginVertex = (event, layer, index, origin) => {
    const vertex = layer.points?.[index];
    if (!vertex) {
      return;
    }
    recordStep();
    const from = { x: vertex.x, y: vertex.y };
    drag(event, (point) => {
      const delta = toLocalDelta(layer.rotation, point.x - origin.x, point.y - origin.y);
      moveVertex(layer, index, round(from.x + delta.x), round(from.y + delta.y));
      edit();
    });
  };

  /**
   * Turns a layer about the centre of its own box.
   *
   * What is measured is the pointer's swing, not the offset it travelled: the
   * angle from the box's centre at the press is subtracted from the angle there
   * now, and that difference is added to the angle the layer already had. So
   * the shape follows the pointer round instead of being pushed sideways by it,
   * and grabbing the grip anywhere leaves the shape's own turn intact.
   */
  const beginRotate = (event, layer, origin) => {
    recordStep();
    const box = normalBox(layer);
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const from = layer.rotation ?? 0;
    const startAngle = angleFrom(centre, origin.x, origin.y);
    drag(event, (point) => {
      layer.rotation = round(rotationFrom(from, startAngle, angleFrom(centre, point.x, point.y)));
      edit();
    });
  };


  // A press picks what is under it and starts dragging; a press on a grip
  // resizes — or, on a polygon, moves that one vertex. What is already selected
  // is checked before the plate, so a box covered by the layer above it still
  // drags the one the panel is showing.
  frame.addEventListener("pointerdown", (event) => {
    node.focus({ preventScroll: true });
    if (event.button === 1) {
      beginPan(event);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const point = pointFrom(event);
    if (!point) {
      return;
    }

    const element = event.target instanceof Element ? event.target : null;
    const grip = element?.closest(".dialog-editor__handle") ?? null;
    const current = primaryId() ? selectionFor(doc, primaryId()) : null;

    // A grip belongs to whatever is selected, and a text block is dragged by
    // its box the same way a layer is: `resizeLayerBox` only scales vertices
    // for a polygon, so on a block it is the plain assignment it looks like.
    if (grip && (current?.kind === "layer" || current?.kind === "region")) {
      const target = current.kind === "layer" ? current.layer : current.block;
      if (current.kind === "layer" && grip.dataset.rotate !== undefined) {
        beginRotate(event, current.layer, point);
      } else if (current.kind === "layer" && grip.dataset.vertex !== undefined) {
        beginVertex(event, current.layer, Number(grip.dataset.vertex), point);
      } else if (grip.dataset.handle) {
        beginResize(event, target, grip.dataset.handle, point);
      }
      return;
    }

    // 辅助线图层不捕获指针事件，按下操作始终落在下层元素。
    // a shape or on bare plate. A region is picked from the layer list and
    // dragged from inside its own dashes once it is selected.
    if (current?.kind === "layer" && current.layer.visible !== false) {
      const local = toLocalPoint(current.layer, point.x, point.y);
      if (containsPoint(current.layer, local.x, local.y)) {
        beginMove(event, current.layer, point);
        return;
      }
    }

    if (current?.kind === "region" && containsPoint(current.block, point.x, point.y)) {
      beginMove(event, current.block, point);
      return;
    }

    const id = hitTest(doc, point.x, point.y);
    select(id);
    const picked = id ? findLayer(doc, id) : null;
    if (picked) {
      beginMove(event, picked, point);
    }
  });

  // --- keyboard ---

  /** How one arrow press moves a selection, in logical canvas units. */
  const NUDGE = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };

  /** Copied layers. Kept in the editor: a project-relative image path in a
      layer means nothing on the system clipboard, and pasting into a different
      style slot is the common case. */
  let clipboard = [];

  /** Moves everything selected by one step; Shift takes ten. */
  const nudgeSelection = (key, step) => {
    const delta = NUDGE[key];
    if (!delta) {
      return false;
    }
    const movers = [...selectedIds]
      .map((id) => selectionFor(doc, id))
      .filter((picked) => picked && (picked.kind === "layer" || picked.kind === "region"))
      .map((picked) => (picked.kind === "layer" ? picked.layer : picked.block));
    if (!movers.length) {
      return false;
    }
    // A run of arrow presses is one edit, so a single undo takes it all back.
    beginApply();
    for (const mover of movers) {
      translateLayer(mover, delta[0] * step, delta[1] * step);
    }
    edit();
    renderProps();
    return true;
  };

  /** Remembers the selected layers, in stack order. */
  const copySelection = () => {
    const layers = [...selectedIds].map((id) => findLayer(doc, id)).filter(Boolean);
    if (!layers.length) {
      return false;
    }
    clipboard = layers.map((layer) => structuredClone(layer));
    return true;
  };

  /** Puts the copied layers on top of the current slot, with ids of their own. */
  const pasteSelection = () => {
    if (!clipboard.length) {
      return false;
    }
    recordStep();
    const { layers } = currentStyle(doc);
    const pasted = [];
    for (const source of clipboard) {
      const copy = structuredClone(source);
      copy.id = uniqueLayerId(doc);
      copy.x += COPY_OFFSET;
      copy.y += COPY_OFFSET;
      // The vertices are the shape for a polygon, so they travel with the box.
      for (const point of copy.points ?? []) {
        point.x += COPY_OFFSET;
        point.y += COPY_OFFSET;
      }
      layers.push(copy);
      pasted.push(copy.id);
    }
    selectedIds = new Set(pasted);
    lastSelected = pasted[pasted.length - 1] ?? null;
    anchorId = lastSelected;
    editList();
    return true;
  };

  // Undo / redo / delete / nudge / copy / paste, caught on the editor root so
  // they fire only when the designer — not a text field inside it — has focus.
  node.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    } else if (mod && (event.key === "y" || event.key === "Y")) {
      event.preventDefault();
      redo();
    } else if (mod && (event.key === "c" || event.key === "C")) {
      if (copySelection()) {
        event.preventDefault();
      }
    } else if (mod && (event.key === "v" || event.key === "V")) {
      if (pasteSelection()) {
        event.preventDefault();
      }
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedIds.size) {
        event.preventDefault();
        removeSelected();
      }
    } else if (NUDGE[event.key]) {
      if (nudgeSelection(event.key, event.shiftKey ? 10 : 1)) {
        event.preventDefault();
      }
    }
  });

  // --- toolbar ---

  // Which style is being edited. The two are kept whole and apart, so switching
  // is only a matter of which one every other call reads; what was selected in
  // the one left behind means nothing in the one arrived at, so the selection
  // is dropped on the way across.
  const setSlot = (slot) => {
    if (!STYLE_SLOTS.includes(slot) || doc.active === slot) {
      return;
    }
    doc.active = slot;
    selectedIds.clear();
    lastSelected = null;
    anchorId = null;
    renderSlots();
    renderList();
    renderProps();
    renderHandles();
    redraw();
    onChange();
  };

  const slotButtons = STYLE_SLOTS.map((slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dialog-editor__button dialog-editor__button--slot";
    button.dataset.slot = slot;
    const label = STYLE_SLOT_LABELS[slot] ?? slot;
    button.append(createIcon(SLOT_ICONS[slot] ?? "message-square"));
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => setSlot(slot));
    toolbar.append(button);
    return button;
  });

  /**
   * 标记正在编辑的插槽，并禁用无目标的副本。
   */
  function renderSlots() {
    for (const button of slotButtons) {
      const active = button.dataset.slot === doc.active;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    for (const button of copyButtons) {
      button.disabled = button.dataset.copy === doc.active;
    }
  }

  const spacer = document.createElement("span");
  spacer.className = "dialog-editor__spacer";
  toolbar.append(spacer);

  const copyButtons = STYLE_SLOTS.map((slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dialog-editor__button dialog-editor__button--copy";
    button.dataset.copy = slot;
    const label = STYLE_SLOT_LABELS[slot] ?? slot;
    // Two glyphs: the slot the copy lands in, plus an arrow saying "copy over".
    button.append(createIcon(SLOT_ICONS[slot] ?? "message-square"), createIcon("arrow-right"));
    button.title = `复制到${label}`;
    button.setAttribute("aria-label", `复制到${label}`);
    button.addEventListener("click", () => {
      recordStep();
      if (!copyStyleTo(doc, slot)) {
        // Nothing actually changed; drop the snapshot we just pushed.
        history.past.pop();
        return;
      }
      // The copy lands in the slot that is not being edited, so the plate on
      // screen does not change — but the file does.
      edit();
    });
    toolbar.append(button);
    return button;
  });

  for (const type of LAYER_TYPES) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "dialog-editor__button";
    add.dataset.add = type;
    const label = LAYER_TYPE_LABELS[type] ?? type;
    add.append(createIcon(LAYER_ICONS[type] ?? "plus"));
    add.title = `添加${label}`;
    add.setAttribute("aria-label", `添加${label}`);
    add.addEventListener("click", () => {
      recordStep();
      const layer = addLayer(doc, type);
      selectSingle(layer.id);
      edit();
    });
    toolbar.append(add);
  }

  // View controls: grid, zoom out, the current zoom (click to reset), zoom in.
  const viewSpacer = document.createElement("span");
  viewSpacer.className = "dialog-editor__spacer";
  toolbar.append(viewSpacer);

  const viewButton = (label, title, run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dialog-editor__button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", run);
    toolbar.append(button);
    return button;
  };

  const gridButton = viewButton("网格", "显示网格（仅编辑辅助）", () => {
    showGrid = !showGrid;
    gridLayer.hidden = !showGrid;
    gridButton.setAttribute("aria-pressed", String(showGrid));
    gridButton.classList.toggle("is-active", showGrid);
  });
  gridButton.setAttribute("aria-pressed", "false");
  viewButton("−", "缩小画布（Ctrl + 滚轮）", () => setZoom(zoom / 1.25));
  zoomLabel = viewButton("100%", "重置为 100%", resetView);
  viewButton("+", "放大画布（Ctrl + 滚轮）", () => setZoom(zoom * 1.25));

  // --- layer list ---

  /** Redraws the layer rows, top of the stack first. */
  function renderList() {
    layersBody.replaceChildren();
    // The header actions are only meaningful with something selected.
    for (const button of layerActionButtons) {
      button.disabled = selectedIds.size === 0;
    }

    if (!currentStyle(doc).layers.length) {
      const empty = document.createElement("p");
      empty.className = "dialog-editor__hint";
      empty.textContent = "还没有图层。用上面的按钮添加形状。";
      layersBody.append(empty);
    }

    // Painted last is on top, so the list reads bottom-up: the topmost layer is
    // the first row, which is how every drawing tool presents a stack.
    for (const layer of [...currentStyle(doc).layers].reverse()) {
      const row = document.createElement("div");
      row.className = "dialog-editor__layer";
      row.dataset.id = layer.id;
      if (selectedIds.has(layer.id)) {
        row.classList.add("is-selected");
      }

      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "dialog-editor__eye";
      eye.dataset.visible = String(layer.visible !== false);
      eye.title = layer.visible === false ? "显示" : "隐藏";
      eye.textContent = layer.visible === false ? "○" : "●";
      eye.addEventListener("click", (event) => {
        event.stopPropagation();
        layer.visible = layer.visible === false;
        editList();
      });

      const label = document.createElement("span");
      label.className = "dialog-editor__layer-name";
      label.textContent = layer.name || LAYER_TYPE_LABELS[layer.type] || layer.type;

      row.append(eye, label);
      row.addEventListener("click", (event) => {
        node.focus({ preventScroll: true });
        if (event.ctrlKey || event.metaKey) {
          toggleSelect(layer.id);
        } else if (event.shiftKey) {
          rangeSelect(layer.id);
        } else {
          selectSingle(layer.id);
        }
      });
      // Right-clicking a row acts on that layer: a row not already selected is
      // picked first, so the menu never restacks something else.
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (!selectedIds.has(layer.id)) {
          selectSingle(layer.id);
        }
        openLayerMenu(event.clientX, event.clientY);
      });
      layersBody.append(row);
    }

    // The system components are listed last and set apart, because they are not
    // layers: none of them is painted on the plate and none can be reordered or
    // removed. The two text blocks are here to be selected and dragged — the
    // only handle the author has on where the text lands — and the backdrop is
    // here to be picked, so the text can be judged over a real picture.
    const divider = document.createElement("h3");
    divider.className = "dialog-editor__heading dialog-editor__heading--spaced";
    divider.textContent = "系统组件";
    layersBody.append(divider);

    for (const component of SYSTEM_COMPONENTS) {
      const row = document.createElement("div");
      row.className = "dialog-editor__layer dialog-editor__layer--system";
      row.dataset.id = component.id;
      if (selectedIds.has(component.id)) {
        row.classList.add("is-selected");
      }

      const mark = document.createElement("span");
      mark.className = "dialog-editor__sys-mark";
      mark.textContent = component.mark;

      const label = document.createElement("span");
      label.className = "dialog-editor__layer-name";
      label.textContent = component.name;

      row.append(mark, label);
      row.addEventListener("click", (event) => {
        node.focus({ preventScroll: true });
        if (event.ctrlKey || event.metaKey) {
          toggleSelect(component.id);
        } else if (event.shiftKey) {
          rangeSelect(component.id);
        } else {
          selectSingle(component.id);
        }
      });
      layersBody.append(row);
    }
  }

  // --- properties ---

  /** The fields for the selected layer, or for every selected layer at once. */
  function layerSection(layer) {
    // With several layers selected, every field edits all of them; the panel
    // shows the primary's values. `group` is the layers to write back to.
    const group = selectedIds.size > 1
      ? [...selectedIds].map((id) => findLayer(doc, id)).filter(Boolean)
      : [layer];

    // Records one undo step, then writes the same change to every layer.
    const applyAll = (mutate) => {
      recordStep();
      for (const target of group) {
        mutate(target);
      }
      edit();
    };

    /**
     * Applies one numeric field to every selected layer.
     *
     * A polygon's box is a cache of its vertices, so its position and size go
     * through the same helper a grip drag uses: assigning `x` on its own would
     * leave the shape behind while the frame around it moved. Rotation is not
     * part of the box and is stored straight either way.
     */
    const setNumber = (key, value) => {
      applyAll((target) => {
        if (target.type !== "polygon" || key === "rotation") {
          updateLayer(doc, target.id, { [key]: value });
        } else {
          const box = { x: target.x, y: target.y, width: target.width, height: target.height };
          resizeLayerBox(target, { ...box, [key]: value });
        }
      });
    };

    const numeric = (label, key, options = {}) => ({
      kind: "number",
      label,
      value: layer[key],
      step: options.step ?? 1,
      min: options.min,
      max: options.max,
      onChange: (value) => setNumber(key, value),
    });

    // One field, labelled. `pair` already answers a finished row; everything
    // else below is a bare spec, and a spec appended as it stands is appended
    // as a *string* — the field it describes would be missing from the panel
    // and a `[object Object]` would sit where it should have been.
    const property = (spec) => field(spec.label, control(spec));

    const specs = [
      {
        kind: "text",
        label: "名称",
        value: layer.name,
        // The row in the layer list carries the same name, so the list — and
        // only the list — is rebuilt to keep the two in step.
        onChange: (value) => {
          applyAll((target) => updateLayer(doc, target.id, { name: value }));
          renderList();
        },
      },
      {
        kind: "number",
        label: "不透明度",
        value: layer.opacity ?? 1,
        step: 0.05,
        min: 0,
        max: 1,
        onChange: (value) => applyAll((target) => updateLayer(doc, target.id, { opacity: Math.min(1, Math.max(0, value)) })),
      },
    ];

    const geometry = [
      pair(
        { first: "x", second: "y" },
        numeric("x", "x"),
        numeric("y", "y"),
      ),
      pair(
        { first: "宽", second: "高" },
        numeric("宽", "width"),
        numeric("高", "height"),
      ),
      property(numeric("旋转", "rotation", { step: 1 })),
    ];

    if (layer.type === "rect" || layer.type === "ellipse" || layer.type === "polygon") {
      geometry.push(
        property({
          kind: "color",
          label: "填充",
          value: layer.fill ?? "#000000",
          onChange: (value) => applyAll((target) => updateLayer(doc, target.id, { fill: value })),
        }),
        property({
          kind: "color",
          label: "描边",
          value: layer.stroke?.color ?? "#ffffff",
          onChange: (value) => applyAll((target) => updateLayer(doc, target.id, { stroke: { color: value } })),
        }),
        property({
          kind: "number",
          label: "描边宽",
          value: layer.stroke?.width ?? 0,
          min: 0,
          onChange: (value) => applyAll((target) => updateLayer(doc, target.id, { stroke: { width: value } })),
        }),
      );
    }

    if (layer.type === "rect") {
      geometry.push(property({
        kind: "number",
        label: "圆角",
        value: layer.radius ?? 0,
        min: 0,
        onChange: (value) => applyAll((target) => updateLayer(doc, target.id, { radius: value })),
      }));
    }

    if (layer.type === "line") {
      geometry.push(
        property({
          kind: "color",
          label: "颜色",
          value: layer.color ?? "#ffffff",
          onChange: (value) => applyAll((target) => updateLayer(doc, target.id, { color: value })),
        }),
        property({
          kind: "number",
          label: "粗细",
          value: layer.thickness ?? 1,
          min: 1,
          onChange: (value) => applyAll((target) => updateLayer(doc, target.id, { thickness: value })),
        }),
      );
    }

    if (layer.type === "polygon") {
      // A polygon is rebuilt as a whole rather than nudged, so this is the one
      // shape whose field does not go through `updateLayer`: the sides are not
      // stored, the vertices are.
      geometry.push(property({
        kind: "number",
        label: "边数",
        value: layer.points?.length ?? DEFAULT_POLYGON_SIDES,
        step: 1,
        min: MIN_POLYGON_SIDES,
        max: MAX_POLYGON_SIDES,
        onChange: (value) => {
          recordStep();
          for (const target of group) {
            setPolygonSides(target, value);
          }
          edit();
        },
      }));
    }

    if (layer.type === "image") {
      // A picture path is picked from what the project actually holds, not
      // entered without a picker: the author asked to "import" an image and got a text box
      // whose every value came back as "not found", because a bare name is
      // resolved under `assets/` and the field gave no sign of that. The list is
      // the interface's own folder — `assets/ui/`, the frames and furniture a
      // dialogue box is built from, which is what a layer here places — with the
      // current value kept selectable even when the tree no longer lists it, and
      // a free-text field beside it for a path that is not in the list yet.
      const paths = listImages();
      const options = [{ value: "", label: "无" }];
      for (const path of paths) {
        options.push({ value: path, label: path });
      }
      const current = String(layer.source ?? "");
      if (current && !paths.includes(current)) {
        // A path the tree does not list stays selectable rather than being
        // silently dropped: the file may be back after a rescan, and the author
        // typed it for a reason.
        options.push({ value: current, label: current });
      }
      geometry.push(
        field("图片", control({
          kind: "select",
          value: current,
          options,
          onChange: (value) => applyAll((target) => {
            updateLayer(doc, target.id, { source: value });
            // A path that failed before may be the one just picked, so the
            // "never ask again" memory is dropped with the new value.
            if (value) broken.delete(value);
          }),
        })),
        field("图片路径", control({
          kind: "text",
          value: current,
          onChange: (value) => applyAll((target) => {
            updateLayer(doc, target.id, { source: value });
            if (value) broken.delete(value);
          }),
        })),
      );
    }

    const box = document.createElement("section");
    box.className = "dialog-editor__section";
    const heading = document.createElement("h3");
    heading.className = "dialog-editor__heading";
    heading.textContent = "形状";
    // Both lists hold finished rows by the time they get here — `geometry` is
    // built from `property`, and `pair` answers a row — so this is a plain
    // append and every field in it is a field, not a spec spelled out.
    box.append(heading, ...specs.map(property), ...geometry);
    if (group.length > 1) {
      const note = document.createElement("p");
      note.className = "dialog-editor__hint";
      note.textContent = `已选中 ${group.length} 个图层，改动将应用到全部。`;
      box.append(note);
    }
    return box;
  }

  /** The fields for one text block: the name plate or the line. */
  function textSection(title, key, families) {
    const block = currentStyle(doc)[key];
    const set = (patch) => {
      Object.assign(block, patch);
      edit();
    };
    const setFont = (patch) => set({ font: { ...block.font, ...patch } });

    const box = document.createElement("section");
    box.className = "dialog-editor__section";
    const heading = document.createElement("h3");
    heading.className = "dialog-editor__heading";
    heading.textContent = title;
    box.append(heading);

    box.append(
      pair(
        { first: "x", second: "y" },
        {
          kind: "number",
          label: "x",
          value: block.x,
          onChange: (value) => set({ x: value }),
        },
        {
          kind: "number",
          label: "y",
          value: block.y,
          onChange: (value) => set({ y: value }),
        },
      ),
      pair(
        { first: "宽", second: "高" },
        {
          kind: "number",
          label: "宽",
          value: block.width,
          onChange: (value) => set({ width: value }),
        },
        {
          kind: "number",
          label: "高",
          value: block.height,
          onChange: (value) => set({ height: value }),
        },
      ),
    );

    const familyOptions = families.map((family) => ({ value: family, label: family }));
    if (block.font.family && !families.includes(block.font.family)) {
      // The file may name a face the machine does not have; it is kept and
      // shown, so opening a file never silently rewrites its font.
      familyOptions.unshift({ value: block.font.family, label: block.font.family });
    }
    box.append(
      field("字体", control({
        kind: "select",
        value: block.font.family,
        options: familyOptions,
        onChange: (value) => setFont({ family: value }),
      })),
      pair(
        { first: "字号", second: "行高" },
        {
          kind: "number",
          label: "字号",
          value: block.font.size,
          min: 1,
          onChange: (value) => setFont({ size: value }),
        },
        {
          kind: "number",
          label: "行高",
          value: block.lineHeight ?? 1.4,
          step: 0.1,
          min: 0.5,
          onChange: (value) => set({ lineHeight: value }),
        },
      ),
      pair(
        { first: "字重", second: "斜体" },
        {
          kind: "number",
          label: "字重",
          value: block.font.weight,
          step: 100,
          min: 100,
          max: 900,
          onChange: (value) => setFont({ weight: value }),
        },
        {
          kind: "checkbox",
          label: "斜体",
          value: block.font.italic,
          onChange: (value) => setFont({ italic: value }),
        },
      ),
      field("颜色", control({
        kind: "color",
        value: block.font.color,
        onChange: (value) => setFont({ color: value }),
      })),
      pair(
        { first: "横排", second: "竖排" },
        {
          kind: "select",
          label: "横排",
          value: block.align,
          options: ALIGN_OPTIONS,
          onChange: (value) => set({ align: value }),
        },
        {
          kind: "select",
          label: "竖排",
          value: block.valign,
          options: VALIGN_OPTIONS,
          onChange: (value) => set({ valign: value }),
        },
      ),
      // Only the line is written out a character at a time; a name plate is
      // there from the moment the line starts, present from the start of the line.
      ...(key === "text"
        ? [
            field(
              "逐字速度（毫秒/字，0 为整句直接出现）",
              control({
                kind: "number",
                value: block.typeSpeed ?? 0,
                step: 5,
                min: 0,
                max: 200,
                onChange: (value) => set({ typeSpeed: value }),
              }),
            ),
          ]
        : []),
    );

    return box;
  }

  /** The fields for the test backdrop: which picture, and what it is for. */
  function backdropSection() {
    const box = document.createElement("section");
    box.className = "dialog-editor__section";
    const heading = document.createElement("h3");
    heading.className = "dialog-editor__heading";
    heading.textContent = "背景";

    // The note is not decoration: without it, a background picked here looks
    // like a style field — and an author expecting it on the stage would find
    // it missing from every scene.
    const note = document.createElement("p");
    note.className = "dialog-editor__hint";
    note.textContent = "仅供预览，不写入样式文件。";

    const paths = listBackdrops();
    const options = [
      { value: "", label: "无" },
      ...paths.map((path) => ({ value: path, label: path })),
    ];
    if (backdrop && !paths.includes(backdrop)) {
      // A picture the tree no longer lists stays selected rather than being
      // discarded without notification: the file may be back on the next scan.
      options.push({ value: backdrop, label: backdrop });
    }

    box.append(
      heading,
      note,
      field("背景图", control({
        kind: "select",
        value: backdrop,
        options,
        onChange: (value) => setBackdrop(value),
      })),
    );
    return box;
  }

  /** The font families the machine has, once the backend has answered. */
  let families = [];

  /**
   * Redraws the property panel for the current selection.
   *
   * One selection, one section: the panel says what the selected thing is made
   * of, and nothing else. With layers and system components in one list, a
   * field that belonged to something else would be a field with no way to tell
   * whose it was.
   */
  function renderProps() {
    propsBody.replaceChildren();

    const current = primaryId() ? selectionFor(doc, primaryId()) : null;

    if (current?.kind === "layer") {
      props.append(layerSection(current.layer));
      return;
    }

    if (current?.kind === "region") {
      const section = textSection(regionByKey(current.key)?.name ?? "文本区域", current.key, families);
      section.classList.add("is-selected");
      props.append(section);
      return;
    }

    if (current?.kind === "backdrop") {
      const section = backdropSection();
      section.classList.add("is-selected");
      props.append(section);
      return;
    }

    const hint = document.createElement("p");
    hint.className = "dialog-editor__hint";
    hint.textContent = "选中一个图层或系统组件来编辑它。";
    props.append(hint);
  }

  /**
   * Fills the preview with `document`, from the file at `path`.
   *
   * @param {string} path Project-relative path of the `.dialog.json` file.
   * @param {object} raw The parsed file, or anything else for a new document.
   */
  const load = (path, raw) => {
    stylePath = path ?? null;
    doc = normaliseDocument(raw);
    selectedIds.clear();
    lastSelected = null;
    anchorId = null;
    images.clear();
    broken.clear();

    plate.width = doc.canvas.width;
    plate.height = doc.canvas.height;
    // The style file and the plate are the same size: a box drawn for one
    // canvas is never stretched onto another.
    frame.style.aspectRatio = `${doc.canvas.width} / ${doc.canvas.height}`;
    // Fit the frame to the room the viewer has; a hidden view answers 0 and the
    // resize observer below fits it again the moment it is shown.
    fitFrame();

    renderList();
    renderProps();
    redraw();
  };

  renderProps();

  // The preview is fitted to the viewer: collapsing a panel or resizing the
  // window changes its box, and the whole frame must stay visible.
  let previewObserver = null;
  if (typeof ResizeObserver === "function") {
    previewObserver = new ResizeObserver(() => fitFrame());
    previewObserver.observe(viewer);
  }

  if (listFonts) {
    Promise.resolve()
      .then(() => listFonts())
      .then((names) => {
        families = Array.isArray(names) ? names : [];
        renderProps();
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }

  return {
    node,
    load,
    /** The document being edited, mutated in place by the panel. */
    get document() {
      return doc;
    },
    /** The style file being edited, or `null`. */
    get path() {
      return stylePath;
    },
    /** The document as the text to write to the style file. */
    serialize: () => documentToJson(doc),
    /** Increases with every document change; lets callers cache comparisons. */
    version: () => version,
    /** Draws the plate again, after something outside the panel changed it. */
    redraw,
    /**
     * Releases the observer and the DOM the designer built.
     *
     * `disposeDoc()` calls this when the tab closes; without it the observer
     * keeps the whole designer — document, canvas, event closures — alive.
     */
    close() {
      previewObserver?.disconnect();
      previewObserver = null;
      node.remove();
    },
  };
}
