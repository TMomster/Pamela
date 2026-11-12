// 覆盖在舞台上的设置面板。
// Pamela — the settings panel drawn over the stage.
// 档位设置属于演出参数，不属于编辑器配置。

import { createIcon } from "./icons.js";

/** The one section the panel offers. */
export const TEXT_SPEED_TITLE = "文本逐字显示模式";

/**
 * The typewriter modes, in the order the panel offers them.
 *
 * The values are the manifest's vocabulary (`pamela.json` → `typewriter`); the
 * labels are what a player reads. `off` is first because it is the default a new
 * project gets.
 */
export const TYPEWRITER_OPTIONS = Object.freeze([
  { value: "off", label: "关闭" },
  { value: "fast", label: "快速" },
  { value: "medium", label: "中速" },
  { value: "slow", label: "慢速" },
]);

/** The label of a mode, for messages; the raw value when it is unknown. */
export function typewriterLabel(value) {
  return TYPEWRITER_OPTIONS.find((option) => option.value === value)?.label ?? String(value ?? "");
}

/**
 * Builds the panel inside `host` and answers the handle the stage wires to.
 *
 * @param {object} options
 * @param {HTMLElement} options.host `#stage-settings-panel`, inside the frame.
 * @param {(value: string) => void} [options.onChange] Called with the chosen
 *   mode; the panel does not write anything itself.
 * @param {() => void} [options.onClose]
 * @returns {{ element: HTMLElement, open: (view: { value: string }) => void,
 *   close: () => void, isOpen: () => boolean, value: () => string }}
 */
export function createStageSettings({ host, onChange = () => {}, onClose = () => {} }) {
  if (!host) {
    throw new Error("createStageSettings 需要一个容器");
  }

  /** The view on screen — `{ value }` — or `null` while closed. */
  let view = null;

  const close = () => {
    const wasOpen = Boolean(view);
    view = null;
    host.hidden = true;
    host.replaceChildren();
    if (wasOpen) {
      onClose();
    }
  };

  const draw = (current) => {
    const panel = document.createElement("div");
    panel.className = "stage-settings__panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "设置");

    const head = document.createElement("div");
    head.className = "stage-settings__head";

    const title = document.createElement("span");
    title.className = "stage-settings__title";
    title.textContent = "设置";

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "stage-settings__close";
    dismiss.title = "关闭";
    dismiss.setAttribute("aria-label", "关闭");
    dismiss.append(createIcon("close"));
    dismiss.addEventListener("click", close);

    head.append(title, dismiss);
    panel.append(head);

    const body = document.createElement("div");
    body.className = "stage-settings__body";

    const section = document.createElement("h3");
    section.className = "stage-settings__section";
    section.textContent = TEXT_SPEED_TITLE;

    const options = document.createElement("div");
    options.className = "stage-settings__options";
    options.setAttribute("role", "radiogroup");
    options.setAttribute("aria-label", TEXT_SPEED_TITLE);

    for (const option of TYPEWRITER_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stage-settings__option";
      button.dataset.value = option.value;
      button.textContent = option.label;
      button.setAttribute("role", "radio");
      const isCurrent = option.value === current.value;
      button.setAttribute("aria-checked", String(isCurrent));
      button.classList.toggle("is-active", isCurrent);
      button.addEventListener("click", () => {
        if (option.value === current.value) {
          return;
        }
        onChange(option.value);
      });
      options.append(button);
    }

    body.append(section, options);
    panel.append(body);

    host.replaceChildren(panel);
    host.hidden = false;
  };

  return {
    element: host,
    /** Opens the panel on `{ value }`, or redraws it when already open. */
    open: (next) => {
      view = next;
      draw(next);
    },
    close,
    isOpen: () => Boolean(view),
    value: () => view?.value ?? "off",
  };
}
