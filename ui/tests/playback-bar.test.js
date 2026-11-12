// 播放控件的行为测试：回看、菜单状态、自动 / 快进、全屏、设置面板。
// Tests for the stage's playback conveniences.

import assert from "node:assert/strict";
import test from "node:test";

import { createPlaybackBar } from "../playback-bar.js";

/** An element with just enough surface for the module to write into it. */
function fakeElement(id = "") {
  const classes = new Set();
  return {
    id,
    hidden: false,
    disabled: false,
    title: "",
    textContent: "",
    className: "",
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    classes,
    append(node) {
      this.children.push(node);
    },
    replaceChildren() {
      this.children = [];
    },
  };
}

/** Installs a fake document with the given ids, and answers its `.app`. */
function installDom(ids = {}) {
  const previous = globalThis.document;
  const elements = new Map(Object.entries(ids).map(([id, node]) => [id, node ?? fakeElement(id)]));
  const app = fakeElement("app");
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: (selector) => (selector === ".app" ? app : null),
    createElement: (tag) => fakeElement(tag),
  };
  return {
    elements,
    app,
    restore: () => {
      globalThis.document = previous;
    },
  };
}

/** Runs a synchronous `body` with a fake document. */
function inFakeDom(ids, body) {
  const dom = installDom(ids);
  try {
    return body(dom);
  } finally {
    dom.restore();
  }
}

function harness({
  history = [],
  auto = false,
  skip = false,
  project = { name: "p", typewriter: "off" },
  chrome = null,
  slots = false,
  slotView = null,
  settingsPanel = null,
  actions = null,
} = {}) {
  const messages = [];
  const calls = [];
  const stage = {
    getHistory: () => history,
    getAuto: () => auto,
    setAuto: (on) => {
      auto = on;
      calls.push(["setAuto", on]);
    },
    getSkip: () => skip,
    toggleSkip: () => {
      skip = !skip;
      calls.push(["toggleSkip", skip]);
    },
    setTypewriter: (value) => calls.push(["stage.typewriter", value]),
  };
  const session = {
    project,
    stageName: "main",
    running: true,
    node: { canSave: true },
  };
  const playback = createPlaybackBar({
    dom: { stageView: { hidden: false } },
    session,
    getStage: () => stage,
    getSlotView: () => slotView,
    getSettingsPanel: () => settingsPanel,
    getActions: () =>
      actions ?? {
        setTypewriter: async (value) => {
          calls.push(["actions.typewriter", value]);
          return { ...session.project, typewriter: value };
        },
      },
    getChrome: () => chrome,
    slotsOpen: () => slots,
    setMessage: (text, options = {}) => messages.push({ text, error: Boolean(options.error) }),
  });
  return { playback, session, messages, calls, stage };
}

test("回看：打开时按历史画出行并滚到最新一句", () => {
  const panel = fakeElement("backlog");
  const body = fakeElement("backlog-body");
  body.scrollHeight = 900;
  inFakeDom({ backlog: panel, "backlog-body": body }, () => {
    const { playback } = harness({
      history: [
        { name: "艾琳", text: "早。" },
        { name: "", text: "旁白一句。" },
      ],
    });

    playback.toggleBacklog();

    assert.equal(panel.hidden, false);
    assert.equal(playback.isBacklogOpen(), true);
    assert.equal(body.children.length, 2);
    assert.equal(body.children[0].className, "backlog__row");
    assert.equal(body.children[0].children[0].textContent, "艾琳");
    assert.equal(body.children[0].children[1].textContent, "早。");
    assert.equal(body.children[1].children.length, 1, "旁白没有姓名");
    assert.equal(body.scrollTop, 900, "打开时停在最后一句");
  });
});

test("回看：新台词到来时不抢滚动位置，空历史有占位", () => {
  const panel = fakeElement("backlog");
  const body = fakeElement("backlog-body");
  body.scrollTop = 40;
  body.scrollHeight = 900;
  inFakeDom({ backlog: panel, "backlog-body": body }, () => {
    const { playback } = harness({ history: [{ name: "", text: "一句" }] });
    playback.renderBacklog({ stickToEnd: false });
    assert.equal(body.scrollTop, 40, "已经有列表时不能把画面拽走");
  });

  const empty = fakeElement("backlog-body");
  inFakeDom({ backlog: panel, "backlog-body": empty }, () => {
    const { playback } = harness({ history: [] });
    playback.renderBacklog();
    assert.equal(empty.children.length, 1);
    assert.equal(empty.children[0].className, "backlog__empty");
  });
});

test("回看：列表在顶部时再往上滚就是关掉它", () => {
  const panel = fakeElement("backlog");
  const body = fakeElement("backlog-body");
  inFakeDom({ backlog: panel, "backlog-body": body }, () => {
    const { playback } = harness();
    playback.toggleBacklog(true);

    assert.equal(playback.wheelClosesBacklogAtTop({ deltaY: -120 }), true);
    body.scrollTop = 200;
    assert.equal(playback.wheelClosesBacklogAtTop({ deltaY: -120 }), false);
    body.scrollTop = 0;
    assert.equal(playback.wheelClosesBacklogAtTop({ deltaY: 120 }), false);
  });
});

test("滚轮：只在舞台可用且没被面板盖住时打开回看", () => {
  const panel = fakeElement("backlog");
  const body = fakeElement("backlog-body");
  inFakeDom({ backlog: panel, "backlog-body": body }, () => {
    const { playback } = harness();
    let prevented = 0;
    const event = { deltaY: -120, preventDefault: () => (prevented += 1) };

    playback.onStageWheel(event);
    assert.equal(playback.isBacklogOpen(), true);
    assert.equal(prevented, 1, "开回看要吃掉这次滚动");

    playback.toggleBacklog(false);
    const covered = harness({ slots: true });
    covered.playback.onStageWheel({ deltaY: -120, preventDefault: () => (prevented += 1) });
    assert.equal(covered.playback.isBacklogOpen(), false, "存档面板盖着时不抢手势");
    assert.equal(prevented, 1);
  });
});

test("舞台菜单：auto / skip / 回看 / 存档四处的亮灭跟着真实状态", () => {
  const ids = {
    "stage-auto": fakeElement(),
    "stage-skip": fakeElement(),
    "stage-fullscreen": fakeElement(),
    "stage-backlog": fakeElement(),
    "stage-save": fakeElement(),
    "stage-load": fakeElement(),
    "stage-settings": fakeElement(),
  };
  inFakeDom(ids, () => {
    const { playback, session } = harness({ auto: true, skip: false });

    playback.refreshMenu();

    assert.equal(ids["stage-auto"].classes.has("is-active"), true);
    assert.equal(ids["stage-skip"].classes.has("is-active"), false);
    assert.equal(ids["stage-backlog"].classes.has("is-active"), false);
    assert.equal(ids["stage-save"].disabled, false);
    assert.equal(ids["stage-save"].title, "存档");

    session.node = { canSave: false };
    playback.refreshMenu();
    assert.equal(ids["stage-save"].disabled, true, "站在不能存的位置时灰着");
  });
});

test("自动与快进：切换的是舞台上的开关", () => {
  inFakeDom({}, () => {
    const { playback, calls } = harness({ auto: false });

    playback.toggleAuto();
    playback.toggleSkip();

    assert.deepEqual(calls, [
      ["setAuto", true],
      ["toggleSkip", true],
    ]);
  });
});

test("全屏：没有桥就报错", () => {
  inFakeDom({}, () => {
    const { playback, messages } = harness({ chrome: null });
    playback.toggleFullscreen();
    assert.equal(messages.at(-1).error, true);
  });
});

test("全屏：有桥则连外壳一起进出", async () => {
  const dom = installDom();
  try {
    const asked = [];
    const chrome = {
      setFullscreen: async (on) => {
        asked.push(on);
        return on;
      },
    };
    const { playback } = harness({ chrome });

    await playback.toggleFullscreen();
    assert.deepEqual(asked, [true]);
    assert.equal(playback.isFullscreen(), true);
    assert.equal(dom.app.classes.has("is-stage-fullscreen"), true);

    await playback.toggleFullscreen();
    assert.deepEqual(asked, [true, false]);
    assert.equal(playback.isFullscreen(), false);
    assert.equal(dom.app.classes.has("is-stage-fullscreen"), false);
  } finally {
    dom.restore();
  }
});

test("设置面板：打开时带上清单里的档位，关闭直接收面板", () => {
  const opened = [];
  let closed = 0;
  const settingsPanel = {
    open: (state) => opened.push(state),
    close: () => (closed += 1),
    isOpen: () => opened.length > 0,
  };
  inFakeDom({}, () => {
    const withProject = harness({ settingsPanel, project: { typewriter: "fast" } });
    withProject.playback.openSettings();
    assert.deepEqual(opened, [{ value: "fast" }]);
    withProject.playback.closeSettings();
    assert.equal(closed, 1);

    const noProject = harness({ settingsPanel, project: null });
    noProject.playback.openSettings();
    assert.equal(noProject.messages.at(-1).error, true);
  });
});

test("文本模式：写清单并立刻交给舞台，同值不重复写", async () => {
  const dom = installDom();
  try {
    const { playback, session, calls } = harness({ project: { typewriter: "off" } });

    await playback.applyTypewriter("off");
    assert.deepEqual(calls, [], "已经是这个档位就不写盘");

    await playback.applyTypewriter("slow");
    assert.deepEqual(calls, [
      ["actions.typewriter", "slow"],
      ["stage.typewriter", "slow"],
    ]);
    assert.equal(session.project.typewriter, "slow");
  } finally {
    dom.restore();
  }
});

test("文本模式写盘失败时上报，内存里的清单不变", async () => {
  const dom = installDom();
  try {
    const { playback, messages, session } = harness({
      actions: {
        setTypewriter: async () => {
          throw new Error("磁盘只读");
        },
      },
    });

    await playback.applyTypewriter("slow");

    assert.equal(messages.at(-1).error, true);
    assert.match(messages.at(-1).text, /磁盘只读/);
    assert.equal(session.project.typewriter, "off");
  } finally {
    dom.restore();
  }
});
