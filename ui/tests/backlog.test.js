// 回放记录滚轮手势测试。
// Tests for the backlog's wheel gesture.

import assert from "node:assert/strict";
import test from "node:test";

import { wheelClosesBacklog, wheelOpensBacklog } from "../backlog.js";

test("an upward wheel over the scene opens the history", () => {
  assert.equal(
    wheelOpensBacklog({ open: false, onStage: true, covered: false, deltaY: -120 }),
    true,
  );
});

test("a downward wheel over the scene does nothing", () => {
  assert.equal(
    wheelOpensBacklog({ open: false, onStage: true, covered: false, deltaY: 120 }),
    false,
  );
});

test("the wheel does not reopen a history that is already up", () => {
  assert.equal(
    wheelOpensBacklog({ open: true, onStage: true, covered: false, deltaY: -120 }),
    false,
  );
});

test("a covered stage leaves the wheel to the panel on top", () => {
  // The save/load grid sits over the scene and has its own scrolling; opening
  // the history underneath it would be a second overlay the player never asked
  // for.
  assert.equal(
    wheelOpensBacklog({ open: false, onStage: true, covered: true, deltaY: -120 }),
    false,
  );
});

test("the gesture needs a stage with a run on it", () => {
  assert.equal(
    wheelOpensBacklog({ open: false, onStage: false, covered: false, deltaY: -120 }),
    false,
  );
});

test("scrolling up at the first line closes the history", () => {
  assert.equal(wheelClosesBacklog({ open: true, deltaY: -120, scrollTop: 0 }), true);
});

test("scrolling up inside the history is the list's own scroll", () => {
  // There is text above the current position, so the wheel scrolls rather than
  // closing — otherwise nothing past the first screen could ever be read.
  assert.equal(wheelClosesBacklog({ open: true, deltaY: -120, scrollTop: 400 }), false);
});

test("scrolling down never closes the history", () => {
  assert.equal(wheelClosesBacklog({ open: true, deltaY: 120, scrollTop: 0 }), false);
  assert.equal(wheelClosesBacklog({ open: true, deltaY: 120, scrollTop: 400 }), false);
});

test("a closed history ignores the wheel", () => {
  assert.equal(wheelClosesBacklog({ open: false, deltaY: -120, scrollTop: 0 }), false);
});

test("a sub-pixel scroll position still reads as the top", () => {
  // A browser can leave `scrollTop` at a fraction after a smooth scroll; without
  // the slack the gesture would never fire on those machines.
  assert.equal(wheelClosesBacklog({ open: true, deltaY: -120, scrollTop: 0.4 }), true);
  assert.equal(wheelClosesBacklog({ open: true, deltaY: -120, scrollTop: 1 }), true);
  // A real scroll away from the top is not the gesture.
  assert.equal(wheelClosesBacklog({ open: true, deltaY: -120, scrollTop: 2 }), false);
});
