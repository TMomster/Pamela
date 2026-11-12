// 查找替换栏的行为测试：匹配、标记、跳转、替换、关闭。
// Tests for the editor's find / replace bar.

import assert from "node:assert/strict";
import test from "node:test";

import { createFindBar } from "../find-bar.js";

/** A stand-in for the elements `createFindBar` writes into. */
function fakeElement() {
  return { className: "", style: {}, hidden: false, textContent: "", children: [], appendChild(node) { this.children.push(node); } };
}

/** Runs `body` with a fake document, then restores the globals it replaced. */
function inFakeDom(body) {
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };
  globalThis.document = {
    createElement: (tag) => {
      if (tag === "canvas") {
        return { getContext: () => ({ font: "", measureText: () => ({ width: 8 }) }) };
      }
      return fakeElement();
    },
  };
  globalThis.getComputedStyle = () => ({
    fontSize: "14px",
    fontFamily: "monospace",
    lineHeight: "21px",
    paddingTop: "12px",
    paddingLeft: "14px",
  });
  try {
    return body();
  } finally {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
  }
}

/**
 * A fake editor: `text` holds the script, the bar's own fields hold the query.
 */
function harness({ text = "", query = "", replace = "", caseSensitive = false, regex = false, rect = null } = {}) {
  const events = [];
  const selections = [];
  const inner = {
    style: {},
    children: [],
    get innerHTML() {
      return this.html ?? "";
    },
    set innerHTML(value) {
      this.html = value;
      if (value === "") {
        this.children = [];
      }
    },
    appendChild(node) {
      this.children.push(node);
    },
  };
  const editorText = {
    value: text,
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight: 200,
    clientWidth: 600,
    focused: 0,
    focus() {
      this.focused += 1;
    },
    setSelectionRange(start, end) {
      selections.push([start, end]);
    },
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
  };
  const dom = {
    editorText,
    editorFindBar: { hidden: true },
    editorFindInner: inner,
    editorFindInfo: { textContent: "" },
    editorFindInput: { value: query, focused: 0, focus() { this.focused += 1; }, select() {} },
    editorFindReplace: { value: replace },
    editorFindCase: { checked: caseSensitive },
    editorFindRegex: { checked: regex },
  };
  const bar = createFindBar({ dom, editorRangeRect: () => rect });
  return { bar, dom, editorText, inner, events, selections };
}

test("打开：显示 1/N，且只有第一条标记是高亮的", () => {
  inFakeDom(() => {
    const { bar, inner, dom } = harness({ text: "abc abc abc", query: "abc" });

    bar.open();

    assert.equal(dom.editorFindBar.hidden, false);
    assert.equal(dom.editorFindInfo.textContent, "1/3");
    assert.equal(inner.children.length, 3);
    assert.equal(inner.children[0].className, "editor__find-mark editor__find-mark--active");
    assert.equal(inner.children[1].className, "editor__find-mark");
  });
});

test("无匹配显示「无」，空查询什么都不显示", () => {
  inFakeDom(() => {
    const none = harness({ text: "abc", query: "zzz" });
    none.bar.open();
    assert.equal(none.dom.editorFindInfo.textContent, "无");
    assert.equal(none.inner.children.length, 0);

    const empty = harness({ text: "abc", query: "" });
    empty.bar.open();
    assert.equal(empty.dom.editorFindInfo.textContent, "");
    assert.equal(empty.inner.children.length, 0);
  });
});

test("区分大小写与正则两个开关都传给匹配", () => {
  inFakeDom(() => {
    const loose = harness({ text: "Abc abc", query: "abc" });
    loose.bar.run();
    assert.equal(loose.dom.editorFindInfo.textContent, "1/2");

    const strict = harness({ text: "Abc abc", query: "abc", caseSensitive: true });
    strict.bar.run();
    assert.equal(strict.dom.editorFindInfo.textContent, "1/1");

    const re = harness({ text: "a1 b22", query: "[a-z]\\d+", regex: true });
    re.bar.run();
    assert.equal(re.dom.editorFindInfo.textContent, "1/2");
  });
});

test("跳转会在两端环绕", () => {
  inFakeDom(() => {
    const { bar, dom, selections } = harness({ text: "x x x", query: "x" });
    bar.run();

    bar.navigate(1);
    assert.equal(dom.editorFindInfo.textContent, "2/3");
    assert.deepEqual(selections.at(-1), [2, 3]);

    bar.navigate(-1);
    assert.equal(dom.editorFindInfo.textContent, "1/3");

    bar.navigate(-1);
    assert.equal(dom.editorFindInfo.textContent, "3/3", "从头再往前一步是最后一个");
    assert.deepEqual(selections.at(-1), [4, 5]);
  });
});

test("替换当前：只改一处的文本，并通知编辑器", () => {
  inFakeDom(() => {
    const { bar, editorText, events, dom } = harness({ text: "a a a", query: "a", replace: "b" });
    bar.run();
    bar.navigate(1);

    bar.replaceCurrent();

    assert.equal(editorText.value, "a b a");
    assert.deepEqual(events, ["input"]);
    // 替换后重新计数，但序号留在原来的位置（第 1 条之后的那条）。
    assert.equal(dom.editorFindInfo.textContent, "2/2");
  });
});

test("全部替换：普通模式按不区分大小写整篇换掉", () => {
  inFakeDom(() => {
    const { bar, editorText } = harness({ text: "Cat cat CAT", query: "cat", replace: "dog" });
    bar.run();

    bar.replaceAll();

    assert.equal(editorText.value, "dog dog dog");
  });
});

test("全部替换：正则模式支持分组引用，坏正则不动文本", () => {
  inFakeDom(() => {
    const groups = harness({ text: "a1 b2", query: "([a-z])(\\d)", replace: "$2$1", regex: true });
    groups.bar.run();
    groups.bar.replaceAll();
    assert.equal(groups.editorText.value, "1a 2b");

    const broken = harness({ text: "a1", query: "([", replace: "x", regex: true });
    broken.bar.run();
    broken.bar.replaceAll();
    assert.equal(broken.editorText.value, "a1");
  });
});

test("关闭：清空标记、藏起栏、焦点回到正文", () => {
  inFakeDom(() => {
    const { bar, inner, dom, editorText } = harness({ text: "abc", query: "abc" });
    bar.open();
    assert.equal(inner.children.length, 1);
    const focusedBefore = editorText.focused;

    bar.close();

    assert.equal(dom.editorFindBar.hidden, true);
    assert.equal(inner.children.length, 0);
    assert.equal(bar.isOpen(), false);
    assert.equal(editorText.focused, focusedBefore + 1, "关闭后焦点回到正文");
  });
});

test("正则跨行命中不画标记，但也不炸", () => {
  inFakeDom(() => {
    // `findMatches` 跳过跨行命中：一个矩形画不了两行。
    const { bar, inner } = harness({ text: "a\nb", query: "a\\nb", regex: true });
    bar.run();
    assert.equal(inner.children.length, 0);
  });
});

test("几何：行高、内边距与字符宽度都从样式量出来", () => {
  inFakeDom(() => {
    const { bar } = harness({ text: "abc", query: "abc" });

    bar.measureGeometry();

    assert.deepEqual(bar.geometry(), {
      lineHeight: 21,
      charWidth: 8,
      padTop: 12,
      padLeft: 14,
    });
  });
});

test("标记落在行首 + 列宽上，活动项跟着当前匹配", () => {
  inFakeDom(() => {
    const { bar, inner } = harness({ text: "abc\nxx abc", query: "abc" });
    bar.measureGeometry();
    bar.run();

    const [first, second] = inner.children;
    assert.equal(first.style.top, "12px", "第 0 行：上边距");
    assert.equal(first.style.left, "14px", "第 0 列：左边距");
    assert.equal(first.style.width, "24px", "3 个字符 × 8px");
    assert.equal(first.style.height, "21px");
    assert.equal(second.style.top, "33px", "第 1 行：12 + 21");
    assert.equal(second.style.left, "38px", "第 3 列：14 + 3×8");
  });
});
