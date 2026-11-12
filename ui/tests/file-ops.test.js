// 文件操作撤销栈的行为测试。
// Tests for the resource tree's undo history.

import assert from "node:assert/strict";
import test from "node:test";

import { createFileOps } from "../file-ops.js";

function harness({ actions = {} } = {}) {
  const messages = [];
  const calls = { refresh: 0 };
  const session = { project: null, openPath: null };
  const ops = createFileOps({
    getActions: () => actions,
    session,
    refreshTree: async () => {
      calls.refresh += 1;
      return session.project;
    },
    setMessage: (text, options = {}) => messages.push({ text, error: Boolean(options.error) }),
  });
  return { ops, session, messages, calls };
}

test("undo replays the inverse and moves the entry to the redo branch", async () => {
  const { ops, calls, messages } = harness();
  const order = [];

  ops.record({ redo: () => order.push("redo"), undo: () => order.push("undo") });
  await ops.undo();

  assert.deepEqual(order, ["undo"]);
  assert.equal(calls.refresh, 1);
  assert.equal(messages.at(-1).text, "已撤销文件操作");

  await ops.redo();
  assert.deepEqual(order, ["undo", "redo"]);
  assert.equal(calls.refresh, 2);
  assert.equal(messages.at(-1).text, "已重做文件操作");
});

test("a new action drops the redo branch", async () => {
  const { ops, messages } = harness();
  const replayed = [];

  ops.record({ redo: () => replayed.push("first"), undo() {} });
  await ops.undo();

  ops.record({ redo: () => replayed.push("second"), undo() {} });
  await ops.redo();
  // The undo branch was discarded, so the earlier action cannot be replayed at all.
  assert.deepEqual(replayed, []);
  assert.equal(messages.at(-1).text, "没有可重做的文件操作");
});

test("an empty history reports instead of throwing", async () => {
  const { ops, messages } = harness();

  await ops.undo();
  assert.equal(messages.at(-1).text, "没有可撤销的文件操作");

  await ops.redo();
  assert.equal(messages.at(-1).text, "没有可重做的文件操作");
});

test("a failed undo keeps the entry for another try", async () => {
  const { ops, messages } = harness();
  let attempts = 0;

  ops.record({
    redo() {},
    undo() {
      attempts += 1;
      throw new Error("磁盘只读");
    },
  });

  await ops.undo();
  assert.equal(attempts, 1);
  assert.equal(messages.at(-1).error, true);
  assert.match(messages.at(-1).text, /撤销失败/);

  await ops.undo();
  assert.equal(attempts, 2, "the entry must still be on the undo stack");
});

test("the history is bounded", async () => {
  const { ops } = harness();
  const undone = [];

  for (let index = 0; index < 120; index += 1) {
    ops.record({ redo() {}, undo: () => undone.push(index) });
  }
  // 120 recorded, limit 100: the oldest 20 are gone.
  for (let index = 0; index < 100; index += 1) {
    await ops.undo();
  }
  assert.equal(undone.length, 100);
  // Undo is last-in-first-out: the 100 kept entries are 20..119, so 20 comes last.
  assert.equal(undone.at(-1), 20);
  assert.equal(undone.includes(19), false);
});

test("a rename keeps the open file pointer in step", () => {
  const { ops, session } = harness();
  session.openPath = "scripts/a.pe";

  ops.rehomeAfterRename("scripts/a.pe", "scripts/b.pe");

  assert.equal(session.openPath, "scripts/b.pe");
});

test("a rename of the entry script rewrites the manifest", async () => {
  const entries = [];
  const { ops, session } = harness({
    actions: {
      setEntry: async (path) => {
        entries.push(path);
        return { ...session.project, entry: path };
      },
    },
  });
  session.project = { name: "p", entry: "scripts/a.pe", tree: [] };

  ops.rehomeAfterRename("scripts/a.pe", "scripts/b.pe");
  await Promise.resolve();

  assert.deepEqual(entries, ["scripts/b.pe"]);
  assert.equal(session.project.entry, "scripts/b.pe");
});

test("restoreEntry recreates the folders and writes the files back", async () => {
  const written = [];
  const folders = [];
  const { ops } = harness({
    actions: {
      createFolder: async (path) => folders.push(path),
      write: async (path, content) => written.push([path, content]),
    },
  });

  await ops.restoreEntry("scripts", {
    files: [
      { path: "scripts/a.pe", content: "a" },
      { path: "scripts/sub/b.pe", content: "b" },
    ],
  });

  assert.deepEqual(folders, ["scripts", "scripts/sub"]);
  assert.deepEqual(written, [
    ["scripts/a.pe", "a"],
    ["scripts/sub/b.pe", "b"],
  ]);
});

test("restoreEntry rebuilds an empty folder as a folder", async () => {
  const folders = [];
  const { ops } = harness({
    actions: { createFolder: async (path) => folders.push(path) },
  });

  await ops.restoreEntry("empty", { files: [] });
  assert.deepEqual(folders, ["empty"]);
});
