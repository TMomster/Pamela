// @ts-check
// 内建阅读器：帮助与关于以标签的形式借用编辑区与资源面板。
// Pamela — the built-in reader.

import { createReaderToc, readerArticle, readerSet, renderArticle } from "./reader.js";
import { createReaderMeasure } from "./reader-width.js";

/** @typedef {"about" | "help"} ReaderSetName */

/**
 * Creates the reader.
 *
 * The article is read-only, but the tab is an ordinary tab: leaving it for a
 * document keeps it on the strip, and clicking it comes back to the article.
 * Each pane keeps its own article and scroll position.
 *
 * @param {{
 *   dom: Record<string, any>,
 *   session: Record<string, any>,
 *   refreshResourcePanel: () => void,
 *   refreshEditor: () => void,
 *   getActivePane: () => Record<string, any> | null,
 *   addReaderTab: (pane: Record<string, any>) => void,
 *   removeReaderTab: () => void,
 * }} deps
 */
export function createReaderPanel({
  dom,
  session,
  refreshResourcePanel,
  refreshEditor,
  getActivePane,
  addReaderTab,
  removeReaderTab,
}) {

  /** The width control, one per pane: the width is a reading preference. */
  const measures = new WeakMap();

  /** @param {Record<string, any>} pane */
  function viewOf(pane) {
    return pane.dom?.readerView ?? dom.readerView;
  }

  /** @param {Record<string, any>} pane */
  function widthControl(pane) {
    const view = viewOf(pane);
    if (!view) {
      return null;
    }
    let measure = measures.get(pane);
    if (!measure) {
      measure = createReaderMeasure({ view });
      measures.set(pane, measure);
    }
    return measure;
  }

  /**
   * Opens an article in `pane`, or in the focused pane when none is named.
   *
   * @param {ReaderSetName} setName
   * @param {string} [articleId]
   * @param {Record<string, any>} [pane]
   */
  function open(setName, articleId = "", pane = getActivePane()) {
    if (!pane) {
      return;
    }
    const set = readerSet(setName);
    if (!set) {
      return;
    }
    const article = readerArticle(setName, articleId) ?? set.articles[0];
    pane.reader = { setName, articleId: article.id };
    pane.readerActive = true;
    addReaderTab(pane);
    if (pane === getActivePane()) {
      session.reader = pane.reader;
    }
    refreshResourcePanel();
    refreshEditor();
    viewOf(pane)?.focus();
  }

  /**
   * Closes the reader tab and forgets the article.
   *
   * @param {Record<string, any>} [pane]
   */
  function close(pane = getActivePane()) {
    if (!pane || !pane.reader) {
      return;
    }
    pane.reader = null;
    pane.readerActive = false;
    removeReaderTab();
    if (pane === getActivePane()) {
      session.reader = null;
    }
    refreshResourcePanel();
    refreshEditor();
  }

  /**
   * Draws the current article into `pane`, unless it is already on screen.
   *
   * @param {Record<string, any>} [pane]
   */
  function render(pane = getActivePane()) {
    const view = pane && viewOf(pane);
    if (!view || !pane?.reader) {
      return;
    }
    const { setName, articleId } = pane.reader;
    const signature = `${setName}/${articleId}`;
    if (view.dataset.readerSignature === signature) {
      return;
    }
    const set = readerSet(setName);
    const article = readerArticle(setName, articleId) ?? set?.articles[0];
    if (!set || !article) {
      return;
    }
    view.dataset.readerSignature = signature;
    const page = renderArticle({ set, article });
    const control = widthControl(pane);
    view.replaceChildren(...(control ? [control.element, page] : [page]));
    view.scrollTop = 0;
  }

  /**
   * Builds the table of contents the resource panel shows while reading.
   *
   * @param {ReaderSetName} setName
   * @param {string} articleId
   * @param {Record<string, any>} [pane]
   * @returns {HTMLElement | null} `null` when the set does not exist.
   */
  function toc(setName, articleId, pane = getActivePane()) {
    const set = readerSet(setName);
    if (!set) {
      return null;
    }
    return createReaderToc({
      set,
      active: articleId,
      onSelect: (id) => open(setName, id, pane ?? undefined),
    });
  }

  /**
   * Leaves the reader for a caller that opens a document or starts a run.
   *
   * The article and its tab stay put; only the surface is handed back.
   *
   * @param {{ repaint?: boolean, pane?: Record<string, any> }} [options]
   * @returns {boolean} Whether the reader was showing.
   */
  function leave({ repaint = true, pane = getActivePane() } = {}) {
    if (!pane || !pane.readerActive) {
      return false;
    }
    pane.readerActive = false;
    if (pane === getActivePane()) {
      session.reader = null;
    }
    refreshResourcePanel();
    if (repaint) {
      refreshEditor();
    }
    return true;
  }

  /**
   * The pair the status bar shows while reading: the set, then the article.
   *
   * @param {Record<string, any>} [pane]
   * @returns {string} Empty when the reader is not showing.
   */
  function label(pane = getActivePane()) {
    const reading = pane?.readerActive ? pane.reader : null;
    if (!reading) {
      return "";
    }
    const set = readerSet(reading.setName);
    const article = readerArticle(reading.setName, reading.articleId);
    return [set?.label, article?.title].filter(Boolean).join(" · ");
  }

  return { open, close, leave, render, toc, label };
}
