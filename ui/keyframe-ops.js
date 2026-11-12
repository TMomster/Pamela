// @ts-check
// 关键帧文件身份：复制 / 改名时同步文件内的 id、剧本里的引用与打开的标签。
// Pamela — key frame file identity: id, references and the open tab.

import { rewriteKeyReferences } from "./move-calls.js";
import { idFromPathFile, normalizePath, rehomePathDocument } from "./path.js";
import { isMapPath, isScriptPath, listFiles, splitPath } from "./project-actions.js";

/**
 * Creates the key frame file domain.
 *
 * A key frame file's name is its id, and a script names that file in `key("…")`
 * (a flowmap names it in `params.file`). Copying or renaming one therefore has
 * to move three things at once: the id inside the file, every reference to the
 * old name, and the editor's own pointers to the open file. Doing only the
 * rename leaves a file that the next project check deletes as "unreferenced",
 * and an open key frame tab that still claims the old name.
 *
 * @param {{
 *   dom: Record<string, any>,
 *   session: Record<string, any>,
 *   getActions: () => any,
 *   getPathCache: () => Map<string, any>,
 *   getPathEditor: () => any,
 * }} deps
 */
export function createKeyframeOps({ dom, session, getActions, getPathCache, getPathEditor }) {
  /** Whether `path` is the open script, whose textarea holds unsaved text. */
  function viaEditor(path) {
    return session.openPath === path && Boolean(dom.editorText) && isScriptPath(path);
  }

  /** Reads a file, preferring the open editor's text over the copy on disk. */
  async function currentText(path) {
    if (viaEditor(path)) {
      return dom.editorText.value;
    }
    return getActions().read(path).catch(() => null);
  }

  /** Writes a file, going through the textarea when it is the open script. */
  async function putText(path, text) {
    if (viaEditor(path)) {
      const caret = dom.editorText.selectionStart;
      dom.editorText.value = text;
      dom.editorText.setSelectionRange(caret, caret);
      dom.editorText.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    await getActions().write(path, text);
  }

  /**
   * Points every script and flowmap reference to one key frame file at another.
   *
   * @returns {Promise<{ path: string, before: string, after: string }[]>} The
   *   changes, so the caller's undo/redo can replay them in either direction.
   */
  async function rekeyReferences(from, to) {
    const fromName = splitPath(from).name;
    const toName = splitPath(to).name;
    const options = { fromId: idFromPathFile(from), toId: idFromPathFile(to) };
    const files = listFiles(session.project, (node) => node.is_script || isMapPath(node.path)).map(
      (node) => node.path,
    );
    const changes = [];
    for (const path of files) {
      const before = await currentText(path);
      if (before == null) {
        continue;
      }
      const after = rewriteKeyReferences(before, fromName, toName, options);
      if (after === before) {
        continue;
      }
      await putText(path, after);
      changes.push({ path, before, after });
    }
    return changes;
  }

  /** Replays the reference rewrites after an undo or a redo. */
  async function replayTexts(changes, direction) {
    for (const change of changes) {
      await putText(change.path, direction === "after" ? change.after : change.before);
    }
  }

  /** Puts a parsed key frame document into the run-time cache. */
  function cacheKeyframes(text, id) {
    try {
      const normalized = normalizePath(JSON.parse(text));
      if (normalized && id) {
        getPathCache().set(id, normalized);
      }
    } catch {
      // A broken file is simply not cached; the run reports it the next time it
      // reads `data/`, which is the existing behaviour for unreadable paths.
    }
  }

  /**
   * Rebuilds a copied or renamed key frame file for its new name.
   *
   * @param {string} path The destination.
   * @param {string} [originalPath] The source, when a rename moved it (so its old
   *   id can leave the cache). A copy keeps the source alive and passes "".
   * @returns {Promise<{ before: string, after: string, id: string } | null>}
   */
  async function rehomeKeyframesFile(path, originalPath = "") {
    const before = await getActions()
      .read(path)
      .catch(() => null);
    if (before == null) {
      return null;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(before);
    } catch {
      return null;
    }
    const rebuilt = rehomePathDocument(parsed, path);
    const after = `${JSON.stringify(rebuilt, null, 2)}\n`;
    if (after !== before) {
      await getActions().write(path, after);
    }
    const fromId = idFromPathFile(originalPath);
    const id = idFromPathFile(path);
    if (fromId && fromId !== id) {
      getPathCache().delete(fromId);
    }
    cacheKeyframes(after, id);
    return { before, after, id };
  }

  /** Drops a key frame document from the run-time cache. */
  function forgetPath(id) {
    if (id) {
      getPathCache().delete(id);
    }
  }

  /** Parses a key frame document without letting a broken file stop a rename. */
  function keyframeDoc(text) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Keeps the open key frame tab — and the editor's own id — on the file it edits.
   *
   * The editor builds its document from an id it captured when the file was
   * opened. Leaving that alone after a rename would make the next save write the
   * old id back into the new file, undoing the rename from the inside.
   */
  function rehomeKeyTab(from, to, doc = null) {
    const pathEditor = getPathEditor();
    if (session.keyFile?.path !== from) {
      return;
    }
    session.keyFile.path = to;
    session.keyFile.id = idFromPathFile(to) || session.keyFile.id;
    if (doc && pathEditor?.isOpen()) {
      pathEditor.rehome(doc.id, doc.name);
    }
  }

  return {
    viaEditor,
    currentText,
    putText,
    rekeyReferences,
    replayTexts,
    cacheKeyframes,
    forgetPath,
    rehomeKeyframesFile,
    keyframeDoc,
    rehomeKeyTab,
  };
}
