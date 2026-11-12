// 存读档插槽面板。
// Pamela — the save/load slot panel.

import { createIcon } from "./icons.js";
import { saveFilesIn } from "./save.js";

/** How many slots one page shows, in three columns of four. */
export const SLOT_COLUMNS = 3;
export const SLOT_ROWS = 4;
export const SLOTS_PER_PAGE = SLOT_COLUMNS * SLOT_ROWS;

/**
 * The number a slot is known by, counting from 1 across pages.
 *
 * A galgame numbers its slots rather than labelling them "空": the number is
 * what the player says out loud, so it is also what an empty slot shows.
 */
export function slotNumber(page, index) {
  return Math.max(0, page) * SLOTS_PER_PAGE + index + 1;
}

/** How many pages a list of saves needs, with at least one. */
export function pageCount(saves) {
  return Math.max(1, Math.ceil((saves ?? []).length / SLOTS_PER_PAGE));
}

/** The page a save at `index` in the list falls on. */
export function pageOf(index) {
  return Math.max(0, Math.floor(Number(index ?? 0) / SLOTS_PER_PAGE));
}

/**
 * One page of slots, padded to a full grid.
 *
 * A filled slot is `{ name, path, title, savedAt, thumbnail }` — what the panel
 * needs to draw it — and an empty one is `null`. The answer is always exactly
 * `SLOTS_PER_PAGE` long, so the grid keeps its shape whether the project has one
 * save or twenty.
 *
 * @param {Array<object | null>} saves
 * @param {number} [page] Zero-based.
 * @returns {Array<object | null>}
 */
export function pageSlots(saves, page = 0) {
  const start = Math.max(0, page) * SLOTS_PER_PAGE;
  const slots = [];
  for (let index = 0; index < SLOTS_PER_PAGE; index += 1) {
    slots.push(saves?.[start + index] ?? null);
  }
  return slots;
}

/**
 * The label a slot shows under its picture.
 *
 * A save carries the label it was written with; a file renamed on disk has none
 * that matches, so its slot name stands in rather than the slot reading empty.
 */
export function slotTitle(save) {
  const title = String(save?.title ?? "").trim();
  return title || String(save?.name ?? "").trim();
}

/**
 * A save's time as the panel writes it, in local time.
 *
 * A slot shows the minute it was written, because that is what a player uses to
 * tell two saves apart. A missing or unreadable stamp answers an empty string
 * rather than "Invalid Date" leaking into the grid.
 *
 * @param {string} iso
 * @returns {string} `2026-10-18 15:33`, or `""`.
 */
export function formatSavedAt(iso) {
  const date = new Date(String(iso ?? ""));
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The words on a slot's action row.
 *
 * Saving and loading share one grid, so what a click does is decided here rather
 * than by two separate panels: on a filled slot saving is an overwrite, on an
 * empty one it is a fresh write, and an empty slot has nothing to load.
 *
 * @param {"save" | "load"} mode
 * @param {boolean} filled
 * @returns {{ label: string, enabled: boolean }}
 */
export function slotAction(mode, filled) {
  if (mode === "load") {
    return filled ? { label: "读取", enabled: true } : { label: "空栏位", enabled: false };
  }
  return filled ? { label: "覆盖", enabled: true } : { label: "保存", enabled: true };
}

/**
 * Builds the panel over `host` and answers the handle the host wires to.
 *
 * There is one element for the whole application: opening the panel a second
 * time refills it rather than adding another, which is what "单例弹窗" means
 * here — the player can never end up with two grids stacked on the stage.
 *
 * @param {object} options
 * @param {HTMLElement} options.host `#slots-panel`, inside the stage frame.
 * @param {(mode: "save" | "load", save: object | null, page: number,
 *   index: number) => void} options.onPick Called with the slot the player
 *   chose; `save` is `null` for an empty one.
 * @param {(mode: "save" | "load", save: object, page: number,
 *   index: number) => void} [options.onDelete] Called when a filled slot's
 *   delete control is used; `save` is never `null` here.
 * @param {(page: number) => void} [options.onPage] Turns to another page.
 * @param {() => void} [options.onClose]
 * @returns {{ element: HTMLElement, open: (view: object) => void,
 *   refresh: (view: object) => void, close: () => void, isOpen: () => boolean }}
 */
export function createSlotPanel({ host, onPick, onPage = () => {}, onClose = () => {}, onDelete = () => {} }) {
  if (!host) {
    throw new Error("createSlotPanel 需要一个容器");
  }

  /** The view on screen — `{ mode, page, saves }` — or `null` while closed. */
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

  /** The header: what the panel is for, which page, and the way out. */
  const renderHead = (panel, current) => {
    const head = document.createElement("div");
    head.className = "slots__head";

    const title = document.createElement("span");
    title.className = "slots__title";
    title.textContent = current.mode === "save" ? "存档" : "读档";
    head.append(title);

    const pages = pageCount(current.saves);
    if (pages > 1) {
      const pager = document.createElement("span");
      pager.className = "slots__pager";

      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "slots__pager-button";
      prev.append(createIcon("chevron-left"));
      prev.title = "上一页";
      prev.disabled = current.page <= 0;
      prev.addEventListener("click", () => onPage(current.page - 1));

      const label = document.createElement("span");
      label.className = "slots__pager-label";
      label.textContent = `${current.page + 1} / ${pages}`;

      const next = document.createElement("button");
      next.type = "button";
      next.className = "slots__pager-button";
      next.append(createIcon("chevron-right"));
      next.title = "下一页";
      next.disabled = current.page >= pages - 1;
      next.addEventListener("click", () => onPage(current.page + 1));

      pager.append(prev, label, next);
      head.append(pager);
    }

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "slots__close";
    dismiss.title = "关闭";
    dismiss.setAttribute("aria-label", "关闭");
    dismiss.append(createIcon("close"));
    dismiss.addEventListener("click", () => close());
    head.append(dismiss);

    panel.append(head);
  };

  /** One slot: the picture, what it holds, and what a click would do. */
  const renderSlot = (grid, current, save, index) => {
    const number = slotNumber(current.page, index);
    const action = slotAction(current.mode, Boolean(save));

    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "slots__slot";
    if (!save) {
      slot.classList.add("slots__slot--empty");
    }
    slot.disabled = !action.enabled;
    slot.dataset.slot = String(number);
    const stamp = save ? formatSavedAt(save.savedAt) : "";
    slot.title = save
      ? [slotTitle(save), stamp].filter(Boolean).join("　")
      : `空栏位 ${number}`;

    // The picture. A save made before thumbnails existed has none, and an empty
    // slot has nothing at all; both draw a blank rather than a broken image, so
    // the grid keeps its rhythm instead of collapsing into text rows.
    const shot = document.createElement("span");
    shot.className = "slots__shot";
    if (save?.thumbnail) {
      const image = document.createElement("img");
      image.className = "slots__shot-image";
      image.alt = "";
      image.draggable = false;
      image.src = save.thumbnail;
      shot.append(image);
    } else {
      const blank = document.createElement("span");
      blank.className = "slots__shot-blank";
      blank.textContent = save ? "—" : String(number).padStart(2, "0");
      shot.append(blank);
    }

    // The words beside it: the save's own label, when it was written, and what
    // a click would do — the three things a player picks a slot by.
    const body = document.createElement("span");
    body.className = "slots__body";

    const name = document.createElement("span");
    name.className = "slots__name";
    name.textContent = save ? slotTitle(save) : "空栏位";
    body.append(name);

    const when = document.createElement("span");
    when.className = "slots__when";
    when.textContent = stamp || (save ? "" : `No. ${number}`);
    body.append(when);

    // What the click does, spelled out: "保存" on an empty slot, "覆盖" on a
    // filled one, "读取" when loading. It is a word, not a button — the whole
    // slot is the target. A slot with nothing to do says nothing, so an empty
    // row does not read "空栏位 / 空栏位".
    if (action.enabled) {
      const badge = document.createElement("span");
      badge.className = "slots__action";
      badge.textContent = action.label;
      body.append(badge);
    }

    slot.append(shot, body);
    // A filled slot carries a delete control. It is its own action, not a pick,
    // so its click stops before the slot's own handler — a stray click wipes a
    // position otherwise. It only appears on hover, keeping the grid about the
    // pictures until the player reaches for it.
    if (save) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "slots__delete";
      remove.title = "删除存档";
      remove.setAttribute("aria-label", "删除存档");
      remove.append(createIcon("close"));
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        onDelete(current.mode, save, current.page, index);
      });
      slot.append(remove);
    }
    slot.addEventListener("click", () => {
      if (action.enabled) {
        onPick(current.mode, save, current.page, index);
      }
    });

    grid.append(slot);
  };

  const draw = (current) => {
    const panel = document.createElement("div");
    panel.className = "slots__panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", current.mode === "save" ? "存档" : "读档");

    renderHead(panel, current);

    const grid = document.createElement("div");
    grid.className = "slots__grid";
    pageSlots(current.saves, current.page).forEach((save, index) => {
      renderSlot(grid, current, save, index);
    });
    panel.append(grid);

    host.replaceChildren(panel);
    host.hidden = false;
  };

  return {
    element: host,
    /** Opens the panel on `view`, or redraws it when it is already open. */
    open: (next) => {
      view = next;
      draw(next);
    },
    /** Redraws the open panel on a new view; a no-op while it is closed. */
    refresh: (next) => {
      if (!view) {
        return;
      }
      view = next;
      draw(next);
    },
    close,
    isOpen: () => Boolean(view),
  };
}
