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
import { PARAM_SPECS, boolArg } from "./pamela.js";
import { PAMELA_INTRO_MS } from "./pamela-intro.js";
import {
  AUTOVOICE_DEFAULT_SPEED,
  AUTOVOICE_MIN_SPEED,
  AUTOVOICE_MAX_SPEED,
} from "./voice-effect.js";
import { BACKGROUND_DEPTH, clampDepth } from "./space.js";
import { createStageGlobals } from "./stage.js";
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

const TRANSFORM_POINTS = [
  "upleft", "upright", "downleft", "downright",
  "up", "down", "left", "right",
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

/** 一句台词的停留时长：显式 time 优先，否则按字数给玩家阅读时间。 */
export function holdFor(line, timing, config = DEFAULT_RECORDING) {
  const explicit = Number(timing?.time);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const length = [...asText(line)].length;
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
}) {
  const settings = { ...DEFAULT_RECORDING, ...config };
  // `stage.autoVoice(...)` 在导出里落在这里：开启后，没有显式配音的台词
  // 由 `onSynth` 登记一段合成效果音（见 `sayLine`）；参数可带播放速度（次/秒）。
  // 随演出（录制器重建）重置。
  let autoVoiceOn = false;
  let autoVoiceSpeed = AUTOVOICE_DEFAULT_SPEED;
  return {
    setVisible(visible) {
      addSet(timeline, clock.now(), "dialogue", { visible: Boolean(visible) });
    },
    /** @returns {Promise<void>|undefined} 被 push 进 context.pending 的等待。 */
    sayLine(name, line, timing = {}) {
      const t = clock.now();
      const length = [...asText(line)].length;
      if (timing.audio) {
        // 显式配音优先：按变量名登记一次播放，由混音器排进成片。
        onVoice?.(timing.audio);
      } else if (autoVoiceOn) {
        // 自动配音：没有显式配音时按字数登记一段合成效果音，并带上当前速度。
        onSynth?.(length, autoVoiceSpeed);
      }
      const hold = holdFor(line, timing, settings);
      const reveal = Math.min(settings.typewriterMs, Math.max(0, hold - 100));
      addSet(timeline, t, "dialogue", {
        name: asText(name),
        text: asText(line),
        revealed: 0,
        visible: true,
      });
      if (length > 0 && reveal > 0) {
        addTween(timeline, t, t + reveal, "dialogue", "revealed", 0, length, {
          quantize: "floor",
        });
      }
      return clock.wait(hold);
    },
    choose(labels) {
      return Promise.resolve(labels?.length ? 0 : -1);
    },
    /**
     * `stage.click(time)` / `stage.auto(time)` 在导出里只占时长：没有玩家来
     * 点击，点击标记也不进画面，唯一的职责是把虚拟时钟推进 `time` 毫秒。
     */
    clickWait(time) {
      return clock.wait(Number(time) || 0);
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
    autoWait(time) {
      return clock.wait(Number(time) || 0);
    },
    /**
     * `stage.pamela()` 在成片里照常占 3 秒：时间线记下开始时刻，逐帧渲染按
     * 同一份 `pamelaIntroState()` 把黑幕、图标与文字画上去，到点再登记关闭。
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
     * 所以它和舞台上一样只作用于画面，不作用于对话盒。
     */
    setAmbient(value) {
      const next = Math.min(2, Math.max(0, Number(value)));
      if (!Number.isFinite(next)) {
        throw new Error("环境亮度需要 0–2 的数字");
      }
      addSet(timeline, clock.now(), "ambient", { value: next });
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

/** 未知方法一律返回自身，让脚本里的链式调用不会炸；但不伪装成 thenable。 */
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
      return () => proxy;
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

  /**
   * 视频把两条记录拼起来：画面照旧走时间线（位置、透明度、显隐），
   * 播放头与声音交给 `videoRecorder`，两个记录共用同一条时间轴。
   */
  function attachVideo(picture, sound) {
    const baseEnable = picture.enable;
    const baseDisable = picture.disable;
    const reveal = () => baseEnable();
    const hide = () => baseDisable();

    picture.enable = () => {
      reveal();
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

    // 画面轨：显隐自己答，播放、暂停与速率交给播放头。
    const media = chainable({
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
    });
    // 滤镜与调色写在画面上，media 轨上的调用转给整层记录。
    for (const name of ["blur", "brightness", "contrast", "saturate", "rgb", "rgbTo", "hex"]) {
      media[name] = (...args) => {
        picture[name](...args);
        return media;
      };
    }
    picture.media = media;
    return picture;
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

    function commit(patch, ms = 0) {
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
      key: target,
      enable() {
        commit({ visible: true });
        return light;
      },
      disable() {
        commit({ visible: false });
        return light;
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
          const key = object?.key;
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
      commit(
        {
          look: state.look,
          look_blur: state.look.blur,
          look_brightness: state.look.brightness,
          look_contrast: state.look.contrast,
          look_saturate: state.look.saturate,
        },
        ms,
      );
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
      enable() {
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
            opacity: state.opacity,
            crood: state.crood,
            lightPass: state.lightPass,
            rim: state.rim,
          });
        } else {
          // 构造参数写下的位置、深度、三个转角与缩放也要落到时间线上：
          // 舞台那边 `enable()` 会把它们整套应用一次，成片要和预览一致。
          commit({
            visible: true,
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
        return proxy;
      },
      disable() {
        commit({ visible: false });
        return proxy;
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
        timed(ms);
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
      say(line, ms, audio) {
        const waiting = recordingStage.sayLine(speaker || null, asText(line), {
          time: Number(ms) || 0,
          audio: typeof audio === "string" ? audio : null,
        });
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
    record.show = record.enable;
    record.hide = record.disable;

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

    // 这颗对象在时间线上的目标名。灯按这个名字排除它，所以与 `target` 同一份。
    record.key = target;
    record.media = chainable({ kind: "VideoMedia", enable: () => record.media, disable: () => record.media });
    record.audio = chainable({ kind: "VideoAudio", play: () => record.audio, pause: () => record.audio });

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
