// 资源树命令的行为测试：粘贴副本、重命名、引用改写、删除撤销。
// Tests for the resource tree's mutating commands.

import assert from "node:assert/strict";
import test from "node:test";

import { createFileOps } from "../file-ops.js";
import { createKeyframeOps } from "../keyframe-ops.js";
import { buildPathFile } from "../path.js";
import { canPaste, createTreeOps, targetDirectory } from "../tree-ops.js";

const keyframeText = (id) => `${JSON.stringify(buildPathFile({ id, segments: [] }), null, 2)}\n`;

/**
 * A fake host: files in memory, a project tree, a transcript of the messages.
 */
function harness({ files = {}, project = null, prompt = async () => null, confirm = async () => true } = {}) {
  const disk = new Map(Object.entries(files));
  const messages = [];
  const opened = [];
  const entries = [];
  const scripts = [];
  const pathCache = new Map();
  const session = { project, openPath: null, clipboard: null, keyFile: null };
  const setMessage = (text, options = {}) => messages.push({ text, error: Boolean(options.error) });
  const actions = {
    read: async (path) => {
      if (!disk.has(path)) {
        throw new Error(`no such file: ${path}`);
      }
      return disk.get(path);
    },
    write: async (path, text) => {
      disk.set(path, text);
    },
    copy: async (from, to) => {
      disk.set(to, disk.get(from));
    },
    remove: async (path) => {
      disk.delete(path);
    },
    createFolder: async () => {},
    createScript: async (_project, options) => {
      scripts.push(options);
      return `scripts/new${options.suffix}`;
    },
    reload: async () => session.project,
    rename: async (path, name) => {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const to = parent ? `${parent}/${name}` : name;
      disk.set(to, disk.get(path));
      disk.delete(path);
    },
    setEntry: async (path) => {
      entries.push(path);
      session.project = { ...session.project, entry: path };
      return session.project;
    },
  };
  const refreshTree = async () => session.project;
  const fileOps = createFileOps({ getActions: () => actions, session, refreshTree, setMessage });
  const keyframeOps = createKeyframeOps({
    dom: {},
    session,
    getActions: () => actions,
    getPathCache: () => pathCache,
    getPathEditor: () => ({ isOpen: () => false }),
  });
  const ops = createTreeOps({
    getActions: () => actions,
    getPromptConfirm: () => confirm,
    session,
    fileOps,
    keyframeOps,
    setMessage,
    refreshTree,
    openFile: async (path) => opened.push(path),
    refreshEditor: () => {},
    refreshResourcePanel: () => {},
    openPathEditor: async (path) => opened.push(path),
    applyProject: (next) => {
      session.project = next;
    },
    openImageEditor: async () => {},
    openAudioEditor: async () => {},
    isEditorDirty: () => false,
    describeTarget: () => null,
    menuItems: () => [],
    promptText: prompt,
  });
  return { ops, session, disk, messages, opened, entries, scripts, pathCache, fileOps };
}

/** A project tree with `data/` holding one key frame file and a script beside it. */
function projectWith(...paths) {
  const children = paths.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }));
  return {
    name: "demo",
    tree: [{ path: "data", name: "data", is_dir: true, children: children.filter((n) => n.path.startsWith("data/")) },
      { path: "scripts", name: "scripts", is_dir: true, children: children.filter((n) => n.path.startsWith("scripts/")).map((n) => ({ ...n, is_script: true })) }],
  };
}

test("粘贴关键帧文件：副本换掉自己的 id，并提示新的 key()", async () => {
  const { ops, session, disk, messages } = harness({
    project: projectWith("data/key-a.keyframes"),
    files: { "data/key-a.keyframes": keyframeText("a") },
  });
  session.clipboard = { path: "data/key-a.keyframes", name: "key-a.keyframes", isDir: false };

  await ops.handlers["tree.paste"]({ path: "data", isDir: true });

  assert.equal(disk.has("data/key-a-copy.keyframes"), true);
  assert.match(disk.get("data/key-a-copy.keyframes"), /"id": "a-copy"/);
  assert.match(messages.at(-1).text, /key\("key-a-copy\.keyframes"\)/);
});

test("重命名关键帧文件：文件内 id、剧本引用、打开的文件指针一起走", async () => {
  const { ops, session, disk, messages, entries } = harness({
    project: { ...projectWith("data/key-a.keyframes", "scripts/main.pe"), entry: "scripts/main.pe" },
    files: {
      "data/key-a.keyframes": keyframeText("a"),
      "scripts/main.pe": 'ch.key("key-a.keyframes")\n',
    },
    prompt: async () => "key-b.keyframes",
  });
  session.openPath = "data/key-a.keyframes";

  await ops.handlers["tree.rename"]({
    path: "data/key-a.keyframes",
    name: "key-a.keyframes",
    isDir: false,
  });

  assert.equal(disk.has("data/key-a.keyframes"), false);
  assert.match(disk.get("data/key-b.keyframes"), /"id": "b"/);
  assert.match(disk.get("scripts/main.pe"), /key\("key-b\.keyframes"\)/);
  assert.equal(session.openPath, "data/key-b.keyframes", "打开的文件跟着改名走");
  assert.deepEqual(entries, [], "关键帧文件不是入口脚本，manifest 不该被改写");
  assert.match(messages.at(-1).text, /已重命名为 data\/key-b\.keyframes/);
});

test("撤销重命名：文件名、文件内 id、剧本引用三样一起退回", async () => {
  const { ops, session, disk, fileOps } = harness({
    project: projectWith("data/key-a.keyframes", "scripts/main.pe"),
    files: {
      "data/key-a.keyframes": keyframeText("a"),
      "scripts/main.pe": 'ch.key("key-a.keyframes")\n',
    },
    prompt: async () => "key-b.keyframes",
  });

  await ops.handlers["tree.rename"]({ path: "data/key-a.keyframes", name: "key-a.keyframes", isDir: false });
  assert.equal(disk.has("data/key-b.keyframes"), true);

  await fileOps.undo();

  assert.equal(disk.has("data/key-a.keyframes"), true);
  assert.equal(disk.has("data/key-b.keyframes"), false);
  assert.match(disk.get("data/key-a.keyframes"), /"id": "a"/);
  assert.match(disk.get("scripts/main.pe"), /key\("key-a\.keyframes"\)/);
});

test("重命名入口脚本会改 manifest", async () => {
  const { ops, session, entries } = harness({
    project: { ...projectWith("scripts/main.pe"), entry: "scripts/main.pe" },
    files: { "scripts/main.pe": "say()\n" },
    prompt: async () => "start.pe",
  });

  await ops.handlers["tree.rename"]({ path: "scripts/main.pe", name: "main.pe", isDir: false });

  assert.deepEqual(entries, ["scripts/start.pe"]);
  assert.equal(session.project.entry, "scripts/start.pe");
});

test("取消命名直接返回，磁盘一个字节都不动", async () => {
  const { ops, disk } = harness({
    project: projectWith("data/key-a.keyframes"),
    files: { "data/key-a.keyframes": keyframeText("a") },
    prompt: async () => null,
  });

  await ops.handlers["tree.rename"]({ path: "data/key-a.keyframes", name: "key-a.keyframes", isDir: false });

  assert.equal(disk.has("data/key-a.keyframes"), true);
  assert.equal(disk.has("data/key-b.keyframes"), false);
});

test("删除前先快照，撤销能把文件重建回来", async () => {
  const { ops, disk, fileOps } = harness({
    project: projectWith("scripts/main.pe"),
    files: { "scripts/main.pe": "say()\n" },
  });

  await ops.handlers["tree.delete"]({ path: "scripts/main.pe", name: "main.pe", isDir: false });
  assert.equal(disk.has("scripts/main.pe"), false);

  await fileOps.undo();
  assert.equal(disk.get("scripts/main.pe"), "say()\n");
});

test("设为入口脚本写 manifest，再点一次取消", async () => {
  const { ops, session, entries } = harness({
    project: projectWith("scripts/main.pe"),
    files: { "scripts/main.pe": "say()\n" },
  });
  const target = { path: "scripts/main.pe", name: "main.pe", isDir: false };

  await ops.handlers["tree.toggleEntry"](target);
  assert.deepEqual(entries, ["scripts/main.pe"]);

  await ops.handlers["tree.toggleEntry"](target);
  assert.deepEqual(entries, ["scripts/main.pe", ""]);
  assert.equal(session.project.entry, "");
});

test("新建 pe / mpe 剧本：后缀从菜单一路传到后端并打开", async () => {
  const { ops, scripts, opened } = harness({ project: projectWith("scripts/main.pe"), files: {} });

  await ops.newScript(".pe");
  await ops.newScript(".mpe");

  assert.deepEqual(
    scripts.map((options) => options.suffix),
    [".pe", ".mpe"],
  );
  assert.deepEqual(opened, ["scripts/new.pe", "scripts/new.mpe"]);
});

test("targetDirectory：文件夹落在自己里面，文件落在同级", () => {
  assert.equal(targetDirectory({ path: "data", isDir: true }), "data");
  assert.equal(targetDirectory({ path: "data/key-a.keyframes", isDir: false }), "data");
  assert.equal(targetDirectory({ path: "main.pe", isDir: false }), "");
});

test("canPaste：文件夹不能粘进自己和自己的子孙里", () => {
  assert.equal(canPaste(null, "data"), false);

  const folder = { path: "data", isDir: true };
  assert.equal(canPaste(folder, "data"), false);
  assert.equal(canPaste(folder, "data/sub"), false);
  assert.equal(canPaste(folder, "scripts"), true);

  const file = { path: "data/a.pe", isDir: false };
  assert.equal(canPaste(file, "data"), true);
});
