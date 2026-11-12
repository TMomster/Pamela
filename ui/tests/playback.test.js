// 播放辅助功能测试：自动推进、跳过与快进。
// Tests for the playback conveniences: auto-advance, skip (fast-forward) and the

import assert from "node:assert/strict";
import test from "node:test";

import { createDialogue } from "../dialog.js";
import { createStage } from "../stage.js";

/** A stand-in element, with just enough of the DOM for `createStage`/`createDialogue`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: new Proxy(
      {},
      {
        set(target, key, value) {
          target[key] = value;
          return true;
        },
      },
    ),
    get offsetWidth() {
      return 0;
    },
    childNodes: [],
    classList: { toggle() {} },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    replaceChildren(...children) {
      node.childNodes = children;
    },
    append(child) {
      node.childNodes.push(child);
    },
    hidden: false,
    textContent: "",
    removeAttribute(name) {
      node[name] = "";
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    /** Fires what was registered for `type`, as a click on the frame would. */
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
  return node;
}

/** Runs `body` with a minimal `document`, so the box can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

/** A box over the fake DOM, ready to show lines. */
function box() {
  return createDialogue({
    element: fakeElement(),
    node: fakeElement(),
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
  });
}

/** Resolves after `ms` milliseconds, so a timer the box armed can fire. */
function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("回看：台词进入历史，重放时不记录", () => {
  inFakeDom(() => {
    const live = box();
    live.line(null, "第一句").catch(() => {});
    live.settle();
    live.line("小明", "第二句").catch(() => {});
    live.settle();
    const history = live.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].text, "第一句");
    assert.equal(history[0].name, null);
    assert.equal(history[1].text, "第二句");
    assert.equal(history[1].name, "小明");
  });
});

test("回看：重放中的台词不进入历史", async () => {
  await inFakeDom(async () => {
    const replay = createDialogue({
      element: fakeElement(),
      node: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      isReplaying: () => true,
    });
    await replay.line(null, "本不该被记住");
    assert.equal(replay.getHistory().length, 0);
  });
});

test("回看：历史上限为 100，超出丢弃最旧", () => {
  inFakeDom(() => {
    const b = box();
    for (let index = 0; index < 120; index += 1) {
      const shown = b.line(null, `L${index}`);
      b.settle();
      // The line's wait must be released before the next can begin.
      shown.catch(() => {});
    }
    const history = b.getHistory();
    assert.equal(history.length, 100);
    assert.equal(history[0].text, "L20");
  });
});

test("回看：clear 清空历史", () => {
  inFakeDom(() => {
    const b = box();
    b.line(null, "一句话").catch(() => {});
    b.settle();
    assert.equal(b.getHistory().length, 1);
    b.clear();
    assert.equal(b.getHistory().length, 0);
  });
});

test("回看：getHistory 返回副本，外部修改不影响内部", () => {
  inFakeDom(() => {
    const b = box();
    b.line(null, "原句").catch(() => {});
    b.settle();
    const copy = b.getHistory();
    copy[0].text = "被改";
    assert.equal(b.getHistory()[0].text, "原句");
  });
});

test("快进：开启后台词自动推进，无需点击", async () => {
  await inFakeDom(async () => {
    const b = box();
    let resolved = false;
    const shown = b.line(null, "快进这句");
    shown.then(() => {
      resolved = true;
    });
    b.setSkip(true);
    await wait();
    assert.equal(resolved, true);
  });
});

test("快进：运行中开启也能立即快进当前这句", async () => {
  await inFakeDom(async () => {
    const b = box();
    let resolved = false;
    const shown = b.line(null, "已经显示中");
    shown.then(() => {
      resolved = true;
    });
    b.setSkip(true);
    await wait();
    assert.equal(resolved, true);
    assert.equal(b.getSkip(), true);
  });
});

test("自动：开启后每句停留片刻自动推进", async () => {
  await inFakeDom(async () => {
    const b = box();
    b.setAutoDelay(5);
    b.setAuto(true);
    let resolved = false;
    const shown = b.line(null, "自动这句");
    shown.then(() => {
      resolved = true;
    });
    await wait(30);
    assert.equal(resolved, true);
  });
});

test("自动：开启前已在等待的台词也会自动推进", async () => {
  await inFakeDom(async () => {
    const b = box();
    b.setAutoDelay(5);
    let resolved = false;
    const shown = b.line(null, "先等后自动");
    shown.then(() => {
      resolved = true;
    });
    b.setAuto(true);
    await wait(30);
    assert.equal(resolved, true);
  });
});

test("自动：手动点击取消待定的自动推进，不重复结算", async () => {
  await inFakeDom(async () => {
    const b = box();
    b.setAutoDelay(60);
    let count = 0;
    const shown = b.line(null, "手动优先");
    shown.then(() => {
      count += 1;
    });
    await wait(10);
    assert.equal(count, 0, "自动尚未触发");
    b.settle();
    await wait(5);
    assert.equal(count, 1, "手动点击结算了一次");
    await wait(80);
    assert.equal(count, 1, "过期的自动定时器不再结算");
  });
});

test("舞台转发：toggleSkip 与按住 Ctrl 组合正确", () => {
  inFakeDom(() => {
    const element = fakeElement();
    const stage = createStage({
      element,
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    });
    assert.equal(stage.getSkip(), false);
    assert.equal(stage.toggleSkip(), true);
    assert.equal(stage.getSkip(), true);
    assert.equal(stage.toggleSkip(), false);
    assert.equal(stage.getSkip(), false);

    // 按住 Ctrl 快进，松开恢复。
    element.dispatch("keydown", { key: "Control" });
    assert.equal(stage.getSkip(), true);
    element.dispatch("keyup", { key: "Control" });
    assert.equal(stage.getSkip(), false);

    // 已开启快进时按住 Ctrl 再松开，切换态保留。
    stage.toggleSkip();
    element.dispatch("keydown", { key: "Control" });
    element.dispatch("keyup", { key: "Control" });
    assert.equal(stage.getSkip(), true);
  });
});

test("舞台转发：getHistory 透传对话盒历史", () => {
  inFakeDom(() => {
    const element = fakeElement();
    const stage = createStage({
      element,
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    });
    const shown = stage.sayLine(null, "舞台台词");
    // The box settles a line on a click on the stage element; drive it that way.
    element.dispatch("click");
    shown.catch(() => {});
    assert.equal(stage.getHistory().length, 1);
    assert.equal(stage.getHistory()[0].text, "舞台台词");
  });
});
