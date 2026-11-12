// @ts-check
// 回放记录的滚轮手势。
// Pamela — the backlog's wheel gesture.
// 滚轮方向决定是否打开回放列表。
/**
 * Whether an upward wheel at the top of the list means "close it".
 *
 * Three things have to hold at once: the list is open, the wheel is going up,
 * and the list has nothing left above it. A wheel that would still scroll the
 * list is the list's own — closing on it would make the history unreadable past
 * its first screen.
 *
 * @param {object} state
 * @param {boolean} state.open Whether the backlog is on screen.
 * @param {number} state.deltaY The wheel's vertical travel; negative is up.
 * @param {number} state.scrollTop How far the list has been scrolled.
 * @returns {boolean}
 */

export function wheelClosesBacklog({ open, deltaY, scrollTop }) {
  if (!open) {
    return false;
  }
  if (!(deltaY < 0)) {
    return false;
  }
  // A pixel of slack: a browser can leave `scrollTop` at a fraction after a
  // smooth scroll, and without it the gesture would never fire on those
  // machines.
  return !(scrollTop > 1);
}

/**
 * Whether an upward wheel over the scene should open the backlog.
 *
 * The gesture is only offered where there is something for it to open — a stage
 * with a run on it — and never while another panel is covering the scene, since
 * those have their own wheel behaviour and would otherwise open the history
 * underneath themselves.
 *
 * @param {object} state
 * @param {boolean} state.open Whether the backlog is already up.
 * @param {boolean} state.onStage Whether a stage with a run is on screen.
 * @param {boolean} state.covered Whether another panel covers the stage.
 * @param {number} state.deltaY The wheel's vertical travel; negative is up.
 * @returns {boolean}
 */
export function wheelOpensBacklog({ open, onStage, covered, deltaY }) {
  if (open || covered || !onStage) {
    return false;
  }
  return deltaY < 0;
}
