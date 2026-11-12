// 导出 MP4 的参数浮窗：文件名、入口脚本、时长、帧率（轮盘）、画面参数、选择支
// 策略与导出进度。
// Pamela — the export sheet: what to write, from which script, how fast, and how far.
//
// 浮窗是窗口级的一层（不是舞台内的一层）：导出本来就不占用舞台 DOM，画面画在
// 离屏画布上，所以这一层覆盖整个窗口，与「文件 → 导出 MP4…」的位置一致。
//
// 帧率不用下拉框，用一个实验性的轮盘：点一下选框，八个帧率从中心依次弹出，
// 选一个即选定并原路收起；轮盘正中是取消，点它同样原路收起。收起顺序是打开
// 顺序的倒放，所以看上去是「原路」回去而不是一起消失。
//
// 参数会跨启动记住：`preferences` 进来（上次写的），每次改动经 `onPreferences`
// 出去，由宿主写进偏好文件。字段名是 snake_case，与 `AppState.export` 对齐。

import { createIcon } from "./icons.js";
import { framesFor } from "./export-estimate.js";
import { createSelect } from "./select.js";

/** 可选的帧率，八个正好绕满一圈。 */
export const FPS_CHOICES = Object.freeze([12, 24, 25, 30, 50, 60, 90, 120]);

/** 画面尺寸：都保持 16:9，渲染后端按这个尺寸画布。 */
export const RESOLUTIONS = Object.freeze([
  { value: "1920x1080", label: "1920 × 1080", width: 1920, height: 1080 },
  { value: "1280x720", label: "1280 × 720", width: 1280, height: 720 },
  { value: "960x540", label: "960 × 540", width: 960, height: 540 },
]);

export const BITRATES = Object.freeze([
  { value: 4_000_000, label: "4 Mbps" },
  { value: 8_000_000, label: "8 Mbps" },
  { value: 12_000_000, label: "12 Mbps" },
  { value: 16_000_000, label: "16 Mbps" },
]);

/** 关键帧间隔，按秒给；写入配置时乘以帧率。 */
export const KEYFRAME_CHOICES = Object.freeze([1, 2, 5]);

/** 选择支怎么走；`recorded` 读的是上一轮演出的记录。 */
export const CHOICE_MODES = Object.freeze([
  { value: "first", label: "固定第一项" },
  { value: "recorded", label: "按上次运行" },
]);

/** 轮盘半径（像素）与弹出/收起动画时长（毫秒）。 */
export const WHEEL_RADIUS = 88;
export const WHEEL_ANIMATION_MS = 300;

/** 文件名里不允许出现的字符（后端按项目内相对路径落盘）。 */
const ILLEGAL_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 毫秒 → `分:秒.十分位`，进度与时长共用一种读法。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

/** 去掉首尾空白与多余的 `.mp4`：输入框里写的是名字，不是后缀。 */
export function sanitizeName(raw) {
  let name = String(raw ?? "").trim();
  if (name.toLowerCase().endsWith(".mp4")) {
    name = name.slice(0, -4);
  }
  return name.trim();
}

/**
 * @param {string} raw
 * @returns {string|null} 错误文案；通过时为 null。
 */
export function validateName(raw) {
  const name = sanitizeName(raw);
  if (!name) {
    return "请先给视频起个名字";
  }
  if (ILLEGAL_NAME.test(name)) {
    return '文件名不能包含 \\ / : * ? " < > |';
  }
  if (name === "." || name === ".." || name.startsWith(".")) {
    return "文件名不能以点开头";
  }
  if (name.length > 80) {
    return "文件名最多 80 个字符";
  }
  return null;
}

/** 名字 → 项目内的导出路径；后端只接受 `exports/*.mp4`。 */
export function pathForName(raw) {
  return `exports/${sanitizeName(raw)}.mp4`;
}

/** 默认文件名：把作品名里不能进文件名的字符去掉，实在没有就叫 export。 */
export function defaultNameFor(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "export";
}

/**
 * 换了入口脚本之后跟着换的默认文件名。
 *
 * 同一个项目导出多个场景时，文件名要能自己区分开：入口脚本是 `main` 就用
 * 作品名，别的场景拼成 `<作品>-<脚本名>`，否则第二次导出会覆盖第一次。
 *
 * @param {string} projectName
 * @param {string} entry 入口脚本的项目相对路径
 * @returns {string}
 */
export function defaultNameForEntry(projectName, entry) {
  const project = defaultNameFor(projectName);
  const file = String(entry ?? "").split("/").pop() ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  const base = stem ? defaultNameFor(stem) : "";
  if (!base || base === project || base === "main") {
    return project;
  }
  return defaultNameFor(`${project}-${base}`);
}

/**
 * 把偏好文件里读到的导出参数滤成可用的值。
 *
 * 偏好文件可能是旧版本写的、也可能被手工改坏：认不出的值一律回答 `null`，
 * 由调用方回落到内置默认，而不是把一个非法帧率当成用户的选择。
 *
 * @param {unknown} raw `AppState.export` 的原样内容
 * @returns {{resolution: string|null, fps: number|null, bitrate: number|null,
 *   keyframeSeconds: number|null, choiceMode: string|null, entry: string|null}}
 */
export function sanitizePreferences(raw) {
  const source = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const resolution = RESOLUTIONS.find((item) => item.value === String(source.resolution ?? ""));
  const fps = FPS_CHOICES.includes(Number(source.fps)) ? Number(source.fps) : null;
  const bitrate = BITRATES.find((item) => item.value === Number(source.bitrate));
  const keyframeSeconds = KEYFRAME_CHOICES.includes(Number(source.keyframe_seconds))
    ? Number(source.keyframe_seconds)
    : null;
  const choiceMode = CHOICE_MODES.some((item) => item.value === source.choice_mode)
    ? String(source.choice_mode)
    : null;
  const entry =
    typeof source.entry === "string" && source.entry.trim() ? source.entry.trim() : null;
  return {
    resolution: resolution ? resolution.value : null,
    fps,
    bitrate: bitrate ? bitrate.value : null,
    keyframeSeconds,
    choiceMode,
    entry,
  };
}

/**
 * 面板状态 → 偏好对象（snake_case，与 `AppState.export` 对齐）。
 *
 * @param {{resolution: string, fps: number, bitrate: number, keyframeSeconds: number,
 *   choiceMode: string, entry: string}} state
 * @returns {{resolution: string, fps: number, bitrate: number, keyframe_seconds: number,
 *   choice_mode: string, entry: string}}
 */
export function preferencesOf(state) {
  return {
    resolution: state.resolution,
    fps: state.fps,
    bitrate: state.bitrate,
    keyframe_seconds: state.keyframeSeconds,
    choice_mode: state.choiceMode,
    entry: state.entry,
  };
}

/**
 * 轮盘上每一项的落点：从正上方开始顺时针均分一圈。
 *
 * @param {number} count
 * @param {number} [radius]
 * @returns {Array<{index: number, degrees: number, x: number, y: number}>}
 */
export function wheelLayout(count, radius = WHEEL_RADIUS) {
  const total = Math.max(1, Math.floor(Number(count) || 0));
  const span = Number.isFinite(Number(radius)) ? Number(radius) : WHEEL_RADIUS;
  return Array.from({ length: total }, (_, index) => {
    const degrees = -90 + (index * 360) / total;
    const radians = (degrees * Math.PI) / 180;
    return {
      index,
      degrees,
      x: Math.round(Math.cos(radians) * span),
      y: Math.round(Math.sin(radians) * span),
    };
  });
}

/**
 * 进度百分比。未完成时封顶 99%：总帧数是从时间线现算的，最后的 1% 留给收尾。
 *
 * @param {number} frames
 * @param {number} totalFrames
 * @param {boolean} [done]
 * @returns {number} 0–100 的整数
 */
export function progressPercent(frames, totalFrames, done = false) {
  if (done) {
    return 100;
  }
  const total = Math.max(1, Number(totalFrames) || 0);
  const shown = Math.max(0, Number(frames) || 0);
  return Math.min(99, Math.max(0, Math.floor((shown / total) * 100)));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(className, text) {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

/** 上次用过的参数：同一会话里再导出一次，不该重新选一遍。 */
const remembered = {
  fps: 30,
  resolution: RESOLUTIONS[0].value,
  bitrate: BITRATES[1].value,
  keyframeSeconds: KEYFRAME_CHOICES[1],
  choiceMode: CHOICE_MODES[0].value,
};

/**
 * 造一个导出浮窗。
 *
 * @param {object} options
 * @param {HTMLElement} [options.host] 挂载点，默认 `document.body`
 * @param {Array<string|{value: string, label: string}>} [options.entries]
 *   可选的入口脚本；超过一个时浮窗多一行选择
 * @param {(entry: string) => string} [options.defaultName]
 *   换了入口脚本之后该用的文件名（作者改过名字就不再覆盖）
 * @param {object|null} [options.preferences] 上次保存的导出参数（snake_case）
 * @param {(prefs: object) => void} [options.onPreferences] 参数改动后上报
 * @param {(path: string) => void} [options.onReveal] 结果页「在文件夹中显示」
 * @param {(draft?: object) => Promise<number|{ms: number, error?: string|null}>} [options.estimate]
 *   按剧本推算时长（毫秒）；入参是当前的参数草稿（入口脚本、帧率、选择支策略）
 * @param {(config: object) => Promise<object>} [options.onStart]
 *   开始导出；resolve 出 `{ path, frames, bytes, elapsedMs }`，取消时 `{ cancelled: true }`
 * @param {() => void} [options.onCancel] 进度界面里的取消
 * @param {() => void} [options.onClose]
 * @returns {object} 浮窗句柄
 */
export function createExportPanel({
  host = null,
  entries = [],
  defaultName = null,
  preferences = null,
  onPreferences = null,
  onReveal = null,
  estimate = null,
  onStart = async () => ({}),
  onCancel = () => {},
  onClose = () => {},
} = {}) {
  let overlay = null;
  let card = null;
  let closed = true;
  let wheelOpen = false;
  let wheelTimer = null;
  let estimateToken = 0;
  let lastPaint = 0;

  const stored = sanitizePreferences(preferences);
  /** 本次浮窗的起始值：偏好文件优先，其次是同一会话上次用过的值。 */
  const defaults = {
    fps: stored.fps ?? remembered.fps,
    resolution: stored.resolution ?? remembered.resolution,
    bitrate: stored.bitrate ?? remembered.bitrate,
    keyframeSeconds: stored.keyframeSeconds ?? remembered.keyframeSeconds,
    choiceMode: stored.choiceMode ?? remembered.choiceMode,
    entry: stored.entry ?? "",
  };

  /** 可选入口脚本；支持字符串与 `{ value, label }` 两种写法。 */
  const entryOptions = (entries ?? [])
    .map((item) =>
      typeof item === "string"
        ? { value: item, label: item }
        : { value: String(item?.value ?? ""), label: String(item?.label ?? item?.value ?? "") },
    )
    .filter((item) => item.value);

  const state = {
    name: "export",
    fps: defaults.fps,
    resolution: defaults.resolution,
    bitrate: defaults.bitrate,
    keyframeSeconds: defaults.keyframeSeconds,
    choiceMode: defaults.choiceMode,
    entry: "",
    /** 作者亲手改过文件名：换入口脚本时不再自动覆盖。 */
    nameEdited: false,
    resultPath: "",
    estimatedMs: 0,
    estimateError: null,
    estimateState: "loading", // loading | ready | failed
    view: "form", // form | progress | result
    frames: 0,
    videoMs: 0,
    startedAt: 0,
    done: false,
    cancelled: false,
  };

  const dom = {};

  const mount = () => host ?? document.body;

  const destroy = () => {
    if (wheelTimer) {
      clearTimeout(wheelTimer);
      wheelTimer = null;
    }
    wheelOpen = false;
    document.removeEventListener("keydown", onKeyDown, true);
    overlay?.remove?.();
    overlay = null;
    card = null;
    dom.form = null;
  };

  // --- 参数 ---

  /** 当前浮窗读出的导出配置；`exports/<名字>.mp4` 是后端唯一接受的形状。 */
  function value() {
    const resolution =
      RESOLUTIONS.find((item) => item.value === state.resolution) ?? RESOLUTIONS[0];
    const fps = Math.max(1, Math.round(Number(state.fps) || 30));
    return {
      name: sanitizeName(state.name),
      path: pathForName(state.name),
      width: resolution.width,
      height: resolution.height,
      fps,
      // 每秒 ticks 取 fps×1000，于是每帧恰好 1000 ticks（90fps 也不会攒出漂移）。
      timescale: fps * 1000,
      bitrate: Number(state.bitrate) || BITRATES[1].value,
      keyFrameEvery: Math.max(1, Math.round(fps * Number(state.keyframeSeconds))),
      // 与导出侧的上限同一语义：一小时。
      maxFrames: Math.max(108_000, fps * 3600),
      // 进度回调的间隔：每秒视频两次，足够让进度条连续动。
      progressEvery: Math.max(1, Math.round(fps / 2)),
      // 下面两项不进后端参数表，只给宿主的取脚本 / 选择支策略用。
      entry: state.entry,
      choiceMode: state.choiceMode,
    };
  }

  /** 参数变了：同步进偏好文件，下次打开浮窗不用重选。 */
  function remember() {
    onPreferences?.(preferencesOf(state));
  }

  /**
   * 打开时用哪个入口脚本：上次导过的优先（偏好文件），其次是清单入口，
   * 两者都已不存在（脚本被改名或删掉）时退回列表第一项。
   */
  function pickEntry(wanted) {
    for (const candidate of [defaults.entry, String(wanted ?? "")]) {
      if (candidate && entryOptions.some((item) => item.value === candidate)) {
        return candidate;
      }
    }
    return entryOptions[0]?.value ?? "";
  }

  /** 总帧数：估出来的时长与已经渲染到的时刻取较长的一个。 */
  function totalFrames() {
    const base = Math.max(Number(state.estimatedMs) || 0, state.videoMs);
    return Math.max(state.frames, framesFor(base, state.fps));
  }

  // --- 表单 ---

  function row(label, control, hint) {
    const line = element("div", "export-panel__row");
    const caption = element("span", "export-panel__label", label);
    const cell = element("div", "export-panel__control");
    cell.append(control);
    if (hint) {
      const note = element("span", "export-panel__hint", hint);
      cell.append(note);
    }
    line.append(caption, cell);
    return line;
  }

  function buildForm() {
    const form = element("div", "export-panel__form");

    const name = element("input", "export-panel__input");
    name.type = "text";
    name.spellcheck = false;
    name.value = state.name;
    name.setAttribute("aria-label", "导出文件名");
    name.addEventListener("input", () => {
      state.name = name.value;
      state.nameEdited = true;
      paintForm();
    });
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void submit();
      }
    });
    dom.name = name;
    dom.nameHint = element("span", "export-panel__hint");
    const nameCell = element("div", "export-panel__control");
    nameCell.append(name, dom.nameHint);
    const nameRow = element("div", "export-panel__row export-panel__row--name");
    nameRow.append(element("span", "export-panel__label", "文件名"), nameCell);
    form.append(nameRow);

    // 一个项目可以有很多场景：从哪一份脚本开始导出，由这一行决定。
    if (entryOptions.length > 1) {
      dom.entry = createSelect({
        options: entryOptions,
        value: state.entry,
        className: "export-panel__select",
        label: "入口脚本",
      });
      dom.entry.addEventListener("change", () => {
        state.entry = dom.entry.value;
        if (!state.nameEdited && defaultName) {
          state.name = defaultName(state.entry);
        }
        paintForm();
        remember();
        // 时长按脚本算：换了脚本，总帧数与进度条的分母都得重算。
        void runEstimate();
      });
      form.append(row("入口脚本", dom.entry));
    }

    dom.duration = element("span", "export-panel__static", "计算中…");
    form.append(row("视频时长", dom.duration));

    dom.fps = button("export-panel__fps");
    dom.fps.setAttribute("aria-label", "帧率");
    dom.fps.setAttribute("aria-haspopup", "true");
    dom.fpsValue = element("span", "export-panel__fps-value");
    dom.fps.append(dom.fpsValue, createIcon("chevron-down"));
    dom.fps.addEventListener("click", () => (wheelOpen ? closeWheel() : openWheel()));
    form.append(row("帧率", dom.fps));

    dom.frames = element("span", "export-panel__static");
    form.append(row("总帧数", dom.frames));

    dom.resolution = createSelect({
      options: RESOLUTIONS.map((item) => ({ value: item.value, label: item.label })),
      value: state.resolution,
      className: "export-panel__select",
      label: "画面尺寸",
    });
    dom.resolution.addEventListener("change", () => {
      state.resolution = dom.resolution.value;
      remembered.resolution = state.resolution;
      remember();
    });
    form.append(row("画面尺寸", dom.resolution));

    dom.bitrate = createSelect({
      options: BITRATES.map((item) => ({ value: item.value, label: item.label })),
      value: String(state.bitrate),
      className: "export-panel__select",
      label: "码率",
    });
    dom.bitrate.addEventListener("change", () => {
      state.bitrate = Number(dom.bitrate.value) || state.bitrate;
      remembered.bitrate = state.bitrate;
      remember();
    });
    form.append(row("码率", dom.bitrate));

    dom.keyframe = createSelect({
      options: KEYFRAME_CHOICES.map((seconds) => ({
        value: String(seconds),
        label: `每 ${seconds} 秒`,
      })),
      value: String(state.keyframeSeconds),
      className: "export-panel__select",
      label: "关键帧间隔",
    });
    dom.keyframe.addEventListener("change", () => {
      state.keyframeSeconds = Number(dom.keyframe.value) || state.keyframeSeconds;
      remembered.keyframeSeconds = state.keyframeSeconds;
      remember();
    });
    form.append(row("关键帧", dom.keyframe));

    // 选择支默认固定第一项；`按上次运行` 沿用最近一次演出给出的答案。
    dom.choice = createSelect({
      options: CHOICE_MODES.map((item) => ({ value: item.value, label: item.label })),
      value: state.choiceMode,
      className: "export-panel__select",
      label: "选择支",
    });
    dom.choice.addEventListener("change", () => {
      state.choiceMode = dom.choice.value || CHOICE_MODES[0].value;
      remembered.choiceMode = state.choiceMode;
      remember();
      // 走的分支不同，剧本长度就不同：时长要按新策略重算。
      void runEstimate();
    });
    form.append(row("选择支", dom.choice, "「按上次运行」沿用本轮演出的选择，没有记录时走第一项"));

    dom.formError = element("p", "export-panel__error");
    dom.formError.hidden = true;
    form.append(dom.formError);

    dom.form = form;
    return form;
  }

  /** 重画表单里所有「读出来」的文字（输入、帧率、时长、总帧数）。 */
  function paintForm() {
    if (!dom.form || state.view !== "form") {
      return;
    }
    if (dom.name.value !== state.name) {
      dom.name.value = state.name;
    }
    const error = validateName(state.name);
    dom.nameHint.textContent = error ? "" : pathForName(state.name);
    dom.name.classList.toggle("is-invalid", Boolean(error));

    dom.fpsValue.textContent = `${state.fps} fps`;
    dom.frames.textContent = `${totalFrames()} 帧`;

    if (state.estimateState === "loading") {
      dom.duration.textContent = "计算中…";
      dom.duration.classList.add("is-muted");
    } else if (state.estimateState === "failed") {
      dom.duration.textContent = "—";
      dom.duration.classList.add("is-muted");
    } else {
      dom.duration.textContent = `${formatDuration(state.estimatedMs)}（按剧本计算）`;
      dom.duration.classList.remove("is-muted");
    }
  }

  // --- 轮盘 ---

  function buildWheel() {
    const wheel = element("div", "export-wheel");
    wheel.hidden = true;
    const dial = element("div", "export-wheel__dial");
    dial.style.setProperty("--count", String(FPS_CHOICES.length));
    dial.style.setProperty("--radius", `${WHEEL_RADIUS}px`);

    const cancel = button("export-wheel__cancel", "取消");
    cancel.setAttribute("aria-label", "收起轮盘");
    cancel.addEventListener("click", () => closeWheel());
    dial.append(cancel);

    const layout = wheelLayout(FPS_CHOICES.length, WHEEL_RADIUS);
    for (const [index, fps] of FPS_CHOICES.entries()) {
      const option = button("export-wheel__option", String(fps));
      option.dataset.fps = String(fps);
      option.style.setProperty("--x", `${layout[index].x}px`);
      option.style.setProperty("--y", `${layout[index].y}px`);
      option.style.setProperty("--i", String(index));
      option.setAttribute("aria-checked", String(fps === state.fps));
      option.addEventListener("click", () => {
        setFps(fps);
        closeWheel();
      });
      dial.append(option);
    }

    wheel.append(dial);
    dom.wheel = wheel;
    dom.dial = dial;
    return wheel;
  }

  function setFps(fps) {
    state.fps = fps;
    remembered.fps = fps;
    for (const option of dom.dial?.childNodes ?? []) {
      if (option.dataset?.fps) {
        option.setAttribute("aria-checked", String(Number(option.dataset.fps) === fps));
      }
    }
    paintForm();
  }

  function openWheel() {
    if (!dom.wheel || wheelOpen) {
      return;
    }
    wheelOpen = true;
    if (wheelTimer) {
      clearTimeout(wheelTimer);
      wheelTimer = null;
    }
    dom.wheel.hidden = false;
    dom.wheel.classList.remove("is-closing");
    // 先让「收起」的样式生效一帧，过渡才有起点。
    void dom.wheel.offsetWidth;
    dom.wheel.classList.add("is-open");
  }

  /** 原路收起：反向的 stagger 由 CSS 的 `--i` 与 `--count` 算出。 */
  function closeWheel() {
    if (!dom.wheel || !wheelOpen) {
      return;
    }
    wheelOpen = false;
    dom.wheel.classList.remove("is-open");
    dom.wheel.classList.add("is-closing");
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      if (!dom.wheel) {
        return;
      }
      dom.wheel.classList.remove("is-closing");
      dom.wheel.hidden = true;
    }, WHEEL_ANIMATION_MS);
  }

  // --- 进度 ---

  function buildProgress() {
    const section = element("div", "export-panel__progress");

    dom.phase = element("p", "export-panel__phase", "正在准备…");
    const bar = element("div", "export-panel__bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    dom.fill = element("div", "export-panel__fill");
    bar.append(dom.fill);

    const stats = element("div", "export-panel__stats");
    dom.percent = element("span", "export-panel__percent", "0%");
    dom.frameStat = element("span", "export-panel__stat", "已渲染 0 / ~0 帧");
    dom.videoStat = element("span", "export-panel__stat", "视频 0:00.0");
    dom.elapsedStat = element("span", "export-panel__stat", "已用 0:00.0");
    stats.append(dom.percent, dom.frameStat, dom.videoStat, dom.elapsedStat);

    dom.bar = bar;
    section.append(dom.phase, bar, stats);
    dom.progress = section;
    return section;
  }

  function paintProgress() {
    if (!dom.bar || state.view !== "progress") {
      return;
    }
    const total = totalFrames();
    const percent = progressPercent(state.frames, total, state.done);
    dom.fill.style.width = `${percent}%`;
    dom.bar.setAttribute("aria-valuenow", String(percent));
    dom.percent.textContent = `${percent}%`;
    dom.frameStat.textContent = `已渲染 ${state.frames} / ~${total} 帧`;
    dom.videoStat.textContent = `视频 ${formatDuration(state.videoMs)}`;
    dom.elapsedStat.textContent = `已用 ${formatDuration(Date.now() - state.startedAt)}`;
  }

  // --- 结果 ---

  function buildResult() {
    const section = element("div", "export-panel__result");
    dom.resultTitle = element("p", "export-panel__phase", "导出完成");
    dom.resultPath = element("p", "export-panel__path");
    dom.resultStats = element("div", "export-panel__stats");

    // 「再导一次」回到参数页而不是关掉浮窗：同一个场景常要试两种码率。
    dom.resultActions = element("div", "export-panel__actions");
    dom.reveal = button("export-panel__link", "在文件夹中显示");
    dom.reveal.addEventListener("click", () => {
      if (state.resultPath) {
        onReveal?.(state.resultPath);
      }
    });
    dom.again = button("export-panel__link", "再导一次");
    dom.again.addEventListener("click", () => {
      setView("form");
      paintForm();
      void runEstimate();
    });
    dom.resultActions.append(dom.reveal, dom.again);

    section.append(dom.resultTitle, dom.resultPath, dom.resultStats, dom.resultActions);
    dom.result = section;
    return section;
  }

  // --- 视图切换 ---

  function setView(view) {
    state.view = view;
    if (dom.form) {
      dom.form.hidden = view !== "form";
    }
    if (dom.progress) {
      dom.progress.hidden = view !== "progress";
    }
    if (dom.result) {
      dom.result.hidden = view !== "result";
    }
    if (view !== "form") {
      closeWheel();
    }

    if (view === "form") {
      dom.primary.textContent = "开始导出";
      dom.primary.disabled = false;
      dom.primary.hidden = false;
      dom.secondary.textContent = "取消";
      dom.secondary.hidden = false;
      primaryAction = submit;
      secondaryAction = () => close();
      dom.title.textContent = "导出 MP4";
    } else if (view === "progress") {
      dom.primary.hidden = true;
      dom.secondary.textContent = "取消导出";
      dom.secondary.hidden = false;
      dom.secondary.disabled = false;
      secondaryAction = () => requestCancel();
      dom.title.textContent = "正在导出";
    } else {
      dom.primary.textContent = "关闭";
      dom.primary.hidden = false;
      dom.primary.disabled = false;
      dom.secondary.hidden = true;
      primaryAction = () => close();
    }
  }

  function requestCancel() {
    if (state.cancelled) {
      return;
    }
    state.cancelled = true;
    dom.secondary.disabled = true;
    dom.phase.textContent = "正在取消…";
    onCancel();
  }

  // --- 挂载 ---

  function build() {
    overlay = element("div", "export-panel");
    card = element("div", "export-panel__card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "导出 MP4");

    const head = element("div", "export-panel__head");
    dom.title = element("span", "export-panel__title", "导出 MP4");
    const dismiss = button("export-panel__close");
    dismiss.title = "关闭";
    dismiss.setAttribute("aria-label", "关闭");
    dismiss.append(createIcon("close"));
    // 导出进行中，关掉浮窗等于把任务留在背后跑：这一下改成叫停。
    dismiss.addEventListener("click", () => (state.view === "progress" ? requestCancel() : close()));
    head.append(dom.title, dismiss);

    const body = element("div", "export-panel__body");
    body.append(buildForm(), buildProgress(), buildResult());

    const foot = element("div", "export-panel__foot");
    dom.secondary = button("export-panel__button", "取消");
    dom.primary = button("export-panel__button export-panel__button--primary", "开始导出");
    dom.secondary.addEventListener("click", () => secondaryAction());
    dom.primary.addEventListener("click", () => primaryAction());
    foot.append(dom.secondary, dom.primary);

    card.append(head, body, foot);
    card.append(buildWheel());
    overlay.append(card);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay && state.view !== "progress") {
        close();
      }
    });
    document.addEventListener("keydown", onKeyDown, true);
    mount().append(overlay);
    setView("form");
  }

  let primaryAction = () => {};
  let secondaryAction = () => {};

  async function submit() {
    const error = validateName(state.name);
    if (error) {
      dom.formError.textContent = error;
      dom.formError.hidden = false;
      dom.name.focus?.();
      return;
    }
    dom.formError.hidden = true;
    closeWheel();

    const config = value();
    state.frames = 0;
    state.videoMs = 0;
    state.done = false;
    state.cancelled = false;
    state.startedAt = Date.now();
    setView("progress");
    dom.phase.textContent = "正在准备…";
    paintProgress();

    let result = null;
    try {
      result = await onStart(config);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    finish(result ?? {});
  }

  /** 导出结束（成功、取消或失败）后落到结果界面。 */
  function finish(result = {}) {
    if (closed) {
      return;
    }
    state.done = true;
    // A file that actually landed wins over a late cancel click: once the
    // final write has started it cannot be aborted, so reporting "没有留下文件"
    // would be a lie and invite a redundant re-export.
    if (!result.path && (result.cancelled || state.cancelled)) {
      state.view = "progress";
      paintProgress();
      dom.phase.textContent = "已取消导出，没有留下文件";
      dom.secondary.hidden = true;
      dom.primary.hidden = false;
      dom.primary.textContent = "关闭";
      primaryAction = () => close();
      return;
    }

    setView("result");
    if (result.error) {
      state.resultPath = "";
      dom.title.textContent = "导出失败";
      dom.resultTitle.textContent = "导出没有完成";
      dom.resultPath.textContent = String(result.error);
      dom.resultPath.classList.add("is-error");
      dom.resultStats.replaceChildren();
      dom.resultActions.hidden = true;
      return;
    }
    dom.title.textContent = "导出完成";
    dom.resultTitle.textContent = "文件已写入项目";
    dom.resultPath.classList.remove("is-error");
    dom.resultPath.textContent = String(result.path ?? "");
    state.resultPath = String(result.path ?? "");
    dom.resultActions.hidden = false;
    dom.reveal.hidden = !onReveal || !state.resultPath;
    const timing = result.metrics ?? null;
    const stats = [
      `共 ${Number(result.frames) || 0} 帧`,
      `用时 ${formatDuration(Number(result.elapsedMs) || 0)}`,
      result.bytes ? `${(Number(result.bytes) / 1024 / 1024).toFixed(1)} MB` : "",
      timing && timing.avgFrameMs > 0 ? `每帧 ${timing.avgFrameMs.toFixed(1)} ms` : "",
    ].filter(Boolean);
    const statNodes = stats.map((text) => element("span", "export-panel__stat", text));
    if (timing && statNodes.length > 0) {
      // 分项明细放在 title 里：结果页保持一行，需要排查慢点时悬停即可。
      const stages = timing.stages ?? {};
      const ms = (stage) => Number(stages[stage]?.ms ?? 0).toFixed(0);
      const calls = (stage) => Number(stages[stage]?.calls ?? 0);
      statNodes[statNodes.length - 1].title = [
        `渲染 ${ms("render")} ms`,
        `取帧 ${ms("seek")} ms（${calls("seek")} 次）`,
        `调色 ${ms("tint")} ms（${calls("tint")} 次）`,
        `编码 ${ms("encode")} ms`,
        `写盘 ${ms("append")} ms`,
        `复用 ${Number(timing.counters?.reuse ?? 0)} 帧`,
      ].join(" · ");
    }
    dom.resultStats.replaceChildren(...statNodes);
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    if (wheelOpen) {
      closeWheel();
      return;
    }
    if (state.view === "progress") {
      requestCancel();
      return;
    }
    close();
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    destroy();
    onClose();
  }

  function open(view = {}) {
    if (!closed) {
      dom?.name?.focus?.();
      return;
    }
    closed = false;
    state.entry = pickEntry(view.entry);
    state.name = sanitizeName(view.name) || defaultName?.(state.entry) || "export";
    state.nameEdited = false;
    state.resultPath = "";
    state.fps = FPS_CHOICES.includes(Number(view.fps)) ? Number(view.fps) : defaults.fps;
    state.estimateState = "loading";
    state.estimatedMs = 0;
    state.estimateError = null;
    state.frames = 0;
    state.videoMs = 0;
    state.done = false;
    state.cancelled = false;
    build();
    paintForm();
    void runEstimate();
    dom.name.focus?.();
    dom.name.select?.();
  }

  async function runEstimate() {
    const token = (estimateToken += 1);
    let result = null;
    try {
      // 时长取决于入口脚本、帧率与选择支策略，所以把当前参数一并交出去。
      result = await estimate?.(value());
    } catch (error) {
      result = { ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
    if (token !== estimateToken || closed) {
      return;
    }
    const ms = typeof result === "number" ? result : Number(result?.ms);
    state.estimatedMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    state.estimateError =
      typeof result === "object" && result?.error ? String(result.error) : null;
    state.estimateState = state.estimatedMs > 0 ? "ready" : "failed";
    paintForm();
  }

  return {
    get element() {
      return overlay;
    },
    open,
    close,
    isOpen: () => !closed,
    value,
    /** 进度：已渲染帧数与此刻的视频时刻（毫秒）。 */
    setProgress({ frames = 0, t = 0 } = {}) {
      if (state.view !== "progress") {
        return;
      }
      state.frames = Math.max(0, Math.floor(Number(frames) || 0));
      state.videoMs = Math.max(0, Number(t) || 0);
      // 帧循环比实时快得多：重画限到 ~12Hz，读数照样在动。
      const now = Date.now();
      if (now - lastPaint < 80) {
        return;
      }
      lastPaint = now;
      paintProgress();
    },
    /** 阶段文案：读脚本、预解码资源、渲染。 */
    setPhase(text) {
      if (dom.phase && state.view === "progress") {
        dom.phase.textContent = String(text ?? "");
      }
    },
    /** 导出结束后落到结果界面；`{ cancelled }` / `{ error }` / `{ path, frames, bytes, elapsedMs }`。 */
    finish,
  };
}
