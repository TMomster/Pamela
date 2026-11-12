// @ts-check
// 对白设计器的撤销与重做快照栈。
// Pamela — an undo/redo snapshot stack for the dialogue designer.
/** Most steps worth keeping. Older ones fall off the front of the stack. */

export const MAX_HISTORY = 200;

/** A fresh, empty history. */
export function createHistory() {
  return { past: [], future: [] };
}

/**
 * Records the document as it stands *before* a mutation, so the mutation can be
 * undone. Call this right before changing `doc`; pass the live `doc`. The next
 * state is captured by the caller mutating `doc` in place.
 *
 * @param {{ past: object[], future: object[] }} history
 * @param {object} current The document as it is now, before the edit.
 */
export function record(history, current) {
  history.past.push(structuredClone(current));
  if (history.past.length > MAX_HISTORY) {
    history.past.shift();
  }
  history.future.length = 0;
}

/**
 * Reverts the last recorded step. Returns the prior document to assign to `doc`,
 * or `null` when there is nothing to undo.
 *
 * @param {{ past: object[], future: object[] }} history
 * @param {object} current The document as it is now.
 * @returns {object | null}
 */
export function undo(history, current) {
  if (!history.past.length) {
    return null;
  }
  history.future.unshift(structuredClone(current));
  return history.past.pop();
}

/**
 * Re-applies the last undone step. Returns the document to assign to `doc`, or
 * `null` when there is nothing to redo.
 *
 * @param {{ past: object[], future: object[] }} history
 * @param {object} current The document as it is now.
 * @returns {object | null}
 */
export function redo(history, current) {
  if (!history.future.length) {
    return null;
  }
  history.past.push(structuredClone(current));
  return history.future.shift();
}

/** Whether a step can be undone right now. */
export const canUndo = (history) => history.past.length > 0;

/** Whether a step can be redone right now. */
export const canRedo = (history) => history.future.length > 0;
