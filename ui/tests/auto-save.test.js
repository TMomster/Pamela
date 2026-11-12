// 自动保存：菜单的五档间隔与「最后一次编辑后重新计时」的调度器。
// Pamela — autosave options and the timer that writes every dirty tab.

import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_SAVE_OPTIONS, createAutoSave, normalizeAutoSave } from "../auto-save.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A clock and a captured tick function; nothing here touches a real timer. */
function harness({ interval = 30, dirty = () => true, canSave = () => true } = {}) {
  let now = 0;
  let tickFn = null;
  const writes = [];
  const autoSave = createAutoSave({
    getInterval: () => interval,
    canSave,
    hasDirty: dirty,
    saveDirty: () => { writes.push(now); },
    now: () => now,
    setTimer: (fn) => { tickFn = fn; return 1; },
    clearTimer: () => { tickFn = null; },
  });
  return {
    autoSave,
    writes,
    tick: (at) => { now = at; tickFn?.(); return flush(); },
    edit: (at) => { now = at; autoSave.noteEdit(); },
    setInterval: (seconds) => { interval = seconds; },
  };
}

test("the five options are the ones in 文件 → 自动保存", () => {
  assert.deepEqual(AUTO_SAVE_OPTIONS.map(({ value }) => value), [0, 30, 60, 180, 300]);
  assert.deepEqual(AUTO_SAVE_OPTIONS.map(({ label }) => label), [
    "关", "30秒", "1分钟", "3分钟", "5分钟",
  ]);
});

test("normalizeAutoSave clamps an unknown stored value to off", () => {
  assert.equal(normalizeAutoSave(60), 60);
  assert.equal(normalizeAutoSave("180"), 180);
  assert.equal(normalizeAutoSave(45), 0);
  assert.equal(normalizeAutoSave(undefined), 0);
  assert.equal(normalizeAutoSave(null), 0);
});

test("「关」never writes, however long the editor has been idle", async () => {
  const h = harness({ interval: 0 });
  h.autoSave.start();
  await h.tick(600000);
  assert.equal(h.writes.length, 0);
});

test("a save waits a full interval after the last edit", async () => {
  const h = harness({ interval: 30 });
  h.autoSave.start();
  await h.tick(10000);
  assert.equal(h.writes.length, 0, "还没到 30 秒");
  h.edit(12000);
  await h.tick(40000);
  assert.equal(h.writes.length, 0, "最后一次编辑后才过了 28 秒");
  await h.tick(42000);
  assert.equal(h.writes.length, 1, "最后一次编辑后满 30 秒才写");
});

test("one tick writes once even when several tabs are dirty", async () => {
  const h = harness({ interval: 60 });
  h.autoSave.start();
  await h.tick(60000);
  await h.tick(60001);
  assert.equal(h.writes.length, 1, "保存是一次批量动作，不是每个标签一次");
});

test("a clean editor, a running performance and a stalled save block writing", async () => {
  const clean = harness({ interval: 30, dirty: () => false });
  clean.autoSave.start();
  await clean.tick(30000);
  assert.equal(clean.writes.length, 0);

  const playing = harness({ interval: 30, canSave: () => false });
  playing.autoSave.start();
  await playing.tick(30000);
  assert.equal(playing.writes.length, 0);

  let now = 0;
  let tickFn = null;
  let release = null;
  let saveCalls = 0;
  const stuck = createAutoSave({
    getInterval: () => 30,
    hasDirty: () => true,
    saveDirty: () => {
      saveCalls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
    now: () => now,
    setTimer: (fn) => { tickFn = fn; return 1; },
    clearTimer: () => {},
  });
  stuck.start();
  now = 30000;
  tickFn();
  await flush();
  assert.equal(saveCalls, 1, "第一次到点开始写盘");
  now = 31000;
  tickFn();
  await flush();
  assert.equal(saveCalls, 1, "上一次没结束，不会并发写第二次");
  release();
  await flush();
  now = 62000;
  tickFn();
  await flush();
  assert.equal(saveCalls, 2, "上一段结束后重新计时，下一段照常写盘");
});
