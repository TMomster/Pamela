// @ts-check
// 资源树的文件操作撤销栈：撤销 / 重做、删除前快照、重命名后的指针同步。
// Pamela — undo and redo for file operations in the resource tree.

import { describeError, listTreeNodes, splitPath } from "./project-actions.js";

/**
 * Creates the resource panel's own history.
 *
 * It is separate from the dialogue designer's (`history.js`) and from the
 * browser's native text undo. Each mutating tree handler records an inverse
 * pair — `redo` replays the change, `undo` walks it back — so Ctrl+Z / Ctrl+Y
 * can reverse a copy, rename, creation or deletion. A deletion is captured
 * beforehand by snapshotting every file under it, because the backend has no
 * recycle bin to fall back on.
 *
 * @param {{
 *   getActions: () => any,
 *   session: Record<string, any>,
 *   refreshTree: () => Promise<any>,
 *   setMessage: (text: string, options?: { error?: boolean }) => void,
 * }} deps
 */
export function createFileOps({ getActions, session, refreshTree, setMessage }) {
  const history = { past: [], future: [], limit: 100 };

  /** Records an undoable file operation. `redo`/`undo` are the two directions. */
  function record({ redo, undo }) {
    history.past.push({ redo, undo });
    if (history.past.length > history.limit) {
      history.past.shift();
    }
    // A new action discards the redo branch, as every undo stack does.
    history.future = [];
  }

  /** Reverts the most recent file operation. */
  async function undo() {
    const op = history.past.pop();
    if (!op) {
      setMessage("没有可撤销的文件操作");
      return;
    }
    try {
      await op.undo();
    } catch (error) {
      setMessage(`撤销失败：${describeError(error)}`, { error: true });
      history.past.push(op);
      return;
    }
    history.future.push(op);
    await refreshTree();
    setMessage("已撤销文件操作");
  }

  /** Replays the most recently undone file operation. */
  async function redo() {
    const op = history.future.pop();
    if (!op) {
      setMessage("没有可重做的文件操作");
      return;
    }
    try {
      await op.redo();
    } catch (error) {
      setMessage(`重做失败：${describeError(error)}`, { error: true });
      history.future.push(op);
      return;
    }
    history.past.push(op);
    await refreshTree();
    setMessage("已重做文件操作");
  }

  /**
   * Reads back every file under `rootPath`, so a later deletion can be undone.
   *
   * @returns {Promise<{ files: Array<{ path: string, content: string }> }>}
   */
  async function captureEntry(rootPath) {
    const actions = getActions();
    const files = [];
    if (session.project && actions) {
      const prefix = `${rootPath}/`;
      for (const node of listTreeNodes(session.project)) {
        if (node.is_dir) {
          continue;
        }
        if (node.path === rootPath || node.path.startsWith(prefix)) {
          let content = "";
          try {
            content = await actions.read(node.path);
          } catch {
            // 无法读取的文件仍按空文件重建。
          }
          files.push({ path: node.path, content });
        }
      }
    }
    return { files };
  }

  /** Creates a folder for an undo replay, tolerating one that is already there. */
  async function recreateFolderForUndo(path) {
    try {
      await getActions().createFolder(path);
    } catch (error) {
      // Undo can replay twice; a folder that already exists is not a failure.
      if (!String(error).includes("已存在")) {
        setMessage(describeError(error), { error: true });
      }
    }
  }

  /**
   * Recreates `rootPath` from a snapshot captured by {@link captureEntry}.
   *
   * The backend's `create_dir` makes any missing parent, so creating the
   * deepest folder each file needs is enough; the files are then written back
   * in place.
   */
  async function restoreEntry(rootPath, snapshot) {
    const actions = getActions();
    const dirs = new Set();
    if (snapshot.files.length === 0) {
      // An empty directory (or, rarely, a file that could not be snapshotted) is
      // recreated as a folder rather than losing the entry entirely.
      await recreateFolderForUndo(rootPath);
      return;
    }
    for (const file of snapshot.files) {
      const parent = splitPath(file.path).dir;
      if (parent) {
        dirs.add(parent);
      }
    }
    for (const dir of dirs) {
      await recreateFolderForUndo(dir);
    }
    for (const file of snapshot.files) {
      await actions.write(file.path, file.content);
    }
  }

  /**
   * Keeps the open-file and project-entry pointers in step after a rename
   * replays in either direction.
   *
   * @param {string} from Path before this step.
   * @param {string} to Path after this step.
   */
  function rehomeAfterRename(from, to) {
    if (session.openPath === from) {
      session.openPath = to;
    }
    if (session.project?.entry === from) {
      getActions()
        .setEntry(to)
        .then((project) => {
          if (project) {
            session.project = project;
          }
        })
        .catch((error) => setMessage(describeError(error), { error: true }));
    }
  }

  return { record, undo, redo, captureEntry, restoreEntry, rehomeAfterRename };
}
