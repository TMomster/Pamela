// 存档文件测试：命名、内容与拒绝条件。
// Tests for save files: what they name, what they carry and what is refused.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSave,
  defaultSaveName,
  hashText,
  isSavePath,
  parseSave,
  saveFileName,
  saveFilesIn,
  saveNameFrom,
  saveNamesIn,
  savePathFor,
  SAVE_VERSION,
  verifyScripts,
} from "../save.js";

test("a save file lives under saves and carries the json suffix", () => {
  assert.equal(savePathFor("第一章 教室"), "saves/第一章 教室.json");
  assert.equal(savePathFor("  a  b  "), "saves/a b.json");
  assert.equal(savePathFor("a/b:c*"), "saves/a-b-c-.json");
  assert.equal(isSavePath("saves/a.json"), true);
  assert.equal(isSavePath("saves\\a.json"), true);
  assert.equal(isSavePath("scripts/a.pamela"), false);
  assert.equal(isSavePath("saves/a.pamela"), false);
});

test("a name that cannot be a file is refused, not quietly changed", () => {
  assert.throws(() => saveFileName(""), /不能为空/);
  assert.throws(() => saveFileName("   "), /不能为空/);
  assert.throws(() => saveFileName(".."), /不能只有点/);
});

test("a save path names its slot back", () => {
  assert.equal(saveNameFrom("saves/第一章 教室.json"), "第一章 教室");
  assert.equal(saveNameFrom("saves\\a.json"), "a");
});

test("a default name says when the save was made", () => {
  // Month is zero-based, as `Date` has it.
  const name = defaultSaveName(new Date(2026, 9, 18, 15, 33));
  assert.equal(name, "存档 2026-10-18 15-33");
  assert.equal(saveFileName(name), name);
});

test("the save slots are read off the project tree", () => {
  const tree = [
    { name: "scripts", path: "scripts", is_dir: true, children: [] },
    {
      name: "saves",
      path: "saves",
      is_dir: true,
      children: [
        { name: "b.json", path: "saves/b.json", is_dir: false },
        { name: "a.json", path: "saves/a.json", is_dir: false },
        { name: "notes.txt", path: "saves/notes.txt", is_dir: false },
      ],
    },
  ];
  assert.deepEqual(saveNamesIn(tree), ["a", "b"]);
  assert.deepEqual(saveNamesIn([]), []);
  assert.deepEqual(saveNamesIn(null), []);
});

test("a slot knows the file it stands for, not just its name", () => {
  const tree = [
    { name: "scripts", path: "scripts", is_dir: true, children: [] },
    {
      name: "saves",
      path: "saves",
      is_dir: true,
      children: [
        { name: "b.json", path: "saves/b.json", is_dir: false },
        { name: "a.json", path: "saves/a.json", is_dir: false },
      ],
    },
  ];
  assert.deepEqual(saveFilesIn(tree), [
    { name: "a", path: "saves/a.json" },
    { name: "b", path: "saves/b.json" },
  ]);
  // A `.json` outside `saves/` is not a save: the grid would otherwise offer
  // every JSON file in the project as a slot.
  assert.deepEqual(
    saveFilesIn([{ name: "notes.json", path: "notes.json", is_dir: false }]),
    [],
  );
});

test("a save carries the position and the answers, not the stage", () => {
  const document = buildSave({
    name: "第一章",
    root: "scripts/main.pamela",
    file: "scripts/chapter1.pamela",
    path: [2, "then", 0],
    choices: [{ key: "x", picked: 1 }],
    savedAt: new Date(Date.UTC(2026, 9, 18, 7, 33)),
  });
  assert.equal(document.version, SAVE_VERSION);
  assert.equal(document.root, "scripts/main.pamela");
  assert.deepEqual(document.path, [2, "then", 0]);
  assert.deepEqual(document.choices, [{ key: "x", picked: 1 }]);
  assert.equal(document.savedAt, "2026-10-18T07:33:00.000Z");
});

test("a save without a position is refused", () => {
  const base = {
    name: "x",
    root: "scripts/main.pamela",
    file: "scripts/main.pamela",
    path: [0],
  };
  assert.throws(() => buildSave({ ...base, root: "" }), /没有正在运行的脚本/);
  assert.throws(() => buildSave({ ...base, file: "" }), /不属于任何脚本/);
  assert.throws(() => buildSave({ ...base, path: [] }), /不能存档/);
});

test("a written save reads back as the same thing", () => {
  const document = buildSave({
    name: "第一章",
    root: "scripts/main.pamela",
    file: "scripts/main.pamela",
    path: [4],
  });
  const read = parseSave(JSON.stringify(document));
  assert.deepEqual(read, { ...document });
});

test("a save carries the label and the picture its slot shows", () => {
  const document = buildSave({
    name: "存档 2026-10-18 15-33",
    title: "第一章 教室",
    root: "scripts/main.pamela",
    file: "scripts/main.pamela",
    path: [0],
    thumbnail: "data:image/jpeg;base64,YWJj",
  });
  assert.equal(document.title, "第一章 教室");
  assert.equal(document.thumbnail, "data:image/jpeg;base64,YWJj");
  assert.deepEqual(parseSave(JSON.stringify(document)), { ...document });
});

test("a save without a picture is still a save", () => {
  const base = { root: "a.pamela", file: "a.pamela", path: [0] };
  // No backdrop to capture, or one that would not decode.
  assert.equal(buildSave({ ...base, name: "x" }).thumbnail, null);
  assert.equal(buildSave({ ...base, name: "x", thumbnail: null }).thumbnail, null);
  assert.equal(buildSave({ ...base, name: "x", thumbnail: "" }).thumbnail, null);
  // A save written before thumbnails existed reads back with none, rather than
  // failing the way a malformed field would.
  const legacy = { version: SAVE_VERSION, ...base, name: "x", choices: [], scripts: {} };
  assert.equal(parseSave(JSON.stringify(legacy)).thumbnail, null);
  assert.equal(parseSave(JSON.stringify(legacy)).title, "");
  // A thumbnail that is not a string is dropped rather than trusted into an
  // `<img src>`.
  assert.equal(
    parseSave(JSON.stringify({ ...legacy, thumbnail: { href: "x" } })).thumbnail,
    null,
  );
});

test("a save fingerprints the scripts it walked through", () => {
  const document = buildSave({
    name: "x",
    root: "a.pamela",
    file: "a.pamela",
    path: [0],
    scripts: { "scripts/a.pamela": hashText('say("hi")') },
  });
  assert.match(document.scripts["scripts/a.pamela"], /^[0-9a-f]{8}$/);
});

test("a fingerprint notices an edited script, and a missing one", async () => {
  const text = 'say("hi")';
  const scripts = { "scripts/main.pamela": hashText(text) };

  // The same text passes...
  await verifyScripts(scripts, () => Promise.resolve(text));

  // ...a changed one is refused rather than resumed at the same index...
  await assert.rejects(
    verifyScripts(scripts, () => Promise.resolve(text + '\nsay("more")')),
    /不一致：scripts\/main\.pamela 改过了/,
  );

  // ...and so is one that is no longer there.
  await assert.rejects(
    verifyScripts(scripts, () => Promise.reject(new Error("gone"))),
    /已经不在了：scripts\/main\.pamela/,
  );

  // A save from before fingerprints existed has nothing to compare.
  await verifyScripts({}, () => Promise.reject(new Error("never read")));
});

test("a save this build cannot resume from says what is wrong", () => {
  const good = {
    version: SAVE_VERSION,
    root: "a.pamela",
    file: "a.pamela",
    path: [0],
    choices: [],
  };
  const cases = [
    ["not json", /不是有效的 JSON/],
    ["[]", /不是一个对象/],
    [JSON.stringify({ ...good, version: 9 }), /不认识的存档版本：9/],
    [JSON.stringify({ ...good, root: "" }), /从哪个脚本开始/],
    [JSON.stringify({ ...good, file: "" }), /节点在哪个脚本/],
    [JSON.stringify({ ...good, path: [] }), /节点位置/],
    [JSON.stringify({ ...good, path: [true] }), /格式不对/],
    [JSON.stringify({ ...good, choices: [{ key: 1 }] }), /选择记录格式不对/],
    [JSON.stringify({ ...good, scripts: { "a.pamela": "nope" } }), /剧本指纹格式不对/],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => parseSave(text), expected, text);
  }
});
