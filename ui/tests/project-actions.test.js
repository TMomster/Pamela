// Pamela 项目操作测试。
// Tests for the Pamela project actions.

import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMANDS,
  TEMPLATES_DIR,
  assetDirFor,
  countScripts,
  createDirectoryPicker,
  listAssetFiles,
  listFiles,
  listTreeNodes,
  createProjectActions,
  describeError,
  findEntryScript,
  isDialogPath,
  isAudioPath,
  isImagePath,
  isScriptPath,
  joinPath,
  listImages,
  listUiImages,
  modernFileName,
  pickerResult,
  resolveEntry,
  splitFolderPath,
  splitPath,
  validateDialogName,
  validateProjectName,
  validateScriptName,
} from "../project-actions.js";

/**
 * Records calls and answers them from a table of responses.
 *
 * Success values and failures are given separately on purpose: a value cannot
 * be told apart from an error by its type, since backend commands reject with a
 * plain string. Folding them into one table would silently turn an intended
 * failure into a success.
 *
 * @param {Record<string, unknown>} [responses] Resolved values per command.
 * @param {Record<string, string>} [failures] Rejection messages per command.
 */
function fakeInvoke(responses = {}, failures = {}) {
  const calls = [];
  const invoke = (command, args) => {
    calls.push([command, args]);
    if (Object.hasOwn(failures, command)) {
      return Promise.reject(failures[command]);
    }
    return Promise.resolve(responses[command]);
  };
  return { invoke, calls };
}

/** A prompt that returns a queued answer per call. */
function fakePrompt(answers) {
  const queue = [...answers];
  const prompt = () => Promise.resolve(queue.length ? queue.shift() : null);
  return prompt;
}

const SAMPLE_PROJECT = {
  name: "demo",
  root: "C:/projects/demo",
  entry: "",
  tree: [
    {
      name: "scripts",
      path: "scripts",
      is_dir: true,
      is_script: false,
      children: [
        { name: "b.pamela", path: "scripts/b.pamela", is_dir: false, is_script: true, children: [] },
        { name: "a.pamela", path: "scripts/a.pamela", is_dir: false, is_script: true, children: [] },
        { name: "notes.txt", path: "scripts/notes.txt", is_dir: false, is_script: false, children: [] },
      ],
    },
    { name: "pamela.json", path: "pamela.json", is_dir: false, is_script: false, children: [] },
  ],
};

// --- validation ---

test("validateProjectName accepts ordinary names", () => {
  assert.equal(validateProjectName("my-novel"), null);
  assert.equal(validateProjectName("我的游戏"), null);
  assert.equal(validateProjectName("v1.2"), null);
});

test("validateProjectName rejects empty, separators and traversal", () => {
  assert.match(validateProjectName(""), /不能为空/);
  assert.match(validateProjectName("   "), /不能为空/);
  assert.match(validateProjectName("a/b"), /分隔符/);
  assert.match(validateProjectName("a\\b"), /分隔符/);
  assert.match(validateProjectName("."), /无效/);
  assert.match(validateProjectName(".."), /无效/);
});

test("validateProjectName rejects surrounding whitespace", () => {
  assert.match(validateProjectName(" demo "), /空白/);
});

test("validateScriptName takes the full and the shorthand suffix", () => {
  assert.equal(validateScriptName("chapter01.pe"), null);
  assert.equal(validateScriptName("CHAPTER01.PE"), null);
  assert.equal(validateScriptName("chapter01.mpe"), null, "简写脚本用 .mpe");
  assert.equal(validateScriptName("CHAPTER01.MPE"), null);
  assert.match(validateScriptName("chapter01.txt"), /\.pe/);
  assert.match(validateScriptName("chapter01"), /\.pe/);
  // The old suffix is read, but a new file is never written under it.
  assert.match(validateScriptName("chapter01.pamela"), /\.pe/);
});

test("validateScriptName rejects separators and reserved characters", () => {
  assert.match(validateScriptName("a/b.pe"), /分隔符/);
  assert.match(validateScriptName("a:b.pe"), /不允许/);
  assert.match(validateScriptName("a*b.pe"), /不允许/);
  assert.match(validateScriptName(""), /不能为空/);
});

test("isScriptPath reads .pe, .mpe and the old .pamela", () => {
  assert.equal(isScriptPath("scripts/a.pe"), true);
  assert.equal(isScriptPath("scripts/a.PE"), true);
  assert.equal(isScriptPath("scripts/a.mpe"), true, "简写脚本也是脚本");
  assert.equal(isScriptPath("scripts/a.MPE"), true);
  assert.equal(isScriptPath("scripts/a.pamela"), true, "旧后缀仍然支持识别");
  assert.equal(isScriptPath("scripts/a.flowmap"), false);
  assert.equal(isScriptPath("scripts/notes.txt"), false);
});

test("modernFileName upgrades each kind's old suffix", () => {
  // The rename dialog's default: an author who opens 重命名 on a file written
  // before the renames is shown the name it should have, and accepting is what
  // upgrades it.
  assert.equal(modernFileName("main.pamela"), "main.pe");
  assert.equal(modernFileName("flow.pmap"), "flow.flowmap");
  assert.equal(modernFileName("key-ch.json"), "key-ch.keyframes");
  assert.equal(modernFileName("path-a1b2.json"), "path-a1b2.keyframes");
  // Already modern, or some other file entirely: unchanged.
  assert.equal(modernFileName("main.pe"), "main.pe");
  assert.equal(modernFileName("flow.flowmap"), "flow.flowmap");
  assert.equal(modernFileName("key-ch.keyframes"), "key-ch.keyframes");
  assert.equal(modernFileName("notes.txt"), "notes.txt");
  assert.equal(modernFileName("pamela.json"), "pamela.json", "清单不是剧本");
  assert.equal(modernFileName("save-2.json"), "save-2.json", "其它 JSON 不动");
  assert.equal(modernFileName(""), "");
});

test("asset folders are one per kind, and the picker lists that kind's own first", () => {
  assert.equal(assetDirFor("Character"), "assets/Character");
  assert.equal(assetDirFor("Background"), "assets/Background");
  assert.equal(assetDirFor("Audio"), "assets/Audio");
  assert.equal(assetDirFor("Nope"), "");

  const project = {
    tree: [
      {
        name: "assets",
        path: "assets",
        is_dir: true,
        children: [
          // A file in the flat layout a project made before the split uses: the
          // backend reads it as a fallback, so the picker offers it too.
          { name: "old.png", path: "assets/old.png", is_dir: false, children: [] },
          // Something another kind owns: never offered for this one.
          { name: "bg.png", path: "assets/bg.png", is_dir: false, children: [] },
          {
            name: "Character",
            path: "assets/Character",
            is_dir: true,
            children: [
              { name: "ch.png", path: "assets/Character/ch.png", is_dir: false, children: [] },
              { name: "ch2.png", path: "assets/Character/ch2.png", is_dir: false, children: [] },
            ],
          },
          {
            name: "Background",
            path: "assets/Background",
            is_dir: true,
            children: [
              { name: "sky.png", path: "assets/Background/sky.png", is_dir: false, children: [] },
            ],
          },
          {
            name: "Audio",
            path: "assets/Audio",
            is_dir: true,
            children: [
              { name: "bgm.mp3", path: "assets/Audio/bgm.mp3", is_dir: false, children: [] },
            ],
          },
        ],
      },
    ],
  };
  // The kind's own folder comes first, then the flat files it may also name,
  // each half in name order.
  assert.deepEqual(listAssetFiles(project, "Character"), [
    "assets/Character/ch.png",
    "assets/Character/ch2.png",
    "assets/bg.png",
    "assets/old.png",
  ]);
  assert.deepEqual(listAssetFiles(project, "Background"), [
    "assets/Background/sky.png",
    "assets/bg.png",
    "assets/old.png",
  ]);
  assert.deepEqual(listAssetFiles(project, "Audio"), [
    "assets/Audio/bgm.mp3",
    "assets/bg.png",
    "assets/old.png",
  ]);
  // A filter applies, and another kind's folder is never reached into: the
  // sound lives under `assets/Audio/`, so a character picker does not see it.
  assert.deepEqual(listAssetFiles(project, "Character", (p) => p.endsWith(".mp3")), []);
  // A kind with no folder answers an empty list rather than throwing.
  assert.deepEqual(listAssetFiles({ tree: [] }, "Background"), []);
  assert.deepEqual(listAssetFiles(project, "Nope"), []);
});

test("validateDialogName requires the .dialog.json suffix", () => {
  assert.equal(validateDialogName("default.dialog.json"), null);
  assert.equal(validateDialogName("DEFAULT.DIALOG.JSON"), null);
  assert.match(validateDialogName("default.json"), /\.dialog\.json/);
  assert.match(validateDialogName("default"), /\.dialog\.json/);
});

test("validateDialogName rejects separators and reserved characters", () => {
  assert.match(validateDialogName("a/b.dialog.json"), /分隔符/);
  assert.match(validateDialogName("a:b.dialog.json"), /不允许/);
  assert.match(validateDialogName("a?b.dialog.json"), /不允许/);
  assert.match(validateDialogName("   "), /不能为空/);
});

test("isDialogPath picks out the style files and only those", () => {
  assert.equal(isDialogPath("templates/default.dialog.json"), true);
  assert.equal(isDialogPath("DEFAULTS.DIALOG.JSON"), true);
  assert.equal(isDialogPath("scripts/a.pamela"), false);
  assert.equal(isDialogPath("pamela.json"), false, "the manifest is not a style");
  assert.equal(isDialogPath(null), false);
  assert.equal(isDialogPath(undefined), false);
});

test("templates is the folder a project keeps its styles in", () => {
  assert.equal(TEMPLATES_DIR, "templates");
});

test("isImagePath picks out the pictures the viewer can show", () => {
  assert.equal(isImagePath("assets/bg.png"), true);
  assert.equal(isImagePath("assets/templates/box.PNG"), true);
  assert.equal(isImagePath("assets/face.jpeg"), true);
  assert.equal(isImagePath("assets/icon.svg"), true);
  assert.equal(isImagePath("scripts/a.pamela"), false);
  assert.equal(isImagePath("templates/a.dialog.json"), false, "a style is not a picture");
  assert.equal(isImagePath("assets/notes.txt"), false);
  assert.equal(isImagePath("assets/noext"), false, "an extension is what says it is one");
  assert.equal(isImagePath(null), false);
  assert.equal(isImagePath(undefined), false);
});

test("isAudioPath picks out the sounds the editor can decode", () => {
  assert.equal(isAudioPath("assets/bgm.wav"), true);
  assert.equal(isAudioPath("assets/bgm.MP3"), true);
  assert.equal(isAudioPath("assets/voice.ogg"), true);
  assert.equal(isAudioPath("scripts/a.pamela"), false);
  assert.equal(isImagePath("assets/bgm.wav"), false, "a sound is not a picture");
  assert.equal(isAudioPath("assets/noext"), false);
  assert.equal(isAudioPath(null), false);
});

test("listImages walks the whole tree and keeps only the pictures", () => {
  const project = {
    tree: [
      {
        path: "assets",
        is_dir: true,
        children: [
          { path: "assets/bg.png", is_dir: false },
          { path: "assets/notes.txt", is_dir: false },
          {
            path: "assets/faces",
            is_dir: true,
            children: [{ path: "assets/faces/hero.webp", is_dir: false }],
          },
        ],
      },
      { path: "templates", is_dir: true, children: [{ path: "templates/a.dialog.json", is_dir: false }] },
      { path: "main.pamela", is_dir: false },
    ],
  };

  // Subfolders count — a picture is offered wherever it sits.
  assert.deepEqual(listImages(project), ["assets/bg.png", "assets/faces/hero.webp"]);
});

test("listImages answers an empty list for a project with nothing to show", () => {
  assert.deepEqual(listImages({ tree: [] }), []);
  assert.deepEqual(listImages({}), []);
  assert.deepEqual(listImages(null), []);
  assert.deepEqual(listImages(undefined), []);
});

test("listUiImages keeps the interface folder's pictures, and only those", () => {
  const project = {
    tree: [
      {
        path: "assets",
        is_dir: true,
        children: [
          {
            path: "assets/ui",
            is_dir: true,
            children: [
              { path: "assets/ui/frame.png", is_dir: false },
              { path: "assets/ui/button 2.PNG", is_dir: false },
              { path: "assets/ui/readme.txt", is_dir: false },
              {
                path: "assets/ui/frames",
                is_dir: true,
                children: [{ path: "assets/ui/frames/inner.webp", is_dir: false }],
              },
            ],
          },
          {
            path: "assets/Background",
            is_dir: true,
            children: [{ path: "assets/Background/bg.png", is_dir: false }],
          },
        ],
      },
    ],
  };

  // Sorted, sub-folders included, pictures only — a scene backdrop is not
  // furniture and does not belong in a style layer's menu.
  assert.deepEqual(listUiImages(project), [
    "assets/ui/button 2.PNG",
    "assets/ui/frame.png",
    "assets/ui/frames/inner.webp",
  ]);
  assert.deepEqual(listUiImages({ tree: [] }), []);
  assert.deepEqual(listUiImages(null), []);
  assert.deepEqual(listUiImages(undefined), []);
});

// --- helpers ---

test("pickerResult normalises the dialog return shapes", () => {
  assert.equal(pickerResult("C:/x"), "C:/x");
  assert.equal(pickerResult(["C:/x"]), "C:/x");
  assert.equal(pickerResult([]), null);
  assert.equal(pickerResult(null), null);
  assert.equal(pickerResult(undefined), null);
  assert.equal(pickerResult(""), null);
});

test("splitPath and joinPath round-trip", () => {
  assert.deepEqual(splitPath("scripts/a.pamela"), { dir: "scripts", name: "a.pamela" });
  assert.deepEqual(splitPath("a.pamela"), { dir: "", name: "a.pamela" });
  assert.deepEqual(splitPath("a\\b\\c.pamela"), { dir: "a/b", name: "c.pamela" });

  assert.equal(joinPath("scripts", "a.pamela"), "scripts/a.pamela");
  assert.equal(joinPath("", "a.pamela"), "a.pamela");
  assert.equal(joinPath("scripts/", "a.pamela"), "scripts/a.pamela");
});

test("splitFolderPath keeps the platform's separators", () => {
  assert.deepEqual(splitFolderPath("C:/projects/demo"), { dir: "C:/projects", name: "demo" });
  assert.deepEqual(splitFolderPath("C:\\projects\\demo"), {
    dir: "C:\\projects",
    name: "demo",
  });
  assert.deepEqual(splitFolderPath("/home/me/demo"), { dir: "/home/me", name: "demo" });

  // A trailing separator is ignored, so a path pasted with one still splits.
  assert.deepEqual(splitFolderPath("C:/projects/demo/"), { dir: "C:/projects", name: "demo" });

  // A drive root has no name to give the project.
  assert.deepEqual(splitFolderPath("C:\\"), { dir: "", name: "C:" });
  assert.deepEqual(splitFolderPath("C:/"), { dir: "", name: "C:" });
});

test("countScripts counts only scripts", () => {
  assert.equal(countScripts(SAMPLE_PROJECT), 2);
  assert.equal(countScripts(null), 0);
  assert.equal(countScripts({ tree: [] }), 0);
});

test("findEntryScript is always scripts/main.pe when present", () => {
  const withMain = {
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "b.pe", path: "scripts/b.pe", is_dir: false, children: [] },
          { name: "main.pe", path: "scripts/main.pe", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.equal(findEntryScript(withMain), "scripts/main.pe");
});

test("findEntryScript prefers .pe when a project has both", () => {
  const both = {
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "main.pamela", path: "scripts/main.pamela", is_dir: false, children: [] },
          { name: "main.pe", path: "scripts/main.pe", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.equal(findEntryScript(both), "scripts/main.pe");
});

test("findEntryScript accepts a shorthand entry", () => {
  const shorthand = {
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "scene.mpe", path: "scripts/scene.mpe", is_dir: false, children: [] },
          { name: "main.mpe", path: "scripts/main.mpe", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.equal(findEntryScript(shorthand), "scripts/main.mpe");
  // 两种后缀同时存在时，完整脚本是入口。
  const both = {
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "main.mpe", path: "scripts/main.mpe", is_dir: false, children: [] },
          { name: "main.pe", path: "scripts/main.pe", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.equal(findEntryScript(both), "scripts/main.pe");
});

test("findEntryScript ignores the manifest entry and every other script", () => {
  // A project without a `main` script has, by definition, no entry.
  assert.equal(findEntryScript(SAMPLE_PROJECT), null);
});

test("findEntryScript returns null for a project without scripts", () => {
  assert.equal(findEntryScript({ tree: [] }), null);
  assert.equal(findEntryScript(null), null);
});

test("resolveEntry prefers the manifest entry when the file is there", () => {
  const project = {
    entry: "scripts/ch1.pe",
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "main.pe", path: "scripts/main.pe", is_dir: false, children: [] },
          { name: "ch1.pe", path: "scripts/ch1.pe", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.deepEqual(resolveEntry(project), { path: "scripts/ch1.pe", stale: "" });
});

test("resolveEntry falls back to main and reports a stale entry", () => {
  const project = {
    entry: "scripts/gone.pe",
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        children: [
          { name: "main.pe", path: "scripts/main.pe", is_dir: false, children: [] },
        ],
      },
    ],
  };
  assert.deepEqual(resolveEntry(project), {
    path: "scripts/main.pe",
    stale: "scripts/gone.pe",
  });
});

test("resolveEntry ignores a folder named by the manifest", () => {
  const project = {
    entry: "scripts",
    tree: [{ name: "scripts", path: "scripts", is_dir: true, children: [] }],
  };
  assert.deepEqual(resolveEntry(project), { path: null, stale: "scripts" });
});

test("resolveEntry answers an empty project", () => {
  assert.deepEqual(resolveEntry(null), { path: null, stale: "" });
  assert.deepEqual(resolveEntry({ tree: [] }), { path: null, stale: "" });
});

test("describeError unwraps backend strings and Error objects", () => {
  assert.equal(describeError("尚未打开项目"), "尚未打开项目");
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError(404), "404");
});

// --- command usage ---

test("createNew turns the picked folder into a project", async () => {
  const { invoke, calls } = fakeInvoke({ [COMMANDS.createProject]: SAMPLE_PROJECT });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve("C:/projects"),
    prompt: fakePrompt(["demo"]),
  });

  const project = await actions.createNew();

  assert.equal(project, SAMPLE_PROJECT);
  assert.deepEqual(calls, [
    [COMMANDS.createProject, { parent: "C:/projects", name: "demo" }],
  ]);
});

test("createNew splits a backslash path without rewriting it", async () => {
  const { invoke, calls } = fakeInvoke({ [COMMANDS.createProject]: SAMPLE_PROJECT });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve("C:\\projects"),
    prompt: fakePrompt(["demo"]),
  });

  await actions.createNew();
  assert.deepEqual(calls[0][1], { parent: "C:\\projects", name: "demo" });
});

test("createNew does nothing when the folder picker is cancelled", async () => {
  const { invoke, calls } = fakeInvoke({});
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([]),
  });

  assert.equal(await actions.createNew(), null);
  assert.deepEqual(calls, [], "no project is created without a location");
});

test("createNew refuses an invalid project name", async () => {
  const { invoke, calls } = fakeInvoke({}, { [COMMANDS.createProject]: "项目名不能包含路径分隔符" });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve("C:/projects"),
    prompt: fakePrompt(["a/b"]),
  });

  await assert.rejects(
    () => actions.createNew(),
    (error) => describeError(error).includes("路径分隔符"),
  );
});

test("open passes the chosen folder to the backend", async () => {
  const { invoke, calls } = fakeInvoke({ [COMMANDS.openProject]: SAMPLE_PROJECT });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve("C:/projects/demo"),
    prompt: fakePrompt([]),
  });

  await actions.open();
  assert.deepEqual(calls, [[COMMANDS.openProject, { root: "C:/projects/demo" }]]);
});

test("open does nothing when the folder picker is cancelled", async () => {
  const { invoke, calls } = fakeInvoke({});
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([]),
  });

  assert.equal(await actions.open(), null);
  assert.deepEqual(calls, []);
});

test("createScript writes an empty file under scripts and returns its path", async () => {
  const { invoke, calls } = fakeInvoke({});
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt(["chapter02.pe"]),
  });

  const path = await actions.createScript(SAMPLE_PROJECT);

  assert.equal(path, "scripts/chapter02.pe");
  assert.deepEqual(calls, [
    [COMMANDS.writeFile, { path: "scripts/chapter02.pe", contents: "" }],
  ]);
});

test("createScript does nothing when cancelled", async () => {
  const { invoke, calls } = fakeInvoke({});
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([null]),
  });

  assert.equal(await actions.createScript(SAMPLE_PROJECT), null);
  assert.deepEqual(calls, []);
});

test("validateScriptName narrows to one suffix when asked", () => {
  assert.equal(validateScriptName("a.pe", ".pe"), null);
  assert.equal(validateScriptName("A.PE", ".pe"), null);
  assert.match(validateScriptName("a.mpe", ".pe"), /\.pe/);
  assert.equal(validateScriptName("a.mpe", ".mpe"), null);
  assert.match(validateScriptName("a.pe", ".mpe"), /\.mpe/);
  // 不指定后缀时两种均接受：只有菜单项才由菜单项指定。
  assert.equal(validateScriptName("a.pe"), null);
  assert.equal(validateScriptName("a.mpe"), null);
});

test("createScript asks for the spelling the menu entry named", async () => {
  const seen = [];
  const { invoke, calls } = fakeInvoke({});
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: (options) => {
      seen.push(options);
      return Promise.resolve("new.mpe");
    },
  });

  const path = await actions.createScript(SAMPLE_PROJECT, { suffix: ".mpe" });

  assert.equal(path, "scripts/new.mpe");
  assert.equal(seen[0].title, "新建 mpe 剧本");
  assert.equal(seen[0].value, "new.mpe");
  // 两个菜单项唯一的不同就在提示里：给什么后缀，仅接受什么后缀。
  assert.equal(seen[0].validate("new.mpe"), null);
  assert.match(seen[0].validate("new.pe"), /\.mpe/);
  assert.deepEqual(calls, [[COMMANDS.writeFile, { path: "scripts/new.mpe", contents: "" }]]);
});

test("createScript defaults to the full syntax", async () => {
  const seen = [];
  const { invoke } = fakeInvoke({});
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: (options) => {
      seen.push(options);
      return Promise.resolve("new.pe");
    },
  });

  assert.equal(await actions.createScript(SAMPLE_PROJECT), "scripts/new.pe");
  assert.equal(seen[0].title, "新建 pe 剧本");
  assert.equal(seen[0].value, "new.pe");
});

test("read and write target the backend file commands", async () => {
  const { invoke, calls } = fakeInvoke({ [COMMANDS.readFile]: "scene 1\n" });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([]),
  });

  assert.equal(await actions.read("scripts/a.pamela"), "scene 1\n");
  await actions.write("scripts/a.pamela", "scene 2\n");

  assert.deepEqual(calls, [
    [COMMANDS.readFile, { path: "scripts/a.pamela" }],
    [COMMANDS.writeFile, { path: "scripts/a.pamela", contents: "scene 2\n" }],
  ]);
});

test("a style file, an image asset and the font list use the backend's own commands", async () => {
  const { invoke, calls } = fakeInvoke({ [COMMANDS.listFonts]: ["微软雅黑", "Arial"] });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([]),
  });

  assert.deepEqual(await actions.listFonts(), ["微软雅黑", "Arial"]);
  await actions.write("templates/a.dialog.json", "{}\n");
  await actions.writeAsset("assets/templates/a.png", "data:image/png;base64,YWJj");

  assert.deepEqual(calls, [
    [COMMANDS.listFonts, undefined],
    [COMMANDS.writeFile, { path: "templates/a.dialog.json", contents: "{}\n" }],
    [
      COMMANDS.writeAsset,
      { path: "assets/templates/a.png", contents: "data:image/png;base64,YWJj" },
    ],
  ]);
});

test("readAsset carries the kind, readImage takes the path as given", async () => {
  const { invoke, calls } = fakeInvoke({
    [COMMANDS.readAsset]: "data:image/png;base64,YWJj",
    [COMMANDS.readImage]: "data:image/png;base64,ZGVm",
  });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([]),
  });

  // The kind is the `assets/` folder the backend resolves a bare name inside.
  assert.equal(
    await actions.readAsset("ch.png", "Character"),
    "data:image/png;base64,YWJj",
  );
  assert.equal(await actions.readImage("assets/bg.png"), "data:image/png;base64,ZGVm");

  assert.deepEqual(calls, [
    [COMMANDS.readAsset, { path: "ch.png", kind: "Character" }],
    [COMMANDS.readImage, { path: "assets/bg.png" }],
  ]);
});

test("check asks the backend to inspect and repair the project", async () => {
  const report = {
    repairs: ["已创建 templates/"],
    needs_template: true,
    project: SAMPLE_PROJECT,
  };
  const { invoke, calls } = fakeInvoke({ [COMMANDS.checkProject]: report });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([]),
  });

  assert.equal(await actions.check(), report);
  assert.deepEqual(calls, [[COMMANDS.checkProject, undefined]]);
});

test("setEntry records the entry script, and an empty path clears it", async () => {
  const { invoke, calls } = fakeInvoke({ [COMMANDS.setEntry]: SAMPLE_PROJECT });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve(null),
    prompt: fakePrompt([]),
  });

  assert.equal(await actions.setEntry("scripts/chapter01.pamela"), SAMPLE_PROJECT);
  await actions.setEntry("");

  assert.deepEqual(calls, [
    [COMMANDS.setEntry, { entry: "scripts/chapter01.pamela" }],
    [COMMANDS.setEntry, { entry: "" }],
  ]);
});

test("a rejected command surfaces the backend message", async () => {
  // Backend commands reject with a plain string, which is what the status bar
  // renders. The validator returns a boolean so a mismatch is reported as a
  // normal assertion failure.
  const message = "不是 Pamela 项目（缺少 pamela.json）";
  const { invoke } = fakeInvoke({}, { [COMMANDS.openProject]: message });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve("C:/nope"),
    prompt: fakePrompt([]),
  });

  await assert.rejects(
    () => actions.open(),
    (error) => describeError(error) === message,
    "the backend message should reach the caller unchanged",
  );
});

test("a rejecting backend stops createNew from reporting success", async () => {
  const { invoke } = fakeInvoke({}, { [COMMANDS.createProject]: "项目“demo”已存在" });
  const actions = createProjectActions({
    invoke,
    pickDirectory: () => Promise.resolve("C:/projects"),
    prompt: fakePrompt(["demo"]),
  });

  await assert.rejects(
    () => actions.createNew(),
    (error) => describeError(error) === "项目“demo”已存在",
  );
});

// --- directory picker ---

test("the picker asks for a single directory and normalises the reply", async () => {
  const { invoke, calls } = fakeInvoke({ [COMMANDS.dialogOpen]: "C:/picked" });
  const pick = createDirectoryPicker(invoke);

  assert.equal(await pick({ title: "打开项目" }), "C:/picked");
  assert.deepEqual(calls, [
    [
      COMMANDS.dialogOpen,
      { options: { directory: true, multiple: false, title: "打开项目" } },
    ],
  ]);
});

test("the picker returns null when the dialog is dismissed", async () => {
  const { invoke } = fakeInvoke({ [COMMANDS.dialogOpen]: null });
  assert.equal(await createDirectoryPicker(invoke)({ title: "x" }), null);
});

test("the picker unwraps a list reply", async () => {
  const { invoke } = fakeInvoke({ [COMMANDS.dialogOpen]: ["C:/only"] });
  assert.equal(await createDirectoryPicker(invoke)({ title: "x" }), "C:/only");
});

// --- 项目树的形状 ---

/** A project whose tree is a forest, the way the backend answers it. */
function forestProject() {
  return {
    name: "demo",
    tree: [
      {
        name: "scripts",
        path: "scripts",
        is_dir: true,
        is_script: false,
        children: [
          { name: "main.pamela", path: "scripts/main.pamela", is_dir: false, is_script: true, children: [] },
          { name: "chapter.pamela", path: "scripts/chapter.pamela", is_dir: false, is_script: true, children: [] },
        ],
      },
      { name: "assets", path: "assets", is_dir: true, is_script: false, children: [] },
      {
        name: "data",
        path: "data",
        is_dir: true,
        is_script: false,
        children: [
          { name: "key-ch.json", path: "data/key-ch.json", is_dir: false, is_script: false, children: [] },
        ],
      },
    ],
  };
}

test("项目树是森林：遍历要下到每一层", () => {
  // Regression case: `project.tree` is an array of roots, not one node.
  // A walker that treats it as a node finds nothing — an array has no `is_dir`
  // and no `children`, so the descent never happens and every caller silently
  // gets an empty list. That is how key files once went missing from the
  // runtime, so this is the shape every tree helper has to honour.
  const nodes = listTreeNodes(forestProject());
  assert.deepEqual(
    nodes.map((node) => node.path),
    ["scripts", "scripts/main.pamela", "scripts/chapter.pamela", "assets", "data", "data/key-ch.json"],
  );
});

test("项目树：按条件挑文件只挑文件，不挑目录", () => {
  const scripts = listFiles(forestProject(), (node) => node.is_script);
  assert.deepEqual(
    scripts.map((node) => node.path),
    ["scripts/main.pamela", "scripts/chapter.pamela"],
  );

  // A directory whose name looks like a file is still a directory.
  const keyFiles = listFiles(forestProject(), (node) => node.path.endsWith(".json"));
  assert.deepEqual(
    keyFiles.map((node) => node.path),
    ["data/key-ch.json"],
  );
});

test("项目树：空树与缺树都不抛出异常", () => {
  assert.deepEqual(listTreeNodes(null), []);
  assert.deepEqual(listTreeNodes({}), []);
  assert.deepEqual(listTreeNodes({ tree: [] }), []);
  assert.deepEqual(listFiles({ tree: [] }, () => true), []);
});

test("项目树：嵌套更深的文件也找得到", () => {
  const deep = {
    tree: [
      {
        name: "a",
        path: "a",
        is_dir: true,
        children: [
          {
            name: "b",
            path: "a/b",
            is_dir: true,
            children: [
              { name: "c.json", path: "a/b/c.json", is_dir: false, children: [] },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    listTreeNodes(deep).map((node) => node.path),
    ["a", "a/b", "a/b/c.json"],
  );
});
