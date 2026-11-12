// 导出浮窗：文件名与参数的规矩，轮盘的几何与开合，以及进度读数。
// The export sheet: naming rules, the wheel's geometry, and the progress read-out.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHOICE_MODES,
  createExportPanel,
  defaultNameFor,
  defaultNameForEntry,
  FPS_CHOICES,
  formatDuration,
  pathForName,
  preferencesOf,
  progressPercent,
  sanitizeName,
  sanitizePreferences,
  validateName,
  wheelLayout,
  WHEEL_ANIMATION_MS,
  WHEEL_RADIUS,
} from "../export-panel.js";

/** 一个够用的替身元素：浮窗只用到这些属性与方法。 */
function fakeNode(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const attributes = {};
  const values = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    type: "",
    textContent: "",
    title: "",
    value: "",
    disabled: false,
    hidden: false,
    childNodes: [],
    attributes,
    dataset: {},
    offsetWidth: 0,
    style: {
      setProperty(name, value) {
        values.set(name, String(value));
      },
      removeProperty(name) {
        values.delete(name);
      },
      getPropertyValue(name) {
        return values.get(name) ?? "";
      },
    },
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      for (const name of String(value ?? "").split(/\s+/)) {
        if (name) {
          classes.add(name);
        }
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
      attributes[name] = String(value);
      if (name === "class") {
        node.className = value;
      }
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event ?? { stopPropagation() {}, preventDefault() {}, target: node });
    },
    remove() {
      node.removed = true;
    },
    focus() {},
    select() {},
    findAll(wanted) {
      const found = [];
      const walk = (current) => {
        for (const child of current.childNodes ?? []) {
          if (child.classList?.contains(wanted)) {
            found.push(child);
          }
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    find(predicate) {
      let hit = null;
      const walk = (current) => {
        for (const child of current.childNodes ?? []) {
          if (hit) {
            return;
          }
          if (predicate(child)) {
            hit = child;
            return;
          }
          walk(child);
        }
      };
      walk(node);
      return hit;
    },
  };
  return node;
}

/** 在替身 document 下跑 `body`；浮窗挂到 `host` 上。 */
async function withFakeDom(body) {
  const previous = globalThis.document;
  const host = fakeNode("div");
  const documentListeners = new Map();
  globalThis.document = {
    body: host,
    createElement: (tag) => fakeNode(tag),
    createElementNS: (_ns, tag) => fakeNode(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener(type, handler) {
      documentListeners.set(type, handler);
    },
    removeEventListener(type) {
      documentListeners.delete(type);
    },
  };
  try {
    return await body({ host, documentListeners });
  } finally {
    globalThis.document = previous;
  }
}

/** 让浮窗里挂起的 Promise（估算）落地。 */
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

function build(overrides = {}) {
  const starts = [];
  const cancels = [];
  let closed = 0;
  const host = overrides.host ?? fakeNode("div");
  const panel = createExportPanel({
    host,
    entries: overrides.entries,
    defaultName: overrides.defaultName,
    preferences: overrides.preferences,
    onPreferences: overrides.onPreferences,
    onReveal: overrides.onReveal,
    estimate: overrides.estimate ?? (async () => ({ ms: 2000 })),
    onStart:
      overrides.onStart ??
      (async (config) => {
        starts.push(config);
        return { path: config.path, frames: 60, bytes: 1024, elapsedMs: 500 };
      }),
    onCancel: () => cancels.push(true),
    onClose: () => {
      closed += 1;
    },
  });
  return { panel, host, starts, cancels, closed: () => closed };
}

// --- 纯逻辑 ---

test("时长读成 分:秒.十分位", () => {
  assert.equal(formatDuration(0), "0:00.0");
  assert.equal(formatDuration(12_400), "0:12.4");
  assert.equal(formatDuration(125_000), "2:05.0");
  assert.equal(formatDuration(-1), "0:00.0");
});

test("文件名去掉多余后缀与空白，路径固定在 exports/ 下", () => {
  assert.equal(sanitizeName("  第一章  "), "第一章");
  assert.equal(sanitizeName("第一章.MP4"), "第一章");
  assert.equal(pathForName("demo"), "exports/demo.mp4");
  assert.equal(pathForName("  demo.mp4 "), "exports/demo.mp4");
});

test("文件名校验拦下空名、分隔符与点开头", () => {
  assert.equal(validateName("第一章"), null);
  assert.match(validateName("   "), /名字/);
  assert.match(validateName("a/b"), /不能包含/);
  assert.match(validateName("a?b"), /不能包含/);
  assert.match(validateName(".."), /点/);
  assert.match(validateName(".hidden"), /点/);
  assert.match(validateName("长".repeat(81)), /80/);
});

test("默认文件名从作品名来，去掉不能进文件名的字符", () => {
  // 全角冒号在文件名里是合法的，只去掉 Windows 不认的那几个。
  assert.equal(defaultNameFor("第一章：开始"), "第一章：开始");
  assert.equal(defaultNameFor("第一章:开始?"), "第一章开始");
  assert.equal(defaultNameFor(""), "export");
  assert.equal(defaultNameFor("   "), "export");
  assert.equal(defaultNameFor(null), "export");
});

test("轮盘：八个帧率从正上方起顺时针均分一圈", () => {
  const layout = wheelLayout(FPS_CHOICES.length, WHEEL_RADIUS);
  assert.equal(layout.length, 8);

  const [top] = layout;
  assert.equal(top.x, 0);
  assert.equal(top.y, -WHEEL_RADIUS, "第一项在正上方");

  const right = layout.find((item) => Math.abs(item.degrees - 0) < 1e-9);
  assert.equal(right.x, WHEEL_RADIUS, "第四项在正右方");
  assert.equal(right.y, 0);

  const bottom = layout.find((item) => Math.abs(item.degrees - 90) < 1e-9);
  assert.equal(bottom.y, WHEEL_RADIUS);
  assert.equal(bottom.x, 0);

  // 每一项都落在半径上，没有挤在一起。
  for (const item of layout) {
    const distance = Math.round(Math.hypot(item.x, item.y));
    assert.ok(Math.abs(distance - WHEEL_RADIUS) <= 1, `第 ${item.index} 项偏离半径`);
  }
});

test("进度百分比封顶 99%，完成时才给 100%", () => {
  assert.equal(progressPercent(0, 100), 0);
  assert.equal(progressPercent(50, 100), 50);
  assert.equal(progressPercent(100, 100), 99);
  assert.equal(progressPercent(120, 100), 99);
  assert.equal(progressPercent(100, 100, true), 100);
  assert.equal(progressPercent(5, 0), 99, "总帧数未知时不要假装走完");
});

// --- 浮窗 ---

test("浮窗：打开后是一张参数表，时长按剧本算出来", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel } = build({ host });
    panel.open({ name: "第一章", fps: 30 });
    assert.equal(panel.isOpen(), true);
    assert.equal(host.childNodes.length, 1);

    // 时长与总帧数是同一对只读格子，顺序即表单里的顺序。
    const statics = host.findAll("export-panel__static");
    const [duration, frames] = statics;
    assert.equal(duration.textContent, "计算中…");

    await flush();
    assert.match(duration.textContent, /0:02\.0/, "估算落地后显示时长");
    assert.match(duration.textContent, /按剧本/);

    // 默认 30fps，2 秒 = 60 帧。
    assert.equal(frames.textContent, "60 帧");

    const value = panel.value();
    assert.equal(value.path, "exports/第一章.mp4");
    assert.equal(value.width, 1920);
    assert.equal(value.fps, 30);
    assert.equal(value.timescale, 30_000, "每帧恰好 1000 ticks");
    assert.equal(value.keyFrameEvery, 60);
    panel.close();
  });
});

test("浮窗：帧率选框点开后展开轮盘，选一个即选定并原路收起", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel } = build({ host });
    panel.open({ name: "demo", fps: 30 });
    await flush();

    const wheel = host.find((node) => node.className === "export-wheel");
    assert.equal(wheel.hidden, true, "轮盘一开始是收起的");

    const trigger = host.find((node) => node.className === "export-panel__fps");
    trigger.dispatch("click");
    assert.equal(wheel.hidden, false);
    assert.equal(wheel.classList.contains("is-open"), true);

    const options = host.findAll("export-wheel__option");
    assert.deepEqual(
      options.map((node) => node.textContent),
      FPS_CHOICES.map(String),
    );
    // 每一项都拿到了自己的方位与出场次序。
    const first = options[0];
    assert.equal(first.style.getPropertyValue("--x"), "0px");
    assert.equal(first.style.getPropertyValue("--y"), `-${WHEEL_RADIUS}px`);
    assert.equal(first.style.getPropertyValue("--i"), "0");

    const sixty = options.find((node) => node.dataset.fps === "60");
    sixty.dispatch("click");
    assert.equal(panel.value().fps, 60);
    assert.equal(panel.value().keyFrameEvery, 120, "关键帧间隔跟着帧率走");
    assert.equal(sixty.getAttribute("aria-checked"), "true");

    // 收起是一个反向动画，动画走完才真正隐藏。
    assert.equal(wheel.classList.contains("is-open"), false);
    assert.equal(wheel.classList.contains("is-closing"), true);
    await new Promise((resolve) => setTimeout(resolve, WHEEL_ANIMATION_MS + 40));
    assert.equal(wheel.hidden, true);
    panel.close();
  });
});

test("浮窗：轮盘正中的取消点一下即原路收起，帧率不变", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel } = build({ host });
    panel.open({ name: "demo", fps: 30 });
    await flush();

    const wheel = host.find((node) => node.className === "export-wheel");
    host.find((node) => node.className === "export-panel__fps").dispatch("click");
    const cancel = host.find((node) => node.className === "export-wheel__cancel");
    cancel.dispatch("click");

    assert.equal(panel.value().fps, 30);
    assert.equal(wheel.classList.contains("is-closing"), true);
    await new Promise((resolve) => setTimeout(resolve, WHEEL_ANIMATION_MS + 40));
    assert.equal(wheel.hidden, true);
    panel.close();
  });
});

test("浮窗：名字不合法时不开始导出，错误写在表里", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel, starts } = build({ host });
    panel.open({ name: "demo", fps: 30 });
    await flush();

    const input = host.find((node) => node.className === "export-panel__input");
    input.value = "a/b";
    input.dispatch("input");
    assert.equal(input.classList.contains("is-invalid"), true);

    const primary = host.findAll("export-panel__button--primary")[0];
    primary.dispatch("click");
    await flush();

    assert.deepEqual(starts, [], "名字不合法就不该开会话");
    const error = host.find((node) => node.className === "export-panel__error");
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /不能包含/);
    panel.close();
  });
});

test("浮窗：导出时显示进度条、已渲染帧数与两个时长，完成后落到结果页", async () => {
  await withFakeDom(async ({ host }) => {
    let finish = null;
    const panel = createExportPanel({
      host,
      estimate: async () => ({ ms: 4000 }),
      onStart: (config) =>
        new Promise((resolve) => {
          finish = () => resolve({ path: config.path, frames: 120, bytes: 2_048, elapsedMs: 900 });
        }),
    });
    panel.open({ name: "demo", fps: 30 });
    await flush();

    const primary = host.findAll("export-panel__button--primary")[0];
    primary.dispatch("click");
    await flush();

    const phase = host.find((node) => node.className === "export-panel__phase");
    assert.equal(phase.textContent, "正在准备…", "开始后先到进度页");

    panel.setPhase("正在渲染…");
    assert.equal(phase.textContent, "正在渲染…");

    panel.setProgress({ frames: 60, t: 2000 });
    // 节流是给高频回调的：这里刚过 0ms，再推一次确保读数落地。
    panel.setProgress({ frames: 60, t: 2000 });
    const percent = host.find((node) => node.className === "export-panel__percent");
    assert.equal(percent.textContent, "50%", "60/120 帧");
    const bar = host.find((node) => node.className === "export-panel__fill");
    assert.equal(bar.style.width, "50%");

    const stats = host.findAll("export-panel__stat").map((node) => node.textContent);
    assert.ok(stats.some((text) => text === "已渲染 60 / ~120 帧"), stats.join(" | "));
    assert.ok(stats.some((text) => text === "视频 0:02.0"), stats.join(" | "));
    assert.ok(
      stats.some((text) => /^已用 \d+:\d\d\.\d$/.test(text)),
      "导出用了多久也要读得出来",
    );

    finish();
    await flush(10);
    const result = host.findAll("export-panel__path")[0];
    assert.equal(result.textContent, "exports/demo.mp4");
    assert.equal(host.find((node) => node.className === "export-panel__title").textContent, "导出完成");
    panel.close();
  });
});

test("浮窗：结果页显示每帧耗时，分项明细放在 title 里", async () => {
  await withFakeDom(async ({ host }) => {
    const metrics = {
      avgFrameMs: 12.5,
      stages: {
        render: { ms: 300, calls: 120 },
        seek: { ms: 120, calls: 120 },
        tint: { ms: 80, calls: 40 },
        encode: { ms: 200, calls: 120 },
        append: { ms: 60, calls: 120 },
      },
      counters: { reuse: 48 },
    };
    const panel = createExportPanel({
      host,
      estimate: async () => ({ ms: 4000 }),
      onStart: (config) =>
        Promise.resolve({
          path: config.path,
          frames: 120,
          bytes: 2_048,
          elapsedMs: 1500,
          metrics,
        }),
    });
    panel.open({ name: "demo", fps: 30 });
    await flush();

    host.findAll("export-panel__button--primary")[0].dispatch("click");
    await flush(10);

    const perFrame = host
      .findAll("export-panel__stat")
      .find((node) => /^每帧 /.test(node.textContent));
    assert.ok(perFrame, "结果页要显示每帧平均毫秒");
    assert.equal(perFrame.textContent, "每帧 12.5 ms");
    assert.match(perFrame.title, /取帧 120 ms/);
    assert.match(perFrame.title, /调色 80 ms（40 次）/);
    assert.match(perFrame.title, /复用 48 帧/);
    panel.close();
  });
});

test("浮窗：取消导出把取消交给会话，并停在进度页", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel, cancels } = build({
      host,
      onStart: () => new Promise(() => {}),
    });
    panel.open({ name: "demo", fps: 30 });
    await flush();

    host.findAll("export-panel__button--primary")[0].dispatch("click");
    await flush();

    const secondary = host.findAll("export-panel__button")[0];
    assert.equal(secondary.textContent, "取消导出");
    secondary.dispatch("click");

    assert.deepEqual(cancels, [true]);
    assert.equal(secondary.disabled, true);
    assert.equal(host.find((node) => node.className === "export-panel__phase").textContent, "正在取消…");
    panel.close();
  });
});

test("浮窗：关闭后从宿主上摘掉，并上报一次关闭", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel, closed } = build({ host });
    panel.open({ name: "demo", fps: 30 });
    await flush();
    const overlay = panel.element;

    panel.close();
    assert.equal(overlay.removed, true);
    assert.equal(panel.isOpen(), false);
    assert.equal(closed(), 1);
    panel.close();
    assert.equal(closed(), 1, "重复关闭不重复上报");
  });
});

// --- 偏好与入口脚本 ---

const NO_PREFS = {
  resolution: null,
  fps: null,
  bitrate: null,
  keyframeSeconds: null,
  choiceMode: null,
  entry: null,
};

test("偏好参数只认合法值，认不出的留空而不是猜一个", () => {
  assert.deepEqual(
    sanitizePreferences({
      resolution: "1280x720",
      fps: 60,
      bitrate: 12_000_000,
      keyframe_seconds: 5,
      choice_mode: "recorded",
      entry: " scripts/ch1.pe ",
    }),
    {
      resolution: "1280x720",
      fps: 60,
      bitrate: 12_000_000,
      keyframeSeconds: 5,
      choiceMode: "recorded",
      entry: "scripts/ch1.pe",
    },
  );

  // 旧版本或手工改坏的文件：每一项都退回默认，而不是把整份偏好判为损坏。
  assert.deepEqual(
    sanitizePreferences({
      resolution: "8k",
      fps: 33,
      bitrate: 7,
      keyframe_seconds: 3,
      choice_mode: "all",
      entry: 42,
    }),
    NO_PREFS,
  );
  assert.deepEqual(sanitizePreferences(null), NO_PREFS);
  assert.deepEqual(sanitizePreferences("junk"), NO_PREFS);
});

test("偏好对象按后端字段名写：snake_case", () => {
  assert.deepEqual(preferencesOf({
    resolution: "960x540",
    fps: 24,
    bitrate: 4_000_000,
    keyframeSeconds: 2,
    choiceMode: "first",
    entry: "scripts/main.pe",
  }), {
    resolution: "960x540",
    fps: 24,
    bitrate: 4_000_000,
    keyframe_seconds: 2,
    choice_mode: "first",
    entry: "scripts/main.pe",
  });
  assert.deepEqual(
    CHOICE_MODES.map((item) => item.value),
    ["first", "recorded"],
  );
});

test("换入口脚本时默认文件名跟着换，不覆盖作者写好的名字", () => {
  assert.equal(defaultNameForEntry("星海", "scripts/main.pe"), "星海");
  assert.equal(defaultNameForEntry("星海", "scripts/ch1.pe"), "星海-ch1");
  // 作品名与脚本名相同时不重复拼。
  assert.equal(defaultNameForEntry("ch1", "scripts/ch1.pe"), "ch1");
  assert.equal(defaultNameForEntry("星海", ""), "星海");
});

test("浮窗：上次的导出参数与入口脚本在打开时恢复", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel } = build({
      host,
      entries: ["scripts/main.pe", "scripts/ch1.pe"],
      defaultName: (entry) => defaultNameForEntry("星海", entry),
      preferences: {
        resolution: "1280x720",
        fps: 60,
        bitrate: 4_000_000,
        keyframe_seconds: 1,
        choice_mode: "recorded",
        entry: "scripts/ch1.pe",
      },
    });
    panel.open({ entry: "scripts/main.pe" });
    await flush();

    const value = panel.value();
    assert.equal(value.fps, 60);
    assert.equal(value.width, 1280);
    assert.equal(value.bitrate, 4_000_000);
    assert.equal(value.keyFrameEvery, 60, "每 1 秒一个关键帧 @60fps");
    assert.equal(value.choiceMode, "recorded");
    assert.equal(value.entry, "scripts/ch1.pe", "上次导过的入口优先于清单入口");
    assert.equal(value.name, "星海-ch1", "默认名字跟着入口脚本走");
    panel.close();
  });
});

test("浮窗：参数一改就上报，供宿主写进偏好文件", async () => {
  await withFakeDom(async ({ host }) => {
    const reported = [];
    const { panel } = build({
      host,
      entries: ["scripts/main.pe", "scripts/ch1.pe"],
      // 作品名为空时 `defaultNameForEntry` 用 `export` 兜底。
      defaultName: (entry) => defaultNameForEntry("", entry),
      onPreferences: (prefs) => reported.push(prefs),
    });
    panel.open({ entry: "scripts/main.pe" });
    await flush();

    const byLabel = (label) => host.find((node) => node.getAttribute?.("aria-label") === label);

    const resolution = byLabel("画面尺寸");
    resolution.value = "960x540";
    resolution.dispatch("change");
    assert.equal(reported.at(-1).resolution, "960x540");
    assert.equal(panel.value().width, 960);

    const choice = byLabel("选择支");
    choice.value = "recorded";
    choice.dispatch("change");
    assert.equal(reported.at(-1).choice_mode, "recorded");
    assert.equal(panel.value().choiceMode, "recorded");

    const entry = byLabel("入口脚本");
    entry.value = "scripts/ch1.pe";
    entry.dispatch("change");
    assert.equal(reported.at(-1).entry, "scripts/ch1.pe");
    assert.equal(panel.value().name, "export-ch1", "作品名缺省时跟着脚本名");
    await flush();
    panel.close();
  });
});

test("浮窗：作者改过名字之后，换入口脚本不再覆盖它", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel } = build({
      host,
      entries: ["scripts/main.pe", "scripts/ch1.pe"],
      defaultName: (entry) => defaultNameForEntry("星海", entry),
    });
    panel.open({ entry: "scripts/main.pe" });
    await flush();

    const input = host.find((node) => node.className === "export-panel__input");
    input.value = "我的成片";
    input.dispatch("input");

    const entry = host.find((node) => node.getAttribute?.("aria-label") === "入口脚本");
    entry.value = "scripts/ch1.pe";
    entry.dispatch("change");
    await flush();

    assert.equal(panel.value().name, "我的成片");
    assert.equal(panel.value().entry, "scripts/ch1.pe");
    panel.close();
  });
});

test("浮窗：估算拿到当前参数草稿，入口脚本与服务端参数一致", async () => {
  await withFakeDom(async ({ host }) => {
    const drafts = [];
    const { panel, starts } = build({
      host,
      entries: ["scripts/main.pe", "scripts/ch1.pe"],
      estimate: async (draft) => {
        drafts.push(draft);
        return { ms: 1000 };
      },
    });
    panel.open({ entry: "scripts/main.pe" });
    await flush();

    assert.equal(drafts.at(-1).entry, "scripts/main.pe");
    assert.equal(drafts.at(-1).fps, panel.value().fps, "草稿与真导出用同一个帧率");
    assert.equal(drafts.at(-1).choiceMode, panel.value().choiceMode);

    host.findAll("export-panel__button--primary")[0].dispatch("click");
    await flush(8);
    assert.equal(starts.at(-1).entry, "scripts/main.pe");
    assert.equal(starts.at(-1).choiceMode, panel.value().choiceMode);
    panel.close();
  });
});

test("浮窗：结果页能带作者去文件夹，也能留在浮窗里再导一次", async () => {
  await withFakeDom(async ({ host }) => {
    const revealed = [];
    const { panel } = build({ host, onReveal: (path) => revealed.push(path) });
    panel.open({ name: "demo", fps: 30 });
    await flush();

    host.findAll("export-panel__button--primary")[0].dispatch("click");
    await flush(10);

    const links = host.findAll("export-panel__link").map((node) => node.textContent);
    assert.deepEqual(links, ["在文件夹中显示", "再导一次"]);

    host.findAll("export-panel__link")[0].dispatch("click");
    assert.deepEqual(revealed, ["exports/demo.mp4"]);

    host.findAll("export-panel__link")[1].dispatch("click");
    const form = host.find((node) => node.className === "export-panel__form");
    assert.equal(form.hidden, false, "再导一次回到参数页而不是关窗");
    assert.equal(panel.isOpen(), true);
    panel.close();
  });
});

test("浮窗：导出失败时不给「在文件夹中显示」", async () => {
  await withFakeDom(async ({ host }) => {
    const { panel } = build({
      host,
      onStart: async () => ({ error: "编码器不接受这个分辨率" }),
    });
    panel.open({ name: "demo" });
    await flush();

    host.findAll("export-panel__button--primary")[0].dispatch("click");
    await flush(10);

    const actions = host.find((node) => node.className === "export-panel__actions");
    assert.equal(actions.hidden, true);
    assert.match(
      host.findAll("export-panel__path")[0].textContent,
      /编码器不接受/,
    );
    panel.close();
  });
});

// --- 接线守卫 ---

test("导出浮窗的接线：菜单命令仍走 exportMp4，浮窗与时长估算都在组合根上", () => {
  const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const main = read("main.js");
  const html = read("index.html");

  assert.match(main, /import \{ createExportPanel, defaultNameForEntry \} from "\.\/export-panel\.js"/);
  assert.match(main, /import \{ estimateDuration \} from "\.\/export-estimate\.js"/);
  assert.match(main, /const panel = createExportPanel\(\{/);
  assert.match(main, /estimate: async \(draft = \{\}\) => \{/);
  assert.match(main, /onStart: \(config\) => runExport\(config\)/);
  // 时长与真导出必须用同一个选择支策略，否则两条路径走的剧本不一样长。
  assert.equal(
    [...main.matchAll(/chooseStrategy: choiceStrategyFor\(([^)]*)\)/g)].length,
    2,
    "估算与导出各接一次选择支策略",
  );
  assert.match(main, /preferences: lifecycle\.state\.export/);
  assert.match(main, /onPreferences: \(prefs\) => \{/);
  assert.match(main, /onReveal: \(path\) => \{/);
  assert.match(main, /entries: scripts/);
  // 取消要同时记住意图并叫停帧循环：准备阶段还没有会话可取消。
  assert.match(main, /cancelRequested = true;\s*exporting\?\.cancel\(\);/);
  assert.match(main, /onProgress: \(\{ frames, t \}\) => panel\.setProgress\(\{ frames, t \}\)/);
  assert.match(main, /canvas\.width = config\.width/);
  assert.match(main, /canvas\.height = config\.height/);

  assert.match(html, /styles\/export-panel\.css/);
});
