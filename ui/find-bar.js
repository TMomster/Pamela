// @ts-check
// 编辑器查找替换：查询、匹配标记、替换与滚动同步。
// Pamela — the editor's find / replace bar.

import { findMatches, replaceOne } from "./find.js";

/**
 * Creates the editor's find bar.
 *
 * The bar owns its own query, matches and geometry. The geometry is measured
 * from the textarea rather than hard-coded, because the marks have to sit on the
 * glyphs under them: the grid (line height, padding) places a mark vertically
 * and holds for any face, while `charWidth` places one horizontally and is only
 * exact in a monospace face — the editor's is proportional, so the highlight
 * layer is measured instead and this stays the fallback.
 *
 * @param {{
 *   dom: Record<string, any>,
 *   editorRangeRect: (start: number, end: number) => ({ left: number, width: number } | null),
 * }} deps
 */
export function createFindBar({ dom, editorRangeRect }) {
  /**
   * `matches` are `[start, end]` index pairs from `findMatches`; `index` points
   * at the active one.
   */
  const state = {
    open: false,
    query: "",
    matches: [],
    index: 0,
    charWidth: 0,
    lineHeight: 0,
    padTop: 0,
    padLeft: 0,
  };

  /** Reads the textarea's line and fallback character metrics. */
  function measureGeometry() {
    const el = dom.editorText;
    if (!el) {
      return;
    }
    const cs = getComputedStyle(el);
    state.lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6;
    state.padTop = parseFloat(cs.paddingTop) || 0;
    state.padLeft = parseFloat(cs.paddingLeft) || 0;
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    state.charWidth = ctx.measureText("M").width || parseFloat(cs.fontSize) * 0.6;
  }

  /**
   * The metrics the error underline also places itself with.
   *
   * They are measured once and shared: a repaint that needs a mark somewhere in
   * the text should not measure the font a second time.
   */
  function geometry() {
    return {
      lineHeight: state.lineHeight,
      charWidth: state.charWidth,
      padTop: state.padTop,
      padLeft: state.padLeft,
    };
  }

  /** Opens the find bar and searches the current text. */
  function open() {
    if (!dom.editorFindBar) {
      return;
    }
    measureGeometry();
    state.open = true;
    dom.editorFindBar.hidden = false;
    dom.editorFindInput.focus();
    dom.editorFindInput.select();
    run();
    if (state.matches.length) {
      select(0);
    }
  }

  /** Closes the find bar and clears its marks, returning focus to the text. */
  function close() {
    state.open = false;
    if (dom.editorFindBar) {
      dom.editorFindBar.hidden = true;
    }
    if (dom.editorFindInner) {
      dom.editorFindInner.innerHTML = "";
    }
    if (dom.editorText) {
      dom.editorText.focus();
    }
  }

  /** Recomputes matches from the bar's inputs without moving the caret. */
  function run(resetIndex = true) {
    if (!dom.editorText) {
      return;
    }
    state.query = dom.editorFindInput.value;
    const options = {
      caseSensitive: dom.editorFindCase.checked,
      regex: dom.editorFindRegex.checked,
    };
    state.matches = findMatches(dom.editorText.value, state.query, options);
    if (resetIndex) {
      state.index = 0;
    } else {
      state.index = Math.min(state.index, Math.max(0, state.matches.length - 1));
    }
    render();
  }

  /** Repaints the match marks and the "n / total" read-out. */
  function render() {
    const total = state.matches.length;
    if (dom.editorFindInfo) {
      dom.editorFindInfo.textContent = !state.query ? "" : total ? `${state.index + 1}/${total}` : "无";
    }
    renderMarks();
  }

  /** Draws one rectangle per match in content coordinates. */
  function renderMarks() {
    if (!dom.editorFindInner) {
      return;
    }
    const inner = dom.editorFindInner;
    inner.innerHTML = "";
    const text = dom.editorText.value;
    const { lineHeight: lh, charWidth: cw, padTop: pt, padLeft: pl } = state;
    // The line index is built once per repaint, not once per match; every box is
    // still measured before any of them is inserted, so appending a mark does not
    // re-lay-out the layer once per hit.
    const starts = lineStarts(text);
    const boxes = state.matches.map(([start, end]) => {
      const a = positionAt(starts, start);
      const b = positionAt(starts, end);
      // A mark is one line box, so a match that runs over a line break is cut at
      // the end of the line it starts on rather than measured across both.
      const cut = text.indexOf("\n", start);
      const stop = cut !== -1 && cut < end ? cut : end;
      // The glyphs are measured, not counted: a proportional face makes every
      // `(b.col - a.col) * charWidth` an estimate.
      const box = editorRangeRect(start, stop);
      return {
        top: pt + a.line * lh,
        left: box ? box.left : pl + a.col * cw,
        width: Math.max(1, box ? box.width : (b.col - a.col) * cw),
      };
    });
    for (let i = 0; i < boxes.length; i += 1) {
      const mark = document.createElement("span");
      mark.className = "editor__find-mark" + (i === state.index ? " editor__find-mark--active" : "");
      mark.style.top = `${boxes[i].top}px`;
      mark.style.left = `${boxes[i].left}px`;
      mark.style.width = `${boxes[i].width}px`;
      mark.style.height = `${lh}px`;
      inner.appendChild(mark);
    }
    syncScroll();
  }

  /** Slides the match layer with the textarea so marks stay glued to the text. */
  function syncScroll() {
    if (dom.editorFindInner && dom.editorText) {
      dom.editorFindInner.style.transform =
        `translate(${-dom.editorText.scrollLeft}px, ${-dom.editorText.scrollTop}px)`;
    }
  }

  /** Selects match `index` (wrapping) and scrolls it into view. */
  function select(index) {
    const matches = state.matches;
    if (!matches.length) {
      return;
    }
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    state.index = wrapped;
    const [start, end] = matches[wrapped];
    const text = dom.editorText.value;
    dom.editorText.focus();
    dom.editorText.setSelectionRange(start, end);
    const a = lineColAt(text, start);
    const box = editorRangeRect(start, end);
    const top = state.padTop + a.line * state.lineHeight;
    const left = box ? box.left : state.padLeft + a.col * state.charWidth;
    const width = box ? Math.max(1, box.width) : state.charWidth;
    const el = dom.editorText;
    if (top < el.scrollTop + state.lineHeight) {
      el.scrollTop = Math.max(0, top - state.lineHeight);
    } else if (top + state.lineHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = top - el.clientHeight + state.lineHeight;
    }
    if (left < el.scrollLeft + width) {
      el.scrollLeft = Math.max(0, left - width);
    } else if (left + width > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = left - el.clientWidth + width;
    }
    renderMarks();
    if (dom.editorFindInfo) {
      dom.editorFindInfo.textContent = `${wrapped + 1}/${matches.length}`;
    }
  }

  /** Steps to the previous / next match (dir is -1 or +1). */
  function navigate(dir) {
    if (!state.matches.length) {
      return;
    }
    select(state.index + dir);
  }

  /** Replaces the active match in place, then refreshes the search. */
  function replaceCurrent() {
    if (!state.matches.length) {
      return;
    }
    const match = state.matches[state.index];
    const options = {
      caseSensitive: dom.editorFindCase.checked,
      regex: dom.editorFindRegex.checked,
    };
    const next = replaceOne(
      dom.editorText.value,
      match,
      state.query,
      dom.editorFindReplace.value,
      options,
    );
    dom.editorText.value = next;
    dom.editorText.dispatchEvent(new Event("input"));
    run(false);
  }

  /** Replaces every match across the whole text. */
  function replaceAll() {
    if (!state.query) {
      return;
    }
    const options = {
      caseSensitive: dom.editorFindCase.checked,
      regex: dom.editorFindRegex.checked,
    };
    const text = dom.editorText.value;
    let next;
    if (options.regex) {
      let re;
      try {
        re = new RegExp(state.query, options.caseSensitive ? "g" : "gi");
      } catch {
        return;
      }
      next = text.replace(re, dom.editorFindReplace.value);
    } else {
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      const needle = options.caseSensitive ? state.query : state.query.toLowerCase();
      const parts = [];
      let from = 0;
      let last = 0;
      let idx;
      while ((idx = haystack.indexOf(needle, from)) !== -1) {
        parts.push(text.slice(last, idx));
        parts.push(dom.editorFindReplace.value);
        from = idx + needle.length;
        last = idx + needle.length;
      }
      parts.push(text.slice(last));
      next = parts.join("");
    }
    dom.editorText.value = next;
    dom.editorText.dispatchEvent(new Event("input"));
    run(false);
  }

  return {
    isOpen: () => state.open,
    measureGeometry,
    geometry,
    open,
    close,
    run,
    render,
    renderMarks,
    syncScroll,
    select,
    navigate,
    replaceCurrent,
    replaceAll,
  };
}

/** Offsets where each line of `text` starts; the index is the 0-based line. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Maps an offset to its `{ line, col }` by binary search over `starts`.
 *
 * Scanning from the top for every match made drawing the marks O(n·m): a hundred
 * hits in a ten-thousand-line script rescanned the whole text a hundred times.
 * One pass builds the index, then each lookup is logarithmic.
 */
function positionAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low, col: offset - starts[low] };
}

/** Maps a character offset to its { line, col } within the source. */
function lineColAt(text, offset) {
  return positionAt(lineStarts(text), offset);
}
