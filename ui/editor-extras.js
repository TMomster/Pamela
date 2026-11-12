// 由编辑器辅助功能驱动的剧本行编辑。
// Pamela — script-line edits driven by the editor's helpers.

import { parseHex, toHex } from "./filters.js";
import { shorthandCallIn } from "./mpe.js";
import { englishNameFor } from "./pamela.js";

/**
 * The lines that carry a colour-picker call, with the colour they currently
 * name (or `null` when it cannot be read back yet).
 *
 * Only `rgbTo` and `hex` get a picker: `rgb` is a relative offset with no single
 * colour to drop a swatch on, so the picker would have nothing meaningful to
 * open with.
 *
 * @param {string} text The whole script.
 * @returns {Array<{ index: number, kind: "rgbTo" | "hex", hex: string | null }>}
 */
export function findTintLines(text) {
  const lines = String(text).split("\n");
  const found = [];
  lines.forEach((line, index) => {
    const call = /\b(rgbTo|hex)\s*\(/.exec(line);
    if (!call) {
      return;
    }
    const kind = /** @type {"rgbTo" | "hex"} */ (call[1]);
    let hex = null;
    if (kind === "hex") {
      const match = /hex\s*\(\s*["']?([0-9a-fA-F]{3,6})["']?/.exec(line);
      if (match) {
        const parsed = parseHex(match[1]);
        hex = toHex(parsed.r, parsed.g, parsed.b);
      }
    } else {
      const match = /rgbTo\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/.exec(line);
      if (match) {
        hex = toHex(Number(match[1]), Number(match[2]), Number(match[3]));
      }
    }
    found.push({ index, kind, hex });
  });
  return found;
}

/**
 * Rewrites a line's `rgbTo` or `hex` call to a colour.
 *
 * `hex` is a six-digit (case-insensitive) hex string; it is normalised to
 * upper-case before being written. A `rgbTo` call keeps its three numbers — they
 * are replaced with the colour's channels — while a `hex` call keeps its string
 * form, now quoting the colour. A line with neither call comes back unchanged.
 *
 * @param {string} line One line of the script.
 * @param {string} hex A colour such as `FF0000`.
 * @returns {string} The line with the call filled in.
 */
export function fillTintLine(line, hex) {
  const colour = toHex(parseHex(hex).r, parseHex(hex).g, parseHex(hex).b);

  const rgbTo = /(rgbTo\s*\(\s*)(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/.exec(line);
  if (rgbTo) {
    const r = parseInt(colour.slice(0, 2), 16);
    const g = parseInt(colour.slice(2, 4), 16);
    const b = parseInt(colour.slice(4, 6), 16);
    return line.replace(rgbTo[0], `${rgbTo[1]}${r}, ${g}, ${b}`);
  }

  const hexCall = /(hex\s*\(\s*)(["'][^"']*["']|[^,)\s]+)/.exec(line);
  if (hexCall) {
    return line.replace(hexCall[0], `${hexCall[1]}"${colour}"`);
  }

  return line;
}

/**
 * Whether the line at `index` is a `Character`/`Background` call with an empty
 * argument list, so a drop has somewhere to put a path.
 *
 * An empty call — `Character()` — and one with an empty string — `Character("")`
 * — both count, because neither has a value yet. A call that already names a
 * path does not, so a drop there leaves the writer's choice alone.
 *
 * @param {string} text The whole script.
 * @param {number} index The line to test.
 * @returns {boolean}
 */
export function findImageDropLine(text, index) {
  const line = String(text).split("\n")[index];
  if (!line) {
    return false;
  }
  const match = /\b(Background|Character)\s*\(\s*([^)]*)\)/.exec(line);
  if (!match) {
    return false;
  }
  const inner = match[2].trim();
  if (inner === "") {
    return true;
  }
  // A string literal: fillable only when it holds nothing.
  if (/^["'][\s\S]*["']$/.test(inner)) {
    return inner.slice(1, -1).trim() === "";
  }
  // Anything else (a path) means the call is already filled.
  return false;
}

/**
 * Fills an empty `Character`/`Background` argument with `path`.
 *
 * `path` is taken as written — already relative to `assets/`, so a subfolder
 * stays as `subfolder/file.png` — and any stray backslashes are normalised to
 * forward slashes. A call that already has a value is returned untouched, so a
 * drop on a filled line is a no-op rather than an overwrite.
 *
 * @param {string} line One line of the script.
 * @param {string} path The asset path to drop in.
 * @returns {string} The line with the argument filled, or unchanged.
 */
export function fillImageArg(line, path) {
  const match = /\b(Background|Character)\s*\(\s*([^)]*)\)/.exec(line);
  if (!match) {
    return line;
  }
  const inner = match[2].trim();
  const empty = inner === "" || (/^["'][\s\S]*["']$/.test(inner) && inner.slice(1, -1).trim() === "");
  if (!empty) {
    return line;
  }
  const relative = String(path).replace(/\\/g, "/");
  return line.replace(match[0], `${match[1]}("${relative}")`);
}

/**
 * The index of the `)` that closes the `(` at `open`, or -1 if the line ends
 * first.
 *
 * Brackets inside a string literal are part of the string, not of the call, so a
 * `"a)b"` argument does not end the call early. Escapes inside the literal are
 * stepped over for the same reason.
 */
function matchingParen(line, open) {
  let depth = 0;
  let quote = "";
  for (let i = open; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === "\\") {
        i += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * The call on `line` that a drop at `column` lands on.
 *
 * The author aims at the function, not at the brackets inside it, so the whole
 * call is the target: the name, the arguments and the closing bracket. A column
 * a couple of characters left of the name still counts — aiming at a name has to
 * be forgiving, or half the drops would miss by a pixel. Where calls overlap —
 * `wrapper(inner(x))` — the innermost one under the pointer wins.
 *
 * @param {string} line One line of source, without its newline.
 * @param {number} column Zero-based character column of the pointer.
 * @returns {{ start: number, open: number, end: number, hasArguments: boolean } | null}
 */
export function callAtColumn(line, column) {
  if (typeof line !== "string" || !Number.isFinite(column)) {
    return null;
  }
  const pattern = /[A-Za-z_$][\w$.]*\s*\(/g;
  let best = null;
  for (const match of line.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(line, open);
    const start = match.index;
    const end = close === -1 ? line.length : close;
    // To the left of the name a small grace, to the right the whole call.
    if (column < start - 2 || column > end) {
      continue;
    }
    if (!best || start >= best.start) {
      const inner = line.slice(open + 1, end).trim();
      best = {
        start,
        open,
        end,
        // A lone quote pair is an empty argument, not a value: `Character("")`
        // has nowhere to put a name yet, so the name replaces the pair.
        hasArguments: inner !== "" && !/^(["'])\s*\1$/.test(inner),
      };
    }
  }
  return best;
}

/**
 * Adds `name` as the next argument of the call under `column`.
 *
 * `func()` becomes `func("ch.png")`; `func(a)` becomes `func(a, "ch.png")`.
 * The name goes in as a quoted string, which is how every call in a script takes
 * an asset name, and an argument list that already ends in a comma is not given
 * a second one. A call still open at the end of the line — the writer was about
 * to type the rest — is closed by the drop.
 *
 * @param {string} line One line of the script.
 * @param {number} column Where the pointer let go, in characters.
 * @param {string} name The file name to add.
 * @returns {string | null} The rewritten line, or null when no call is under the pointer.
 */
/**
 * Functions that take exactly one string (a resource path). A drop onto one of
 * these replaces whatever argument is already there — even a filled one — rather
 * than appending a second argument, because there is nowhere else for it to go.
 */
const SINGLE_STRING_FUNCS = new Set(["Background", "Character", "Audio", "key"]);

export function dropArgumentAt(line, column, name) {
  const call = callAtColumn(line, column);
  if (!call || !name) {
    return null;
  }
  const quoted = `"${String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  // `Background`/`Character`/`Audio`/`key` are single-string: a drop overwrites
  // the argument (empty, filled or half-typed) instead of adding one more. The
  // check is on the method name, so `ch.key("a.keyframes")` is as single-string
  // as a bare `key(…)`: `key` names a file whichever object it animates, and a
  // second argument would be a different call altogether.
  const funcName = line.slice(call.start, call.open).replace(/\s+$/, "").trim();
  const bare = funcName.slice(funcName.lastIndexOf(".") + 1);
  if (SINGLE_STRING_FUNCS.has(bare)) {
    const close = line[call.end] === ")" ? line.slice(call.end) : ")";
    return `${line.slice(0, call.open + 1)}${quoted}${close}`;
  }

  // The call runs to the end of the line: nothing closes it yet, so close it. A
  // trailing comma means the writer was already between arguments.
  if (line[call.end] !== ")") {
    const head = line.replace(/\s+$/, "");
    const separator = head.endsWith(",") ? " " : call.hasArguments ? ", " : "";
    return `${head}${separator}${quoted})`;
  }

  // Nothing in the brackets — empty, or only a pair of quotes — so the name is
  // the whole list rather than the next entry in it.
  if (!call.hasArguments) {
    return `${line.slice(0, call.open + 1)}${quoted}${line.slice(call.end)}`;
  }

  const head = line.slice(0, call.end).replace(/\s+$/, "");
  const tail = line.slice(head.length);
  const separator = head.endsWith(",") ? " " : ", ";
  return `${head}${separator}${quoted}${tail}`;
}

/**
 * The shorthand statement on `line` a drop at `column` would fill, or `null`.
 *
 * Only the four single-string builtins are targets in the shorthand. The
 * dialect joins arguments with spaces and lets free text run to the end of the
 * line, so "append a second argument" has no spelling that would not change
 * what the line means; these four take one resource name, which is exactly what
 * a drag from the tree carries (`背景 教室.png`, `角色 帕梅拉.png`,
 * `音频 风.mp3`, `小帕 动画 小帕.keyframes`).
 *
 * The whole statement is the target, the name and what it already names alike,
 * the same way a bracketed call is — an author aims at the function, not at the
 * space after it.
 *
 * @param {string} line One line of source, without its newline.
 * @param {number} column Zero-based character column of the pointer.
 * @returns {{ start: number, end: number } | null} The columns of the statement,
 *   `end` being its last character.
 */
export function mpeDropTargetAt(line, column) {
  const call = droppableCallAt(line, column);
  return call ? { start: call.start, end: call.end } : null;
}

/**
 * Fills the resource name of the shorthand statement at `column`.
 *
 * `背景` becomes `背景 教室.png`; a name already written is replaced, whatever
 * form it was written in (bare, quoted, `{ … }`), and a trailing comment stays
 * where the author left it. The name goes in as the dialect writes it — bare,
 * since free text is the rest of the line — so no quoting is added that the
 * writer would have to remove.
 *
 * @param {string} line One line of the source.
 * @param {number} column Where the pointer let go, in characters.
 * @param {string} name The asset name to write.
 * @returns {string | null} The rewritten line, or null when no statement is
 *   under the pointer.
 */
export function mpeFillDropAt(line, column, name) {
  const call = droppableCallAt(line, column);
  if (!call || !name) {
    return null;
  }
  const before = line.slice(0, call.argsStart);
  // The space that separated the name from its argument is already in `before`
  // unless the line had no argument at all, in which case the drop supplies it.
  const gap = call.argsStart > call.nameEnd ? "" : " ";
  // What follows the argument stays as it was: the comment, and the calls a
  // chained line goes on with (`. 模糊 200`), which name nothing of their own.
  // With no argument, whatever trails the name is whitespace the writer had not
  // filled in yet, so the drop replaces it rather than leaving it behind.
  const tail = call.args ? line.slice(call.firstArgsEnd) : "";
  return `${before}${gap}${name}${tail}`;
}

/**
 * The droppable shorthand call at `column`, with the columns a drop replaces.
 *
 * @param {string} line
 * @param {number} column
 * @returns {ReturnType<typeof shorthandCallIn> & { start: number, end: number } | null}
 */
function droppableCallAt(line, column) {
  if (!Number.isFinite(column)) {
    return null;
  }
  const call = shorthandCallIn(line);
  if (!call) {
    return null;
  }
  // `小帕 动画 …` names `key` by its method; `背景 …` names it by its head.
  if (!SINGLE_STRING_FUNCS.has(englishNameFor(call.verb || call.head))) {
    return null;
  }
  // The statement starts at the indent, which for `小帕 = 角色 …` is left of the
  // call itself: the line is the unit a drop aims at in this spelling, so the
  // receiver and the equals sign are part of the target too.
  const start = call.indent.length;
  const end = Math.max(call.nameEnd, call.argsEnd) - 1;
  // A small grace to the left of the statement, and nothing past its last
  // character — the same rule a bracketed call follows.
  if (column < start - 2 || column > end) {
    return null;
  }
  return { ...call, start, end };
}
