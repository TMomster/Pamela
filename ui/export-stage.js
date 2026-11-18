// 录制代理：把一次脚本演出的动作登记进导出时间线，而不是画到 DOM 舞台。
// Pamela — a recording stand-in for the stage, driven by the virtual clock.
//
// `createStageGlobals(stage, objects)` 本来就把它用到的东西委托给一个 stage
// 和一个 objects 工厂集合。这里提供二者的录制版本，于是参数表、中文别名、
// 批量调用、`context.pending` 等语言语义全部照旧，不需要改 `stage.js` 一行。
//
// 背景、角色、文字、视频、粒子与对话都落到画面；声音与视频声轨另外交给混音。
// 8 点自由变形与滤镜/调色都写进时间线（数值属性插值），由离屏渲染后端重画。

import { createEffectRecorder } from "./export-effect.js";
import { LOGICAL_SIZE, fitRect, meshBasePoint } from "./export-render.js";
import { addSet, addTween } from "./export-timeline.js";
import { addTint, clampChannel, parseHex, toHex, withLook } from "./filters.js";
import { antialiasAmount } from "./antialias.js";
import { normalizeLight } from "./light.js";
import {
  BUILTIN_ALIASES,
  OBJECT_DESTROY,
  PARAM_SPECS,
  boolArg,
  methodNameOf,
} from "./pamela.js";
import { richTextRuns, stripRichText } from "./rich-text.js";
import { PAMELA_INTRO_MS } from "./pamela-intro.js";
import {
  AUTOVOICE_DEFAULT_SPEED,
  AUTOVOICE_MIN_SPEED,
  AUTOVOICE_MAX_SPEED,
} from "./voice-effect.js";
import {
  BACKGROUND_DEPTH,
  DEFAULT_CAMERA,
  clampDepth,
  normalizeCamera,
} from "./space.js";
import { createStageGlobals, sayTiming } from "./stage.js";
import {
  spriteFrameAt,
  spriteFrameRate,
  spriteIndex,
  spritePath,
} from "./sprite-group.js";
import { TEXT_FONT_WEIGHT, textFontWeight } from "./text-font.js";

export const DEFAULT_RECORDING = Object.freeze({
  minLineMs: 900,
  msPerCharacter: 55,
  linePaddingMs: 600,
  typewriterMs: 420,
  defaultMoveMs: 500,
});

/** 一句台词在「语音 / 文字都完毕」之后额外停顿的毫秒数（见需求：约 800ms）。 */
export const SAY_TAIL_MS = 800;

const TRANSFORM_POINTS = [
  "upleft", "upright", "downleft", "downright",
  "up", "down", "left", "right",
];

/**
 * `flush` 能复原的效果，按不写名字时的顺序排列。
 *
 * 与 `stage.js` 的 `imageFlushers` 是同一套名字与同一套顺序 —— 舞台改的是元素
 * 样式，导出改的是时间线，名字与默认值必须是同一个，成片才与预览一致。
 */
const FLUSH_PLACE = [
  "move", "moveTo", "x", "h", "xTo", "hTo", "y", "v", "yTo", "vTo", "z", "zTo",
  "rotate", "rotateTo", "rotateH", "rotateHTo", "rotateV", "rotateVTo",
  "scale", "scaleTo",
];
/** 四个滤镜回到原样时的值：模糊 0，其余三个 1。 */
const FLUSH_LOOK = { blur: 0, brightness: 1, contrast: 1, saturate: 1 };
/** 调色：三个名字落回同一个「没有偏移」。 */
const FLUSH_TINT = ["rgb", "rgbTo", "hex"];
/** 文字自己的三项。 */
const FLUSH_TEXT = ["color", "font", "weight"];
/** 文字的默认颜色，与舞台的 `DEFAULT_TEXT_COLOR` 相同。 */
const DEFAULT_TEXT_COLOR = "#ffffff";
/** 不写名字时复原的清单，按顺序：每个状态只写一次，别名不重复。 */
const FLUSH_ALL_PLACE = ["move", "rotate", "rotateH", "rotateV", "scale", "alpha"];

/**
 * `v.media` 上与画面同名的方法。
 *
 * 与播放器 `video.js` 的 `mediaMethods` 是同一组名字：画面轨就是这条视频的
 * 画面，导出把调用转给同一层记录。少了这一步，`v.media.moveTo(…)` 在成片里
 * 会悄悄什么都不做，而预览时是有效的。
 */
const VIDEO_MEDIA_PICTURE_METHODS = [
  "show", "hide", "alpha",
  "move", "moveTo", "z", "x", "y", "zTo", "xTo", "yTo",
  "h", "v", "hTo", "vTo",
  "rotate", "rotateTo", "rotateH", "rotateHTo", "rotateV", "rotateVTo",
  "scale", "scaleTo",
  "blur", "brightness", "contrast", "saturate", "rgb", "rgbTo", "hex",
];

function asText(value) {
  return value === null || value === undefined ? "" : String(value);
}

/** `#rgb` / `#rrggbb` → channels, or null for a colour this table cannot parse. */
function rgbOf(color) {
  try {
    return parseHex(asText(color));
  } catch {
    return null;
  }
}

/**
 * 一句台词的停留时长：显式 time 优先，否则按字数给玩家阅读时间。
 *
 * 字数只数看得见的字：`{红}…{/红}` 这类颜色标记不占阅读时间。
 */
export function holdFor(line, timing, config = DEFAULT_RECORDING) {
  const explicit = Number(timing?.time);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const length = [...stripRichText(asText(line))].length;
  return Math.max(
    config.minLineMs,
    length * config.msPerCharacter + config.linePaddingMs,
  );
}

/**
 * `createStageGlobals` 会用到 setVisible / sayLine；choose 由 host 注入。
 *
 * `onVoice` 收到 `say(text, time, 配音变量)` 里的那个变量名：真舞台靠它把台词
 * 卡在配音结束，导出里则让录制器在台词开始处登记一次配音播放。
 */
export function createRecordingStage({
  clock,
  timeline,
  config = DEFAULT_RECORDING,
  onVoice = null,
  onSynth = null,
  onVoiceDuration = null,
}) {
  const settings = { ...DEFAULT_RECORDING, ...config };
  // `stage.autoVoice(...)` 在导出里落在这里：开启后，没有显式配音的台词
  // 由 `onSynth` 登记一段合成效果音（见 `sayLine`）；参数可带播放速度（次/秒）。
  // 随演出（录制器重建）重置。
  let autoVoiceOn = false;
  let autoVoiceSpeed = AUTOVOICE_DEFAULT_SPEED;
  // `stage.autoPause(ms)` 在导出里落在这里：语音/文字较晚者之后要停多久，
  // 默认与真舞台一致（800ms），0 表示说完就切。
  let autoPauseMs = SAY_TAIL_MS;
  // 环境亮度：目标值，以及上一段过渡的起点 / 时刻 / 时长。下一次过渡要从
  // 画面上正在显示的那个值起步，而不是从上一段的目标值（可能还没走到）。
  let ambientValue = 1;
  let ambientFrom = 1;
  let ambientStart = 0;
  let ambientSpan = 0;
  const ambientShown = () => {
    if (!(ambientSpan > 0)) {
      return ambientValue;
    }
    const progress = Math.min(1, Math.max(0, (clock.now() - ambientStart) / ambientSpan));
    return ambientFrom + (ambientValue - ambientFrom) * progress;
  };
  // 对话框上现在是哪一句（原文与已显示字数）：`csay` 要在它后面接着写。
  let shownRaw = "";
  let shownRevealed = 0;
  // 台词与 `stage.click` 共用一条队列。`cue` 里的台词不等待，脚本后文走到
  // 下一句时前一句可能还在停留；播放器的 `dialog.js` 按调用顺序排队，后一句
  // 等到前一句走完才上屏。导出若直接按当前时刻写时间线，两句就会挤在一起：
  // 后一句提前把文字换掉，前一句的配音却还在放。这里排同一条队。
  let lineTail = Promise.resolve();
  let queuedLines = 0;

  /**
   * 把一段要等的时间排到上一句之后：队列空时立即开始，否则等前一段走完再
   * 开始 —— 而且要在真正轮到自己时才读时钟与上一句留下的文字，`csay` 接的
   * 正是「排到它时」框里的内容；`cue` 里同时发出的几句也因此按顺序登场。
   */
  function serializeLine(start) {
    if (queuedLines === 0) {
      queuedLines = 1;
      let started;
      try {
        started = start();
      } catch (error) {
        // 同步失败（时间参数非法之类）不能把队列永久占住。
        queuedLines = 0;
        throw error;
      }
      lineTail = Promise.resolve(started).catch(() => {}).finally(() => {
        queuedLines = Math.max(0, queuedLines - 1);
      });
      return started;
    }
    queuedLines += 1;
    const next = lineTail.then(start, start);
    lineTail = next.catch(() => {}).finally(() => {
      queuedLines = Math.max(0, queuedLines - 1);
    });
    return next;
  }

  /**
   * 一句台词的录制，`say` 与 `csay` 共用。
   *
   * `append` 的差别与真舞台一样只有一处：文字接在上一句后面，`revealed` 从上一
   * 句的字数继续增长，也就只有新接上的一段是「打」出来的。
   */
  function writeLine(name, line, timing, append) {
    const t = clock.now();
    const piece = asText(line);
    const raw = append ? shownRaw + piece : piece;
    // 台词只剩看得见的字进时间线；颜色标记另存成分段，由渲染后端逐段上色。
    const text = stripRichText(raw);
    const runs = richTextRuns(raw);
    const length = [...text].length;
    const from = append ? shownRevealed : 0;
    // 这一句要看多少字：`csay` 只算自己接上的那一段。
    const added = [...stripRichText(piece)].length;
    // 文本「全部显示完毕」所需的时长：与对话框里的逐字速度一致，
    // 显式 time 直接用，否则按字数给阅读时间。
    const textDone = holdFor(piece, timing, settings);
    // 逐字揭示窗口：录制层把整句停留切出一段固定窗口做打字机，
    // 它恒小于整句停留，因此只依赖 textDone，不受配音时长影响。
    const reveal = Math.min(settings.typewriterMs, Math.max(0, textDone - 100));
    addSet(timeline, t, "dialogue", {
      name: asText(name),
      text,
      // 分段每句都写：上一句的颜色不能留在这一句上。全都没有颜色时渲染
      // 后端仍走原来的整行路径，一个字的重排都不会变。
      runs,
      revealed: from,
      visible: true,
    });
    if (length > from && reveal > 0) {
      addTween(timeline, t, t + reveal, "dialogue", "revealed", from, length, {
        quantize: "floor",
      });
    }
    shownRaw = raw;
    shownRevealed = length;
    // 配音必须在 await 之前同步登记：保证配音严格从本句开头播放，与混音里的
    // `at = clock.now()` 对齐；显式 audio 播放，否则看 autoVoice 是否开（合成效果音）。
    let voiceDuration = 0;
    if (timing.audio) {
      onVoice?.(timing.audio);
    } else if (autoVoiceOn) {
      onSynth?.(added, autoVoiceSpeed);
      // 合成效果音的跨度可按字数直接算（与 dialog.js 的 synthVoice 同公式）。
      const count = Math.max(1, Math.ceil(added / 2));
      voiceDuration = count * (1000 / autoVoiceSpeed);
    }
    // 一句的停顿点 = max(文字显示完毕, 语音播放完毕) + autoPause（默认 800ms）。
    // 没有配音时维持原 behaviour：停留就是 textDone 本身。
    const audioHold = (vd) => Math.max(textDone, vd) + autoPauseMs;
    const hold = voiceDuration > 0 ? audioHold(voiceDuration) : textDone;
    // 显式配音的时长要解码文件才能知道，且导出在录制期就得算准停顿点：
    // 异步解析，期间画面照常显示本句，解析完再排定本句的停留。缺文件 / 解不出
    // 直接抛错，由上层中止导出并报错（与「配音缺失即中止」的需求一致）。
    if (timing.audio && onVoiceDuration) {
      return (async () => {
        let vd = 0;
        try {
          vd = Number(await onVoiceDuration(timing.audio)) || 0;
        } catch (error) {
          throw error instanceof Error
            ? error
            : new Error(`配音时长解析失败：${timing.audio}`);
        }
        return clock.wait(vd > 0 ? audioHold(vd) : textDone);
      })();
    }
    return clock.wait(hold);
  }
  return {
    setVisible(visible) {
      addSet(timeline, clock.now(), "dialogue", { visible: Boolean(visible) });
    },
    /** @returns {Promise<void>|undefined} 被 push 进 context.pending 的等待。 */
    sayLine(name, line, timing = {}) {
      return serializeLine(() => writeLine(name, line, timing, false));
    },
    /** `csay`：同一句接着上一句写，只把新接上的一段算成这一句。 */
    csayLine(name, line, timing = {}) {
      return serializeLine(() => writeLine(name, line, timing, true));
    },
    choose(labels) {
      return Promise.resolve(labels?.length ? 0 : -1);
    },
    /**
     * `stage.click(time)` / `stage.auto(time)` 在导出里只占时长：没有玩家来
     * 点击，点击标记也不进画面，唯一的职责是把虚拟时钟推进 `time` 毫秒。
     * 与台词排同一条队，和播放器一样：前一句还挂着时，这个等待从那一句
     * 走完之后才开始计时。
     */
    clickWait(time) {
      return serializeLine(() => clock.wait(Number(time) || 0));
    },
    /**
     * `stage.autoVoice(speed)` 在导出里落在这里：开启后，没有显式配音的
     * `say` 自动配一段合成效果音。参数为整数播放速度（次/秒，1–10，默认 10）；
     * 传 `false`/`0` 关闭。已有的 `audio` 配音优先，不受此开关影响。
     */
    setAutoVoice(on) {
      if (typeof on === "number") {
        autoVoiceOn = on > 0;
        autoVoiceSpeed = Math.min(
          AUTOVOICE_MAX_SPEED,
          Math.max(AUTOVOICE_MIN_SPEED, Math.round(on)),
        );
      } else {
        autoVoiceOn = Boolean(on);
        autoVoiceSpeed = AUTOVOICE_DEFAULT_SPEED;
      }
    },
    /** 当前是否开启自动配音（导出录制侧）。 */
    getAutoVoice() {
      return autoVoiceOn;
    },
    /**
     * `stage.autoPause(ms)` 在导出里落在这里：一句说完之后的停顿，默认 800。
     *
     * 缺省或非法值回到默认；`0` 是「说完就切」，不是「用默认值」。
     */
    setAutoPause(ms) {
      const value = Number(ms);
      autoPauseMs = Number.isFinite(value) && value >= 0 ? value : SAY_TAIL_MS;
    },
    autoWait(time) {
      return clock.wait(Number(time) || 0);
    },
    /**
     * `stage.pamela()` 在成片里照常占满整段动画：时间线记下开始时刻，逐帧渲染
     * 按同一份 `pamelaIntroState()` 把黑幕、图标与两行文字画上去，到点再登记关闭。
     * 预览 / 读档回放走的是真舞台，不进这条录制路径。
     */
    pamelaIntro() {
      const start = clock.now();
      addSet(timeline, start, "pamelaIntro", { start, total: PAMELA_INTRO_MS, active: true });
      addSet(timeline, start + PAMELA_INTRO_MS, "pamelaIntro", { active: false });
      return clock.wait(PAMELA_INTRO_MS);
    },
    /**
     * 环境亮度：整块画面的乘算亮度，0–2，1 为原样。
     *
     * 它进时间线而不是进某个对象：渲染后端在画每一层时把它乘进滤镜里，
     * 所以它和舞台上一样只作用于画面，不作用于对话盒。给了 `time` 就登记
     * 一段线性过渡，成片里看到的是从当前亮度走到新值。
     *
     * @returns {Promise<void> | undefined} 有时间时让剧本等这段过渡走完。
     */
    setAmbient(value, time) {
      const next = Math.min(2, Math.max(0, Number(value)));
      if (!Number.isFinite(next)) {
        throw new Error("环境亮度需要 0–2 的数字");
      }
      const at = clock.now();
      const span = Number(time) > 0 ? Number(time) : 0;
      const from = ambientShown();
      ambientValue = next;
      ambientFrom = from;
      ambientStart = at;
      ambientSpan = span;
      if (span > 0) {
        addTween(timeline, at, at + span, "ambient", "value", from, next);
        return clock.wait(span);
      }
      addSet(timeline, at, "ambient", { value: next });
      return undefined;
    },
    /**
     * 空间透视：默认关。开关进时间线而不是进某个对象 —— 它改的是整幅画面的
     * 投影，渲染后端每帧读一次。
     */
    setPerspective(value) {
      addSet(timeline, clock.now(), "perspective", { value: boolArg(value) });
    },
    /**
     * 空间参考线：开关与间隔一起进时间线，渲染后端按同一套几何重画。
     */
    setGuideline(value, interval) {
      const patch = { value: boolArg(value) };
      if (interval !== undefined && interval !== null) {
        const number = Number(interval);
        if (!Number.isFinite(number)) {
          throw new Error("参考线间隔需要 ≥ 10 的整数");
        }
        patch.interval = Math.max(10, Math.round(number));
      }
      addSet(timeline, clock.now(), "guideline", patch);
    },
  };
}

/**
 * 录制对象的链式代理，但不伪装成 thenable。
 *
 * 只有录进去的方法才答得出来：脚本写错名字，或者这个类型本来没有那个方法时，
 * 答案和播放器一样是「没有这个方法」，而不是一个默默吞掉调用的空实现。否则
 * 导出能跑、播放器报错的脚本会把两边真正的差异掩盖过去。
 */
function chainable(record) {
  let proxy;
  proxy = new Proxy(record, {
    get(target, prop) {
      if (prop in target) {
        return target[prop];
      }
      if (typeof prop !== "string") {
        return undefined;
      }
      if (prop === "then" || prop === "toJSON" || prop === "valueOf") {
        return undefined;
      }
      // 中文方法名落到同名英文方法上：解释器拿到对象自带的方法后就不再查别名
      // 表，`模糊(8) @ 1000` 会因找不到参数表而报「没有时间参数」。
      const english = BUILTIN_ALIASES.get(prop);
      if (english !== undefined && english in target) {
        return target[english];
      }
      // 别名对应的英文方法也没有时照样交回 undefined：像「颜色」这种多义词
      // 选 `hex` 还是 `color`，要由解释器按对象实际有的方法决定，与播放器一致。
      return undefined;
    },
  });
  return proxy;
}

/**
 * 与 `createStageObjects` 同形的一组工厂：`(args, context) => 对象`。
 * `args[0]` 是资源名；其余构造参数在 MVP 里忽略（视觉近似）。
 */
export function createRecordingObjects({
  clock,
  timeline,
  recordingStage,
  config = DEFAULT_RECORDING,
  assets = new Map(),
  frameSize = LOGICAL_SIZE,
  /** `createAudioRecorder()` 的产物：有它时 `Audio(…)` 才真正被记录。 */
  audioRecorder = null,
  /** `createVideoRecorder()` 的产物：有它时 `Video(…)` 的声轨也进成片。 */
  videoRecorder = null,
}) {
  const settings = { ...DEFAULT_RECORDING, ...config };
  // 粒子只写时间线：渲染后端按固定步长推进，不需要会话层再传什么。
  const effectRecorder = createEffectRecorder({ clock, timeline });
  /** 没被赋给变量的灯，按顺序拿一个名字。 */
  let lightCounter = 0;
  // 每台摄影机在时间线上有自己的 `camera:<名字>` 目标；同一时刻 active 只有一台。
  const cameraStates = new Map();
  let cameraCounter = 0;

  /**
   * 视频把两条记录拼起来：画面照旧走时间线（位置、透明度、显隐），
   * 播放头与声音交给 `videoRecorder`，两个记录共用同一条时间轴。
   */
  function attachVideo(picture, sound) {
    const baseEnable = picture.enable;
    const baseDisable = picture.disable;
    const reveal = (time) => baseEnable(time);
    const hide = () => baseDisable();

    picture.enable = (time = 0) => {
      reveal(time);
      sound.enable();
      return picture;
    };
    picture.disable = () => {
      hide();
      sound.disable();
      return picture;
    };
    picture.play = () => {
      reveal();
      sound.play();
      return picture;
    };
    picture.pause = () => {
      sound.pause();
      return picture;
    };
    picture.mute = (value) => {
      sound.mute(value);
      return picture;
    };
    picture.volume = (value, time) => {
      sound.volume(value, time);
      return picture;
    };
    picture.loop = () => {
      sound.loop();
      return picture;
    };
    picture.once = () => {
      sound.once();
      return picture;
    };
    picture.speed = (value, time) => {
      sound.speed(value, time);
      return picture;
    };
    picture.speedTo = (value, time) => {
      sound.speedTo(value, time);
      return picture;
    };
    picture.duration = () => sound.duration();
    picture.audio = sound.audio;
    // `del v` 要把声音一起放下：画面由 picture 自己的销毁钩子收掉，声轨另说。
    const baseDestroy = picture[OBJECT_DESTROY];
    picture[OBJECT_DESTROY] = () => {
      baseDestroy();
      sound.disable();
    };

    // 画面轨：显隐、播放、暂停与速率交给播放头；其余画面方法（移动、旋转、
    // 缩放、透明度、滤镜与调色）转给同一层画面记录，和播放器的画面轨一致。
    const mediaRecord = {
      kind: "VideoMedia",
      enable() {
        reveal();
        return media;
      },
      disable() {
        hide();
        return media;
      },
      play() {
        reveal();
        sound.media.play();
        return media;
      },
      pause() {
        sound.media.pause();
        return media;
      },
      speed(value, time) {
        sound.media.speed(value, time);
        return media;
      },
      speedTo(value, time) {
        sound.media.speedTo(value, time);
        return media;
      },
    };
    for (const name of VIDEO_MEDIA_PICTURE_METHODS) {
      if (typeof picture[name] !== "function") {
        continue;
      }
      mediaRecord[name] = (...args) => {
        picture[name](...args);
        return media;
      };
    }
    const media = chainable(mediaRecord);
    picture.media = media;
    return picture;
  }

  /**
   * 摄影机的录制：每台一个 `camera:<名字>` 目标，只有 active 那台参与导出画面。
   *
   * 相机不读素材也不画在舞台上，所以状态全是数字；移动、视角、畸变都走同一条
   * `commit`，带时长就登记成时间线插值。enable 会把别的相机同时置为 inactive，
   * 多机位切换因此只是几行 set。
   */
  function makeCamera(args, context) {
    const slot = context?.assignee ?? `camera-${(cameraCounter += 1)}`;
    const target = `camera:${asText(slot)}`;
    const options = {};
    (PARAM_SPECS.Camera ?? []).forEach((name, index) => {
      if (args?.[index] !== undefined) options[name] = args[index];
    });
    const start = normalizeCamera({ ...DEFAULT_CAMERA, ...options });
    const state = {
      x: start.x, y: start.y, z: start.z,
      rotate: start.rotate, rotateH: start.rotateH, rotateV: start.rotateV,
      fov: start.fov, k1: start.k1, k2: start.k2,
      active: false,
    };
    cameraStates.set(target, state);
    addSet(timeline, clock.now(), target, { ...state });

    // 与画面对象同一条规矩：`del` 之后不再写时间线。
    let destroyed = false;

    function commit(patch, ms = 0) {
      if (destroyed) {
        return;
      }
      const at = clock.now();
      const span = Number(ms) > 0 ? Number(ms) : 0;
      if (span > 0) {
        for (const [prop, value] of Object.entries(patch)) {
          if (typeof value === "number" && typeof state[prop] === "number") {
            addTween(timeline, at, at + span, target, prop, state[prop], value);
          } else {
            addSet(timeline, at, target, { [prop]: value });
          }
        }
      } else {
        addSet(timeline, at, target, patch);
      }
      Object.assign(state, patch);
    }

    function timed(ms) {
      const span = Number(ms) > 0 ? Number(ms) : 0;
      if (span > 0) {
        context?.pending?.push(clock.wait(span));
      }
    }

    const number = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const camera = {
      kind: "Camera",
      moveTo(x, y, z, time) {
        const patch = {};
        if (x !== undefined && x !== null) patch.x = number(x);
        if (y !== undefined && y !== null) patch.y = number(y);
        if (z !== undefined && z !== null) patch.z = number(z);
        commit(patch, time);
        timed(time);
        return camera;
      },
      move(h, v, d, time) {
        return camera.moveTo(
          state.x + number(h),
          state.y + number(v),
          state.z + number(d),
          time,
        );
      },
      rotateTo(degrees, time) {
        commit({ rotate: number(degrees, state.rotate) }, time);
        timed(time);
        return camera;
      },
      rotate(degrees, time) {
        return camera.rotateTo(state.rotate + number(degrees), time);
      },
      rotateH(degrees, time) {
        commit({ rotateH: number(degrees, state.rotateH) }, time);
        timed(time);
        return camera;
      },
      rotateV(degrees, time) {
        commit({ rotateV: number(degrees, state.rotateV) }, time);
        timed(time);
        return camera;
      },
      fov(value, time) {
        const next = normalizeCamera({ ...state, fov: number(value, state.fov) });
        commit({ fov: next.fov }, time);
        timed(time);
        return camera;
      },
      distort(k1, k2, time) {
        commit({
          k1: number(k1),
          k2: number(k2),
        }, time);
        timed(time);
        return camera;
      },
      enable() {
        if (!state.active) {
          const at = clock.now();
          for (const [key, other] of cameraStates) {
            if (key !== target && other.active) {
              addSet(timeline, at, key, { ...other, active: false });
              other.active = false;
            }
          }
        }
        commit({ active: true });
        return camera;
      },
      disable() {
        commit({ active: false });
        return camera;
      },
      /** `del cam`：在当下退出取景，之后不再写它的状态。 */
      [OBJECT_DESTROY]() {
        if (destroyed) {
          return;
        }
        commit({ active: false });
        destroyed = true;
        camera.destroyed = true;
      },
    };
    void context;
    return camera;
  }

  function makeObject(kind, args, context) {
    let object;
    // 声音不进画面，也不参与时间线：有录制器时整件事交给它（记事件、留到混音）。
    if (kind === "Audio" && audioRecorder) {
      object = audioRecorder.audio(args, context);
    } else if (kind === "Effect") {
      // 粒子没有图片路径，按对象名写一条 `effect:` 状态，渲染后端自己推进。
      object = effectRecorder.effect(args, context);
    } else if (kind === "Light") {
      // 灯同样不读素材：它按对象名写一条 `light:` 状态，渲染后端画成灯层。
      object = makeLight(args, context);
    } else if (kind === "Camera") {
      // 摄影机不画在舞台上，只写一条 `camera:` 状态供渲染后端取景。
      object = makeCamera(args, context);
    } else {
      const picture = makePicture(kind, args, context);
      object = kind === "Video" && videoRecorder
        ? attachVideo(picture, videoRecorder.video(args, context))
        : picture;
    }
    // 音频与粒子没有三维坐标：给它们一个安静的空实现，让导出时的
    // `crood(true)` 和舞台一样不会报错，也不会凭空画出三根轴。它们也不挡光，
    // 所以 `translucent(...)` 同样是空实现。
    if (object && typeof object === "object" && typeof object.crood !== "function") {
      object.crood = () => object;
    }
    if (object && typeof object === "object" && typeof object.translucent !== "function") {
      object.translucent = () => object;
    }
    // 粒子与音频没有轮廓可勾，接住这个方法只为和其余对象同名。
    if (object && typeof object === "object" && typeof object.rim !== "function") {
      object.rim = () => object;
    }
    // 舞台上每个对象都能 `del`；将来新增的类型漏了销毁钩子时，这里补一个
    // 空的，至少不会让整趟导出因为一条收尾语句失败。
    if (object && typeof object === "object" && typeof object[OBJECT_DESTROY] !== "function") {
      object[OBJECT_DESTROY] = () => {
        object.destroyed = true;
      };
    }
    return object;
  }

  /**
   * 灯的录制：全部状态都是数值，所以过渡与位移一样交给时间线插值。
   *
   * 灯在时间线上是一个 `light:<名字>` 目标，渲染后端按它画灯层。排除关系是
   * 一组对象键（`excluded`），不是数值，按 `addSet` 整组替换。
   */
  function makeLight(args, context) {
    const slot = context?.assignee ?? `light-${(lightCounter += 1)}`;
    const target = `light:${asText(slot)}`;
    const numberOf = (index, fallback) => {
      const value = Number(args?.[index]);
      return Number.isFinite(value) ? value : fallback;
    };
    const start = normalizeLight({
      color: asText(args?.[0]).trim() || "FFFFFF",
      intensity: numberOf(1, 1),
      x: numberOf(2, 0),
      y: numberOf(3, 0),
      opacity: numberOf(4, 1),
      spread: numberOf(5, 360),
      range: numberOf(6, -1),
      bloom: numberOf(7, 0),
      soft: numberOf(8, 0),
      z: numberOf(9, 0),
      rotateH: numberOf(10, 0),
      rotateV: numberOf(11, 0),
      rotate: numberOf(12, 0),
      width: numberOf(13, 0),
    });
    const state = {
      color: start.color,
      intensity: start.intensity,
      opacity: start.opacity,
      spread: start.spread,
      range: start.range,
      bloom: start.bloom,
      soft: start.soft,
      width: start.width,
      x: start.x,
      y: start.y,
      z: start.z,
      rotateH: start.rotateH,
      rotateV: start.rotateV,
      rotation: start.rotate,
      visible: false,
      excluded: [],
      // 每个对象自己的三维坐标轴：默认隐藏，`crood(true)` 打开。
      crood: false,
    };
    // 灯建出来就有一条状态：没有它，渲染后端直到第一次 enable 才知道这盏灯。
    addSet(timeline, clock.now(), target, { ...state });

    // 与画面对象同一条规矩：`del` 之后不再写时间线。
    let destroyed = false;

    function commit(patch, ms = 0) {
      if (destroyed) {
        return;
      }
      const at = clock.now();
      const span = Number(ms) > 0 ? Number(ms) : 0;
      if (span > 0) {
        for (const [prop, value] of Object.entries(patch)) {
          if (typeof value === "number" && typeof state[prop] === "number") {
            addTween(timeline, at, at + span, target, prop, state[prop], value);
          } else {
            addSet(timeline, at, target, { [prop]: value });
          }
        }
      } else {
        addSet(timeline, at, target, patch);
      }
      Object.assign(state, patch);
    }

    function timed(ms) {
      const span = Number(ms) > 0 ? Number(ms) : 0;
      if (span > 0) {
        context?.pending?.push(clock.wait(span));
      }
    }

    /** 一个数值属性的过渡：与舞台上的 `Light` 同名同义。 */
    const number = (prop, value, ms) => {
      const next = normalizeLight({ ...state, rotate: state.rotation, [prop]: Number(value) })[prop];
      commit({ [prop]: next }, ms);
      timed(ms);
      return light;
    };

    const light = {
      kind: "Light",
      /** 这颗灯在时间线上的目标名，也是对象键的前缀。 */
      timelineKey: target,
      enable() {
        commit({ visible: true });
        return light;
      },
      disable() {
        commit({ visible: false });
        return light;
      },
      /** `del lamp`：在当下熄掉这盏灯，之后不再写它的状态。 */
      [OBJECT_DESTROY]() {
        if (destroyed) {
          return;
        }
        commit({ visible: false });
        destroyed = true;
        light.destroyed = true;
      },
      /** 这盏灯自己的三维坐标轴；和舞台一样默认隐藏。 */
      crood(value) {
        commit({ crood: Boolean(value) });
        return light;
      },
      /** 灯自己不挡光：光源就是光本身。只为和其余对象同名而存在。 */
      translucent() {
        return light;
      },
      /** 光源没有轮廓可勾（它自己就是光）。只为和其余对象同名而存在。 */
      rim() {
        return light;
      },
      alpha(value, ms) {
        commit({ opacity: Math.min(1, Math.max(0, Number(value) || 0)) }, ms);
        timed(ms);
        return light;
      },
      show(ms) {
        return light.alpha(1, ms);
      },
      hide(ms) {
        return light.alpha(0, ms);
      },
      move(dx, dy, dz, ms) {
        const patch = {
          x: state.x + Number(dx || 0),
          y: state.y + Number(dy || 0),
        };
        if (dz !== undefined && dz !== null) {
          patch.z = normalizeLight({ z: state.z + Number(dz || 0) }).z;
        }
        commit(patch, ms);
        timed(ms);
        return light;
      },
      moveTo(x, y, z, ms) {
        const patch = { x: Number(x) || 0, y: Number(y) || 0 };
        if (z !== undefined && z !== null) {
          patch.z = normalizeLight({ z }).z;
        }
        commit(patch, ms);
        timed(ms);
        return light;
      },
      rotate(value, ms) {
        commit({ rotation: state.rotation + Number(value || 0) }, ms);
        timed(ms);
        return light;
      },
      rotateTo(value, ms) {
        commit({ rotation: Number(value) || 0 }, ms);
        timed(ms);
        return light;
      },
      intensity(value, ms) {
        return number("intensity", value, ms);
      },
      spread(value, ms) {
        return number("spread", value, ms);
      },
      range(value, ms) {
        return number("range", Number(value) < 0 ? -1 : value, ms);
      },
      bloom(value, ms) {
        return number("bloom", value, ms);
      },
      soft(value, ms) {
        return number("soft", value, ms);
      },
      width(value, ms) {
        return number("width", value, ms);
      },
      z(dz, ms) {
        return number("z", state.z + Number(dz || 0), ms);
      },
      x(dx, ms) {
        commit({ x: state.x + Number(dx || 0) }, ms);
        timed(ms);
        return light;
      },
      y(dy, ms) {
        commit({ y: state.y + Number(dy || 0) }, ms);
        timed(ms);
        return light;
      },
      zTo(z, ms) {
        return number("z", z, ms);
      },
      xTo(x, ms) {
        commit({ x: Number(x) || 0 }, ms);
        timed(ms);
        return light;
      },
      yTo(y, ms) {
        commit({ y: Number(y) || 0 }, ms);
        timed(ms);
        return light;
      },
      /** H 平轴（即 x）的相对移动：与 `x` 同一个调用。 */
      h(dh, ms) {
        commit({ x: state.x + Number(dh || 0) }, ms);
        timed(ms);
        return light;
      },
      /** V 升轴（即 y）的相对移动：与 `y` 同一个调用。 */
      v(dv, ms) {
        commit({ y: state.y + Number(dv || 0) }, ms);
        timed(ms);
        return light;
      },
      /** 把绝对 H 坐标（即 x）设成 `h`。 */
      hTo(h, ms) {
        commit({ x: Number(h) || 0 }, ms);
        timed(ms);
        return light;
      },
      /** 把绝对 V 坐标（即 y）设成 `v`。 */
      vTo(v, ms) {
        commit({ y: Number(v) || 0 }, ms);
        timed(ms);
        return light;
      },
      /** H 面方位角：0 光束朝 +x，顺时针 90 度正对镜头。 */
      rotateH(value, ms) {
        return number("rotateH", value, ms);
      },
      /** V 面抬落角：0 水平，正数低头。 */
      rotateV(value, ms) {
        return number("rotateV", value, ms);
      },
      direction(rotateH, rotateV, ms) {
        const next = normalizeLight({ rotateH: Number(rotateH), rotateV: Number(rotateV) });
        commit({ rotateH: next.rotateH, rotateV: next.rotateV }, ms);
        timed(ms);
        return light;
      },
      /** 灯的颜色是绝对的：`hex` 与 `rgb` 都直接换色，不像图片那样是偏移。 */
      hex(value, ms) {
        const { r, g, b } = parseHex(value);
        commit({ color: toHex(r, g, b) }, ms);
        timed(ms);
        return light;
      },
      rgb(r, g, b, ms) {
        commit({ color: toHex(clampChannel(r), clampChannel(g), clampChannel(b)) }, ms);
        timed(ms);
        return light;
      },
      /** 这盏灯不照 `targets`：对象键写进 `excluded`，渲染后端据此挖洞。 */
      exclude(targets, add) {
        const keys = new Set(state.excluded);
        for (const object of targets) {
          // 与播放器的 litKeyOf 同一条规则：只有背景与角色有剪影可排除，
          // 其余类型（视频、粒子、文字、灯）都不接受。
          const key =
            object?.kind === "Background" || object?.kind === "Character"
              ? object.timelineKey
              : null;
          if (!key) {
            throw new Error("光照只能排除背景与角色");
          }
          if (add) {
            keys.add(key);
          } else {
            keys.delete(key);
          }
        }
        commit({ excluded: [...keys] });
        return light;
      },
    };
    return light;
  }

  function makePicture(kind, args, context) {
    // 文字没有资源：第一个参数是内容，其余是构造参数（x / y / size / color …）。
    const isText = kind === "Text";
    const path = isText ? "" : asText(args?.[0]).trim();
    // 视频的画面也进时间线（渲染后端逐帧取帧），所以和背景、角色一样算「要画」。
    // 文字同样要画：渲染后端用 fillText 重画，不经过位图。
    const draws =
      kind === "Background" || kind === "Character" || kind === "Video" || isText;
    const target =
      kind === "Background"
        ? "background"
        : kind === "Character"
          ? "character:" + asText(context?.assignee ?? "character")
          : kind.toLowerCase() + ":" + asText(context?.assignee ?? kind.toLowerCase());
    const state = {
      path,
      opacity: 1,
      x: 0,
      y: 0,
      // 深度：0 是舞台平面，正数往画面深处（更远、更小）。背景默认比角色
      // （0）远一层，与舞台一致：它总是垫在角色后面。
      z: kind === "Background" ? BACKGROUND_DEPTH : 0,
      rotation: 0,
      // 转出 W 面的两个角：0 表示这张纸躺在舞台上、正对观众。
      rotateH: 0,
      rotateV: 0,
      scale: 1,
      visible: false,
      // 每个对象自己的三维坐标轴：默认隐藏，`crood(true)` 打开。
      crood: false,
      // 透光：灯的光能不能穿过这个对象。与舞台同一套默认值 —— 角色挡光，
      // 背景画的是整个世界、文字与视频还不在灯层里，所以它们默认透光。
      lightPass: kind !== "Character",
      // 轮廓光：逆光时贴着轮廓勾出的光强，0–1。默认 0：不写就不勾边。
      rim: 0,
      // 抗锯齿：角色缩放时怎么取像素，强度 0–2。与舞台同一套默认值 —— 默认 0
      // （关，硬边）。`smooth` 是整张图那一档，`edgeSmooth` 是只柔化轮廓那一档；
      // 只有角色有，其余类型留空（渲染端照旧交给浏览器平滑）。
      smooth: kind === "Character" ? 0 : undefined,
      edgeSmooth: kind === "Character" ? 0 : undefined,
      frame: 0,
      // 文字的状态：内容与样式都在这里，渲染后端据此 fillText。
      text: isText ? asText(args?.[0]) : "",
      size: isText ? Number(args?.[3]) || 48 : 0,
      color: isText ? asText(args?.[4]) || "#ffffff" : "#ffffff",
      // 颜色拆成通道之后，时间线才能像调色那样逐帧插值；拆不出来的 CSS
      // 颜色（`tomato` 之类）退化为到点换色，`colorIsRgb` 说明该用哪一种。
      color_r: 0,
      color_g: 0,
      color_b: 0,
      colorIsRgb: false,
      // 一个字体名同时作用于中文与西文；空串是内置默认（西文 JetBrains
      // Mono、中文思源黑体）。
      fontFamily: "",
      // 字重是 CSS 的数值刻度，400 是常规；渲染后端据此写 canvas 的 font。
      fontWeight: TEXT_FONT_WEIGHT,
      // 滤镜与调色：舞台把它们写在元素的 CSS 上，导出写进时间线，由渲染后端重画。
      // 同时存一份扁平数值，让过渡能像位移一样在时间线上插值。
      look: null,
      look_blur: 0,
      look_brightness: 1,
      look_contrast: 1,
      look_saturate: 1,
      tint: { r: 0, g: 0, b: 0 },
      tint_r: 0,
      tint_g: 0,
      tint_b: 0,
      // 逐帧图片组：一组图、速度、是否循环，以及这一轮从哪一刻开始。渲染端按
      // 时间求值出当前该画哪一张，所以不必为每一帧写一条时间线记录。
      group: [],
      groupFps: 0,
      groupLoop: false,
      groupStart: 0,
      groupPlaying: false,
    };
    // 文字的构造参数（位置、缩放、旋转、透明度）在舞台上会被记住并在
    // enable 时应用；导出沿用同一语义，让成片的第一帧就在作者写的位置上。
    if (isText) {
      const numberOf = (index, fallback) => {
        const value = Number(args?.[index]);
        return Number.isFinite(value) ? value : fallback;
      };
      state.x = numberOf(1, 0);
      state.y = numberOf(2, 0);
      const scale = numberOf(5, 1);
      const scaleTo = args?.[6] === undefined ? null : numberOf(6, 1);
      state.scale = scaleTo === null ? scale : scaleTo;
      const rotation = numberOf(7, 0);
      const rotateTo = args?.[8] === undefined ? null : numberOf(8, 0);
      state.rotation = rotateTo === null ? rotation : rotateTo;
      state.opacity = Math.min(1, Math.max(0, numberOf(9, 1)));
      const rgb = rgbOf(state.color);
      if (rgb) {
        state.color_r = rgb.r;
        state.color_g = rgb.g;
        state.color_b = rgb.b;
        state.colorIsRgb = true;
      }
    }
    // 构造里的 z：位置由 PARAM_SPECS 决定，所以按名字找，不写死下标。
    const depthIndex = (PARAM_SPECS[kind] ?? []).indexOf("z");
    if (depthIndex >= 0 && args?.[depthIndex] !== undefined) {
      state.z = clampDepth(args[depthIndex]);
    }
    // 两个转出 W 面的角同样按名字找：它们排在参数表最后，位置随时可以变。
    for (const prop of ["rotateH", "rotateV"]) {
      const index = (PARAM_SPECS[kind] ?? []).indexOf(prop);
      const value = Number(args?.[index]);
      if (index >= 0 && args?.[index] !== undefined && Number.isFinite(value)) {
        state[prop] = value;
      }
    }
    // 每个控制点一组数值偏移，交给时间线做 tween；渲染后端按名字装配网格。
    for (const point of TRANSFORM_POINTS) {
      state[`mesh_${point}_dx`] = 0;
      state[`mesh_${point}_dy`] = 0;
    }
    let speaker = "";
    // `del ch` 之后这颗对象就下场了：变量虽已解开，但组或别的名字还可能提到它。
    // 真舞台上销毁后的调用是空操作，录制端也一样 —— 不能再往时间线写状态，
    // 否则一次迟到的 `enable` 会把它重新画回成片里。
    let destroyed = false;

    /** `...To(x, y)` 是舞台坐标，要减掉对象位置与该点原本的矩形位置。 */
    function meshBase(handle) {
      const bitmap = assets?.get(path);
      const rect = bitmap
        ? fitRect(
            bitmap.width ?? bitmap.naturalWidth,
            bitmap.height ?? bitmap.naturalHeight,
            Number(frameSize.width) || LOGICAL_SIZE.width,
            Number(frameSize.height) || LOGICAL_SIZE.height,
            kind === "Background" ? "cover" : "contain",
          )
        : null;
      return meshBasePoint(handle, rect);
    }

    /** 登记一个状态变更；数值属性在 time 内线性插值。 */
    function commit(patch, ms = 0) {
      if (destroyed) {
        return;
      }
      const t = clock.now();
      const duration = Number(ms) > 0 ? Number(ms) : 0;
      if (!draws) {
        return;
      }
      if (duration > 0) {
        for (const [prop, value] of Object.entries(patch)) {
          if (typeof value === "number" && typeof state[prop] === "number") {
            addTween(timeline, t, t + duration, target, prop, state[prop], value);
          } else {
            addSet(timeline, t, target, { [prop]: value });
          }
        }
      } else {
        addSet(timeline, t, target, patch);
      }
      Object.assign(state, patch);
    }

    /** 耗时动作既插值，也让 context.pending 汇合；方法仍返回自身保持链式。 */
    function timed(ms) {
      const waiting = clock.wait(ms > 0 ? ms : settings.defaultMoveMs);
      context?.pending?.push(waiting);
    }

    /** 只在脚本给了时间时等待：滤镜与调色没有默认时长。 */
    function settle(ms) {
      const span = Number(ms) || 0;
      if (span > 0) {
        context?.pending?.push(clock.wait(span));
      }
    }

    /** 滤镜是叠加的绝对量，和舞台一样由 `withLook` 校验并夹取。 */
    function setLook(property, value, ms) {
      state.look = withLook(state.look, property, value, kind);
      // 只写这次动的那一项：一次 cue 里连写两个滤镜时，另一项的过渡还在飞，
      // 把它连同目标值重新登记会让它瞬间落位，与舞台的逐帧插值不一致。
      commit({ look: state.look, [`look_${property}`]: state.look[property] }, ms);
      settle(ms);
    }

    /** 调色是一组通道偏移；整组换掉，三个通道各自按时间插值。 */
    function setTint(next, ms) {
      state.tint = next;
      commit({ tint: next, tint_r: next.r, tint_g: next.g, tint_b: next.b }, ms);
      settle(ms);
    }

    const record = {
      kind,
      path,
      get name() {
        return speaker;
      },
      enable(time = 0) {
        // 舞台的 enable 自带 show：给了时长就从透明渐显，没给就沿用既有透明度。
        // 录制端过去只把 visible 写成 true，2000 这样的时长被丢掉，成片里文字
        // 第一帧就不透明，看着像瞬间出现。
        const span = Number(time) > 0 ? Number(time) : 0;
        const enteringOpacity = span > 0 ? 0 : state.opacity;
        // 文字没有位图路径：第一次上台时把内容、样式与构造位置一起登记，
        // 否则渲染后端只会看到一个没有文字的可见层。
        if (kind === "Text") {
          commit({
            visible: true,
            text: state.text,
            size: state.size,
            color: state.color,
            color_r: state.color_r,
            color_g: state.color_g,
            color_b: state.color_b,
            colorIsRgb: state.colorIsRgb,
            fontFamily: state.fontFamily,
            fontWeight: state.fontWeight,
            x: state.x,
            y: state.y,
            z: state.z,
            rotation: state.rotation,
            rotateH: state.rotateH,
            rotateV: state.rotateV,
            scale: state.scale,
            opacity: enteringOpacity,
            // 舞台在 enable 时把记住的 look 一次性画出来；这里同样把当前滤镜
            // 快照登记，写在 enable 之前的 blur 就不会留着一条未完的过渡。
            look: state.look,
            look_blur: state.look_blur,
            look_brightness: state.look_brightness,
            look_contrast: state.look_contrast,
            look_saturate: state.look_saturate,
            crood: state.crood,
            lightPass: state.lightPass,
            rim: state.rim,
          });
        } else {
          // 构造参数写下的位置、深度、三个转角与缩放也要落到时间线上：
          // 舞台那边 `enable()` 会把它们整套应用一次，成片要和预览一致。
          commit({
            visible: true,
            // 把上台时的透明度写进时间线：给了时长就从 0 起跑，没给就沿用
            // 既有值（例如 `hide().enable().show(ms)` 仍由 show 负责渐显）。
            opacity: enteringOpacity,
            // `state.path` rather than the constructor's: a `group()` written
            // before `enable()` has already moved the picture on to its first
            // frame, and enabling must not put the empty definition back.
            path: state.path,
            x: state.x,
            y: state.y,
            z: state.z,
            rotation: state.rotation,
            rotateH: state.rotateH,
            rotateV: state.rotateV,
            scale: state.scale,
            crood: state.crood,
            lightPass: state.lightPass,
            rim: state.rim,
            // 抗锯齿只有角色有；别的类型不写这两项，渲染端就照旧交给浏览器平滑。
            ...(kind === "Character"
              ? { smooth: state.smooth, edgeSmooth: state.edgeSmooth }
              : {}),
          });
        }
        if (span > 0) {
          record.alpha(1, span);
        }
        return proxy;
      },
      disable() {
        commit({ visible: false });
        return proxy;
      },
      /**
       * `del ch`：导出只演一趟，没有素材要释放，但要在当下把这一层收掉，
       * 后面的帧不再画它；此后对它的调用也不再写时间线。
       */
      [OBJECT_DESTROY]() {
        if (destroyed) {
          return;
        }
        commit({ visible: false });
        destroyed = true;
        record.destroyed = true;
      },
      /** 这个对象自己的三维坐标轴；默认隐藏，enable() 会把开关一并登记。 */
      crood(value) {
        commit({ crood: boolArg(value) });
        return proxy;
      },
      /** 透光：true 时光穿过这个对象，灯不再按深度把它挖成剪影。 */
      translucent(value = true) {
        commit({ lightPass: boolArg(value) });
        return proxy;
      },
      /** 轮廓光强度 0–1：灯在它背后时贴着轮廓勾一圈光，默认 0。 */
      rim(value = 1) {
        commit({ rim: Math.min(1, Math.max(0, Number(value) || 0)) });
        return proxy;
      },
      /** 抗锯齿：整张图的强度 0–2，默认 0（关，硬边）。 */
      aa(value = 0) {
        commit({ smooth: antialiasAmount("抗锯齿", value) });
        return proxy;
      },
      /** 边缘抗锯齿：只柔化轮廓的强度 0–2，默认 0（关）。 */
      eaa(value = 0) {
        commit({ edgeSmooth: antialiasAmount("边缘抗锯齿", value) });
        return proxy;
      },
      show: null,
      hide: null,
      alpha(value, ms) {
        commit({ opacity: Number(value) || 0 }, ms);
        // 与舞台一致：没给时长就是瞬间落定，不要像 move 那样垫一段默认时长。
        settle(ms);
        return proxy;
      },
      move(dx, dy, dz, ms) {
        const patch = {
          x: state.x + Number(dx || 0),
          y: state.y + Number(dy || 0),
        };
        if (dz !== undefined && dz !== null) {
          patch.z = clampDepth(state.z + Number(dz || 0));
        }
        commit(patch, ms);
        timed(ms);
        return proxy;
      },
      moveTo(x, y, z, ms) {
        const patch = { x: Number(x) || 0, y: Number(y) || 0 };
        if (z !== undefined && z !== null) {
          patch.z = clampDepth(z);
        }
        commit(patch, ms);
        timed(ms);
        return proxy;
      },
      /** 深度：0 是舞台平面，正数往画面深处（更远、更小）。 */
      z(dz, ms) {
        commit({ z: clampDepth(state.z + Number(dz || 0)) }, ms);
        settle(ms);
        return proxy;
      },
      /** 沿 x 轴相对移动：正数向右。 */
      x(dx, ms) {
        commit({ x: state.x + Number(dx || 0) }, ms);
        timed(ms);
        return proxy;
      },
      /** 沿 y 轴相对移动：正数向上。 */
      y(dy, ms) {
        commit({ y: state.y + Number(dy || 0) }, ms);
        timed(ms);
        return proxy;
      },
      /** 把绝对深度设成 `z`；这是 `z` 改名后的绝对写法。 */
      zTo(z, ms) {
        commit({ z: clampDepth(z) }, ms);
        settle(ms);
        return proxy;
      },
      /** 把绝对 x 坐标设成 `x`。 */
      xTo(x, ms) {
        commit({ x: Number(x) || 0 }, ms);
        timed(ms);
        return proxy;
      },
      /** 把绝对 y 坐标设成 `y`。 */
      yTo(y, ms) {
        commit({ y: Number(y) || 0 }, ms);
        timed(ms);
        return proxy;
      },
      /** H 平轴（即 x）的相对移动：与 `x` 同一个调用。 */
      h(dh, ms) {
        commit({ x: state.x + Number(dh || 0) }, ms);
        timed(ms);
        return proxy;
      },
      /** V 升轴（即 y）的相对移动：与 `y` 同一个调用。 */
      v(dv, ms) {
        commit({ y: state.y + Number(dv || 0) }, ms);
        timed(ms);
        return proxy;
      },
      /** 把绝对 H 坐标（即 x）设成 `h`。 */
      hTo(h, ms) {
        commit({ x: Number(h) || 0 }, ms);
        timed(ms);
        return proxy;
      },
      /** 把绝对 V 坐标（即 y）设成 `v`。 */
      vTo(v, ms) {
        commit({ y: Number(v) || 0 }, ms);
        timed(ms);
        return proxy;
      },
      rotate(value, ms) {
        // 相对旋转：在当前角度上累加，负数即反向旋转。
        commit({ rotation: state.rotation + Number(value || 0) }, ms);
        timed(ms);
        return proxy;
      },
      rotateTo(value, ms) {
        commit({ rotation: Number(value) || 0 }, ms);
        timed(ms);
        return proxy;
      },
      /** 沿 H 面（水平面）的圈转出画面：相对累加。 */
      rotateH(value, ms) {
        commit({ rotateH: state.rotateH + Number(value || 0) }, ms);
        timed(ms);
        return proxy;
      },
      /** 沿 V 面（正立面）的圈抬落：相对累加。 */
      rotateV(value, ms) {
        commit({ rotateV: state.rotateV + Number(value || 0) }, ms);
        timed(ms);
        return proxy;
      },
      rotateHTo(value, ms) {
        commit({ rotateH: Number(value) || 0 }, ms);
        timed(ms);
        return proxy;
      },
      rotateVTo(value, ms) {
        commit({ rotateV: Number(value) || 0 }, ms);
        timed(ms);
        return proxy;
      },
      scale(value, ms) {
        // 相对缩放：在当前倍率上相乘（与 stage.js 的 scale 语义一致）。
        commit({ scale: state.scale * Number(value || 1) }, ms);
        timed(ms);
        return proxy;
      },
      scaleTo(value, ms) {
        commit({ scale: Number(value) || 1 }, ms);
        timed(ms);
        return proxy;
      },
      crossFade(next, ms) {
        commit({ path: asText(next).trim(), opacity: 1 }, ms);
        timed(ms);
        return proxy;
      },
      name(value) {
        speaker = asText(value);
        return proxy;
      },
      /** 字体切换是即时的：一个名字同时作用于中文与西文。 */
      font(value) {
        state.fontFamily = asText(value).trim();
        commit({ fontFamily: state.fontFamily });
        return proxy;
      },
      /** 字重同样即时：CSS 数值刻度，400 是常规。 */
      weight(value = TEXT_FONT_WEIGHT) {
        state.fontWeight = textFontWeight("Text", value);
        commit({ fontWeight: state.fontWeight });
        return proxy;
      },
      // 与真舞台的角色 say 一样按类型读尾参：数字是 time，字符串是配音名。
      // 固定位置会把 `ch.say("文本", "vo")` 的配音读成时间而丢掉，进而误触发自动配音。
      say(value, ...rest) {
        const waiting = recordingStage.sayLine(speaker || null, asText(value), sayTiming(rest));
        context?.pending?.push(waiting);
        return proxy;
      },
      /** 续说：与角色 say 同形同参，接到当前这一句后面。 */
      csay(value, ...rest) {
        const waiting = recordingStage.csayLine?.(speaker || null, asText(value), sayTiming(rest));
        context?.pending?.push(waiting);
        return proxy;
      },
      duration() {
        return 0;
      },
      /** `step(n)` 定格到第 n 帧（1-based 取模）；0 或负数恢复自动播放。 */
      step(frame) {
        const n = Number(frame);
        commit({ frame: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 });
        return proxy;
      },
      front() {
        return proxy;
      },
      back() {
        return proxy;
      },
      rgb(dr, dg, db, ms) {
        setTint(addTint(state.tint, dr, dg, db), ms);
        return proxy;
      },
      rgbTo(r, g, b, ms) {
        setTint({ r: clampChannel(r), g: clampChannel(g), b: clampChannel(b) }, ms);
        return proxy;
      },
      hex(value, ms) {
        setTint(parseHex(value), ms);
        return proxy;
      },
      blur(value, ms) {
        setLook("blur", value, ms);
        return proxy;
      },
      brightness(value, ms) {
        setLook("brightness", value, ms);
        return proxy;
      },
      contrast(value, ms) {
        setLook("contrast", value, ms);
        return proxy;
      },
      saturate(value, ms) {
        setLook("saturate", value, ms);
        return proxy;
      },
      /**
       * 清除：按效果名把状态复原，写进时间线的是一次过渡（渲染时逐帧插值）。
       *
       * 名字与舞台的 `flush` 同一套（`flush(scale)`、`flush(rgb) @ 5000`），不写
       * 名字就是这一层的全部效果一起复原。时长不写就是立刻 —— 与舞台一样是
       * 「复原到原样」，不是一次默认时长的移动。
       */
      flush(...args) {
        // 与舞台一致：只有图片对象能清除，视频、特效与音频没有这个方法。
        if (kind !== "Background" && kind !== "Character" && kind !== "Text") {
          throw new Error(`${kind} 没有方法 flush`);
        }
        const asked = [];
        let time;
        for (const value of args) {
          if (typeof value === "number") {
            time = value;
            continue;
          }
          const name = methodNameOf(value);
          if (!name) {
            throw new Error(`${kind} 的 flush 需要不带引号的效果名，例如 flush(scale)`);
          }
          asked.push(name);
        }
        const home = kind === "Background" ? BACKGROUND_DEPTH : 0;
        // 能写进 `flush(…)` 的名字：别名也算，报错时列出的就是这一串。
        // 文字没有 SVG 调色，但四个滤镜是 CSS 的，与图片一样能复原。
        const known = [
          ...FLUSH_PLACE,
          "alpha",
          "hide",
          ...(isText ? FLUSH_TEXT : FLUSH_TINT),
          ...Object.keys(FLUSH_LOOK),
          ...(kind === "Character" ? ["transform"] : []),
        ];
        // 不写名字时复原的清单：每个状态只写一次，别名的重复不进来。
        const all = isText
          ? [...FLUSH_ALL_PLACE, ...FLUSH_TEXT, ...Object.keys(FLUSH_LOOK)]
          : [
              ...FLUSH_ALL_PLACE,
              ...FLUSH_TINT,
              ...Object.keys(FLUSH_LOOK),
              ...(kind === "Character" ? ["transform"] : []),
            ];
        const names = asked.length ? asked : all.map((english) => ({ english, written: english }));
        const patch = {};
        let look = state.look;
        let tinted = false;
        for (const { english, written } of names) {
          if (!known.includes(english)) {
            throw new Error(`${kind} 没有可清除的 ${written}（可用：${known.join("、")}）`);
          }
          if (english === "move" || english === "moveTo") {
            Object.assign(patch, { x: 0, y: 0, z: home });
          } else if (english === "x" || english === "h" || english === "xTo" || english === "hTo") {
            patch.x = 0;
          } else if (english === "y" || english === "v" || english === "yTo" || english === "vTo") {
            patch.y = 0;
          } else if (english === "z" || english === "zTo") {
            patch.z = home;
          } else if (english === "rotate" || english === "rotateTo") {
            patch.rotation = 0;
          } else if (english === "rotateH" || english === "rotateHTo") {
            patch.rotateH = 0;
          } else if (english === "rotateV" || english === "rotateVTo") {
            patch.rotateV = 0;
          } else if (english === "scale" || english === "scaleTo") {
            patch.scale = 1;
          } else if (english === "alpha" || english === "hide") {
            patch.opacity = 1;
          } else if (FLUSH_TINT.includes(english)) {
            tinted = true;
          } else if (english in FLUSH_LOOK) {
            look = withLook(look, english, FLUSH_LOOK[english], kind);
          } else if (english === "transform") {
            for (const point of TRANSFORM_POINTS) {
              patch[`mesh_${point}_dx`] = 0;
              patch[`mesh_${point}_dy`] = 0;
            }
          } else if (english === "color") {
            const rgb = rgbOf(DEFAULT_TEXT_COLOR);
            Object.assign(patch, { color: DEFAULT_TEXT_COLOR, colorIsRgb: Boolean(rgb) });
            if (rgb) {
              Object.assign(patch, { color_r: rgb.r, color_g: rgb.g, color_b: rgb.b });
            }
          } else if (english === "font") {
            patch.fontFamily = "";
          } else if (english === "weight") {
            patch.fontWeight = TEXT_FONT_WEIGHT;
          }
        }
        if (look !== state.look) {
          Object.assign(patch, {
            look,
            look_blur: look.blur,
            look_brightness: look.brightness,
            look_contrast: look.contrast,
            look_saturate: look.saturate,
          });
        }
        if (tinted) {
          Object.assign(patch, { tint: { r: 0, g: 0, b: 0 }, tint_r: 0, tint_g: 0, tint_b: 0 });
        }
        commit(patch, time);
        settle(time);
        return proxy;
      },
      play(ms) {
        timed(ms);
        return proxy;
      },
      stop(ms) {
        timed(ms);
        return proxy;
      },
      loop() {
        return proxy;
      },
      once() {
        return proxy;
      },
      pause() {
        return proxy;
      },
      mute() {
        return proxy;
      },
      volume() {
        return proxy;
      },
      speed() {
        return proxy;
      },
      speedTo() {
        return proxy;
      },
      size() {
        return proxy;
      },
      sizeTo() {
        return proxy;
      },
      density() {
        return proxy;
      },
      densityTo() {
        return proxy;
      },
      key(file, ms) {
        timed(ms);
        return proxy;
      },
    };
    // `show` / `hide` 是透明度过渡，与舞台同名方法一致：`show(ms)` 由当前透明度
    // 渐显到 1，`hide(ms)` 渐隐到 0。不能直接别名成 enable / disable —— 那两个只切
    // `visible`、从不碰透明度，会让 `ch.hide().enable().show(1500)` 在录制里直接落到
    // 不透明、完全没有渐变（导出成片里立绘瞬现，自动播放与导出表现一致）。
    record.show = (ms) => record.alpha(1, ms);
    record.hide = (ms) => record.alpha(0, ms);

    const transform = {};
    for (const point of TRANSFORM_POINTS) {
      const dxKey = `mesh_${point}_dx`;
      const dyKey = `mesh_${point}_dy`;
      // 相对拉动：在当前偏移上累加，并在 ms 内插值到新位置。cue 里同时启动的
      // 多个点各占一组属性，互不覆盖，与舞台 reshape 的语义一致。
      transform[point] = (dx, dy, ms) => {
        commit(
          {
            [dxKey]: state[dxKey] + (Number(dx) || 0),
            [dyKey]: state[dyKey] + (Number(dy) || 0),
          },
          ms,
        );
        timed(ms);
        return proxy;
      };
      // 绝对落点：与 stage.js::pointsOf 同一公式先算出该点在舞台上的初始
      // 位置（含 pose），再用脚本坐标减掉它，得到世界偏移。
      transform[point + "To"] = (x, y, ms) => {
        const base = meshBase(point);
        const radians = (state.rotation * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const lx = base.x * state.scale;
        const ly = base.y * state.scale;
        const startX = state.x + lx * cos + ly * sin;
        const startY = state.y - lx * sin + ly * cos;
        commit(
          {
            [dxKey]: (Number(x) || 0) - startX,
            [dyKey]: (Number(y) || 0) - startY,
          },
          ms,
        );
        timed(ms);
        return proxy;
      };
    }
    record.transform = transform;

    // --- 逐帧图片组：只有背景与角色有，与舞台同一套规则 ---
    //
    // 播放不往时间线上逐帧写记录：状态里留下列表、速度与起播时刻，渲染端按
    // 时间求值出这一帧该画哪一张。这样循环播放也不会把成片拖到无穷长。
    if (kind === "Background" || kind === "Character") {
      const groupAt = (elapsed) =>
        spriteFrameAt(elapsed, state.groupFps, state.group.length, state.groupLoop);

      /** 提交一份新的列表；时间线存的是副本，之后改列表不会改到过去。 */
      const setGroup = (next) => {
        state.group = next;
        commit({ group: [...next] });
      };

      Object.assign(record, {
        group(...pictures) {
          const next = pictures.map((picture) => spritePath(kind, picture));
          state.groupStart = clock.now();
          setGroup(next);
          commit({ path: next[0] ?? state.path, groupPlaying: false, groupFps: 0 });
          return proxy;
        },
        fps(value, loop) {
          const rate = spriteFrameRate(value);
          if (!state.group.length) {
            throw new Error(`${kind} 还没有设置 group，先写 group("…")`);
          }
          const at = Math.max(0, state.group.indexOf(state.path));
          state.groupStart = clock.now();
          commit({
            path: state.group[at],
            groupFps: rate,
            groupLoop: Boolean(loop),
            groupStart: state.groupStart,
            groupPlaying: true,
          });
          if (!loop) {
            // 一遍播完才轮到下一句，与舞台一致。循环播放不在成片里等待：等下去
            // 成片就没有结尾了，它会一直循环到 `pause` 或下一次播放接替。
            context?.pending?.push(clock.wait(((state.group.length - at) / rate) * 1000));
          }
          return proxy;
        },
        element(value) {
          return state.group[spriteIndex(state.group, value, "element")];
        },
        pause(value) {
          let next = state.path;
          if (value !== undefined && value !== null && value !== "") {
            const member =
              typeof value === "number" ||
              (typeof value === "string" && state.group.includes(value.trim()));
            next = member
              ? state.group[spriteIndex(state.group, value, "pause")]
              : spritePath(kind, value);
          } else if (state.groupPlaying && state.group.length) {
            // 不带参数：停在按时间算出来的那一张上，画面与舞台同一帧。
            next = state.group[groupAt(clock.now() - state.groupStart)] ?? state.path;
          }
          commit({ path: next, groupPlaying: false });
          return proxy;
        },
        add(value, picture) {
          const next = [...state.group];
          next.splice(spriteIndex(state.group, value, "add") + 1, 0, spritePath(kind, picture));
          setGroup(next);
          return proxy;
        },
        remove(value) {
          const next = [...state.group];
          next.splice(spriteIndex(state.group, value, "remove"), 1);
          setGroup(next);
          return proxy;
        },
        update(value, picture) {
          const next = [...state.group];
          const at = spriteIndex(state.group, value, "update");
          const before = next[at];
          next[at] = spritePath(kind, picture);
          setGroup(next);
          if (state.path === before) {
            commit({ path: next[at] });
          }
          return proxy;
        },
      });
    }

    // 文字改色与舞台同一个方法：只有 Text 有，图片与视频的画面没有 `color`，
    // 正如它们在舞台上也没有。
    if (isText) {
      record.color = (value, ms) => {
        const next = asText(value).trim();
        if (!next) {
          throw new Error('Text 的颜色需要文本，例如 "#ffffff"');
        }
        const rgb = rgbOf(next);
        // 通道写进 patch 而不是先改 state：`commit` 拿 state 里的旧值当插值
        // 起点，先改就成了「从新色渐变到新色」。
        const patch = { color: next, colorIsRgb: Boolean(rgb) };
        if (rgb) {
          patch.color_r = rgb.r;
          patch.color_g = rgb.g;
          patch.color_b = rgb.b;
        }
        commit(patch, ms);
        settle(ms);
        return proxy;
      };
    }

    // 这颗对象在时间线上的目标名，灯按这个名字排除它。不能叫 `key`：那是
    // 剧本里的关键帧方法（`bg.key("…")`），一个字符串字段会把它盖掉。
    record.timelineKey = target;
    // 两条控制子轨只有视频有。有录像器时 `attachVideo` 会用真正的播放头换掉
    // 这两个占位；没有时画面方法仍转给画面层，形状与播放器一致。
    if (kind === "Video") {
      const mediaOnly = {
        kind: "VideoMedia",
        enable: () => record.media,
        disable: () => record.media,
      };
      for (const name of VIDEO_MEDIA_PICTURE_METHODS) {
        if (typeof record[name] !== "function") {
          continue;
        }
        mediaOnly[name] = (...args) => {
          record[name](...args);
          return record.media;
        };
      }
      record.media = chainable(mediaOnly);
      record.audio = chainable({
        kind: "VideoAudio",
        enable: () => record.audio,
        disable: () => record.audio,
        play: () => record.audio,
        pause: () => record.audio,
        mute: () => record.audio,
        volume: () => record.audio,
        loop: () => record.audio,
        once: () => record.audio,
        speed: () => record.audio,
        speedTo: () => record.audio,
        duration: () => Promise.resolve(0),
      });
    }

    // 文字没有 SVG 调色：`hex` / `rgb` / `rgbTo` 在播放器里只挂在图片上。
    // 留着它们会让多义的「颜色」先命中 `hex`，与播放器解析成 `color` 不同。
    // 关键帧动画同理，播放器的 `Text` 也没有 `key`。
    if (isText) {
      delete record.hex;
      delete record.rgb;
      delete record.rgbTo;
      delete record.key;
    }
    // 交叉溶解只有背景有（见播放器的 `Background.crossFade`）。
    if (kind !== "Background") {
      delete record.crossFade;
    }

    const proxy = chainable(record);
    return proxy;
  }

  /**
   * `stage.exclude(光源… : 对象…)` 的录制端。
   *
   * 两个列表都必须有内容，与舞台同一条规则：撤销用 `unexclude`，不是留空。
   */
  const applyExclusion = (sources, targets, add) => {
    if (!Array.isArray(sources) || !sources.length) {
      throw new Error("排除至少需要一盏光源");
    }
    if (!Array.isArray(targets) || !targets.length) {
      throw new Error("排除至少需要一个对象");
    }
    for (const source of sources) {
      if (source?.kind !== "Light") {
        throw new Error("排除的冒号前面只能是光源");
      }
    }
    for (const source of sources) {
      source.exclude?.(targets, add);
    }
  };
  if (recordingStage) {
    recordingStage.exclude = (sources, targets) => applyExclusion(sources, targets, true);
    recordingStage.unexclude = (sources, targets) => applyExclusion(sources, targets, false);
  }

  const factory = (kind) => (args, context) => makeObject(kind, args, context);
  return {
    Background: factory("Background"),
    Character: factory("Character"),
    Text: factory("Text"),
    Audio: factory("Audio"),
    Effect: factory("Effect"),
    Video: factory("Video"),
    Light: (args, context) => makeLight(args, context),
    // 相机同样走 makeObject：播放器给每个对象都接了 crood / translucent / rim，
    // 少接这三个会让 `cam.crood(true)` 这种写法在导出里报「没有方法」。
    Camera: factory("Camera"),
  };
}

/** 交给 `run(program, { globals })` 的录制版本。 */
export function createRecordGlobals(session, options = {}) {
  // 声音录制器可以来自调用方（一次导出一个），也可以挂在 session 上。
  const audioRecorder = options.audioRecorder ?? session.audioRecorder ?? null;
  const videoRecorder = options.videoRecorder ?? session.videoRecorder ?? null;
  const recordingStage = createRecordingStage({
    clock: session.clock,
    timeline: session.timeline,
    config: { ...DEFAULT_RECORDING, ...options.config },
    onVoice: audioRecorder ? (name) => audioRecorder.audio.voice(name) : null,
    onSynth: audioRecorder
      ? (chars, speed) => audioRecorder.audio.autoVoice(chars, speed)
      : null,
    onVoiceDuration: options.onVoiceDuration ?? session.voiceDuration ?? null,
  });
  const objects = createRecordingObjects({
    clock: session.clock,
    timeline: session.timeline,
    recordingStage,
    config: { ...DEFAULT_RECORDING, ...options.config },
    assets: session.assets,
    audioRecorder,
    videoRecorder,
    // 网格基准恒为舞台的 1920×1080 逻辑空间，不随导出画幅缩放。
  });
  return createStageGlobals(recordingStage, objects);
}
