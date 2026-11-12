// 项目操作：新建、打开、保存与资源树动作。
// Pamela — project actions.

import { promptText } from "./modal.js";

/** Command names, kept together so the backend contract is visible in one place. */
export const COMMANDS = Object.freeze({
  createProject: "create_project",
  openProject: "open_project",
  reloadProject: "reload_project",
  currentProject: "current_project",
  closeProject: "close_project",
  setEntry: "set_entry",
  setTypewriter: "set_typewriter",
  checkProject: "check_project",
  readFile: "read_file",
  readAsset: "read_asset",
  readImage: "read_image",
  readAudio: "read_audio",
  readVideo: "read_video",
  writeFile: "write_file",
  writeAsset: "write_asset",
  listFonts: "list_fonts",
  createDir: "create_dir",
  deleteEntry: "delete_entry",
  copyEntry: "copy_entry",
  renameEntry: "rename_entry",
  readAppState: "read_app_state",
  writeAppState: "write_app_state",
  dialogOpen: "plugin:dialog|open",
});

/** The suffix that marks a file as a dialogue style, opened in the designer. */
export const DIALOG_SUFFIX = ".dialog.json";

/** The directory a project keeps its dialogue style templates in. */
export const TEMPLATES_DIR = "templates";

/** Whether a project-relative path is a dialogue style file. */
export function isDialogPath(path) {
  return String(path ?? "")
    .toLowerCase()
    .endsWith(DIALOG_SUFFIX);
}

/**
 * Extensions the image viewer can show.
 *
 * Mirrors the backend's own table, so a file one refuses is never offered by
 * the other: clicking a file here always either shows a picture or says why it
 * cannot.
 */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"];

/** Whether a project-relative path is an image the viewer can show. */
export function isImagePath(path) {
  const normalized = String(path ?? "").toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.includes(normalized.slice(dot + 1));
}

const AUDIO_EXTENSIONS = ["wav", "mp3", "ogg", "m4a", "flac", "aac", "opus", "weba"];

/** Whether a project-relative path is an audio file the editor can decode. */
export function isAudioPath(path) {
  const normalized = String(path ?? "").toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot > 0 && AUDIO_EXTENSIONS.includes(normalized.slice(dot + 1));
}

/** Extensions the webview can play as video; mirrors `video_mime` in the backend. */
const VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "ogv", "mov"];

/** Whether a project-relative path is a video the stage can play. */
export function isVideoPath(path) {
  const normalized = String(path ?? "").toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot > 0 && VIDEO_EXTENSIONS.includes(normalized.slice(dot + 1));
}

/** The suffix that marks a file as a visual programming map, edited on a canvas. */
export const MAP_SUFFIX = ".flowmap";

/**
 * The folder maps live in.
 *
 * A map is a drawing of a script, kept beside the scripts rather than among the
 * assets: `scripts/` holds what plays, `maps/` holds the pictures of it.
 */
export const MAPS_DIR = "maps";

/** The suffix that marks a file as a key frame animation. */
export const KEYFRAMES_SUFFIX = ".keyframes";

/** Validates a new key frame file name. */
export function validateKeyframesName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "文件名不能为空";
  }
  if (/[\\/]/.test(trimmed)) {
    return "文件名不能包含路径分隔符";
  }
  if (!trimmed.toLowerCase().endsWith(KEYFRAMES_SUFFIX)) {
    return `关键帧文件必须以 ${KEYFRAMES_SUFFIX} 结尾`;
  }
  if (/[<>:"|?*]/.test(trimmed)) {
    return "文件名含有不允许的字符";
  }
  return "";
}

/**
 * The suffix a map had before the rename.
 *
 * Still read, so a project made earlier opens on the canvas; only new files are
 * `.flowmap`. A map is saved back under the name it was opened with, so nothing
 * is renamed without the author's knowledge.
 */
export const LEGACY_MAP_SUFFIX = ".pmap";

/** Whether a project-relative path is a visual programming map file. */
export function isMapPath(path) {
  const lower = String(path ?? "").toLowerCase();
  return lower.endsWith(MAP_SUFFIX) || lower.endsWith(LEGACY_MAP_SUFFIX);
}

/** Validates a new visual programming map file name. */
export function validateMapName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "文件名不能为空";
  }
  if (/[\\/]/.test(trimmed)) {
    return "文件名不能包含路径分隔符";
  }
  if (!trimmed.toLowerCase().endsWith(MAP_SUFFIX)) {
    return `地图文件必须以 ${MAP_SUFFIX} 结尾`;
  }
  if (/[<>:"|?*]/.test(trimmed)) {
    return "文件名含有不允许的字符";
  }
  return "";
}

/** Validates a new plain JSON file name. */
export function validateJsonName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "文件名不能为空";
  }
  if (/[\\/]/.test(trimmed)) {
    return "文件名不能包含路径分隔符";
  }
  if (!trimmed.toLowerCase().endsWith(".json")) {
    return "JSON 文件必须以 .json 结尾";
  }
  if (/[<>:"|?*]/.test(trimmed)) {
    return "文件名含有不允许的字符";
  }
  return "";
}

/**
 * Validates a project name before it is sent to the backend.
 *
 * The backend validates again; this exists to give immediate feedback in the
 * dialog instead of a round trip.
 *
 * @returns {string | null} An error message, or `null` when the name is usable.
 */
export function validateProjectName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "项目名不能为空";
  }
  if (/[\\/]/.test(trimmed)) {
    return "项目名不能包含路径分隔符";
  }
  if (trimmed === "." || trimmed === "..") {
    return "项目名无效";
  }
  if (name !== trimmed) {
    return "项目名首尾不能有空白字符";
  }
  return null;
}

/** The suffix of a full-syntax script. */
export const SCRIPT_SUFFIX = ".pe";

/**
 * The suffix of a shorthand script.
 *
 * A `.mpe` file is the same language written without brackets or quotes (see
 * `ui/mpe.js`): it compiles to `.pe` line for line before the run starts. It is
 * a second suffix rather than a second kind of document — every place that asks
 * "is this a script?" has to answer yes for it.
 */
export const SHORT_SCRIPT_SUFFIX = ".mpe";

/**
 * The suffix a script had before the rename.
 *
 * Still read, so a project made earlier opens and plays; only new files are
 * `.pe`. A script is saved back under the name it was opened with, so nothing
 * is renamed without the author's knowledge.
 */
export const LEGACY_SCRIPT_SUFFIX = ".pamela";

/** Whether a project-relative path names a Pamela script. */
export function isScriptPath(path) {
  const lower = String(path ?? "").toLowerCase();
  return (
    lower.endsWith(SCRIPT_SUFFIX) ||
    lower.endsWith(SHORT_SCRIPT_SUFFIX) ||
    lower.endsWith(LEGACY_SCRIPT_SUFFIX)
  );
}

/**
 * A file name with the modern suffix, for the rename dialog's default.
 *
 * Every kind of file that was renamed carries its old suffix on disk until it
 * is saved again, so an author who opens 重命名 on one is shown the name it
 * *should* have: accepting the dialog is what upgrades it. A name that is
 * already modern — or is some other file altogether — comes back unchanged, so
 * the dialog never rewrites something it has no business touching.
 *
 * Key frame files are the one kind identified by their whole name rather
 * than their extension (`data/key-<id>.json`), because plenty of other files
 * are `.json` and only these are animations.
 *
 * @param {string} name A bare file name.
 * @returns {string} The name with the modern suffix.
 */
export function modernFileName(name) {
  const trimmed = String(name ?? "");
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(LEGACY_SCRIPT_SUFFIX)) {
    return `${trimmed.slice(0, -LEGACY_SCRIPT_SUFFIX.length)}${SCRIPT_SUFFIX}`;
  }
  if (lower.endsWith(LEGACY_MAP_SUFFIX)) {
    return `${trimmed.slice(0, -LEGACY_MAP_SUFFIX.length)}${MAP_SUFFIX}`;
  }
  if (/^(?:key|path)-[A-Za-z0-9_-]+\.json$/i.test(trimmed)) {
    return `${trimmed.slice(0, -".json".length)}${KEYFRAMES_SUFFIX}`;
  }
  return trimmed;
}

/**
 * The `assets/` sub-directories, one per kind of object that names a file.
 *
 * A `Background` reads `assets/Background/`, a `Character` reads
 * `assets/Character/`, an `Audio` reads `assets/Audio/`, and a `Video` reads
 * `assets/Video/`. The split is what makes each kind's files listable on its
 * own, and keeps a picture from being offered where a sound belongs.
 */
export const ASSET_KINDS = Object.freeze(["Background", "Character", "Audio", "Video"]);

/** The directory every asset lives under, as the backend spells it. */
export const ASSETS_DIR = "assets";

/**
 * The folder a kind of object reads its files from.
 *
 * @param {string} kind `"Background"`, `"Character"` or `"Audio"`.
 * @returns {string} A project-relative folder, or "" for an unknown kind.
 */
export function assetDirFor(kind) {
  return ASSET_KINDS.includes(kind) ? `assets/${kind}` : "";
}

/**
 * Every file under a kind's own `assets/` folder, as project-relative paths.
 *
 * This is what the visual editor's file pickers offer: the folder belonging to
 * the node, so a character node lists portraits and a background node lists
 * backdrops. A project with nothing in the folder answers an empty list, which
 * the picker shows as "no files yet" rather than as an error.
 *
 * **Files sitting directly in `assets/` are listed too**, after the kind's own
 * folder. The backend reads them as a fallback for a project made before the
 * split, so offering them is offering what already works — and it would be a
 * puzzle to have a file the script can name but the picker refuses to show.
 *
 * @param {object | null} project
 * @param {string} kind
 * @param {(path: string) => boolean} [matches] An extra filter, such as "only
 *   pictures" for a node that draws one.
 * @returns {string[]} Sorted project-relative paths, the kind's folder first.
 */
export function listAssetFiles(project, kind, matches = () => true) {
  const folder = assetDirFor(kind);
  if (!folder) {
    return [];
  }
  const prefix = `${folder}/`;
  const inKind = [];
  const flat = [];
  for (const node of listTreeNodes(project)) {
    const path = String(node.path ?? "");
    if (node.is_dir || !path.startsWith(`${ASSETS_DIR}/`) || !matches(path)) {
      continue;
    }
    if (path.startsWith(prefix)) {
      inKind.push(path);
    } else if (!path.slice(ASSETS_DIR.length + 1).includes("/")) {
      // Directly under `assets/`: the flat layout the fallback reads.
      flat.push(path);
    }
  }
  return [...inKind.sort(), ...flat.sort()];
}

/**
 * Validates a new script file name.
 *
 * With `suffix`, the name has to end in that one spelling: 新建 pe 剧本 and
 * 新建 mpe 剧本 each ask for the file they name, and a `.pe` offered for a
 * shorthand script would be renamed by the author a second later. Without it —
 * a name arriving from anywhere else — either spelling is accepted.
 *
 * @param {string} name
 * @param {string} [suffix] `SCRIPT_SUFFIX` or `SHORT_SCRIPT_SUFFIX`.
 * @returns {string | null} The first problem, or null when the name is usable.
 */
export function validateScriptName(name, suffix = "") {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "文件名不能为空";
  }
  if (/[\\/]/.test(trimmed)) {
    return "文件名不能包含路径分隔符";
  }
  const lower = trimmed.toLowerCase();
  if (suffix) {
    const wanted = String(suffix).toLowerCase();
    if (!lower.endsWith(wanted)) {
      return `文件名必须以 ${wanted} 结尾`;
    }
  } else if (!lower.endsWith(SCRIPT_SUFFIX) && !lower.endsWith(SHORT_SCRIPT_SUFFIX)) {
    return `脚本文件必须以 ${SCRIPT_SUFFIX} 或 ${SHORT_SCRIPT_SUFFIX} 结尾`;
  }
  if (/[<>:"|?*]/.test(trimmed)) {
    return "文件名含有不允许的字符";
  }
  return null;
}

/** Validates a new dialogue style file name. */
export function validateDialogName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "文件名不能为空";
  }
  if (/[\\/]/.test(trimmed)) {
    return "文件名不能包含路径分隔符";
  }
  if (!trimmed.toLowerCase().endsWith(DIALOG_SUFFIX)) {
    return `文件名必须以 ${DIALOG_SUFFIX} 结尾`;
  }
  if (/[<>:"|?*]/.test(trimmed)) {
    return "文件名含有不允许的字符";
  }
  return null;
}

/** Validates a new folder name. */
export function validateFolderName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return "文件夹名不能为空";
  }
  if (/[\\/]/.test(trimmed)) {
    return "文件夹名不能包含路径分隔符";
  }
  if (trimmed === "." || trimmed === "..") {
    return "文件夹名无效";
  }
  if (/[<>:"|?*]/.test(trimmed)) {
    return "文件夹名含有不允许的字符";
  }
  return null;
}

/**
 * Normalises the return value of the folder picker.
 *
 * Depending on the options passed, the dialog returns a string, a list, or
 * null, so callers get a single value or nothing.
 */
export function pickerResult(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null;
  }
  return typeof value === "string" && value ? value : null;
}

/** Splits a project-relative path into its parent folder and file name. */
export function splitPath(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1
    ? { dir: "", name: normalized }
    : { dir: normalized.slice(0, index), name: normalized.slice(index + 1) };
}

/** Joins a project-relative folder and file name. */
export function joinPath(dir, name) {
  const cleanDir = String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return cleanDir ? `${cleanDir}/${name}` : String(name ?? "");
}

/**
 * Splits a folder picked in the dialog into its parent and its own name.
 *
 * The name is what the project will be called, so a pick without one — a drive
 * root such as `C:\` — yields an empty `name`, and the caller refuses it rather
 * than creating a project at the drive's current folder.
 *
 * Unlike `splitPath`, the separators are left alone: this result goes straight
 * back to the backend, and rewriting a Windows path to forward slashes would
 * turn `C:\projects` into `C:/projects`.
 */
export function splitFolderPath(folder) {
  const raw = String(folder ?? "").replace(/[\\/]+$/, "");
  const index = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  if (index === -1) {
    return { dir: "", name: raw };
  }
  return { dir: raw.slice(0, index), name: raw.slice(index + 1) };
}

/**
 * The fallback entry: `scripts/main.<suffix>`, used when the manifest names no
 * entry (or names one that is no longer there).
 *
 * Three names are read, because three are legitimate: `main.pe` for a normal
 * script, `main.mpe` for one written in the shorthand, and `main.pamela` for a
 * project made before the rename. The suffix changed, not the file, so the old
 * name is accepted.
 *
 * @returns {string | null}
 */
export function findEntryScript(project) {
  if (!project) {
    return null;
  }
  const entries = new Set([
    "scripts/main.pe",
    "scripts/main.mpe",
    "scripts/main.pamela",
  ]);
  // Which of the three is preferred when more than one exists: the full script
  // first (that is the name new files are written under), the shorthand next,
  // and the pre-rename name last.
  const rank = (path) => {
    const lower = path.toLowerCase();
    if (lower.endsWith(SCRIPT_SUFFIX)) {
      return 0;
    }
    return lower.endsWith(SHORT_SCRIPT_SUFFIX) ? 1 : 2;
  };
  let entry = null;
  const visit = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.is_dir) {
        visit(node.children);
      } else if (node.path && entries.has(node.path.toLowerCase())) {
        if (!entry || rank(node.path) < rank(entry)) {
          entry = node.path;
        }
      }
    }
  };
  visit(project.tree);
  return entry;
}

/**
 * The script a run starts from, plus a manifest entry that is no longer usable.
 *
 * The manifest's `entry` is the author's choice and wins when the file is really
 * there. An empty entry, or one whose file was deleted, renamed or turned into a
 * folder, falls back to the `scripts/main.*` convention older projects rely on.
 * The stale path is answered separately so the caller can report it and clear
 * the manifest rather than silently pretending the choice never happened.
 *
 * @param {object | null} project
 * @returns {{ path: string | null, stale: string }}
 */
export function resolveEntry(project) {
  if (!project) {
    return { path: null, stale: "" };
  }
  const named = String(project.entry ?? "").trim();
  if (!named) {
    return { path: findEntryScript(project), stale: "" };
  }
  const node = findNode(project, named);
  if (node && !node.is_dir) {
    return { path: named, stale: "" };
  }
  return { path: findEntryScript(project), stale: named };
}

/**
 * Every image in a project tree, as project-relative paths.
 *
 * The designer offers these as its test backdrop, so only what the viewer could
 * open is listed: a path the backend would refuse to read is not worth putting
 * in front of the author.
 */
export function listImages(project) {
  const paths = [];
  const visit = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.is_dir) {
        visit(node.children);
      } else if (isImagePath(node.path)) {
        paths.push(node.path);
      }
    }
  };
  visit(project?.tree);
  return paths;
}

/**
 * The folder the interface's own art lives in: frames, buttons, the pictures a
 * dialogue style places on its plate.
 *
 * Kept apart from the object kinds (`assets/Background/` and friends) because
 * it answers a different question: those are the pictures a *scene* names, this
 * is the furniture the dialogue box is built from. The designer's image list
 * reads only this folder, so a style's layer menu offers a handful of frames
 * rather than every picture in the project. The integrity check guarantees the
 * folder exists (see `src/project.rs`).
 */
export const UI_ASSETS_DIR = "assets/ui";

/**
 * Every picture under {@link UI_ASSETS_DIR}, as project-relative paths.
 *
 * Sub-folders are walked: a project that groups its frames (`assets/ui/frames/`)
 * is offered them the same way, and only pictures the viewer can open are
 * listed. Sorted, so the menu does not reshuffle itself between openings.
 *
 * @param {object | null} project
 * @returns {string[]}
 */
export function listUiImages(project) {
  const prefix = `${UI_ASSETS_DIR}/`;
  const paths = [];
  for (const node of listTreeNodes(project)) {
    const path = String(node.path ?? "");
    if (!node.is_dir && path.startsWith(prefix) && isImagePath(path)) {
      paths.push(path);
    }
  }
  return paths.sort();
}

/**
 * Every entry in a project's tree, depth first, flattened.
 *
 * `project.tree` is a forest — an array of the root's children — not a
 * single node. Every helper here reads it that way (`countScripts`, `findNode`,
 * `childNames`), and the resource panel draws it that way. A walker that treats
 * it as one node finds nothing at all, and does so silently: an array has no
 * `is_dir` and no `children`, so the descent never happens.
 *
 * @param {object} project
 * @returns {object[]}
 */
export function listTreeNodes(project) {
  const found = [];
  const walk = (node) => {
    if (!node) {
      return;
    }
    found.push(node);
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  for (const root of project?.tree ?? []) {
    walk(root);
  }
  return found;
}

/**
 * Every file in the project that a test accepts, as tree nodes.
 *
 * @param {object} project
 * @param {(node: object) => boolean} matches
 * @returns {object[]}
 */
export function listFiles(project, matches) {
  return listTreeNodes(project).filter((node) => !node.is_dir && matches(node));
}

/** Counts the scripts in a project tree. */
export function countScripts(project) {
  let total = 0;
  const visit = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.is_dir) {
        visit(node.children);
      } else if (node.is_script) {
        total += 1;
      }
    }
  };
  visit(project?.tree);
  return total;
}

/**
 * Finds a node in a project tree by its project-relative path.
 *
 * @returns {object | null} The node, or `null` for the root, a missing path, or
 *   a project with no tree.
 */
export function findNode(project, path) {
  const segments = String(path ?? "")
    .split("/")
    .filter(Boolean);
  let nodes = project?.tree ?? [];
  let node = null;

  for (const segment of segments) {
    node = nodes.find((candidate) => candidate.name === segment) ?? null;
    if (!node) {
      return null;
    }
    nodes = node.children ?? [];
  }

  return node;
}

/** Names of the entries directly inside a project-relative directory. */
export function childNames(project, dirPath) {
  const path = String(dirPath ?? "");
  if (!path) {
    return (project?.tree ?? []).map((node) => node.name);
  }
  return (findNode(project, path)?.children ?? []).map((node) => node.name);
}

/**
 * Picks a name next to `name` that is not already in `existing`.
 *
 * Pasting uses this so a copy lands beside the original instead of failing or
 * overwriting it: `a.pamela` becomes `a 副本.pamela`, then `a 副本 (2).pamela`.
 */
export function uniqueName(existing, name) {
  const taken = new Set(existing ?? []);
  if (!taken.has(name)) {
    return name;
  }

  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";

  let candidate = `${base} 副本${extension}`;
  let index = 1;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${base} 副本 (${index})${extension}`;
  }
  return candidate;
}

/**
 * Translates a backend error into a display string.
 *
 * Backend commands reject with a plain string; anything else is a transport
 * failure and is reported as such rather than as `[object Object]`.
 */
export function describeError(error) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Builds the project actions bound to a concrete environment.
 *
 * @param {object} options
 * @param {(command: string, args?: object) => Promise<unknown>} options.invoke
 * @param {() => Promise<string | null>} options.pickDirectory
 * @param {typeof promptText} [options.prompt]
 */
export function createProjectActions({ invoke, pickDirectory, prompt = promptText }) {
  return {
    /**
     * Asks for the project folder, then creates the project inside it.
     *
     * The folder the author picks *is* the project root, so it names the
     * project and its parent is where the backend puts it. There is no name
     * prompt: the picker is the first thing that appears, and the chosen
     * folder's name is what the project is called.
     *
     * `defaultPath` is the folder the picker opens in, so the dialog is already
     * positioned instead of starting from the filesystem root.
     */
    async createNew({ defaultPath } = {}) {
      // The picker chooses where the project lives; the name is typed by hand so
      // it can be validated instead of inherited from whatever folder was clicked.
      const parent = await pickDirectory({ title: "选择项目存放的文件夹", defaultPath });
      if (!parent) {
        return null;
      }

      const name = await prompt({
        title: "项目名称",
        label: "项目文件夹名",
        value: "my-project",
        confirmLabel: "创建",
        validate: validateProjectName,
      });
      if (name === null) {
        return null;
      }

      return invoke(COMMANDS.createProject, { parent, name: name.trim() });
    },

    /** Asks for a project folder and opens it. */
    async open({ defaultPath } = {}) {
      const root = await pickDirectory({ title: "打开项目", defaultPath });
      if (!root) {
        return null;
      }
      return invoke(COMMANDS.openProject, { root });
    },

    reload: () => invoke(COMMANDS.reloadProject),

    current: () => invoke(COMMANDS.currentProject),

    close: () => invoke(COMMANDS.closeProject),

    /**
     * Records which script the project opens first.
     *
     * An empty path clears the entry. The backend answers the reloaded project,
     * which is what the caller redraws the tree from.
     */
    setEntry: (entry) => invoke(COMMANDS.setEntry, { entry }),

    /**
     * Records the project's default typewriter mode.
     *
     * Written through the backend rather than by rewriting `pamela.json` here,
     * for the same reason `setEntry` is: the manifest holds fields this side
     * does not own, and a round trip would drop them. Answers the reloaded
     * project.
     *
     * @param {"off" | "fast" | "medium" | "slow"} mode
     */
    setTypewriter: (mode) => invoke(COMMANDS.setTypewriter, { typewriter: mode }),

    /**
     * Re-checks the project structure and repairs whatever is missing.
     *
     * Answers the backend's report: the repairs it made, whether a default
     * style still has to be loaded, and the project as it now stands.
     */
    check: () => invoke(COMMANDS.checkProject),

    /**
     * Prompts for a file name and creates an empty script, then opens it.
     *
     * `suffix` is the spelling of the language: `.pe` for the full syntax, `.mpe`
     * for the shorthand. It is the only thing that separates the two menu
     * entries, so it drives the title, the offered name and the validation
     * together — a prompt that offered `new.pe` for a shorthand script would be
     * asking the author to undo the choice they just made.
     */
    async createScript(project, { directory = "scripts", suffix = SCRIPT_SUFFIX } = {}) {
      const shorthand = String(suffix).toLowerCase() === SHORT_SCRIPT_SUFFIX;
      const wanted = shorthand ? SHORT_SCRIPT_SUFFIX : SCRIPT_SUFFIX;
      const name = await prompt({
        title: shorthand ? "新建 mpe 剧本" : "新建 pe 剧本",
        label: "文件名",
        value: `new${wanted}`,
        confirmLabel: "创建",
        validate: (value) => validateScriptName(value, wanted),
      });
      if (name === null) {
        return null;
      }

      const path = joinPath(directory, name.trim());
      await invoke(COMMANDS.writeFile, { path, contents: "" });
      return path;
    },

    read: (path) => invoke(COMMANDS.readFile, { path }),

    /**
     * Resolves a project-relative image to a `data:` URL for the stage.
     *
     * `kind` names the `assets/` folder a bare name is resolved inside — a
     * `Character` reads `assets/Character/` — so a script writes `"ch.png"` and
     * the folder is implied by the object. A sub-folder is written with slashes
     * (`"ori/si.png"`) or with dots before the extension (`"ori.si.png"`); the
     * host tries the name as written first, then the dotted spelling.
     */
    readAsset: (path, kind = "") => invoke(COMMANDS.readAsset, { path, kind }),

    /**
     * Resolves any project-relative image to a `data:` URL, for the viewer.
     *
     * Unlike `readAsset`, the path is taken as given rather than resolved under
     * `assets/`: the viewer shows the file that was clicked.
     */
    readImage: (path) => invoke(COMMANDS.readImage, { path }),

    /** Resolves a project-relative sound to a `data:` URL for the stage. */
    readAudio: (path) => invoke(COMMANDS.readAudio, { path }),

    /**
     * Resolves a bare video name inside `assets/Video/` to a `data:` URL.
     * The backend owns the folder and the 256 MB allowance.
     */
    readVideo: (path) => invoke(COMMANDS.readVideo, { path }),

    write: (path, contents) => invoke(COMMANDS.writeFile, { path, contents }),

    /** Writes an image asset: `contents` is a `data:` URL, decoded by the backend. */
    writeAsset: (path, contents) => invoke(COMMANDS.writeAsset, { path, contents }),

    /** The font families the machine has, for the designer's font pickers. */
    listFonts: () => invoke(COMMANDS.listFonts),

    createFolder: (path) => invoke(COMMANDS.createDir, { path }),

    remove: (path) => invoke(COMMANDS.deleteEntry, { path }),

    copy: (from, to) => invoke(COMMANDS.copyEntry, { from, to }),

    /**
     * Renames a project-relative file or directory inside its own folder.
     *
     * `to` is a bare name, not a path: a rename keeps the entry where it
     * is, so a right-click can never move a file out of the folder it was
     * found in.
     */
    rename: (from, to) => invoke(COMMANDS.renameEntry, { from, to }),

    /** Opens a project at a known root, with no folder picker. */
    openRoot: (root) => invoke(COMMANDS.openProject, { root }),

    /** Reads the persisted editor preferences, or `null` when none are stored. */
    loadState: () => invoke(COMMANDS.readAppState),

    /** Writes the editor preferences; `state` replaces the stored object. */
    saveState: (state) => invoke(COMMANDS.writeAppState, { state }),
  };
}

/**
 * Opens a native folder picker through the dialog plugin.
 *
 * `defaultPath` is only forwarded when it is set, so a picker without one keeps
 * the plugin's own default location rather than being sent an empty path.
 */
export function createDirectoryPicker(invoke) {
  return async ({ title, defaultPath }) => {
    const options = { directory: true, multiple: false, title };
    if (defaultPath) {
      options.defaultPath = defaultPath;
    }
    const selected = await invoke(COMMANDS.dialogOpen, { options });
    return pickerResult(selected);
  };
}
