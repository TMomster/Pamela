// @ts-check
// 内建阅读器：帮助与关于以「模式」借用编辑器区与资源面板。
// Pamela — the built-in reader.

import { createReaderToc, readerArticle, readerSet, renderArticle } from "./reader.js";
import { createReaderMeasure } from "./reader-width.js";

/** @typedef {"about" | "help"} ReaderSetName */

/**
 * Creates the reader mode.
 *
 * The reader is a mode, not a document: it borrows the editor area and the
 * resource panel, and the open tabs are still there behind it. `articleId` that
 * is unknown falls back to the set's first article, so 帮助 and 关于 always land
 * somewhere.
 *
 * @param {{
 *   dom: Record<string, any>,
 *   session: Record<string, any>,
 *   refreshResourcePanel: () => void,
 *   refreshEditor: () => void,
 * }} deps
 */
export function createReaderPanel({ dom, session, refreshResourcePanel, refreshEditor }) {
  /**
   * The article last drawn into `#reader-view`, as `"set/article"`.
   *
   * `refreshEditor` runs on every status change, and rebuilding the article each
   * time would throw away the reader's scroll position — which matters, since a
   * help page is read by scrolling. A different article redraws; the same one is
   * left alone.
   */
  let shown = "";

  /**
   * The width control above the article, built once.
   *
   * It is kept across articles — and across leaving the reader — because the
   * width is a reading preference rather than a property of one page: opening
   * another article must not snap the column back to its default.
   *
   * @type {ReturnType<typeof createReaderMeasure> | null}
   */
  let measure = null;

  /** The width control, created on the first article drawn into the view. */
  function widthControl() {
    if (!measure && dom.readerView) {
      measure = createReaderMeasure({ view: dom.readerView });
    }
    return measure;
  }

  /**
   * Opens the read-only reader on an article.
   *
   * @param {ReaderSetName} setName
   * @param {string} [articleId]
   */
  function open(setName, articleId = "") {
    const set = readerSet(setName);
    if (!set) {
      return;
    }
    const article = readerArticle(setName, articleId) ?? set.articles[0];
    session.reader = { setName, articleId: article.id };
    refreshResourcePanel();
    refreshEditor();
    dom.readerView?.focus();
  }

  /** Leaves the reader and hands the editor area back to the open document. */
  function close() {
    if (!session.reader) {
      return;
    }
    session.reader = null;
    shown = "";
    refreshResourcePanel();
    refreshEditor();
  }

  /** Draws the current article, unless it is already on screen. */
  function render() {
    if (!dom.readerView || !session.reader) {
      return;
    }
    const { setName, articleId } = session.reader;
    const signature = `${setName}/${articleId}`;
    if (shown === signature) {
      return;
    }
    const set = readerSet(setName);
    const article = readerArticle(setName, articleId) ?? set?.articles[0];
    if (!set || !article) {
      return;
    }
    shown = signature;
    const page = renderArticle({ set, article });
    const control = widthControl();
    // The control sits above the page and moves with it: a re-render would
    // otherwise drop it, since it is the view's other child.
    dom.readerView.replaceChildren(...(control ? [control.element, page] : [page]));
    dom.readerView.scrollTop = 0;
  }

  /**
   * Builds the table of contents the resource panel shows while reading.
   *
   * @param {ReaderSetName} setName
   * @param {string} articleId
   * @returns {HTMLElement | null} `null` when the set does not exist.
   */
  function toc(setName, articleId) {
    const set = readerSet(setName);
    if (!set) {
      return null;
    }
    return createReaderToc({
      set,
      active: articleId,
      onSelect: (id) => open(setName, id),
    });
  }

  /**
   * Leaves the reader for a caller that opens a document or starts a run.
   *
   * The caller may repaint the editor itself, which is why the repaint is
   * optional: a run draws on the stage rather than in the editor area.
   *
   * @param {{ repaint?: boolean }} [options]
   * @returns {boolean} Whether the reader was open.
   */
  function leave({ repaint = true } = {}) {
    if (!session.reader) {
      return false;
    }
    session.reader = null;
    shown = "";
    refreshResourcePanel();
    if (repaint) {
      refreshEditor();
    }
    return true;
  }

  /**
   * The pair the status bar shows while reading: the set, then the article.
   *
   * @returns {string} Empty when the reader is not open.
   */
  function label() {
    const reading = session.reader;
    if (!reading) {
      return "";
    }
    const set = readerSet(reading.setName);
    const article = readerArticle(reading.setName, reading.articleId);
    return [set?.label, article?.title].filter(Boolean).join(" · ");
  }

  return { open, close, leave, render, toc, label };
}
