// 应用内右键菜单。
// Pamela — in-app context menu.
// 菜单项与 DOM 节点按 id 配对，不依赖位置。
/**
 * Opens a context menu at a viewport position.
 *
 * @param {object} options
 * @param {number} options.x Viewport x, usually the pointer position.
 * @param {number} options.y Viewport y.
 * @param {Array<{label?: string, command?: string, disabled?: boolean, separator?: boolean, fontFamily?: string, sample?: string}>} options.items
 *   Separators are drawn as-is; an item without a command still closes the menu
 *   when picked, which lets a caller use labels as no-op entries. `fontFamily`
 *   and `sample` turn an entry into a font preview: the label and the sample
 *   text are both drawn in that family, so the list shows the face itself.
 * @returns {Promise<string | null>} The chosen command, or `null` when dismissed.
 */

export function openContextMenu({ x, y, items }) {
  return new Promise((resolve) => {
    const menu = document.createElement("div");
    menu.className = "menu menu--context";
    menu.setAttribute("role", "menu");

    let settled = false;

    const close = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("wheel", onWheel, true);
      menu.remove();
      resolve(result);
    };

    /**
     * A wheel over the menu scrolls its list; a wheel anywhere else dismisses.
     *
     * The font picker can be taller than the window, so closing on every wheel
     * would make the families past the first screen unreachable.
     */
    function onWheel(event) {
      if (!menu.contains(event.target)) {
        close(null);
      }
    }

    function onPointerDown(event) {
      if (!menu.contains(event.target)) {
        close(null);
      }
    }

    function onDismiss() {
      close(null);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
        return;
      }

      const offset = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (offset === undefined) {
        return;
      }
      event.preventDefault();
      const enabled = menu.querySelectorAll(".menu__item:not(.is-disabled)");
      if (!enabled.length) {
        return;
      }
      const index = [...enabled].indexOf(document.activeElement);
      const next = enabled[(index + offset + enabled.length) % enabled.length];
      next.focus();
    }

    for (const item of items) {
      if (item.separator) {
        const separator = document.createElement("div");
        separator.className = "menu__separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu__item";
      button.setAttribute("role", "menuitem");

      if (item.sample) {
        // The name and the sample are two spans rather than one line of text:
        // the name stays the thing being picked while the sample is the preview
        // of how a Text would look in it.
        button.classList.add("menu__item--font");
        const label = document.createElement("span");
        label.className = "menu__label";
        label.textContent = item.label;
        if (item.fontFamily) {
          label.style.fontFamily = item.fontFamily;
        }
        const sample = document.createElement("span");
        sample.className = "menu__sample";
        sample.textContent = item.sample;
        if (item.fontFamily) {
          sample.style.fontFamily = item.fontFamily;
        }
        button.append(label, sample);
      } else {
        button.textContent = item.label;
      }

      if (item.disabled) {
        button.classList.add("is-disabled");
        button.setAttribute("aria-disabled", "true");
      } else {
        button.addEventListener("click", () => close(item.command ?? null));
      }

      menu.append(button);
    }

    document.body.append(menu);

    // Placed after mounting so the real size is known; the menu flips back from
    // the right and bottom edges rather than spilling off-screen.
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("wheel", onWheel, true);

    menu.querySelector(".menu__item:not(.is-disabled)")?.focus();
  });
}
