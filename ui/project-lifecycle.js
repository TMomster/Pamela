// @ts-check
// 项目的打开、新建、关闭与上次进度的记忆。
// Pamela — opening, creating and closing a project, and remembering the last one.

import { describeError, splitPath } from "./project-actions.js";

/**
 * 后端在「这次加载已被更新的打开请求取代」时回的文案，与 `src/commands/mod.rs`
 * 的 `SUPERSEDED_OPEN` 一致。那是预期行为：两次打开只有后发的那次生效。
 */
const SUPERSEDED_OPEN = "项目已被另一次打开操作取代";

/** 后端作废了这次加载，因为它已被更新的打开请求顶掉。 */
function isSuperseded(error) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.includes(SUPERSEDED_OPEN);
}

/**
 * Creates the project lifecycle: the preferences file, and the one path every
 * project-changing command goes through.
 *
 * The preferences are one live object here rather than a snapshot, because the
 * editor writes single fields into it from three different places (the mode
 * switch, the window size, the maximised flag). Everything that changes it calls
 * {@link save} afterwards, which is what keeps those writes from being lost.
 *
 * @param {{
 *   session: Record<string, any>,
 *   getActions: () => any,
 *   setMessage: (text: string, options?: { error?: boolean }) => void,
 *   isEditorDirty: () => boolean,
 *   confirmDiscard: () => Promise<boolean>,
 *   applyProject: (project: any) => void,
 *   setBusy?: (active: boolean) => void,
 * }} deps
 */
export function createProjectLifecycle({
  session,
  getActions,
  setMessage,
  isEditorDirty,
  confirmDiscard,
  applyProject,
  setBusy,
}) {
  /** The editor preferences restored at launch, kept so each save keeps the rest. */
  const state = {};

  /** Serialises the writes: a resize and a mode switch must not overtake. */
  let saveChain = Promise.resolve();

  /**
   * How many project swaps are in flight.
   *
   * The editor is locked for the whole swap, but two opens can overlap: the
   * first to finish must not unlock typing while the other is still running.
   */
  let busyDepth = 0;

  /** 锁住编辑器；由 {@link unlockEditor} 抵消。 */
  function lockEditor() {
    busyDepth += 1;
    if (busyDepth === 1) {
      setBusy?.(true);
    }
  }

  /** 抵消一次 {@link lockEditor}；最后一次才真正解锁。 */
  function unlockEditor() {
    busyDepth = Math.max(0, busyDepth - 1);
    if (busyDepth === 0) {
      setBusy?.(false);
    }
  }

  /** What was last read from or written to disk, so a save need not re-read it. */
  let stateOnDisk = {};

  /**
   * Persists the preferences as a read-merge-write.
   *
   * The backend replaces the whole preference file, and the object in memory may
   * not know every field an earlier launch wrote. Reading first keeps those, and
   * serialising the writes keeps two fast changes (a resize, then a mode switch)
   * from racing each other. A failure is reported rather than swallowed: a
   * preference that silently stops being saved is worse than a message.
   *
   * @returns {Promise<void>}
   */
  function save() {
    const actions = getActions();
    if (!actions) {
      return Promise.resolve();
    }
    const next = { ...state };
    saveChain = saveChain
      .then(() => actions.saveState({ ...stateOnDisk, ...next }))
      .then(() => {
        // Only after the write lands: a failed save must not claim the file has
        // the values it never received.
        stateOnDisk = { ...stateOnDisk, ...next };
      })
      .catch((error) => setMessage(`保存偏好失败：${describeError(error)}`, { error: true }));
    return saveChain;
  }

  /**
   * Loads the preferences remembered from the last launch.
   *
   * This has to run before anything calls {@link save}: the backend replaces the
   * whole file, so a save that started from an empty object would erase the
   * project remembered on disk. Answers the project path to reopen, if one was
   * remembered; the caller decides whether a project is already open.
   *
   * @returns {Promise<string | null>}
   */
  async function restore() {
    const actions = getActions();
    try {
      const stored = await actions.loadState();
      reset(stored && typeof stored === "object" ? stored : {});
    } catch (error) {
      reset({});
      console.warn("[pamela] 无法读取上次的编辑器状态：", error);
    }
    return state.last_project ?? null;
  }

  /** Replaces both copies of the preferences, keeping their merge baseline in step. */
  function reset(next) {
    for (const key of Object.keys(state)) {
      delete state[key];
    }
    Object.assign(state, next);
    stateOnDisk = { ...next };
  }

  /** Reopens the remembered project, or answers `null` when it is gone. */
  async function openRemembered(root) {
    if (!root) {
      return null;
    }
    try {
      return await getActions().openRoot(root);
    } catch (error) {
      setMessage(`无法恢复上次的项目：${describeError(error)}`, { error: true });
      return null;
    }
  }

  /**
   * Folder the folder picker opens in when creating a project.
   *
   * There is nothing to point at until a project exists, so the first project is
   * left to the dialog's own default.
   */
  function defaultPath() {
    if (!session.project) {
      return undefined;
    }
    return splitPath(session.project.root).dir || undefined;
  }

  /**
   * Opens a project, closing the current one when the backend returns one.
   *
   * Every command that replaces the open project goes through here, so the three
   * things that must happen together cannot drift: an unsaved file is confirmed
   * once, the new project becomes the one the editors show, and it is remembered
   * for the next launch. A run is stopped by `applyProject`, not here.
   *
   * @param {() => Promise<any>} operation Opens the project; resolves `null` when
   *   the user cancelled the picker.
   */
  async function withProject(operation) {
    if (isEditorDirty() && !(await confirmDiscard())) {
      return;
    }
    // Lock typing for the whole swap: a keystroke between the confirmation and
    // `applyProject` would be discarded with the old documents. Held by count,
    // so an overlapping swap cannot unlock it early.
    lockEditor();
    try {
      const project = await operation();
      if (project) {
        applyProject(project);
        state.last_project = project.root;
        save();
      }
    } catch (error) {
      // 后发的打开会顶掉先发的：先完成的那次被后端作废，不该报成打不开。
      if (!isSuperseded(error)) {
        setMessage(describeError(error), { error: true });
      }
    } finally {
      unlockEditor();
    }
  }

  return { state, save, restore, openRemembered, defaultPath, withProject };
}
