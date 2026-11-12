// 应用图标集。
// Pamela — the icon set.
// 以图标表达语义时由 `title` 与 `aria-label` 提供名称。

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Geometry per icon. A shape is a `path` `d` string, or an object naming another
 * primitive (`tag`) with its attributes — the arrows and the clock are not all
 * one path, and flattening them to one would bend the shapes.
 */
const ICONS = {
  save: [
    {
      d:
        "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    },
    { d: "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" },
    { d: "M7 3v4a1 1 0 0 0 1 1h7" },
  ],
  undo: [
    { d: "M9 14L4 9l5-5" },
    { d: "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" },
  ],
  redo: [
    { d: "m15 14l5-5l-5-5" },
    { d: "M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" },
  ],
  "arrow-left": [{ d: "m12 19l-7-7l7-7m7 7H5" }],
  "chevron-left": [{ d: "m15 18l-6-6l6-6" }],
  "chevron-right": [{ d: "m9 18l6-6l-6-6" }],
  timer: [{ d: "M10 2h4m-2 12l3-3" }, { tag: "circle", cx: 12, cy: 14, r: 8 }],
  plus: [{ d: "M5 12h14m-7-7v14" }],
  pencil: [
    {
      d:
        "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4",
    },
  ],
  play: [
    {
      d:
        "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z",
    },
  ],
  grid: [
    { tag: "rect", width: 7, height: 7, x: 3, y: 3, rx: 1 },
    { tag: "rect", width: 7, height: 7, x: 14, y: 3, rx: 1 },
    { tag: "rect", width: 7, height: 7, x: 14, y: 14, rx: 1 },
    { tag: "rect", width: 7, height: 7, x: 3, y: 14, rx: 1 },
  ],
  // The segment type switch. The bend is the same gesture at 24: a rising
  // diagonal, and the same diagonal bowed. The spline's end dots are dropped
  // because at the 15 px a button gives it they read as visual clutter.
  curve: [{ d: "M5 17A12 12 0 0 1 17 5" }],
  line: [{ d: "M4 20L20 4" }],
  close: [{ d: "M18 6 6 18M6 6l12 12" }],
  // Delete the selected key frame.
  trash: [
    { d: "M3 6h18" },
    { d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" },
    { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" },
  ],
  "chevron-down": [{ d: "m6 9 6 6 6-6" }],
  "chevron-up": [{ d: "m18 15-6-6-6 6" }],
  // The resource panel's collapse: two chevrons pointing the way it will move.
  "chevrons-left": [{ d: "m11 17-5-5 5-5M18 17l-5-5 5-5" }],
  "chevrons-right": [{ d: "m6 17 5-5-5-5M13 17l5-5-5-5" }],
  // A plain minus, for the graph zoom-out button.
  minus: [{ d: "M5 12h14" }],
  // Reverse import: the same rotate-ccw Lucide draws for "undo a parse".
  reverse: [{ d: "M3 12a9 9 0 1 0 3-7.7L3 8" }, { d: "M3 3v5h5" }],
  // Fit to content: the four-corner brackets Lucide uses for "maximize".
  maximize: [
    { d: "M3 8V5a2 2 0 0 1 2-2h3" },
    { d: "M21 8V5a2 2 0 0 0-2-2h-3" },
    { d: "M3 16v3a2 2 0 0 0 2 2h3" },
    { d: "M21 16v3a2 2 0 0 1-2 2h-3" },
  ],
  // Back to 1:1 scale.
  percent: [
    { d: "M19 5 5 19" },
    { tag: "circle", cx: 6.5, cy: 6.5, r: 2.5 },
    { tag: "circle", cx: 17.5, cy: 17.5, r: 2.5 },
  ],
  // --- dialogue designer toolbar ---
  // 对话: a speech box. 旁白: the same box with a quote mark in it.
  "message-square": [
    { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  ],
  "message-square-quote": [
    { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
    { d: "M8 12a2 2 0 0 0 2-2V8H8" },
    { d: "M14 12a2 2 0 0 0 2-2V8h-2" },
  ],
  // Copy a document or a layer.
  copy: [
    { d: "M8 8h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" },
    { d: "M4 16V5a2 2 0 0 1 2-2h9" },
  ],
  "arrow-up": [{ d: "m12 19V5m-6 6 6-6 6 6" }],
  "arrow-down": [{ d: "M12 5v14m6-6-6 6-6-6" }],
  "arrow-right": [{ d: "M5 12h14m-6-6 6 6-6 6" }],
  // Layer shapes, matching what each add-button places.
  square: [{ tag: "rect", x: 3, y: 3, width: 18, height: 18, rx: 2 }],
  circle: [{ tag: "circle", cx: 12, cy: 12, r: 9 }],
  polygon: [{ d: "M12 3l8 5.5v7L12 21l-8-5.5v-7z" }],
  image: [
    { tag: "rect", x: 3, y: 3, width: 18, height: 18, rx: 2 },
    { tag: "circle", cx: 9, cy: 9, r: 1.6 },
    { d: "m21 15-4.5-4.5L6 21" },
  ],
  // The stamp: a rubber stamp pressed onto the plate.
  stamp: [
    { d: "M5 22h14" },
    {
      d:
        "M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z",
    },
    { d: "M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13" },
  ],
};

/** The names this module can draw — used by callers that validate a request. */
export const iconNames = Object.freeze(Object.keys(ICONS));

/**
 * Builds one icon as an SVG element.
 *
 * The element is decorative: every button that uses it also carries a title and
 * an `aria-label`, so the glyph behind it is `aria-hidden` and never read twice.
 *
 * @param {string} name Key of the icon; see {@link iconNames}.
 * @returns {SVGElement | null} The glyph, or `null` for a name not in the set.
 */
export function createIcon(name) {
  const shapes = ICONS[name];
  if (!shapes) {
    return null;
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const shape of shapes) {
    if (typeof shape === "string") {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", shape);
      svg.append(path);
      continue;
    }
    const node = document.createElementNS(SVG_NS, shape.tag || "path");
    for (const [key, value] of Object.entries(shape)) {
      if (key !== "tag") {
        node.setAttribute(key, String(value));
      }
    }
    svg.append(node);
  }

  return svg;
}
