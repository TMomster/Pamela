// 演出的键盘：一只手就能把整场看完，不必去右下角找那排字。
// Pamela — the stage's keyboard shortcuts: advance, auto, fullscreen, save/load,
// settings, a held Ctrl to fast-forward, and Up for the backlog.
//
// 这些键只在画面在屏上时算数。焦点还在输入框里、或者有一个窗口级对话框盖着
// 画面时，键归它们——否则在存档名里打一个空格就会把台词推下去。

/**
 * 「下一步」的键：与鼠标左键点在画面上同义。
 *
 * 空格是每个视觉小说的习惯；方向键下与它并列，因为一只手按着方向键读下去更
 * 顺手。Enter 保留自舞台自己的监听器，这里一并接上。
 */
export const ADVANCE_KEYS = Object.freeze([" ", "Spacebar", "Space", "ArrowDown", "Enter", "NumpadEnter"]);

/** 输入框类元素：键是它们自己的。 */
const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * 这个键是不是属于一个输入框。
 *
 * 例外是「藏在舞台后面的编辑器」：运行剧本时编辑区被 `hidden` 收起，焦点却
 * 可能还留在里面。它已经不在屏上了，键该归舞台。
 *
 * @param {EventTarget | null | undefined} target
 * @returns {boolean}
 */
export function isTextEntry(target) {
  if (!target || typeof target !== "object") {
    return false;
  }
  const tag = String(target.tagName ?? "").toUpperCase();
  if (!TEXT_ENTRY_TAGS.has(tag) && target.isContentEditable !== true) {
    return false;
  }
  // `closest` 只在真 DOM 上有；测试里的假元素没有，就按「在输入框里」算。
  return !target.closest?.("[hidden]");
}

/**
 * 把舞台的快捷键挂到 `document` 上。
 *
 * 所有动作都由调用方给：这个模块只知道「哪个键对应哪件事」，既不知道舞台在哪，
 * 也不知道存档写到哪。`isActive` / `canAdvance` 回答「这一次按键该不该由演出
 * 接手」——舞台不在屏上、或者存档格正盖着画面时，按键原样留给别处。
 *
 * Ctrl 是按住式的：按下快进、松开恢复，和舞台自己的监听器写的是同一个状态。
 *
 * @param {object} options
 * @param {() => any} [options.getStage] 当前的舞台（`ui/stage.js` 的返回值）。
 * @param {() => boolean} [options.isActive] 演出是否该接手这些键。
 * @param {() => boolean} [options.canAdvance] 「下一步」是否该推进；默认同 `isActive`。
 * @param {() => void} [options.toggleAuto]
 * @param {() => void} [options.toggleFullscreen]
 * @param {() => void} [options.openSave]
 * @param {() => void} [options.openLoad]
 * @param {() => void} [options.openSettings]
 * @param {() => void} [options.toggleBacklog]
 * @param {Document} [options.doc]
 * @returns {{ dispose: () => void, isHoldingSkip: () => boolean }}
 */
export function createStageKeys({
  getStage = () => null,
  isActive = () => true,
  canAdvance = isActive,
  toggleAuto = () => {},
  toggleFullscreen = () => {},
  openSave = () => {},
  openLoad = () => {},
  openSettings = () => {},
  toggleBacklog = () => {},
  doc = globalThis.document,
} = {}) {
  const view = doc?.defaultView ?? globalThis.window ?? null;
  let holdingSkip = false;

  const setSkipHold = (on) => {
    const next = Boolean(on);
    if (holdingSkip === next) {
      return;
    }
    holdingSkip = next;
    getStage()?.setSkipHold?.(next);
  };

  /** 有没有窗口级对话框盖在画面上（存档名的输入、删除确认、忙碌框）。 */
  const modalOpen = () => Boolean(doc?.querySelector?.(".modal-overlay"));

  function onKeyDown(event) {
    if (!event || event.defaultPrevented) {
      return;
    }
    if (modalOpen() || isTextEntry(event.target)) {
      return;
    }

    const key = String(event.key ?? "");

    // Ctrl 按住快进：不预先 preventDefault，编辑器里的 Ctrl+C / Ctrl+S 仍然
    // 是它们自己的组合键。
    if (key === "Control") {
      if (!event.repeat && isActive()) {
        setSkipHold(true);
      }
      return;
    }
    // 其它带修饰键的按下都不是演出快捷键：Ctrl+S 是保存，Ctrl+O 是打开项目。
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (!isActive()) {
      return;
    }

    if (ADVANCE_KEYS.includes(key)) {
      if (!canAdvance()) {
        return;
      }
      event.preventDefault();
      getStage()?.advance?.();
      return;
    }

    if (key === "ArrowUp") {
      // 回看是开合一次的：已经翻开时，再按一次把它收回去。
      if (event.repeat) {
        return;
      }
      event.preventDefault();
      toggleBacklog();
      return;
    }

    if (event.repeat) {
      return;
    }
    switch (key.toLowerCase()) {
      case "a":
        toggleAuto();
        break;
      case "f":
        toggleFullscreen();
        break;
      case "s":
        openSave();
        break;
      case "d":
        openLoad();
        break;
      case "o":
        openSettings();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function onKeyUp(event) {
    if (event?.key === "Control") {
      setSkipHold(false);
    }
  }

  /**
   * 窗口失焦时 keyup 不会来。按住 Ctrl 切出去再回来，快进不能一直开着。
   */
  const onBlur = () => setSkipHold(false);

  doc?.addEventListener?.("keydown", onKeyDown);
  doc?.addEventListener?.("keyup", onKeyUp);
  view?.addEventListener?.("blur", onBlur);

  return {
    isHoldingSkip: () => holdingSkip,
    dispose: () => {
      doc?.removeEventListener?.("keydown", onKeyDown);
      doc?.removeEventListener?.("keyup", onKeyUp);
      view?.removeEventListener?.("blur", onBlur);
      setSkipHold(false);
    },
  };
}
