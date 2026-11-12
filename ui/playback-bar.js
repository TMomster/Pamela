// @ts-check
// 演出时的播放便利：自动、快进、回看、舞台菜单、设置面板与全屏。
// Pamela — the playback conveniences drawn over the stage.

import { wheelClosesBacklog, wheelOpensBacklog } from "./backlog.js";
import { describeError } from "./project-actions.js";
import { typewriterLabel } from "./stage-settings.js";

/**
 * Creates the stage's playback controls.
 *
 * They are one module because they share one state machine: the stage menu says
 * which of them is on, the backlog and the settings panel cover the scene (so
 * the wheel cannot open the history through them), and leaving fullscreen has to
 * put the shell back. `stage` is a module-level `let` in the composition root, so
 * it arrives as a getter — never as a value captured at construction time.
 *
 * @param {{
 *   dom: Record<string, any>,
 *   session: Record<string, any>,
 *   getStage: () => any,
 *   getSlotView: () => any,
 *   getSettingsPanel: () => any,
 *   getActions: () => any,
 *   getChrome: () => any,
 *   slotsOpen: () => boolean,
 *   setMessage: (text: string, options?: { error?: boolean }) => void,
 * }} deps
 */
export function createPlaybackBar({
  dom,
  session,
  getStage,
  getSlotView,
  getSettingsPanel,
  getActions,
  getChrome,
  slotsOpen,
  setMessage,
}) {
  /** Whether the backlog overlay is open; the stage's `onLine` refreshes it live. */
  let backlogOpen = false;

  /** Whether the window is in fullscreen, as last reported by the host. */
  let windowFullscreen = false;

  /**
   * Refreshes the backlog from the stage's history.
   *
   * `stickToEnd` scrolls to the newest line afterwards. It is on when the list is
   * first opened — a player scrolling back wants the line they just read, not the
   * first one of the scene — and off when a new line arrives while the list is
   * already up, because scrolling then would restore the view out from under
   * someone reading further back.
   */
  function renderBacklog({ stickToEnd = true } = {}) {
    const body = document.getElementById("backlog-body");
    const stage = getStage();
    if (!body || !stage) {
      return;
    }
    const entries = stage.getHistory();
    body.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "backlog__empty";
      empty.textContent = "还没有显示的台词。";
      body.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "backlog__row";
      if (entry.name) {
        const who = document.createElement("span");
        who.className = "backlog__name";
        who.textContent = entry.name;
        row.append(who);
      }
      const what = document.createElement("span");
      what.className = "backlog__text";
      what.textContent = entry.text;
      row.append(what);
      body.append(row);
    }
    if (stickToEnd) {
      body.scrollTop = body.scrollHeight;
    }
  }

  /** Opens or closes the backlog overlay; `force` pins the state when given. */
  function toggleBacklog(force) {
    const panel = document.getElementById("backlog");
    if (!panel) {
      return;
    }
    backlogOpen = force === undefined ? !backlogOpen : Boolean(force);
    panel.hidden = !backlogOpen;
    if (backlogOpen) {
      renderBacklog();
    }
    refreshMenu();
  }

  /**
   * Whether a wheel event at the top of the backlog means "close it".
   *
   * Scrolling up is how the list is opened, so scrolling up again once the list
   * has reached its first line is the same gesture reversed — the player pulling
   * the history back down out of the way. The rule itself is
   * `wheelClosesBacklog`'s, in `ui/backlog.js`; this only reads the two numbers
   * off the elements.
   *
   * @param {WheelEvent} event
   * @returns {boolean}
   */
  function wheelClosesBacklogAtTop(event) {
    const body = document.getElementById("backlog-body");
    return wheelClosesBacklog({
      open: backlogOpen,
      deltaY: event.deltaY,
      scrollTop: body?.scrollTop ?? 0,
    });
  }

  /**
   * Opens the backlog from an upward wheel over the stage.
   *
   * The gesture a visual novel uses for its history: flick the wheel up and the
   * lines already read are restored. The decision is made by
   * `wheelOpensBacklog`, which is where the "not while another panel covers the
   * scene" rule lives.
   *
   * @param {WheelEvent} event
   */
  function onStageWheel(event) {
    const stage = getStage();
    const onStage = Boolean(stage && session.stageName && !dom.stageView?.hidden);
    if (!wheelOpensBacklog({ open: backlogOpen, onStage, covered: slotsOpen(), deltaY: event.deltaY })) {
      return;
    }
    event.preventDefault();
    toggleBacklog(true);
  }

  /** Lights a stage-menu word, or puts it out. */
  function markMenuItem(id, on) {
    document.getElementById(id)?.classList.toggle("is-active", Boolean(on));
  }

  /**
   * Brings the stage menu's selected words up to date.
   *
   * The menu says which of its toggles are on, and which panel is currently
   * covering the scene, so the words and the state is consistent. It is
   * called after anything that could change either — never on a timer.
   *
   * 存档 is also greyed while there is no position to save: a run parked inside a
   * function or a `cue` block is not one a save can resume at, and a word that
   * looks available but only ever answers with an error is worse than one that
   * says so up front.
   */
  function refreshMenu() {
    const stage = getStage();
    const slotView = getSlotView();
    markMenuItem("stage-auto", stage?.getAuto());
    markMenuItem("stage-skip", stage?.getSkip());
    markMenuItem("stage-fullscreen", windowFullscreen);
    markMenuItem("stage-backlog", backlogOpen);
    markMenuItem("stage-save", slotView?.mode === "save");
    markMenuItem("stage-load", slotView?.mode === "load");
    markMenuItem("stage-settings", getSettingsPanel()?.isOpen());

    const save = /** @type {HTMLButtonElement | null} */ (document.getElementById("stage-save"));
    if (save) {
      const savable = Boolean(session.running && session.node?.canSave);
      save.disabled = !savable;
      save.title = "存档";
    }
  }

  /** Toggles auto mode and reflects it on the stage menu. */
  function toggleAuto() {
    const stage = getStage();
    if (!stage) {
      return;
    }
    stage.setAuto(!stage.getAuto());
    refreshMenu();
  }

  /** Toggles skip (fast-forward) and reflects it on the stage menu. */
  function toggleSkip() {
    const stage = getStage();
    if (!stage) {
      return;
    }
    stage.toggleSkip();
    refreshMenu();
  }

  /**
   * Opens the settings panel over the scene.
   *
   * The panel is a layer of the stage rather than a window-wide dialog: it is
   * reached from the stage's own menu, and it carries one section — the mode the
   * dialogue box writes its lines out in — with its options and nothing else. Any
   * explanation belongs in 帮助, not in the middle of a performance.
   */
  function openSettings() {
    const settingsPanel = getSettingsPanel();
    if (!session.project) {
      setMessage("还没有打开项目", { error: true });
      return;
    }
    if (!settingsPanel) {
      setMessage("舞台不可用", { error: true });
      return;
    }
    settingsPanel.open({ value: session.project.typewriter || "off" });
    refreshMenu();
  }

  /** Closes the settings panel with the stage it is drawn on. */
  function closeSettings() {
    getSettingsPanel()?.close();
  }

  /**
   * Applies a picked typewriter mode.
   *
   * It is a project-level default, so it is written to `pamela.json` through the
   * backend and then handed to the stage immediately: the next line uses it
   * without waiting for a re-run. A style file naming its own `text.typeSpeed`
   * still wins for the lines it styles.
   *
   * @param {string} value
   */
  async function applyTypewriter(value) {
    if (!session.project || value === (session.project.typewriter || "off")) {
      return;
    }
    try {
      session.project = await getActions().setTypewriter(value);
      getStage()?.setTypewriter(value);
      // Redrawn on the new value, but only while it is still up: the write is a
      // round trip, and the panel may have been dismissed (or the stage dropped)
      // in the meantime.
      const settingsPanel = getSettingsPanel();
      if (settingsPanel?.isOpen()) {
        settingsPanel.open({ value });
      }
      setMessage(`文本逐字显示模式：${typewriterLabel(value)}`);
    } catch (error) {
      setMessage(describeError(error), { error: true });
    }
  }

  /**
   * Puts the stage on the whole screen, shell hidden.
   *
   * Two things have to happen together, and either one alone is wrong:
   *
   * - The window goes fullscreen, through the host (`set_fullscreen`). The
   *   webview's own `requestFullscreen()` only fills the webview, which leaves the
   *   taskbar painting over the bottom of the stage — a strip of desktop showing
   *   through the scene. Asking Windows for the monitor is what actually covers it.
   * - The shell is hidden (`.is-stage-fullscreen`), so it is the *stage* that
   *   is fullscreen and not the whole editor stretched across the display. Title
   *   bar, menu bar, resource panel, tabs and status bar are removed; only the scene is
   *   left.
   *
   * Entered from the stage's 全屏 word or the F11 key. No-op while the stage is
   * not on screen — there is nothing to fill the monitor with.
   */
  async function toggleFullscreen() {
    const target = dom.stageView;
    if (!target || target.hidden) {
      return;
    }
    const chrome = getChrome();
    if (!chrome) {
      setMessage("后端未连接，全屏不可用", { error: true });
      return;
    }
    windowFullscreen = await chrome.setFullscreen(!windowFullscreen);
    applyStageFullscreen(windowFullscreen);
    refreshMenu();
  }

  /**
   * Shows or hides the editor shell around the stage.
   *
   * Separate from the window call so the two cannot drift: whatever asks for the
   * window to go fullscreen also asks for the shell to go away, and leaving
   * fullscreen (by any route) puts the shell back.
   *
   * @param {boolean} on
   */
  function applyStageFullscreen(on) {
    const app = document.querySelector(".app");
    app?.classList.toggle("is-stage-fullscreen", Boolean(on));
    // Nothing else to do: the stage watches its own surface with a
    // `ResizeObserver`, so the meshes are re-drawn against the new frame size the
    // moment the class change gives it one.
  }

  return {
    isBacklogOpen: () => backlogOpen,
    isFullscreen: () => windowFullscreen,
    /** Records the host's answer, e.g. after the platform left fullscreen. */
    setFullscreen: (on) => {
      windowFullscreen = Boolean(on);
    },
    renderBacklog,
    toggleBacklog,
    wheelClosesBacklogAtTop,
    onStageWheel,
    refreshMenu,
    toggleAuto,
    toggleSkip,
    openSettings,
    closeSettings,
    applyTypewriter,
    toggleFullscreen,
    applyStageFullscreen,
  };
}
