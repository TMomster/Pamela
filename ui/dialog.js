// 对白框：名牌与当前台词。
// Pamela — the dialogue box: the name plate and the line being spoken.
// 未绑定配音或无法取得时长时返回 0。

import { draw, hasPlate, plateLayers } from "./dialog-plate.js";

/** The stage's logical size. Kept in step with `stage.js`. */

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

/** What a line looks like before a style file says otherwise. */
export const DEFAULT_STYLE = {
  version: 1,
  canvas: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
  stamp: { path: "" },
  // A style with no layers falls back to a stamped PNG, or to the stand-in bar.
  layers: [],
  speaker: {
    x: 180,
    y: 786,
    width: 520,
    height: 64,
    font: { family: "微软雅黑", size: 40, weight: 700, italic: false, color: "#ffd479" },
    align: "left",
    valign: "middle",
  },
  text: {
    x: 180,
    y: 862,
    width: 1560,
    height: 170,
    font: { family: "微软雅黑", size: 32, weight: 400, italic: false, color: "#f2f2f2" },
    lineHeight: 1.4,
    align: "left",
    valign: "top",
    overflow: "shrink",
    // Milliseconds per character as the line is revealed. Zero is off, which is
    // what every project written before this field existed reads as: a line is
    // simply there. An author turns it on by naming a speed, in the style file
    // or the designer.
    typeSpeed: 0,
  },
};

/**
 * The two styles one template file carries.
 *
 * `dialog` is what a named character's line is drawn in; `narration` is what a
 * line with no name is drawn in. Which one a line uses is decided by the name
 * alone (`slotFor`), never by the script.
 */
export const STYLE_SLOTS = ["dialog", "narration"];

/** Fonts are never shrunk below this, whatever the overflow. */
const MIN_FONT_SIZE = 14;

/** Horizontal placement from an `align` name, for a flex row. */
const HORIZONTAL = { left: "flex-start", center: "center", right: "flex-end" };

/** Vertical placement from a `valign` name, for a flex column. */
const VERTICAL = { top: "flex-start", middle: "center", bottom: "flex-end" };

/** How long a fully revealed line waits in skip (fast-forward) mode, in ms. */
const SKIP_DELAY = 0;

/** 项目级打字机档位 → 每字毫秒。0 = 不逐字（整行直接出现）。 */
const TYPEWRITER_MS = { off: 0, fast: 20, medium: 40, slow: 70 };

/**
 * 把项目档位名或直接给定的数值解析为每字毫秒；未知或缺失时按 `off`（0）处理。
 */
const typewriterSpeed = (mode) =>
  Number.isFinite(Number(mode)) && Number(mode) > 0
    ? Number(mode)
    : TYPEWRITER_MS[String(mode)] ?? 0;

/** Most lines the backlog keeps; the oldest drop off once this is passed. */
const HISTORY_LIMIT = 100;

/**
 * The slot a line belongs to.
 *
 * A line with no name is the narrator's, which is what a bare `say` and a
 * `dialog.say` with the name left out both are. Everything else is a character
 * speaking, and gets the name plate.
 *
 * @param {string | null | undefined} name
 * @returns {"dialog" | "narration"}
 */
export function slotFor(name) {
  return name === null || name === undefined ? "narration" : "dialog";
}

/**
 * Deep-merges a style file over the defaults, so a file may name only what it
 * changes and a missing file is the defaults entire.
 */
function mergeStyle(base, patch) {
  const over = patch && typeof patch === "object" ? patch : {};
  return {
    ...base,
    ...over,
    canvas: { ...base.canvas, ...over.canvas },
    stamp: { ...base.stamp, ...over.stamp },
    // Layers are the plate itself now. A file that names none is an older one
    // and keeps whatever plate its stamp points at.
    layers: Array.isArray(over.layers) ? over.layers : base.layers ?? [],
    speaker: {
      ...base.speaker,
      ...over.speaker,
      font: { ...base.speaker.font, ...over.speaker?.font },
    },
    text: {
      ...base.text,
      ...over.text,
      font: { ...base.text.font, ...over.text?.font },
    },
  };
}

/**
 * Merges a template file over the defaults, for both slots.
 *
 * A file that names `styles` is the current shape and each slot is merged out
 * of it; a file that does not is an older one and its whole self is used for
 * both slots. Either way a missing slot falls back to the defaults, so a file
 * may design one box and leave the other alone.
 *
 * @param {object} base
 * @param {object} [config] The parsed template file.
 * @returns {{ dialog: object, narration: object }}
 */
export function mergeStyles(base, config) {
  const source = config && typeof config === "object" ? config : {};
  const named = source.styles && typeof source.styles === "object" ? source.styles : null;
  const pick = (slot) => (named ? named[slot] ?? {} : source);
  return {
    dialog: mergeStyle(base, pick("dialog")),
    narration: mergeStyle(base, pick("narration")),
  };
}

/**
 * Builds the dialogue layer.
 *
 * @param {object} options
 * @param {HTMLElement} options.element The `#stage-view` container, which is
 *   where a click is heard: the whole frame advances a line, not just the box.
 * @param {HTMLElement} options.node The dialogue layer element to fill.
 * @param {(path: string) => Promise<string>} options.resolveAsset
 * @param {(message: string) => void} [options.onError]
 * @returns {{ node: HTMLElement, line: (name: string | null, text: string) => Promise<void>,
 *   clickWait: (time: number) => Promise<void>,
 *   sample: (name: string | null, text: string) => void, setStyle: (config?: object) => void,
 *   setVisible: (visible: boolean) => void, clear: () => void, settle: () => boolean,
 *   isWaiting: () => boolean }}
 */
export function createDialogue({
  element,
  node,
  resolveAsset,
  isReplaying = () => false,
  onError = () => {},
  // Called with each line as it is shown (not while replaying a save), so the
  // host can feed the backlog viewer without the box knowing about it.
  onLine = () => {},
  // A preview travels to a moment rather than performing: the line is drawn but
  // nothing waits for the click that would release it.
  isPreviewing = () => false,
  // 项目默认打字机档位：`off` / `fast` / `medium` / `slow`。样式文件显式写了
  // `text.typeSpeed` 时以样式为准，否则用这里给的默认每字速度。
  typewriter = "off",
  // 绑定配音：按给定文件名播放音频并返回其时长（毫秒）。
  // 语句计时以该时长为准；未绑定配音或无法取得时长时返回 0。
  onVoice = () => 0,
  // 中断由 `onVoice` 播放的配音轨，用于切句 / 手动推进时打断语音。
  onVoiceStop = () => {},
  // 自动配音开关：开启时，没有显式 `audio` 的 say 会自动配一段合成效果音。
  getAutoVoice = () => false,
  // 合成自动配音效果音：返回 { duration, stop }。仅当 getAutoVoice() 为真时调用。
  synthVoice = () => ({ duration: 0, stop() {} }),
  // The designer draws the plate on its own canvas and only borrows this box
  // for the text. Its preview must not add the stand-in bar over that plate.
  suppressFallback = false,
}) {
  if (!node) {
    throw new Error("createDialogue 需要一个图层元素");
  }

  // The baked PNG is kept for styles written before the runtime drew layers.
  const stamp = document.createElement("img");
  stamp.className = "dialogue__stamp";
  stamp.alt = "";
  stamp.draggable = false;
  stamp.hidden = true;

  // The live plate: the style file's layers are painted straight onto this
  // canvas. It sits after the two text blocks in the DOM — so the box's long
  // standing child order stays put — and CSS layers it behind them.
  const plateCanvas = document.createElement("canvas");
  plateCanvas.className = "dialogue__plate";
  plateCanvas.hidden = true;

  // The fallback plate: a plain bar behind the line, drawn only when the style
  // names no plate of its own. It is the difference between "the box is a
  // picture the author baked" and "a line of text floats over the scene with
  // nothing behind it" — and a narration box, which the designer stamps to a
  // plate of its own, used to have no plate at all by default, so a bare `say`
  // was unreadable over a bright picture. It sits under the baked plate and is
  // hidden the moment one is loaded, so a style that does name a plate never
  // shows both.
  const fallback = document.createElement("div");
  fallback.className = "dialogue__fallback";
  fallback.hidden = true;

  const speaker = document.createElement("div");
  speaker.className = "dialogue__speaker";
  speaker.hidden = true;

  const text = document.createElement("div");
  text.className = "dialogue__text";

  node.replaceChildren(fallback, stamp, speaker, text, plateCanvas);

  // Both slots are always ready; `slot` is which one the line on screen is
  // drawn in, and it follows the name of the line rather than the script.
  let styles = mergeStyles(DEFAULT_STYLE, null);
  let slot = "dialog";
  // 项目级默认每字速度（由 `typewriter` 档位换算），样式 `text.typeSpeed` 为 0
  // 时回落到这里，否则样式优先。
  let projectSpeed = typewriterSpeed(typewriter);
  // The line awaiting a click, held as its resolver rather than its promise, so
  // `settle` can end it from outside when the run that asked for it is dropped.
  let waiting = null;
  // 当前句正在显示/等待的文本与 say 的 time/audio 选项，供自动播放计时读取。
  let pendingLine = "";
  let currentOpts = { time: 0, audio: null };
  // 当前句正在播放的配音中断句柄（显式 `audio` 或自动配音效果音）；
  // 切句 / 手动推进 / 清场时调用，确保语音不会残留在下一句。
  let activeVoiceStop = null;
  // 本句配音时长（毫秒）：显式 audio 以音频轨时长为准，自动配音以效果音时长为准，
  // 无配音为 0。由 `startVoice` 在对话一开始就填好，供自动模式计切换时长用。
  let voiceDuration = 0;
  // `line` 一开始就把配音（显式 audio 或自动配音效果音）启动了，这个 promise
  // 用来在 `onLineReady` 里等时长算完；配音本身在说台词的同时就在放。
  let voiceStarted = Promise.resolve();
  const stopActiveVoice = () => {
    if (activeVoiceStop) {
      try {
        activeVoiceStop();
      } catch {
        /* 中断过程中的异常忽略 */
      }
      activeVoiceStop = null;
    }
  };
  // 本句自动播放切换语句总时长（毫秒），由 onLineReady 算出。
  let currentDelay = 0;
  // 圆环倒计时的 rAF 句柄，便于切换语句/手动推进时取消。
  let countdownRAF = null;

  // Auto and skip are player-side conveniences the stage owns, not the script: a
  // line that has been fully revealed either waits (default), advances on its own
  // after `autoDelay` (auto), or advances at once (skip). The pending advance is
  // a single timer, cancelled the moment a click or key settles the line by hand.
  let auto = false;
  let skip = false;
  // 自动播放手动覆盖时长（毫秒）。0 = 不覆盖，用按字数算出的本句时长。
  let autoDelay = 0;
  let advanceTimer = null;
  // The lines shown this run, oldest first, for the backlog viewer. Capped so a
  // long script cannot grow it without bound; the cap drops the oldest.
  const history = [];
  // Which plate is on the layer, so switching slots does not reload a bitmap
  // that is already there — and so a `clear` can put it back.
  let plate = null;
  let plateTicket = 0;

  // The live plate's decoded bitmaps, by project-relative path. Loads are
  // remembered so a line switching slots does not fetch the same picture twice,
  // and failures are remembered so a bad path does not retry on every line.
  const plateImages = new Map();
  const plateLoading = new Set();
  const plateBroken = new Set();
  // `clear` takes the plate off a run that has ended; the next line puts it back.
  let plateCleared = false;

  /** The shape the shared painter reads: a canvas plus both style slots. */
  const plateDocument = () => ({
    canvas: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    active: slot,
    styles,
  });

  /** Fetches the bitmaps the current slot's image layers name. */
  const loadPlateImages = () => {
    for (const layer of plateLayers(plateDocument(), slot)) {
      const source = layer.source;
      if (
        layer.type !== "image" || !source ||
        plateImages.has(source) || plateLoading.has(source) || plateBroken.has(source)
      ) {
        continue;
      }
      plateLoading.add(source);
      Promise.resolve()
        .then(() => resolveAsset(source))
        .then((url) => {
          // A test stand-in has no Image constructor. The plate is decoration
          // there, so a missing bitmap must never break a run.
          if (typeof Image !== "function") {
            plateLoading.delete(source);
            return;
          }
          const bitmap = new Image();
          bitmap.onload = () => {
            plateLoading.delete(source);
            plateImages.set(source, bitmap);
            drawPlate();
          };
          bitmap.onerror = () => {
            plateLoading.delete(source);
            plateBroken.add(source);
            onError(`无法加载图片：${source}`);
          };
          bitmap.src = url;
        })
        .catch((error) => {
          plateLoading.delete(source);
          plateBroken.add(source);
          onError(error instanceof Error ? error.message : String(error));
        });
    }
  };

  /** Paints the current slot's layers onto the plate canvas. */
  const drawPlate = () => {
    // The node tests build elements with `createElement` alone, so a canvas
    // without a 2d context simply draws nothing.
    const ctx = typeof plateCanvas.getContext === "function"
      ? plateCanvas.getContext("2d")
      : null;
    if (!ctx) {
      return;
    }
    if (plateCanvas.width !== STAGE_WIDTH) {
      plateCanvas.width = STAGE_WIDTH;
    }
    if (plateCanvas.height !== STAGE_HEIGHT) {
      plateCanvas.height = STAGE_HEIGHT;
    }
    ctx.imageSmoothingEnabled = true;
    draw(ctx, plateDocument(), plateImages, slot);
    loadPlateImages();
  };

  /** The style the line on screen is drawn in. */
  const current = () => styles[slot] ?? styles.dialog;

  const percentage = (value, total) => `${(value / total) * 100}%`;
  // Font sizes are in the same logical units as the boxes, so they are scaled
  // by the layer's width: a line keeps its proportions however large the window
  // is. The scale starts at 1 and is corrected as soon as there is a width to
  // measure — which is when the stage is shown, not when it is built.
  let scale = 1;
  const fontSize = (value) => `${value * scale}px`;

  const applyBox = (target, box) => {
    target.style.left = percentage(box.x, STAGE_WIDTH);
    target.style.top = percentage(box.y, STAGE_HEIGHT);
    target.style.width = percentage(box.width, STAGE_WIDTH);
    target.style.height = percentage(box.height, STAGE_HEIGHT);
  };

  const applyFont = (target, font) => {
    target.style.fontFamily = `"${font.family}", sans-serif`;
    target.style.fontSize = fontSize(font.size);
    target.style.fontWeight = String(font.weight);
    target.style.fontStyle = font.italic ? "italic" : "normal";
    target.style.color = font.color;
  };

  /** Fills the stamp's element, once the current style names a plate. */
  const loadStamp = () => {
    const path = current().stamp?.path ?? "";
    if (path === plate) {
      return;
    }
    plate = path;
    const ticket = (plateTicket += 1);
    if (!path) {
      stamp.hidden = true;
      stamp.removeAttribute("src");
      // No plate: the fallback bar is what keeps the line readable over a
      // bright picture. It is laid out by `applyStyle`, which knows the boxes.
      return;
    }
    Promise.resolve()
      .then(() => resolveAsset(path))
      .then((url) => {
        // A slower plate than the one now asked for is dropped, so switching
        // slots twice in a row leaves the second plate up.
        if (ticket !== plateTicket) {
          return;
        }
        stamp.src = url;
        stamp.hidden = false;
        // A real plate is what the style asked for; the stand-in goes.
        fallback.hidden = true;
      })
      .catch((error) => {
        if (ticket !== plateTicket) {
          return;
        }
        stamp.hidden = true;
        // A plate that will not load leaves the line over the scene, which is
        // the same state a style naming none is in: the fallback bar is what
        // keeps it readable, and the error says why the plate is missing.
        showFallback(true);
        onError(error instanceof Error ? error.message : String(error));
      });
  };

  /**
   * Shows the fallback bar behind the current style's text.
   *
   * The bar covers the line's own box — and the name plate's when the style has
   * one — rather than the whole frame: a `say` over a wide picture should read
   * as a box, not as a darkened screen. It is hidden the moment a style names a
   * plate, so a box the author designed never shows both.
   *
   * @param {boolean} [forced] Show it even when the style names a plate, for a
   *   plate that failed to load: the line is still on the stage and still needs
   *   something behind it.
   */
  const showFallback = (forced = false) => {
    if (suppressFallback) {
      fallback.hidden = true;
      return;
    }
    if (!forced && String(current().stamp?.path ?? "").trim()) {
      fallback.hidden = true;
      return;
    }
    const style = current();
    const line = style.text;
    const boxes = [line];
    // A narrator's line has no name plate, and its box would otherwise push the
    // bar up over the picture for nothing.
    if (slot === "dialog") {
      boxes.push(style.speaker);
    }
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    fallback.style.left = percentage(left, STAGE_WIDTH);
    fallback.style.top = percentage(top, STAGE_HEIGHT);
    fallback.style.width = percentage(right - left, STAGE_WIDTH);
    fallback.style.height = percentage(bottom - top, STAGE_HEIGHT);
    fallback.hidden = false;
  };

  /**
   * Shows the plate the current slot asks for.
   *
   * Layers are the source of truth: as soon as a style names a visible layer the
   * runtime paints it itself, so an edit to a template reaches the stage without
   * any baking step. A style written before layers were rendered still names a
   * PNG, and a style naming neither gets the stand-in bar.
   */
  const showPlate = () => {
    if (hasPlate(plateDocument(), slot)) {
      stamp.hidden = true;
      stamp.removeAttribute("src");
      // A later `loadStamp` must not mistake a stale path for a loaded plate.
      plate = null;
      fallback.hidden = true;
      plateCanvas.hidden = false;
      plateCleared = false;
      drawPlate();
      return;
    }
    plateCanvas.hidden = true;
    plateCleared = false;
    loadStamp();
    showFallback();
  };

  const applyStyle = () => {
    const style = current();
    applyBox(speaker, style.speaker);
    applyFont(speaker, style.speaker.font);
    speaker.style.justifyContent = HORIZONTAL[style.speaker.align] ?? HORIZONTAL.left;
    speaker.style.textAlign = style.speaker.align;

    applyBox(text, style.text);
    applyFont(text, style.text.font);
    text.style.lineHeight = String(style.text.lineHeight);
    text.style.textAlign = style.text.align;
    text.style.justifyContent = VERTICAL[style.text.valign] ?? VERTICAL.top;

    showPlate();
  };

  /** Shrinks the line until it fits, when the style asks for it. */
  const fitText = () => {
    const style = current();
    let size = style.text.font.size;
    text.style.fontSize = fontSize(size);
    if (style.text.overflow !== "shrink") {
      return;
    }
    for (let guard = 0; guard < 40; guard += 1) {
      const overflows =
        text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1;
      if (!overflows || size <= MIN_FONT_SIZE) {
        return;
      }
      size *= 0.94;
      text.style.fontSize = fontSize(size);
    }
  };

  /**
   * Draws a line into the box, all at once.
   *
   * The name and the text are written whole; the reveal is `reveal`'s job, and
   * keeping the two apart is what lets a click finish a line without a second
   * layout path.
   */
  const render = (name, line) => {
    // The name decides the box, not the other way round: a line with none is
    // the narrator's, drawn in the narration style with the plate hidden.
    const next = slotFor(name);
    if (next !== slot) {
      slot = next;
      applyStyle();
    } else if (plateCleared) {
      // `clear` hid the plate when the last run ended. The first line of the
      // next one puts it back, without repainting it on every line.
      showPlate();
    }
    plateCleared = false;
    // A narrator has no name to show, so the plate is hidden rather than shown
    // empty — that is what tells a `say` from a character's own line. The
    // narration style has no plate of its own either, so it is hidden twice
    // over, which costs nothing.
    speaker.hidden = name === null || name === undefined;
    speaker.textContent = speaker.hidden ? "" : name;
    text.textContent = line;
    fitText();
  };

  /** The reveal in progress, if the style asked for one. */
  let typing = null;

  /**
   * Stops a reveal where it is, leaving the whole line on screen.
   *
   * Called by a click (the first one finishes the line, the second advances) and
   * by `clear`. It answers whether there was anything to stop, which is how a
   * click knows whether it is finishing a line or letting one go.
   *
   * @returns {boolean}
   */
  const finishTyping = () => {
    if (!typing) {
      return false;
    }
    const { timer, full, done } = typing;
    typing = null;
    clearTimeout(timer);
    text.textContent = full;
    fitText();
    done?.();
    return true;
  };

  /**
   * Writes a line out a character at a time, when the style names a speed.
   *
   * `fitText` runs once on the whole line before the reveal starts, not per
   * character: the shrink-to-fit answer is about the finished line, and
   * recomputing it as the text grows would make the font size jump on the way
   * in. The line is therefore laid out at its final size and revealed into it.
   *
   * A speed of zero — or no speed at all, which is what a style file written
   * before this field existed answers — shows the line at once, exactly as it
   * always did.
   */
  const reveal = (line, speedOverride) => {
    // 样式文件里的 `text.typeSpeed` 优先；为 0（未设）时回落到项目默认档位。
    // `speedOverride` 用于 say 的 time 参数：强制在指定时间内显示完。
    const speed =
      speedOverride != null
        ? speedOverride
        : Number(current().text.typeSpeed) || projectSpeed;
    if (speed <= 0 || typeof setTimeout !== "function") {
      text.textContent = line;
      fitText();
      return Promise.resolve();
    }

    const characters = [...line];
    text.textContent = line;
    fitText();
    // The box is measured on the finished line; the reveal then starts from an
    // empty one at the same font size.
    const size = text.style.fontSize;
    text.textContent = "";
    text.style.fontSize = size;

    return new Promise((resolve) => {
      let shown = 0;
      const step = () => {
        shown += 1;
        text.textContent = characters.slice(0, shown).join("");
        if (shown >= characters.length) {
          typing = null;
          resolve();
          return;
        }
        typing.timer = setTimeout(step, speed);
      };
      typing = {
        full: line,
        done: () => resolve(),
        timer: setTimeout(step, speed),
      };
    });
  };

  /** Remembers a performed line for the backlog viewer. */
  const pushHistory = (name, value) => {
    history.push({ name: name ?? null, text: String(value ?? "") });
    if (history.length > HISTORY_LIMIT) {
      history.splice(0, history.length - HISTORY_LIMIT);
    }
  };

  /**
   * Advances the line the player is waiting on, after `delay` ms.
   *
   * A single timer is kept: a manual settle clears it, so a click and an
   * auto-advance cannot both fire — whichever comes first wins, and the other is
   * a no-op because `settle` only acts while a line is still up.
   */
  const scheduleAdvance = (delay) => {
    if (advanceTimer != null) {
      return;
    }
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      settle();
    }, delay);
  };

  /**
   * Acts on a line once it is fully revealed.
   *
   * Auto waits `autoDelay` then advances; skip advances at once. Either way the
   * player can still settle by hand first, which cancels the timer. When neither
   * is on, the line simply waits — the default the dialogue box has always had.
   */
  // 样式/项目默认下的每字速度。
  const effectiveSpeed = () => Number(current().text.typeSpeed) || projectSpeed;

  // 把 `say` 的 `time` / `audio` 选项从未包装的位置参数规整为 `{ time, audio }`。
  const normalizeOpts = (opts) => {
    const o = opts && typeof opts === "object" ? opts : {};
    const time = Number(o.time) || 0;
    const audio = typeof o.audio === "string" && o.audio ? o.audio : null;
    return { time, audio };
  };

  // 取配音时长（毫秒）。
  const resolveVoice = (name) =>
    Promise.resolve()
      .then(() => onVoice(name))
      .then((ms) => Number(ms) || 0)
      .catch(() => 0);

  // 触发本句配音：显式 `audio` 直接播放，否则看 `autoVoice` 是否开启，
  // 开启则配一段合成效果音。不论 auto / 手动，对话一开始显示就调用，
  // 确保手动阅读模式也会发声（之前只在自动模式触发）。
  const startVoice = async () => {
    const chars = [...pendingLine].length;
    if (currentOpts.audio) {
      // 先登记中断句柄再等时长，手动推进能立刻打断正在播放的配音。
      activeVoiceStop = () => onVoiceStop(currentOpts.audio);
      voiceDuration = await resolveVoice(currentOpts.audio);
    } else if (getAutoVoice()) {
      // 自动配音：没有显式 audio 时配一段合成效果音，次数按字数决定。
      const effect = synthVoice(chars);
      voiceDuration = effect.duration || 0;
      activeVoiceStop = effect.stop || null;
    } else {
      activeVoiceStop = null;
      voiceDuration = 0;
    }
  };

  // 本句自动播放切换语句总时长（毫秒）。结合 say 的 time/audio 与项目打字档位。
  // `voiceDuration` 已由 `startVoice` 在对话开始时填好（显式 audio 或自动配音）。
  const computeDelay = async () => {
    const chars = [...pendingLine].length;
    const speed = effectiveSpeed();
    const revealTime =
      currentOpts.time > 0
        ? chars > 0
          ? currentOpts.time / chars
          : 0
        : speed > 0
          ? speed * chars
          : 0;
    if (voiceDuration > 0) {
      if (currentOpts.time > 0) {
        // 文本须在 time 内显示完；切换语句在配音播放完毕后 +0.5s。
        return Math.max(0, Math.max(currentOpts.time, voiceDuration) + 500 - revealTime);
      }
      // 仅绑定配音（显式或自动）：以配音结束时间为准，打字速度不受影响。
      return Math.max(0, voiceDuration - revealTime);
    }
    if (currentOpts.time > 0) {
      // 仅指定 `time` 时，文本必须在该时长内显示完毕并随即切换语句，显示过程已计入 `time`。
      return 0;
    }
    // 默认：打字机模式 = 显示完 +0.5s；非逐字 = 每 3 字一组、每组 0.8s。
    if (speed > 0) {
      return speed * chars + 500;
    }
    const groups = Math.ceil(chars / 3);
    return groups * 800;
  };

  // 实际用于排程的时长：手动 override（autoDelay>0）优先。
  const effectiveDelay = async () =>
    autoDelay > 0 ? autoDelay : computeDelay();

  const onLineReady = async () => {
    if (!waiting) {
      return;
    }
    if (skip) {
      finishTyping();
      scheduleAdvance(SKIP_DELAY);
      return;
    }
    // 配音已在 `line` 一开始启动（`voiceStarted`），这里只等时长算完，
    // 供自动模式计算切句时机；手动模式不自动切句，只等玩家自己推进。
    await voiceStarted;
    if (!auto) {
      return;
    }
    const delay = await effectiveDelay();
    currentDelay = delay;
    scheduleAdvance(delay);
    startCountdown(delay);
  };

  // 自动播放右下角圆环倒计时（在对话框上层，仅 auto 模式显示）。
  let ring = null;
  let ringFg = null;
  let ringC = 0;
  // 点击位置提示（`stage.click` 画的标记），等待期间显示。
  let clickMark = null;

  // The ring is decoration, so it borrows whichever frame clock exists and
  // simply does not animate without one: `requestAnimationFrame` is a browser
  // global, and a headless run has no frames to draw into anyway.
  const raf =
    typeof requestAnimationFrame === "function"
      ? (step) => requestAnimationFrame(step)
      : null;
  const cancelRaf =
    typeof cancelAnimationFrame === "function"
      ? (id) => cancelAnimationFrame(id)
      : () => {};

  const startCountdown = (delay) => {
    if (!ring || delay <= 0) {
      hideCountdown();
      return;
    }
    ring.hidden = false;
    if (!raf) {
      // No frame clock: the ring stays a still full circle, which is what a
      // countdown that cannot tick should look like. The advance timer is
      // unaffected — it is a `setTimeout`, and it is what actually cuts the line.
      return;
    }
    const start =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const step = (now) => {
      const t = now ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
      const elapsed = t - start;
      const remain = Math.max(0, delay - elapsed);
      const frac = remain / delay;
      if (ringFg) ringFg.style.strokeDashoffset = String(ringC * (1 - frac));
      if (remain > 0 && waiting && auto) {
        countdownRAF = raf(step);
      } else {
        countdownRAF = null;
        if (remain <= 0) hideCountdown();
      }
    };
    if (countdownRAF != null) cancelRaf(countdownRAF);
    countdownRAF = raf(step);
  };

  const hideCountdown = () => {
    if (countdownRAF != null) {
      cancelRaf(countdownRAF);
      countdownRAF = null;
    }
    if (ring) ring.hidden = true;
  };

  /** 显示 `stage.click` 的点击位置标记。 */
  const showClickMark = () => {
    if (clickMark) clickMark.hidden = false;
  };

  /** 收起点击位置标记。 */
  const hideClickMark = () => {
    if (clickMark) clickMark.hidden = true;
  };

  const settle = () => {
    // A manual settle cancels any pending auto/skip advance: the player's click is
    // the action, so a second one a moment later must not also fire.
    if (advanceTimer != null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    hideCountdown();
    if (!waiting) {
      return false;
    }
    // A click while the line is still being written finishes the writing rather
    // than advancing: the player asked to see the line, not to skip it. The
    // next click ends the wait.
    if (finishTyping()) {
      return true;
    }
    const resolve = waiting;
    waiting = null;
    hideClickMark();
    // 落终态即离开本句：正在播放的配音（显式或自动）一并中断，不残留到下一句。
    stopActiveVoice();
    resolve();
    return true;
  };

  // One listener for the whole run of the stage: a click only does something
  // while a line is up, so there is nothing to add and remove per line.
  element?.addEventListener("click", () => settle());

  /**
   * Shows one line and answers a promise that a click resolves.
   *
   * The promise is handed to the interpreter, which waits on it, so a script
   * never runs past a line on its own. Asking for a second line while one is
   * still up is a `cue` block trying to speak twice at once, which is refused
   * rather than resolved to one of them: neither reading of it is what a writer
   * meant. Thrown synchronously, so the interpreter reports it in the status
   * bar like any other script error.
   */
  const line = (name, value, opts) => {
    // A replay seeks a saved node: the lines before it are travelled past,
    // not read, so nothing is drawn and nothing waits — and neither auto nor
    // skip applies, because there is no line up to advance.
    if (isReplaying()) {
      return Promise.resolve();
    }
    // A preview travels to a moment to be looked at — the frame a key plays on.
    // The line is drawn, because the dialogue box is part of the picture the
    // author is placing a path against; it just does not wait, because the click
    // that would release it is one no click occurs.
    if (isPreviewing()) {
      render(name, value);
      onLine?.(name ?? null, value);
      return Promise.resolve();
    }
    if (waiting) {
      throw new Error("cue 中不能同时显示两句台词，Pamela 不允许并发台词");
    }
    // 进入新一句：先中断上一句可能仍在播放的配音（保险，正常已在落终态时停过）。
    stopActiveVoice();
    pendingLine = value == null ? "" : String(value);
    currentOpts = normalizeOpts(opts);
    render(name, value);
    // Remembered for the backlog, which shows the lines already performed.
    pushHistory(name, value);
    onLine?.(name ?? null, value);
    // 配音（显式 audio 或自动配音效果音）与文字同时开始：在说台词的一开始就启动，
    // 而不是等逐字显示完才放——手动 / 自动模式都如此，和导出成片一致。
    voiceStarted = startVoice();
    // 按 say 的 time 参数强制打字速度，保证在指定时间内显示完。
    const chars = [...pendingLine].length;
    const revealSpeed =
      currentOpts.time > 0 && chars > 0 ? currentOpts.time / chars : undefined;
    // The wait starts before the reveal finishes: a click during the reveal is
    // handled by `settle`, which finishes the writing rather than ending the
    // wait, so the promise is the same one either way.
    const shown = new Promise((resolve) => {
      waiting = resolve;
    });
    // Once the line is fully on screen, auto or skip may advance it; until then
    // the player settles it by hand. In skip mode the reveal is cut short so the
    // line reads at once rather than typing out.
    reveal(value, revealSpeed)
      .then(() => onLineReady())
      .catch(() => {});
    if (skip) {
      finishTyping();
    }
    return shown;
  };

  /**
   * 创建一个点击位置并等待，`stage.click(time)` 的演出端。
   *
   * 没有台词，只画一个点击标记：非自动模式下等玩家手动点击才放行；自动模式
   * 或导出时，`time` 是必须走完的等待时长（未给 time 时回落到 autoDelay）。
   * 与 `line` 一样，它把 promise 交给解释器，让脚本停在这一点上。
   */
  const clickWait = (time) => {
    if (isReplaying() || isPreviewing()) {
      return Promise.resolve();
    }
    if (waiting) {
      throw new Error("上一句还在等待点击，不能同时再设点击位置");
    }
    showClickMark();
    const shown = new Promise((resolve) => {
      waiting = resolve;
    });
    if (skip) {
      scheduleAdvance(SKIP_DELAY);
    } else if (auto) {
      const delay = Number(time) > 0 ? Number(time) : autoDelay;
      scheduleAdvance(delay);
      startCountdown(delay);
    }
    return shown;
  };

  /**
   * Shows a line without waiting for a click.
   *
   * This is `line`'s rendering half alone: the same box, the same font and the
   * same shrink-to-fit, but nothing is being read and so nothing blocks, and a
   * click has nothing to settle. The designer draws a style with it, which is
   * what makes the text an author judges a font by the runtime's own layout
   * rather than a second implementation of it.
   */
  const sample = (name, value) => render(name, value);

  /** Shows or hides the whole layer, content and all. */
  const setVisible = (visible) => {
    node.hidden = !visible;
  };

  const clear = () => {
    settle();
    hideCountdown();
    hideClickMark();
    if (advanceTimer != null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    // A reveal still running would write into a box that has been emptied, so
    // it is dropped rather than finished.
    if (typing) {
      clearTimeout(typing.timer);
      typing = null;
    }
    speaker.hidden = true;
    speaker.textContent = "";
    text.textContent = "";
    text.style.fontSize = fontSize(current().text.font);
    stamp.hidden = true;
    stamp.removeAttribute("src");
    plateCanvas.hidden = true;
    plateCleared = true;
    // The plate is off the layer, so asking for it again has to load it again.
    plate = null;
    // The backlog belongs to the run that filled it; a new run starts empty so
    // the viewer never shows lines the player has not seen this time through.
    history.length = 0;
    // A script that hid the box with `dialog.disable()` hid it for that run
    // only. Clearing is what a new run begins with, so the box comes back with
    // it: leaving it hidden would draw every line of the next script into a
    // layer that is not visible, and the run would still wait for a click on it.
    node.hidden = false;
  };

  /** Redraws the fonts after the layer's width — and so the scale — changed. */
  const rescale = () => {
    const style = current();
    applyFont(speaker, style.speaker.font);
    applyFont(text, style.text.font);
    fitText();
  };

  const setStyle = (config) => {
    styles = mergeStyles(DEFAULT_STYLE, config ?? null);
    // The file may have swapped the plate out from under the line on screen.
    plate = null;
    applyStyle();
    fitText();
  };

  applyStyle();

  // 自动播放右下角圆环倒计时：SVG 圆环，存储于舞台取景框内、对话框上层，
  // 仅 auto 模式且本句在等待时显示，标识切换语句剩余时间。
  //
  // Built through `createSvg`, the same fallback the stage's tint filters use:
  // the node tests stub `document` with `createElement` alone, and the ring is
  // decoration that must never be the reason a stage cannot be built.
  const RING_NS = "http://www.w3.org/2000/svg";
  const createSvg = (name) =>
    typeof document.createElementNS === "function"
      ? document.createElementNS(RING_NS, name)
      : document.createElement(name);
  ring = createSvg("svg");
  ring.setAttribute("class", "dialogue__countdown");
  ring.setAttribute("viewBox", "0 0 40 40");
  ring.hidden = true;
  const ringBg = createSvg("circle");
  ringBg.setAttribute("class", "dialogue__countdown-bg");
  ringBg.setAttribute("cx", "20");
  ringBg.setAttribute("cy", "20");
  ringBg.setAttribute("r", "16");
  ringFg = createSvg("circle");
  ringFg.setAttribute("class", "dialogue__countdown-fg");
  ringFg.setAttribute("cx", "20");
  ringFg.setAttribute("cy", "20");
  ringFg.setAttribute("r", "16");
  ring.append(ringBg, ringFg);
  ringC = 2 * Math.PI * 16;
  ringFg.style.strokeDasharray = String(ringC);
  ringFg.style.strokeDashoffset = String(ringC);
  // `append` rather than `appendChild`: both exist on a real element, only the
  // former exists on the stand-ins the tests build.
  (node.parentNode ?? element)?.append(ring);

  // `stage.click` 的点击位置标记：一个朝下的箭头，等待点击期间显示，位置由
  // CSS 固定在右下角，与倒计时圆环共用一块角落但不会同时出现。
  clickMark = createSvg("svg");
  clickMark.setAttribute("class", "dialogue__click");
  clickMark.setAttribute("viewBox", "0 0 24 24");
  clickMark.hidden = true;
  const clickMarkPath = createSvg("path");
  clickMarkPath.setAttribute("class", "dialogue__click-mark");
  clickMarkPath.setAttribute("d", "M6 9 L12 15 L18 9");
  clickMark.append(clickMarkPath);
  (node.parentNode ?? element)?.append(clickMark);

  // The layer is laid out long before it has a width to measure, so the first
  // useful measurement comes from this rather than from the build above.
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => {
      const width = node.clientWidth;
      if (width > 0 && Math.abs(width / STAGE_WIDTH - scale) > 1e-4) {
        scale = width / STAGE_WIDTH;
        rescale();
      }
    });
    resizeObserver.observe(node);
  }

  return {
    node,
    line,
    clickWait,
    sample,
    clear,
    setStyle,
    setVisible,
    settle,
    /**
     * Releases the observer that keeps the layer scaled to its box.
     *
     * The node itself belongs to the stage and is removed with it; an observer
     * left running would keep the whole dialogue object alive after the run.
     */
    dispose() {
      resizeObserver?.disconnect();
      resizeObserver = null;
    },
    /** Whether a reveal is still writing; a click would finish it. */
    isTyping: () => Boolean(typing),
    isWaiting: () => Boolean(waiting),
    /** Turns auto mode on or off: a revealed line then advances after its delay. */
    setAuto: (on) => {
      auto = Boolean(on);
      if (!auto) {
        hideCountdown();
        return;
      }
      // If a line is already up and fully revealed, arm it now rather than
      // waiting for the next one.
      if (auto && waiting && !typing) {
        effectiveDelay().then((delay) => {
          if (auto && waiting) {
            currentDelay = delay;
            scheduleAdvance(delay);
            startCountdown(delay);
          }
        });
      }
    },
    /** Whether auto mode is on. */
    getAuto: () => auto,
    /** Sets how long auto mode waits after a line is revealed, in ms (0 = 用计算值). */
    setAutoDelay: (ms) => {
      autoDelay = Number(ms) || 0;
    },
    /** Turns skip (fast-forward) on or off: revealed lines advance at once. */
    setSkip: (on) => {
      skip = Boolean(on);
      if (skip) {
        hideCountdown();
      }
      if (skip && waiting) {
        finishTyping();
        if (advanceTimer == null) {
          scheduleAdvance(SKIP_DELAY);
        }
      }
    },
    /** 更新项目默认打字机档位（关/快/中/慢），影响后续语句的回落速度。 */
    setTypewriter: (mode) => {
      projectSpeed = typewriterSpeed(mode);
    },
    /** Whether skip mode is on. */
    getSkip: () => skip,
    /** The lines shown this run, oldest first, each `{ name, text }`. */
    getHistory: () => history.map((entry) => ({ name: entry.name, text: entry.text })),
    /** Drops the backlog without touching the stage. */
    clearHistory: () => {
      history.length = 0;
    },
  };
}
