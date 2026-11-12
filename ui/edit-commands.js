// @ts-check
// 编辑器文本命令。
// Pamela — editor text commands.
// 命令只作用于 `textarea` 的选区，不改动 DOM 结构。
/** What a Tab inserts: four spaces rather than a tab character. */

export const INDENT = "    ";

/**
 * Indents the editor's selection with `INDENT`.
 *
 * Tab belongs to the editor rather than to the webview, because leaving the
 * field mid-line is never what was meant while writing a script. A caret — or a
 * selection inside one line — takes the spaces in place of what is selected; a
 * selection reaching across lines is a block being pushed over, so every line it
 * covers is indented and the whole block stays selected.
 *
 * The text is spliced in with `setRangeText`, which the browser records as an
 * edit and so leaves undo intact — assigning `value`, as accepting a suggestion
 * does, would throw the editor's history away. It fires no `input` event of its
 * own, though, so one is dispatched for the handlers that watch it.
 *
 * @param {{ value: string, selectionStart: number, selectionEnd: number, setRangeText: Function, setSelectionRange: Function, dispatchEvent: Function }} textarea
 */
export function indentSelection(textarea) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;

  if (!value.slice(start, end).includes("\n")) {
    textarea.setRangeText(INDENT, start, end, "end");
  } else {
    // The head of every line the selection covers, read before anything moves.
    const heads = [];
    for (let head = value.lastIndexOf("\n", start - 1) + 1; head < end; ) {
      heads.push(head);
      const next = value.indexOf("\n", head) + 1;
      if (next <= head) {
        break;
      }
      head = next;
    }

    // Written from the last line back, so every insertion is still addressed by
    // the offsets read from the untouched text above it.
    for (let index = heads.length - 1; index >= 0; index -= 1) {
      textarea.setRangeText(INDENT, heads[index], heads[index], "preserve");
    }
    // The first head sits at or before `start`, so the selection's start follows
    // it by one indent; the lines after it each push the selection's end along.
    textarea.setSelectionRange(start + INDENT.length, end + INDENT.length * heads.length);
  }

  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The block of whole lines a caret or selection covers.
 *
 * The block starts at the beginning of the caret's line and ends after the last
 * covered line's newline, so cutting it takes the line away rather than leaving
 * an empty one behind. A selection that stops at the very start of a line does
 * not take that line: `end - 1` is what decides the last covered line. The last
 * line of a document has no newline, and the block simply ends with the text.
 *
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @returns {{ from: number, to: number }}
 */
export function lineBlockOf(value, start, end) {
  const text = String(value ?? "");
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const anchor = end > start ? end - 1 : start;
  const next = text.indexOf("\n", anchor);
  return { from, to: next === -1 ? text.length : next + 1 };
}

/**
 * The text of the lines a caret or selection covers, ready for the clipboard.
 *
 * @param {{ value: string, selectionStart: number, selectionEnd: number }} textarea
 * @returns {string}
 */
export function lineTextOf(textarea) {
  const { from, to } = lineBlockOf(textarea.value, textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
  return textarea.value.slice(from, to);
}

/**
 * Deletes `from`–`to` — a block from `lineBlockOf` — and leaves the caret where
 * the block began.
 *
 * `setRangeText` keeps the edit on the browser's undo stack, and the `input`
 * event it does not fire is dispatched for the highlight, the gutter and the
 * dirty mark, exactly as `indentSelection` does.
 *
 * @param {{ value: string, setRangeText: Function, setSelectionRange: Function, dispatchEvent: Function }} textarea
 * @param {number} from
 * @param {number} to
 */
export function removeLineBlock(textarea, from, to) {
  if (!(to > from)) {
    return;
  }
  textarea.setRangeText("", from, to, "preserve");
  textarea.setSelectionRange(from, from);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Duplicates the lines the caret or selection covers, putting the copy directly
 * below them.
 *
 * The caret lands on the same column of the copy, which is where the eye left
 * it, so holding Ctrl+D stacks copies of one line. At the end of a document the
 * last line has no newline of its own, so one is added before the copy.
 *
 * @param {{ value: string, selectionStart: number, selectionEnd: number, setRangeText: Function, setSelectionRange: Function, dispatchEvent: Function }} textarea
 * @returns {boolean} Whether anything was duplicated.
 */
export function duplicateLineBlock(textarea) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;
  const { from, to } = lineBlockOf(value, start, end);
  const block = value.slice(from, to);
  // Nothing on a blank line to copy; the press is left alone rather than
  // inserting a lone newline nobody asked for.
  if (!block) {
    return false;
  }
  const lead = block.endsWith("\n") ? "" : "\n";
  const insert = lead + block;
  textarea.setRangeText(insert, to, to, "preserve");
  // The copy starts one newline below the block, or right where it does when
  // the block already ended in one.
  const copy = to + lead.length;
  textarea.setSelectionRange(copy + (start - from), copy + (end - from));
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/**
 * Removes one level of indentation from the start of every covered line — the
 * inverse of `indentSelection`. Mirrors it by writing last-line-first so earlier
 * line heads keep their original offsets after later deletions. A single-line
 * selection pulls its line back one indent, or snaps the caret to the previous
 * indent stop when there is none to remove.
 *
 * @param {{ value: string, selectionStart: number, selectionEnd: number, setRangeText: Function, setSelectionRange: Function, dispatchEvent: Function }} textarea
 */
export function outdentSelection(textarea) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;

  if (!value.slice(start, end).includes("\n")) {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    if (value.startsWith(INDENT, lineStart)) {
      textarea.setRangeText("", lineStart, lineStart + INDENT.length, "end");
    } else {
      const col = start - lineStart;
      const step = col % INDENT.length || INDENT.length;
      const target = Math.max(lineStart, start - step);
      textarea.setSelectionRange(target, target);
    }
    return;
  }

  const heads = [];
  for (let head = value.lastIndexOf("\n", start - 1) + 1; head < end; ) {
    heads.push(head);
    const next = value.indexOf("\n", head) + 1;
    if (next <= head) {
      break;
    }
    head = next;
  }

  let removedBeforeStart = 0;
  let removedTotal = 0;
  for (let index = heads.length - 1; index >= 0; index -= 1) {
    const head = heads[index];
    if (!value.startsWith(INDENT, head)) {
      continue;
    }
    textarea.setRangeText("", head, head + INDENT.length, "preserve");
    removedTotal += INDENT.length;
    if (head <= start) {
      removedBeforeStart += INDENT.length;
    }
  }

  textarea.setSelectionRange(
    Math.max(0, start - removedBeforeStart),
    Math.max(0, end - removedTotal),
  );

  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What a toggled line comment is written as. */
export const COMMENT_MARKER = "//";

/**
 * The whole lines a caret or selection covers, with the indentation ahead of
 * each one.
 *
 * The lines are the ones the caret sits on or the selection reaches into — the
 * same rule `lineBlockOf` uses for a cut, so what a comment toggles is what a
 * cut would take. Each line records where its text starts after the leading
 * whitespace, since a comment is written after the indentation rather than in
 * column zero. A whitespace-only line counts as blank: it takes the marker
 * without the space that would otherwise trail into nothing.
 *
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @returns {Array<{ head: number, text: string, indent: number, blank: boolean, marker: "" | "//" | "#" }>}
 */
function coveredLines(value, start, end) {
  const anchor = end > start ? end - 1 : start;
  const lines = [];
  for (let head = value.lastIndexOf("\n", start - 1) + 1; head <= anchor; ) {
    const newline = value.indexOf("\n", head);
    const lineEnd = newline === -1 ? value.length : newline;
    const text = value.slice(head, lineEnd);
    const indent = /^[ \t]*/.exec(text)[0].length;
    const body = text.slice(indent);
    /** @type {"" | "//" | "#"} */
    let marker = "";
    if (body.startsWith("//")) {
      marker = "//";
    } else if (body.startsWith("#")) {
      marker = "#";
    }
    lines.push({ head, text, indent, blank: body.trim() === "", marker });
    if (newline === -1) {
      break;
    }
    head = newline + 1;
  }
  return lines;
}

/**
 * Moves a caret or selection edge over a set of edits, all addressed in the
 * text before anything was written.
 *
 * An edit at the point itself is included unless told otherwise, so a caret at
 * the start of a line ends up after the marker just written there while a
 * selection keeps starting where it did. A removal clamps to where it began, so
 * a caret inside removed text lands at the removal rather than before it.
 *
 * @param {number} point
 * @param {Array<{ at: number, delta: number }>} edits
 * @param {boolean} [includeAt]
 * @returns {number}
 */
function shiftPoint(point, edits, includeAt = true) {
  let moved = point;
  for (const { at, delta } of edits) {
    if (at > point || (at === point && !includeAt)) {
      continue;
    }
    moved = delta < 0 ? Math.max(at, moved + delta) : moved + delta;
  }
  return moved;
}

/**
 * Comments every line the caret or selection covers, or takes the comments back
 * off when all of those lines carry one.
 *
 * `//` is written after the indentation, with a space before the text; a blank
 * line takes the bare marker. Mixed blocks — some lines commented, some not —
 * comment only the lines that are not, so one press leaves the block uniformly
 * commented and the next press removes every marker. Both `//` and `#` count as
 * a line comment when deciding, and either is removed, so a block written by
 * hand toggles the same way.
 *
 * The caret keeps its line and column past the marker; a selection keeps
 * covering the same text. `setRangeText` keeps the edits on the browser's undo
 * stack, and the `input` event it does not fire is dispatched for the highlight,
 * the gutter and the dirty mark, exactly as `indentSelection` does.
 *
 * @param {{ value: string, selectionStart: number, selectionEnd: number, setRangeText: Function, setSelectionRange: Function, dispatchEvent: Function }} textarea
 * @returns {boolean} Whether anything changed.
 */
export function toggleLineComment(textarea) {
  const value = textarea.value;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;
  const lines = coveredLines(value, start, end);
  // A block of blank lines has nothing to comment out, and writing markers
  // there would add text the author never asked for.
  const meaningful = lines.filter((line) => !line.blank);
  if (meaningful.length === 0) {
    return false;
  }
  const uncomment = meaningful.every((line) => line.marker !== "");
  const edits = [];

  // Written from the last line back, so every position is still addressed by
  // the offsets read from the untouched text above it.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const at = line.head + line.indent;
    if (uncomment) {
      if (!line.marker) {
        continue;
      }
      // The space after the marker goes with it when there is one, so a
      // commented line comes back exactly as it was written.
      const space = line.text[line.indent + line.marker.length] === " " ? 1 : 0;
      const length = line.marker.length + space;
      textarea.setRangeText("", at, at + length, "preserve");
      edits.push({ at, delta: -length });
    } else {
      if (line.marker) {
        continue;
      }
      const text = line.blank ? COMMENT_MARKER : `${COMMENT_MARKER} `;
      textarea.setRangeText(text, at, at, "preserve");
      edits.push({ at, delta: text.length });
    }
  }

  const caret = end === start;
  const first = shiftPoint(start, edits, caret);
  const last = caret ? first : shiftPoint(end, edits);
  textarea.setSelectionRange(first, last);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return edits.length > 0;
}
