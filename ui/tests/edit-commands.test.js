import test from "node:test";
import assert from "node:assert/strict";
import {
  INDENT,
  duplicateLineBlock,
  indentSelection,
  lineBlockOf,
  lineTextOf,
  outdentSelection,
  removeLineBlock,
  toggleLineComment,
} from "../edit-commands.js";

// 编辑器文本命令测试。
// A textarea-shaped stub: only the fields the commands touch.
// 桩对象只提供命令所触及的字段。
class FakeTextarea {
  constructor(value, start = 0, end = start) {
    this.value = value;
    this.selectionStart = start;
    this.selectionEnd = end;
    this.events = [];
  }

  setRangeText(replacement, start = this.selectionStart, end = this.selectionEnd, mode = "preserve") {
    const before = this.value.slice(0, start);
    const after = this.value.slice(end);
    this.value = before + replacement + after;
    const length = replacement.length;
    if (mode === "end") {
      this.selectionStart = this.selectionEnd = start + length;
    } else if (mode === "start") {
      this.selectionStart = this.selectionEnd = start;
    }
    // "preserve" leaves the selection where it was; the commands re-set it.
  }

  setSelectionRange(start, end = start) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  dispatchEvent(event) {
    this.events.push(event.type);
  }
}

test("INDENT is four spaces", () => {
  assert.equal(INDENT, "    ");
});

test("indent inserts at a bare caret", () => {
  const textarea = new FakeTextarea("x", 0, 0);
  indentSelection(textarea);
  assert.equal(textarea.value, "    x");
  assert.equal(textarea.selectionStart, 4);
  assert.equal(textarea.selectionEnd, 4);
  assert.deepEqual(textarea.events, ["input"]);
});

test("indent replaces the selected text on one line", () => {
  const textarea = new FakeTextarea("ab", 0, 2);
  indentSelection(textarea);
  assert.equal(textarea.value, "    ");
  assert.equal(textarea.selectionEnd, 4);
});

test("indent pushes every covered line over and keeps the block selected", () => {
  const textarea = new FakeTextarea("a\nb\nc", 0, 4); // covers lines "a" and "b"
  indentSelection(textarea);
  assert.equal(textarea.value, "    a\n    b\nc");
  assert.equal(textarea.selectionStart, 4);
  assert.equal(textarea.selectionEnd, 12);
});

test("outdent removes one level at an indented caret", () => {
  const textarea = new FakeTextarea("    x", 4, 4);
  outdentSelection(textarea);
  assert.equal(textarea.value, "x");
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 0);
});

test("outdent snaps an unindented caret back to the previous indent stop", () => {
  const textarea = new FakeTextarea("x", 1, 1);
  outdentSelection(textarea);
  assert.equal(textarea.value, "x");
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 0);
});

test("outdent pulls every covered line back one level", () => {
  const textarea = new FakeTextarea("    a\n    b\nc", 0, 10); // covers lines "a" and "b"
  outdentSelection(textarea);
  assert.equal(textarea.value, "a\nb\nc");
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 2);
});

test("outdent skips a covered line that is not indented", () => {
  const textarea = new FakeTextarea("    a\nb", 0, 6); // covers both lines
  outdentSelection(textarea);
  assert.equal(textarea.value, "a\nb");
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 2);
});

// --- whole-line cut / copy / duplicate ---

test("lineBlockOf takes the whole line a caret sits on, newline included", () => {
  assert.deepEqual(lineBlockOf("aa\nbb\ncc", 3, 3), { from: 3, to: 6 }, "caret on bb");
  assert.deepEqual(lineBlockOf("aa\nbb\ncc", 4, 4), { from: 3, to: 6 }, "caret at the end of bb");
  assert.deepEqual(lineBlockOf("aa\nbb\ncc", 0, 0), { from: 0, to: 3 }, "caret on the first line");
});

test("lineBlockOf keeps the last line whole when it has no newline", () => {
  assert.deepEqual(lineBlockOf("aa\nbb", 4, 4), { from: 3, to: 5 });
});

test("lineBlockOf covers a selection, but not the line it merely points at", () => {
  assert.deepEqual(lineBlockOf("aa\nbb\ncc", 1, 4), { from: 0, to: 6 }, "covers aa and bb");
  assert.deepEqual(lineBlockOf("aa\nbb\ncc", 1, 3), { from: 0, to: 3 }, "ends at bb's start");
});

test("lineTextOf is what Ctrl+C would put on the clipboard", () => {
  assert.equal(lineTextOf(new FakeTextarea("aa\nbb\ncc", 4, 4)), "bb\n");
  assert.equal(lineTextOf(new FakeTextarea("aa\nbb", 4, 4)), "bb");
});

test("removeLineBlock deletes the line and leaves the caret in its place", () => {
  const textarea = new FakeTextarea("aa\nbb\ncc", 4, 4);
  removeLineBlock(textarea, 3, 6);
  assert.equal(textarea.value, "aa\ncc");
  assert.equal(textarea.selectionStart, 3);
  assert.equal(textarea.selectionEnd, 3);
  assert.deepEqual(textarea.events, ["input"]);
});

test("Ctrl+D duplicates the line under the caret and puts the caret on the copy", () => {
  const textarea = new FakeTextarea("aa\nbb\ncc", 4, 4);
  assert.equal(duplicateLineBlock(textarea), true);
  assert.equal(textarea.value, "aa\nbb\nbb\ncc");
  // Column 1 of the copied "bb".
  assert.equal(textarea.selectionStart, 7);
  assert.equal(textarea.selectionEnd, 7);
  assert.deepEqual(textarea.events, ["input"]);
});

test("Ctrl+D on the last line adds the newline it needs first", () => {
  const textarea = new FakeTextarea("aa\nbb", 4, 4);
  duplicateLineBlock(textarea);
  assert.equal(textarea.value, "aa\nbb\nbb");
  assert.equal(textarea.selectionStart, 7);
});

test("Ctrl+D duplicates every line a selection covers and keeps it selected", () => {
  const textarea = new FakeTextarea("aa\nbb\ncc", 1, 4);
  duplicateLineBlock(textarea);
  assert.equal(textarea.value, "aa\nbb\naa\nbb\ncc");
  assert.equal(textarea.selectionStart, 7);
  assert.equal(textarea.selectionEnd, 10);
});

test("Ctrl+D on an empty document is a no-op", () => {
  const textarea = new FakeTextarea("", 0, 0);
  assert.equal(duplicateLineBlock(textarea), false);
  assert.equal(textarea.value, "");
  assert.deepEqual(textarea.events, []);
});

// --- Ctrl+/ line comments ---

test("Ctrl+/ comments the line under the caret and leaves the caret past the marker", () => {
  const textarea = new FakeTextarea("x", 0, 0);
  assert.equal(toggleLineComment(textarea), true);
  assert.equal(textarea.value, "// x");
  assert.equal(textarea.selectionStart, 3);
  assert.equal(textarea.selectionEnd, 3);
  assert.deepEqual(textarea.events, ["input"]);
});

test("Ctrl+/ writes the marker after the indentation", () => {
  const textarea = new FakeTextarea("    foo", 5, 5);
  toggleLineComment(textarea);
  assert.equal(textarea.value, "    // foo");
  // Column 1 of "foo" — five spaces of indentation, one space of marker.
  assert.equal(textarea.selectionStart, 8);
});

test("Ctrl+/ comments every line a selection covers and keeps the same text selected", () => {
  const textarea = new FakeTextarea("aa\nbb\ncc", 0, 5);
  toggleLineComment(textarea);
  assert.equal(textarea.value, "// aa\n// bb\ncc");
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 11);
  // The second press puts the text back exactly as it was.
  toggleLineComment(textarea);
  assert.equal(textarea.value, "aa\nbb\ncc");
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 5);
});

test("Ctrl+/ takes back both // and # comments", () => {
  const hash = new FakeTextarea("# note", 0, 0);
  assert.equal(toggleLineComment(hash), true);
  assert.equal(hash.value, "note");
  assert.equal(hash.selectionStart, 0);

  const slashes = new FakeTextarea("    // note", 0, 0);
  toggleLineComment(slashes);
  assert.equal(slashes.value, "    note");
});

test("Ctrl+/ on a mixed block comments only the lines still bare", () => {
  const textarea = new FakeTextarea("// aa\nbb", 0, 8);
  toggleLineComment(textarea);
  assert.equal(textarea.value, "// aa\n// bb");
});

test("Ctrl+/ gives a blank line the bare marker, so toggling it back adds nothing", () => {
  const textarea = new FakeTextarea("aa\n\nbb", 0, 6);
  toggleLineComment(textarea);
  assert.equal(textarea.value, "// aa\n//\n// bb");
  toggleLineComment(textarea);
  assert.equal(textarea.value, "aa\n\nbb");
});

test("Ctrl+/ does not comment the line a selection merely points at", () => {
  const textarea = new FakeTextarea("aa\nbb", 0, 2);
  toggleLineComment(textarea);
  assert.equal(textarea.value, "// aa\nbb");
});

test("Ctrl+/ on blank lines is a no-op", () => {
  const textarea = new FakeTextarea("\n  \n", 0, 0);
  assert.equal(toggleLineComment(textarea), false);
  assert.equal(textarea.value, "\n  \n");
  assert.deepEqual(textarea.events, []);
});
