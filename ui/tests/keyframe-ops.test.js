// 关键帧文件身份的行为测试：id 重建、引用改写、标签跟随。
// Tests for the key frame file domain.

import assert from "node:assert/strict";
import test from "node:test";

import { createKeyframeOps } from "../keyframe-ops.js";
import { buildPathFile } from "../path.js";

/**
 * A fake host: files in memory, a path cache, a transcript of the writes.
 */
function harness({ files = {}, keyFile = null, project = null, editor = null } = {}) {
  const disk = new Map(Object.entries(files));
  const written = [];
  const pathCache = new Map();
  const rehomed = [];
  const session = { project, openPath: null, keyFile };
  const dom = { editorText: editor };
  const actions = {
    read: async (path) => {
      if (!disk.has(path)) {
        throw new Error(`no such file: ${path}`);
      }
      return disk.get(path);
    },
    write: async (path, text) => {
      written.push([path, text]);
      disk.set(path, text);
    },
  };
  const ops = createKeyframeOps({
    dom,
    session,
    getActions: () => actions,
    getPathCache: () => pathCache,
    getPathEditor: () => ({
      isOpen: () => true,
      rehome: (id, name) => rehomed.push([id, name]),
    }),
  });
  return { ops, session, disk, written, pathCache, rehomed };
}

test("一个副本把文件里的 id 换成自己的名字", async () => {
  const { ops, written, pathCache } = harness({
    files: { "data/key-b.keyframes": '{"id":"a","segments":[]}' },
  });

  const result = await ops.rehomeKeyframesFile("data/key-b.keyframes");

  assert.equal(result.id, "b");
  assert.equal(written.length, 1);
  assert.match(written[0][1], /"id": "b"/);
  assert.equal(pathCache.has("b"), true, "新 id 进缓存，副本才播得到");
});

test("改名把旧 id 从缓存里删掉，副本不会顶掉原文件", async () => {
  const { ops, pathCache } = harness({
    files: { "data/key-b.keyframes": '{"id":"a","segments":[]}' },
  });
  pathCache.set("a", { id: "a" });

  await ops.rehomeKeyframesFile("data/key-b.keyframes", "data/key-a.keyframes");

  assert.equal(pathCache.has("a"), false);
  assert.equal(pathCache.has("b"), true);
});

test("id 已经对了就不重写文件", async () => {
  const canonical = `${JSON.stringify(buildPathFile({ id: "b", segments: [] }), null, 2)}\n`;
  const { ops, written } = harness({
    files: { "data/key-b.keyframes": canonical },
  });

  const result = await ops.rehomeKeyframesFile("data/key-b.keyframes");

  assert.equal(result.before, result.after);
  assert.deepEqual(written, [], "文件已经按新名字写对了，不该再动一次");
});

test("打不开的关键帧文件不阻断改名", async () => {
  const { ops } = harness();
  assert.equal(await ops.rehomeKeyframesFile("data/key-b.keyframes"), null);

  const broken = harness({ files: { "data/key-b.keyframes": "{ 不是 JSON" } });
  assert.equal(await broken.ops.rehomeKeyframesFile("data/key-b.keyframes"), null);
});

test("改名后打开的关键帧标签跟着走", () => {
  const { ops, session, rehomed } = harness({
    keyFile: { path: "data/key-a.keyframes", id: "a" },
  });

  ops.rehomeKeyTab("data/key-a.keyframes", "data/key-b.keyframes", { id: "b", name: "" });

  assert.equal(session.keyFile.path, "data/key-b.keyframes");
  assert.equal(session.keyFile.id, "b");
  assert.deepEqual(rehomed, [["b", ""]], "编辑器里那份文档的 id 也要换");
});

test("打开的是别的关键帧文件时什么都不动", () => {
  const { ops, session, rehomed } = harness({
    keyFile: { path: "data/key-other.keyframes", id: "other" },
  });

  ops.rehomeKeyTab("data/key-a.keyframes", "data/key-b.keyframes", { id: "b", name: "" });

  assert.equal(session.keyFile.path, "data/key-other.keyframes");
  assert.deepEqual(rehomed, []);
});

test("剧本里的 key() 跟着改名重写", async () => {
  const { ops, written } = harness({
    project: {
      tree: [{ path: "scripts", is_dir: true, children: [{ path: "scripts/main.pe", is_script: true }] }],
    },
    files: { "scripts/main.pe": 'ch.key("key-a.keyframes")\n' },
  });

  const changes = await ops.rekeyReferences("data/key-a.keyframes", "data/key-b.keyframes");

  // 第一次读走 `harness` 内存盘，写走同一个盘，所以 changes 里带着前后文本。
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "scripts/main.pe");
  assert.match(changes[0].after, /key\("key-b\.keyframes"\)/);
  assert.match(changes[0].before, /key\("key-a\.keyframes"\)/);
  assert.equal(written.at(-1)[0], "scripts/main.pe");
});

test("打开的剧本走 textarea，不写盘", async () => {
  const dispatched = [];
  const editor = {
    value: 'ch.key("key-a.keyframes")\n',
    selectionStart: 3,
    setSelectionRange: () => {},
    dispatchEvent: (event) => dispatched.push(event.type),
  };
  const { ops, session, written, disk } = harness({
    project: {
      tree: [{ path: "scripts", is_dir: true, children: [{ path: "scripts/main.pe", is_script: true }] }],
    },
    files: { "scripts/main.pe": 'ch.key("key-a.keyframes")\n' },
    editor,
  });
  session.openPath = "scripts/main.pe";

  const changes = await ops.rekeyReferences("data/key-a.keyframes", "data/key-b.keyframes");

  assert.equal(changes.length, 1);
  assert.match(editor.value, /key\("key-b\.keyframes"\)/);
  assert.deepEqual(written, [], "未保存的剧本不能被磁盘上的旧文本覆盖");
  assert.match(disk.get("scripts/main.pe"), /key-a/, "磁盘上仍是旧文本，直到作者保存");
  assert.deepEqual(dispatched, ["input"], "改完要通知编辑器重绘");
});

test("坏掉的关键帧文件不进缓存", () => {
  const { ops, pathCache } = harness();

  ops.cacheKeyframes("{ 不是 JSON", "a");
  assert.equal(pathCache.size, 0);

  ops.cacheKeyframes('{"id":"a","segments":[]}', "a");
  assert.equal(pathCache.get("a").id, "a");
});

test("撤销时的文本重放两个方向都能走", async () => {
  const { ops, written } = harness();
  const changes = [
    { path: "scripts/a.pe", before: "old", after: "new" },
    { path: "scripts/b.pe", before: "one", after: "two" },
  ];

  await ops.replayTexts(changes, "after");
  assert.deepEqual(
    written.map((entry) => entry[1]),
    ["new", "two"],
  );

  await ops.replayTexts(changes, "before");
  assert.deepEqual(
    written.map((entry) => entry[1]),
    ["new", "two", "old", "one"],
  );
});
