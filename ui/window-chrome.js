// 自定义标题栏状态与 IPC 桥。
// Pamela — custom title bar state and IPC bridge.
// F11 由应用接管，避免与 WebView 绑定冲突。
/**
 * Resolves the IPC bridge.
 *
 * `window.__TAURI_INTERNALS__.invoke` is injected into every Tauri webview and
 * is the very entry point the packaged API module wraps. This editor ships
 * without that module (no bundler, `withGlobalTauri` off), so asking for it
 * first only produced a failed request on every launch; the module is now the
 * fallback, kept for a future bundled build.
 *
 * @param {object} [options]
 * @param {object} [options.internals] `window.__TAURI_INTERNALS__`, if present.
 * @param {(specifier: string) => Promise<object>} [options.importModule] Module loader.
 * @param {(error: unknown) => void} [options.onWarning]
 * @returns {Promise<((command: string, args?: object) => Promise<unknown>) | null>}
 */

export async function createInvoke({
  internals = globalThis.window?.__TAURI_INTERNALS__,
  importModule = (specifier) => import(specifier),
  onWarning = () => {},
} = {}) {
  if (typeof internals?.invoke === "function") {
    return (command, args) => internals.invoke(command, args);
  }

  try {
    const api = await importModule("@tauri-apps/api/core");
    if (typeof api?.invoke === "function") {
      return (command, args) => api.invoke(command, args);
    }
  } catch (error) {
    onWarning(error);
  }

  return null;
}

/** Commands issued by the caption buttons, in the order they appear. */
export const WINDOW_COMMANDS = Object.freeze({
  minimize: "minimize",
  toggleMaximize: "toggle_maximize",
  close: "close",
  isMaximized: "is_maximized",
  // The OS's own fullscreen, not the webview's Fullscreen API — see
  // `setFullscreen` below for why the two are not interchangeable.
  setFullscreen: "set_fullscreen",
  isFullscreen: "is_fullscreen",
});

/**
 * Wraps a raw `invoke` so command failures are reported instead of becoming
 * unhandled rejections, and records the last observed maximise state.
 *
 * @param {object} options
 * @param {(command: string, args?: object) => Promise<unknown>} options.invoke
 * @param {(maximized: boolean) => void} [options.onMaximizedChange]
 * @param {(message: string, error: unknown) => void} [options.onError]
 */
export function createWindowChrome({
  invoke,
  onMaximizedChange = () => {},
  onError = () => {},
}) {
  let maximized = false;

  const run = (command, args) => {
    try {
      return Promise.resolve(invoke(command, args)).catch((error) => {
        onError(`${command} failed`, error);
      });
    } catch (error) {
      onError(`${command} failed`, error);
      return Promise.resolve();
    }
  };

  const syncMaximized = async () => {
    try {
      const value = await invoke(WINDOW_COMMANDS.isMaximized);
      maximized = Boolean(value);
      onMaximizedChange(maximized);
    } catch (error) {
      onError("could not read the maximised state", error);
    }
    return maximized;
  };

  const toggleMaximize = async () => {
    await run(WINDOW_COMMANDS.toggleMaximize);
    return syncMaximized();
  };

  /**
   * Puts the window into real fullscreen, or takes it out again.
   *
   * This goes through the host rather than through `element.requestFullscreen()`
   * on purpose. The webview's Fullscreen API only makes an element fill the
   * webview: the window keeps its frame and the taskbar keeps painting on top
   * of it, so the bottom of the stage shows a strip of desktop. The host's
   * `set_fullscreen` asks Windows for the monitor instead, which is what a
   * player means by "全屏".
   *
   * @param {boolean} on
   * @returns {Promise<boolean>} The state the window reports afterwards.
   */
  const setFullscreen = async (on) => {
    const value = await run(WINDOW_COMMANDS.setFullscreen, { fullscreen: Boolean(on) });
    return Boolean(value);
  };

  /** Reads the window's current fullscreen state, for the menu on start-up. */
  const syncFullscreen = async () => {
    try {
      return Boolean(await invoke(WINDOW_COMMANDS.isFullscreen));
    } catch (error) {
      onError("could not read the fullscreen state", error);
      return false;
    }
  };

  return {
    minimize: () => run(WINDOW_COMMANDS.minimize),
    close: () => run(WINDOW_COMMANDS.close),
    toggleMaximize,
    syncMaximized,
    isMaximized: () => maximized,
    setFullscreen,
    syncFullscreen,
  };
}
