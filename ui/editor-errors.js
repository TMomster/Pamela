// @ts-check
// 编辑器侧的语法错误标记。
// Pamela — editor-side syntax error marks.
// 报告位置需限制在文本范围内。

import { parse, tokenize } from "./pamela.js";

/**
 * The first syntax error in `source`, or `null` when it scans and parses clean.
 * `line` and `column` are 1-based, matching the interpreter's error objects.
 *
 * @param {string} source
 * @returns {{ message: string, line: number, column: number } | null}
 */
export function syntaxErrorIn(source) {
  const text = String(source ?? "");
  const scanned = tokenize(text);
  // `"error" in scanned` is the narrowing TypeScript understands; a truthiness
  // check on an optional field of a union would not tell it which arm it is on.
  if ("error" in scanned) {
    return normalise(scanned.error, text);
  }
  if (!scanned.tokens) {
    return null;
  }
  return syntaxErrorInTokens(scanned.tokens, text);
}

/**
 * The first parse error in an already-tokenized script, or `null`.
 *
 * The editor already scans the text to paint it; handing those tokens over skips
 * a second full tokenize on every keystroke. A lexer error is not represented
 * here — the caller has no tokens for it — so `syntaxErrorIn` still owns that
 * case.
 *
 * @param {{ type: string }[] | null | undefined} tokens
 * @param {string} source
 * @returns {{ message: string, line: number, column: number } | null}
 */
export function syntaxErrorInTokens(tokens, source) {
  if (!tokens) {
    return null;
  }
  const text = String(source ?? "");
  const parsed = parse(tokens);
  return "error" in parsed ? normalise(parsed.error, text) : null;
}

/** Clamps a reported position to the text bounds, so an off-by-one cannot exceed them. */
function normalise(error, text) {
  const lines = text.split(/\r?\n/);
  const line = Math.min(Math.max(Math.trunc(Number(error?.line) || 1), 1), lines.length);
  const width = (lines[line - 1]?.length ?? 0) + 1;
  const column = Math.min(Math.max(Math.trunc(Number(error?.column) || 1), 1), width);
  return {
    message: String(error?.message ?? "脚本有语法错误"),
    line,
    column,
  };
}

/**
 * The rectangle of the error's line, in content coordinates (before scrolling).
 * `column` is 1-based, so the mark starts one glyph earlier. It runs to the end
 * of the line but is at least one character wide, so an error on an empty line
 * is still visible.
 *
 * @param {string} source
 * @param {{ line: number, column: number }} error
 * @param {{ lineHeight?: number, charWidth?: number, padTop?: number,
 *   padLeft?: number }} geometry
 * @returns {{ top: number, left: number, width: number, height: number, row: number }}
 */
export function errorMarkRect(source, error, geometry = {}) {
  const lines = String(source ?? "").split(/\r?\n/);
  const row = Math.min(Math.max(Math.trunc(Number(error?.line) || 1) - 1, 0), lines.length - 1);
  const col = Math.min(
    Math.max(Math.trunc(Number(error?.column) || 1) - 1, 0),
    lines[row]?.length ?? 0,
  );
  const { lineHeight = 0, charWidth = 0, padTop = 0, padLeft = 0 } = geometry;
  const remaining = Math.max(1, (lines[row]?.length ?? 0) - col);
  return {
    top: padTop + row * lineHeight,
    left: padLeft + col * charWidth,
    width: Math.max(charWidth, remaining * charWidth),
    height: lineHeight,
    row,
  };
}
