// 在剧本编辑器中定位 `key()` 调用。
// Pamela — finding a `key()` in the script editor.
// 按词法器结果计算光标偏移对应的调用，不依赖正则。
/**
 * A `key()` call: `ch.key("key-ch.keyframes")`.
 *
 * @typedef {object} KeyCall
 * @property {string} target The variable the call is made on. The object the
 *   key animates, and the name a file is created under when the call has none.
 * @property {string} file The file the call names, as written; "" for the older
 *   `ch.key()` that names none.
 * @property {number} open Index of the call's "(".
 * @property {number} close Index of its ")".
 * @property {number} start Index of the dot, so a selection can take the call.
 * @property {number} nameStart Index of the `key` word.
 * @property {number} end Index just past the closing bracket.
 * @property {number} line The 1-based line the call sits on. Travelling to a
 *   key needs this: the interpreter reports the line of each statement it is
 *   about to run, so the two can be matched.
 */
/**
 * The pattern a key call is found with.
 *
 * It anchors on the dot rather than on a variable name, because a call is often
 * **chained** — `ch.enable().key()` — and a pattern wanting `<name>.key(` would
 * miss it. The receiver is recovered from the text afterwards (`receiverOf`).
 *
 * It stops at the opening bracket, the same way a call is scanned for any other
 * method: the bracket's partner is found by counting (`matchingBracket`), which
 * needs the position of the `(` itself. What the call takes is checked
 * afterwards, on the text between the brackets.
 *
 * The `d` flag is what makes the offsets exact: a call may be written
 * `ch . key ( )`, and counting backwards from the bracket would land one
 * character off the name whenever there is a space before it.
 */

const KEY_CALL = /\.\s*(key)\s*\(/dg;

/**
 * Rewrites a `key()` call to name `file`, keeping the rest of the script.
 *
 * This is how the editor fills the argument in after the author has drawn the
 * animation: right-clicking `ch.key()` and saving writes
 * `ch.key("key-ch.keyframes")`. The call's own span is replaced rather than the
 * whole line, so a chained call — `ch.enable().key()` — keeps the chain, and
 * the offsets in `call` are the ones the scan reported, so the edit is exact.
 *
 * @param {string} source The script text.
 * @param {KeyCall} call A call from `keyCallsIn`.
 * @param {string} file The file to name, as it should be written.
 * @returns {string} The rewritten script, or the original when the call cannot
 *   be found at those offsets any more.
 */
export function withKeyFile(source, call, file) {
  const text = String(source ?? "");
  const at = Number(call?.open);
  const close = Number(call?.close);
  if (!Number.isFinite(at) || !Number.isFinite(close) || close < at) {
    return text;
  }
  if (text[at] !== "(" || text[close] !== ")") {
    return text;
  }
  return `${text.slice(0, at + 1)}${quote(file)}${text.slice(close)}`;
}

/**
 * Clears the file a `key()` call names, returning it to `key()`.
 *
 * This is the reverse of `withKeyFile`: deleting a path frame removes its file
 * and leaves the call naming nothing, so the script stops pointing at a file
 * that is no longer there. The call's own span is preserved, so a chained call
 * — `ch.enable().key("…")` — keeps its chain.
 *
 * @param {string} source The script text.
 * @param {KeyCall} call A call from `keyCallsIn`.
 * @returns {string} The rewritten script, or the original when the call cannot
 *   be found at those offsets any more.
 */
export function withoutKeyFile(source, call) {
  const text = String(source ?? "");
  const at = Number(call?.open);
  const close = Number(call?.close);
  if (!Number.isFinite(at) || !Number.isFinite(close) || close < at) {
    return text;
  }
  if (text[at] !== "(" || text[close] !== ")") {
    return text;
  }
  return `${text.slice(0, at + 1)}${text.slice(close)}`;
}

/** A file name as a script would read it: no folder, no `./`, no backslashes. */
function keyName(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Points every reference to one key frame file at another one.
 *
 * Used when a key frame file is renamed. Three spellings have to move together:
 * the `ch.key("key-ch.keyframes")` a script writes, the `"file": "…"` field a
 * flowmap's key node holds, and the old `ch.followPath("ch")` that named an id
 * rather than a file. Rewriting only the file on disk would leave the script
 * pointing at nothing — and `unreferencedPaths` would then delete the renamed
 * file on the very next project check.
 *
 * Only calls and fields that are references are touched: a `say()` with the
 * same words, or an unrelated `"file": "scene.pe"`, is left alone. Edits are
 * applied from the end backwards so several references on one line all keep
 * their offsets.
 *
 * @param {string} text A script or a flowmap's JSON text.
 * @param {string} from The file name (or path) being renamed away from.
 * @param {string} to The file name (or path) being renamed to.
 * @param {{ fromId?: string, toId?: string }} [options] The ids, for the old
 *   `followPath("id")` spelling.
 * @returns {string} The rewritten text, or the original when nothing matched.
 */
export function rewriteKeyReferences(text, from, to, { fromId = "", toId = "" } = {}) {
  const source = String(text ?? "");
  const wanted = keyName(from);
  const target = keyName(to);
  const edits = [];
  const add = (start, end, value) => {
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      edits.push({ start, end, value });
    }
  };

  if (wanted && target && wanted !== target) {
    for (const call of keyCallsIn(source)) {
      if (call.file && keyName(call.file) === wanted) {
        add(call.open + 1, call.close, quote(target));
      }
    }
    // A flowmap is JSON; its key node keeps the file in `params.file`.
    const field = /"file"\s*:\s*(["'])([^"']*)\1/g;
    let match = field.exec(source);
    while (match) {
      if (keyName(match[2]) === wanted) {
        const start = match.index + match[0].length - 1 - match[2].length;
        add(start, start + match[2].length, target);
      }
      match = field.exec(source);
    }
  }
  // The oldest spelling named the id itself. It only moves when the id did.
  if (fromId && toId && fromId !== toId) {
    const legacy = /followPath\s*\(\s*(["'])([^"']*)\1/g;
    let match = legacy.exec(source);
    while (match) {
      if (String(match[2]).trim() === fromId) {
        const start = match.index + match[0].length - 1 - match[2].length;
        add(start, start + match[2].length, toId);
      }
      match = legacy.exec(source);
    }
  }

  let out = source;
  let covered = Infinity;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > covered) {
      continue;
    }
    out = `${out.slice(0, edit.start)}${edit.value}${out.slice(edit.end)}`;
    covered = edit.start;
  }
  return out;
}

/**
 * The variable a call like `hero.enable().move(…)` is made on.
 *
 * The receiver is walked back from the dot: an expression is collected leftward
 * while its brackets stay balanced, and the identifier that starts it is the
 * object the whole chain hangs off. This is what makes a chained call name the
 * same object an unchained one does.
 *
 * @param {string} text
 * @param {number} dotIndex Index of the "." before the method.
 * @returns {string} The variable, or "" when the call has no plain receiver.
 */
function receiverOf(text, dotIndex) {
  // Walk back over the receiver expression. A `.method(...)` link is skipped as
  // a unit, which is what lets the chain be followed to its first link. `start`
  // only moves when a character that *belongs* to the expression is seen, so
  // the whitespace separating a chain from the statement before it is not
  // dragged into the receiver.
  let index = dotIndex;
  let start = dotIndex;
  let guard = 0;
  while (index > 0 && guard < 1000) {
    guard += 1;
    index -= 1;
    const char = text[index];
    if (char === ")" || char === "]" || char === "}") {
      const open = matchingOpen(text, index);
      if (open === -1) break;
      index = open;
      start = open;
    } else if (char === "\n") {
      break;
    } else if (/\s/.test(char)) {
      continue;
    } else if (/[A-Za-z0-9_.$[\]]/.test(char)) {
      start = index;
    } else {
      break;
    }
  }
  const expression = text.slice(start, dotIndex);
  const name = /^\s*([A-Za-z_]\w*)/.exec(expression);
  return name ? name[1] : "";
}

/** The index of the bracket that opens the one at `close`. */
function matchingOpen(text, close) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const open = pairs[text[close]];
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    const char = text[index];
    if (char === text[close]) {
      depth += 1;
    } else if (char === open) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Every `key()` call in a script, in the order they appear.
 *
 * Scanned with a regular expression rather than through the lexer because the
 * answer has to survive a half-typed script: an editor's text is unterminated
 * most of the time, and the call the author is looking at still has to be
 * found.
 *
 * A key names its file: `ch.key("key-ch.keyframes")`. The argument is what
 * the call plays, so it is read here and carried on the call; a call with no
 * argument is still recognised — it is what every script written before the
 * argument existed has — and its `file` is left empty so the caller can fall
 * back to the object's own name.
 *
 * @param {string} source
 * @returns {KeyCall[]}
 */
export function keyCallsIn(source) {
  const text = String(source ?? "");
  const calls = [];
  KEY_CALL.lastIndex = 0;
  let match = KEY_CALL.exec(text);
  while (match) {
    const open = match.indices[0][1] - 1; // the "(" the pattern consumed
    const dot = match.indices[0][0];
    const end = matchingBracket(text, open);
    if (end !== -1) {
      const inner = text.slice(open + 1, end - 1);
      const argued = /^\s*["']([^"']*)["']\s*$/.exec(inner);
      // `key()` and `key("file")` are both keys; anything else between the
      // brackets (`key(x + 1)`) is some other call, and offering the editor for
      // it would be wrong.
      if (inner.trim() === "" || argued) {
        calls.push({
          target: receiverOf(text, dot),
          file: argued ? argued[1] : "",
          open,
          close: end - 1,
          start: dot,
          nameStart: match.indices[1][0],
          end,
          line: lineOf(text, dot),
        });
      }
    }
    match = KEY_CALL.exec(text);
  }
  return calls;
}

/**
 * The index just past the bracket that closes the one at `open`.
 *
 * Bracket depth is counted over the whole text, including any brackets inside
 * string literals — which is wrong for a call like `move(len(")"), 0)`. The
 * alternative is to lex the script, and the cost of being wrong here is a menu
 * that does not appear on an unusual line, against a right-click that would
 * have to parse a half-typed file on every click. The simple count wins.
 *
 * @param {string} text
 * @param {number} open Index of a "(" character.
 * @returns {number} The index past the matching ")", or -1 if it never closes.
 */
function matchingBracket(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

/**
 * The `key()` call a caret offset belongs to.
 *
 * A click anywhere inside the call picks it. A click on the `key` word picks it
 * too — that is the word an author aims at. Failing both, the call on the same
 * line is used, so a click towards the end of a line still offers the key
 * written at its start.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {KeyCall | null}
 */
export function keyCallAt(source, offset) {
  const text = String(source ?? "");
  const at = Number(offset);
  if (!Number.isFinite(at)) {
    return null;
  }
  return callAt(text, at, keyCallsIn(text));
}

/**
 * The call a caret offset belongs to, preferring one the offset is inside.
 *
 * Sharing the search between `key()` and `font()` is what keeps the two menus
 * from disagreeing about a click: both are found by the same rule, and only
 * the pattern that produced `calls` differs.
 *
 * @param {string} text
 * @param {number} at
 * @param {object[]} calls
 * @returns {object | null}
 */
function callAt(text, at, calls) {
  if (!calls.length) {
    return null;
  }

  for (const call of calls) {
    // `end` is exclusive — it is the offset *past* the closing bracket — so a
    // caret sitting right after one call belongs to whatever comes next, not to
    // the call it just left.
    if (at >= call.start && at < call.end) {
      return call;
    }
  }

  const line = lineBoundsAt(text, at);
  // Several keys may share a line; the one whose name is nearest the caret is
  // the one the author meant.
  let best = null;
  let bestDistance = Infinity;
  for (const call of calls) {
    if (call.start < line.start || call.start > line.end) {
      continue;
    }
    const distance = Math.abs(call.nameStart - at);
    if (distance < bestDistance) {
      best = call;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * A `font()` call: `title.font("宋体")`.
 *
 * Both spellings are matched, because a script may be written in Chinese and
 * the menu has to work on `title.字体("宋体")` exactly as on the English call.
 */
const FONT_CALL = /\.\s*(font|字体)\s*\(/dg;

/**
 * Every `font()` call in a script, in the order they appear.
 *
 * Read like `keyCallsIn`: a regular expression over the editor's text rather
 * than the lexer, because the script is half-typed most of the time and the
 * call the author is looking at still has to be found. A call with no
 * argument is the default font; a call whose argument is not a single string
 * (`font(pick())`) is some other expression and is not offered a menu.
 *
 * @param {string} source
 * @returns {object[]}
 */
export function fontCallsIn(source) {
  const text = String(source ?? "");
  const calls = [];
  FONT_CALL.lastIndex = 0;
  let match = FONT_CALL.exec(text);
  while (match) {
    const open = match.indices[0][1] - 1; // the "(" the pattern consumed
    const dot = match.indices[0][0];
    const end = matchingBracket(text, open);
    if (end !== -1) {
      const inner = text.slice(open + 1, end - 1);
      const argued = /^\s*["']([^"']*)["']\s*$/.exec(inner);
      if (inner.trim() === "" || argued) {
        calls.push({
          target: receiverOf(text, dot),
          family: argued ? argued[1] : "",
          open,
          close: end - 1,
          start: dot,
          nameStart: match.indices[1][0],
          end,
          line: lineOf(text, dot),
        });
      }
    }
    match = FONT_CALL.exec(text);
  }
  return calls;
}

/**
 * The `font()` call a caret offset is inside.
 *
 * No same-line fallback, unlike `keyCallAt`: the font menu is an addition to
 * the editor, and a right-click anywhere else on a line that happens to carry a
 * `font()` call should still reach the resource panel's own menu.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {object | null}
 */
export function fontCallAt(source, offset) {
  const text = String(source ?? "");
  const at = Number(offset);
  if (!Number.isFinite(at)) {
    return null;
  }
  return (
    fontCallsIn(text).find((call) => at >= call.start && at < call.end) ?? null
  );
}

/**
 * Rewrites a `font()` call to name `family`, keeping the rest of the script.
 *
 * An empty family clears the argument — `title.font()` — which the runtime
 * reads as the built-in pair rather than as a broken call.
 *
 * @param {string} source The script text.
 * @param {object} call A call from `fontCallsIn`.
 * @param {string} family The family to write, or "" for the default.
 * @returns {string} The rewritten script, or the original at stale offsets.
 */
export function withFontFamily(source, call, family) {
  const text = String(source ?? "");
  const at = Number(call?.open);
  const close = Number(call?.close);
  if (!Number.isFinite(at) || !Number.isFinite(close) || close < at) {
    return text;
  }
  if (text[at] !== "(" || text[close] !== ")") {
    return text;
  }
  const named = String(family ?? "").trim();
  return `${text.slice(0, at + 1)}${named ? quote(named) : ""}${text.slice(close)}`;
}

/** The 1-based line an offset sits on. */
function lineOf(text, offset) {
  let line = 1;
  const at = Math.min(Math.max(0, offset), text.length);
  for (let index = 0; index < at; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** The start and end offsets of the line containing `offset`. */
function lineBoundsAt(text, offset) {
  const at = Math.min(Math.max(0, offset), text.length);
  const start = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const next = text.indexOf("\n", at);
  return { start, end: next === -1 ? text.length : next };
}

/** A string as a Pamela literal, with the two characters that matter escaped. */
export function quote(value) {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Splits a whole-text offset across the text nodes an element is made of.
 *
 * A highlighted layer is HTML: one text node per coloured run, not one for the
 * whole script. An offset into the script therefore has to be walked to the
 * node that actually holds that character — handing the whole-file offset to
 * the first node clamps it to that node's length, and every position then
 * measures as the same spot, which is what made a right-click never find its
 * `move`.
 *
 * @param {{ length: number }[]} lengths The text nodes' lengths, in order.
 * @param {number} offset An offset into the concatenation of all of them.
 * @returns {{ index: number, offset: number }} Which node, and where inside it.
 */
export function splitOffset(lengths, offset) {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const at = Math.min(Math.max(0, Number(offset) || 0), total);
  let seen = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    // `<=` so the offset that lands exactly on a boundary belongs to the node
    // it starts, not to the end of the one before it — the caret sits at the
    // first character of the next run.
    if (at <= seen + length) {
      return { index, offset: at - seen };
    }
    seen += length;
  }
  // Past the end: the last node, at its end.
  const last = Math.max(0, lengths.length - 1);
  return { index: last, offset: lengths[last] ?? 0 };
}

/**
 * Turns a pointer position into a caret offset.
 *
 * `measure(offset)` answers the client rectangle of a collapsed caret at that
 * offset — which is what the highlight layer's `Range` gives, and the same
 * thing a `<textarea>` cannot be asked for. The search is two binary passes
 * rather than a scan, so a long script does not make a right-click expensive.
 *
 * Text flows downward, so an offset's `top` never decreases: the line the point
 * is on is found first, then the position within that line by `left`.
 *
 * @param {(offset: number) => { left: number, top: number, right: number, bottom: number }} measure
 * @param {number} length The text's length, which bounds the search.
 * @param {number} x Client x of the point.
 * @param {number} y Client y of the point.
 * @returns {number} A caret offset into the text.
 */
export function offsetAtPoint(measure, length, x, y) {
  const total = Math.max(0, Number(length) || 0);
  if (total === 0) {
    return 0;
  }

  // The first offset whose line has moved past the point: that is the line the
  // point is above, so the one it is on is the offset before it.
  let low = 0;
  let high = total;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (measure(mid).bottom <= y) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const onLine = low;

  // The line's own extent, bounded by that same `top`.
  const lineTop = measure(onLine).top;
  let lo = 0;
  let hi = onLine;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (measure(mid).top >= lineTop) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const lineStart = lo;

  let lo2 = onLine;
  let hi2 = total;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2 + 1) >> 1;
    if (measure(mid).top <= lineTop) {
      lo2 = mid;
    } else {
      hi2 = mid - 1;
    }
  }
  const lineEnd = lo2;

  // Within the line, the first offset at or right of the point.
  let a = lineStart;
  let b = lineEnd;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (measure(mid).left < x) {
      a = mid + 1;
    } else {
      b = mid;
    }
  }
  // `a` is the first offset right of the point; the nearer of it and the one
  // before it is where the caret would go.
  if (a <= lineStart) {
    return lineStart;
  }
  const before = measure(a - 1);
  const here = measure(a);
  return Math.abs(x - before.right) <= Math.abs(x - here.left) ? a - 1 : a;
}