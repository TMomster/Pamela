// 播放器模式的开始画面：黑屏 + 播放按钮，等待一次左键点击或空格。
// Pamela — the player's start gate: a black screen with a play button, waiting
// for one left click or a press of Space.

import { createIcon } from "./icons.js";

/** The line under the play button. */
export const PLAYER_START_HINT = "点击鼠标左键或空格键开始播放";

/**
 * Builds the start gate over the stage.
 *
 * The gate owns its own listeners rather than borrowing the stage's: the stage
 * only answers Space while a line is waiting for a click, and before a run
 * starts there is no line. Both listeners are removed as soon as the gate
 * closes, so a Space typed in the editor can never reach a run that has ended.
 *
 * @param {object} options
 * @param {HTMLElement} options.host Element the gate covers.
 * @param {() => void} [options.onStart] Called once, after the gate closes.
 * @returns {{ element: HTMLElement, open: () => void, close: () => void, isOpen: () => boolean }}
 */
export function createPlayerStart({ host, onStart = () => {} }) {
  if (!host) {
    throw new Error("播放器开始画面缺少容器");
  }

  const element = document.createElement("div");
  element.className = "player-start";
  element.hidden = true;
  element.setAttribute("aria-label", "开始播放");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "player-start__button";
  button.setAttribute("aria-label", "开始播放");
  button.append(createIcon("play"));

  const hint = document.createElement("p");
  hint.className = "player-start__hint";
  hint.textContent = PLAYER_START_HINT;

  element.append(button, hint);
  host.append(element);
  // The whole black screen answers a primary click, not just the play button:
  // "随意点击一下" is deliberately forgiving about where the pointer lands.
  element.addEventListener("click", onClick);

  let open = false;
  let starting = false;

  function close() {
    open = false;
    element.hidden = true;
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function start() {
    if (!open || starting) {
      return;
    }
    starting = true;
    close();
    onStart();
  }

  function onClick(event) {
    // "随意点击一下" means a primary click anywhere on the black screen; a
    // right click belongs to the context menu and must not start the run.
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    start();
  }

  function onKeyDown(event) {
    if (!open || event.defaultPrevented || event.repeat) {
      return;
    }
    if (event.key !== " " && event.key !== "Spacebar" && event.code !== "Space") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    start();
  }

  return {
    element,
    open() {
      if (open) {
        return;
      }
      open = true;
      starting = false;
      element.hidden = false;
      document.addEventListener("keydown", onKeyDown, true);
      button.focus?.();
    },
    close,
    isOpen: () => open,
  };
}
