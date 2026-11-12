// 编辑器语法错误标记测试。
// Tests for the editor's syntax-error marks.

import assert from "node:assert/strict";
import test from "node:test";

import { errorMarkRect, syntaxErrorIn } from "../editor-errors.js";

test("a clean script has no error to mark", () => {
  assert.equal(syntaxErrorIn("ch = Character(\"a.png\")\nch.enable()"), null);
  assert.equal(syntaxErrorIn(""), null);
  assert.equal(syntaxErrorIn(null), null);
});

test("an unclosed block is reported on its own line", () => {
  const error = syntaxErrorIn("cue(50) {");
  assert.ok(error, "a broken script must be detected");
  assert.equal(error.line, 1);
  assert.equal(error.column, 1);
  assert.match(error.message, /语句块/);
});

test("a missing value is reported on the line where it is missing", () => {
  // The row is the key constraint of an inline mark: an error on line 2 must not
  // be painted on line 1.
  assert.equal(syntaxErrorIn("a = ").line, 1);
  assert.equal(syntaxErrorIn("a = 1\nb = ").line, 2);
});

test("a lexer error is reported too, not just a parser error", () => {
  const error = syntaxErrorIn("ch = Character(\"a.png)");
  assert.ok(error, "an unterminated string must be detected");
  assert.equal(error.line, 1);
  assert.ok(error.message.length > 0);
});

test("an error with no position still gets a usable message", () => {
  const error = syntaxErrorIn("a = ");
  assert.equal(typeof error.message, "string");
  assert.ok(Number.isFinite(error.line));
  assert.ok(Number.isFinite(error.column));
});

test("errorMarkRect places the mark at the 1-based line and column", () => {
  const rect = errorMarkRect("abc\ndefgh\n", { line: 2, column: 3 }, {
    lineHeight: 20,
    charWidth: 8,
    padTop: 12,
    padLeft: 14,
  });
  assert.deepEqual(rect, { top: 32, left: 30, width: 24, height: 20, row: 1 });
});

test("errorMarkRect is at least one character wide on an empty line", () => {
  const rect = errorMarkRect("a\n\nb", { line: 2, column: 1 }, {
    lineHeight: 18,
    charWidth: 9,
    padTop: 0,
    padLeft: 0,
  });
  assert.equal(rect.top, 18);
  assert.equal(rect.width, 9);
  assert.equal(rect.row, 1);
});

test("errorMarkRect clamps a position that runs past the text", () => {
  const rect = errorMarkRect("abc", { line: 99, column: 99 }, {
    lineHeight: 20,
    charWidth: 8,
    padTop: 12,
    padLeft: 14,
  });
  assert.equal(rect.row, 0);
  assert.equal(rect.top, 12);
  assert.equal(rect.left, 14 + 3 * 8);
  assert.ok(rect.width >= 8);
});
