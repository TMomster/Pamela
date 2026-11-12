// 舞台内「退出演出」确认的测试：卡片结构、Enter 确认、Esc 返回、幂等。
// Tests for the exit card drawn over the stage.

import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE_EXIT_BODY,
  STAGE_EXIT_CANCEL,
  STAGE_EXIT_CONFIRM,
  STAGE_EXIT_TITLE,
  createStageExitConfirm,
} from "../stage-exit.js";

/** A stand-in element, enough for the card to be built in node. */
function fakeNode(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    type: "",
    textContent: "",
    hidden: false,
    childNodes: [],
    attributes: {},
    dataset: {},
    focused: 0,
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
      contains(name) {
        return classes.has(name);
      },
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
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
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    focus() {
      node.focused += 1;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event ?? { stopPropagation() {}, target: node });
    },
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

/** Runs `body` with a minimal `document` that records its key listeners. */
function withFakeDom(body) {
  const previous = globalThis.document;
  const keys = [];
  const doc = {
    activeElement: null,
    createElement: (tag) => fakeNode(tag),
    addEventListener(type, handler, capture) {
      if (type === "keydown") keys.push({ handler, capture });
    },
    removeEventListener(type, handler) {
      if (type !== "keydown") return;
      const at = keys.findIndex((entry) => entry.handler === handler);
      if (at >= 0) keys.splice(at, 1);
    },
  };
  globalThis.document = doc;
  try {
    return body({ keys, doc });
  } finally {
    globalThis.document = previous;
  }
}

/** A keydown the card should answer; `prevented`/`stopped` record what it did. */
function key(name) {
  const event = {
    key: name,
    prevented: false,
    stopped: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
  };
  return event;
}

/** Builds the card on a fresh host and hands back the handle and the host. */
function build() {
  const host = fakeNode("div");
  host.hidden = true;
  const answers = [];
  const card = createStageExitConfirm({
    host,
    onConfirm: () => answers.push("confirm"),
    onCancel: () => answers.push("cancel"),
  });
  return { host, card, answers };
}

test("卡片：一句问话、两个按钮，默认动作是退出", () => {
  withFakeDom(() => {
    const { host, card } = build();
    card.open();

    assert.equal(host.hidden, false, "打开后要显示");
    const panel = host.childNodes[0];
    assert.equal(panel.attributes.role, "dialog");
    assert.equal(panel.attributes["aria-modal"], "true");
    assert.equal(panel.attributes["aria-label"], STAGE_EXIT_TITLE);

    const title = panel.findAll("stage-exit__title")[0];
    assert.equal(title.textContent, STAGE_EXIT_TITLE);
    const body = panel.findAll("stage-exit__body")[0];
    assert.equal(body.textContent, STAGE_EXIT_BODY);

    const buttons = panel.findAll("stage-exit__button");
    assert.equal(buttons.length, 2, "只有退出与返回");
    assert.equal(buttons[0].dataset.action, "confirm");
    assert.equal(buttons[0].textContent, STAGE_EXIT_CONFIRM);
    assert.equal(buttons[0].focused, 1, "焦点落在默认动作上");
    assert.equal(buttons[1].dataset.action, "cancel");
    assert.equal(buttons[1].textContent, STAGE_EXIT_CANCEL);
    // 键位提示跟着按钮走，卡片自己说清楚怎么用键盘。
    const keys = panel.findAll("stage-exit__key").map((node) => node.textContent);
    assert.deepEqual(keys, ["Enter", "Esc"]);
  });
});

test("Enter 确认，Esc 返回，两者都吃掉这次按键", () => {
  withFakeDom(({ keys }) => {
    const { host, card, answers } = build();

    card.open();
    assert.equal(keys.length, 1, "开着的时候接管键盘");
    assert.equal(keys[0].capture, true, "捕获阶段，先于舞台自己的 Space/Enter");

    const enter = key("Enter");
    keys[0].handler(enter);
    assert.equal(enter.prevented, true, "不能同时推一句台词");
    assert.equal(enter.stopped, true);
    assert.deepEqual(answers, ["confirm"]);
    assert.equal(card.isOpen(), false);
    assert.equal(host.hidden, true);
    assert.equal(keys.length, 0, "收起后不留监听器");

    card.open();
    const escape = key("Escape");
    keys[0].handler(escape);
    assert.equal(escape.prevented, true);
    assert.equal(escape.stopped, true);
    assert.deepEqual(answers, ["confirm", "cancel"]);
    assert.equal(card.isOpen(), false);
    assert.equal(host.hidden, true);
    assert.equal(keys.length, 0);
  });
});

test("空格不算确认：卡片开着时它什么都不做，也不落到舞台上", () => {
  withFakeDom(({ keys }) => {
    const { card, answers } = build();
    card.open();

    const space = key(" ");
    keys[0].handler(space);
    assert.equal(space.prevented, true);
    assert.equal(space.stopped, true);
    assert.deepEqual(answers, [], "既没退出也没返回");
    assert.equal(card.isOpen(), true, "卡片还开着");
  });
});

test("点按钮与点背景都会收起卡片，各自算一次", () => {
  withFakeDom(() => {
    const { host, card, answers } = build();

    card.open();
    host.childNodes[0].findAll("stage-exit__button")[1].dispatch("click");
    assert.deepEqual(answers, ["cancel"]);
    assert.equal(card.isOpen(), false);

    card.open();
    host.dispatch("click", { target: host });
    assert.deepEqual(answers, ["cancel", "cancel"], "点背景当作返回");

    card.open();
    host.childNodes[0].findAll("stage-exit__button")[0].dispatch("click");
    assert.deepEqual(answers, ["cancel", "cancel", "confirm"]);
  });
});

test("点卡片本身不算点背景", () => {
  withFakeDom(() => {
    const { host, card, answers } = build();
    card.open();
    host.dispatch("click", { target: host.childNodes[0] });
    assert.deepEqual(answers, [], "点在卡片上什么都不发生");
    assert.equal(card.isOpen(), true);
  });
});

test("重复打开与重复关闭都是幂等的", () => {
  withFakeDom(({ keys }) => {
    const { host, card, answers } = build();

    card.open();
    card.open();
    assert.equal(keys.length, 1, "只挂一次键盘");
    assert.equal(host.childNodes.length, 1, "只有一张卡");

    card.close();
    card.close();
    assert.deepEqual(answers, [], "程序性关闭不回答任何事");
    assert.equal(card.isOpen(), false);
    assert.equal(host.hidden, true);
    assert.equal(keys.length, 0);
  });
});

test("关舞台时顺手收起卡片，不会回头再确认一次", () => {
  withFakeDom(() => {
    const { card, answers } = build();
    card.open();
    // `discardStage` 走的就是这一支：确认回调里 `closeStage` 又会关一次。
    card.close();
    card.confirm();
    assert.deepEqual(answers, [], "已经关了就不再回答");
  });
});

test("收起之后焦点还给原来的地方，按键才推得动台词", () => {
  withFakeDom(({ doc }) => {
    const { card } = build();
    let focused = 0;
    doc.activeElement = {
      focus() {
        focused += 1;
      },
    };

    card.open();
    assert.equal(focused, 0, "打开时焦点在卡片上");
    card.cancel();
    assert.equal(focused, 1, "取消之后还回去");
  });
});

test("没有容器就直说，而不是静默什么都不做", () => {
  withFakeDom(() => {
    assert.throws(() => createStageExitConfirm({ host: null }), /需要一个容器/);
  });
});
