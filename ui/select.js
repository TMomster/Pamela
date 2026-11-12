// 下拉选择控件。
// Pamela — the dropdown.

import { createIcon } from "./icons.js";

/**
 * One option, whatever shape it arrived in.
 *
 * @param {string | {value?: string, label?: string}} option
 * @returns {{ value: string, label: string }}
 */
function normaliseOption(option) {
  if (typeof option === "string") {
    return { value: option, label: option };
  }
  const value = String(option?.value ?? option?.label ?? "");
  return { value, label: String(option?.label ?? option?.value ?? "") };
}

/**
 * Builds a dropdown.
 *
 * @param {object} [options]
 * @param {Array<string | {value: string, label: string}>} [options.options]
 * @param {string} [options.value] The option that starts picked.
 * @param {string} [options.className] Extra classes for the button.
 * @param {string} [options.label] Accessible name; also the tooltip.
 * @returns {HTMLButtonElement} A button carrying a `value` property of its own.
 */
export function createSelect({ options = [], value = "", className = "", label = "" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className ? `select ${className}` : "select";
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  if (label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  const text = document.createElement("span");
  text.className = "select__value";
  button.append(text);
  const arrow = createIcon("chevron-down");
  if (arrow) {
    arrow.classList.add("select__arrow");
    button.append(arrow);
  }

  const items = options.map(normaliseOption);
  let current = String(value ?? "");
  let popup = null;
  let active = -1;

  const sync = () => {
    const match = items.find((item) => item.value === current);
    text.textContent = match ? match.label : "";
  };
  sync();

  // The `<select>` contract, kept: a caller may still write `element.value = x`
  // and read it back after a `change`.
  Object.defineProperty(button, "value", {
    configurable: true,
    get: () => current,
    set: (next) => {
      current = String(next ?? "");
      sync();
    },
  });

  /** Highlights one row of the open list, keeping it in view. */
  const setActive = (index) => {
    if (!popup) {
      return;
    }
    const rows = popup.children;
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle("is-active", i === index);
    }
    active = index;
    rows[index]?.scrollIntoView?.({ block: "nearest" });
  };

  const move = (delta) => {
    if (!items.length) {
      return;
    }
    const count = items.length;
    setActive(((active < 0 ? 0 : active) + delta + count) % count);
  };

  const choose = (item) => {
    const changed = item.value !== current;
    current = item.value;
    sync();
    close();
    button.focus();
    if (changed) {
      button.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  /** Places the list under the button, flipping above it near the bottom edge. */
  const position = () => {
    if (!popup) {
      return;
    }
    const rect = button.getBoundingClientRect();
    popup.style.minWidth = `${Math.round(Math.max(120, rect.width))}px`;
    popup.style.left = `${Math.round(rect.left)}px`;
    const height = popup.offsetHeight;
    const below = rect.bottom + 4;
    const above = rect.top - height - 4;
    const flip = below + height > window.innerHeight - 8 && above > 8;
    popup.style.top = `${Math.round(flip ? above : below)}px`;
  };

  function close() {
    if (!popup) {
      return;
    }
    popup.remove();
    popup = null;
    active = -1;
    button.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", onScroll, true);
  }

  function onOutside(event) {
    if (popup?.contains(event.target) || button.contains(event.target)) {
      return;
    }
    close();
  }

  function onScroll(event) {
    // Scrolling the list itself is not a reason to shut it. The target of a
    // document-level scroll can be the document, which `contains` cannot take.
    const target = event.target;
    if (popup && target?.nodeType === 1 && popup.contains(target)) {
      return;
    }
    close();
  }

  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (active >= 0 && active < items.length) {
        choose(items[active]);
      } else {
        close();
      }
      return;
    }
    if (event.key === "Tab") {
      close();
    }
  }

  const open = () => {
    if (popup || !items.length) {
      return;
    }
    popup = document.createElement("div");
    popup.className = "select-popup";
    popup.setAttribute("role", "listbox");
    items.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "select-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(item.value === current));
      if (item.value === current) {
        row.classList.add("is-selected");
      }
      row.textContent = item.label;
      row.addEventListener("pointerenter", () => setActive(index));
      row.addEventListener("click", () => choose(item));
      popup.append(row);
    });
    document.body.append(popup);
    position();
    button.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");
    setActive(Math.max(0, items.findIndex((item) => item.value === current)));
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
  };

  button.addEventListener("click", () => {
    if (popup) {
      close();
    } else {
      open();
    }
  });

  // A closed dropdown still answers the keys a `<select>` would: Down/Enter
  // open it. Once open, `onKey` has them.
  button.addEventListener("keydown", (event) => {
    if (popup) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });

  return button;
}

/**
 * Turns a text box into a filtered dropdown.
 *
 * The box stays a box: a name that is not in the folder yet — a picture about to
 * be added — is still allowed, which is why this is not a `<select>`. What the
 * list replaces is the webview's own `<datalist>` popup, which is a system menu
 * with its own type scale and no way to style it; this one is the same list the
 * dropdowns above draw, filtered by what has been typed.
 *
 * @param {HTMLInputElement} input The field to attach to; changed in place.
 * @param {string[]} options Values the list offers.
 * @param {object} [settings]
 * @param {string} [settings.label] Accessible name.
 * @returns {HTMLInputElement} The same input.
 */
export function attachCombo(input, options = [], { label = "" } = {}) {
  const all = options.map((option) => String(option));
  input.classList.add("combo");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-expanded", "false");
  input.autocomplete = "off";
  if (label) {
    input.setAttribute("aria-label", label);
  }

  let popup = null;
  let active = -1;
  let shown = all;

  /** Puts the list under the field, flipping above it near the bottom edge. */
  const position = () => {
    if (!popup) {
      return;
    }
    const rect = input.getBoundingClientRect();
    popup.style.minWidth = `${Math.round(Math.max(140, rect.width))}px`;
    popup.style.left = `${Math.round(rect.left)}px`;
    const height = popup.offsetHeight;
    const below = rect.bottom + 4;
    const above = rect.top - height - 4;
    const flip = below + height > window.innerHeight - 8 && above > 8;
    popup.style.top = `${Math.round(flip ? above : below)}px`;
  };

  const setActive = (index) => {
    if (!popup) {
      return;
    }
    const rows = popup.children;
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle("is-active", i === index);
    }
    active = index;
    rows[index]?.scrollIntoView?.({ block: "nearest" });
  };

  const move = (delta) => {
    if (!shown.length) {
      return;
    }
    const count = shown.length;
    setActive(((active < 0 ? 0 : active) + delta + count) % count);
  };

  const choose = (value) => {
    // Both events, in the order a typed value produces them: the field's own
    // listeners (`input`) and the ones that commit the change (`change`).
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
    input.focus();
  };

  function close() {
    if (!popup) {
      return;
    }
    popup.remove();
    popup = null;
    active = -1;
    input.classList.remove("is-open");
    input.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", onScroll, true);
  }

  function onOutside(event) {
    // The box itself is not "outside": pressing in it again would close the list
    // and the click that follows would open it, which reads as a flicker.
    if (popup?.contains(event.target) || input.contains(event.target)) {
      return;
    }
    close();
  }

  function onScroll(event) {
    const target = event.target;
    if (popup && target?.nodeType === 1 && popup.contains(target)) {
      return;
    }
    close();
  }

  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!popup) {
        open();
        return;
      }
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && popup) {
      event.preventDefault();
      event.stopPropagation();
      if (active >= 0 && active < shown.length) {
        choose(shown[active]);
      } else {
        close();
      }
      return;
    }
    if (event.key === "Tab") {
      close();
    }
  }

  /** Rebuilds the rows for what is currently typed. */
  const fill = () => {
    if (!popup) {
      return;
    }
    const needle = input.value.trim().toLowerCase();
    shown = needle ? all.filter((value) => value.toLowerCase().includes(needle)) : all;
    popup.replaceChildren();
    for (const value of shown) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "select-option";
      row.setAttribute("role", "option");
      if (value === input.value) {
        row.classList.add("is-selected");
        row.setAttribute("aria-selected", "true");
      }
      row.textContent = value;
      // The press must not take the focus from the box, or the list would close
      // underneath the pointer before the click lands.
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("pointerenter", () => setActive(shown.indexOf(value)));
      row.addEventListener("click", () => choose(value));
      popup.append(row);
    }
    position();
    // The first match is highlighted so Enter takes it: a typed prefix plus one
    // key is the fastest way through a folder of pictures.
    setActive(shown.length ? 0 : -1);
  };

  const open = () => {
    if (popup || !all.length) {
      return;
    }
    popup = document.createElement("div");
    popup.className = "select-popup";
    popup.setAttribute("role", "listbox");
    document.body.append(popup);
    input.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    fill();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
  };

  input.addEventListener("focus", () => open());
  input.addEventListener("click", () => open());
  // Typing narrows the list rather than closing it: the field is a filter as
  // well as a value.
  input.addEventListener("input", () => {
    if (popup) {
      fill();
    } else {
      open();
    }
  });

  return input;
}
