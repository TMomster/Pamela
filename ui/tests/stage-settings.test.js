// 覆盖舞台的设置面板测试。
// Tests for the settings panel drawn over the stage.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createStageSettings,
  TEXT_SPEED_TITLE,
  TYPEWRITER_OPTIONS,
  typewriterLabel,
} from "../stage-settings.js";

/** A stand-in element, enough for the panel to be built in node. */
function fakeNode(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    type: "",
    textContent: "",
    title: "",
    disabled: false,
    hidden: false,
    childNodes: [],
    attributes: {},
    dataset: {},
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      for (const name of String(value ?? "").split(/\s+/)) {
        if (name) classes.add(name);
      }
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, on) {
        if (on === undefined) {
          classes.has(name) ? classes.delete(name) : classes.add(name);
        } else if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return classes.has(name);
      },
    },
    append(...children) {
      node.childNodes.push(...children);
    },
    replaceChildren(...children) {
      node.childNodes = [...children];
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
      if (name === "class") node.className = value;
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event ?? { stopPropagation() {}, target: node });
    },
    /** Every descendant carrying `className`'s class, depth first. */
    findAll(wanted) {
      const out = [];
      const walk = (current) => {
        for (const child of current.childNodes ?? []) {
          if (child.classList?.contains(wanted)) out.push(child);
          walk(child);
        }
      };
      walk(node);
      return out;
    },
  };
  return node;
}

/** Runs `body` with a minimal `document`, so icons and the panel can be built. */
function withFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    createElementNS: (_ns, tag) => fakeNode(tag),
    createTextNode: (text) => ({ textContent: text }),
  };
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

/** Builds the panel on a fresh host and hands back the handle and the host. */
function build() {
  const host = fakeNode("div");
  const picks = [];
  let closed = 0;
  const panel = createStageSettings({
    host,
    onChange: (value) => picks.push(value),
    onClose: () => {
      closed += 1;
    },
  });
  return { host, panel, picks, closed: () => closed };
}

test("设置面板：只有一节标题与四个选项，没有多余的解释文字", () => {
  withFakeDom(() => {
    const { host, panel } = build();
    panel.open({ value: "off" });

    assert.equal(host.hidden, false, "打开后要显示");
    const card = host.childNodes[0];
    assert.equal(card.childNodes.length, 2, "卡片只有标题栏与内容区");

    const body = card.childNodes[1];
    assert.equal(body.childNodes.length, 2, "内容区只放节标题与选项行，不导入正文");

    const section = body.childNodes[0];
    assert.equal(section.textContent, TEXT_SPEED_TITLE);
    assert.equal(section.textContent, "文本逐字显示模式");

    const labels = host.findAll("stage-settings__option").map((node) => node.textContent);
    assert.deepEqual(labels, ["关闭", "快速", "中速", "慢速"]);
    assert.deepEqual(
      TYPEWRITER_OPTIONS.map((option) => option.value),
      ["off", "fast", "medium", "slow"],
      "值仍是清单里的词汇",
    );
  });
});

test("设置面板：当前档位只有一项被标记", () => {
  withFakeDom(() => {
    const { host, panel } = build();
    panel.open({ value: "medium" });

    const options = host.findAll("stage-settings__option");
    const checked = options.filter((node) => node.getAttribute("aria-checked") === "true");
    assert.equal(checked.length, 1);
    assert.equal(checked[0].dataset.value, "medium");
    assert.equal(checked[0].classList.contains("is-active"), true);

    // 换档位重画后，标记跟着走，不会留下两项。
    panel.open({ value: "slow" });
    const after = host
      .findAll("stage-settings__option")
      .filter((node) => node.getAttribute("aria-checked") === "true");
    assert.equal(after.length, 1);
    assert.equal(after[0].dataset.value, "slow");
  });
});

test("设置面板：点击其它档位才上报，点当前档位不上报", () => {
  withFakeDom(() => {
    const { host, panel, picks } = build();
    panel.open({ value: "off" });

    const byValue = new Map(
      host.findAll("stage-settings__option").map((node) => [node.dataset.value, node]),
    );

    byValue.get("off").dispatch("click");
    assert.deepEqual(picks, [], "当前档位不需要重写清单");

    byValue.get("fast").dispatch("click");
    byValue.get("slow").dispatch("click");
    assert.deepEqual(picks, ["fast", "slow"]);
  });
});

test("设置面板：关闭后容器清空并收起", () => {
  withFakeDom(() => {
    const { host, panel, closed } = build();
    panel.open({ value: "off" });
    assert.equal(panel.isOpen(), true);

    panel.close();
    assert.equal(host.hidden, true);
    assert.equal(host.childNodes.length, 0);
    assert.equal(panel.isOpen(), false);
    assert.equal(closed(), 1);

    // 再关一次不重复上报：舞台收起时会被调用不止一次。
    panel.close();
    assert.equal(closed(), 1);
  });
});

test("设置面板：档位名称可读，未知值原样返回", () => {
  assert.equal(typewriterLabel("fast"), "快速");
  assert.equal(typewriterLabel("off"), "关闭");
  assert.equal(typewriterLabel("custom"), "custom");
});
