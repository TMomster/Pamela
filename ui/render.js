// 菜单栏与资源树的 DOM 渲染。
// Pamela — DOM rendering for the menu bar and the resource tree.
// 目录排在文件之前，各自按字母序排列。

import { isEnabled, MENUS, TOOLBAR_ACTIONS } from "./menus.js";

/**
 * Builds the menu bar.
 *
 * Behaviour:
 *  - click a title to open its menu, click again to close
 *  - hovering another title while a menu is open switches to it
 *  - Escape closes, arrow keys move between titles
 *  - clicking anywhere else closes
 *
 * @param {object} options
 * @param {(command: string) => void} options.onCommand
 * @returns {{ element: HTMLElement, setContext: (context: object) => void, close: () => void }}
 */
export function createMenuBar({ onCommand }) {
  const element = document.createElement("div");
  element.className = "menubar";
  element.setAttribute("role", "menubar");

  let openMenuId = null;
  let context = {};
  /** @type {Map<string, {title: HTMLButtonElement, popup: HTMLElement}>} */
  const parts = new Map();
  /** Nested popups, closed together with the menu that owns them. */
  const submenus = [];

  const close = () => {
    for (const submenu of submenus) {
      submenu.hide();
    }
    if (openMenuId === null) {
      return;
    }
    const part = parts.get(openMenuId);
    part?.popup.classList.remove("is-open");
    part?.title.setAttribute("aria-expanded", "false");
    openMenuId = null;
  };

  const open = (id) => {
    if (openMenuId === id) {
      return;
    }
    close();
    const part = parts.get(id);
    if (!part) {
      return;
    }
    part.popup.classList.add("is-open");
    part.title.setAttribute("aria-expanded", "true");
    openMenuId = id;
  };

  const applyContext = () => {
    for (const [id, part] of parts) {
      const menu = MENUS.find((entry) => entry.id === id);
      if (!menu) {
        continue;
      }
      // `items` is walked by the nodes built from it, not by position. A
      // separator takes a slot in `items` but builds no `.menu__item`, so
      // indexing `querySelectorAll(".menu__item")` with an item's index drifts
      // by one at every separator: entries after one read a neighbour's state,
      // and entries near the end run off the list and are never updated at all
      // — which is how an item could stay greyed out no matter what.
      for (const [node, item] of part.commands) {
        const enabled = isEnabled(item.command, context);
        node.classList.toggle("is-disabled", !enabled);
        node.setAttribute("aria-disabled", String(!enabled));
        if (item.checkable) {
          const checked = context[item.group] === item.value;
          node.classList.toggle("is-checked", checked);
          node.setAttribute("aria-checked", String(checked));
        }
      }
    }
  };

  for (const menu of MENUS) {
    const wrap = document.createElement("div");
    wrap.className = "menubar__menu";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "menubar__title";
    title.textContent = menu.label;
    title.setAttribute("aria-haspopup", "true");
    title.setAttribute("aria-expanded", "false");

    const popup = document.createElement("div");
    popup.className = "menu";
    popup.setAttribute("role", "menu");

    // The items that became nodes, paired with the item they came from. Built
    // here rather than re-derived from the DOM later, because a separator is an
    // item without a node and any index-based pairing would drift at each one.
    const commands = [];

    /** Builds one clickable row; top-level items and submenu children share it. */
    const makeItem = (item) => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "menu__item";
      node.setAttribute("role", item.checkable ? "menuitemradio" : "menuitem");

      // The label stays the first child: that is how the menu bar's tests and
      // the accelerator layout find it without another lookup.
      const label = document.createElement("span");
      label.className = "menu__label";
      label.textContent = item.label;
      node.append(label);

      if (item.accelerator) {
        const accelerator = document.createElement("span");
        accelerator.className = "menu__accelerator";
        accelerator.textContent = item.accelerator;
        node.append(accelerator);
      }
      if (item.checkable) {
        const mark = document.createElement("span");
        mark.className = "menu__check";
        mark.textContent = "✓";
        mark.setAttribute("aria-hidden", "true");
        node.append(mark);
      }

      node.addEventListener("click", () => {
        if (node.classList.contains("is-disabled")) {
          return;
        }
        close();
        onCommand(item.command, item);
      });

      if (item.command) {
        commands.push([node, item]);
      }
      return node;
    };

    /** A separator, drawn in whichever popup the item belongs to. */
    const makeSeparator = () => {
      const separator = document.createElement("div");
      separator.className = "menu__separator";
      separator.setAttribute("role", "separator");
      return separator;
    };

    for (const item of menu.items) {
      if (item.separator) {
        popup.append(makeSeparator());
        continue;
      }

      if (item.submenu) {
        const wrap = document.createElement("div");
        wrap.className = "menu__submenu";

        const parent = document.createElement("button");
        parent.type = "button";
        parent.className = "menu__item menu__item--parent";
        parent.setAttribute("role", "menuitem");
        parent.setAttribute("aria-haspopup", "menu");
        parent.setAttribute("aria-expanded", "false");
        // A submenu parent has no command, so it is always available; give it
        // the same attribute the command rows get from `applyContext`.
        parent.setAttribute("aria-disabled", "false");
        const label = document.createElement("span");
        label.className = "menu__label";
        label.textContent = item.label;
        const caret = document.createElement("span");
        caret.className = "menu__caret";
        caret.textContent = "›";
        caret.setAttribute("aria-hidden", "true");
        parent.append(label, caret);

        const sub = document.createElement("div");
        sub.className = "menu menu--sub";
        sub.setAttribute("role", "menu");
        sub.hidden = true;
        for (const child of item.submenu) {
          sub.append(child.separator ? makeSeparator() : makeItem(child));
        }

        const hide = () => {
          sub.hidden = true;
          parent.setAttribute("aria-expanded", "false");
        };
        const show = () => {
          sub.hidden = false;
          parent.setAttribute("aria-expanded", "true");
        };
        wrap.addEventListener("mouseenter", show);
        wrap.addEventListener("mouseleave", hide);
        parent.addEventListener("click", (event) => {
          event.stopPropagation();
          if (sub.hidden) {
            show();
          } else {
            hide();
          }
        });
        wrap.append(parent, sub);
        popup.append(wrap);
        submenus.push({ hide });
        continue;
      }

      popup.append(makeItem(item));
    }

    title.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openMenuId === menu.id) {
        close();
      } else {
        open(menu.id);
      }
    });

    // Moving across titles with a menu already open switches menus, which is
    // how every desktop menu bar behaves.
    title.addEventListener("mouseenter", () => {
      if (openMenuId !== null && openMenuId !== menu.id) {
        open(menu.id);
      }
    });

    title.addEventListener("keydown", (event) => {
      const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (offset === undefined) {
        return;
      }
      event.preventDefault();
      const ids = [...parts.keys()];
      const next = ids[(ids.indexOf(menu.id) + offset + ids.length) % ids.length];
      parts.get(next)?.title.focus();
      if (openMenuId !== null) {
        open(next);
      }
    });

    wrap.append(title, popup);
    element.append(wrap);
    parts.set(menu.id, { title, popup, commands });
  }

  // 帮助 / 关于: a title that runs its command instead of opening a popup, so the
  // reader is one click away from anywhere. They are appended after the menus and
  // stay outside `parts`, since there is no popup to open or close.
  for (const action of TOOLBAR_ACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menubar__title menubar__title--action";
    button.textContent = action.label;
    button.title = action.title;
    button.setAttribute("data-command", action.command);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      onCommand(action.command);
    });
    element.append(button);
  }

  // A click elsewhere in the window closes the open menu. `stopPropagation` on
  // the titles keeps this from firing for them.
  document.addEventListener("click", close);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });

  applyContext();

  return {
    element,
    setContext: (next) => {
      context = next;
      applyContext();
    },
    close,
  };
}

/**
 * Renders a resource tree from the project returned by the backend.
 *
 * @param {object} options
 * @param {Array<object>} options.nodes Nodes as returned by the backend.
 * @param {string} [options.entry] The manifest's entry path, marked in the tree.
 * @param {(node: object) => void} options.onOpenFile
 * @param {Set<string>} [options.expanded] Folder paths to draw open. The panel is
 *   rebuilt on every save and after every tree edit, so the caller carries the
 *   open folders across the rebuild; anything not in the set starts folded.
 * @returns {HTMLElement}
 */
export function createTree({ nodes, entry = "", onOpenFile, expanded = new Set() }) {
  const root = document.createElement("div");
  root.className = "tree";
  root.setAttribute("role", "tree");

  const render = (items, depth) => {
    const fragment = document.createDocumentFragment();

    for (const item of items) {
      const row = document.createElement("div");
      row.className = `tree__row tree__row--${item.is_dir ? "dir" : "file"}`;
      if (item.is_script) {
        row.classList.add("tree__row--script");
      }
      row.setAttribute("role", "treeitem");
      row.style.setProperty("--depth", String(depth));
      row.dataset.path = item.path;
      row.title = item.path;

      // Every file can be dragged into an editor. A picture under `assets/`
      // travels as its path relative to `assets/` — `Character/ori/si.png` —
      // so a file kept in a sub-folder can be named by the call it lands in. A
      // file elsewhere keeps its bare name. A drop on a call joins its arguments;
      // anywhere else in the code the name is written in at the pointer; a file
      // field in the node map takes it as the value.
      if (!item.is_dir) {
        row.draggable = true;
        row.addEventListener("dragstart", (event) => {
          const full = String(item.path ?? "").replace(/\\/g, "/");
          const text = full.startsWith("assets/")
            ? full.slice("assets/".length)
            : (item.name ?? full.split("/").pop() ?? "");
          event.dataTransfer?.setData("text/plain", text);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "copy";
          }
        });
      }

      if (item.is_dir) {
        // A folder is drawn open only when it was open before the rebuild; a
        // project's tree starts with every directory shut, so the panel lists
        // only the top level until the author opens one.
        row.setAttribute("aria-expanded", expanded.has(item.path) ? "true" : "false");
      }
      // Every row is focusable so the panel's keyboard shortcuts (copy, paste,
      // delete, undo) can act on the selection; directories used to be skipped,
      // which left them un-deletable by key.
      row.tabIndex = 0;

      const twisty = document.createElement("span");
      twisty.className = "tree__twisty";
      twisty.setAttribute("aria-hidden", "true");

      const label = document.createElement("span");
      label.className = "tree__label";
      label.textContent = item.name;

      row.append(twisty, label);

      // The entry is the script the project opens first. It is marked so a
      // project that has been given one reads differently from one that is
      // still falling back to the first script in the tree.
      if (!item.is_dir && entry && item.path === entry) {
        row.classList.add("is-entry");
        const badge = document.createElement("span");
        badge.className = "tree__entry-badge";
        badge.textContent = "入口";
        badge.title = "项目入口脚本";
        row.append(badge);
      }

      if (item.is_dir) {
        // Wrapped in a group so the collapsed state can hide the children with
        // a sibling selector, keeping the markup and CSS in step.
        const group = document.createElement("div");
        group.className = "tree__group";
        group.append(render(item.children ?? [], depth + 1));
        fragment.append(row, group);
      } else {
        fragment.append(row);
      }
    }

    return fragment;
  };

  root.addEventListener("click", (event) => {
    const target = event.target;
    const row = target instanceof Element ? target.closest(".tree__row") : null;
    if (!row || !root.contains(row)) {
      return;
    }

    for (const selected of root.querySelectorAll(".tree__row.is-selected")) {
      selected.classList.remove("is-selected");
    }
    row.classList.add("is-selected");

    if (row.classList.contains("tree__row--dir")) {
      const expanded = row.getAttribute("aria-expanded") === "true";
      row.setAttribute("aria-expanded", expanded ? "false" : "true");
      // Keep focus in the tree so Delete / Ctrl+Z act on this folder.
      row.focus();
      return;
    }

    onOpenFile({ name: row.querySelector(".tree__label")?.textContent ?? "", path: row.dataset.path });
    // Re-focus the row after opening: the editor is now visible but the tree keeps
    // focus, so the new file can be deleted or copied from the keyboard at once.
    row.focus();
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const target = event.target;
    const row = target instanceof Element ? target.closest(".tree__row") : null;
    if (row) {
      event.preventDefault();
      row.click();
    }
  });

  const contents = render(nodes, 0);
  if (!nodes.length) {
    const empty = document.createElement("p");
    empty.className = "tree__empty";
    empty.textContent = "项目为空";
    root.append(empty);
  } else {
    root.append(contents);
  }

  return root;
}
