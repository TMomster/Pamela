// 颜色滤镜原语。
// Pamela — colour filter primitives.
// 数值按有效范围夹取，越界不按错误处理。
/** Clamps a colour channel to the 0–255 range the stage understands. */

export function clampChannel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("颜色通道需要数字");
  }
  return Math.max(0, Math.min(255, Math.round(number)));
}

/**
 * Reads a hex colour, case-insensitively.
 *
 * Both the three-digit shorthand and the six-digit form are accepted, so a
 * writer may spell a colour `fff` or `ffffff` and either way gets the same RGB.
 *
 * @param {string} text A colour such as `FF0000` or `#abc`.
 * @returns {{ r: number, g: number, b: number }}
 */
export function parseHex(text) {
  if (typeof text !== "string") {
    throw new Error("hex 的颜色需要文本");
  }
  const raw = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{3}$/.test(raw) && !/^[0-9a-fA-F]{6}$/.test(raw)) {
    throw new Error("hex 的颜色需要三位或六位十六进制，如 FFFFFF");
  }
  const full = raw.length === 3 ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2] : raw;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Formats RGB channels as a six-digit uppercase hex string, e.g. `FF0000`. */
export function toHex(r, g, b) {
  const digit = (value) => clampChannel(value).toString(16).padStart(2, "0");
  return `${digit(r)}${digit(g)}${digit(b)}`.toUpperCase();
}

/**
 * Adds a relative offset to a base tint, clamping each channel at 255.
 *
 * This is what `rgb` does: `red = 254` plus an offset of `10` can only reach
 * `255`, never `264`, so the part that would spill past the top is dropped.
 *
 * @param {{ r: number, g: number, b: number }} base The current tint.
 * @param {number} dr Offset to the red channel.
 * @param {number} dg Offset to the green channel.
 * @param {number} db Offset to the blue channel.
 * @returns {{ r: number, g: number, b: number }}
 */
export function addTint(base, dr, dg, db) {
  return {
    r: clampChannel((base?.r ?? 0) + (dr ?? 0)),
    g: clampChannel((base?.g ?? 0) + (dg ?? 0)),
    b: clampChannel((base?.b ?? 0) + (db ?? 0)),
  };
}

/**
 * The `values` string an SVG `feColorMatrix` needs to add an RGB offset.
 *
 * The matrix keeps every channel as it is and adds the offset in the last
 * column, where the SVG expects values in the 0–1 range — so each channel is
 * divided by 255. A zero offset is the identity matrix, which leaves the picture
 * untouched.
 *
 * @param {number} r Red offset, 0–255.
 * @param {number} g Green offset, 0–255.
 * @param {number} b Blue offset, 0–255.
 * @returns {string} Twenty numbers, the five rows of the matrix.
 */
export function tintMatrix(r, g, b) {
  const offset = (value) => (clampChannel(value) / 255).toFixed(4);
  return [
    "1 0 0 0", offset(r),
    "0 1 0 0", offset(g),
    "0 0 1 0", offset(b),
    "0 0 0 1 0",
  ].join(" ");
}

// --- the look ---
//
// `blur`, `saturate`, `contrast` and `brightness` are the four a visual novel
// reaches for: a soft-focus flashback, a greyed-out memory, a harsh close-up,
// a scene gone dark. Each is one number, and the CSS function of the same name
// takes it as written — so the table below is the whole of the language's side
// of the deal, and the defaults are the identity.
//
// A value is the neutral point when it is the function's own identity, not when
// it is zero: `saturate(0)` is grey and `contrast(0)` is flat grey, so "no
// effect" is 1 for those two and 0 for blur. `paintLook` drops the neutral
// entries, which is what keeps a picture a script never filtered free of a
// `filter` declaration at all.

/**
 * The look's properties, in the order they are written.
 *
 * The order is fixed rather than left to the order the script set them, so the
 * same look always produces the same CSS — which is what lets a test hold it to
 * what it guarantees, and what keeps a rebuild from reordering the string.
 */
export const LOOK_PROPERTIES = ["blur", "brightness", "contrast", "saturate"];

/** What each look property reads as before a script names it. */
export const LOOK_NEUTRAL = Object.freeze({
  blur: 0,
  brightness: 1,
  contrast: 1,
  saturate: 1,
});

/** The CSS function each look property is written as, and its unit. */
const LOOK_CSS = {
  blur: { name: "blur", unit: "px" },
  brightness: { name: "brightness", unit: "" },
  contrast: { name: "contrast", unit: "" },
  saturate: { name: "saturate", unit: "" },
};

/** The range each look property is clamped into. */
const LOOK_RANGE = {
  blur: [0, 100],
  brightness: [0, 4],
  contrast: [0, 4],
  saturate: [0, 4],
};

/** A fresh look: every property at its neutral value. */
export function neutralLook() {
  return { ...LOOK_NEUTRAL };
}

/**
 * Reads one look property: a number, clamped rather than refused.
 *
 * 数值按有效范围夹取，不因越界而拒绝：`saturate(4.2)` 取最大饱和度，负模糊量按模糊处理并归零。
 *
 * @param {string} property One of {@link LOOK_PROPERTIES}.
 * @param {unknown} value
 * @param {string} [kind] The object name, for the message a writer sees.
 * @returns {number}
 */
export function lookValue(property, value, kind = "滤镜") {
  if (!Number.isFinite(value)) {
    throw new Error(`${kind} 的 ${property} 需要数字`);
  }
  const [low, high] = LOOK_RANGE[property] ?? [0, Infinity];
  return Math.min(high, Math.max(low, Number(value)));
}

/**
 * Sets one property of a look, answering a new look.
 *
 * A copy rather than a mutation: a look is remembered on the object and the
 * previous one may still be what the element is drawn with while a fade runs.
 *
 * @param {object} look The look as it stands.
 * @param {string} property
 * @param {unknown} value
 * @param {string} [kind]
 * @returns {{ blur: number, brightness: number, contrast: number, saturate: number }}
 */
export function withLook(look, property, value, kind = "滤镜") {
  const next = { ...LOOK_NEUTRAL, ...look };
  next[property] = lookValue(property, value, kind);
  return next;
}

/**
 * The `filter` declaration a look asks for, or `""` when it asks for nothing.
 *
 * Neutral entries are dropped, so a look a script has not touched produces an
 * empty string and the element keeps no `filter` at all. A blur of zero is
 * dropped for the same reason `opacity: 1` is: the declaration would only be
 * the identity.
 *
 * @param {object} look
 * @returns {string} e.g. `blur(4px) saturate(0.4)`, or `""`.
 */
export function lookFilter(look) {
  const source = { ...LOOK_NEUTRAL, ...(look ?? {}) };
  const parts = [];
  for (const property of LOOK_PROPERTIES) {
    const value = Number(source[property]);
    if (!Number.isFinite(value) || value === LOOK_NEUTRAL[property]) {
      continue;
    }
    const { name, unit } = LOOK_CSS[property];
    parts.push(`${name}(${value}${unit})`);
  }
  return parts.join(" ");
}

/**
 * The `filter` declaration a look asks for, written as all four functions.
 *
 * Unlike {@link lookFilter}, which drops the neutral entries, this keeps every
 * property in `LOOK_PROPERTIES` order — `blur() brightness() contrast()
 * saturate()` — even when some are at their neutral value. A `filter` list only
 * animates from and to another list of the same length, so a look a script
 * reaches for gradually must be spelled the same way at both ends. The stage
 * uses this for the short-lived moment a blur (or any of the four) fades in: it
 * paints the previous look as a full list, then the new look as a full list, so
 * the browser can interpolate instead of snapping.
 *
 * @param {object} look
 * @returns {string} e.g. `blur(0px) brightness(1) contrast(1) saturate(0.4)`.
 */
export function lookFilterFull(look) {
  const source = { ...LOOK_NEUTRAL, ...(look ?? {}) };
  return LOOK_PROPERTIES.map((property) => {
    const value = Number(source[property]);
    const { name, unit } = LOOK_CSS[property];
    return `${name}(${Number.isFinite(value) ? value : LOOK_NEUTRAL[property]}${unit})`;
  }).join(" ");
}

/** Whether a look asks for anything at all. */
export function lookIsNeutral(look) {
  return lookFilter(look) === "";
}

