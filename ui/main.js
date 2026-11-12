// 应用接线：菜单、面板、编辑器与窗口状态的装配。
// Pamela — application wiring.
// 状态变更统一经 `refreshMenuContext` 与 `refreshEditor` 刷新。

import { createAssetCache } from "./asset-cache.js";
import { AUTO_SAVE_OPTIONS, createAutoSave, normalizeAutoSave } from "./auto-save.js";
import {
  INDENT,
  duplicateLineBlock,
  indentSelection,
  lineBlockOf,
  outdentSelection,
  removeLineBlock,
  toggleLineComment,
} from "./edit-commands.js";
import { createCompletion } from "./completion.js";
import { openContextMenu } from "./context-menu.js";
import {
  createDefaultTemplate,
  createDialogueEditor,
  documentToJson,
} from "./dialog-editor.js";
import { createGraphEditor, inferGraph, parseGraph } from "./graph-editor.js";
import { createIcon } from "./icons.js";
import { currentResourceWidth, setupSplitter } from "./panel-splitter.js";
import { createResourcePreview } from "./resource-preview.js";
import { createSelect } from "./select.js";
import { textFontStack } from "./text-font.js";
import { createImageEditor } from "./image-editor.js";
import { createAudioEditor } from "./audio-editor.js";
import { commandForEvent } from "./menus.js";
import { showBusy, confirmDialog, promptText } from "./modal.js";
import { isMpePath, transpile } from "./mpe.js";
import { createReaderPanel } from "./reader-panel.js";
import { createFileOps } from "./file-ops.js";
import { createFindBar } from "./find-bar.js";
import { createPlaybackBar } from "./playback-bar.js";
import { createProjectLifecycle } from "./project-lifecycle.js";
import { createKeyframeOps } from "./keyframe-ops.js";
import { canPaste, createTreeOps, targetDirectory } from "./tree-ops.js";
import { createStageSettings } from "./stage-settings.js";
import { createStageExitConfirm } from "./stage-exit.js";
import { createStageMenu } from "./stage-menu.js";
import { nodeKey, run, stageNameFor, tokenize } from "./pamela.js";
import { createExportSession } from "./export-session.js";
import { createExportPerformance, makePreloader, preloadPlateImages } from "./export-performance.js";
import { estimateDuration } from "./export-estimate.js";
import { createExportPanel, defaultNameForEntry } from "./export-panel.js";
import { highlightMpe, highlightTokens } from "./syntax-highlight.js";
import { errorMarkRect, syntaxErrorIn, syntaxErrorInTokens } from "./editor-errors.js";
import { classifyError, pushErrorBubble, pushToast } from "./error-notify.js";
import { createPlayerStart } from "./player-start.js";
import { arrayBufferFromDataUrl } from "./data-url.js";
import {
  buildSave,
  defaultSaveName,
  hashText,
  parseSave,
  saveFileName,
  saveFilesIn,
  savePathFor,
  verifyScripts,
} from "./save.js";
import { createSlotPanel } from "./slots.js";
import { createPathEditor } from "./path-editor.js";
import {
  fontCallAt,
  fontCallsIn,
  keyCallAt,
  keyCallsIn,
  offsetAtPoint,
  splitOffset,
  withFontFamily,
  withKeyFile,
  withoutKeyFile,
} from "./move-calls.js";
import {
  buildPathFile,
  cleanId,
  freeKeyFrameIndex,
  idFromKeyArgument,
  idFromPathFile,
  isPathFile,
  KEYFRAMES_SUFFIXES,
  keyFrameStemFor,
  normalizePath,
  orderedPathFileFor,
  PATHS_DIR,
  pathFileFor,
  pathFileFromArgument,
  unreferencedPaths,
} from "./path.js";
import { createStage, createStageGlobals, pointInStage } from "./stage.js";
import {
  callAtColumn,
  dropArgumentAt,
  fillTintLine,
  findTintLines,
  mpeDropTargetAt,
  mpeFillDropAt,
} from "./editor-extras.js";
import {
  countScripts,
  createDirectoryPicker,
  createProjectActions,
  describeError,
  findNode,
  isDialogPath,
  isAudioPath,
  isImagePath,
  isVideoPath,
  isMapPath,
  isScriptPath,
  listAssetFiles,
  listFiles,
  joinPath,
  listImages,
  listUiImages,
  MAP_SUFFIX,
  MAPS_DIR,
  resolveEntry,
  SCRIPT_SUFFIX,
  SHORT_SCRIPT_SUFFIX,
  splitPath,
} from "./project-actions.js";
import { createMenuBar, createTree } from "./render.js";
import { createInvoke, createWindowChrome } from "./window-chrome.js";

const MINIMIZE_BUTTON = "titlebar-minimize";
const MAXIMIZE_BUTTON = "titlebar-maximize";
const CLOSE_BUTTON = "titlebar-close";

/**
 * 播放器模式那条「按Esc以返回编辑器」提示停留多久（毫秒）。
 *
 * 它只是指一下路，不是等人来读的东西：过一会儿还在屏幕上，反而会让人以为
 * 有什么没弹完的窗。
 */
const TOAST_ESC_HINT_MS = 1500;

/** Counts file-open requests so a slow read cannot replace a newer tab. */
let openToken = 0;

const dom = {};

/** Clears the status bar's pointer reading; the stage wiring installs it. */
let clearPointerReading = () => {};

/** The stage's corner menu; it hides itself when the pointer leaves the corner. */
let stageMenu = null;

/**
 * 播放器模式只活在这一次运行里。
 *
 * 它不写进偏好文件：下次启动一律回到编辑器。上次是在播放器里关掉的，下一次打开
 * 仍然是编辑器——记住模式只会让人以为程序记错了什么。
 */
let playerMode = false;

/** Editor session state. */
const session = {
  /** The open project as returned by the backend, or null. */
  project: null,
  /** Project-relative path of the file in the editor, or null. */
  openPath: null,
  /** Contents last read from or written to disk, for dirty tracking. */
  savedText: "",
  /** The designer's document as it was last saved, for its own dirty mark. */
  savedJson: "",
  /**
   * Which surface the editor area shows: `"code"`, `"stage"`, `"dialog"`,
   * `"image"`, `"imageEdit"` or `"audioEdit"`.
   */
  view: "code",
  /** Label of the running stage, or null when no script has been run yet. */
  stageName: null,
  /** The script the current stage run started from, or null. */
  root: null,
  /** The node the run is standing on: `{ file, path, canSave }`, or null. */
  node: null,
  /** Answers the run has taken, so a save can replay the same branches. */
  choices: [],
  /**
   * The text of every script the run has read, by project-relative path.
   *
   * A save records a fingerprint of each, so a load can refuse to resume when
   * a script changed: a statement index means something else once the file
   * around it has moved.
   */
  texts: new Map(),
  /** Whether a script is playing on the stage right now. */
  running: false,
  /** Entry held by "复制", awaiting "粘贴": `{ path, name, isDir }`, or null. */
  clipboard: null,
  /**
   * Every open file, one entry per tab: `{ path, kind, container, editor, text,
   * savedText, savedJson, url, view, scroll, caret }`.
   *
   * A tab owns its surface. The node map, the dialogue designer and the image
   * and audio tools are instantiated per tab and kept in their own container,
   * so switching is a visibility change rather than a reload — a graph keeps its
   * selection and its undo stack while a script is read beside it. A script has
   * no container of its own (there is one textarea); the tab keeps the text, the
   * scroll offset and the caret instead.
   */
  docs: new Map(),
  /** The tab order, left to right. */
  order: [],
  /**
   * The built-in reader's position — `{ setName, articleId }` — or null.
   *
   * While it is set the editor area shows a read-only article and the resource
   * panel shows a table of contents. It is a mode rather than a document: the
   * open tabs are kept behind it, and opening any of them leaves the reader.
   */
  reader: null,
  /**
   * The key frame file open in its own tab, or null.
   *
   * A key frame file is a document of its own, opened in the key frame editor
   * and never as text — which is why it is tracked apart from `openPath`: the
   * script tab stays open behind it, and coming back is a switch rather than a
   * reload. `{ path, id, scriptPath, objectName, call }` where `call` is the
   * `key()` call the editor was entered from, if any.
   */
  keyFile: null,
};

/**
 * The pictures and sounds a run has read, by path.
 *
 * A scene re-shows the same picture on every branch and a replay walks the
 * whole script again, so a read per `enable()` would be the same megabytes
 * encoded over and over. The cache is emptied when a run starts: within a run
 * nothing on disk can change under it, and between runs the author may have
 * replaced a picture.
 *
 * The designer reads straight through instead — it is not a run, and an author
 * who swaps a backdrop expects the preview to change.
 */
const assetCache = createAssetCache((path, kind) => actions.readAsset(path, kind));
const soundCache = createAssetCache((path) => actions.readAudio(path));
// A video is a large data: URL, so it gets its own small LRU: one clip should
// not evict every picture in the run just because it is a single big entry.
const videoCache = createAssetCache((path) => actions.readVideo(path), { limit: 4 });

/** Drops every cached asset, so the next run reads them from disk again. */
function clearAssetCache() {
  assetCache.clear();
  soundCache.clear();
  videoCache.clear();
}

const resourcePreview = createResourcePreview({ dom, getActions: () => actions });

const readerPanel = createReaderPanel({
  dom,
  session,
  refreshResourcePanel,
  refreshEditor,
});

const fileOps = createFileOps({
  getActions: () => actions,
  session,
  refreshTree,
  setMessage,
});


const keyframeOps = createKeyframeOps({
  dom,
  session,
  getActions: () => actions,
  getPathCache: () => pathCache,
  getPathEditor: () => pathEditor,
});

const treeOps = createTreeOps({
  getActions: () => actions,
  getPromptConfirm: () => promptConfirm,
  session,
  fileOps,
  keyframeOps,
  setMessage,
  refreshTree,
  openFile,
  refreshEditor,
  refreshResourcePanel,
  openPathEditor,
  applyProject,
  openImageEditor,
  openAudioEditor,
  isEditorDirty,
  describeTarget: describeContextTarget,
  menuItems: contextMenuItems,
  promptText,
});


const findBar = createFindBar({ dom, editorRangeRect });


const playback = createPlaybackBar({
  dom,
  session,
  getStage: () => stage,
  getSlotView: () => slotView,
  getSettingsPanel: () => settingsPanel,
  getActions: () => actions,
  getChrome: () => chrome,
  slotsOpen: () => slotsOpen(),
  setMessage,
});


const lifecycle = createProjectLifecycle({
  session,
  getActions: () => actions,
  setMessage,
  isEditorDirty,
  confirmDiscard,
  applyProject,
  setBusy: setEditorBusy,
});

/** Autosave: one clock, one interval, all dirty tabs. Started after restore. */
const autoSave = createAutoSave({
  getInterval: () => normalizeAutoSave(lifecycle.state.auto_save),
  // A performance owns the stage and an export owns the disk; neither should
  // be interrupted by an editor writing files behind it.
  canSave: () => !session.running && Boolean(actions),
  hasDirty: () => hasDirtyDocs(),
  saveDirty: () => saveAllDirty(),
});


// --- status bar ---

let messageTimer = 0;

/**
 * Whether the run in progress has raised anything of its own.
 *
 * A run reports trouble as it happens — a `key()` whose file cannot be read, an
 * asset that will not load — and then ends with "已运行". That closing line is
 * a success message and must not bury the report; this flag is set by
 * `setMessage` whenever it is handed an error, and cleared when a run starts.
 */
let runTrouble = false;

function setMessage(text, { error = false } = {}) {
  if (!dom.statusMessage) {
    return;
  }
  // Anything reported as an error is trouble the run raised, and the run's
  // closing success line must not bury it. One funnel, so nothing has to
  if (error) {
    runTrouble = true;
  }
  dom.statusMessage.textContent = text;
  dom.statusMessage.classList.toggle("is-error", error);
  clearTimeout(messageTimer);
  if (text) {
    messageTimer = setTimeout(() => {
      dom.statusMessage.textContent = "";
      dom.statusMessage.classList.remove("is-error");
    }, 6000);
  }
}

function refreshStatus() {
  const dirty = isEditorDirty();

  if (dom.statusProject) {
    dom.statusProject.textContent = session.project
      ? `项目：${session.project.name}`
      : "未打开项目";
    dom.statusProject.title = session.project?.root ?? "";
  }

  if (dom.statusFile) {
    // The reader has no file behind it, so the bar reports what is on screen
    // instead: the set and the article, which is also the pair the tab shows.
    const reading = session.reader;
    if (reading) {
      dom.statusFile.textContent = readerPanel.label();
    } else {
      dom.statusFile.textContent = session.openPath
        ? `${session.openPath}${dirty ? " •" : ""}`
        : "";
    }
  }

  // The tab and the tree row mirror the status bar's dot, so the same file reads
  // the same way wherever it appears. A file's tab is `tab--code` or
  // `tab--dialog` depending on its surface, and either one carries the dot.
  dom.editorTabs
    ?.querySelector(".tab--code, .tab--dialog")
    ?.classList.toggle("tab--dirty", dirty);
  markTreeDirty(dirty);

  if (dom.resourceMeta) {
    dom.resourceMeta.textContent = session.project
      ? `${countScripts(session.project)} 个脚本`
      : "";
  }
}

/**
 * Tints the tree row of the file with unsaved changes, matching its tab.
 *
 * Only the previously marked row is cleared and the new one set, rather than
 * every row being rewritten, since this runs on each keystroke.
 */
function markTreeDirty(dirty) {
  if (!dom.resourceBody) {
    return;
  }
  for (const row of dom.resourceBody.querySelectorAll(".tree__row.is-dirty")) {
    row.classList.remove("is-dirty");
  }
  if (!dirty || !session.openPath) {
    return;
  }
  for (const row of dom.resourceBody.querySelectorAll(".tree__row")) {
    if (row.dataset.path === session.openPath) {
      row.classList.add("is-dirty");
      return;
    }
  }
}

// --- resource panel ---

function refreshResourcePanel() {
  if (!dom.resourceBody) {
    return;
  }
  // A different project's files may carry the same relative paths, so the
  // preview cache does not outlive the project it was filled from.
  resourcePreview.sync(session.project);
  // Folders the author already opened stay open. The panel is rebuilt on every
  // save and after every tree edit, and folding everything back to its default
  // would shut the folder being worked in each time a file is added or deleted.
  const expanded = new Set();
  for (const row of dom.resourceBody.querySelectorAll('.tree__row--dir[aria-expanded="true"]')) {
    if (row.dataset.path) {
      expanded.add(row.dataset.path);
    }
  }

  const previous = dom.resourceBody.querySelector(".panel__placeholder, .tree, .reader-toc");
  previous?.remove();

  // Reading turns the panel into a table of contents: 帮助 and 关于 are articles
  // rather than files, and a project tree beside them would be beside the point.
  // The heading follows the contents so the panel says which list it is showing,
  // and the rescan button — which belongs to the project — steps aside.
  const reading = session.reader;
  if (dom.resourceTitle) {
    dom.resourceTitle.textContent = reading ? "目录" : "资源";
  }
  if (dom.resourceRefresh) {
    dom.resourceRefresh.hidden = Boolean(reading);
  }
  if (reading) {
    const toc = readerPanel.toc(reading.setName, reading.articleId);
    if (toc) {
      dom.resourceBody.append(toc);
    }
    return;
  }

  if (!session.project) {
    const empty = document.createElement("p");
    empty.className = "panel__placeholder";
    empty.textContent = "尚未打开项目。使用「文件 → 新建项目…」或「打开项目…」。";
    dom.resourceBody.append(empty);
    return;
  }

  dom.resourceBody.append(
    createTree({
      nodes: session.project.tree,
      // The file a player would start from: the manifest's entry when it is
      // still there, otherwise the `scripts/main.*` fallback.
      entry: resolveEntry(session.project).path ?? "",
      onOpenFile: (node) => openFile(node.path),
      expanded,
    }),
  );
}

/**
 * Wires the refresh button in the resource panel's header.
 *
 * A rescan is `refreshTree`, the same call the tree's own edits use: it re-reads
 * the project from disk and redraws the panel without disturbing the open file.
 * That is the point of a refresh button — a file added, renamed or deleted
 * outside the editor is invisible until something rescans, and the menu's
 * 重新扫描 is two menus away from the tree it refreshes.
 *
 * The glyph spins while the scan runs. A rescan that changes nothing looks
 * exactly like a button that did nothing, and the spin is the only evidence a
 * press landed; it is removed however the scan ends, so a failed rescan cannot
 * leave the button turning for the rest of the session.
 */
function wireResourceRefresh() {
  const button = document.getElementById("resource-refresh");
  if (!button) {
    return;
  }
  button.addEventListener("click", async () => {
    if (button.classList.contains("is-busy")) {
      return;
    }
    if (!session.project) {
      setMessage("尚未打开项目", { error: true });
      return;
    }
    button.classList.add("is-busy");
    try {
      const project = await refreshTree();
      if (project) {
        setMessage("资源树已刷新");
      }
    } catch (error) {
      setMessage(describeError(error), { error: true });
    } finally {
      button.classList.remove("is-busy");
    }
  });
}

// --- resource context menu ---

/**
 * Describes the entry under a right-click in the resource panel.
 *
 * A row yields its own path and kind; empty space below the tree yields the
 * project root, so "新建" still has somewhere to put things.
 *
 * @returns {{path: string, name: string, isDir: boolean, isScript: boolean} | null}
 *   `null` when the click was outside the panel, or when no project is open.
 */
function describeContextTarget(target) {
  if (!session.project || !dom.resourceBody) {
    return null;
  }
  if (!(target instanceof Element) || !dom.resourceBody.contains(target)) {
    return null;
  }

  const row = target.closest(".tree__row");
  if (!row) {
    return { path: "", name: session.project.name, isDir: true, isScript: false };
  }

  // Right-click selects the row, so the menu's subject is also what is shown
  // as selected — the click handler does the same for a left click.
  for (const selected of dom.resourceBody.querySelectorAll(".tree__row.is-selected")) {
    selected.classList.remove("is-selected");
  }
  row.classList.add("is-selected");

  const path = row.dataset.path ?? "";
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    isDir: row.classList.contains("tree__row--dir"),
    isScript: row.classList.contains("tree__row--script"),
  };
}

/** Menu entries for `target`, which differ between a folder and a file. */
function contextMenuItems(target) {
  const paste = {
    label: "粘贴",
    command: "tree.paste",
    disabled: !canPaste(session.clipboard, targetDirectory(target)),
  };

  // Empty space: only new entries and a paste, both at the project root.
  if (!target.path) {
    return [
      { label: "新建 pe 剧本", command: "tree.newPe" },
      { label: "新建 mpe 剧本", command: "tree.newMpe" },
      { label: "新建对话框样式", command: "tree.newDialog" },
      { label: "新建 JSON 文件", command: "tree.newJson" },
      { label: "新建 flowmap 文件", command: "tree.newMap" },
      { label: "新建关键帧文件", command: "tree.newKeyframes" },
      { label: "新建文件夹", command: "tree.newFolder" },
      { separator: true },
      paste,
    ];
  }

  // A folder: new entries and paste land inside it; copy/delete act on it.
  if (target.isDir) {
    return [
      { label: "新建 pe 剧本", command: "tree.newPe" },
      { label: "新建 mpe 剧本", command: "tree.newMpe" },
      { label: "新建对话框样式", command: "tree.newDialog" },
      { label: "新建 JSON 文件", command: "tree.newJson" },
      { label: "新建 flowmap 文件", command: "tree.newMap" },
      { label: "新建关键帧文件", command: "tree.newKeyframes" },
      { label: "新建文件夹", command: "tree.newFolder" },
      { separator: true },
      paste,
      { separator: true },
      { label: "复制", command: "tree.copy" },
      { label: "删除", command: "tree.delete" },
    ];
  }

  // A file: a script can be named the project's entry; anything may be copied
  // or deleted. The label flips once it is the entry, so the item is always the
  // way back rather than a dead entry for the file already chosen.
  const items = [];
  if (isScriptPath(target.path)) {
    const isEntry = session.project?.entry === target.path;
    items.push(
      { label: isEntry ? "取消入口脚本" : "设为入口脚本", command: "tree.toggleEntry" },
      { separator: true },
    );
  }
  if (isImagePath(target.path)) {
    items.push(
      { label: "编辑图片", command: "tree.editImage" },
      { separator: true },
    );
  }
  if (isAudioPath(target.path)) {
    items.push(
      { label: "编辑音频", command: "tree.editAudio" },
      { separator: true },
    );
  }
  items.push(
    { label: "重命名…", command: "tree.rename" },
    { label: "复制", command: "tree.copy" },
    { label: "删除", command: "tree.delete" },
  );
  return items;
}



/**
 * Builds the `{ path, name, isDir, isScript }` target the tree handlers expect
 * from a selected row element. With no row, the project root is the target — used
 * by Ctrl+V to paste into the top level.
 *
 * @param {Element | null} row
 */
function targetFromRow(row) {
  if (!row) {
    return { path: "", name: session.project?.name ?? "", isDir: true, isScript: false };
  }
  const path = row.dataset.path ?? "";
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    isDir: row.classList.contains("tree__row--dir"),
    isScript: row.classList.contains("tree__row--script"),
  };
}

/**
 * Wires the resource panel's keyboard shortcuts. The listener lives on the tree
 * container, so it only fires while focus is in the file tree — the editor's own
 * Ctrl+Z / Ctrl+C, and the graph editor's undo, are untouched.
 *
 * - Ctrl+C copy the selection, Ctrl+V paste into it (or the root if nothing is
 *   selected), Delete removes it.
 * - Ctrl+Z / Ctrl+Y undo and redo the last file operation.
 */
function attachResourceShortcuts() {
  const panel = dom.resourceBody;
  if (!panel) {
    return;
  }
  panel.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    const row = panel.querySelector(".tree__row.is-selected");
    const target = targetFromRow(row);

    // The handlers are async and report their own failures through setMessage; a
    // rejected promise here would otherwise surface as an unhandled rejection.
    const runHandler = (fn) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve()
        .then(fn)
        .catch((error) => setMessage(`文件操作失败：${describeError(error)}`, { error: true }));
    };

    if (mod && key === "c") {
      runHandler(() => treeOps.handlers["tree.copy"](target));
      return;
    }
    if (mod && key === "v") {
      runHandler(() => treeOps.handlers["tree.paste"](target));
      return;
    }
    if (!mod && (key === "delete" || key === "backspace")) {
      runHandler(() => treeOps.handlers["tree.delete"](target));
      return;
    }
    if (mod && key === "z" && !event.shiftKey) {
      runHandler(fileOps.undo);
      return;
    }
    if ((mod && key === "y") || (mod && key === "z" && event.shiftKey)) {
      runHandler(fileOps.redo);
      return;
    }
  });
}

// --- editor ---

/**
 * Builds one tab in the editor tab strip.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string} [options.kind] Extra class suffix, such as `code` or `stage`.
 * @param {boolean} [options.active]
 * @param {boolean} [options.dirty]
 * @param {() => void} [options.onSelect] Brings the tab's surface forward.
 * @param {() => void} [options.onClose] Omit for a tab with no close button.
 * @returns {HTMLElement}
 */
function createTab({ label, kind, active = false, dirty = false, onSelect, onClose }) {
  const tab = document.createElement("div");
  tab.className = "tab";
  if (kind) {
    tab.classList.add(`tab--${kind}`);
  }
  if (active) {
    tab.classList.add("tab--active");
  }
  if (dirty) {
    tab.classList.add("tab--dirty");
  }
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", String(active));

  const text = document.createElement("span");
  text.className = "tab__label";
  text.textContent = label;
  text.title = label;
  tab.append(text);

  if (onSelect) {
    tab.addEventListener("click", onSelect);
  }

  if (onClose) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab__close";
    close.title = "关闭";
    close.setAttribute("aria-label", `关闭 ${label}`);
    close.append(createIcon("close"));
    // The close button sits inside the tab, so the click must not also select it.
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      onClose();
    });
    tab.append(close);
  }

  return tab;
}

/**
 * Tells the menu bar what the current session can do.
 *
 * Called wherever one of the three facts it depends on changes — the project,
 * the open file, or whether a run is on — rather than only when the editor is
 * redrawn, so "停止运行" greys out the moment a run ends.
 */
function refreshMenuContext() {
  menuBar?.setContext({
    hasProject: Boolean(session.project),
    hasOpenFile: Boolean(session.openPath),
    // Whether "停止运行" has anything to stop; the entry is greyed out otherwise.
    running: Boolean(session.running),
    // The checked entry in the 文件 menu reads its state from here.
    autoSave: normalizeAutoSave(lifecycle.state.auto_save),
  });
  refreshRunButton();
}

/**
 * Lights the runbar play button only while a run can actually start.
 *
 * 「从当前文件执行」要求当前打开的确实是脚本（`.pe` / `.mpe`）或 `.flowmap`；
 * 「从入口文件执行」
 * 运行按钮仅在项目已打开时启用；按钮处于禁用态时不可点击，无需在点击后再提示不可运行。
 * 以下状态变更均触发按钮状态刷新：打开或关闭文件、打开或关闭项目、切换运行策略、运行结束。
 * 刷新入口为 `refreshMenuContext` 与 `refreshEditor`。
 * The refresh entry points are `refreshMenuContext` and `refreshEditor`.
 */
function refreshRunButton() {
  if (!runPlayButton) {
    return;
  }
  const runnable =
    runStrategy === "entry"
      ? Boolean(session.project)
      : Boolean(session.openPath) &&
        (isScriptPath(session.openPath) || isMapPath(session.openPath));
  runPlayButton.disabled = !runnable;
  // 悬停提示仅说明操作名称；可点击性由按钮的启用/禁用状态表达，不附加解释文字。
  runPlayButton.title = "执行";
  runPlayButton.setAttribute("aria-label", "执行");
}

// --- open documents ---
//
// A tab is a document, and a document owns its surface: the node map, the
// dialogue designer and the image and audio tools are instantiated per tab and
// kept in a container of their own, so switching tabs is a visibility change
// rather than a reload — a graph keeps its selection and its undo stack while a
// script is read beside it. A script is the one kind without a container (there
// is one textarea), so its tab keeps the text, the scroll offset and the caret.
//
// The editors are still reachable through the module's `dialogEditor`,
// `graphEditor`, `imageEditor` and `audioEditor` names: activating a document
// points those at its own instance, which keeps every existing call site — save,
// dirty check, path rewrite — reading the editor of the tab it means.

/**
 * 各类条目绘制时使用的容器类名。
 */
const DOC_CONTAINER_CLASS = {
  graph: "graph-view",
  dialog: "dialog-view",
  image: "image-edit",
  audio: "audio-edit",
};

/** Which surface a file is edited on, from its path alone. */
function docKind(path) {
  if (!path) {
    return null;
  }
  if (isMapPath(path)) {
    return "graph";
  }
  if (isDialogPath(path)) {
    return "dialog";
  }
  if (isImagePath(path)) {
    return "image";
  }
  if (isAudioPath(path)) {
    return "audio";
  }
  return "script";
}

function activeDoc() {
  return session.openPath ? session.docs.get(session.openPath) ?? null : null;
}

/** The surface a kind is drawn in — null for the shared ones (script, viewer). */
function containerFor(doc) {
  if (doc.kind === "script") {
    return null;
  }
  const element = document.createElement("div");
  element.className = DOC_CONTAINER_CLASS[doc.kind] ?? "doc-view";
  element.hidden = true;
  dom.editorCode?.parentElement?.append(element);
  return element;
}

/** The document for `path`, created on first open. */
function ensureDoc(path) {
  let doc = session.docs.get(path);
  if (doc) {
    return doc;
  }
  doc = {
    path,
    kind: docKind(path),
    container: null,
    editor: null,
    text: "",
    savedText: "",
    savedJson: "",
    url: "",
    view: "",
    scroll: 0,
    caret: 0,
  };
  doc.container = containerFor(doc);
  session.docs.set(path, doc);
  session.order.push(path);
  return doc;
}

/** Copies the live surface back into its document before switching away. */
function stashActive() {
  const doc = activeDoc();
  if (!doc) {
    return;
  }
  doc.view = session.view;
  doc.savedText = session.savedText;
  doc.savedJson = session.savedJson;
  if (doc.kind === "script" && dom.editorText) {
    doc.text = dom.editorText.value;
    doc.scroll = dom.editorText.scrollTop;
    doc.caret = dom.editorText.selectionStart ?? 0;
  }
}

/** Makes `path` the active tab and points the editor names at its instances. */
function activateDoc(path) {
  const doc = session.docs.get(path);
  if (!doc) {
    return null;
  }
  stashActive();
  session.openPath = path;
  session.savedText = doc.savedText;
  session.savedJson = doc.savedJson;
  if (doc.view) {
    session.view = doc.view;
  }

  for (const other of session.docs.values()) {
    if (other.container) {
      other.container.hidden = other.path !== path;
    }
  }

  syncEditors();
  return doc;
}

/**
 * Points the module's editor names at the active tab's instances.
 *
 * Every existing call site — save, dirty check, path rewrite — reads one of
 * these, so keeping them in step with the active document is what lets the
 * per-tab instances stay invisible to the rest of the file.
 */
function syncEditors() {
  const doc = activeDoc();
  const kind = doc?.kind ?? null;
  dialogEditor = kind === "dialog" ? doc.editor : null;
  graphEditor = kind === "graph" ? doc.editor : null;
  imageEditor = kind === "image" ? doc.editor : null;
  audioEditor = kind === "audio" ? doc.editor : null;
  dom.dialogView = kind === "dialog" ? doc.container : null;
  dom.graphView = kind === "graph" ? doc.container : null;
  dom.imageEditView = kind === "image" ? doc.container : null;
  dom.audioEditView = kind === "audio" ? doc.container : null;
}

/** Puts a document's contents back on the shared surfaces. */
function restoreDoc(doc) {
  if (!doc) {
    return;
  }
  if (doc.kind === "script" && dom.editorText) {
    dom.editorText.value = doc.text;
    updateHighlight();
    updateGutter();
    dom.editorText.scrollTop = doc.scroll;
    dom.editorText.setSelectionRange(doc.caret, doc.caret);
    return;
  }
  if (doc.kind === "image" && dom.imageImage && doc.url) {
    dom.imageImage.src = doc.url;
    if (dom.imageMeta) {
      dom.imageMeta.textContent = doc.path;
    }
  }
}

/** Whether a tab that is not on screen holds unsaved work. */
function isDocDirty(doc) {
  if (!doc) {
    return false;
  }
  if (doc.kind === "script") {
    return doc.text !== doc.savedText;
  }
  if (doc.kind === "dialog") {
    return Boolean(doc.editor) && doc.editor.serialize() !== doc.savedJson;
  }
  return Boolean(doc.editor?.dirty);
}

/**
 * Builds the editor a document needs, the first time its tab is opened.
 *
 * One instance per document: the callbacks below are all module-level, so
 * nothing here holds a particular tab, and a graph opened in one tab keeps its
 * selection and undo stack while another tab is in front.
 */
function createDocEditor(doc) {
  if (doc.editor || !doc.container) {
    return doc.editor;
  }
  try {
    if (doc.kind === "dialog") {
      // Built with `actions` in hand: the designer asks for the font list and for
      // image data as soon as a style file is opened, and both go through IPC.
      doc.editor = createDialogueEditor({
        // The designer is not a run, so it reads straight through: an author
        // who replaces a backdrop picture expects the preview to change, and a
        // cache with no run to clear it would keep showing the old file.
        resolveAsset: (path) => actions.readAsset(path),
        listFonts: () => actions.listFonts(),
        // Read lazily: the designer asks when a picture is picked, so a project
        // opened later is still the one being listed.
        //
        // A layer's picture comes from the interface folder — `assets/ui/`, the
        // frames and furniture a dialogue box is built from — while the test
        // backdrop is a scene picture and may be any image in the project.
        listImages: () => listUiImages(session.project),
        listBackdrops: () => listImages(session.project),
        onChange: () => { refreshStatus(); noteEdit(); },
        onError: (message) => setMessage(message, { error: true }),
      });
      doc.container.append(doc.editor.node);
    } else if (doc.kind === "image") {
      doc.editor = createImageEditor({
        element: doc.container,
        readImage: (path) => actions.readImage(path),
        writeAsset: (path, data) => actions.writeAsset(path, data),
        listImages: () => listImages(session.project),
        onError: (message) => setMessage(message, { error: true }),
        onStatus: (message) => setMessage(message),
        onChange: () => { refreshStatus(); noteEdit(); },
      });
    } else if (doc.kind === "audio") {
      doc.editor = createAudioEditor({
        element: doc.container,
        readAudio: (path) => actions.readAudio(path),
        writeAsset: (path, data) => actions.writeAsset(path, data),
        onError: (message) => setMessage(message, { error: true }),
        onStatus: (message) => setMessage(message),
        onChange: () => { refreshStatus(); noteEdit(); },
      });
    } else if (doc.kind === "graph") {
      doc.editor = createGraphEditor({
        element: doc.container,
        writeFile: (path, contents) => actions.write(path, contents),
        openFile: (path) => openFile(path),
        setMessage: (message, options) => setMessage(message, options),
        onStatus: (message) => setMessage(message),
        onChange: () => { refreshStatus(); noteEdit(); },
        onGenerate: (path) => generatePamelaFromMap(path).then((out) => out && openFile(out)),
        onConfirm: promptConfirm,
        // The move node's path frame is drawn on the stage the move happens on,
        // so the graph hands the node over and the host opens the editor.
        onEditPath: (node) => editGraphNodePath(node),
        // A file field offers the folder its kind owns: a character lists
        // portraits, a background lists backdrops, an audio node lists sounds.
        // A key frame field lists `data/`, where the animations live.
        listAssets: (kind) =>
          kind === "keyframes"
            ? listKeyFrameFiles().map((path) => splitPath(path).name)
            : listAssetFiles(session.project, kind).map((path) => splitPath(path).name),
        onImport: (path) => {
          const base = (path || "")
            .split("/")
            .pop()
            .replace(/\.(?:flowmap|pmap)$/i, "");
          const gen = joinPath("scripts", `p_${base}${SCRIPT_SUFFIX}`);
          return actions.read(gen).catch(() => null);
        },
      });
    }
  } catch (error) {
    console.error("[pamela] 编辑器初始化失败", error);
    setMessage("编辑器初始化失败。", { error: true });
  }
  // The instance just appeared, so the module's editor names may need to follow.
  if (doc.path === session.openPath) {
    syncEditors();
  }
  return doc.editor;
}

/** Drops a document's surface; its editor goes with the container. */
function disposeDoc(doc) {
  if (!doc) {
    return;
  }
  // An editor owns more than its DOM: observers, canvases, an AudioContext and
  // document-level listeners. Each one that can tear itself down is asked to,
  // so closing a tab does not leave a live editor (and its audio thread) behind.
  try {
    const editor = doc.editor;
    if (typeof editor?.close === "function") {
      editor.close();
    } else if (typeof editor?.destroy === "function") {
      editor.destroy();
    }
  } catch (error) {
    console.warn("[pamela] 关闭标签失败：", error);
  }
  doc.container?.remove();
  doc.container = null;
  doc.editor = null;
}

function refreshEditor() {
  refreshRunButton();
  if (!dom.editorText || !dom.editorEmpty) {
    return;
  }
  // Redrawing the editor means the text the suggestions were read from is being
  // replaced, so any list still up is about to describe the wrong script — and
  // a repaint still in flight must not open a new one over the new file.
  completion?.dismiss();
  const hasFile = Boolean(session.openPath);
  // The key frame editor is a document of its own, drawn over the stage. It
  // shows while its own tab is the active one — `session.view === "stage"` with
  // the editor open — and the script stays on screen behind it otherwise.
  const keyEditing = Boolean(session.keyFile) && Boolean(pathEditor?.isOpen());
  // The active tab decides which surface fills the editor area: a dialogue style
  // file is edited as a box, an image is shown, the node map as a map.
  const doc = activeDoc();
  const kind = doc?.kind ?? null;
  const isDialog = kind === "dialog";
  const isImage = kind === "image";
  const isImageEdit = isImage && session.view === "imageEdit";
  const isAudioEdit = kind === "audio";
  const isGraph = kind === "graph";
  const showGraph = isGraph && session.view === "graph";
  // The stage shares the editor area with the code, and only exists while a
  // script has been run — or while a load is being chosen, which has to show
  // the grid even though no run is on yet. Without a file there is nothing to
  // run from. The key frame editor needs no file open: it is opened over the
  // scene it belongs to, which is a document of its own.
  const showStage =
    (hasFile || keyEditing) &&
    session.view === "stage" &&
    (Boolean(session.stageName) || slotsOpen() || keyEditing);
  const showDialog = isDialog && session.view === "dialog";
  const showImage = isImage && session.view === "image";
  const showImageEdit = isImageEdit;
  const showAudioEdit = isAudioEdit;
  // The reader borrows the editor area and takes precedence over whatever
  // document is open: it is entered from the toolbar, and leaving it is opening
  // a tab again rather than closing the reader first.
  const reading = Boolean(session.reader);

  if (dom.editorCode) {
    dom.editorCode.hidden =
      reading ||
      !hasFile ||
      showStage ||
      isDialog ||
      isImage ||
      isImageEdit ||
      isAudioEdit ||
      isGraph;
  }
  dom.editorEmpty.hidden = reading || hasFile || keyEditing;
  if (dom.stageView) {
    dom.stageView.hidden = reading || !showStage;
    // Leaving the stage tab takes the pointer reading with it — the pointer is
    // somewhere else now, and no `pointerleave` will say so.
    if (dom.stageView.hidden) {
      clearPointerReading();
      // The corner menu goes with it: it is open only while the pointer is in
      // the corner, and a hidden stage has no corner to be in.
      stageMenu?.close();
    }
  }
  if (dom.readerView) {
    dom.readerView.hidden = !reading;
  }
  if (reading) {
    readerPanel.render();
  }
  // The menu's lit words follow the stage: while it is off screen there is
  // nothing for them to say, and a stale "auto on" would outlive its run.
  if (!showStage) {
    closeSlots();
    playback.closeSettings();
  }
  playback.refreshMenu();
  if (dom.dialogView) {
    dom.dialogView.hidden = reading || !showDialog;
  }
  if (dom.imageView) {
    dom.imageView.hidden = reading || !showImage;
  }
  if (dom.imageEditView) {
    dom.imageEditView.hidden = reading || !showImageEdit;
  }
  if (dom.audioEditView) {
    dom.audioEditView.hidden = reading || !showAudioEdit;
  }
  if (dom.graphView) {
    dom.graphView.hidden = reading || !showGraph;
  }

  if (hasFile && !showStage && !isDialog && !isImage) {
    updateGutter();
    updateTintMarkers();
  }

  if (dom.editorTabs) {
    dom.editorTabs.replaceChildren();
    // One tab per open document, in the order they were opened. Each tab keeps
    // its own surface, so selecting one is a switch rather than a reload.
    for (const path of session.order) {
      const item = session.docs.get(path);
      if (!item) {
        continue;
      }
      const isActive = path === session.openPath;
      const surface = item.view || (item.kind === "script" ? "code" : item.kind);
      dom.editorTabs.append(
        createTab({
          label: path,
          kind: surface === "audio" ? "audioEdit" : surface,
          // While a key frame is being edited the stage belongs to that tab, so
          // the document behind it does not claim the highlight.
          // The reader likewise owns the editor area while it is open.
          active: !reading && isActive && !keyEditing && (surface === "code" ? !showStage : true),
          dirty: isActive ? isEditorDirty() : isDocDirty(item),
          onSelect: () => {
            void openFile(path);
          },
          onClose: () => {
            void closeFile(path);
          },
        }),
      );
    }
    // The key frame file is a tab of its own, named after the file rather than
    // the object: that is what the author opened and what the script names.
    if (session.keyFile) {
      dom.editorTabs.append(
        createTab({
          label: session.keyFile.path,
          kind: "keyframes",
          active: showStage && keyEditing,
          dirty: Boolean(pathEditor?.isDirty()),
          onSelect: () => {
            if (!pathEditor?.isOpen()) {
              // brought back after a trip): opening the file again rebuilds it
              // over the scene the key plays on, exactly as the first time.
              openPathEditor(session.keyFile.path, {
                objectName: session.keyFile.objectName,
                scriptPath: session.keyFile.scriptPath,
                call: session.keyFile.call,
              }).catch((error) => setMessage(describeError(error), { error: true }));
              return;
            }
            session.view = "stage";
            refreshEditor();
          },
          onClose: () => {
            // Closing the tab is the one way to drop the animation's tab: the
            // back button keeps it, so coming back to it is always possible.
            if (pathEditor?.isDirty()) {
              pathEditor
                .save()
                .catch((error) =>
                  setMessage(`保存关键帧失败：${describeError(error)}`, { error: true }),
                );
            }
            pathEditor?.close();
            session.keyFile = null;
            session.view = "code";
            refreshEditor();
          },
        }),
      );
    }
    if (hasFile && session.stageName && !keyEditing) {
      dom.editorTabs.append(
        createTab({
          label: session.stageName,
          kind: "stage",
          active: showStage && !reading,
          onSelect: showStageView,
          onClose: closeStage,
        }),
      );
    }
    // The reader is a tab like a document is — it can be left by switching to
    // another tab and returned to from its own. It carries the article's name,
    // since that is what is on screen.
    if (reading) {
      dom.editorTabs.append(
        createTab({
          label: readerPanel.label(),
          kind: "reader",
          active: true,
          onSelect: () => readerPanel.open(session.reader.setName, session.reader.articleId),
          onClose: () => readerPanel.close(),
        }),
      );
    }
  }

  refreshStatus();
  refreshMenuContext();
}

/** Brings the editor forward, leaving a running stage alive in its own tab. */
function showCode() {
  // A dialogue style file has no text surface to return to.
  if (isDialogPath(session.openPath)) {
    showDialogView();
    return;
  }
  // Nor has an image: its own surface is the way back.
  if (isImagePath(session.openPath)) {
    if (session.view === "imageEdit") {
      showImageEditView();
    } else {
      showImageView();
    }
    return;
  }
  if (isAudioPath(session.openPath)) {
    showAudioEditView();
    return;
  }
  if (isMapPath(session.openPath)) {
    showGraphView();
    return;
  }
  if (session.view === "code") {
    return;
  }
  // Coming back from the key frame editor is the same trip: the script's tab is
  // what the author asked for, so the key frame tab steps aside and the script
  // comes forward — without closing the animation's tab, which stays one click
  // away.
  if (session.keyFile && pathEditor?.isOpen()) {
    leavePathEditor().catch((error) => setMessage(describeError(error), { error: true }));
    return;
  }
  session.view = "code";
  refreshEditor();
  dom.editorText?.focus();
}

/** Brings the dialogue designer forward. */
function showDialogView() {
  if (session.view === "dialog") {
    return;
  }
  session.view = "dialog";
  refreshEditor();
}

/** Brings the image viewer forward. */
function showImageView() {
  if (session.view === "image") {
    return;
  }
  session.view = "image";
  refreshEditor();
}

/** Brings the image editor forward. */
function showImageEditView() {
  if (session.view === "imageEdit") {
    return;
  }
  session.view = "imageEdit";
  refreshEditor();
}

/** Brings the audio editor forward. */
function showAudioEditView() {
  if (session.view === "audioEdit") {
    return;
  }
  session.view = "audioEdit";
  refreshEditor();
}

/** Brings the visual programming canvas forward. */
function showGraphView() {
  if (session.view === "graph") {
    return;
  }
  session.view = "graph";
  refreshEditor();
}

/** Brings the stage forward. */
function showStageView() {
  if (session.view === "stage") {
    return;
  }
  session.view = "stage";
  refreshEditor();
}

let repaintFrame = 0;

/** The line count the gutter is currently showing, so an in-line edit is free. */
let gutterLines = 0;

/** A pending live-error check, and the scan it will reuse. */
let errorMarkTimer = 0;
let errorMarkScan = null;

/** How long typing may pause before the error underline is refreshed. */
const ERROR_MARK_DELAY = 140;

/** Last text the find marks were built from, and the debounce for rebuilding. */
let findMarkText = null;
let findMarkTimer = 0;

/**
 * Schedules the editor's repaints for the next frame, once.
 *
 * A keystroke used to repaint the whole document immediately: the gutter, the
 * colour markers, the highlight layer (a full tokenize), the error marks
 * (another tokenize plus parse), the completion scan and the find matches.
 * Coalescing them keeps a fast typist from queueing several full passes per
 * character, which is what made a long script feel heavy.
 */
function scheduleEditorRepaint() {
  if (repaintFrame) {
    return;
  }
  const nextFrame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (run) => setTimeout(run, 16);
  repaintFrame = nextFrame(() => {
    repaintFrame = 0;
    refreshStatus();
    updateGutter();
    updateTintMarkers();
    updateHighlight({ deferErrors: true });
    completion?.refresh();
    // Re-mark live matches while the user edits, but don't yank the caret to
    // the active match — that would fight their typing. The search itself is
    // debounced: re-measuring every hit on every frame is what made a long
    // script crawl. Scrolling only moves the existing marks.
    if (findBar.isOpen()) {
      const text = dom.editorText.value;
      if (text !== findMarkText) {
        findMarkText = text;
        clearTimeout(findMarkTimer);
        findMarkTimer = setTimeout(() => {
          if (findBar.isOpen()) {
            findBar.run(false);
          }
        }, 90);
      } else {
        findBar.syncScroll();
      }
    }
  });
}

/**
 * Renders the gutter line numbers for the open script.
 *
 * A plain textarea has no notion of lines, so the numbers are derived from the
 * value. They are written as a single newline-joined text node, which keeps the
 * rebuild on every keystroke cheap; the gutter shares the textarea's line
 * height, so line N of the gutter sits on line N of the text.
 */
function updateGutter() {
  const host = dom.editorGutterInner;
  if (!host || !dom.editorText) {
    return;
  }
  // The numbers only change when the line count does. Typing inside a line — by
  // far the common case — used to rebuild the whole string and replace the text
  // node on every frame; counting newlines is a read either way, but the rebuild
  // and the DOM write are skipped.
  const lineCount = lineCountOf(dom.editorText.value);
  if (lineCount !== gutterLines) {
    gutterLines = lineCount;
    const numbers = new Array(lineCount);
    for (let index = 0; index < lineCount; index += 1) {
      numbers[index] = String(index + 1);
    }
    host.textContent = numbers.join("\n");
  }
  syncGutterScroll();
}

/** The number of lines in `text`, without splitting it into an array. */
function lineCountOf(text) {
  let count = 1;
  let at = text.indexOf("\n");
  while (at !== -1) {
    count += 1;
    at = text.indexOf("\n", at + 1);
  }
  return count;
}

/**
 * Keeps the gutter aligned when the textarea scrolls.
 *
 * The numbers are translated rather than scrolled: the gutter's own scroll range
 * is not the textarea's (the textarea has scrollbars, and a value ending in a
 * newline gives it one more line box), so an offset copied into `scrollTop` can
 * be clamped a line short at the bottom — the numbers would then sit one line
 * off from the text they label.
 */
function syncGutterScroll() {
  const host = dom.editorGutterInner;
  if (host && dom.editorText) {
    host.style.transform = `translateY(${-dom.editorText.scrollTop}px)`;
  }
}

/**
 * Repaints the highlight layer behind the textarea from the current text. The
 * language lexer produces the coloured HTML — a `.pe` file token by token, a
 * `.mpe` file line by line, since the shorthand is written that way; the layer
 * shares the textarea's font metrics so the two stay in register.
 */
function updateHighlight({ deferErrors = false } = {}) {
  const host = dom.editorHighlightInner;
  if (!host || !dom.editorText) {
    return;
  }
  const source = dom.editorText.value;
  const mpe = isMpePath(session.openPath);
  // A `.pe` script is scanned once and those tokens feed both layers; a `.mpe`
  // file is painted line by line and has to compile before it can be checked,
  // so it has no tokens to share.
  const scanned = mpe ? null : tokenize(source);
  host.innerHTML = mpe
    ? highlightMpe(source)
    : highlightTokens(scanned?.error ? null : scanned.tokens, source);
  syncHighlightScroll();
  // `updateHighlight` is the one repaint every editing path already calls
  // (typing, accepting a completion, opening a file), so the error mark rides
  // along instead of needing its own hook at each of those places. While typing
  // it rides one pause behind: parsing the whole script on every frame is the
  // most expensive thing the editor does, and an underline is not read
  // character by character the way the coloured text is.
  if (deferErrors) {
    scheduleErrorMarks(scanned);
  } else {
    flushErrorMarks(scanned);
  }
}

/**
 * Repaints the error underline now, dropping any deferred check.
 *
 * Opening a file, switching tabs and every non-typing path come through here,
 * so a saved script shows its broken line immediately rather than after a
 * delay meant for keystrokes.
 */
function flushErrorMarks(scanned = null) {
  if (errorMarkTimer) {
    clearTimeout(errorMarkTimer);
    errorMarkTimer = 0;
  }
  errorMarkScan = null;
  updateErrorMarks(scanned);
}

/**
 * Repaints the error underline once typing pauses, reusing the frame's scan.
 *
 * The timer is restarted on every frame, so a long burst of typing does one
 * parse at the end of it rather than one per frame; the tokens kept here are
 * the ones the highlight layer just painted, so the underline cannot disagree
 * with the colours on screen.
 */
function scheduleErrorMarks(scanned) {
  errorMarkScan = scanned;
  if (errorMarkTimer) {
    clearTimeout(errorMarkTimer);
  }
  errorMarkTimer = setTimeout(() => {
    errorMarkTimer = 0;
    const pending = errorMarkScan;
    errorMarkScan = null;
    updateErrorMarks(pending);
  }, ERROR_MARK_DELAY);
}

/**
 * Keeps the painted text aligned with the textarea while it scrolls.
 *
 * The text is translated rather than scrolled, for the same reason as the gutter
 * (`syncGutterScroll`): the two layers' scroll ranges are not equal — a value
 * ending in a newline gives the textarea one more line box than the `<pre>`
 * paints, and the textarea's scrollbars shorten it further — so copying
 * `scrollTop` across makes the paint clamp a line short at the bottom and the
 * coloured text drifts out of register with the numbers and the caret.
 */
function syncHighlightScroll() {
  const host = dom.editorHighlightInner;
  if (host && dom.editorText) {
    host.style.transform =
      `translate(${-dom.editorText.scrollLeft}px, ${-dom.editorText.scrollTop}px)`;
  }
}

/**
 * Paints the first syntax error as a red underline on its own line. Runtime
 * errors are still reported in the status bar; this one is live, so a writer
 * sees the broken line before pressing 运行. `editor-errors.js` uses the
 * interpreter's own `tokenize`/`parse`, so the mark cannot disagree with `run`.
 */
function updateErrorMarks(scanned = null) {
  const inner = dom.editorErrorInner;
  if (!inner || !dom.editorText) {
    return;
  }
  inner.replaceChildren();
  if (dom.editorCode.hidden) {
    return;
  }
  const source = dom.editorText.value;
  const mpe = isMpePath(session.openPath);
  // A shorthand script is compiled before it is checked, so the underline agrees
  // with what 运行 would report. Compiling is line-for-line, so the mark still
  // lands on the line as written; only the columns inside a line may shift.
  const text = mpe ? transpile(source) : source;
  // A clean `.pe` scan is reused; a lexer error has no tokens to parse, and an
  // `.mpe` file was compiled above, so both fall back to a fresh scan.
  const error =
    mpe || !scanned || scanned.error
      ? syntaxErrorIn(text)
      : syntaxErrorInTokens(scanned.tokens, text);
  inner.dataset.message = error ? `第 ${error.line} 行：${error.message}` : "";
  if (!error) {
    return;
  }
  // 同一份几何也摆在查找标记下面，量一次就够。
  findBar.measureGeometry();
  const rect = errorMarkRect(source, error, findBar.geometry());
  // The underline runs from the error's column to the end of its line. The
  // glyphs themselves are measured when the layer can be read, because the count
  // `errorMarkRect` multiplies a character width by is only exact in a
  // monospace face — the editor is set in a proportional one.
  const lineStart = offsetOfLine(source, rect.row);
  const lineEnd = lineStart + (source.split(/\r?\n/)[rect.row]?.length ?? 0);
  const gap = editorRangeRect(lineStart + Math.max(0, error.column - 1), lineEnd);
  if (gap) {
    rect.left = gap.left;
    rect.width = Math.max(1, gap.width);
  }
  const mark = document.createElement("span");
  mark.className = "editor__error-mark";
  mark.setAttribute("aria-label", inner.dataset.message);
  mark.style.top = `${rect.top}px`;
  mark.style.left = `${rect.left}px`;
  mark.style.width = `${rect.width}px`;
  mark.style.height = `${rect.height}px`;
  inner.append(mark);
  syncErrorScroll();
}

/** Keeps the error underline glued to the text while the textarea scrolls. */
function syncErrorScroll() {
  if (dom.editorErrorInner && dom.editorText) {
    dom.editorErrorInner.style.transform =
      `translate(${-dom.editorText.scrollLeft}px, ${-dom.editorText.scrollTop}px)`;
  }
}

// --- editor decorations: colour swatches, colour picker, drop targets ---

/** What the colour strip was last painted from, so an unchanged frame is free. */
let tintText = null;
let tintHost = null;
let tintHidden = null;

/**
 * Rebuilds the per-line colour-picker swatches for `rgbTo`/`hex` calls.
 *
 * One swatch sits at the head of each line that names a colour, over the gutter.
 * Its background shows the colour already there, or a neutral mark when the call
 * has no colour to read back yet. Swatches sit at their position in the text and
 * the strip is translated as a whole, so scrolling moves them without a rebuild.
 */
function updateTintMarkers() {
  const layer = dom.editorTint;
  if (!layer || !dom.editorText || !dom.editorGutter) {
    return;
  }
  const host = dom.editorTintInner || layer;
  const text = dom.editorText.value;
  const hidden = dom.editorCode.hidden;
  // Repainting is keyed on the text: the scroll handler used to come through
  // here too, which rebuilt every swatch — and forced two style/layout reads —
  // for a scroll that only moves them. The swatches now sit at their content
  // position and the whole strip is translated; see `syncTintScroll`.
  if (text === tintText && host === tintHost && hidden === tintHidden) {
    return;
  }
  tintText = text;
  tintHost = host;
  tintHidden = hidden;
  host.replaceChildren();
  if (hidden) {
    return;
  }
  const markers = findTintLines(text);
  if (!markers.length) {
    return;
  }
  // Read once per repaint rather than once per scroll: the strip is positioned
  // from these numbers, and it is the repaint that can change them.
  const styles = getComputedStyle(dom.editorText);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 20.8;
  const padTop = Number.parseFloat(styles.paddingTop) || 12;
  const gutterWidth = dom.editorGutter.getBoundingClientRect().width;
  layer.style.width = `${gutterWidth}px`;
  for (const { index, hex } of markers) {
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "editor__tint-mark";
    mark.style.top = `${padTop + index * lineHeight}px`;
    mark.style.left = `${(gutterWidth - 12) / 2}px`;
    mark.style.background = hex ? `#${hex}` : "var(--pamela-accent)";
    mark.dataset.line = String(index);
    mark.title = hex ? `#${hex}` : "颜色";
    mark.addEventListener("click", async (event) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const chosen = await openColorPicker(rect.left, rect.bottom + 4, hex ? `#${hex}` : "#000000");
      if (chosen) {
        applyTintFill(index, chosen.replace(/^#/, "").toUpperCase());
      }
    });
    host.append(mark);
  }
  syncTintScroll();
}

/** Slides the colour swatches with the text instead of rebuilding them. */
function syncTintScroll() {
  const host = dom.editorTintInner;
  if (host && dom.editorText) {
    host.style.transform = `translateY(${-dom.editorText.scrollTop}px)`;
  }
}

/** Writes a picked colour into the `rgbTo`/`hex` call on `lineIndex`. */
function applyTintFill(lineIndex, hex) {
  const lines = dom.editorText.value.split("\n");
  const line = lines[lineIndex];
  if (!line) {
    return;
  }
  const replaced = fillTintLine(line, hex);
  if (replaced === line) {
    return;
  }
  lines[lineIndex] = replaced;
  dom.editorText.value = lines.join("\n");
  // Fire `input` so the dirty mark, the gutter and the completion list hear it
  // like any other edit, then redraw the swatches for the new colour.
  dom.editorText.dispatchEvent(new Event("input", { bubbles: true }));
  updateTintMarkers();
}

/**
 * Opens the native colour picker at a point, answering the chosen `#rrggbb`.
 *
 * The input is kept invisible and only hosts the OS dialog; what it answers is
 * the colour, and a dismiss (Escape or a click away) answers `null` so the line
 * is left as it was.
 */
function openColorPicker(x, y, currentHex) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(currentHex) ? currentHex : "#000000";
    Object.assign(input.style, {
      position: "fixed",
      left: `${Math.max(0, x)}px`,
      top: `${Math.max(0, y)}px`,
      width: "0",
      height: "0",
      padding: "0",
      border: "0",
      opacity: "0",
      zIndex: "400",
    });
    document.body.append(input);
    let settled = false;
    const close = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      resolve(result);
    };
    input.addEventListener("change", () => close(input.value));
    input.addEventListener("blur", () => close(null));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        close(null);
      }
    });
    // The click hands the dialog to the OS; a choice fires `change`.
    input.click();
  });
}

/**
 * Adds a dropped file name as the next argument of the call under the pointer.
 *
 * The drop does not have to land between the brackets: aiming anywhere on the
 * call — its name included — is enough, because that is what the eye aims at.
 * `func()` becomes `func("ch.png")`; `func(a)` becomes `func(a, "ch.png")`.
 *
 * A shorthand script says the same thing without brackets or quotes, so the
 * line is matched by its own rules there: `背景` becomes `背景 教室.png`, and
 * `角色 旧.png` takes the new name in place of the old one.
 *
 * @param {string} name The file name the tree handed over.
 * @param {DragEvent} event The drop.
 * @returns {boolean} Whether a call took the name.
 */
function insertArgumentAtCall(name, event) {
  const textarea = dom.editorText;
  if (!textarea) {
    return false;
  }
  const at = pointerTextPosition(textarea, event);
  if (!at) {
    return false;
  }
  const lines = textarea.value.split("\n");
  const line = lines[at.line];
  if (line === undefined) {
    return false;
  }
  const replaced = isMpePath(session.openPath)
    ? mpeFillDropAt(line, at.column, name)
    : dropArgumentAt(line, at.column, name);
  if (replaced === null || replaced === line) {
    return false;
  }
  lines[at.line] = replaced;
  textarea.value = lines.join("\n");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  setMessage(`已把 ${name} 追加为参数`);
  return true;
}

/**
 * Where the pointer is, in the textarea's own text.
 *
 * `caretPositionFromPoint` answers the offset inside the field's text, which is
 * what tells a drop both the line it landed on and how far along that line. A
 * drop the webview cannot place — on the padding around the text — falls back to
 * the line under the pointer and the column its x suggests.
 */
function pointerTextPosition(textarea, event) {
  const value = textarea.value;
  const fromOffset = (offset) => {
    const safe = Math.min(Math.max(0, offset), value.length);
    return {
      offset: safe,
      line: value.slice(0, safe).split("\n").length - 1,
      column: safe - (value.lastIndexOf("\n", safe - 1) + 1),
    };
  };

  const at = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (at?.offsetNode && textarea.contains(at.offsetNode)) {
    return fromOffset(at.offset);
  }
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range?.startContainer && textarea.contains(range.startContainer)) {
    return fromOffset(range.startOffset);
  }

  const rect = textarea.getBoundingClientRect();
  const styles = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 20.8;
  const padTop = Number.parseFloat(styles.paddingTop) || 12;
  const padLeft = Number.parseFloat(styles.paddingLeft) || 12;
  const fontSize = Number.parseFloat(styles.fontSize) || 14;
  const line = Math.max(
    0,
    Math.floor((event.clientY - rect.top + textarea.scrollTop - padTop) / lineHeight),
  );
  const column = Math.max(0, Math.round((event.clientX - rect.left - padLeft) / (fontSize * 0.6)));
  return { offset: 0, line, column };
}

/**
 * The pixel width of one monospace character in the editor, measured once from
 * the textarea's own font so a highlight box can be placed over an exact range
 * of columns rather than guessed at.
 *
 * @param {HTMLTextAreaElement} textarea The editor field.
 * @returns {number}
 */
let measuredCharWidth = 0;
function measureCharWidth(textarea) {
  if (measuredCharWidth) {
    return measuredCharWidth;
  }
  const styles = getComputedStyle(textarea);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = `${styles.fontStyle} ${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
    measuredCharWidth = ctx.measureText("M").width || Number.parseFloat(styles.fontSize) * 0.6;
  } else {
    measuredCharWidth = Number.parseFloat(styles.fontSize) * 0.6;
  }
  return measuredCharWidth;
}

/**
 * Hides the call highlight box.
 *
 * Called whenever the drag leaves the editor or lands, and whenever the pointer
 * is no longer over a call that would snap up the dropped file.
 */
function clearDropCall() {
  if (dom.editorCallHighlight) {
    dom.editorCallHighlight.hidden = true;
  }
}

/**
 * Shows the call that a drag currently hovering the editor would snap to.
 *
 * The same target `insertArgumentAtCall` would use on drop is found first — a
 * bracketed call by `callAtColumn`, a shorthand statement by `mpeDropTargetAt`
 * — and a translucent box is painted over that text so the writer can see,
 * before letting go, which function is about to take the file.
 * Anything that is not a snap target — the gutter, a non-call line, the padding
 * — clears the box instead.
 *
 * @param {DragEvent} event The in-progress drag.
 */
function highlightDropCall(event) {
  const textarea = dom.editorText;
  const layer = dom.editorCallHighlight;
  if (!textarea || !layer || dom.editorCode.hidden || !hasPlainText(event)) {
    return;
  }
  const rect = textarea.getBoundingClientRect();
  // The pointer has to be over the text itself, not the gutter or outside.
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    clearDropCall();
    return;
  }
  const at = pointerTextPosition(textarea, event);
  if (!at) {
    clearDropCall();
    return;
  }
  const lines = textarea.value.split("\n");
  const line = lines[at.line];
  if (line === undefined) {
    clearDropCall();
    return;
  }
  // Which statements a drop can fill depends on the spelling of the open file:
  // a bracketed call takes an argument anywhere, a shorthand line only when it
  // names one of the four single-resource builtins.
  const call = isMpePath(session.openPath)
    ? mpeDropTargetAt(line, at.column)
    : callAtColumn(line, at.column);
  if (!call) {
    clearDropCall();
    return;
  }
  const styles = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 20.8;
  const padTop = Number.parseFloat(styles.paddingTop) || 12;
  const padLeft = Number.parseFloat(styles.paddingLeft) || 14;
  const charWidth = measureCharWidth(textarea);
  const scrollTop = textarea.scrollTop;
  const scrollLeft = textarea.scrollLeft;
  // The call's own glyphs are measured wherever the layer can be read: a column
  // times a character width only describes the text in a monospace face, and the
  // editor's is proportional. The column arithmetic stays as the fallback.
  const lineStart = lines.slice(0, at.line).reduce((sum, value) => sum + value.length + 1, 0);
  const box = editorRangeRect(lineStart + call.start, lineStart + call.end + 1);
  const left = (box ? box.left : padLeft + call.start * charWidth) - scrollLeft;
  let width = box ? Math.max(1, box.width) : (call.end - call.start + 1) * charWidth;
  // Keep the box inside the visible text so an open call trailing to the line
  // end does not spill past the editor's right edge.
  width = Math.max(0, Math.min(width, textarea.clientWidth - left));
  layer.hidden = false;
  layer.style.top = `${padTop + at.line * lineHeight - scrollTop}px`;
  layer.style.left = `${left}px`;
  layer.style.width = `${width}px`;
  layer.style.height = `${lineHeight}px`;
}

/**
 * Whether a drag carries the plain-text path the tree hands over.
 *
 * `DataTransfer.types` is a `DOMStringList` in some WebView2 builds and a frozen
 * array in others; only the latter has `includes`, and calling it on the former
 * throws — which leaves the drop target refusing the drag, and the pointer
 * showing the no-entry cursor instead of the copy cursor.
 */
function hasPlainText(event) {
  if (!event.dataTransfer) {
    return false;
  }
  const types = Array.from(event.dataTransfer.types);
  // A file from the desktop is the one kind this target refuses; everything else
  // is either the tree's path or a text drag. An empty list is accepted too —
  // some builds report the types only once the drop lands, and refusing those
  // would leave the pointer showing the no-entry cursor over a drop that works.
  if (types.includes("Files")) {
    return false;
  }
  return types.length === 0 || types.includes("text/plain") || types.includes("text");
}

/**
 * Writes a dropped file name into the script where the pointer let go.
 *
 * A drag out of the tree carries a plain string, and a drop in the middle of a
 * line splits that line there. `caretPositionFromPoint` answers the offset
 * inside the textarea's own text; a drop the webview cannot place falls back to
 * the caret, which is still the author's own position, just less literal.
 */
function insertTextAtDrop(text, event) {
  const textarea = dom.editorText;
  if (!textarea) {
    return;
  }
  let offset = textarea.selectionStart ?? textarea.value.length;
  const at = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (at && at.offsetNode && textarea.contains(at.offsetNode)) {
    offset = at.offset;
  } else {
    // 旧版 WebView2 仅支持 range 变体。
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range?.startContainer && textarea.contains(range.startContainer)) {
      offset = range.startOffset;
    }
  }
  offset = Math.min(Math.max(0, offset), textarea.value.length);
  textarea.focus();
  textarea.setRangeText(text, offset, offset, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  setMessage(`已插入 ${text}`);
}



/** Brings forward the surface a file is edited on: the box, the picture, or the text. */
function surfaceFor(path) {
  if (isDialogPath(path)) {
    showDialogView();
  } else if (isImagePath(path)) {
    showImageView();
  } else if (isAudioPath(path)) {
    showAudioEditView();
  } else if (isMapPath(path)) {
    showGraphView();
  } else {
    showCode();
  }
}

/**
 * Reads a style file.
 *
 * A file that does not parse is reported and the designer opens on the
 * defaults, so a half-written box is still editable rather than a dead tab.
 */
function parseDialog(contents) {
  try {
    return JSON.parse(contents);
  } catch {
    setMessage("样式文件不是有效的 JSON，已按默认样式打开。", { error: true });
    return null;
  }
}

/** Loads a script or a style file from disk into its own surface. */
async function openFile(path) {
  if (!session.project || !dom.editorText) {
    return;
  }
  // Opening a file is leaving the reader: the tab is what the author asked for,
  // and the article would otherwise keep covering it. The editor is repainted
  // here as well as by the branches below: re-opening the file that is already
  // in the editor returns early from `surfaceFor`, and the article must not stay
  // on top of it.
  readerPanel.leave();
  if (session.openPath === path) {
    // Re-opening the current file brings its surface forward instead of doing
    // nothing, so the tree doubles as a way back from the stage.
    surfaceFor(path);
    return;
  }

  // Already open: switch to it. Its surface is still there holding whatever it
  // was showing, so nothing is read again and nothing is thrown away — which is
  // the point of a tab, and the reason a switch never asks about unsaved work.
  if (session.docs.has(path)) {
    const open = activateDoc(path);
    restoreDoc(open);
    surfaceFor(path);
    refreshEditor();
    return;
  }

  // An image is not text, so it never goes through the read below — which
  // would either fail on the bytes or put them in the textarea.
  if (isImagePath(path)) {
    await openImage(path);
    return;
  }

  if (isAudioPath(path)) {
    await openAudioEditor(path);
    return;
  }

  // A video is not text either. The tree shows it on hover; a script reaches
  // it through Video("clip.mp4"), so opening its bytes in the editor is wrong.
  if (isVideoPath(path)) {
    setMessage("视频资源：悬停可预览，在剧本里用 Video(\"文件名\") 引用");
    return;
  }

  if (isMapPath(path)) {
    await openGraph(path);
    return;
  }

  if (isPathFile(path)) {
    // A key frame file is opened in its own editor, over the scene it plays on.
    // The editor is handed the file, not the id: two objects may name one
    // animation, and the tab has to say which file it is editing.
    await openPathEditor(path, { objectName: idFromPathFile(path) });
    return;
  }

  const token = ++openToken;
  try {
    const contents = await actions.read(path);
    // A newer click has already asked for another file: this answer is stale.
    if (token !== openToken || !session.project) {
      return;
    }
    const doc = ensureDoc(path);
    activateDoc(path);
    doc.text = contents;
    doc.savedText = contents;
    session.savedText = contents;

    if (doc.kind === "dialog") {
      const editor = createDocEditor(doc);
      if (!editor) {
        throw new Error("对话框设计器不可用。");
      }
      editor.load(path, parseDialog(contents));
      session.view = "dialog";
      doc.view = "dialog";
      // What was saved is the document as the designer reads it back, not the
      // file's bytes: a file that left fields out is not dirty the moment it
      // is opened.
      doc.savedJson = editor.serialize();
      session.savedJson = doc.savedJson;
    } else {
      doc.savedJson = "";
      session.savedJson = "";
      dom.editorText.value = contents;
      session.view = "code";
      doc.view = "code";
    }

    refreshEditor();
    if (session.view === "code") {
      try {
        updateHighlight();
      } catch (error) {
        console.error("[pamela] 高亮更新失败", error);
      }
      dom.editorText.focus();
    }
    setMessage(`已打开 ${path}`);
  } catch (error) {
    if (token !== openToken) {
      return;
    }
    console.error("[pamela] 打开文件失败", error);
    setMessage(describeError(error), { error: true });
  }
}

/**
 * Loads an image from disk into the viewer.
 *
 * The backend inlines the file as a `data:` URL, because the webview cannot
 * read a project path under the app's CSP. An image has no text and no
 * document, so neither of the editor's saved snapshots applies to it: it can
 * never be dirty, and the panel's other state is left as it was.
 */
async function openImage(path) {
  try {
    const dataUrl = await actions.readImage(path);
    const doc = ensureDoc(path);
    activateDoc(path);
    doc.url = dataUrl;
    doc.savedText = "";
    doc.savedJson = "";
    session.savedText = "";
    session.savedJson = "";
    session.view = "image";
    doc.view = "image";
    if (dom.imageImage) {
      dom.imageImage.src = dataUrl;
      dom.imageImage.alt = splitPath(path).name;
    }
    if (dom.imageMeta) {
      dom.imageMeta.textContent = path;
    }
    refreshEditor();
    setMessage(`已打开 ${path}`);
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/**
 * Loads an image into the image editor (crop / adjust / compose / export).
 */
async function openImageEditor(path) {
  try {
    const doc = ensureDoc(path);
    activateDoc(path);
    const editor = createDocEditor(doc);
    if (!editor) {
      throw new Error("图片编辑器不可用。");
    }
    session.savedText = "";
    session.savedJson = "";
    session.view = "imageEdit";
    doc.view = "imageEdit";
    await editor.load(path);
    refreshEditor();
    setMessage(`已打开编辑 ${path}`);
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/**
 * Loads an audio file into the audio editor (clip / concat / speed / fade / gain).
 */
async function openAudioEditor(path) {
  try {
    const doc = ensureDoc(path);
    activateDoc(path);
    const editor = createDocEditor(doc);
    if (!editor) {
      throw new Error("音频编辑器不可用。");
    }
    session.savedText = "";
    session.savedJson = "";
    session.view = "audioEdit";
    doc.view = "audioEdit";
    await editor.load(path);
    refreshEditor();
    setMessage(`已打开编辑 ${path}`);
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/**
 * Loads a visual programming graph into the canvas editor.
 */
async function openGraph(path) {
  try {
    const contents = await actions.read(path);
    const doc = ensureDoc(path);
    activateDoc(path);
    const editor = createDocEditor(doc);
    if (!editor) {
      throw new Error("可视化编辑器不可用。");
    }
    editor.load(path, parseGraph(contents));
    session.view = "graph";
    doc.view = "graph";
    // What was saved is the document as the editor reads it back, not the file's
    // bytes: a file that left fields out is not dirty the moment it is opened.
    doc.savedJson = editor.serialize();
    session.savedJson = doc.savedJson;
    refreshEditor();
    setMessage(`已打开 ${path}`);
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/** Unloads the viewer's picture, so a closed file is not held in memory. */
function clearImage() {
  if (dom.imageImage) {
    dom.imageImage.removeAttribute("src");
    dom.imageImage.alt = "";
  }
  if (dom.imageMeta) {
    dom.imageMeta.textContent = "";
  }
}

/**
 * Closes a tab.
 *
 * The tab asked about is the tab closed, which need not be the one on screen:
 * every cross works on its own tab. Unsaved work is asked about first — losing
 * it silently is a condition a tab strip must not allow — and the stage goes with
 * the script it was started from.
 *
 * @param {string} [path] The document to close; defaults to the active one.
 */
async function closeFile(path = session.openPath) {
  const doc = session.docs.get(path);
  if (!doc) {
    return;
  }
  const isActive = path === session.openPath;
  const dirty = isActive ? isEditorDirty() : isDocDirty(doc);
  if (dirty && !(await confirmDiscard(path))) {
    return;
  }

  const index = session.order.indexOf(path);
  session.order = session.order.filter((item) => item !== path);
  session.docs.delete(path);
  disposeDoc(doc);

  if (!isActive) {
    refreshEditor();
    return;
  }

  discardStage();
  const next = session.order[index] ?? session.order[index - 1] ?? null;
  session.openPath = null;
  session.savedText = "";
  session.savedJson = "";
  syncEditors();
  if (dom.editorText) {
    dom.editorText.value = "";
    updateHighlight();
  }
  clearImage();
  if (next) {
    const opened = activateDoc(next);
    restoreDoc(opened);
    surfaceFor(next);
  }
  refreshEditor();
}

// --- stage ---

/**
 * Which run is the current one. A script with timed statements takes seconds to
 * play out, so a second run can begin while the first is still waiting; the
 * count is what tells the older one to stop where it stands instead of
 * drawing over the stage that replaced it.
 */
let runCount = 0;

/**
 * Points the stage at the style the project names, before a script draws.
 *
 * Which style is current is the manifest's to say, not something to guess from
 * whatever happens to sit in `templates/`: a project may hold several and only
 * the author knows which one it is on. A project naming none is on the runtime's
 * built-in defaults.
 *
 * A file that is not there yet is not reported: a new project names the default
 * style before the integrity check has written it, so every first run would nag
 * about a state that the check is the thing to fix. A missing file simply means
 * the runtime falls back to its built-in defaults.
 *
 * The style is set even when none could be read, because the stage outlives the
 * run that opened it — one an earlier run set has to be taken back off.
 */
async function applyDialogueStyle() {
  const path = session.project?.style ?? "";
  let config = null;
  if (path) {
    try {
      const document = JSON.parse(await actions.read(path));
      if (document && typeof document === "object" && !Array.isArray(document)) {
        config = document;
      }
    } catch {
      config = null;
    }
  }
  stage?.setDialogueStyle(config);
}

/**
 *
 * The editor's current text is used rather than the file on disk, so an
 * unsaved edit is what gets performed. A stage opened by an earlier run is
 * reused: the new script replaces its contents.
 *
 * Statements that take time are waited for, so the run is only over — and only
 * reported — once the script has actually finished playing.
 */
/**
 * Where an `include` path points, in project-relative terms.
 *
 * A bare name such as `chapter1.pe` is read from the project's `scripts/`
 * folder, the same way an asset name is read from `assets/`; anything with a
 * folder in it is taken as the project-relative path it was written as. The
 * backend still refuses an escape (`..`, a drive, an absolute path), so this
 * only decides which spelling means what.
 */
function resolveScenePath(asked) {
  const cleaned = String(asked ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  return cleaned.includes("/") ? cleaned : `scripts/${cleaned}`;
}

/**
 *
 * Shared by running the open file and by playing the project from its entry,
 * so both put the same stage in place, load the project's dialogue style and
 * report the first error the same way.
 *
 * `path` is the script's project-relative name: `include` reads the rest of
 * the project relative to it, and the open editor's text stands in for its own
 * file so an unsaved edit is what a scene plays. A `replay` turns the run into
 * the silent travel a loaded save describes, and `fromDisk` keeps an unsaved
 * editor buffer out of it, since a save only matches the text it was made on.
 */
/**
 * The motion paths the current run may walk, by id.
 *
 * A stage call cannot read a file — `followPath` is synchronous — so every path
 * in `data/` is read before the script starts performing. A run is a fresh look
 * at the project, so this is refilled each time rather than accumulated.
 */
let pathCache = new Map();

/**
 * Every path file in the project, as project-relative names.
 *
 * The project tree already lists them once `data/` exists, so this is a walk of
 * what the host scanned rather than a second directory read.
 *
 * @param {object | null} project
 * @returns {string[]}
 */
function listPathFiles(project) {
  // The walk lives in `project-actions` beside the other tree helpers, so the
  // forest shape is tested in one place instead of re-derived here.
  return listFiles(project, (node) => isPathFile(node.path)).map((node) => node.path);
}

/**
 * Reads every motion path in the project into `pathCache`.
 *
 * A file that cannot be parsed is skipped and named in one message, rather than
 * failing the run: a path is a detail of one move, and a scene should still
 * play with one broken file.
 */
async function loadPaths(project) {
  pathCache = new Map();
  const files = listPathFiles(project);
  const broken = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const parsed = normalizePath(JSON.parse(await actions.read(file)));
        if (parsed) {
          pathCache.set(parsed.id, parsed);
        } else {
          broken.push(file);
        }
      } catch {
        broken.push(file);
      }
    }),
  );
  if (broken.length) {
    setMessage(`这些路径文件读不出来：${broken.join("、")}`, { error: true });
  }
  return pathCache;
}

/**
 * Deletes the path files no script names any more.
 *
 * Called when the project is checked, so `data/` keeps exactly the paths the
 * scripts still use. The scan reads every script rather than only the open one,
 * because a path is named from wherever the move happens to be written.
 */
async function prunePaths(project) {
  if (!project) {
    return;
  }
  const files = listPathFiles(project);
  if (!files.length) {
    return;
  }
  // The scripts are independent files: reading them one at a time made the
  // check wait once per script. Only the joined text is scanned, so the reads
  // go out together; `Promise.all` keeps the order for the join.
  const texts = await Promise.all(
    listScriptFiles(project).map((script) =>
      // A script that cannot be read might have been the one naming a path, so
      // its absence is treated as "still in use" — nothing is deleted for it.
      actions.read(script.path).catch(() => ""),
    ),
  );
  const stale = unreferencedPaths(files, texts.join("\n"));
  for (const file of stale) {
    try {
      await actions.remove(file);
    } catch {
      // Already gone, or refused by the host: either way there is nothing to do.
    }
  }
}

/**
 * Every key frame file in the project, as project-relative names.
 *
 * This is what the visual editor's key frame field offers: the files in `data/`
 * the author can point a `key` node at. Both suffixes are listed, since a
 * project made before the rename still has its animations under `.json`.
 *
 * @returns {string[]}
 */
function listKeyFrameFiles() {
  return listFiles(session.project, (node) => isPathFile(node.path))
    .map((node) => node.path)
    .sort();
}

/** Every `.pe` script in the project, as tree nodes. */
function listScriptFiles(project) {
  return listFiles(project, (node) => node.is_script);
}

/** The motion path editor, built on first use. */
let pathEditor = null;

/**
 * Writes a key frame file to `target`, and answers the path it used.
 *
 * The file is written under the name the editor opened, not under a name
 * derived from the id: an author may have opened `key-ch.keyframes`, and a
 * project made before the rename may still be on `key-ch.json` — either way the
 * animation goes back to the file it came from rather than a second copy
 * appearing beside it.
 *
 * 当需要返回结果时必须提供 `target`；回退取值会掩盖该前提。
 * "whichever key frame tab happens to be open" is how a brand-new animation for
 * one object would be written over the animation of another: the tab that is
 * open has nothing to do with the file being created.
 *
 * @param {object} file The document from `buildPathFile`.
 * @param {string} [target] The project-relative path to write; derived from the
 *   id when omitted, which is only right for a file that has no home yet.
 * @returns {Promise<string>} The path written.
 */
async function savePathFile(file, target = "") {
  const path = target || pathFileFor(file.id);
  await actions.write(path, `${JSON.stringify(file, null, 2)}\n`);
  // The tree lists `data/` once it exists, so a first save has to rescan for
  // the new folder to show up.
  session.project = await reloadProject().catch(() => session.project);
  refreshResourcePanel();
  pathCache.set(file.id, normalizePath(file));
  // The tab's own name follows the file it writes, so a save into an existing
  // `.json` does not leave the tab claiming a `.keyframes` that is not there.
  // Only when this save is the open document's: creating a new file for
  // another object must not rename the tab the author is looking at.
  if (session.keyFile && session.keyFile.path === path) {
    session.keyFile.path = path;
  }
  return path;
}

/**
 *
 * This is what the path editor draws over: the frame the author is shaping is
 * the scene at that moment — the backdrop that is up, the characters that
 * are on, where they stand — not an empty stage. Without it the editor would be
 * asking the author to place a path against a picture that has nothing to do
 * with the one it will play on.
 *
 * The stop is a thrown signal rather than a normal return, because the
 * interpreter is parked on a promise (a line waiting for a click) and has to be
 * unwound from the inside. The signal is caught here, so it never reaches the
 * status bar.
 *
 * @param {string} source The script text.
 * @param {string} file The script's project-relative name.
 * @param {string} objectName The variable whose `key()` is being edited.
 * @returns {Promise<{ found: boolean, error: string | null }>}
 */
/**
 * Travels a script up to the line of `objectName`'s `key()` call, on the stage
 * given, so the editor can draw against the picture the key actually plays on.
 *
 * The stop is a thrown signal rather than a normal return, because the
 * interpreter is parked on a promise (a line waiting for a click) and has to be
 * unwound from the inside. It is caught here, so it never reaches the status bar.
 *
 * @param {object} travelStage The stage to render the journey on — the editor's
 *   own preview stage, not the live performance stage.
 * @param {string} file The script's project-relative name.
 * @param {string} objectName The variable whose `key()` is being edited.
 * @param {{ line?: number, nameStart?: number } | null} [call] The exact call
 *   being edited; one object may key more than once in a script, and the
 *   preview has to stop at the one whose file is open.
 * @returns {Promise<{ found: boolean, error: string | null }>}
 */
async function travelToKey(travelStage, source, file, objectName, call = null) {
  if (!travelStage) {
    return { found: false, error: "舞台不可用" };
  }
  // A stop the interpreter does not know about: it is thrown from `onNode`,
  // which runs between statements, and unwinds `run` before the key is played.
  const STOP = Symbol("stopAtKey");
  // Where the key is, found in the text rather than guessed at from the run:
  // the interpreter reports the line of each statement it is about to execute,
  // so the two line up on the number alone. Matching on the statement's *text*
  const calls = keyCallsIn(source);
  const keyCall =
    (call &&
      (calls.find((entry) => entry.nameStart === call.nameStart && entry.target === objectName) ??
        calls.find((entry) => entry.line === call.line && entry.target === objectName))) ||
    calls.find((entry) => entry.target === objectName);
  const target = keyCall?.line ?? -1;
  let found = false;
  if (target < 0) {
    return { found: false, error: null };
  }
  // A chained `ch.enable().key("f")` puts the key on the same statement as the
  // calls that build the picture. Stopping *before* that statement drops those
  // calls too, and the preview shows an empty stage. `keyCallsIn` gives the
  // exact span of the key call: take just that span out (line numbers do not
  // move), let the rest of the statement run, then stop at the next statement.
  // A plain `ch.key("f")` keeps the old path untouched.
  const lineStart = source.lastIndexOf("\n", keyCall.start - 1) + 1;
  const lineEndAt = source.indexOf("\n", keyCall.end);
  const lineEnd = lineEndAt < 0 ? source.length : lineEndAt;
  const beforeKey = source.slice(lineStart, keyCall.start);
  const afterKey = source.slice(keyCall.end, lineEnd);
  const chained =
    /\.\s*[A-Za-z_$][\w$]*\s*\(/.test(beforeKey) &&
    !/^\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(afterKey);
  const travelSource = chained
    ? source.slice(0, keyCall.start) + source.slice(keyCall.end)
    : source;
  // A preview is a journey to a moment, not a performance: pauses do not hold,
  // lines do not wait for a click, and a question takes its first branch
  // instead of dropping the run. Everything that builds the picture still
  // happens — that picture is the key constraint of the journey.
  travelStage.setPreview(true);
  let result = null;
  try {
    result = await run(travelSource, {
      // The stage owns the type constructors as its own methods; a run needs no
      // second table of factories beside these globals.
      globals: createStageGlobals(travelStage),
      preview: true,
      // `-1` would drop the run, which is how a choice normally ends when the
      // player walks away. Arriving must not depend on a player being here, so
      // the first option is taken and the journey carries on.
      choose: (labels) => Promise.resolve(labels?.length ? 0 : -1),
      source: file,
      readScene: (asked) => actions.read(resolveScenePath(asked)),
      onNode: (_at, statement) => {
        const line = statement?.line;
        if (!Number.isFinite(line)) return;
        if (chained) {
          // The key's own statement still has to run: on a chain it is also
          // the statement that puts the object on stage. Its key call was
          // already removed from `travelSource`, so nothing plays here.
          if (line === target) found = true;
          else if (line > target) {
            found = true;
            throw STOP;
          }
        } else if (line >= target) {
          // `>=` rather than `===`: reaching or passing the key's line means
          // the picture is the one the key plays on. A key inside an untaken
          // branch would otherwise never be reached, and the journey has to
          // end somewhere rather than run the whole scene.
          found = true;
          throw STOP;
        }
      },
    });
  } catch (error) {
    if (error !== STOP) {
      return { found, error: describeError(error) };
    }
  } finally {
    // Turned off as soon as the journey ends: the picture stays as the journey
    // left it, and a later run of the script sets its own mode.
    travelStage.setPreview(false);
  }
  // `run` reports a failure by returning, not by throwing. A script that broke
  // before the key leaves a half-built picture, and saying so is better than
  // showing a scene that never existed.
  if (!found && result?.error) {
    return { found: false, error: result.error.message };
  }
  return { found, error: null };
}

/** Travels the live stage to the key's frame — kept for callers still on it. */
async function stageAtKey(source, file, objectName) {
  return travelToKey(stage, source, file, objectName);
}

/**
 * The text of a script, preferring what is on screen over what is on disk.
 *
 * The preview travel has to see the script the author is looking at: a `key()`
 * call that was just typed is not on disk yet, and a journey through the saved
 * copy would not find it — the stage would be left empty, which reads as "the
 * editor is broken" rather than "this file has not been saved".
 *
 * The order is: the open editor's text, the copy a run has already read, then
 * the file on disk. `null` when none of the three has it.
 *
 * @param {string} path The script, project-relative.
 * @returns {Promise<string | null>}
 */
async function scriptSourceFor(path) {
  if (session.openPath === path && dom.editorText) {
    return dom.editorText.value;
  }
  const read = session.texts?.get(path);
  if (read != null) {
    return read;
  }
  return actions.read(path).catch(() => null);
}

/**
 * Opens a key frame file in its own tab, over the scene it belongs to.
 *
 * A key frame file is a document of its own, so it gets its own tab and the
 * script it belongs to stays open behind it — coming back is switching tabs,
 * not reopening the script. The stage is first travelled to the moment the key
 * plays, so the author draws against the picture they are actually animating;
 * the key's first frame is then the object's own outline where it already
 * stands, which is what makes "the animation starts here" unambiguous.
 *
 * The editor is keyed by the file, not by the object: two objects may name the
 * same animation, and the tab has to say which file it is editing.
 *
 * @param {string} file The key frame file, project-relative.
 * @param {{ objectName?: string, scriptPath?: string, call?: object | null }} [where]
 *   The script, variable and `key()` call the editor was entered from; omitted
 *   when opening the file from the tree.
 */
async function openPathEditor(file, where = {}) {
  if (!stage) {
    setMessage("舞台不可用", { error: true });
    return;
  }
  const path = String(file ?? "");
  const key = idFromPathFile(path) || cleanId(where.objectName ?? "");
  if (!key) {
    return;
  }
  // The file the editor writes back to. A file opened from the tree is the one
  // that exists; one opened from a call that names none gets the default name
  // for the object it animates.
  const target = path || pathFileFor(key);
  let document_ = null;
  try {
    document_ = JSON.parse(await actions.read(target));
  } catch {
    document_ = null;
  }
  if (!document_) {
    setMessage(`${target} 读不出来`, { error: true });
    return;
  }

  // The editor is created before the preview travel, because the travel renders
  // into the editor's own stage — built here, never borrowed from the live one.
  if (!pathEditor) {
    pathEditor = createPathEditor({
      mount: document.getElementById("path-editor-host"),
      onStatus: (message, kind) => setMessage(message, { error: kind === "error" }),
      // The document is written back to the file the editor opened, which is the
      // one its tab names — never to "whichever key frame tab is open".
      onSave: (saved) => savePathFile(saved, session.keyFile?.path ?? ""),
      onClose: () => refreshEditor(),
      // The explicit way back to the script, which is the key constraint of the
      // editor being a tab of its own.
      onBack: () => leavePathEditor(),
      // The editor renders the backdrop and the keyed object into a stage of its
      // own, built over the preview frame it creates — so it never shares the
      // live performance stage, its controls sit outside the picture, and a run
      // of the script never shows the editor's buttons.
      buildStage: (frame, surface) =>
        createStage({
          element: frame,
          surface,
          resolveAsset: (assetPath, kind = "") => assetCache.resolve(assetPath, kind),
          resolveAudio: (assetPath) => soundCache.resolve(assetPath, "Audio"),
          resolveVideo: (assetPath) => videoCache.resolve(assetPath, "Video"),
          onError: (message) => setMessage(message, { error: true }),
          typewriter: session.project?.typewriter || "off",
          resolvePath: (id) => pathCache.get(cleanId(id)) ?? null,
          onMissingPath: (asked) =>
            setMessage(
              `找不到关键帧文件 ${asked || "(未命名)"}，这一步没有做`,
              { error: true },
            ),
          onLine: () => {
            if (playback.isBacklogOpen()) {
              playback.renderBacklog({ stickToEnd: false });
            }
          },
          // The editor draws its outline before the character's bitmap has been
          // decoded, when `objectBox` can only answer the whole frame. Once the
          // real rectangle is known, re-draw it instead of leaving the outline
          // wrong until the author's first drag.
          onObjectBox: () => pathEditor?.refresh(),
        }),
    });
  }

  // A fresh key editor starts from a clean live stage: the scene the author draws
  // against is the editor's own, so the performance stage is cleared rather than
  // left showing the last run behind the editor's preview.
  discardStage();
  if (where.objectName && (where.sceneSource != null || where.scriptPath)) {
    const source =
      where.sceneSource != null ? where.sceneSource : await scriptSourceFor(where.scriptPath);
    if (source != null) {
      const scene = where.sceneSource != null ? where.scriptPath || "map" : where.scriptPath;
      const previewStage = pathEditor.ensureStage();
      previewStage.reset(scene);
      const travelled = await travelToKey(
        previewStage,
        source,
        scene,
        where.objectName,
        where.call ?? null,
      );
      if (travelled.error) {
        setMessage(`预览没能走到该帧：${travelled.error}`, { error: true });
      } else if (!travelled.found) {
        setMessage("没找到这一句，预览停在剧本开头", { error: true });
      }
    }
  }

  // Which object the outline and the first frame are taken from. Resolved here
  // because `load` binds the start to that object's box.
  const objectTarget = where.objectName || key;
  // The editor brings its own chrome (toolbar + key frame dock) in bands outside
  // its preview, so the stage is never asked to make room and never shows the
  // editor's buttons while a script is being performed.
  pathEditor.load(key, document_, objectTarget);
  // The key frame file is now the open document, in a tab of its own. The
  // script stays where it was, so switching between them is not a reload.
  session.keyFile = {
    path: target,
    id: key,
    scriptPath: where.scriptPath ?? session.openPath ?? "",
    objectName: where.objectName ?? key,
    call: where.call ?? null,
  };
  // Opened after the editor is open: the stage is shown because the editor is,
  // so `refreshEditor` has to look at a state where it already is.
  session.view = "stage";
  refreshEditor();
  setMessage(`正在编辑 ${target}`);
}

/**
 * Leaves the key frame editor and returns to the script it was opened from.
 *
 * This is the explicit way back the author asked for. The key frame file is
 * saved first if it has unsaved changes — a back button that silently dropped
 * the animation would be worse than no button — and then the script's own tab
 * comes forward, with the file the key names written into its `key()` call.
 *
 * The key frame tab is not closed: it stays in the strip, so the animation
 * is one click away. What changes is which tab is in front.
 */
async function leavePathEditor() {
  const open = session.keyFile;
  if (!open) {
    return;
  }
  // Saved before leaving: the author is going back to the script, and the
  // animation they just drew is the thing they came to make.
  if (pathEditor?.isDirty()) {
    await pathEditor
      .save()
      .catch((error) => setMessage(`保存关键帧失败：${describeError(error)}`, { error: true }));
  }

  // The call now names the file, so the script says what it plays. Only a call
  // that was entered from the editor is rewritten: opening a file from the tree
  // must not edit a script that no caller selected.
  const call = open.call;
  if (call && open.scriptPath) {
    await fillKeyArgument(open.scriptPath, call, open.path);
  }

  // The editor stays built and its document stays loaded; the stage simply is
  // not the surface in front any more, which is what `session.view` decides.
  // Which surface that is depends on the file the author came from: a script
  // goes back to the code editor, a visual map back to its canvas.
  const back = open.scriptPath;
  if (back && isMapPath(back)) {
    session.view = "graph";
    refreshEditor();
    setMessage(`已回到 ${back}`);
    return;
  }
  session.view = "code";
  const script = back;
  if (script && findNode(session.project, script)) {
    if (session.openPath !== script) {
      // `openFile` would drop the stage (and with it the key frame tab), so the
      // script is read straight in here: the tab the author is coming back from
      // has to survive the trip.
      await loadScriptInPlace(script);
    }
    refreshEditor();
    dom.editorText?.focus();
    setMessage(`已回到 ${script}`);
  } else {
    refreshEditor();
  }
}

/**
 * Loads a script into the code editor without dropping the stage.
 *
 * Used by the trip back from the key frame editor, where the stage is the thing
 * being left rather than a run being abandoned: `openFile` would clear it, and
 * with it the key frame tab the author is returning from.
 *
 * @param {string} path The script, project-relative.
 */
async function loadScriptInPlace(path) {
  try {
    const contents = await actions.read(path);
    session.openPath = path;
    session.savedText = contents;
    session.savedJson = "";
    if (dom.editorText) {
      dom.editorText.value = contents;
    }
    updateHighlight();
    updateGutter();
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/**
 * Writes a key frame file's name into the `key()` call it was opened from.
 *
 * The argument is the file name as it appears in `data/` — `key-ch.keyframes` —
 * because that is what the author sees in the tree and what the runtime reads.
 * An empty `file` clears the argument instead: a key whose path frame was
 * deleted must stop naming a file that is no longer there.
 *
 * The edit is applied to the editor's text and marked dirty rather than written
 * to disk: it is the author's script, and saving it is the author's call.
 *
 * @param {string} scriptPath The script the call is in.
 * @param {object} call The `key()` call from `keyCallsIn`.
 * @param {string} file The key frame file, project-relative; "" clears it.
 */
async function fillKeyArgument(scriptPath, call, file) {
  const name = String(file ?? "").split("/").pop();
  // The open editor's text is the truth when the script is the open one: the
  // author may have unsaved edits, and rewriting the file underneath them would
  // throw those away.
  let source = session.openPath === scriptPath && dom.editorText ? dom.editorText.value : null;
  if (source == null) {
    source = await actions.read(scriptPath).catch(() => null);
  }
  if (source == null) {
    return;
  }
  // Re-scan rather than trusting the offsets: the text may have been edited
  // while the animation was being drawn, and an offset from before that edit
  // would land in the middle of some other call.
  const found =
    keyCallsIn(source).find(
      (entry) =>
        entry.line === call.line &&
        entry.target === call.target &&
        entry.open === call.open &&
        entry.close === call.close,
    ) ??
    keyCallsIn(source).find((entry) => entry.line === call.line && entry.target === call.target);
  if (!found) {
    return;
  }
  const next = name ? withKeyFile(source, found, name) : withoutKeyFile(source, found);
  if (next === source) {
    return;
  }
  if (session.openPath === scriptPath && dom.editorText) {
    // Through the textarea's own value and an `input` event, so the highlight,
    // the dirty mark and the undo stack all see the change.
    const start = dom.editorText.selectionStart;
    dom.editorText.value = next;
    dom.editorText.setSelectionRange(start, start);
    dom.editorText.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    await actions.write(scriptPath, next).catch((error) => {
      setMessage(`写入 ${scriptPath} 失败：${describeError(error)}`, { error: true });
    });
  }
}

/**
 * Makes sure a key frame file exists for an object, and answers its id.
 *
 * A key frame belongs to an object, so the id is the object's own variable name
 * — there is nothing for the author to allocate. A file that already exists is
 * kept as it is; a project written before the rename may have the same file
 * under the old `.json` suffix, which is found rather than duplicated.
 *
 * @param {string} id The object's variable name.
 * @returns {Promise<string>}
 */
async function ensurePathFile(id) {
  const wanted = cleanId(id);
  if (!wanted) {
    return "";
  }
  const existing = findKeyFile(wanted);
  if (existing) {
    return wanted;
  }
  // Named explicitly: this is a file being created, not the one any open tab is
  // showing, and writing to the open tab would overwrite another animation.
  await savePathFile(
    buildPathFile({ id: wanted, start: { x: 0, y: 0 }, segments: [] }),
    pathFileFor(wanted),
  );
  return wanted;
}

/**
 * The file an object's key frame already lives in, or "" when it has none.
 *
 * The new suffix is preferred; the old `.json` name is found too, so a project
 * made before the rename keeps one file rather than gaining a second one with
 * the same content.
 *
 * @param {string} id The object's variable name.
 * @returns {string} A project-relative path, or "".
 */
function findKeyFile(id) {
  for (const suffix of KEYFRAMES_SUFFIXES) {
    const file = `${PATHS_DIR}/key-${cleanId(id)}${suffix}`;
    if (findNode(session.project, file)) {
      return file;
    }
  }
  return "";
}

/**
 * Opens the key frame of an object from the visual editor.
 *
 * The node's own field holds the object's name, so the flow is: make sure a file
 * exists, record the name on the node, then open the editor over the scene at
 * that point in the graph. The node's own `file` field is what the generated
 * script writes as the argument, so the file name is written there too.
 *
 * The scene is travelled through the compiled script, not through the file
 * on disk: the open document is a `.flowmap`, and reading that as a script
 * finds no `key()` call at all — the stage would be left empty, which is the
 * "editor is black" the author sees. Compiling in memory is the same code the
 * 生成 button runs, so the preview is the scene the canvas would play.
 */
async function editGraphNodePath(node) {
  if (!session.project || !graphEditor) {
    return;
  }
  const id = await ensurePathFile(graphEditor.pathOfNode(node.id));
  if (!id) {
    setMessage("这个节点还没有对象名，先给它起个名字", { error: true });
    return;
  }
  const file = findKeyFile(id) || pathFileFor(id);
  graphEditor.assignPath(node.id, id, file);
  const scene = mapScriptText();
  await openPathEditor(file, {
    objectName: id,
    // The file to restore is the map; the scene to draw is the script it
    // compiles to.
    scriptPath: session.openPath,
    sceneSource: scene,
  });
}

/**
 * The script the open visual map compiles to, or `null` when there is none.
 *
 * Read off the live canvas, so a node the author just added is part of the
 * scene the key frame editor draws over.
 *
 * @returns {string | null}
 */
function mapScriptText() {
  if (!graphEditor) {
    return null;
  }
  try {
    return inferGraph(parseGraph(graphEditor.serialize()));
  } catch {
    // A canvas that cannot be serialised is one the preview has nothing to
    // travel through; the editor still opens, over whatever the stage holds.
    return null;
  }
}

/**
 * Opens the key frame of an object from a `key()` call in the script editor.
 *
 * The call names the object — `ch.key()` — and may already name the file —
 * `ch.key("key-ch.keyframes")`. A call that names one opens that file; one that
 * does not opens the object's default file, creating it if need be, and the
 * argument is filled in when the editor is left. The script is travelled to that
 * statement so the editor draws over the scene the key plays in, and the
 * object's own position there is the key's first frame.
 *
 * @param {{ target: string, file?: string }} call A call from `move-calls.js`.
 */
async function editCodeKey(call) {
  if (!session.project) {
    return;
  }
  const id = cleanId(call?.target);
  if (!id) {
    return;
  }
  // A call that names a file opens exactly that file, even one with a name the
  // object's own default would not produce. A call that names none gets the
  // object's own default, created here if it is not there yet.
  const asked = idFromKeyArgument(call?.file ?? "");
  const target = asked ? pathFileFromArgument(call.file) : "";
  // A call that names a file which exists opens it; one that names a file that
  // does not exist yet is authored at that name (the author asked for it).
  let file = target && findNode(session.project, target) ? target : "";
  if (!file && target) {
    await savePathFile(
      buildPathFile({ id: idFromPathFile(target) || id, start: { x: 0, y: 0 }, segments: [] }),
      target,
    );
    file = target;
  }
  if (!file) {
    await ensurePathFile(id);
    file = findKeyFile(id) || pathFileFor(id);
  }
  await openPathEditor(file, { objectName: id, scriptPath: session.openPath, call });
}

/**
 * The key frame file a `key()` call already names, or "" when it names none.
 *
 * "Bound" means the argument names a file that is actually there. A call whose
 * argument points at nothing is not a key with a path frame, so the edit and
 * delete entries stay dimmed rather than promising an action with nothing
 * behind it.
 *
 * @param {{ file?: string }} call A call from `move-calls.js`.
 * @returns {string} The project-relative file, or "".
 */
function boundKeyFile(call) {
  const asked = String(call?.file ?? "").trim();
  if (!asked || !session.project) {
    return "";
  }
  const path = pathFileFromArgument(asked);
  return path && findNode(session.project, path) ? path : "";
}

/**
 * Creates the path frame a `key()` call has not been bound to yet.
 *
 * Each `key()` call owns one file, so a new frame is only made for a call that
 * names none. The name follows the object and the script it is keyed in —
 * `ch-main-pe-1` — and the index is the lowest one no file uses: deleting
 * `…-2` leaves `…-1` and `…-3` untouched, and the next file takes `…-2`.
 *
 * @param {{ target: string, line: number, nameStart: number }} call The key
 *   call the menu was opened on.
 */
async function newCodeKeyFrame(call) {
  const script = session.openPath;
  if (!session.project || !script || !isScriptPath(script) || !dom.editorText) {
    return;
  }
  const objectName = cleanId(call?.target);
  if (!objectName) {
    return;
  }
  if (boundKeyFile(call)) {
    setMessage("这个 key 已经绑定了路径帧");
    return;
  }
  const stem = keyFrameStemFor(objectName, script);
  if (!stem) {
    return;
  }
  const ids = listKeyFrameFiles().map((path) => idFromPathFile(path)).filter(Boolean);
  const id = `${stem}-${freeKeyFrameIndex(stem, ids)}`;
  const file = orderedPathFileFor(id);
  await savePathFile(buildPathFile({ id, start: { x: 0, y: 0 }, segments: [] }), file);
  // Bound before the editor opens: the file exists now, and the tab it opens
  // is the one the script names.
  await fillKeyArgument(script, call, file);
  const bound = keyCallAt(dom.editorText.value, call.nameStart) ?? call;
  await openPathEditor(file, { objectName, scriptPath: script, call: bound });
}

/**
 * Deletes the path frame a `key()` call names.
 *
 * The file goes with it — that is what "delete the path frame" means — and the
 * call stops naming it, so the script never points at a file that is gone. A
 * tab showing the deleted file is closed first; keeping it would let its next
 * save write the file back.
 *
 * @param {{ target: string, line: number, file?: string }} call The key call
 *   the menu was opened on.
 */
async function deleteCodeKeyFrame(call) {
  const script = session.openPath;
  const file = boundKeyFile(call);
  if (!script || !file) {
    return;
  }
  const name = splitPath(file).name;
  if (promptConfirm) {
    const confirmed = await promptConfirm({
      title: "删除路径帧？",
      body: `${name} 会被永久删除，这个 key 也不再指向它。`,
      confirmLabel: "删除",
    });
    if (!confirmed) {
      return;
    }
  }
  if (session.keyFile?.path === file) {
    pathEditor?.close();
    session.keyFile = null;
    session.view = "code";
  }
  try {
    await actions.remove(file);
  } catch (error) {
    setMessage(`删除 ${name} 失败：${describeError(error)}`, { error: true });
    return;
  }
  pathCache.delete(idFromPathFile(file));
  await fillKeyArgument(script, call, "");
  session.project = await reloadProject().catch(() => session.project);
  refreshResourcePanel();
  refreshEditor();
  setMessage(`已删除 ${name}`);
}

/**
 * The caret offset a pointer position falls on in the script editor.
 *
 * The textarea cannot be asked where a character is, so the highlight layer
 * behind it is measured instead: it carries the same text in the same font at
 * the same size, so an offset into one is an offset into the other.
 *
 * @returns {number} The offset, or -1 when the layers cannot be measured.
 */
function editorOffsetAt(clientX, clientY) {
  const layer = dom.editorHighlight;
  const text = dom.editorText?.value ?? "";
  if (!layer || !text) {
    return -1;
  }
  // The highlight layer is built as HTML, so its text is spread over one node
  // per coloured run — not one node for the whole script. An offset therefore
  // has to be walked to the node that actually holds that character; handing a
  // whole-file offset to the first node would clamp it to that node's length
  // and measure every position as the same spot.
  const spots = textNodesOf(layer);
  const lengths = spots.map((spot) => spot.length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!total) {
    return -1;
  }
  const measure = (offset) => {
    const where = splitOffset(lengths, offset);
    const spot = spots[where.index];
    const range = document.createRange();
    range.setStart(spot.node, Math.min(where.offset, spot.length));
    range.collapse(true);
    return range.getBoundingClientRect();
  };
  try {
    return offsetAtPoint(measure, total, clientX, clientY);
  } catch {
    // A layer that cannot be measured (no text node, or a range the browser
    // refuses) simply offers no menu rather than throwing on a right-click.
    return -1;
  }
}

/**
 * Every text node under an element, in document order.
 *
 * The highlight layer's text is one node per coloured run, so a whole-file
 * offset is an offset into the concatenation of these.
 *
 * @param {Node} element
 * @returns {{ node: Text, length: number }[]}
 */
function textNodesOf(element) {
  const spots = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 3) {
        if (child.length > 0) {
          spots.push({ node: child, length: child.length });
        }
      } else {
        walk(child);
      }
    }
  };
  walk(element);
  return spots;
}

/**
 * The box of a character range, in the editor's content coordinates.
 *
 * Measured off the highlight layer instead of computed from a character width:
 * the editor is set in a proportional face (`--pamela-editor-font`), so a column
 * is not a fixed number of pixels and `column * charWidth` only lands on the
 * right glyph by luck. The layer carries the same text in the same font at the
 * same size as the textarea, so a `Range` over it is the glyphs' own box.
 *
 * The result is in the pane's coordinates *before* scrolling — the find and
 * error layers are translated by the scroll themselves, and the drop box
 * subtracts it. The painted layer is translated by the textarea's scroll, so a
 * measured box already has the scroll in it: the textarea's offset is added back
 * to undo that, which also keeps the measurement independent of how far the
 * layer itself could scroll.
 *
 * @param {number} start Offset of the first character.
 * @param {number} end Offset just past the last one.
 * @returns {{ left: number, top: number, width: number, height: number } | null}
 *   `null` when there is nothing to measure: a hidden editor, an empty layer, or
 *   a range the webview refuses. Callers fall back to their own arithmetic.
 */
function editorRangeRect(start, end) {
  const layer = dom.editorHighlight;
  const pane = dom.editorPane;
  if (!layer || !pane) {
    return null;
  }
  const spots = textNodesOf(layer);
  const lengths = spots.map((spot) => spot.length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!total) {
    return null;
  }
  const from = Math.min(Math.max(0, Math.trunc(Number(start) || 0)), total);
  const to = Math.min(Math.max(from, Math.trunc(Number(end) || 0)), total);
  const point = (offset) => {
    const where = splitOffset(lengths, offset);
    const spot = spots[where.index];
    return { node: spot.node, offset: Math.min(where.offset, spot.length) };
  };
  try {
    const a = point(from);
    const b = point(to);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const box = range.getBoundingClientRect();
    const base = pane.getBoundingClientRect();
    const scrollLeft = dom.editorText?.scrollLeft ?? 0;
    const scrollTop = dom.editorText?.scrollTop ?? 0;
    return {
      left: box.left - base.left + scrollLeft,
      top: box.top - base.top + scrollTop,
      width: box.width,
      height: box.height,
    };
  } catch {
    return null;
  }
}

/**
 * The offset of the first character of a 0-based line.
 *
 * @param {string} text
 * @param {number} line
 * @returns {number}
 */
function offsetOfLine(text, line) {
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    const next = text.indexOf("\n", offset);
    if (next === -1) {
      return text.length;
    }
    offset = next + 1;
  }
  return offset;
}

/**
 * The right-click menu for a `font()` call in the script editor.
 *
 * The list is the machine's own families, read through the backend, so a face
 * the author sees in another application can be named in the script exactly as
 * that application spells it. Picking one rewrites the call's single argument;
 * the script keeps a name, never a copy of the font file.
 *
 * The menu opens asynchronously because the list comes over IPC. The caller
 * has already decided that the click was on a font call — that part is worked
 * out synchronously — so this only has to fill the menu in.
 */
async function openFontMenu(detail, call) {
  let families;
  try {
    families = (await actions.listFonts?.()) ?? [];
  } catch (error) {
    setMessage(`读取本机字体失败：${describeError(error)}`, { error: true });
    return;
  }
  const current = String(call.family ?? "").trim();
  const items = [
    // The empty command is the default pair: JetBrains Mono for Western text,
    // 思源黑体 for Chinese. It clears the argument rather than naming a face.
    { label: "默认字体（思源黑体 / JetBrains Mono）", command: "" },
    { separator: true },
  ];
  for (const family of families) {
    items.push({
      label: family === current ? `✓ ${family}` : family,
      command: family,
      // The row previews the face it names: the same stack a Text would draw
      // with, sample text and all, so the list shows the style rather than a
      // name the author has to recognise.
      fontFamily: textFontStack(family),
      sample: "示例字体Abc",
    });
  }
  if (!families.length) {
    items.push({ label: "没有找到本机字体", disabled: true });
  }
  const picked = await openContextMenu({ x: detail.x, y: detail.y, items });
  if (picked === null) {
    return;
  }
  applyFontToCall(call, picked);
}

/**
 * Writes a picked family into the `font()` call it was picked for.
 *
 * The text is re-scanned rather than trusting the offsets from before the menu
 * opened: the author may have typed while the list was up, and an offset from
 * before that edit would land in the middle of another call. The change goes
 * through the textarea's value and an `input` event, so the highlight, the
 * dirty mark and the undo stack all see it.
 *
 * @param {object} call The font call the menu was opened on.
 * @param {string} family The family to write; "" restores the default pair.
 */
function applyFontToCall(call, family) {
  if (!dom.editorText) {
    return;
  }
  const source = dom.editorText.value;
  const calls = fontCallsIn(source);
  const found =
    calls.find(
      (entry) =>
        entry.line === call.line &&
        entry.target === call.target &&
        entry.open === call.open &&
        entry.close === call.close,
    ) ?? calls.find((entry) => entry.line === call.line && entry.target === call.target);
  if (!found) {
    return;
  }
  const next = withFontFamily(source, found, family);
  if (next === source) {
    return;
  }
  const start = dom.editorText.selectionStart;
  dom.editorText.value = next;
  dom.editorText.setSelectionRange(start, start);
  dom.editorText.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The script editor's own right-click menu: a `font()` first, then a `key()`.
 *
 * A font call is checked first because its menu is the narrower target — a
 * `font()` argument is one family name, while `key()` has a same-line fallback
 * that would otherwise claim a click near either call.
 *
 * The key menu's three entries are about one file. 新建路径帧 is live only while the call
 * names none; 编辑 / 删除 are live only once it names an existing file, so a
 * dimmed entry always means "this key has nothing there yet" rather than an
 * action that would create a file behind the author's back.
 *
 * Answers whether a menu was opened, so the caller can fall back to the
 * resource panel's menu when the click was not on a key. The answer is worked
 * out synchronously — the fall-through decision cannot wait on a promise —
 * so only the menu itself, and whatever it then runs, is asynchronous.
 */
function onEditorKeyContextMenu(detail) {
  if (!dom.editorText || !dom.editorCode || dom.editorCode.hidden) {
    return false;
  }
  const target = detail.target;
  if (!(target instanceof Element) || !dom.editorCode.contains(target)) {
    return false;
  }
  const offset = editorOffsetAt(detail.x, detail.y);
  if (offset < 0) {
    return false;
  }
  const source = dom.editorText.value;
  // A `font()` under the pointer is its own menu; the font list comes over IPC,
  // so only the decision is made here, synchronously.
  const font = fontCallAt(source, offset);
  if (font) {
    void openFontMenu(detail, font);
    return true;
  }
  const call = keyCallAt(source, offset);
  if (!call) {
    return false;
  }

  // A key owns exactly one path frame: a call that already names a file cannot
  // make another, and a call that names none has nothing to edit or delete.
  const bound = boundKeyFile(call);
  const canCreate =
    !bound &&
    isScriptPath(session.openPath) &&
    Boolean(keyFrameStemFor(call.target, session.openPath));
  const canChange = Boolean(bound);
  openContextMenu({
    x: detail.x,
    y: detail.y,
    items: [
      { label: "新建路径帧", command: "editor.newPathFrame", disabled: !canCreate },
      { label: "编辑路径帧", command: "editor.editPathFrame", disabled: !canChange },
      { label: "删除路径帧", command: "editor.deletePathFrame", disabled: !canChange },
    ],
  })
    .then((command) => {
      if (command === "editor.newPathFrame") {
        return newCodeKeyFrame(call);
      }
      if (command === "editor.editPathFrame") {
        return editCodeKey(call);
      }
      if (command === "editor.deletePathFrame") {
        return deleteCodeKeyFrame(call);
      }
      return undefined;
    })
    .catch((error) => setMessage(describeError(error), { error: true }));
  return true;
}

/**
 * Performs a script, closing the stage tab when the run — or the stage itself —
 * breaks.
 *
 * A throw anywhere after the run claimed the stage used to leave `running` and
 * `stageName` set with nobody left to clear them: the tab stayed on the strip
 * and the next run started on top of a half-dead stage. Reporting and tearing
 * down here means every exit, including a crashed stage, cleans up.
 */
async function performScript(source, options) {
  try {
    await performScriptOnStage(source, options);
  } catch (error) {
    // Reporting must not be able to strand the tab either: close it whether
    // the bubble could be drawn or not.
    try {
      reportScriptError(error, { path: options?.path });
    } finally {
      closeStage();
    }
  }
}

async function performScriptOnStage(source, { path, name, replay = null, fromDisk = false }) {
  if (!stage) {
    setMessage("舞台不可用", { error: true });
    return;
  }
  // A run draws on the stage, which the reader is covering; starting one leaves
  // the reader rather than playing behind an article.
  readerPanel.leave({ repaint: false });

  // A `.mpe` script is compiled to `.pe` before anything reads it — including
  // the text still open in the editor, so an unsaved shorthand edit plays as it
  // would after saving. The compile keeps the line count, so every line number
  // the run reports is the line the author wrote. `source` itself stays as
  // written: what a save fingerprints is the file, not the compiled form.
  const program = isMpePath(path) ? transpile(source) : source;

  // The manifest's typewriter mode is the run's fallback, not just what the
  // settings panel last picked: a project opened with 慢速 must play slowly
  // without anyone opening 设置 first. A style file naming its own
  // `text.typeSpeed` still wins for the lines it styles.
  stage.setTypewriter(session.project?.typewriter || "off");

  // Claimed before anything is awaited: reading the project's style is a file
  // read, and a run that is still parked on a line would otherwise be able to
  // wake up and draw into the stage this one has just reset. The session says
  // a run is on from here too, so 停止运行 during the read is not a no-op.
  const token = (runCount += 1);
  const title = name ?? "演出";
  session.running = true;
  session.stageName = title;
  session.view = "stage";
  session.root = path;
  session.node = null;
  session.choices = [];
  // Whether the run raised anything of its own — a `key()` with no readable
  // file, an asset that would not load. Those are reported as they happen, and
  // the run's closing "已运行" must not be allowed to cover them up.
  runTrouble = false;
  // Performing a script is not editing a path: close the key frame editor's
  // overlay so its controls never appear over the running stage. The tab stays
  // in the strip, so the animation is one click away again; unsaved work is
  // saved first so the trip never loses it.
  if (pathEditor?.isOpen()) {
    if (pathEditor.isDirty()) {
      await pathEditor
        .save()
        .catch((error) => setMessage(`保存关键帧失败：${describeError(error)}`, { error: true }));
    }
    pathEditor.close();
  }
  // A run is a fresh look at the project: the author may have replaced a
  // picture since the last one, and a cached `data:` URL would show the old
  // file. Within the run, nothing on disk can change under the script.
  clearAssetCache();
  stage.reset(title);
  // A new run starts with the menu's own state, not the previous run's — and
  // with no backlog from the run before it.
  closeSlots();
  playback.toggleBacklog(false);
  playback.refreshMenu();
  // In place before the first line is drawn, so the script performs on the
  // project's own style rather than on the runtime's defaults.
  await applyDialogueStyle();
  // The paths this run may walk. Read here rather than on demand because
  // `followPath` is a synchronous stage call, and a run must not stall mid-line.
  await loadPaths(session.project);
  // Stopped while the style or the paths were being read: there is nothing left
  // to perform.
  if (token !== runCount) {
    return;
  }
  // The root script's text is known already; `include` adds the rest as it
  // reads them, so a save knows every script the run walked through.
  session.texts = new Map([[path, source]]);
  // A replay travels silently and instantly; the interpreter turns the flag
  // off at the node it reaches, through `onLive`.
  stage.setReplay(Boolean(replay));
  refreshEditor();

  // One cache per run: a scene included twice plays twice, but its text is read
  // once. The file being run answers with the editor's text, not the disk copy.
  const scenes = new Map();
  const readScene = (asked) => {
    const resolved = resolveScenePath(asked);
    if (!fromDisk && resolved === session.openPath) {
      session.texts.set(resolved, source);
      return Promise.resolve(program);
    }
    if (!scenes.has(resolved)) {
      const loading = actions.read(resolved).then((text) => {
        // Remembered as read, so a save can say what the script looked like —
        // the file's own text, which is what the fingerprint is taken over.
        session.texts.set(resolved, text);
        // An included shorthand file is compiled here, once per run: the
        // interpreter's `include` only ever sees the full syntax.
        return isMpePath(resolved) ? transpile(text) : text;
      });
      scenes.set(
        resolved,
        loading.catch((error) => {
          scenes.delete(resolved);
          throw error;
        }),
      );
    }
    return scenes.get(resolved);
  };

  let result;
  try {
    result = await run(program, {
      // The stage owns every call that is not made on an object — the narrator,
      // the batch calls and the type constructors — so its globals are the only
      // runtime channel a script needs.
      globals: createStageGlobals(stage),
      // A `choice` block asks the stage to put its options up and hands back the
      // index the player picked; the language never touches the DOM itself.
      choose: (labels) => stage.choose(labels),
      // `include` reads the rest of the project through the same guarded file
      // command every other read uses; the language never sees a path on disk.
      readScene,
      // `use` switches the dialogue style mid-run: the host reads the named file
      // and applies it, so the rest of the script performs in a different box.
      useStyle: async (path) => {
        let config;
        try {
          const document = JSON.parse(await actions.read(path));
          if (!document || typeof document !== "object" || Array.isArray(document)) {
            throw new Error("不是合法的对象");
          }
          config = document;
        } catch (error) {
          throw new Error(`读不到或解析不了样式 ${path}：${error instanceof Error ? error.message : String(error)}`);
        }
        stage?.setDialogueStyle(config);
      },
      source: path,
      stopped: () => token !== runCount,
      // What a save is made of: the node the run stands on and the answers it
      // has taken. Both reach the editor from here; the stage never reads a
      // script position.
      onNode: (node) => {
        session.node = node;
        // The run has moved to another statement, so whether it can be saved
        // from may have changed with it.
        playback.refreshMenu();
      },
      onChoice: (answer) => {
        session.choices.push({ key: nodeKey(answer.file, answer.path), picked: answer.picked });
      },
      replay,
      onLive: () => stage.setReplay(false),
    });
  } finally {
    // However the run ends, the stage stops replaying: a save that matched no
    // node must not leave the next run silent.
    if (token === runCount) {
      stage.setReplay(false);
    }
  }
  // A newer run has taken over the stage; its own result speaks for it.
  if (token !== runCount) {
    return;
  }
  session.running = false;
  refreshMenuContext();
  if (result.stopped) {
    // The run was dropped on purpose — a newer run started, or the author
    // pressed 停止运行. Saying so would only be visual clutter on top of that.
    return;
  }
  if (result.error) {
    // 跳转到出错脚本标签、高亮行，并在右下角弹出常驻红气泡。
    reportScriptError(result.error, { path });
    // 出错的演出没有留在标签条上的意义：关掉它并复位运行态，下一次运行
    // 才会从一个干净的舞台开始，而不是撞上这次留下的半清理状态。
    closeStage();
    return;
  }
  if (result.replayMissed) {
    // The replay never met its node: the script has changed since the save,
    // or the save names another script. Either way the position is gone.
    setMessage("存档与当前剧本对不上：没有走到存档记录的位置", { error: true });
    return;
  }
  // A message the run itself raised — a `key()` whose file cannot be read, an
  // image that would not load — is the reason the scene looked wrong, and
  // saying "已运行" over the top of it hides exactly what the author needs to
  // 成功提示表示无错误，因此错误报告优先于成功提示。
  if (runTrouble) {
    return;
  }
  setMessage(replay ? "已从存档继续" : `已运行 ${path ?? "脚本"}`);
}

/**
 * 在编辑器里高亮某一行（整行红色背景）并滚动到可见位置。
 *
 * 复用语法错误下划线的同一套坐标：错误层随文本滚动整体平移，所以这里只按
 * 内容坐标落一个整行标记即可跟着滚。行号从 1 开始。
 *
 * @param {number} line 1-based 行号。
 * @returns {boolean} 编辑器可见且已高亮时为 true。
 */
function revealErrorLine(line) {
  const inner = dom.editorErrorInner;
  const text = dom.editorText;
  if (!inner || !text || !dom.editorCode || dom.editorCode.hidden) {
    return false;
  }
  const styles = getComputedStyle(text);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 20.8;
  const padTop = Number.parseFloat(styles.paddingTop) || 12;
  const row = Math.max(0, Math.trunc(line) - 1);
  // 把出错行滚到编辑区中部，便于对照上下文。
  text.scrollTop = Math.max(0, padTop + row * lineHeight - text.clientHeight / 2);
  // 清掉上一次的运行期高亮，避免与语法下划线混淆。
  inner.querySelectorAll(".editor__run-error").forEach((node) => node.remove());
  const mark = document.createElement("span");
  mark.className = "editor__run-error";
  mark.style.top = `${padTop + row * lineHeight}px`;
  mark.style.left = "0px";
  mark.style.width = `${text.scrollWidth || text.clientWidth}px`;
  mark.style.height = `${lineHeight}px`;
  inner.append(mark);
  syncErrorScroll();
  return true;
}

/**
 * 跳转到出错脚本的标签并高亮出错行；文件未打开时先按路径读盘打开。
 *
 * @param {string} path 脚本路径（项目内相对路径）。
 * @param {number} line 1-based 行号。
 */
async function revealErrorInScript(path, line) {
  if (!path) {
    return;
  }
  try {
    await openFile(path);
  } catch {
    // 文件读不到（例如已被删除）：高亮失败也不应阻塞错误报告本身。
  }
  revealErrorLine(line);
}

/**
 * 运行或导出出错时的统一处理：跳转到出错脚本标签、高亮行、右下角弹出常驻红气泡。
 *
 * @param {unknown} error
 * @param {{ path?: string }} [context] 当前脚本路径（导出时多为入口脚本）。
 */
function reportScriptError(error, { path } = {}) {
  const info = classifyError(error);
  const target = info.file || path;
  if (target && info.line) {
    void revealErrorInScript(target, info.line).catch(() => {});
  } else if (target) {
    // Reporting an error must not raise an unhandled rejection of its own: the
    // run's teardown is still waiting behind it, and a broken report used to
    // strand the stage tab on the strip.
    void openFile(target).catch(() => {});
  }
  const where = info.line ? `第 ${info.line} 行` : "";
  const heading = info.file && info.file !== path ? `运行出错 · ${info.file}` : "运行出错";
  const detail = where ? `${where}：${info.message}` : info.message;
  pushErrorBubble({
    heading,
    detail,
    actions:
      target && info.line
        ? [{ label: "定位到行", onClick: () => void revealErrorInScript(target, info.line) }]
        : [],
  });
  setMessage(detail, { error: true });
}

/**
 * Reads a project-relative file from disk and performs it on the stage.
 */
async function runFileOnDisk(filePath) {
  const source = await actions.read(filePath);
  await performScript(source, { path: filePath, name: stageNameFor(filePath) });
}

/**
 * Compiles a `.flowmap` into `scripts/p_<name>.pe`.
 *
 * The generated file goes to the script directory (剧本目录); if it already
 * exists there the user must confirm overwriting. Returns the output path, or
 * `null` when generation was skipped (conflict or error).
 *
 * @returns {Promise<string | null>}
 */
async function generatePamelaFromMap(mapPath) {
  try {
    // 读取画布内容前需确保其编辑已提交。
    if (session.view === "graph" && session.openPath === mapPath && graphEditor?.dirty) {
      await graphEditor.save();
    }
    const contents = await actions.read(mapPath);
    const graph = parseGraph(contents);
    const code = inferGraph(graph);
    // The map's own stem, whatever suffix it was opened under: a project made
    // before the rename still produces `p_<name>.pe`, not `p_<name>.pamela`.
    const base = mapPath
      .split("/")
      .pop()
      .replace(/\.(?:flowmap|pmap)$/i, "");
    const outPath = joinPath("scripts", `p_${base}${SCRIPT_SUFFIX}`);
    if (findNode(session.project, outPath)) {
      const ok = await confirmDialog({
        title: "命名冲突",
        body: `${outPath} 已存在，是否覆盖？`,
        confirmLabel: "覆盖",
        cancelLabel: "取消",
      });
      if (!ok) {
        setMessage("已取消生成（命名冲突）", { error: true });
        return null;
      }
    }
    await actions.write(outPath, code);
    await refreshTree();
    setMessage(`已生成 ${outPath}`);
    return outPath;
  } catch (error) {
    setMessage(describeError(error), { error: true });
    return null;
  }
}

/**
 * Runs a `.flowmap` file: compile it to `scripts/p_<name>.pe`, open that, then
 * play it.
 */
async function runMap(mapPath) {
  if (!stage) {
    setMessage("舞台不可用", { error: true });
    return;
  }
  const outPath = await generatePamelaFromMap(mapPath);
  if (!outPath) {
    return;
  }
  await openFile(outPath);
  await runFileOnDisk(outPath);
}

/**
 * Starts a run according to the toolbar strategy.
 *
 * - `entry`  : always the project's `main` script.
 * - `current`: the open file. A `.flowmap` is compiled first and a `.mpe` is
 *              compiled to `.pe` on the way in; anything that is neither a
 *              script nor a `.flowmap` is refused.
 */
async function runPlay() {
  if (runStrategy === "entry") {
    await runEntryScript();
    return;
  }
  if (!session.openPath) {
    setMessage("没有打开文件，无法运行", { error: true });
    return;
  }
  if (isMapPath(session.openPath)) {
    await runMap(session.openPath);
    return;
  }
  if (!isScriptPath(session.openPath)) {
    setMessage(
      `当前文件不是脚本（${SCRIPT_SUFFIX} / ${SHORT_SCRIPT_SUFFIX}）或 ${MAP_SUFFIX}，不能运行`,
      { error: true },
    );
    return;
  }
  if (session.view === "code" && dom.editorText && !dom.editorText.hidden) {
    await performScript(dom.editorText.value, {
      path: session.openPath,
      name: stageNameFor(session.openPath),
    });
  } else {
    await runFileOnDisk(session.openPath);
  }
}

/**
 * Plays the project from its entry script, the way a player would.
 *
 * No open file is involved: the entry named in `pamela.json` is read from disk,
 * and `include` inside it brings in whatever scenes it chains together. A
 * manifest that names no entry — or one whose file is gone — falls back to the
 * `scripts/main.*` convention. This is the first entry point that plays a whole
 * project rather than the one file in the editor.
 */
async function runEntryScript() {
  if (!session.project) {
    setMessage("没有打开项目", { error: true });
    return;
  }
  const entry = resolveEntry(session.project).path;
  if (!entry) {
    setMessage("项目里还没有脚本", { error: true });
    return;
  }
  try {
    const source = await actions.read(entry);
    await performScript(source, { path: entry, name: stageNameFor(entry) });
  } catch (error) {
    reportScriptError(error, { path: entry });
  }
}

/**
 * 选择支策略：默认由语言层固定第一项，`recorded` 沿用最近一次演出的答案。
 *
 * 记录是「按遇到顺序」的序号列表（`session.choices`，与存档重放同源）。导出
 * 与那次演出从同一个入口脚本出发，遇到同一个选择支的顺序也就相同；记录用完、
 * 越界或那次演出根本没走到这里时回落到第一项，而不是报错停下。
 *
 * @param {string} mode `first` / `recorded`
 * @returns {((labels: string[]) => Promise<number>)|undefined}
 */
function choiceStrategyFor(mode) {
  if (mode !== "recorded") {
    return undefined;
  }
  const picked = (session.choices ?? [])
    .map((choice) => Number(choice.picked))
    .filter((index) => Number.isInteger(index) && index >= 0);
  let cursor = 0;
  return (labels) => {
    const index = picked[cursor];
    cursor += 1;
    return Promise.resolve(index !== undefined && index < (labels?.length ?? 0) ? index : 0);
  };
}

/** The one export panel; running the command again only reports it is open. */
let exportPanel = null;

/**
 * 打开导出浮窗，再按浮窗里选的参数导出一段 MP4。
 *
 * 它不占用 DOM 舞台：解释器在虚拟时钟下逐帧推进，画面由离屏 Canvas2D 后端
 * 绘制，编码结果经流式写盘命令落到项目内的 exports/。音轨暂不参与（见内置
 * 帮助「导出 MP4」里的边界），选择支可选「固定第一项」或「按上次运行」。
 *
 * 入口脚本可以在浮窗里换：同一个项目的多个场景各导一段，不必改 pamela.json
 * 的入口。参数会经 `lifecycle` 写进偏好文件，下次打开不用重选。
 *
 * 浮窗本身只负责问参数和报进度，导出仍在 `runExport` 里发生；两者之间只传
 * 一个 config 和一个可取消的会话句柄，所以「取消」能在帧与帧之间停下来。
 */
async function exportMp4() {
  if (exportPanel?.isOpen()) {
    setMessage("导出面板已经打开");
    return;
  }
  if (!session.project) {
    setMessage("没有打开项目", { error: true });
    return;
  }
  const manifestEntry = resolveEntry(session.project).path;
  if (!manifestEntry) {
    setMessage("项目里还没有脚本", { error: true });
    return;
  }
  if (!invokeBridge) {
    setMessage("后端未连接，无法导出。", { error: true });
    return;
  }

  const projectName = session.project.name;
  const scripts = listScriptFiles(session.project).map((node) => node.path);
  /** 正在跑的导出会话；浮窗上的「取消导出」通过它叫停帧循环。 */
  let exporting = null;
  /** 准备阶段（读脚本、预解码）没有会话可叫停，先把意图记下来。 */
  let cancelRequested = false;

  const panel = createExportPanel({
    entries: scripts,
    defaultName: (entry) => defaultNameForEntry(projectName, entry),
    preferences: lifecycle.state.export ?? null,
    onPreferences: (prefs) => {
      // 参数是「用一次记一次」的偏好：与窗口大小同一条读改写路径。
      lifecycle.state.export = prefs;
      void lifecycle.save();
    },
    onReveal: (path) => {
      invokeBridge("reveal_path", { path }).catch((error) =>
        setMessage(`无法打开文件夹：${describeError(error)}`, { error: true }),
      );
    },
    // 时长按剧本算：真解释器在快进时钟下跑一遍，一帧都不画。浮窗一关就停。
    estimate: async (draft = {}) => {
      const entry = draft.entry || manifestEntry;
      const source = await actions.read(entry);
      return estimateDuration({
        source,
        path: entry,
        read: (asked) => actions.read(asked),
        fps: draft.fps,
        timescale: draft.timescale,
        chooseStrategy: choiceStrategyFor(draft.choiceMode),
        isStopped: () => !panel.isOpen(),
      });
    },
    onStart: (config) => runExport(config),
    onCancel: () => {
      cancelRequested = true;
      exporting?.cancel();
    },
    onClose: () => {
      exportPanel = null;
    },
  });
  exportPanel = panel;
  panel.open({ entry: manifestEntry });

  async function runExport(config) {
    const startedAt = Date.now();
    cancelRequested = false;
    const entry = config.entry || manifestEntry;
    try {
      panel.setPhase("正在读取入口脚本…");
      const source = await actions.read(entry);
      const assets = new Map();
      const preload = makePreloader(invokeBridge, assets);
      panel.setPhase("正在预解码资源…");
      await preload(source);
      // The frame's plate is painted from the style's layers, not a baked PNG,
      // so its image layers join the same decoded-asset map as the script.
      // A missing or unreadable style simply leaves the built-in box in place.
      let plate = null;
      const stylePath = session.project?.style ?? "";
      if (stylePath) {
        try {
          const parsed = JSON.parse(await actions.read(stylePath));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            plate = parsed;
          }
        } catch {
          plate = null;
        }
      }
      await preloadPlateImages(plate, invokeBridge, assets);
      // 准备阶段没有会话可取消，但用户已经按过取消：不必再开一次渲染。
      if (cancelRequested) {
        return { cancelled: true };
      }

      const canvas = document.createElement("canvas");
      canvas.width = config.width;
      canvas.height = config.height;
      const performance = createExportPerformance({
        source,
        path: entry,
        read: (asked) => actions.read(asked),
        preload,
        chooseStrategy: choiceStrategyFor(config.choiceMode),
      });
      panel.setPhase("正在渲染…");
      exporting = createExportSession({
        invoke: invokeBridge,
        canvas,
        assets,
        plate,
        performance,
        config,
        onProgress: ({ frames, t }) => panel.setProgress({ frames, t }),
        onStatus: (text) => panel.setPhase(text),
        // 声音混进成片：脚本里 Audio 的播放、停止、音量与台词配音都按虚拟时钟重放。
        // 资源回来的是 `data:` URL，必须就地解码：webview 的 CSP 只给 img-src /
        // media-src 开了 `data:`，没有 connect-src，`fetch(url)` 会被拒绝。舞台的
        // <video> 走 media-src 所以有声，导出若走 fetch 就会静音且没有任何报错。
        audio: true,
        loadAudio: async (path) => arrayBufferFromDataUrl(await actions.readAudio(path)),
        // 视频素材的声轨：与舞台一样受 mute / volume / play / pause 控制。
        loadVideo: async (path) => arrayBufferFromDataUrl(await actions.readVideo(path)),
        // 视频画面：逐帧 seek 到播放头位置再画进离屏画布。
        resolveVideo: (path) => actions.readVideo(path),
      });
      const result = await exporting.start();
      if (result.cancelled) {
        setMessage("导出已取消");
        return { cancelled: true };
      }
      if (result.warning) {
        // 音频没进成片时仍然给结果：静音视频已经写好，作者能接着用。
        pushErrorBubble({ heading: "导出的音频被跳过", detail: result.warning });
        setMessage(`${result.path} 已导出（没有声音）`);
      } else {
        setMessage(`已导出 ${result.path}（${result.frames} 帧）`);
      }
      return { ...result, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      reportScriptError(error, { path: entry });
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      exporting = null;
    }
  }
}

/**
 * The saves in the open project, read into what a slot needs to draw one.
 *
 * A slot shows more than a file name: the label it was written with, when, and
 * a small copy of the backdrop it stands on. Those live inside each save file,
 * so the whole `saves/` folder is read once when the panel opens. A file that
 * will not parse is kept in the grid as a slot named after itself — deleting or
 * overwriting it is the player's way out, and hiding it would leave a file
 * nothing in the interface could ever reach.
 *
 * @returns {Promise<Array<object>>}
 */
async function readSaveSlots() {
  const files = saveFilesIn(session.project?.tree);
  const saves = [];
  for (const file of files) {
    const entry = { name: file.name, path: file.path, title: "", savedAt: "", thumbnail: null };
    try {
      const save = parseSave(await actions.read(file.path));
      entry.title = save.title || save.name || file.name;
      entry.savedAt = save.savedAt;
      entry.thumbnail = save.thumbnail;
    } catch {
      // Unreadable: still a slot, so it can be overwritten or seen to be there.
      entry.title = file.name;
    }
    saves.push(entry);
  }
  return saves;
}

/** The open slot panel's view: `{ mode, page, saves }`, or `null`. */
let slotView = null;

/** Whether the save/load panel is on screen. */
function slotsOpen() {
  return Boolean(slotView);
}

/** Redraws the panel, or closes it when there is nothing to show. */
function refreshSlots() {
  if (!slotView || !slotPanel) {
    return;
  }
  slotPanel.open(slotView);
}

/** Closes the save/load panel, if it is open. */
function closeSlots() {
  const wasOpen = Boolean(slotView);
  const hadStage = Boolean(session.stageName);
  slotView = null;
  slotPanel?.close();
  // A grid opened before any run was made (loading from a cold start) borrowed
  // the stage to draw on. Closing it hands the editor area back rather than
  // leaving an empty frame with no scene in it. Only when a grid was actually
  // up, so a plain redraw does not re-enter itself.
  if (wasOpen && !hadStage && session.view === "stage") {
    session.view = "code";
    refreshEditor();
  }
}

/**
 * Opens the slot grid in the given mode.
 *
 * One grid serves both directions: saving and loading differ in what a click
 * does, not in how the saves are shown, and a player who has just saved knows
 * where a load will be.
 *
 * @param {"save" | "load"} mode
 */
async function openSlots(mode) {
  if (!session.project) {
    setMessage("没有打开项目", { error: true });
    return;
  }
  if (!stage) {
    setMessage("舞台不可用", { error: true });
    return;
  }
  // The grid is drawn over the stage, and the stage only has a surface while a
  // file is open — without one there is nowhere to put it. This is the same
  // rule the stage itself follows, said before the player picks a slot rather
  // than after.
  if (!session.openPath) {
    setMessage("先打开一个脚本，舞台才有地方显示存档界面", { error: true });
    return;
  }
  // Saving needs somewhere to save from; loading does not, so it may be opened
  // before a run starts and will perform the saved script on a fresh stage.
  if (mode === "save" && (!session.running || !session.node)) {
    setMessage("现在没有可以存档的位置：先运行脚本，停在台词或选择支上再存", { error: true });
    return;
  }
  if (mode === "save" && !session.node.canSave) {
    setMessage("当前位置不能存档：它在函数或 cue 块里", { error: true });
    return;
  }

  try {
    const saves = await readSaveSlots();
    // The grid is drawn over the stage, so the stage has to be the surface on
    // screen. A save is always opened from a run (which already put it there);
    // a load may be asked for straight from the editor.
    if (session.view !== "stage") {
      session.view = "stage";
    }
    // Opening while a grid is already up refills that one grid: the panel is a
    // single instance, never a stack. A page turn keeps its page; a fresh open
    // starts at the first one.
    const page = slotView?.page ?? 0;
    slotView = { mode, page, saves };
    refreshEditor();
    slotPanel.open(slotView);
    playback.refreshMenu();
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/**
 * Writes the run's current node into a slot.
 *
 * The label a slot shows defaults to the save's own name, which is already
 * stamped with the time — so a player who just clicks through gets a slot that
 * says when it was made without typing anything.
 *
 * @param {object | null} slot The save already in the slot, or `null`.
 */
async function saveIntoSlot(slot) {
  if (!session.running || !session.node || !session.node.canSave) {
    setMessage("现在没有可以存档的位置", { error: true });
    return;
  }
  const suggested = slot?.name || defaultSaveName();
  const name = await promptText({
    title: slot ? `覆盖 ${slot.name}` : "存档",
    label: "存档名（存到项目的 saves/ 目录）",
    value: suggested,
    confirmLabel: "存档",
    validate: (value) => {
      try {
        saveFileName(value);
        return null;
      } catch (error) {
        return error.message;
      }
    },
  });
  if (name === null) {
    return;
  }

  try {
    const target = savePathFor(name);
    const document = buildSave({
      name: name.trim(),
      title: name.trim(),
      root: session.root,
      file: session.node.file,
      path: session.node.path,
      choices: session.choices,
      // What the scripts looked like, so a later load can tell whether the
      // position it is about to resume at is still the same one.
      scripts: Object.fromEntries(
        [...session.texts].map(([scriptPath, text]) => [scriptPath, hashText(text)]),
      ),
      // The picture the position stands on, so its slot can show it.
      thumbnail: await captureStageThumbnail(),
    });
    await actions.write(target, `${JSON.stringify(document, null, 2)}\n`);
    // Only the tree is re-read: replacing the whole project would drop the
    // stage the player is standing on — and this save was made from that very
    // run, which has to survive its own save.
    session.project = await reloadProject();
    refreshResourcePanel();
    setMessage(`已存档：${target}`);
    // The grid stays up on the page it was on, now showing the new slot:
    // saving is something a player often does twice in a row. It is refilled
    // directly rather than reopened, so a run that ended meanwhile cannot turn
    // a successful save into an error message.
    if (slotView) {
      slotView = { ...slotView, saves: await readSaveSlots() };
      refreshSlots();
      playback.refreshMenu();
    }
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/**
 * Resumes the node a save names.
 *
 * The save is read, then the run it describes is performed again from the top
 * with the stage silenced, and goes live where the file says. See
 * `ui/save.js` for why nothing but the position is stored.
 *
 * @param {object} slot The save the player picked.
 */
async function loadFromSlot(slot) {
  try {
    const save = parseSave(await actions.read(slot.path));
    // A statement index only means the same line while the script around it is
    // the same, so a changed script is refused instead of resumed elsewhere.
    await verifyScripts(save.scripts, (scriptPath) => actions.read(scriptPath));
    const source = await actions.read(save.root);
    // Closed only once the save is known to be resumable: a refusal leaves the
    // grid up so the player can pick another slot rather than start over.
    closeSlots();
    await performScript(source, {
      path: save.root,
      name: stageNameFor(save.root),
      // The saved node is what the replay seeks; the recorded answers keep the
      // way to it the same as when the save was made.
      replay: { target: nodeKey(save.file, save.path), choices: save.choices },
      // Read from disk, not the editor: a save only matches the text it was
      // made on, and an unsaved edit is a different script.
      fromDisk: true,
    });
  } catch (error) {
    setMessage(describeError(error), { error: true });
  }
}

/**
 * A small copy of the stage as a save's thumbnail.
 *
 * The whole frame cannot be drawn into a canvas from the DOM — the layers are
 * `<img>` elements and CSS, and a scene is not a picture — so what a slot shows
 * is the backdrop, which is the part of the stage a player recognises a save
 * by. A stage with no backdrop answers `null` and the slot draws its number.
 *
 * The copy is bounded in size because it travels inside the save file: 320 px
 * wide is enough for a slot's picture and keeps a save a few tens of kilobytes
 * rather than a megabyte.
 *
 * @returns {Promise<string | null>} A `data:` URL, or `null`.
 */
async function captureStageThumbnail() {
  const path = stage?.backgroundPath?.();
  if (!path) {
    return null;
  }
  try {
    const url = await assetCache.resolve(path);
    const image = await new Promise((resolve, reject) => {
      const bitmap = new Image();
      bitmap.onload = () => resolve(bitmap);
      bitmap.onerror = () => reject(new Error("thumbnail"));
      bitmap.src = url;
    });
    const width = 320;
    const height = Math.round((width * (image.naturalHeight || 9)) / (image.naturalWidth || 16));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(1, height);
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    // `image/jpeg` rather than PNG: a backdrop is photographic, and the slot is
    // 100 px wide — the difference in quality is invisible and in size is not.
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    // A backdrop that will not decode costs the save its picture, nothing more.
    return null;
  }
}

// --- stage controls: playback wiring, teardown, saving ---

/**
 * Shows the pointer's place in the frame in the status bar.
 *
 * The numbers are the stage's own — 1920×1080, origin at the centre, y up — so
 * a reading can be typed straight into `Character(…, x, y)` or a light. It is
 * only there while the pointer is over the frame: a coordinate left behind after
 * the pointer moved away would be worse than none, and so would one left behind
 * on the stage tab after the author switched to the code.
 */
function wireStagePointer() {
  const view = dom.stageView;
  const surface = dom.stageSurface;
  const item = dom.statusPointer;
  if (!view || !surface || !item) {
    return;
  }

  clearPointerReading = () => {
    item.textContent = "";
    item.hidden = true;
  };

  const read = (event) => {
    if (view.hidden) {
      clearPointerReading();
      return;
    }
    // The pointer is taken against the frame's own box, not the panel's: the
    // panel is larger, and its margins are not part of the picture.
    const at = pointInStage(event.clientX, event.clientY, surface.getBoundingClientRect());
    if (!at) {
      clearPointerReading();
      return;
    }
    // Writing the same words back would only cost a layout pass: a pointer that
    // moved a tenth of a pixel still reads as the same coordinate.
    const text = `坐标 ${at.x}, ${at.y}`;
    if (item.textContent !== text) {
      item.textContent = text;
    }
    if (item.hidden) {
      item.hidden = false;
    }
  };

  view.addEventListener("pointermove", read);
  view.addEventListener("pointerleave", clearPointerReading);
  view.addEventListener("pointercancel", clearPointerReading);
}

/** Wires the stage's text menu, the slot panel and the backlog overlay. */
function wireStageControls() {
  const menu = document.getElementById("stage-menu");
  const panel = document.getElementById("backlog");
  const slots = document.getElementById("slots-panel");
  const settings = document.getElementById("stage-settings-panel");
  const exit = document.getElementById("stage-exit");
  // Clicks on the menu, the backlog, the slot grid, the settings panel or the
  // exit card must not also advance the line: the click-to-advance listener
  // lives on the stage element they sit inside, so they stop the event before it
  // reaches it.
  for (const surface of [menu, panel, slots, settings, exit]) {
    surface?.addEventListener("click", (event) => event.stopPropagation());
  }
  // The menu mirrors the 文件 / 演出 items, so the player stays on the stage
  // instead of reaching for the menu bar.
  document.getElementById("stage-save")?.addEventListener("click", () => openSlots("save"));
  document.getElementById("stage-load")?.addEventListener("click", () => openSlots("load"));
  document.getElementById("stage-auto")?.addEventListener("click", () => playback.toggleAuto());
  document.getElementById("stage-skip")?.addEventListener("click", () => playback.toggleSkip());
  document.getElementById("stage-fullscreen")?.addEventListener("click", () => playback.toggleFullscreen());
  document.getElementById("stage-backlog")?.addEventListener("click", () => playback.toggleBacklog());
  document.getElementById("stage-settings")?.addEventListener("click", () => playback.openSettings());
  document.getElementById("backlog-close")?.addEventListener("click", () => playback.toggleBacklog(false));

  // The menu sits in the picture's bottom-right corner and stays hidden until the
  // pointer goes there (`ui/stage-menu.js`). It is a child of the frame, so the
  // frame is what the pointer is measured against.
  const frame = dom.stageView?.querySelector(".stage__frame") ?? null;
  if (dom.stageView && frame && menu) {
    stageMenu = createStageMenu({ stage: dom.stageView, frame, menu });
  }

  // Scrolling up over the scene opens the backlog — the gesture a visual novel
  // uses for its history. It is on the stage rather than on the document so a
  // wheel over the editor or a panel is never mistaken for it.
  const stageView = document.getElementById("stage-view");
  stageView?.addEventListener(
    "wheel",
    (event) => {
      // 退出确认盖着画面时，滚轮不该在它后面翻出一份回看：玩家正在回答一个
      // 问题，别把另一个面板塞到他手底下。
      if (stageExit?.isOpen()) {
        return;
      }
      playback.onStageWheel(event);
    },
    { passive: false },
  );

  // Inside the list, the wheel is the list's own — except at its first line,
  // where another upward flick pulls the history back out of the way.
  const backlogBody = document.getElementById("backlog-body");
  backlogBody?.addEventListener(
    "wheel",
    (event) => {
      if (playback.wheelClosesBacklogAtTop(event)) {
        event.preventDefault();
        playback.toggleBacklog(false);
      }
    },
    { passive: false },
  );
  // A drag on the scrollbar is the list's too, so it never reaches the stage
  // and cannot be read as a click meant to advance the line.
  backlogBody?.addEventListener("pointerdown", (event) => event.stopPropagation());

  if (slots) {
    slotPanel = createSlotPanel({
      host: slots,
      // A click on a slot is the whole interaction: saving asks for a name and
      // writes it, loading reads it and performs it.
      onPick: (mode, save) => {
        // Both write to disk and can fail; the status bar is where a player
        // learns that a slot did not take, so neither is left unhandled.
        const report = (error) => setMessage(describeError(error), { error: true });
        if (mode === "save") {
          saveIntoSlot(save).catch(report);
        } else if (save) {
          loadFromSlot(save).catch(report);
        }
      },
      // A page turn redraws the same panel on another page, so the grid stays
      // one instance.
      onPage: (page) => {
        if (slotView) {
          slotView = { ...slotView, page };
          refreshSlots();
        }
      },
      // Closing from the panel's own × has to put the menu's lit words out too.
      onClose: () => {
        slotView = null;
        playback.refreshMenu();
      },
      // A save is wiped straight from its slot, in either mode, behind a confirm
      // so a stray hover-click does not lose a position.
      onDelete: async (mode, save) => {
        const ok = await confirmDialog({
          title: "删除存档",
          body: `确定删除存档「${save.name}」？此操作不可撤销。`,
          confirmLabel: "删除",
        });
        if (!ok) {
          return;
        }
        try {
          await actions.remove(save.path);
          // The tree re-read keeps the resource panel's save list in step with
          // the grid; only the tree, never the whole project, so a run on the
          // stage survives its own save's deletion.
          session.project = await reloadProject();
          refreshResourcePanel();
          if (slotView) {
            slotView = { ...slotView, saves: await readSaveSlots() };
            refreshSlots();
          }
          setMessage(`已删除存档：${save.path}`);
        } catch (error) {
          setMessage(describeError(error), { error: true });
        }
      },
    });
  }

  if (settings) {
    settingsPanel = createStageSettings({
      host: settings,
      // The panel only reports the pick; writing the manifest and handing the
      // mode to the stage stays here, with the rest of the project state.
      onChange: (value) => {
        void playback.applyTypewriter(value);
      },
      onClose: () => playback.refreshMenu(),
    });
  }

  if (exit) {
    stageExit = createStageExitConfirm({
      host: exit,
      // 确认就是离开舞台本身：`closeStage` 会停运行、复位全屏、把界面还给
      // 编辑器，Esc 因此在全屏里也有了一条走得通的路。返回则什么都不做。
      onConfirm: () => {
        closeStage();
        // 播放器模式把界面整个换成了只有画面的样子：舞台走了，外壳也一起退
        // 出去，否则屏幕上只剩一个没有内容的播放器。
        if (playerMode) {
          setPlayerMode(false);
        }
      },
    });
  }

  // F11 在全局切换全屏；该按键由应用接管，避免与 WebView 的绑定冲突。
  // F11 在全局切换全屏；该按键由应用接管，避免与 WebView 的绑定冲突。
  // binding (if any) does not fight us.
  document.addEventListener("keydown", (event) => {
    if (event.key === "F11") {
      event.preventDefault();
      playback.toggleFullscreen();
    }
  });
  // 全屏时 Esc 不再直接掉出全屏：全屏的舞台上标签栏与菜单栏都被藏起来，屏幕
  // 上只有画面，所以这里问一句「退出演出？」——确认后 `discardStage` 连全屏
  // 一起收掉，返回则还留在全屏的舞台上。抽屉式面板（存档、回看）先让位给它们。
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !playback.isFullscreen()) {
      return;
    }
    // 播放器模式即使全屏，Esc 也只走「要返回编辑器吗」那一条确认，不弹舞台
    // 自己的「退出演出」卡；那条链在 setupMenuBar 里统一处理。
    if (playerMode) {
      return;
    }
    if (slotsOpen() || playback.isBacklogOpen()) {
      return;
    }
    event.preventDefault();
    askToLeaveStage();
  });
  // The webview can also leave fullscreen on its own (a platform shortcut, or
  // a window manager taking it back). Re-read rather than assume — and put the
  // shell back, since the window is no longer covering the monitor.
  document.addEventListener("fullscreenchange", () => {
    if (!chrome) {
      return;
    }
    chrome.syncFullscreen().then((on) => {
      playback.setFullscreen(on);
      playback.applyStageFullscreen(on);
      playback.refreshMenu();
    });
  });
}

/**
 * Runs one teardown step on its own.
 *
 * A stage that has already broken can throw from any of its subsystems. Such an
 * exception used to skip `session.stageName = null` and the repaint after it,
 * which left the tab on the strip for good and made the next run start on top
 * of the wreckage. Every step is isolated, and the session is reset in the
 * `finally` below however far the teardown got.
 */
function discardStageSafely(step) {
  try {
    step();
  } catch (error) {
    console.error("[pamela] stage teardown step failed", error);
  }
}

function discardStage() {
  try {
    // Fullscreen belongs to the stage: with the stage going away, the shell has
    // to come back or the editor would be left hidden behind a scene that is no
    // longer there.
    if (playback.isFullscreen()) {
      discardStageSafely(() => playback.setFullscreen(false));
      discardStageSafely(() => playback.applyStageFullscreen(false));
      discardStageSafely(() => chrome?.setFullscreen(false));
    }
    // A slot grid and the backlog are drawn over the scene, so they go with the
    // scene: leaving either up would show a history with no stage behind it. So
    // does the path editor, and so does the settings panel: each is drawn on the
    // frame that is going away.
    discardStageSafely(closeSlots);
    discardStageSafely(() => playback.closeSettings());
    discardStageSafely(() => stageExit?.close());
    discardStageSafely(() => playback.toggleBacklog(false));
    if (pathEditor?.isOpen()) {
      discardStageSafely(() => pathEditor.close());
    }
    // The stage stops laying itself out for editing, so its own padding and the
    // player's menu come back.
    discardStageSafely(() => dom.stageView?.classList.remove("is-path-editing"));
    // Whatever the run was doing stops with the stage it was doing it on: the
    // count is what the interpreter asks about between statements, so advancing
    // it here is what ends a run whose stage has just gone away.
    discardStageSafely(stopRun);
    discardStageSafely(() => stage?.clear());
  } finally {
    // The tab is nothing but a rendering of this state. These are plain fields,
    // so they can be reset even when a subsystem above threw: a broken stage
    // must never leave a tab that cannot be closed, nor a stale "running" flag
    // that makes the next run start on top of the old one.
    runCount += 1;
    session.running = false;
    session.node = null;
    session.root = null;
    session.choices = [];
    // The key frame tab goes with the stage it was drawn on: the editor's scene
    // is gone, so there is nothing left for the tab to show.
    session.keyFile = null;
    session.stageName = null;
    // Neither a style file nor an image has a text surface, so coming back from a
    // stage returns to its own surface rather than to a code editor that would
    // not be showing.
    session.view = isDialogPath(session.openPath)
      ? "dialog"
      : isImagePath(session.openPath)
        ? "image"
        : isMapPath(session.openPath)
          ? "graph"
          : "code";
  }
}

/**
 * Ends the run on the stage, if there is one.
 *
 * Advancing the run count is not enough on its own: the interpreter only asks
 * whether it was stopped between statements, and a run parked on a line or a
 * question is not between any. The stage is therefore also asked to answer
 * whatever it is waiting on, which lets the run reach its next check and give
 * up there. What is on the stage is left as it is — stopping is not clearing.
 *
 * @returns {boolean} Whether there was a run to stop.
 */
function stopRun() {
  if (!session.running) {
    return false;
  }
  runCount += 1;
  stage?.stop();
  // The run that owned the replay flag is the one being dropped, so the flag
  // goes with it: a stopped replay would otherwise leave the next run silent.
  stage?.setReplay(false);
  session.running = false;
  session.node = null;
  return true;
}

/** Closes the stage tab and returns to the editor. */
function closeStage() {
  try {
    discardStage();
  } catch (error) {
    setMessage(`关闭舞台时出错：${describeError(error)}`, { error: true });
  } finally {
    // A repaint can fail too when the stage's DOM is broken, and the tab strip
    // is rebuilt near its end. Drop the stage tab node first so the click can
    // never leave one behind; the strip is rebuilt from `session` on every
    // repaint anyway, and a reset stage no longer produces a stage tab.
    discardStageSafely(() =>
      dom.editorTabs?.querySelectorAll(".tab--stage").forEach((tab) => tab.remove()),
    );
    // The repaint normally hides the stage view, but it runs late in
    // `refreshEditor`; hiding it here means a broken repaint cannot leave the
    // scene on screen either.
    discardStageSafely(() => {
      if (dom.stageView) {
        dom.stageView.hidden = true;
      }
    });
    discardStageSafely(refreshEditor);
  }
}

/**
 * Whether the stage is what the window is showing right now.
 *
 * The stage tab, the fullscreen shell and the player all show the same element,
 * so one test covers all three: if it is not hidden, the scene is on screen and
 * Esc belongs to it rather than to the editor behind it.
 */
function stageOnScreen() {
  return Boolean(dom.stageView && !dom.stageView.hidden);
}

/**
 * Asks the player whether the stage should go away.
 *
 * This is the one exit a fullscreen stage has: `.tabs` and the menu bar are
 * hidden there, so there is no × to click and the picture is the whole
 * interface. Enter confirms (the card closes the stage through `closeStage`),
 * Esc goes back to the scene.
 *
 * @returns {boolean} Whether the question was asked — `false` when the card was
 *   never built, which leaves the caller free to fall back to its older answer.
 */
function askToLeaveStage() {
  if (!stageExit) {
    return false;
  }
  stageExit.open();
  return true;
}

/**
 * Whether the open file has unsaved changes.
 *
 * A style file is compared as its document rather than as its bytes, since the
 * designer rewrites it in full; a script is compared as the text on screen. An
 * image is only shown, so it has nothing to be unsaved.
 *
 * The key frame editor is its own tab, so its changes are reported here too:
 * the tab carries the dirty dot the same way a script does, and closing the
 * window asks about them.
 */
/** Cached dialog document text, keyed by the editor's version and saved text. */
let dialogDirtyCache = { version: -1, saved: null, text: "" };

function isEditorDirty() {
  // The key frame editor's own state first: it is open over the stage and its
  // file is not `session.openPath`.
  if (pathEditor?.isDirty()) {
    return true;
  }
  if (!session.openPath) {
    return false;
  }
  if (isDialogPath(session.openPath)) {
    if (!dialogEditor) {
      return false;
    }
    // `serialize()` walks the whole style document; the status bar asks on
    // every repaint, so only rebuild the text when the document really moved.
    const version = dialogEditor.version?.() ?? -1;
    if (dialogDirtyCache.version !== version || dialogDirtyCache.saved !== session.savedJson) {
      dialogDirtyCache = {
        version,
        saved: session.savedJson,
        text: dialogEditor.serialize(),
      };
    }
    return dialogDirtyCache.text !== session.savedJson;
  }
  if (session.view === "imageEdit") {
    return Boolean(imageEditor) && imageEditor.dirty;
  }
  if (session.view === "audioEdit") {
    return Boolean(audioEditor) && audioEditor.dirty;
  }
  if (session.view === "graph") {
    return Boolean(graphEditor) && graphEditor.dirty;
  }
  if (isPathFile(session.openPath)) {
    return Boolean(pathEditor?.isDirty());
  }
  if (isImagePath(session.openPath)) {
    return false;
  }
  return dom.editorText?.value !== session.savedText;
}

async function confirmDiscard(path = session.openPath) {
  const answer = await promptConfirm({
    title: "放弃未保存的修改？",
    body: `${path} 有未保存的修改，继续将丢失这些修改。`,
    confirmLabel: "放弃修改",
  });
  return answer;
}

/**
 * Locks the text editor while the project tree is being replaced. Without it,
 * a keystroke during a rescan lands in a document `applyProject` discards.
 */
function setEditorBusy(active) {
  if (!dom.editorText) {
    return;
  }
  dom.editorText.readOnly = active;
  dom.editorText.setAttribute("aria-busy", active ? "true" : "false");
  dom.editorText.classList.toggle("is-busy", active);
}

/**
 * Asks before the window closes when any tab or standalone editor still has
 * unsaved work.
 *
 * `beforeunload` is only a last resort: the host may not wait for it, so the
 * menu's quit command checks here first. Only "discard" and "cancel" are
 * offered; a failed save must not turn into a silent close.
 */
async function confirmCloseAll() {
  const dirty = session.order.filter((path) => isDocDirty(session.docs.get(path)));
  if (!dirty.length && !isEditorDirty()) {
    return true;
  }
  if (!promptConfirm) {
    return true;
  }
  const where = dirty.length
    ? `有 ${dirty.length} 个标签未保存`
    : "当前编辑器有未保存的修改";
  return promptConfirm({
    title: "退出 Pamela？",
    body: `${where}，退出会丢失这些修改。`,
    confirmLabel: "退出并放弃修改",
  });
}

async function saveFile() {
  // The key frame editor is a document of its own, over the stage: Ctrl+S
  // while it is in front saves the animation, not whatever script is behind it.
  if (session.keyFile && pathEditor?.isOpen() && session.view === "stage") {
    await pathEditor.save();
    refreshStatus();
    return true;
  }
  if (!session.openPath) {
    setMessage("没有打开的文件", { error: true });
    return false;
  }
  // A graph is saved as its own JSON document rather than as text.
  if (session.view === "graph") {
    if (!graphEditor) {
      setMessage("可视化编辑器不可用。", { error: true });
      return false;
    }
    await graphEditor.save();
    refreshStatus();
    return true;
  }
  // An image is shown rather than edited, so there is nothing of the editor's
  // to write back over it.
  if (session.view === "imageEdit") {
    if (!imageEditor) {
      setMessage("图片编辑器不可用。", { error: true });
      return false;
    }
    await imageEditor.save();
    refreshStatus();
    return true;
  }
  if (session.view === "audioEdit") {
    if (!audioEditor) {
      setMessage("音频编辑器不可用。", { error: true });
      return false;
    }
    await audioEditor.save();
    refreshStatus();
    return true;
  }
  if (isImagePath(session.openPath)) {
    setMessage("图片不能保存", { error: true });
    return false;
  }
  // The path and contents are read before the await: the tab may change while
  // the write is in flight, and the baseline must follow the file that was
  // actually written, not whatever is in front when the write returns.
  const path = session.openPath;
  const isDialog = isDialogPath(path);
  const contents = isDialog && dialogEditor ? dialogEditor.serialize() : dom.editorText.value;
  try {
    await actions.write(path, contents);
    // The stage draws the plate straight from the style's layers, so a saved
    // edit reaches an already-open stage at once — no re-run and no baking.
    // Only the style the project actually points at is pushed: an author may
    // have another template open that is not the one in use.
    if (isDialog && dialogEditor && path === session.project?.style) {
      stage?.setDialogueStyle(dialogEditor.document);
    }
    const doc = session.docs.get(path);
    if (doc) {
      if (isDialog) {
        doc.savedJson = contents;
      } else if (doc.kind === "script") {
        doc.savedText = contents;
      }
    }
    if (session.openPath === path) {
      if (isDialog) {
        session.savedJson = contents;
      } else {
        session.savedText = contents;
      }
      refreshStatus();
    }
    setMessage(`已保存 ${path}`);
    return true;
  } catch (error) {
    setMessage(describeError(error), { error: true });
    return false;
  }
}

/** Whether any open tab — including the one in front — holds unsaved work. */
function hasDirtyDocs() {
  if (session.running || !actions) {
    return false;
  }
  if (isEditorDirty()) {
    return true;
  }
  return session.order.some((path) =>
    path === session.openPath ? false : isDocDirty(session.docs.get(path)),
  );
}

/**
 * Writes every dirty tab.
 *
 * The active tab goes through `saveFile()`, which knows the key frame editor
 * and the per-surface baselines. The others are written from their own
 * document rather than by switching tabs: an autosave must not move the
 * author's caret or change which surface is in front.
 */
async function saveAllDirty() {
  if (!actions || session.running) {
    return;
  }
  const active = session.openPath;
  const dirty = session.order.filter((path) =>
    path === active ? isEditorDirty() : isDocDirty(session.docs.get(path)),
  );
  if (!dirty.length && !isEditorDirty()) {
    return;
  }
  let saved = 0;
  if (active && isEditorDirty() && !dirty.includes(active)) {
    dirty.unshift(active);
  }
  for (const path of dirty) {
    const doc = session.docs.get(path);
    if (!doc || path === active) {
      if (await saveFile()) {
        saved += 1;
      }
      continue;
    }
    try {
      if (doc.kind === "script") {
        await actions.write(path, doc.text);
        doc.savedText = doc.text;
      } else if (doc.kind === "dialog") {
        const contents = doc.editor?.serialize();
        if (contents == null) {
          continue;
        }
        await actions.write(path, contents);
        doc.savedJson = contents;
      } else if (typeof doc.editor?.save === "function") {
        await doc.editor.save();
      } else {
        continue;
      }
      saved += 1;
    } catch (error) {
      setMessage(`自动保存 ${path} 失败：${describeError(error)}`, { error: true });
    }
  }
  if (saved) {
    setMessage(`已自动保存 ${saved} 个文件`);
    refreshStatus();
  }
}

/** Records an edit as the moment the autosave interval starts from. */
function noteEdit() {
  autoSave.noteEdit();
}

/** Applies one of the five autosave intervals from 文件 → 自动保存. */
function setAutoSave(seconds) {
  const value = autoSave.setIntervalSeconds(seconds);
  lifecycle.state.auto_save = value;
  lifecycle.save();
  refreshMenuContext();
  const label = AUTO_SAVE_OPTIONS.find((option) => option.value === value)?.label ?? "关";
  setMessage(value ? `自动保存：${label}` : "自动保存已关闭");
}

/**
 * Writes the default style file.
 *
 * The path is the one the manifest already names rather than one chosen here:
 * the backend answers it in its report for exactly that reason.
 */
async function writeDefaultStyle(style) {
  // The layers in this file are the plate: the runtime draws them directly, so
  // there is no bitmap to bake and no second file to keep in step.
  await actions.write(style, documentToJson(createDefaultTemplate()));
}

// --- project lifecycle ---

/**
 * Re-scans the open project and redraws the tree in place.
 *
 * Used by the tree's own edits (new/delete/paste), which must not disturb the
 * open file the way `applyProject` does. An open file that no longer exists —
 * because it was deleted, or sat inside a deleted folder — is closed instead.
 */
/**
 * Re-scans the open project without letting an older answer replace a project
 * the user opened while the scan was in flight.
 */
async function reloadProject() {
  const root = session.project?.root ?? null;
  const project = await actions.reload();
  if (!session.project || session.project.root !== root) {
    return session.project;
  }
  return project ?? session.project;
}

async function refreshTree() {
  const project = await reloadProject();
  if (!project) {
    return null;
  }

  session.project = project;
  refreshResourcePanel();

  // Anything the scan no longer finds — deleted, or inside a deleted folder —
  // loses its tab. There is nothing left on disk to save, so nothing is asked.
  const gone = session.order.filter((path) => !findNode(project, path));
  for (const path of gone) {
    const doc = session.docs.get(path);
    session.order = session.order.filter((item) => item !== path);
    session.docs.delete(path);
    disposeDoc(doc);
  }
  if (gone.length && !session.docs.has(session.openPath)) {
    discardStage();
    session.openPath = null;
    session.savedText = "";
    session.savedJson = "";
    syncEditors();
    if (dom.editorText) {
      dom.editorText.value = "";
      updateHighlight();
    }
    clearImage();
    const next = session.order[0] ?? null;
    if (next) {
      restoreDoc(activateDoc(next));
      surfaceFor(next);
    }
  }
  refreshEditor();

  return project;
}

function applyProject(project) {
  // Any read still in flight belongs to the project that is leaving.
  openToken += 1;
  discardStage();
  // A new project is a new set of documents: the old tabs go, surfaces and all.
  for (const doc of session.docs.values()) {
    disposeDoc(doc);
  }
  session.docs.clear();
  session.order = [];
  session.project = project ?? null;
  session.openPath = null;
  session.savedText = "";
  session.savedJson = "";
  // The editor names followed the old tabs; with none left they point at nothing.
  syncEditors();
  // The old tree is dropped before the new one is drawn, so its open folders are
  // not carried over into a project that happens to share their names.
  dom.resourceBody?.querySelector(".tree")?.remove();
  if (dom.editorText) {
    dom.editorText.value = "";
    updateHighlight();
  }
  clearImage();

  refreshResourcePanel();
  refreshEditor();
  menuBar?.setContext({ hasProject: Boolean(session.project), hasOpenFile: false, running: false });

  if (!session.project) {
    return;
  }

  setMessage(`已打开项目 ${session.project.name}`);

  // Open the script a player would start from. An entry that points at a file
  // someone deleted or renamed would otherwise send the editor searching for
  // nothing, so it is reported and cleared instead; the fallback still runs.
  const resolved = resolveEntry(session.project);
  if (resolved.stale) {
    setMessage(`入口脚本 ${resolved.stale} 已失效，已清除入口设置。`, { error: true });
    actions
      .setEntry("")
      .catch((error) => setMessage(describeError(error), { error: true }));
  }
  if (resolved.path) {
    openFile(resolved.path).catch((error) => setMessage(describeError(error), { error: true }));
  }

  // A project opened while in player mode plays at once: the editors above are
  // hidden and the run starts from the entry, so the player never sees sources.
  if (playerMode) {
    setPlayerMode(true);
  }
}

/**
 * Switches between the editor and the player. The player hides every editing
 * surface — the menu bar, the resource tree, the code and dialogue editors and
 * their tabs and status bar — and plays from the entry the moment a project is
 * open, so the author's sources are neither seen nor touched. The choice is
 * not remembered: every launch starts in the editor.
 *
 * @param {boolean} on
 */
function setPlayerMode(on) {
  const app = document.querySelector(".app");
  app?.classList.toggle("is-player-mode", Boolean(on));
  playerMode = Boolean(on);
  if (on) {
    // An editor run must not carry on invisibly behind the black start screen.
    // The gate owns the only run the player will see, from the entry script.
    if (session.running) {
      stopRun();
    }
    // The player does not play on arrival: a black screen with a play button
    // waits for one click or Space. The gate owns the entry run from there.
    playerStart?.open();
    pushToast({ text: "按Esc以返回编辑器", duration: TOAST_ESC_HINT_MS });
  } else {
    playerStart?.close();
    // Back in the editor: stop any run and restore the editing chrome.
    if (session.running) {
      stopRun();
    }
    refreshMenuContext();
    refreshResourcePanel();
  }
}

/** Esc in the player asks before leaving; the old title-bar button is gone. */
async function confirmPlayerExit() {
  if (playerExitPending) {
    return;
  }
  playerExitPending = true;
  try {
    const ok = await confirmDialog({
      title: "要返回编辑器吗",
      body: "确认后将停止演出并返回编辑器。",
      confirmLabel: "返回编辑器",
      cancelLabel: "取消",
    });
    if (ok) {
      // 和舞台上「退出演出」卡同一个收尾：先关掉舞台、停运行，再换回编辑器
      // 外壳，否则回到编辑器后画面还占着整个工作区。
      closeStage();
      setPlayerMode(false);
    }
  } finally {
    playerExitPending = false;
  }
}

// --- command dispatch ---

let menuBar = null;
let actions = null;
// 导出会话要直接调用新的 Rust 命令；`actions` 只暴露封装过的方法，所以
// 把窗口 chrome 建立的 IPC 桥也留一份在模块里。
let invokeBridge = null;
let promptConfirm = null;
let stage = null;
let completion = null;
let dialogEditor = null;
let imageEditor = null;
let audioEditor = null;
let graphEditor = null;
let slotPanel = null;
/** The stage's settings panel (`ui/stage-settings.js`), once the stage exists. */
let settingsPanel = null;
/** 舞台上的退出确认（`ui/stage-exit.js`），Esc 先问一句再走。 */
let stageExit = null;
/** 播放器模式的开始画面（`ui/player-start.js`），左键或空格才开始演出。 */
let playerStart = null;
/** 防止 Esc 连按叠出多个「要返回编辑器吗」窗口。 */
let playerExitPending = false;
// "current" runs the open file (a .flowmap is compiled to .pe first);
// "entry" always runs scripts/main.pe.
let runStrategy = "current";
/** The runbar's play button; lit only while a run can actually start. */
let runPlayButton = null;
/** The window-chrome handle (`ui/window-chrome.js`), once the IPC bridge is up. */
let chrome = null;

const handlers = {
  "project.new": () =>
    lifecycle.withProject(() => actions.createNew({ defaultPath: lifecycle.defaultPath() })),

  // The picker opens at the open project, so the user lands where they were
  // working instead of having to navigate there again.
  "project.open": () => lifecycle.withProject(() => actions.open({ defaultPath: session.project?.root })),

  "project.reload": () =>
    lifecycle.withProject(async () => {
      const project = await reloadProject();
      setMessage("项目已重新扫描");
      return project;
    }),

  "project.close": async () => {
    if (isEditorDirty() && !(await confirmDiscard())) {
      return;
    }
    await actions.close();
    applyProject(null);
    setMessage("项目已关闭");
  },

  /**
   * Checks the project's structure and repairs what the backend can.
   *
   * The backend builds the missing folders, writes `main.pe` and rewrites
   * `pamela.json`. The only thing finished here is `needs_template`: a project
   * with no style file at all is given the built-in template. Its layers are
   * drawn by the runtime itself, so there is no plate to bake and nothing else
   * for the check to keep in step.
   *
   * The whole repair is asynchronous and the user is pinned to a spinner while
   * it runs: every step is a file write, and a half-repaired project is not
   * something to be interrupted into.
   */
  "project.check": async () => {
    const busy = showBusy({
      title: "检查资源完整性",
      body: "正在检查并补全项目结构…",
    });
    try {
      const report = await actions.check();
      const notes = [];

      // The path is the one the report answers rather than one spelled out
      // here: the manifest already names it, so the two cannot drift apart.
      if (report.needs_template) {
        await writeDefaultStyle(report.style);
        notes.push(`已装载默认样式 ${report.style}`);
      }

      // Redrawn from the report rather than by rescanning: the check has just
      // answered the project as it now stands. An open file that the repair did
      // not touch stays open.
      session.project = report.project;
      // `data/` keeps exactly the paths the scripts still name; a stale one is
      // what is left of a move the author removed.
      await prunePaths(session.project);
      session.project = await reloadProject().catch(() => session.project);
      refreshResourcePanel();
      if (session.openPath && !findNode(session.project, session.openPath)) {
        // The `try` around this block cannot catch a rejection from here: the
        // call is not awaited, and the block has already returned by then.
        closeFile().catch((error) => setMessage(describeError(error), { error: true }));
      } else {
        refreshEditor();
      }

      const repairs = [...report.repairs, ...notes];
      setMessage(repairs.length > 0 ? `已补全：${repairs.join("；")}` : "项目结构完整");
    } catch (error) {
      setMessage(describeError(error), { error: true });
    } finally {
      busy.close();
    }
  },

  "file.newPe": () => treeOps.newScript(SCRIPT_SUFFIX),

  "file.newMpe": () => treeOps.newScript(SHORT_SCRIPT_SUFFIX),

  "file.save": () => saveFile(),

  "autosave.0": () => setAutoSave(0),
  "autosave.30": () => setAutoSave(30),
  "autosave.60": () => setAutoSave(60),
  "autosave.180": () => setAutoSave(180),
  "autosave.300": () => setAutoSave(300),

  "run.play": () => runPlay(),

  "run.entry": () => runEntryScript(),
  // 按舞台自动演出的结果，在离屏画布上逐帧导出 MP4。
  "export.mp4": () => exportMp4(),

  "run.stop": () => {
    if (stopRun()) {
      setMessage("已停止运行");
      refreshEditor();
    }
  },

  "save.node": () => openSlots("save"),

  "load.node": () => openSlots("load"),

  "play.auto": () => playback.toggleAuto(),

  "play.skip": () => playback.toggleSkip(),

  "play.backlog": () => playback.toggleBacklog(),

  "app.player": () => setPlayerMode(true),

  "app.quit": () => window.dispatchEvent(new CustomEvent("pamela:quit")),

  // 帮助 and 关于 both open the built-in reader: a table of contents on the left,
  // a read-only article on the right. Neither needs a project — a first-run user
  // should be able to read how the software works before creating one.
  "app.help": () => readerPanel.open("help"),

  "app.about": () => readerPanel.open("about"),
};

/**
 * Commands that never touch the backend, and so stay usable when the IPC
 * bridge could not be established. Everything else would fail inside `actions`
 * with a `TypeError` that says nothing useful.
 */
const LOCAL_COMMANDS = new Set([
  "app.quit",
  "app.about",
  "app.help",
  "play.auto",
  "play.skip",
  "play.backlog",
  "autosave.0",
  "autosave.30",
  "autosave.60",
  "autosave.180",
  "autosave.300",
]);

function runCommand(command, item = null) {
  const handler = handlers[command];
  if (!handler) {
    setMessage(`未实现的命令：${command}`, { error: true });
    return;
  }
  // The menu bar is built before the bridge on purpose, so "no bridge yet" is a
  // state the user can really be in and deserves the real reason.
  if (!actions && !LOCAL_COMMANDS.has(command)) {
    setMessage("后端未连接，命令不可用。", { error: true });
    return;
  }
  Promise.resolve(handler(item)).catch((error) => {
    setMessage(describeError(error), { error: true });
  });
}

// --- resource panel splitter ---

let applyResourceWidth = () => {};


// --- menu bar ---

/**
 * Puts `text` on the system clipboard.
 *
 * The webview's own Clipboard API is tried first. When it is missing or refuses
 * the write, a scratch textarea and `execCommand("copy")` stand in: deprecated,
 * but it is the only other way out of a webview, and between them the two cover
 * a normal window and a restricted one alike. The editor is handed back its
 * focus and selection afterwards, since selecting in the scratch field took
 * both away.
 *
 * @param {string} text
 * @param {HTMLTextAreaElement} [textarea] The editor the copy was made from.
 * @returns {Promise<boolean>} Whether the clipboard took the text.
 */
async function writeClipboardText(text, textarea = null) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A refused permission is not a failure until the older path is tried too.
  }
  const caret = textarea ? [textarea.selectionStart, textarea.selectionEnd] : null;
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.top = "-1000px";
  scratch.style.opacity = "0";
  document.body.append(scratch);
  let copied = false;
  try {
    scratch.select();
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  scratch.remove();
  if (textarea) {
    textarea.focus();
    if (caret) {
      textarea.setSelectionRange(caret[0], caret[1]);
    }
  }
  return copied;
}

/**
 * Builds the menu bar, the global shortcuts and the editor's own input
 * initialisation.
 *
 * This runs before the IPC bridge is up and deliberately outside its `.then`:
 * everything here is front-end only, and an editor with no menu bar has no way
 * to open a project at all. Commands that do need the backend report that when
 * invoked, rather than leaving a dead window behind.
 */
function setupMenuBar() {
  if (dom.menubar) {
    menuBar = createMenuBar({ onCommand: runCommand });
    dom.menubar.replaceChildren(menuBar.element);
    menuBar.setContext({ hasProject: false, hasOpenFile: false, running: false });

    // Right-aligned launch controls: a play button whose behaviour matches
    // Ctrl+Enter, plus a dropdown that chooses what it launches.
    const runbar = document.createElement("div");
    runbar.className = "runbar";

    const strategy = createSelect({
      className: "runbar__select",
      label: "运行策略",
      options: [
        { value: "current", label: "从当前文件执行" },
        { value: "entry", label: "从入口文件执行" },
      ],
      value: runStrategy,
    });
    strategy.addEventListener("change", () => {
      runStrategy = strategy.value;
      refreshRunButton();
    });

    const playButton = document.createElement("button");
    playButton.className = "runbar__play";
    playButton.type = "button";
    // 按钮仅保留图标时，其语义由 `title` 与 `aria-label` 提供。
    playButton.append(createIcon("play"));
    playButton.setAttribute("aria-label", "执行");
    playButton.addEventListener("click", () => runCommand("run.play"));
    runPlayButton = playButton;

    runbar.appendChild(strategy);
    runbar.appendChild(playButton);
    menuBar.element.appendChild(runbar);
    refreshRunButton();
  }

  document.addEventListener("keydown", (event) => {
    // A key already answered by something closer to the target is not this
    // handler's to act on: a modal's Escape, the completion list's Tab, the
    // editor's own Ctrl+S all prevent the default and act themselves. Without
    // this guard the same press would run the command a second time — Escape
    // would cancel a save dialog *and* stop the run behind it.
    if (event.defaultPrevented) {
      return;
    }
    const command = commandForEvent(event);
    if (command) {
      event.preventDefault();
      runCommand(command);
    }
  });

  // Escape 是一条从上往下的礼让链，每一层只在自己被挡住时才轮到下一层。
  //
  // 它不是一个菜单快捷键：每个弹窗、模态框、补全列表都自己吃 Esc，舞台不能
  // 在它们背后也动一下。`defaultPrevented` 就是区分两者的旗子——凡是处理了
  // Esc 的东西都会标记事件，只有没人要的 Esc 才走到这里。存档格子与回看是
  // 其中两层：它们盖在画面上，Esc 关的是它们，而不是它们下面的演出。
  //
  // 最后轮到舞台本身：舞台在屏上时，Esc 问一句「退出演出？」（Enter 退出、
  // Esc 返回），不再把演出悄悄停掉——全屏的舞台上它是唯一还看得见的出口。
  // 只有舞台不在屏上时，剩下的那一路才退回「停掉运行」。
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    if (slotsOpen()) {
      event.preventDefault();
      closeSlots();
      return;
    }
    if (playback.isBacklogOpen()) {
      event.preventDefault();
      playback.toggleBacklog(false);
      return;
    }
    // 播放器模式没有标题栏按钮：Esc 先问「要返回编辑器吗」，确认才退出。
    // 它排在舞台的「退出演出」卡之前，否则播放器里会先弹出那张内容不同的卡。
    if (playerMode) {
      event.preventDefault();
      void confirmPlayerExit();
      return;
    }
    // 舞台在屏上时，Esc 先问一句要不要离开，而不是把演出悄悄停掉：全屏与
    // 播放器模式下它是唯一还看得见的出口，确认后由 `closeStage` 一并收尾。
    if (stageOnScreen() && askToLeaveStage()) {
      event.preventDefault();
      return;
    }
    if (!session.running) {
      return;
    }
    event.preventDefault();
    runCommand("run.stop");
  });

  // Alt belongs to the platform, not to Pamela: on Windows the key on its own
  // reaches for the window menu and pulls focus out of the editor, and with an
  // arrow it walks the view's history. No command is bound to it, so it is
  // swallowed here. `Ctrl+Alt` is left alone, since that pair is how some
  // layouts type an AltGr character.
  document.addEventListener("keydown", (event) => {
    if ((event.key === "Alt" || event.altKey) && !event.ctrlKey) {
      event.preventDefault();
    }
  });

  // Candidate suggestions while a script is typed. Accepting one rewrites the
  // textarea directly, which fires no `input` event of its own, so the refresh
  // the input handler performs is run for it as well.
  if (dom.editorText) {
    completion = createCompletion({
      textarea: dom.editorText,
      // A `.mpe` file writes `enable ch bg` with spaces where `.pe` writes
      // `stage.enable(ch, bg)`, so the list needs the dialect to know which
      // words are calls and which are objects.
      isShorthand: () => isMpePath(session.openPath),
      onChange: () => {
        refreshStatus();
        updateGutter();
        updateTintMarkers();
        updateHighlight();
        syncHighlightScroll();
      },
    });

    // One repaint per frame rather than one per keystroke; see
    // `scheduleEditorRepaint` for what a burst of typing used to trigger.
    dom.editorText.addEventListener("input", scheduleEditorRepaint);
    dom.editorText.addEventListener("scroll", () => {
      syncGutterScroll();
      syncTintScroll();
      syncHighlightScroll();
      syncErrorScroll();
      if (findBar.isOpen()) {
        findBar.syncScroll();
      }
      // The list is pinned to a point on screen, so it has to be re-anchored
      // when the text under it moves.
      completion.reposition();
    });
    // Leaving the editor dismisses the list for good: a repaint still queued
    // from the last keystroke must not open it again behind the user's back.
    dom.editorText.addEventListener("blur", () => completion.dismiss());
    dom.editorText.addEventListener("keydown", (event) => {
      // The list owns Tab while it is up — the highlighted name is taken by it —
      // so it answers first, and only a key it did not want reaches the editor.
      if (completion.handleKey(event)) {
        return;
      }
      // Ctrl+X / Ctrl+C act on the whole line when nothing is selected, the way
      // a code editor does; with a selection they stay the webview's own copy
      // and cut. Ctrl+D duplicates the line the caret sits on — or the block a
      // selection covers — and leaves the caret on the copy.
      const accel = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      const key = String(event.key).toLowerCase();
      if (accel && key === "d") {
        event.preventDefault();
        duplicateLineBlock(dom.editorText);
        return;
      }
      // Ctrl+/ comments the lines the caret or selection covers, or takes the
      // comments back off; the script's `//` is the marker it writes.
      if (accel && key === "/") {
        event.preventDefault();
        toggleLineComment(dom.editorText);
        return;
      }
      if (accel && (key === "x" || key === "c")) {
        const textarea = dom.editorText;
        if (textarea.selectionStart !== textarea.selectionEnd) {
          return;
        }
        const block = lineBlockOf(textarea.value, textarea.selectionStart, textarea.selectionEnd);
        const text = textarea.value.slice(block.from, block.to);
        if (!text) {
          return;
        }
        event.preventDefault();
        // The line is only cut once the clipboard has it: a refused write must
        // not take the author's text with it. If anything was typed while the
        // write was in flight the block no longer matches and the cut is
        // dropped rather than removing the wrong line.
        void writeClipboardText(text, textarea).then((copied) => {
          if (!copied) {
            setMessage("没能写入剪贴板，内容未改动。", { error: true });
            return;
          }
          if (key === "x" && textarea.value.slice(block.from, block.to) === text) {
            removeLineBlock(textarea, block.from, block.to);
          }
        });
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) {
          outdentSelection(dom.editorText);
        } else {
          indentSelection(dom.editorText);
        }
      }
    });

    // Find / replace bar. Ctrl/Cmd+F opens it (or refocuses the field); Esc in
    // the query closes it. The bar lives inside the editor pane, so it is only
    // meaningful while the editor is on screen.
    dom.editorFindInput.addEventListener("input", () => findBar.run());
    dom.editorFindCase.addEventListener("change", () => findBar.run());
    dom.editorFindRegex.addEventListener("change", () => findBar.run());
    dom.editorFindPrev.addEventListener("click", () => findBar.navigate(-1));
    dom.editorFindNext.addEventListener("click", () => findBar.navigate(1));
    dom.editorFindReplaceOne.addEventListener("click", () => findBar.replaceCurrent());
    dom.editorFindReplaceAll.addEventListener("click", () => findBar.replaceAll());
    dom.editorFindClose.addEventListener("click", () => findBar.close());
    dom.editorFindInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        findBar.navigate(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        findBar.close();
      }
    });
    dom.editorFindReplace.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        findBar.replaceCurrent();
      }
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        if (dom.editorCode && !dom.editorCode.hidden) {
          event.preventDefault();
          if (findBar.isOpen()) {
            dom.editorFindInput.focus();
            dom.editorFindInput.select();
          } else {
            findBar.open();
          }
        }
      }
    });

    // The two faces are files, so they can arrive after the first layout has
    // already been measured. Anything placed against the fallback face — the
    // gutter, the coloured copy, the marks that follow the glyphs — is then off,
    // so it is all repainted once the fonts are in.
    document.fonts?.ready.then(() => {
      updateGutter();
      updateHighlight();
      if (findBar.isOpen()) {
        findBar.renderMarks();
      }
    });
  }

  window.addEventListener("beforeunload", (event) => {
    // Every tab counts, not just the one in front: closing the window closes
    // them all.
    const behind = session.order.some((path) => {
      const doc = session.docs.get(path);
      return doc && path !== session.openPath && isDocDirty(doc);
    });
    if (behind || isEditorDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // A stage can also break outside the run's promise chain — a frame callback
  // or a media event — where `performScript` is no longer around to clean up.
  // Close its tab so a crashed stage is never left on the strip. The guard
  // keeps a failure inside the teardown from re-entering this handler.
  let closingCrashedStage = false;
  const closeCrashedStage = (event) => {
    if (closingCrashedStage || !session.running || !session.stageName) {
      return;
    }
    closingCrashedStage = true;
    try {
      const reason = event.reason ?? event.error;
      setMessage(`舞台运行出错：${reason ? describeError(reason) : "未知错误"}`, { error: true });
      closeStage();
    } catch (error) {
      // Never let the crash handler become the next uncaught error. The tab's
      // state has already been reset in `discardStage`'s `finally`.
      console.error("[pamela] closing a crashed stage failed", error);
    } finally {
      closingCrashedStage = false;
    }
  };
  window.addEventListener("error", closeCrashedStage);
  window.addEventListener("unhandledrejection", closeCrashedStage);
}

// --- window chrome ---

function setupWindowChrome(app, titlebar, maximizeButton) {
  createInvoke({
    onWarning: (error) =>
      console.warn("[pamela] Tauri API module unavailable, using internals IPC.", error),
  }).then((invoke) => {
    if (!invoke) {
      console.error("[pamela] no IPC bridge found; the editor cannot reach the backend.");
      setMessage("无法连接后端，命令不可用。", { error: true });
      return;
    }
    invokeBridge = invoke;

    // Published to the module so the stage's 全屏 word can reach it: the
    // toggle lives in `playback.toggleFullscreen`, far from this wiring.
    chrome = createWindowChrome({
      invoke,
      onError: (message, error) => console.error(`[pamela] ${message}`, error),
      onMaximizedChange: (maximized) => {
        app.classList.toggle("is-maximized", maximized);
        maximizeButton.title = maximized ? "还原" : "最大化";
        maximizeButton.setAttribute("aria-label", maximizeButton.title);
        // Remembered for the next launch; the start-up code restores the size
        // and then re-maximises when this was set.
        lifecycle.state.maximized = maximized;
        lifecycle.save();
      },
    });

    const bind = (id, handler) => document.getElementById(id)?.addEventListener("click", handler);

    bind(MINIMIZE_BUTTON, chrome.minimize);
    bind(MAXIMIZE_BUTTON, chrome.toggleMaximize);
    bind(CLOSE_BUTTON, chrome.close);

    // Tauri's drag script gives drag regions double-click maximise on Windows
    // and Linux but not macOS. Caption buttons are excluded so a double-click
    // never reaches them.
    titlebar.addEventListener("dblclick", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".caption-button")) {
        return;
      }
      chrome.toggleMaximize();
    });

    let quitting = false;
    window.addEventListener("pamela:quit", async () => {
      if (quitting) {
        return;
      }
      quitting = true;
      try {
        if (await confirmCloseAll()) {
          chrome.close();
        }
      } finally {
        quitting = false;
      }
    });

    // The window may already be fullscreen (started that way, or restored by
    // the platform), so the menu is told rather than assuming not.
    chrome.syncFullscreen().then((on) => {
      playback.setFullscreen(on);
      playback.refreshMenu();
    });

    // The backend is the source of truth for the open project, so state is
    // restored from it rather than assumed empty on start.
    actions = createProjectActions({
      invoke,
      pickDirectory: createDirectoryPicker(invoke),
    });

    promptConfirm = ({ title, body, confirmLabel = "确定" }) =>
      confirmDialog({ title, body, confirmLabel, cancelLabel: "取消" });

    // One clock for the whole session; the interval itself is read from the
    // live preference object, so the restored value applies as soon as it lands.
    autoSave.start();

    // The editors are not built here: a document owns its surface, so a second
    // graph opens beside the first with its own selection and its own undo
    // stack. `createDocEditor` builds one the first time its tab is opened.

    // Preferences are read before anything can write them back. The backend's
    // state wins when `--open-project` already opened a project; otherwise the
    // one remembered from the last launch is reopened, and a failure is
    // reported rather than leaving the editor looking inexplicably empty.
    lifecycle.restore()
      .then((remembered) =>
        actions.current().then((open) => open ?? lifecycle.openRemembered(remembered)),
      )
      .then(applyProject)
      .then(() => {
        autoSave.setIntervalSeconds(normalizeAutoSave(lifecycle.state.auto_save));
        // The checked item in 文件 reads the restored preferences.
        refreshMenuContext();
      })
      .catch((error) => setMessage(describeError(error), { error: true }));

  });
}

// --- bootstrap ---

function main() {
  const app = document.querySelector(".app");
  const titlebar = document.querySelector(".titlebar");
  const maximizeButton = document.getElementById(MAXIMIZE_BUTTON);

  if (!app || !titlebar || !maximizeButton) {
    console.error("[pamela] window chrome markup is incomplete.");
    return;
  }

  dom.menubar = document.getElementById("menubar");
  dom.resourceBody = document.getElementById("resource-body");
  // The heading and the rescan button change with the panel's contents: 资源
  // with a project tree, 目录 with the reader's table of contents.
  dom.resourceTitle = document.getElementById("resource-title");
  dom.resourceRefresh = document.getElementById("resource-refresh");
  attachResourceShortcuts();
  dom.resourceMeta = document.getElementById("resource-meta");
  dom.editorTabs = document.getElementById("editor-tabs");
  dom.editorCode = document.getElementById("editor-code");
  dom.editorText = document.getElementById("editor-text");
  dom.editorGutter = document.getElementById("editor-gutter");
  dom.editorGutterInner = document.getElementById("editor-gutter-inner");
  dom.editorHighlight = document.getElementById("editor-highlight");
  dom.editorHighlightInner = document.getElementById("editor-highlight-inner");
  dom.editorPane = document.getElementById("editor-pane");
  dom.editorFindBar = document.getElementById("editor-findbar");
  dom.editorFindInput = document.getElementById("editor-find-input");
  dom.editorFindReplace = document.getElementById("editor-find-replace");
  dom.editorFindInfo = document.getElementById("editor-find-info");
  dom.editorFindPrev = document.getElementById("editor-find-prev");
  dom.editorFindNext = document.getElementById("editor-find-next");
  dom.editorFindReplaceOne = document.getElementById("editor-find-replace-one");
  dom.editorFindReplaceAll = document.getElementById("editor-find-replace-all");
  dom.editorFindClose = document.getElementById("editor-find-close");
  dom.editorFindCase = document.getElementById("editor-find-case");
  dom.editorFindRegex = document.getElementById("editor-find-regex");
  dom.editorFindOverlay = document.getElementById("editor-find-overlay");
  dom.editorFindInner = document.getElementById("editor-find-inner");
  dom.editorErrorInner = document.getElementById("editor-error-inner");
  dom.errorBubbles = document.getElementById("error-bubbles");
  // The swatch layer has an inner strip: swatches are placed once at their
  // position in the text, and scrolling translates the strip rather than
  // recomputing every swatch's offset.
  dom.editorTint = document.createElement("div");
  dom.editorTint.className = "editor__tint";
  dom.editorTintInner = document.createElement("div");
  dom.editorTintInner.className = "editor__tint-inner";
  dom.editorTint.append(dom.editorTintInner);
  dom.editorCode.append(dom.editorTint);

  // A translucent box over the call that a drag would snap to, so the writer
  // sees which function is about to take the dropped file.
  dom.editorCallHighlight = document.createElement("div");
  dom.editorCallHighlight.className = "editor__call-highlight";
  dom.editorCallHighlight.hidden = true;
  dom.editorPane.append(dom.editorCallHighlight);

  // A file dragged from the resource tree lands on the line it was dropped on;
  // an empty `Character`/`Background` argument takes the asset path.
  dom.editorCode.addEventListener("dragover", (event) => {
    if (hasPlainText(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      highlightDropCall(event);
    } else {
      clearDropCall();
    }
  });
  dom.editorCode.addEventListener("dragleave", (event) => {
    // `dragleave` fires when the pointer crosses into a child too; only clear
    // once the pointer is really gone from the editor.
    if (!event.relatedTarget || !dom.editorCode.contains(event.relatedTarget)) {
      clearDropCall();
    }
  });
  dom.editorCode.addEventListener("drop", (event) => {
    // `text` is the fallback name for the same payload: a build that reports the
    // drag under one name may hand it back under the other.
    clearDropCall();
    const path = event.dataTransfer?.getData("text/plain") || event.dataTransfer?.getData("text");
    if (!path) {
      return;
    }
    event.preventDefault();
    // A drop aimed at a call joins its arguments, wherever on the call it landed;
    // anywhere else the name is written in at the pointer.
    if (insertArgumentAtCall(path, event)) {
      return;
    }
    insertTextAtDrop(path, event);
  });
  dom.editorEmpty = document.getElementById("editor-empty");
  dom.stageView = document.getElementById("stage-view");
  dom.stageSurface = document.getElementById("stage-surface");

  // The start gate covers the window rather than the stage: before the run
  // begins the stage tab does not exist yet, so an overlay inside it would
  // never be seen. One click or Space hands over to the entry script.
  const playerStartHost = document.getElementById("player-start");
  if (playerStartHost) {
    playerStart = createPlayerStart({
      host: playerStartHost,
      onStart: () => {
        if (playerMode && session.project) {
          runEntryScript();
        }
      },
    });
  }
  // The dialogue designer, image/audio editors and the canvas have no static
  // nodes: `syncEditors()` assigns their per-tab containers when a doc opens.
  dom.imageView = document.getElementById("image-view");
  dom.imageImage = document.getElementById("image-image");
  dom.imageMeta = document.getElementById("image-meta");
  // The built-in reader (帮助 / 关于). Its article is rebuilt only when the open
  // one changes, so `readerPanel.render` can be called from any repaint.
  dom.readerView = document.getElementById("reader-view");
  dom.statusProject = document.getElementById("status-project");
  dom.statusFile = document.getElementById("status-file");
  dom.statusMessage = document.getElementById("status-message");
  dom.statusPointer = document.getElementById("status-pointer");

  if (dom.stageView && dom.stageSurface) {
    // `resolveAsset` reads `actions` when an image is drawn, not now, so the
    // stage can be built before the IPC bridge has finished connecting.
    stage = createStage({
      element: dom.stageView,
      surface: dom.stageSurface,
      // The kind names the `assets/` folder a bare name is resolved inside, so
      // `Character("ch.png")` reads `assets/Character/ch.png`. A sub-folder is
      // written with slashes or with dots: `Character("ori.si.png")` reads
      // `assets/Character/ori/si.png`, with the name as written tried first.
      resolveAsset: (path, kind = "") => assetCache.resolve(path, kind),
      // Sounds go through their own reader: the image one refuses anything
      // that is not a picture. Videos are larger still, so they have a third.
      resolveAudio: (path) => soundCache.resolve(path, "Audio"),
      resolveVideo: (path) => videoCache.resolve(path, "Video"),
      onError: (message) => setMessage(message, { error: true }),
      // The project's default typewriter mode, read from the manifest. A style
      // file naming its own `text.typeSpeed` overrides it; this is the fallback.
      typewriter: session.project?.typewriter || "off",
      // Motion paths are read once at the start of a run (the stage calls this
      // synchronously, so the map has to be ready before the script performs).
      resolvePath: (id) => pathCache.get(cleanId(id)) ?? null,
      onMissingPath: (asked) =>
        setMessage(
          `找不到关键帧文件 ${asked || "(未命名)"}，这一步没有做`,
          { error: true },
        ),
      // Each shown line keeps the backlog overlay current while it is open —
      // but without scrolling it, since the player may be reading further back.
      onLine: () => {
        if (playback.isBacklogOpen()) {
          playback.renderBacklog({ stickToEnd: false });
        }
      },
    });
    wireStageControls();
    wireStagePointer();
  }

  const panel = document.getElementById("resource-panel");
  const splitter = document.getElementById("resource-splitter");
  if (panel && splitter) {
    applyResourceWidth = setupSplitter(panel, splitter, document.getElementById("resource-toggle"));
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        applyResourceWidth(currentResourceWidth());
        // Remember the window size across launches; the project is kept too.
        lifecycle.state.width = window.innerWidth;
        lifecycle.state.height = window.innerHeight;
        lifecycle.save();
      }, 100);
    });
  }

  resourcePreview.wire();
  wireResourceRefresh();

  // A save shortcut inside the textarea must reach the global handler, so the
  // browser's own handling is suppressed there.
  dom.editorText?.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      runCommand("file.save");
    }
  });

  // The window is an application frame, not a web page: the webview's own
  // shortcuts are swallowed rather than acting on the editor.
  //
  // Registered after every binding of Pamela's own, and it steps aside for any
  // key one of them has already answered (`defaultPrevented`) — so the editor's
  // Ctrl+F, the menu's Ctrl+S and the keyframe editor's Ctrl+Z all still reach
  // their handlers, and only the leftovers are dropped here.
  const WEBVIEW_KEYS = new Set(["p", "u", "d", "j", "r", "g", "h", "t", "l"]);
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) {
      return;
    }
    const key = String(event.key).toLowerCase();
    const other = event.shiftKey && ["i", "j", "c"].includes(key);
    const zoom = ["=", "+", "-", "_", "0"].includes(event.key);
    if (WEBVIEW_KEYS.has(key) || other || zoom || event.key === "F12") {
      event.preventDefault();
    }
  });

  // A file dragged in from the desktop would otherwise make the webview navigate
  // to it — replacing the whole editor with the dropped picture. Pamela's own
  // drags are text, so only real files are refused here.
  const carriesFiles = (event) =>
    event.dataTransfer ? Array.from(event.dataTransfer.types).includes("Files") : false;
  window.addEventListener("dragover", (event) => {
    if (carriesFiles(event)) {
      event.preventDefault();
    }
  });
  window.addEventListener("drop", (event) => {
    if (carriesFiles(event)) {
      event.preventDefault();
    }
  });

  // Any edit restarts the autosave interval. Capture phase catches the textarea
  // as well as fields inside the per-tab editors; the canvas editors report
  // their own changes through `onChange` → `noteEdit()`.
  document.addEventListener("input", () => noteEdit(), true);
  document.addEventListener("change", () => noteEdit(), true);

  // Right-click is inert rather than opening the webview's menu. A future
  // in-app menu listens for `pamela:contextmenu` on `window`; nothing enables
  // the native menu again.
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    window.dispatchEvent(
      new CustomEvent("pamela:contextmenu", {
        detail: { x: event.clientX, y: event.clientY, target: event.target },
      }),
    );
  });

  // The in-app menu for the resource panel; the event above carries the target
  // and pointer position, so this listener stays free of DOM lookups.
  window.addEventListener("pamela:contextmenu", (event) => {
    // A move under the pointer in the script editor gets its own menu; anything
    // else falls through to the resource panel's, which is what the event was
    // originally for.
    if (onEditorKeyContextMenu(event.detail)) {
      return;
    }
    treeOps.onResourceContextMenu(event.detail);
  });

  refreshStatus();
  setupMenuBar();
  setupWindowChrome(app, titlebar, maximizeButton);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
