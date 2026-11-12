// @ts-check
// 资源树的写操作：新建 / 复制 / 粘贴 / 重命名 / 删除 / 设为入口。
// Pamela — the resource tree's mutating commands.

import { openContextMenu } from "./context-menu.js";
import { createDocument, documentToJson } from "./dialog-editor.js";
import { emptyGraph, serializeGraph } from "./graph-editor.js";
import {
  buildPathFile,
  cleanId,
  copyNameFor,
  idFromPathFile,
  isPathFile,
  PATHS_DIR,
} from "./path.js";
import {
  childNames,
  describeError,
  joinPath,
  MAPS_DIR,
  modernFileName,
  SCRIPT_SUFFIX,
  SHORT_SCRIPT_SUFFIX,
  splitPath,
  TEMPLATES_DIR,
  uniqueName,
  validateDialogName,
  validateFolderName,
  validateJsonName,
  validateKeyframesName,
  validateMapName,
} from "./project-actions.js";

/** Folder a new entry created from `target` belongs in. */
export function targetDirectory(target) {
  return target.isDir ? target.path : splitPath(target.path).dir;
}

/**
 * Whether a clipboard entry may be pasted into `dir`.
 *
 * @param {{ path: string, isDir: boolean } | null} clip
 * @param {string} dir
 */
export function canPaste(clip, dir) {
  if (!clip) {
    return false;
  }
  // A folder cannot be pasted into itself or one of its own descendants.
  return !clip.isDir || (dir !== clip.path && !dir.startsWith(`${clip.path}/`));
}

/**
 * Creates the resource tree's command table.
 *
 * Every command acts on the row it was invoked from — `{ path, name, isDir,
 * isScript }` — and reports through the status bar. The mutating ones record an
 * inverse pair with `fileOps` so Ctrl+Z can walk them back, and a key frame file
 * goes through `keyframeOps` because its name is also its id.
 *
 * @param {{
 *   getActions: () => any,
 *   getPromptConfirm: () => any,
 *   session: Record<string, any>,
 *   fileOps: Record<string, any>,
 *   keyframeOps: Record<string, any>,
 *   setMessage: (text: string, options?: { error?: boolean }) => void,
 *   refreshTree: () => Promise<any>,
 *   openFile: (path: string) => Promise<void>,
 *   refreshEditor: () => void,
 *   refreshResourcePanel: () => void,
 *   openPathEditor: (path: string, where?: any) => Promise<void>,
 *   applyProject: (project: any) => void,
 *   openImageEditor: (path: string) => Promise<void>,
 *   openAudioEditor: (path: string) => Promise<void>,
 *   isEditorDirty: () => boolean,
 *   describeTarget: (target: any) => any,
 *   menuItems: (target: any) => any[],
 *   promptText: (options: any) => Promise<string | null>,
 * }} deps
 */
export function createTreeOps({
  getActions,
  getPromptConfirm,
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
  describeTarget,
  menuItems,
  promptText,
}) {
  const { record: recordFileOp, captureEntry, restoreEntry, rehomeAfterRename } = fileOps;
  const {
    rehomeKeyframesFile,
    rekeyReferences,
    replayTexts,
    cacheKeyframes,
    keyframeDoc,
    rehomeKeyTab,
    forgetPath,
    putText,
  } = keyframeOps;

  /**
   * Creates an empty script of one spelling from the 文件 menu, then opens it.
   *
   * `suffix` is the whole difference between 新建 pe 剧本 and 新建 mpe 剧本: the
   * prompt's default name and its validation follow it, so the file is the one the
   * author asked for instead of a `.pe` to rename afterwards.
   *
   * @param {string} suffix `SCRIPT_SUFFIX` or `SHORT_SCRIPT_SUFFIX`.
   */
  async function newScript(suffix) {
    const actions = getActions();
    if (!session.project) {
      return;
    }
    try {
      const path = await actions.createScript(session.project, { suffix });
      if (!path) {
        return;
      }
      const project = await actions.reload();
      applyProject(project);
      await openFile(path);
    } catch (error) {
      setMessage(describeError(error), { error: true });
    }
  }

  /**
   * Creates an empty script of one spelling in the tree, and opens it.
   *
   * The same two shapes as the menu, landed where the right-click happened: the
   * creation is recorded for undo, since nothing on disk keeps a copy.
   *
   * @param {{ path?: string, isDir?: boolean } | null} target The right-clicked row.
   * @param {string} suffix `SCRIPT_SUFFIX` or `SHORT_SCRIPT_SUFFIX`.
   */
  async function newScriptInTree(target, suffix) {
    const actions = getActions();
    const path = await actions.createScript(session.project, {
      directory: targetDirectory(target),
      suffix,
    });
    if (!path) {
      return;
    }
    const content = await actions.read(path).catch(() => "");
    recordFileOp({
      redo: () => actions.write(path, content),
      undo: () => actions.remove(path),
    });
    await refreshTree();
    await openFile(path);
    setMessage(`已创建 ${path}`);
  }

  const handlers = {
    "tree.newPe": (target) => newScriptInTree(target, SCRIPT_SUFFIX),

    "tree.newMpe": (target) => newScriptInTree(target, SHORT_SCRIPT_SUFFIX),

    "tree.newFolder": async (target) => {
      const name = await promptText({
        title: "新建文件夹",
        label: "文件夹名",
        value: "新建文件夹",
        confirmLabel: "创建",
        validate: validateFolderName,
      });
      if (name === null) {
        return;
      }
      const path = joinPath(targetDirectory(target), name.trim());
      await getActions().createFolder(path);
      recordFileOp({
        redo: () => getActions().createFolder(path),
        undo: () => getActions().remove(path),
      });
      await refreshTree();
      setMessage(`已创建 ${path}`);
    },

    /**
     * Creates a dialogue style file and opens it in the designer.
     *
     * The file always lands in `templates/` wherever the right-click was: the
     * integrity check and the runtime both expect styles there, so
     * the folder is not the author's to choose by right-clicking somewhere else.
     */
    "tree.newDialog": async () => {
      const name = await promptText({
        title: "新建对话框样式",
        label: "文件名",
        value: "default.dialog.json",
        confirmLabel: "创建",
        validate: validateDialogName,
      });
      if (name === null) {
        return;
      }
      const path = joinPath(TEMPLATES_DIR, name.trim());
      const actions = getActions();
      await actions.write(path, documentToJson(createDocument()));
      const content = await actions.read(path).catch(() => "");
      recordFileOp({
        redo: () => actions.write(path, content),
        undo: () => actions.remove(path),
      });
      await refreshTree();
      await openFile(path);
      setMessage(`已创建 ${path}`);
    },

    /**
     * Creates a visual programming graph file and opens it on the canvas.
     */
    "tree.newMap": async (target) => {
      const name = await promptText({
        title: "新建 flowmap 文件",
        label: "文件名",
        value: "flow.flowmap",
        confirmLabel: "创建",
        validate: validateMapName,
      });
      if (name === null) {
        return;
      }
      // A map is a drawing of a script, so it lands in `maps/` wherever the
      // right-click was: that is the folder the integrity check makes and the
      // one the canvas expects to find maps in.
      const dir = target.path === "maps" || target.path.startsWith("maps/")
        ? targetDirectory(target)
        : MAPS_DIR;
      const path = joinPath(dir, name.trim());
      const actions = getActions();
      await actions.write(path, serializeGraph(emptyGraph()));
      const content = await actions.read(path).catch(() => "");
      recordFileOp({
        redo: () => actions.write(path, content),
        undo: () => actions.remove(path),
      });
      await refreshTree();
      await openFile(path);
      setMessage(`已创建 ${path}`);
    },

    /**
     * Creates a key frame file and opens it in the key frame editor.
     *
     * The file is JSON inside but carries the `.keyframes` suffix, which is what
     * makes the tree open it in the editor rather than as text. It lands in
     * `data/` wherever the right-click was, because that is where a `key()` call
     * reads it from.
     */
    "tree.newKeyframes": async () => {
      const name = await promptText({
        title: "新建关键帧文件",
        label: "文件名",
        value: "key-ch.keyframes",
        confirmLabel: "创建",
        validate: validateKeyframesName,
      });
      if (name === null) {
        return;
      }
      const path = joinPath(PATHS_DIR, name.trim());
      const id = idFromPathFile(path) || cleanId(name.trim());
      const actions = getActions();
      await actions.write(path, `${JSON.stringify(buildPathFile({ id, segments: [] }), null, 2)}\n`);
      const content = await actions.read(path).catch(() => "");
      recordFileOp({
        redo: () => actions.write(path, content),
        undo: () => actions.remove(path),
      });
      await refreshTree();
      await openPathEditor(path, { objectName: id });
      setMessage(`已创建 ${path}`);
    },

    "tree.newJson": async (target) => {
      const name = await promptText({
        title: "新建 JSON 文件",
        label: "文件名",
        value: "data.json",
        confirmLabel: "创建",
        validate: validateJsonName,
      });
      if (name === null) {
        return;
      }
      const path = joinPath(targetDirectory(target), name.trim());
      const actions = getActions();
      await actions.write(path, "{}\n");
      const content = await actions.read(path).catch(() => "");
      recordFileOp({
        redo: () => actions.write(path, content),
        undo: () => actions.remove(path),
      });
      await refreshTree();
      await openFile(path);
      setMessage(`已创建 ${path}`);
    },

    "tree.paste": async (target) => {
      const clip = session.clipboard;
      const dir = targetDirectory(target);
      if (!canPaste(clip, dir)) {
        return;
      }
      const actions = getActions();
      // The copy lands beside the original under a free name rather than failing
      // on the clash, so pasting next to the source is always possible. A key
      // frame file needs its own naming rule: `uniqueName` would put a space and
      // a Chinese word where the id goes, and the copy would stop being a key
      // frame file at all.
      const keyframeCopy = isPathFile(clip.path);
      const names = childNames(session.project, dir);
      const name = keyframeCopy ? copyNameFor(clip.name, names) : uniqueName(names, clip.name);
      const from = clip.path;
      const to = joinPath(dir, name);
      await actions.copy(from, to);
      // A key frame file's id is its name. Without this the copy would still
      // claim the source's id and the two would collide in the path cache.
      const rehomed = keyframeCopy ? await rehomeKeyframesFile(to) : null;
      recordFileOp({
        redo: async () => {
          await actions.copy(from, to);
          if (rehomed) {
            await actions.write(to, rehomed.after);
          }
        },
        undo: async () => {
          await actions.remove(to);
          forgetPath(rehomed?.id);
        },
      });
      await refreshTree();
      setMessage(
        rehomed
          ? `已复制 ${to}（id：${rehomed.id}；在脚本里写 key("${name}") 即可使用）`
          : `已粘贴 ${to}`,
      );
    },

    /**
     * Points the manifest's entry at this script, or clears it when the script is
     * already the entry.
     *
     * The backend rewrites `pamela.json` and answers the reloaded project, so the
     * tree (and its 入口 badge) is redrawn from what is now on disk rather than
     * from a locally mutated copy.
     */
    "tree.toggleEntry": async (target) => {
      if (!target.path || target.isDir) {
        return;
      }
      const wasEntry = session.project?.entry === target.path;
      const project = await getActions().setEntry(wasEntry ? "" : target.path);
      if (project) {
        session.project = project;
        refreshResourcePanel();
      }
      setMessage(wasEntry ? "已取消入口脚本" : `已设为入口脚本：${target.path}`);
    },

    "tree.copy": (target) => {
      if (!target.path) {
        return;
      }
      session.clipboard = { path: target.path, name: target.name, isDir: target.isDir };
      setMessage(`已复制 ${target.path}`);
    },

    /**
     * Renames a file or folder inside the folder it already lives in.
     *
     * The new name is a bare name, never a path: a rename is not a move, so the
     * dialog cannot be used to shift an entry somewhere else in the tree. The
     * open file follows its new name, and so does the project's entry when the
     * renamed script was that entry — otherwise the entry would be left pointing
     * at a file that no longer exists.
     */
    "tree.rename": async (target) => {
      if (!target.path) {
        return;
      }
      const current = target.name;
      const fromPath = target.path;
      const isKeyframes = isPathFile(fromPath);
      // A file written before the renames still carries its old suffix; the
      // dialog is where it gets the new one, so the default name already shows
      // it. A folder, or a file that is already modern, is offered unchanged.
      const suggested = target.isDir ? current : modernFileName(current);
      const upgrades = suggested !== current;
      const next = await promptText({
        title: target.isDir ? "重命名文件夹" : "重命名文件",
        label: upgrades ? "新名称（后缀将更新为当前约定）" : "新名称",
        value: suggested,
        confirmLabel: "重命名",
        validate: (value) => {
          const name = String(value ?? "").trim();
          if (!name) {
            return "名称不能为空";
          }
          if (name === current) {
            return "名称没有变化";
          }
          if (/[\\/:*?"<>|]/.test(name)) {
            return "名称不能包含 \\ / : * ? \" < > |";
          }
          if (isKeyframes) {
            // A key frame file is found by its whole name, not just its suffix:
            // `key-<id>.keyframes` or the generated `<object>-<script>-<suffix>-<n>.keyframes`.
            // A name the id reader cannot parse would make the tree stop offering
            // the editor and leave the script orphaned.
            const error = validateKeyframesName(name);
            if (error) {
              return error;
            }
            if (!idFromPathFile(`data/${name}`)) {
              return "关键帧文件名须形如 名字.keyframes";
            }
          }
          return null;
        },
      });
      if (next === null) {
        return;
      }
      const name = next.trim();
      const actions = getActions();
      // Keep the original document: undo has to put it back byte for byte,
      // including the old id, rather than leaving the rehomed one behind.
      const docBefore = isKeyframes ? await actions.read(fromPath).catch(() => null) : null;
      await actions.rename(fromPath, name);

      const parent = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
      const renamed = parent ? `${parent}/${name}` : name;
      // The entry is a path in the manifest; a renamed script must not leave it
      // pointing at the old name.
      if (!target.isDir && session.project?.entry === fromPath) {
        const updated = await actions.setEntry(renamed).catch((error) => {
          setMessage(describeError(error), { error: true });
          return null;
        });
        if (updated) {
          session.project = updated;
        }
      }
      if (session.openPath === fromPath) {
        session.openPath = renamed;
      }

      // A key frame file's name is its id, and scripts name it in `key("…")`.
      // Both have to follow the rename, or the next project check would delete
      // the file as one no script names any more.
      const rehomed = isKeyframes ? await rehomeKeyframesFile(renamed, fromPath) : null;
      const refChanges = isKeyframes ? await rekeyReferences(fromPath, renamed) : [];
      const renamedDoc = rehomed ? keyframeDoc(rehomed.after) : null;
      const originalDoc = keyframeDoc(docBefore ?? "");
      if (isKeyframes) {
        rehomeKeyTab(fromPath, renamed, renamedDoc);
      }
      recordFileOp({
        redo: async () => {
          await actions.rename(fromPath, name);
          rehomeAfterRename(fromPath, renamed);
          if (rehomed) {
            await actions.write(renamed, rehomed.after);
            await replayTexts(refChanges, "after");
            cacheKeyframes(rehomed.after, rehomed.id);
            rehomeKeyTab(fromPath, renamed, renamedDoc);
          }
        },
        undo: async () => {
          await actions.rename(renamed, current);
          rehomeAfterRename(renamed, fromPath);
          if (rehomed) {
            await putText(fromPath, docBefore ?? "");
            await replayTexts(refChanges, "before");
            forgetPath(rehomed.id);
            cacheKeyframes(docBefore ?? "", idFromPathFile(fromPath));
            rehomeKeyTab(renamed, fromPath, originalDoc);
          }
        },
      });
      await refreshTree();
      refreshEditor();
      setMessage(`已重命名为 ${renamed}`);
    },

    "tree.delete": async (target) => {
      if (!target.path) {
        return;
      }
      const kind = target.isDir ? "文件夹" : "文件";
      const unsaved =
        session.openPath === target.path && isEditorDirty()
          ? "\n\n该文件有未保存的修改，删除后将一并丢失。"
          : "";
      const promptConfirm = getPromptConfirm();
      const confirmed = await promptConfirm({
        title: `删除${kind}？`,
        body: `${target.path} 将被永久删除，可用 Ctrl+Z 撤销。${unsaved}`,
        confirmLabel: "删除",
      });
      if (!confirmed) {
        return;
      }
      // Snapshot the subtree first: the backend has no recycle bin, so undo has to
      // rebuild it from what we read out now.
      const snapshot = await captureEntry(target.path);
      await getActions().remove(target.path);
      recordFileOp({
        redo: () => getActions().remove(target.path),
        undo: () => restoreEntry(target.path, snapshot),
      });
      await refreshTree();
      setMessage(`已删除 ${target.path}`);
    },

    "tree.editImage": async (target) => {
      await openImageEditor(target.path);
    },

    "tree.editAudio": async (target) => {
      await openAudioEditor(target.path);
    },
  };

  /** Opens the resource context menu for a right-click. */
  async function onResourceContextMenu(detail) {
    if (!getActions()) {
      return;
    }
    const target = describeTarget(detail?.target);
    if (!target) {
      return;
    }

    const command = await openContextMenu({
      x: detail.x,
      y: detail.y,
      items: menuItems(target),
    });

    const handler = command ? handlers[command] : null;
    if (!handler) {
      return;
    }
    try {
      await handler(target);
    } catch (error) {
      setMessage(describeError(error), { error: true });
    }
  }

  return { newScript, newScriptInTree, handlers, onResourceContextMenu };
}
