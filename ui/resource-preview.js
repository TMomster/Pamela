// @ts-check
// 资源树悬停图片预览：单浮层、按路径缓存、跟随行位置。
// Pamela — the resource panel's hover preview.

import { isImagePath, isVideoPath } from "./project-actions.js";

/**
 * Creates the thumbnail shown beside a picture the pointer rests on.
 *
 * One floating box for the whole tree rather than one per row: the tree is
 * rebuilt on every save, and a box per row would be thrown away with it. The
 * pictures are cached by path, so running the pointer down a folder of sprites
 * costs one read each and nothing after that.
 *
 * @param {{ dom: Record<string, any>, getActions: () => any }} deps
 */
export function createResourcePreview({ dom, getActions }) {
  let box = null;
  let timer = 0;
  let currentRow = null;
  let project = null;
  const cache = new Map();

  function hide() {
    clearTimeout(timer);
    currentRow = null;
    box?.remove();
    box = null;
  }

  /** Puts the box beside the row, flipping it inwards at the window's edges. */
  function place(target, row) {
    const anchor = row.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    let left = anchor.right + 10;
    if (left + rect.width > window.innerWidth - 8) {
      left = Math.max(8, anchor.left - rect.width - 10);
    }
    let top = anchor.top - 4;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - rect.height - 8);
    }
    target.style.left = `${left}px`;
    target.style.top = `${top}px`;
  }

  async function show(row, path) {
    const actions = getActions();
    if (!actions) {
      return;
    }
    const video = isVideoPath(path);
    let url = cache.get(path);
    if (!url) {
      try {
        url = await (video ? actions.readVideo(path) : actions.readImage(path));
      } catch {
        return;
      }
      cache.set(path, url);
    }
    // The pointer may have moved on while the picture was being read.
    if (currentRow !== row) {
      return;
    }

    const element = document.createElement("div");
    element.className = "tree-preview";
    let media;
    if (video) {
      const clip = document.createElement("video");
      clip.muted = true;
      clip.autoplay = true;
      clip.loop = true;
      clip.playsInline = true;
      media = clip;
    } else {
      const picture = document.createElement("img");
      picture.alt = "";
      media = picture;
    }
    media.className = "tree-preview__image";
    media.src = url;
    const caption = document.createElement("span");
    caption.className = "tree-preview__caption";
    caption.textContent = path;
    element.append(media, caption);
    document.body.append(element);
    box = element;
    place(element, row);
    media.addEventListener(video ? "loadeddata" : "load", () => {
      if (box === element) {
        place(element, row);
      }
    });
  }

  /**
   * Drops the cache when the project changes.
   *
   * A different project's files may carry the same relative paths, so the
   * preview cache does not outlive the project it was filled from.
   *
   * @param {object | null} next
   */
  function sync(next) {
    if (next === project) {
      return;
    }
    project = next;
    cache.clear();
    hide();
  }

  /** Binds the pointer handlers to the resource tree. */
  function wire() {
    if (!dom.resourceBody) {
      return;
    }

    dom.resourceBody.addEventListener("pointerover", (event) => {
      const row = event.target?.closest?.(".tree__row--file");
      if (!row || !row.dataset.path || row === currentRow) {
        return;
      }
      hide();
      if (!isImagePath(row.dataset.path) && !isVideoPath(row.dataset.path)) {
        return;
      }
      currentRow = row;
      timer = setTimeout(() => {
        void show(row, row.dataset.path);
      }, 220);
    });

    dom.resourceBody.addEventListener("pointerout", (event) => {
      const row = event.target?.closest?.(".tree__row--file");
      if (!row) {
        return;
      }
      // Moving between the label and the badge of the same row is not leaving it.
      if (event.relatedTarget?.closest?.(".tree__row--file") === row) {
        return;
      }
      hide();
    });

    // Picking a file up to drag it is the end of looking at it: the plate would
    // otherwise follow the pointer across the editor while a path is being dropped.
    dom.resourceBody.addEventListener("dragstart", hide);

    // A scrolled or blurred tree takes the row out from under the box, which would
    // otherwise hang over whatever the author scrolled to.
    dom.resourceBody.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
  }

  return { hide, sync, wire };
}
