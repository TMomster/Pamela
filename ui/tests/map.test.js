// `.flowmap` 文件类型与 always-main.pe 入口规则测试。
// Tests for the `.flowmap` file type and the always-main.pe entry rule.

import assert from "node:assert/strict";
import test from "node:test";

import {
  findEntryScript,
  isMapPath,
  validateJsonName,
  validateMapName,
} from "../project-actions.js";

test("isMapPath matches .flowmap, and reads the old .pmap", () => {
  assert.equal(isMapPath("maps/flow.flowmap"), true);
  assert.equal(isMapPath("flow.FLOWMAP"), true);
  // A project made before the rename still opens on the canvas.
  assert.equal(isMapPath("maps/flow.pmap"), true);
  assert.equal(isMapPath("flow.PMAP"), true);
  assert.equal(isMapPath("flow.pe"), false);
  assert.equal(isMapPath("flow.graph.json"), false);
});

test("validateMapName enforces .flowmap", () => {
  assert.equal(validateMapName(""), "文件名不能为空");
  assert.equal(validateMapName("a/b.flowmap"), "文件名不能包含路径分隔符");
  assert.equal(validateMapName("flow.txt"), "地图文件必须以 .flowmap 结尾");
  assert.equal(validateMapName("flow.flowmap"), "");
  // The old suffix is read but not written: a new file is always `.flowmap`.
  assert.match(validateMapName("flow.pmap"), /\.flowmap/);
});

test("validateJsonName enforces .json", () => {
  assert.equal(validateJsonName("data.json"), "");
  assert.equal(validateJsonName("data.flowmap"), "JSON 文件必须以 .json 结尾");
});

test("findEntryScript points at scripts/main.pe", () => {
  const project = {
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "main.pe", path: "scripts/main.pe", is_dir: false, children: [] },
          { name: "other.pe", path: "scripts/other.pe", is_dir: false, children: [] },
        ],
      },
      {
        name: "maps",
        path: "maps",
        is_dir: true,
        children: [
          { name: "flow.flowmap", path: "maps/flow.flowmap", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.equal(findEntryScript(project), "scripts/main.pe");
});

test("findEntryScript still finds the old main.pamela", () => {
  // The suffix changed, not the file: a project made earlier still has an entry.
  const project = {
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "main.pamela", path: "scripts/main.pamela", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.equal(findEntryScript(project), "scripts/main.pamela");
});

test("findEntryScript returns null without main.pe", () => {
  const project = {
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "other.pe", path: "scripts/other.pe", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.equal(findEntryScript(project), null);
});
