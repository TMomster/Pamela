// @ts-check
// 资源栏分隔条：拖动宽度、键盘微调与折叠。
// Pamela — the resource panel's splitter.

import { clampResourceWidth, DEFAULT_RESOURCE_WIDTH, widthFromDrag } from "./layout.js";
import { createIcon } from "./icons.js";

const RESOURCE_WIDTH_VAR = "--pamela-resource-width";

/** The panel width currently in effect, from the CSS variable. */
export function currentResourceWidth() {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(RESOURCE_WIDTH_VAR),
  );
  return Number.isFinite(value) ? value : DEFAULT_RESOURCE_WIDTH;
}

/**
 * Wires a splitter beside the resource panel.
 *
 * @param {HTMLElement} panel
 * @param {HTMLElement} splitter
 * @param {HTMLElement | null} [toggle] The collapse button in the panel header.
 * @returns {(width: number) => number} Applies a width and answers the clamped value.
 */
export function setupSplitter(panel, splitter, toggle = null) {
  const styles = document.documentElement.style;

  const apply = (width) => {
    const clamped = clampResourceWidth(width, window.innerWidth);
    styles.setProperty(RESOURCE_WIDTH_VAR, `${clamped}px`);
    return clamped;
  };

  apply(currentResourceWidth());

  // Collapsing is a class on the panel rather than a write to the width
  // variable, so the width the splitter dragged out is still there — unchanged
  // — the moment the panel comes back. The splitter itself goes away while
  // collapsed: there is nothing to resize down a strip.
  let collapsed = false;
  const setCollapsed = (next) => {
    collapsed = next;
    panel.classList.toggle("is-collapsed", collapsed);
    splitter.hidden = collapsed;
    if (!toggle) {
      return;
    }
    const label = collapsed ? "展开资源栏" : "折叠资源栏";
    toggle.replaceChildren(createIcon(collapsed ? "chevrons-right" : "chevrons-left"));
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  toggle?.addEventListener("click", () => setCollapsed(!collapsed));

  let drag = null;

  const finish = () => {
    if (!drag) {
      return;
    }
    drag = null;
    splitter.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
  };

  function onPointerMove(event) {
    if (drag) {
      apply(widthFromDrag(drag.startWidth, drag.startX, event.clientX, window.innerWidth));
    }
  }

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    drag = { startWidth: currentResourceWidth(), startX: event.clientX };
    splitter.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });

  const STEP = 16;
  splitter.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -STEP, ArrowRight: STEP }[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    apply(currentResourceWidth() + step);
  });

  return apply;
}
