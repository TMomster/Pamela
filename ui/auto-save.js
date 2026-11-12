// 自动保存的间隔选项与调度器。
// Pamela — autosave intervals and the timer that saves every dirty tab.

/** 「文件 → 自动保存」的五个选项，单位为秒；0 表示关闭。 */
export const AUTO_SAVE_OPTIONS = Object.freeze([
  { value: 0, label: "关" },
  { value: 30, label: "30秒" },
  { value: 60, label: "1分钟" },
  { value: 180, label: "3分钟" },
  { value: 300, label: "5分钟" },
]);

/** 把存下来的偏好夹回合法档位，旧文件里的未知值回落到「关」。 */
export function normalizeAutoSave(value) {
  const seconds = Number(value);
  return AUTO_SAVE_OPTIONS.some((option) => option.value === seconds) ? seconds : 0;
}

/**
 * A single one-second clock decides whether an autosave is due.
 *
 * The clock is never restarted by a keystroke: instead, every edit moves
 * `lastEditMs`, and a tick only saves once the whole interval has passed with
 * no further edits. That keeps a burst of typing from scheduling hundreds of
 * timers, and keeps the interval measured from the last edit rather than from
 * the moment the app started.
 *
 * @param {object} options
 * @param {() => number} options.getInterval Seconds between saves, 0 disables.
 * @param {() => boolean} [options.canSave] False while a run or export owns the app.
 * @param {() => boolean} options.hasDirty Whether any open tab is unsaved.
 * @param {() => (void | Promise<void>)} options.saveDirty Writes every dirty tab.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 */
export function createAutoSave({
  getInterval,
  canSave = () => true,
  hasDirty,
  saveDirty,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (handle) => clearInterval(handle),
}) {
  let handle = null;
  let lastEditMs = now();
  let saving = false;

  function tick() {
    const seconds = Number(getInterval?.() ?? 0);
    if (seconds <= 0 || saving || !canSave() || now() - lastEditMs < seconds * 1000) {
      return;
    }
    if (!hasDirty()) {
      return;
    }
    saving = true;
    Promise.resolve()
      .then(saveDirty)
      .catch(() => {})
      .finally(() => {
        saving = false;
        // A successful (or failed) save starts a fresh interval, so a document
        // that stays dirty is not written once per tick.
        lastEditMs = now();
      });
  }

  return {
    start() {
      if (handle === null) {
        handle = setTimer(tick, 1000);
      }
    },
    stop() {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    },
    /** Records that the author changed something; the interval starts here. */
    noteEdit() {
      lastEditMs = now();
    },
    /** Applies a new interval; the old one does not fire immediately. */
    setIntervalSeconds(seconds) {
      lastEditMs = now();
      return normalizeAutoSave(seconds);
    },
    tick,
  };
}
