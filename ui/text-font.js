// 画面文字的字体：西文默认 JetBrains Mono，中文默认思源黑体。
// Pamela — the faces a Text object is set in.
//
// A Text names one family, and that family is used for both scripts at once:
// the stack below is only the default, where Latin glyphs come from the
// bundled monospace face and Chinese glyphs fall through to 思源黑体. A family
// the author sets is put first, so it covers both scripts wherever it has the
// glyphs, and the defaults remain only as a fallback for the ones it lacks.

/** The bundled Western face, used for Latin letters by default. */
export const TEXT_FONT_LATIN = "JetBrains Mono";

/** The bundled Chinese face, used for CJK by default. */
export const TEXT_FONT_CJK = "Source Han Sans CN";

/** The weight a Text is drawn at when the author names none: 400, CSS regular. */
export const TEXT_FONT_WEIGHT = 400;

/**
 * Reads a Text's font weight.
 *
 * The value is the CSS scale, 1–1000: the usual stops are 100 (thinnest) to 900
 * (heaviest), and 400 is the regular face a Text starts at. A number outside
 * that range is a mistake worth reporting rather than a value to clamp: the
 * face the author wants is not there, and silently drawing 400 would hide it.
 *
 * @param {string} kind The object type, for the message: "Text".
 * @param {unknown} value
 * @returns {number}
 */
export function textFontWeight(kind, value) {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 1 || weight > 1000) {
    throw new Error(`${kind} 的字重需要 1–1000 的数字，例如 400（常规）、700（粗体）`);
  }
  return Math.round(weight);
}

/**
 * The `font-family` a Text draws with.
 *
 * With no family named, this is the two defaults. With one, it comes first and
 * the defaults follow it: the author's choice applies to Chinese and Western
 * text alike, but a character the chosen face does not carry is still drawn
 * rather than left to the browser's last resort.
 *
 * @param {string} [family] A family the author named, or "".
 * @returns {string} A CSS / Canvas `font-family` list.
 */
export function textFontStack(family = "") {
  const name = String(family ?? "").trim();
  // A quote in the family would end the CSS string it is written into; the
  // backslash keeps it as a character, which is what the name means.
  const chosen = name ? `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", ` : "";
  return `${chosen}"${TEXT_FONT_LATIN}", "${TEXT_FONT_CJK}", sans-serif`;
}
