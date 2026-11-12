import test from "node:test";
import assert from "node:assert/strict";
import { createHistory, record, undo, redo, canUndo, canRedo, MAX_HISTORY } from "../history.js";

const sample = () => ({ version: 2, canvas: { width: 800, height: 600 }, active: "dialog", styles: { dialog: { layers: [] }, narration: { layers: [] } } });

test("undo returns null on an empty history", () => {
  const history = createHistory();
  assert.equal(canUndo(history), false);
  assert.equal(undo(history, sample()), null);
});

test("a recorded step can be undone and redone", () => {
  const history = createHistory();
  const doc = sample();
  doc.styles.dialog.layers.push({ id: "a", type: "rect" });

  record(history, doc);
  doc.styles.dialog.layers.push({ id: "b", type: "rect" });
  assert.equal(doc.styles.dialog.layers.length, 2);

  const before = undo(history, doc);
  assert.ok(before);
  assert.equal(before.styles.dialog.layers.length, 1);
  assert.equal(canRedo(history), true);

  const after = redo(history, before);
  assert.ok(after);
  assert.equal(after.styles.dialog.layers.length, 2);
  assert.equal(canRedo(history), false);
});

test("undo does not alias the live document", () => {
  const history = createHistory();
  const doc = sample();
  record(history, doc);
  doc.styles.dialog.layers.push({ id: "x" });

  const restored = undo(history, doc);
  restored.styles.dialog.layers.push({ id: "y" });
  assert.equal(doc.styles.dialog.layers.length, 1, "mutating the snapshot must not touch the live doc");
});

test("recording clears the redo stack", () => {
  const history = createHistory();
  const doc = sample();
  record(history, doc);
  doc.styles.dialog.layers.push({ id: "a" });
  undo(history, doc);
  assert.equal(canRedo(history), true);

  record(history, doc); // a new branch
  assert.equal(canRedo(history), false);
});

test("the past stack is capped at MAX_HISTORY", () => {
  const history = createHistory();
  const doc = sample();
  for (let index = 0; index <= MAX_HISTORY + 5; index += 1) {
    record(history, doc);
  }
  assert.ok(history.past.length <= MAX_HISTORY);
});
