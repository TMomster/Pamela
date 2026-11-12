// 剧本编辑器的候选补全。
// Pamela — candidate suggestions for the script editor.
// 候选项只在语句起始位置给出，未声明的名称不推断。
/** Characters that may continue an identifier, matching the tokeniser's rule. */

import {
  BUILTIN_ALIASES,
  BUILTIN_GLOBALS,
  BUILTIN_METHODS,
  BULK_METHODS,
  englishNameFor,
} from "./pamela.js";

/** Characters that may continue an identifier, matching the tokeniser's rule. */
const IDENT_PART = /[\p{L}\p{N}_]/u;

/** A single digit, for telling a decimal point from a member access. */
const DIGIT = /[0-9]/;

/**
 * The closing mark of each Chinese quote that opens a string.
 *
 * A quote opened with one of these ends on its partner, exactly as the
 * tokeniser reads it, so a scan looking for a statement's start is not fooled
 * by prose that happens to sit inside a Chinese line.
 */
const QUOTE_CLOSERS = new Map([
  ["“", "”"],
  ["‘", "’"],
]);

/**
 * The head of a statement that binds a name: `name =`, at a statement's start.
 *
 * Where the statement begins is the whole question. `=` means two things in
 * this language: at the start of a statement it binds the name on its left,
 * while inside a call it names an argument — `Character("ch.png", x = 300)`.
 * The brackets are what tell them apart, so this is only ever asked once a
 * separator has been passed with none open (see `scanBindings`).
 *
 * `(?!=)` keeps `==` out: `if a == 1` binds nothing.
 */
const ASSIGNMENT_HEAD = /([\p{L}_][\p{L}\p{N}_]*)[ \t]*=(?!=)/uy;

/**
 * The head of a `for` loop, `for name in` — the one other statement that binds
 * a name of its own.
 *
 * The loop variable is bound where the loop runs, so a line after the loop can
 * read it back; inside the loop it is the name most worth offering.
 */
const FOR_HEAD = /for[ \t]+([\p{L}_][\p{L}\p{N}_]*)[ \t]+in(?![\p{L}\p{N}_])/uy;

/**
 * What a bound name was built from: a call, and the name it was called by.
 *
 * `hero = Character("x")` binds a character because of the name before the
 * bracket. A chain is the same call with its receiver written out, so the name
 * kept is the last one before the bracket — `bg = stage.Background(…)` is a
 * background. The full-width bracket is folded first by the tokeniser, so a
 * call typed on a Chinese keyboard is the same call here.
 */
const ASSIGNMENT_CALL =
  /(?:[\p{L}_][\p{L}\p{N}_]*[ \t]*\.[ \t]*)*([\p{L}_][\p{L}\p{N}_]*)[ \t]*[(（]/uy;

/** The leading name of a value: the type in `ch = Character 帕.png`, the alias in `b = a`. */
const ASSIGNMENT_NAME = /([\p{L}_][\p{L}\p{N}_]*)/uy;

/** The three words that read like names but are values of their own. */
const LITERAL_WORDS = new Set(["true", "false", "null"]);

/** Where a value turns out to be nothing but its own name: a separator, a brace, a note, the end. */
const VALUE_END = /[ \t\r]*(?=$|[\n;；}]|#|\/\/|\/\*)/uy;

/**
 * A function the script itself declares with `func`.
 *
 * The name is what gets offered back to the writer and the parameter list is
 * shown beside it, so a call is spelled the way the declaration asked for.
 *
 * The part before `func` is the tokeniser's own identifier rule: without it a
 * name ending in those four letters — `名字func` — would read as a declaration,
 * when the tokeniser sees one long name and no keyword at all.
 */
const FUNCTION_DECLARATION =
  /(?:^|[^\p{L}\p{N}_])func[ \t]+([\p{L}_][\p{L}\p{N}_]*)[ \t]*\(([^)]*)\)/gu;

/**
 * The methods both stage objects answer to.
 *
 * The list is kept alphabetical by label, because that is the order the
 * popup shows it in (see `suggest`): a writer who has seen `blur` offered knows
 * where to look for it next time, and a name added in the middle of the file
 * does not shuffle the list. The comment on each entry is what a writer needs
 * to know about the call, not a reason to group it with a neighbour.
 *
 * Shared by the entries below so the two cannot drift apart while they behave
 * the same.
 */
const STAGE_METHODS = [
  // 逐帧图片组：一组图、一个速度，组内可以增删改（见 `sprite-group.js`）。
  { label: "add", detail: "(位置, 图片) 在组内某张图之后插入一张新图，位置可写序号或图名" },
  { label: "alpha", detail: "(0–1, time) 设置透明度，超出范围夹取" },
  { label: "blur", detail: "(像素, time) 高斯模糊，0 为清晰；与另外三个滤镜叠加" },
  { label: "brightness", detail: "(倍率, time) 亮度，1 为原样，0 全黑" },
  { label: "contrast", detail: "(倍率, time) 对比度，1 为原样，0 为一片灰" },
  { label: "crood", detail: "(true/false) 显示或隐藏这个对象自己的三维坐标轴，默认隐藏" },
  { label: "element", detail: "(序号或图名) 取组里一张图的路径，序号从 0 起，可直接交给构造函数" },
  { label: "enable", detail: "() 显示到舞台" },
  { label: "fps", detail: "(每秒张数, 循环?) 播放图片组，1–144；默认播一遍，第二参 true 为循环" },
  { label: "group", detail: "(图片…) 把一组图片设成逐帧动画，画面停在第 1 张" },
  // HVD 的单轴写法：H 平轴（即 x）、V 升轴（即 y）。与 x / y 完全等价。
  { label: "h", detail: "(ΔH, time) 沿 H 平轴（即 x）相对移动：正数向右" },
  { label: "hTo", detail: "(H, time) 把绝对 H 坐标（即 x）设成 H" },
  { label: "hex", detail: "(hex, time) 用十六进制颜色设置滤镜，如 hex(\"FFFFFF\", 2000)" },
  { label: "hide", detail: "(time) 淡出：透明度降到 0，仍在舞台上" },
  // The key frame file is what `key()` plays. Naming it is optional — a call
  // with no argument plays the animation filed under the object's own name —
  // so the detail says both, and a writer who *has* a file in mind knows what
  // goes in the brackets.
  {
    label: "key",
    detail: "(文件名?) 播放关键帧动画；省略则播 data/key-<对象名>.keyframes",
  },
  { label: "move", detail: "(dx, dy, dz, time) 相对移动，dz 可省" },
  { label: "moveTo", detail: "(x, y, z, time) 移到舞台坐标，z 可省" },
  { label: "pause", detail: "(序号/图名/图片?) 暂停播放；省略停在当前帧，也可以停在组外的一张图" },
  { label: "remove", detail: "(序号或图名) 从图片组里移除一张；正在显示的那张仍留在画面上" },
  { label: "rgb", detail: "(r, g, b, time) 颜色通道相对偏移，0–255，超出部分省去" },
  { label: "rgbTo", detail: "(r, g, b, time) 颜色通道设为绝对值，0–255" },
  { label: "rim", detail: "(0–1) 轮廓光：逆光时贴着轮廓勾一圈光，默认 0 不勾" },
  { label: "rotate", detail: "(角度, time) 在 W 面里相对自转，负值逆时针" },
  { label: "rotateH", detail: "(角度, time) 沿 H 面（水平面）的圈转出画面：一侧朝观众转过来" },
  { label: "rotateHTo", detail: "(角度, time) 把 H 面的转角设到指定值" },
  { label: "rotateTo", detail: "(角度, time) 旋转到指定角度，负值逆时针" },
  { label: "rotateV", detail: "(角度, time) 沿 V 面（正立面）的圈抬落：顶边朝观众倒下来" },
  { label: "rotateVTo", detail: "(角度, time) 把 V 面的转角设到指定值" },
  { label: "saturate", detail: "(倍率, time) 饱和度，1 为原样，0 为黑白" },
  { label: "scale", detail: "(倍率, time) 相对缩放" },
  { label: "scaleTo", detail: "(倍率, time) 缩放到指定倍率，1.0 为原尺寸" },
  { label: "show", detail: "(time) 淡入：透明度回到 1" },
  { label: "step", detail: "(frame?) GIF 定格到第 frame 帧（从1起）；0或省略则恢复播放" },
  { label: "translucent", detail: "(true/false) 透光：光穿过它、灯不按深度把它挖成剪影；默认角色 false、其余 true" },
  { label: "update", detail: "(序号或图名, 新图片) 替换组里的一张，位置不变" },
  { label: "v", detail: "(ΔV, time) 沿 V 升轴（即 y）相对移动：正数向上" },
  { label: "vTo", detail: "(V, time) 把绝对 V 坐标（即 y）设成 V" },
  { label: "x", detail: "(ΔX, time) 沿 x 轴相对移动：正数向右" },
  { label: "xTo", detail: "(X, time) 把绝对 x 坐标设成 X，原点在中心、正数向右" },
  { label: "y", detail: "(ΔY, time) 沿 y 轴相对移动：正数向上" },
  { label: "yTo", detail: "(Y, time) 把绝对 y 坐标设成 Y，原点在中心、正数向上" },
  { label: "z", detail: "(ΔZ, time) 沿深度相对移动：正数更远更小，负数朝观众" },
  { label: "zTo", detail: "(Z, time) 把绝对深度设成 Z：0 是舞台平面，正数更远更小，负数朝观众" },
];

/** The members only a background has: dissolving one picture into another. */
const BACKGROUND_METHODS = [
  ...STAGE_METHODS,
  { label: "crossFade", detail: "(path, time) 交叉溶解到另一张图，旧图淡出后移除" },
];

/** The members only a character has: its place in the layer. */
const CHARACTER_ORDER_METHODS = [
  { label: "back", detail: "() 画到其他角色后面" },
  { label: "front", detail: "() 画到其他角色前面" },
];

/**
 * The eight points a character's free transform moves, and what each one is.
 *
 * `axis` is the one component an edge midpoint answers to: a corner drags both
 * of the box's edges, an edge drags one, and the axis a call ignores is the one
 * thing about these names a writer cannot guess from the name alone.
 */
const TRANSFORM_POINTS = [
  { point: "upleft", at: "左上角" },
  { point: "up", at: "上边中点", axis: "dy" },
  { point: "upright", at: "右上角" },
  { point: "right", at: "右边中点", axis: "dx" },
  { point: "downright", at: "右下角" },
  { point: "down", at: "下边中点", axis: "dy" },
  { point: "downleft", at: "左下角" },
  { point: "left", at: "左边中点", axis: "dx" },
];

/**
 * What `ch.transform.` offers: every point twice, following the language's
 * split between a relative call and an absolute one (`move` / `moveTo`).
 */
const TRANSFORM_METHODS = TRANSFORM_POINTS.flatMap(({ point, at, axis }) => [
  {
    label: point,
    detail: axis
      ? `(dx, dy, time) 相对移动${at}，仅 ${axis} 生效`
      : `(dx, dy, time) 相对移动${at}，对角固定`,
  },
  { label: `${point}To`, detail: `(x, y, time) 把${at}移到舞台坐标` },
]);

/**
 * The one member that is itself a set of members.
 *
 * `ch.transform.upleft(...)` reaches through two dots, so `methods` here is
 * what gets listed after the second one rather than a name a character answers
 * to directly (see `memberItems`).
 */
const TRANSFORM = {
  label: "transform",
  detail: ".<点> 自由变换，移动角点或边中点",
  methods: TRANSFORM_METHODS,
};

/**
 * The members a character speaks through.
 *
 * A character is also a speaker: `name` is what the plate above the line
 * reads, and `say` shows the line and waits for a click. They are the
 * dialogue half of the object, sitting beside the stage calls and the free
 * transform, and both answer the character so the calls chain.
 */
const SPEAKING_METHODS = [
  { label: "name", detail: "(姓名) 设置台词框显示的姓名" },
  { label: "say", detail: "(台词) 以这个角色说一句台词并等点击" },
];

/**
 * What a character answers to: the stage calls, the layer order, the dialogue
 * calls, and the free transform.
 */
const CHARACTER_METHODS = [
  // 抗锯齿：位图缩放时怎么取像素。默认关，所以这两条排在字母表最前面。
  { label: "aa", detail: "(0–2) 整张图的抗锯齿强度：0 关（硬边），越大越软，连内部一起柔化" },
  { label: "eaa", detail: "(0–2) 边缘抗锯齿：只柔化轮廓那一条过渡带，内部保持清晰；0 关" },
  ...STAGE_METHODS,
  ...CHARACTER_ORDER_METHODS,
  ...SPEAKING_METHODS,
  TRANSFORM,
];

/**
 * What a Text answers to.
 *
 * It shares the picture frame — place, turn, size, opacity — but not the
 * filters, key frames or layer order: those belong to a bitmap, and a Text has
 * none. The list is alphabetical like every other.
 */
const TEXT_METHODS = [
  { label: "alpha", detail: "(0–1, time) 设置透明度，超出范围夹取" },
  { label: "color", detail: '(颜色, time) 改文字颜色，任何 CSS 颜色如 "#ffd479"，可渐变' },
  { label: "crood", detail: "(true/false) 显示或隐藏这段文字自己的三维坐标轴，默认隐藏" },
  { label: "enable", detail: "() 把这段文字显示到舞台" },
  // HVD 的单轴写法：H 平轴（即 x）、V 升轴（即 y）。与 x / y 完全等价。
  { label: "h", detail: "(ΔH, time) 沿 H 平轴（即 x）相对移动这段文字" },
  { label: "hTo", detail: "(H, time) 把这段文字的绝对 H 坐标（即 x）设成 H" },
  { label: "font", detail: "(字体名) 设置字体，中文与西文一起生效；空串回到默认" },
  { label: "hide", detail: "(time) 淡出：透明度降到 0，文字仍占位" },
  { label: "move", detail: "(dx, dy, dz, time) 相对移动，dz 可省" },
  { label: "moveTo", detail: "(x, y, z, time) 移到舞台坐标，z 可省" },
  { label: "rotate", detail: "(角度, time) 在 W 面里相对自转，负值逆时针" },
  { label: "rotateH", detail: "(角度, time) 沿 H 面（水平面）的圈转出画面" },
  { label: "rotateHTo", detail: "(角度, time) 把 H 面的转角设到指定值" },
  { label: "rotateTo", detail: "(角度, time) 旋转到指定角度" },
  { label: "rotateV", detail: "(角度, time) 沿 V 面（正立面）的圈抬落" },
  { label: "rotateVTo", detail: "(角度, time) 把 V 面的转角设到指定值" },
  { label: "scale", detail: "(倍率, time) 相对缩放" },
  { label: "scaleTo", detail: "(倍率, time) 缩放到指定倍率，1.0 为原尺寸" },
  { label: "rim", detail: "(0–1) 轮廓光：逆光时贴着轮廓勾一圈光，默认 0 不勾；文字暂不在灯层里" },
  { label: "show", detail: "(time) 淡入：透明度回到 1" },
  { label: "translucent", detail: "(true/false) 透光：光穿过它、灯不按深度把它挖成剪影；文字默认透光" },
  { label: "v", detail: "(ΔV, time) 沿 V 升轴（即 y）相对移动这段文字" },
  { label: "vTo", detail: "(V, time) 把这段文字的绝对 V 坐标（即 y）设成 V" },
  { label: "weight", detail: "(字重) 设置字重：400 常规、700 粗体，范围 1–1000" },
  { label: "x", detail: "(ΔX, time) 沿 x 轴相对移动：正数向右" },
  { label: "xTo", detail: "(X, time) 把绝对 x 坐标设成 X，原点在中心、正数向右" },
  { label: "y", detail: "(ΔY, time) 沿 y 轴相对移动：正数向上" },
  { label: "yTo", detail: "(Y, time) 把绝对 y 坐标设成 Y，原点在中心、正数向上" },
  { label: "z", detail: "(ΔZ, time) 沿深度相对移动：正数更远更小，负数朝观众" },
  { label: "zTo", detail: "(Z, time) 把绝对深度设成 Z：0 是舞台平面，正数更远更小，负数朝观众" },
];

/**
 * What a light answers to.
 *
 * A light is not a picture: it has no source, so its first argument is the
 * colour it casts. Every number here is a property of the lamp itself, and
 * `direction` is the one call that writes two at once.
 */
const LIGHT_METHODS = [
  { label: "alpha", detail: "(0–1, time) 灯的作用系数：0 不亮，1 全亮" },
  { label: "bloom", detail: "(0–1, time) 泛光：打到对象轮廓上的辉光" },
  { label: "crood", detail: "(true/false) 显示或隐藏这盏灯自己的三维坐标轴，默认隐藏" },
  { label: "direction", detail: "(H 面角, V 面角, time) 一次写完两个转角" },
  { label: "disable", detail: "() 关掉这盏灯（参数保留）" },
  { label: "enable", detail: "() 把这盏灯打到画面上" },
  { label: "hex", detail: '(hex, time) 灯的颜色，如 hex("FFD9A0")' },
  // HVD 的单轴写法：H 平轴（即 x）、V 升轴（即 y）。与 x / y 完全等价。
  { label: "h", detail: "(ΔH, time) 沿 H 平轴（即 x）相对移动光源" },
  { label: "hTo", detail: "(H, time) 把光源的绝对 H 坐标（即 x）设成 H" },
  { label: "hide", detail: "(time) 渐出：作用系数降到 0" },
  { label: "intensity", detail: "(倍率, time) 强度：1 为正常，可过 1 叠出曝光感" },
  { label: "move", detail: "(dx, dy, dz, time) 相对移动光源位置，dz 可省" },
  { label: "moveTo", detail: "(x, y, z, time) 把光源移到舞台坐标，z 可省" },
  { label: "range", detail: "(距离, time) 最大传播距离（空间里的距离，灯自己的 z 也算在内）；负数无限远" },
  { label: "rgb", detail: "(r, g, b, time) 直接给灯的颜色（绝对色，不是偏移）" },
  { label: "rim", detail: "(0–1) 轮廓光：光源自己就是光，没有轮廓可勾；这个方法只为同名" },
  { label: "rotate", detail: "(角度, time) 画面里的转动：正数顺时针，90 度让朝右的光转为朝下，整盏灯连同光束一起转" },
  { label: "rotateH", detail: "(角度, time) H 面方位角：0 光束朝 +x（画面右），俯视顺时针 90 度正对镜头，看到圆形光斑" },
  { label: "rotateTo", detail: "(角度, time) 把这盏灯在画面里的转角设到指定角度" },
  { label: "rotateV", detail: "(角度, time) V 面抬落角：0 水平，正数低头（光束往 -y 压）" },
  { label: "show", detail: "(time) 渐入：作用系数回到 1" },
  { label: "soft", detail: "(0–1, time) 柔光：整块光斑的模糊程度" },
  { label: "spread", detail: "(1–360, time) 散射角：360 全向，越小越像一束聚光" },
  { label: "translucent", detail: "(true/false) 透光：光源自己不挡光，这个方法只为和其余对象同名" },
  { label: "v", detail: "(ΔV, time) 沿 V 升轴（即 y）相对移动光源" },
  { label: "vTo", detail: "(V, time) 把光源的绝对 V 坐标（即 y）设成 V" },
  { label: "width", detail: "(0–4000, time) 灯管长度：0 是点光，正数让灯本身变成一段发光体" },
  {
    label: "x",
    detail: "(ΔX, time) 沿 x 轴相对移动光源：正数向右",
  },
  {
    label: "xTo",
    detail: "(X, time) 把光源绝对 x 设成 X",
  },
  {
    label: "y",
    detail: "(ΔY, time) 沿 y 轴相对移动光源：正数向上",
  },
  {
    label: "yTo",
    detail: "(Y, time) 把光源绝对 y 设成 Y",
  },
  {
    label: "z",
    detail: "(ΔZ, time) 沿深度相对移动灯：正数更远、站到对象背后（光被前面的角色挡住），负数朝观众",
  },
  {
    label: "zTo",
    detail: "(Z, time) 把灯的绝对深度设成 Z：0 是舞台平面，正数在对象背后（会被它挡住），负数朝观众",
  },
];

/**
 * What a sound answers to.
 *
 * A sound is never waited for: each of these starts or changes something that
 * keeps going while the script reads the next line, so none of them blocks.
 */
const AUDIO_METHODS = [
  { label: "duration", detail: "() 这段音频的时长（毫秒）；元数据未就绪时最多等 2 秒，取不到给 0" },
  { label: "loop", detail: "() 循环播放：背景音乐" },
  { label: "once", detail: "() 只播一次：音效" },
  { label: "play", detail: "(time?) 从头播放，可淡入；不阻塞" },
  { label: "stop", detail: "(time?) 停止，可淡出；不阻塞" },
  { label: "volume", detail: "(0–1, time?) 设置音量，可渐变" },
];

/** A built-in effect: rain / snow, drawn by the engine rather than loaded. */
const EFFECT_METHODS = [
  { label: "alpha", detail: "(0–1, time?) 设置粒子画面透明度" },
  { label: "density", detail: "(倍率, time?) 相对改变粒子密度" },
  { label: "densityTo", detail: "(倍率, time?) 设置粒子密度，1.0 为标准" },
  { label: "disable", detail: "() 移除特效并停止绘制" },
  { label: "enable", detail: "() 重置粒子并开始播放特效" },
  { label: "hide", detail: "(time?) 渐出：透明度降到 0" },
  { label: "pause", detail: "() 暂停，保留粒子位置" },
  { label: "play", detail: "() 从暂停处继续" },
  { label: "scale", detail: "(倍率, time?) 相对缩放粒子画面" },
  { label: "scaleTo", detail: "(倍率, time?) 把粒子画面缩放到指定倍率" },
  { label: "show", detail: "(time?) 渐入：透明度回到 1" },
  { label: "size", detail: "(倍率, time?) 相对改变单个粒子尺寸" },
  { label: "sizeTo", detail: "(倍率, time?) 设置单个粒子尺寸" },
  { label: "speed", detail: "(倍率, time?) 相对改变动画速率" },
  { label: "speedTo", detail: "(倍率, time?) 设置动画速率，1.0 为原速" },
];

/** The picture half of a Video: `video.media.<method>`. */
const VIDEO_MEDIA_METHODS = [
  { label: "alpha", detail: "(0–1, time?) 设置画面透明度" },
  { label: "blur", detail: "(像素, time?) 高斯模糊，0 为清晰" },
  { label: "brightness", detail: "(倍率, time?) 亮度，1 为原样" },
  { label: "contrast", detail: "(倍率, time?) 对比度，1 为原样" },
  { label: "disable", detail: "() 隐藏画面，音频继续" },
  { label: "enable", detail: "() 显示画面" },
  { label: "hex", detail: "(hex, time?) 十六进制染色" },
  // HVD 的单轴写法：H 平轴（即 x）、V 升轴（即 y）。与 x / y 完全等价。
  { label: "h", detail: "(ΔH, time?) 沿 H 平轴（即 x）相对移动画面" },
  { label: "hTo", detail: "(H, time?) 把画面的绝对 H 坐标（即 x）设成 H" },
  { label: "hide", detail: "(time?) 画面渐出" },
  { label: "move", detail: "(dx, dy, dz, time?) 相对移动画面，dz 可省" },
  { label: "moveTo", detail: "(x, y, z, time?) 把画面移到舞台坐标，z 可省" },
  { label: "pause", detail: "() 暂停，保留播放位置" },
  { label: "play", detail: "() 从当前位置播放" },
  { label: "rgb", detail: "(r, g, b, time?) 颜色通道相对偏移" },
  { label: "rgbTo", detail: "(r, g, b, time?) 颜色通道设为绝对值" },
  { label: "rotate", detail: "(角度, time?) 相对旋转画面" },
  { label: "rotateH", detail: "(角度, time?) 沿 H 面（水平面）圈转出画面，相对" },
  { label: "rotateHTo", detail: "(角度, time?) 把 H 面的转角设到指定值" },
  { label: "rotateTo", detail: "(角度, time?) 把画面旋转到指定角度" },
  { label: "rotateV", detail: "(角度, time?) 沿 V 面（正立面）圈抬落，相对" },
  { label: "rotateVTo", detail: "(角度, time?) 把 V 面的转角设到指定值" },
  { label: "saturate", detail: "(倍率, time?) 饱和度，1 为原样" },
  { label: "scale", detail: "(倍率, time?) 相对缩放画面" },
  { label: "scaleTo", detail: "(倍率, time?) 把画面缩放到指定倍率" },
  { label: "show", detail: "(time?) 画面渐入" },
  { label: "speed", detail: "(倍率, time?) 相对改变播放速率" },
  { label: "speedTo", detail: "(倍率, time?) 设置播放速率，1.0 为原速" },
  { label: "v", detail: "(ΔV, time?) 沿 V 升轴（即 y）相对移动画面：正数向上" },
  { label: "vTo", detail: "(V, time?) 把画面的绝对 V 坐标（即 y）设成 V" },
  { label: "x", detail: "(ΔX, time?) 沿 x 轴相对移动画面：正数向右" },
  { label: "xTo", detail: "(X, time?) 把画面绝对 x 设成 X" },
  { label: "y", detail: "(ΔY, time?) 沿 y 轴相对移动画面：正数向上" },
  { label: "yTo", detail: "(Y, time?) 把画面绝对 y 设成 Y" },
  { label: "z", detail: "(ΔZ, time?) 沿深度相对移动画面：正数更远更小" },
  { label: "zTo", detail: "(Z, time?) 把画面绝对深度设成 Z：0 是舞台平面" },
];

/** The sound half of a Video: `video.audio.<method>`. */
const VIDEO_AUDIO_METHODS = [
  { label: "disable", detail: "() 静音音轨，画面继续" },
  { label: "duration", detail: "() 视频时长（毫秒）" },
  { label: "enable", detail: "() 启用音轨" },
  { label: "loop", detail: "() 循环播放" },
  { label: "mute", detail: "(true?) 静音；省略参数默认 true，mute(false) 解除" },
  { label: "once", detail: "() 只播一次" },
  { label: "pause", detail: "() 暂停，保留播放位置" },
  { label: "play", detail: "() 从当前位置播放" },
  { label: "speed", detail: "(倍率, time?) 相对改变播放速率" },
  { label: "speedTo", detail: "(倍率, time?) 设置播放速率" },
  { label: "volume", detail: "(0–1, time?) 设置音量，可渐变" },
];

/** The two namespaces a Video reaches through a second dot. */
const MEDIA_TRACK = {
  label: "media",
  detail: ".<方法> 画面轨：位置、缩放、变换与滤镜",
  methods: VIDEO_MEDIA_METHODS,
  namespace: true,
};

const AUDIO_TRACK = {
  label: "audio",
  detail: ".<方法> 声音轨：静音、音量、循环与时长",
  methods: VIDEO_AUDIO_METHODS,
  namespace: true,
};

/** What a Video answers to directly: both tracks, or one unambiguous owner. */
const VIDEO_METHODS = [
  AUDIO_TRACK,
  { label: "alpha", detail: "(0–1, time?) 画面透明度" },
  { label: "blur", detail: "(像素, time?) 高斯模糊" },
  { label: "brightness", detail: "(倍率, time?) 亮度" },
  { label: "contrast", detail: "(倍率, time?) 对比度" },
  { label: "crood", detail: "(true/false) 显示或隐藏这段画面自己的三维坐标轴，默认隐藏" },
  { label: "disable", detail: "() 两轨同时停用" },
  { label: "duration", detail: "() 视频时长（毫秒）" },
  { label: "enable", detail: "() 从头重播并同时启用两轨" },
  { label: "hex", detail: "(hex, time?) 十六进制染色" },
  // HVD 的单轴写法：H 平轴（即 x）、V 升轴（即 y）。与 x / y 完全等价。
  { label: "h", detail: "(ΔH, time?) 沿 H 平轴（即 x）相对移动画面" },
  { label: "hTo", detail: "(H, time?) 把画面的绝对 H 坐标（即 x）设成 H" },
  { label: "hide", detail: "(time?) 画面渐出" },
  { label: "loop", detail: "() 循环播放" },
  MEDIA_TRACK,
  { label: "move", detail: "(dx, dy, dz, time?) 相对移动画面，dz 可省" },
  { label: "moveTo", detail: "(x, y, z, time?) 把画面移到舞台坐标，z 可省" },
  { label: "mute", detail: "(true?) 静音；省略参数默认 true" },
  { label: "once", detail: "() 只播一次" },
  { label: "pause", detail: "() 暂停，保留播放位置" },
  { label: "play", detail: "() 从当前位置播放" },
  { label: "rgb", detail: "(r, g, b, time?) 颜色通道相对偏移" },
  { label: "rgbTo", detail: "(r, g, b, time?) 颜色通道设为绝对值" },
  { label: "rim", detail: "(0–1) 轮廓光：逆光时贴着画面轮廓勾一圈光，默认 0 不勾" },
  { label: "rotate", detail: "(角度, time?) 相对旋转画面" },
  { label: "rotateTo", detail: "(角度, time?) 把画面旋转到指定角度" },
  { label: "saturate", detail: "(倍率, time?) 饱和度" },
  { label: "scale", detail: "(倍率, time?) 相对缩放画面" },
  { label: "scaleTo", detail: "(倍率, time?) 把画面缩放到指定倍率" },
  { label: "show", detail: "(time?) 画面渐入" },
  { label: "speed", detail: "(倍率, time?) 相对改变播放速率" },
  { label: "speedTo", detail: "(倍率, time?) 设置播放速率" },
  { label: "translucent", detail: "(true/false) 透光：光穿过这段画面，灯不按深度把它挖成剪影；默认透光" },
  { label: "volume", detail: "(0–1, time?) 设置音量" },
  { label: "v", detail: "(ΔV, time?) 沿 V 升轴（即 y）相对移动画面：正数向上" },
  { label: "vTo", detail: "(V, time?) 把画面的绝对 V 坐标（即 y）设成 V" },
  { label: "x", detail: "(ΔX, time?) 沿 x 轴相对移动画面：正数向右" },
  { label: "xTo", detail: "(X, time?) 把画面绝对 x 设成 X" },
  { label: "y", detail: "(ΔY, time?) 沿 y 轴相对移动画面：正数向上" },
  { label: "yTo", detail: "(Y, time?) 把画面绝对 y 设成 Y" },
  { label: "z", detail: "(ΔZ, time?) 沿深度相对移动画面：正数更远更小" },
  { label: "zTo", detail: "(Z, time?) 把画面绝对深度设成 Z：0 是舞台平面" },
];

/**
 * What a group (`Array`) answers to.
 *
 * Only the two that change membership: everything else a group does is a
 * stage-wide call made on its members, and those are the stage's own names.
 * They are listed alphabetically like every other method list.
 */
const ARRAY_METHODS = [
  { label: "add", detail: "(对象…) 把对象加入组；已在组里的不会重复" },
  { label: "del", detail: "(对象…) 把对象移出组" },
  { label: "remove", detail: "(序号或对象…) 把成员移出组；数字按 0 起的顺序取" },
  { label: "update", detail: "(序号或旧成员, 新对象) 在原位置换掉一个成员，顺序不变" },
];

/** What the `dialog` global answers to, alphabetically like the rest. */
const DIALOG_METHODS = [
  { label: "disable", detail: "() 隐藏对话框" },
  { label: "enable", detail: "() 显示对话框" },
  { label: "say", detail: "(文本, 姓名?, 时长?, 配音?) 显示一句对话并等点击；省略姓名是旁白" },
];

/**
 * The names a script may use.
 *
 * `detail` is the signature and a short description, shown beside the name in
 * the list; `methods` are offered after a dot on a value built from it. `own`
 * marks the members that only that kind answers to, keeping them out of the
 * list offered when a receiver's kind cannot be worked out.
 */
export const COMPLETIONS = [
  {
    name: "Background",
    kind: "object",
    detail: "(source, x?, y?, scale?, scaleTo?, …) 背景图，可按参数名给；即 stage.Background(…)",
    methods: BACKGROUND_METHODS,
  },
  {
    name: "Character",
    kind: "object",
    detail: "(source, x?, y?, scale?, scaleTo?, name?) 角色图，可按参数名给；即 stage.Character(…)",
    methods: CHARACTER_METHODS,
  },
  {
    name: "Audio",
    kind: "object",
    detail: "(source, volume?, loop?) 声音：背景音乐或音效；即 stage.Audio(…)",
    methods: AUDIO_METHODS,
  },
  {
    name: "Effect",
    kind: "object",
    detail: '("rain" / "snow", scale?, size?, density?, speed?, alpha?) 引擎内置特效：下雨或下雪；即 stage.Effect(…)',
    methods: EFFECT_METHODS,
  },
  {
    name: "Video",
    kind: "object",
    detail: "(source, volume?, loop?, mute?) 视频；默认静音，分 media / audio 两轨；即 stage.Video(…)",
    methods: VIDEO_METHODS,
  },
  {
    name: "Text",
    kind: "object",
    detail: '(内容, x?, y?, size?, color?, …) 画面上的文字；换行写 \\n；即 stage.Text(…)',
    methods: TEXT_METHODS,
  },
  {
    name: "Light",
    kind: "object",
    detail: '(颜色?, 强度?, x?, y?, …) 光源：不读素材，enable 后打在画面上；即 stage.Light(…)',
    methods: LIGHT_METHODS,
  },
  {
    name: "Array",
    kind: "object",
    detail: "(对象…) 对象组：批量调用只需指向组，由 Pamela 分给每个成员；即 stage.Array(…)",
    // `own`: these two are answered by a group and by nothing else, so a
    // receiver whose kind cannot be worked out is not offered them.
    own: true,
    methods: ARRAY_METHODS,
  },
  // `str` turns a value into the text a line can show. The language converts
  // nothing on its own, so this is the one way across, and it is a name a
  // writer needs to find without being told about it.
  {
    name: "str",
    kind: "function",
    detail: "(值, 小数位数?) 把数字/布尔/空值变成文本，接进台词用",
  },
  // The narrator's line is a bare call rather than something built first, so
  // `say` is a name of its own and has no members for a dot to reach. It is the
  // same call as `stage.say` with the receiver left out.
  { name: "say", kind: "function", detail: "(text) 旁白：说一句台词并等点击；即 stage.say" },
  // `dialog` is not built either: it is there from the start, so `dialog.say`
  // reaches it without a variable in between. `global` says so — a name
  // matched by itself rather than through a variable, and one left out of the
  // list an unknown receiver falls back to.
  {
    name: "dialog",
    kind: "object",
    global: true,
    detail: ". 全局对话框",
    methods: DIALOG_METHODS,
  },
  // The stage owns the calls that belong to no object. It is not built either:
  // it comes into being with the stage and lives as long as it does, which is
  // why the narrator's line is properly `stage.say(…)` — and so is a type's
  // constructor: `Character(…)` is `stage.Character(…)` with the receiver left
  // out. The constructors are marked `fullOnly`: a shorthand line never writes
  // `stage Character …`, so they are offered after a dot, not after a space.
  {
    name: "stage",
    kind: "object",
    global: true,
    detail: ". 全局舞台：类型构造、无接收者的调用，以及替多个对象一起调用",
    methods: [
      { label: "Background", fullOnly: true, detail: "(source, …) 建背景图；等同 Background(…)" },
      { label: "Character", fullOnly: true, detail: "(source, …) 建角色图；等同 Character(…)" },
      { label: "Audio", fullOnly: true, detail: "(source, …) 建声音；等同 Audio(…)" },
      { label: "Effect", fullOnly: true, detail: '("rain" / "snow", …) 建内置特效；等同 Effect(…)' },
      { label: "Video", fullOnly: true, detail: "(source, …) 建视频；等同 Video(…)" },
      { label: "Text", fullOnly: true, detail: '(内容, x?, y?, size?, color?, …) 建文字；等同 Text(…)' },
      { label: "Light", fullOnly: true, detail: '(颜色?, 强度?, x?, y?, …) 建光源；等同 Light(…)' },
      { label: "Array", fullOnly: true, detail: "(对象…) 建对象组；等同 Array(…)" },
      { label: "ambient", detail: "(0–2) 环境亮度：画面整体的乘算亮度，1 为原样" },
      { label: "perspective", detail: "(true/false) 空间透视：默认关闭（正交空间，深度只分前后）；打开后近大远小" },
      { label: "guideline", detail: "(true/false, 间隔?) 空间参考线：每 100 坐标一条，间隔最小 10；无透视时只有横纵线，透视下每个深度截面各一圈" },
      {
        label: "exclude",
        detail: "(光源… : 对象…) 这些灯不照这些对象；两组都不能空，撤销用 unexclude",
      },
      { label: "unexclude", detail: "(光源… : 对象…) 撤销同一组排除" },
      { label: "say", detail: "(text, time?, audio?) 旁白：说一句台词并等点击" },
      { label: "click", detail: "(time?) 创建点击位置并等待：非自动模式等点击，自动/导出模式等 time 毫秒" },
      { label: "auto", detail: "(time?) 无点击位置的计时等待，用于控制自动模式的等待时长" },
      { label: "autoVoice", detail: "(开/速度?) 自动配音：没有显式 audio 的 say 自动配一段合成音；0 或 false 关闭" },
      { label: "pamela", detail: "() 播放约 3 秒的 Pamela 开场动画：黑幕淡入、图标左移、展开 Made with Pamela、整体淡出" },
      // The stage speaks for a set of objects: one line sets up the whole
      // scene instead of repeating the call per character. The objects go after
      // a colon when the fixed parameters are cut short — `stage.scale(2.0 : ch, bg)`.
      { label: "enable", detail: "(对象…) 让每个对象显示到舞台，等于逐个 enable" },
      { label: "show", detail: "(对象…) 对每个对象淡入" },
      { label: "hide", detail: "(对象…) 对每个对象淡出" },
      { label: "scale", detail: "(倍率, time? : 对象…) 对每个对象缩放；冒号可跳过 time" },
      { label: "scaleTo", detail: "(倍率, time? : 对象…) 把每个对象缩放到同一倍率" },
      { label: "alpha", detail: "(值, time? : 对象…) 对每个对象设透明度" },
      { label: "blur", detail: "(像素, time? : 对象…) 对每个对象设模糊" },
      { label: "brightness", detail: "(倍率, time? : 对象…) 对每个对象设亮度" },
      { label: "contrast", detail: "(倍率, time? : 对象…) 对每个对象设对比度" },
      { label: "saturate", detail: "(倍率, time? : 对象…) 对每个对象设饱和度" },
      { label: "rgb", detail: "(r, g, b, time? : 对象…) 对每个对象做颜色通道偏移" },
      { label: "rgbTo", detail: "(r, g, b, time? : 对象…) 把每个对象的颜色通道设为绝对值" },
      { label: "move", detail: "(dx, dy, dz, time? : 对象…) 一起相对移动" },
      { label: "moveTo", detail: "(x, y, z, time? : 对象…) 一起移到同一坐标" },
      { label: "rotate", detail: "(角度, time? : 对象…) 一起旋转；负值逆时针" },
      { label: "rotateTo", detail: "(角度, time? : 对象…) 一起转到同一角度" },
      { label: "front", detail: "(对象…) 一起移到最前" },
      { label: "back", detail: "(对象…) 一起移到最后" },
      { label: "play", detail: "(对象…) 对每个声音/视频/特效播放" },
      { label: "stop", detail: "(对象…) 对每个声音停止" },
      { label: "loop", detail: "(对象…) 对每个声音/视频循环播放" },
      { label: "once", detail: "(对象…) 对每个声音/视频只播一次" },
      { label: "pause", detail: "(对象…) 对每个视频/特效/图片组暂停" },
      { label: "mute", detail: "(true? : 对象…) 对每个视频静音；省略即 true，mute(false) 解除" },
      { label: "speed", detail: "(倍率, time? : 对象…) 对每个视频/特效改变速率" },
      { label: "speedTo", detail: "(倍率, time? : 对象…) 把每个视频/特效的速率设为指定值" },
      { label: "size", detail: "(倍率, time? : 对象…) 对每个特效改变粒子尺寸" },
      { label: "sizeTo", detail: "(倍率, time? : 对象…) 把每个特效的粒子尺寸设为指定值" },
      { label: "density", detail: "(倍率, time? : 对象…) 对每个特效改变粒子密度" },
      { label: "densityTo", detail: "(倍率, time? : 对象…) 把每个特效的粒子密度设为指定值" },
    ],
  },
];

/**
 * The words the language itself reserves.
 *
 * They are offered beside the objects because a writer reaches for them in the
 * same place, at the start of a statement, and a name not declared in the script may
 * as well not be in the language.
 */
const KEYWORDS = [
  { label: "cue", detail: "(毫秒) 语句 或 { ... }：块内语句同时开始；cue(毫秒) 或块后 wait 毫秒决定多久后继续" },
  { label: "func", detail: "名字(参数) { ... } 定义函数，用名字(实参) 调用" },
  { label: "if", detail: "条件 { ... }；条件必须是布尔值，可接 else / else if" },
  { label: "while", detail: "条件 { ... } 条件为真时重复执行块内语句" },
  { label: "for", detail: "变量 in 集合 { ... } 遍历列表/字典/文本的每个元素" },
  { label: "switch", detail: "值 { case 值 { ... } default { ... } } 按值多分支选择" },
  { label: "break", detail: "立刻离开所在的循环" },
  { label: "continue", detail: "跳过本轮剩下的语句，直接开始下一轮" },
  { label: "wait", detail: "毫秒数 暂停一会儿（也可写 wait(毫秒)）；写在 cue 块 } 后面则决定块后多久继续，不带毫秒数即等整块结束" },
  { label: "choice", detail: '{ 标签表达式 { ... } ... } 让玩家选一项，选中分支的语句才执行' },
  { label: "include", detail: '"路径" 在该处演出另一个脚本文件（裸名从 scripts/ 取）' },
  { label: "use", detail: '("模板路径") 运行时切换对话框样式（如心声框）；路径可为变量/拼接/函数结果' },
  { label: "jump", detail: '("路径") 结束当前脚本并从该文件顶端重新开始运行（场景跳转）；路径可为变量/拼接/函数结果' },
  { label: "else", detail: "{ ... } 或 if ...：if 条件不成立时走这里" },
  { label: "return", detail: "[值] 从函数返回，省略即返回空值" },
  { label: "true", detail: "布尔真" },
  { label: "false", detail: "布尔假" },
  { label: "null", detail: "空值" },
];

/** Words that open a statement of the full syntax rather than a shorthand call. */
const STATEMENT_KEYWORDS = new Set([...KEYWORDS.map(({ label }) => label), "case", "default"]);

/** Every member once, for a receiver whose object cannot be worked out. */
function everyMethod() {
  const seen = new Map();
  for (const object of COMPLETIONS) {
    // A global is reached by its own name and never through a receiver, and a
    // name such as `say` is a call on its own: neither has members this list
    // should carry. An `own` entry — the group — is marked for the same reason:
    // its members are answered by that kind alone, and a receiver the script
    // cannot be asked about is far more likely a picture than a group.
    if (object.global || object.own || !object.methods) {
      continue;
    }
    for (const method of object.methods) {
      // A track namespace is read as a member (`v.media`), not called; `transform`
      // is still listed because a script can call `ch.transform` to reach it.
      if (method.namespace) {
        continue;
      }
      if (!seen.has(method.label)) {
        seen.set(method.label, method);
      }
    }
  }
  return [...seen.values()];
}

/**
 * The members a dot at `dot` should offer, in `text` with the caret at `at`.
 *
 * A plain `hero.` lists the object's own members. `hero.transform.` reaches one
 * level deeper — the name before the dot is a namespace and the name before
 * *that* one is the variable it hangs off — so that name's own members are what
 * gets listed instead.
 *
 * Which object a variable was built from is only read when the script spells it
 * out, so a receiver that cannot be worked out answers with every member at
 * once: a name whose owner is unknown is still better offered than withheld.
 */
function memberItems(text, dot, at) {
  const member = nameBefore(text, dot);
  const outerDot = member ? dot - member.length - 1 : -1;

  if (outerDot >= 0 && text[outerDot] === ".") {
    const base = COMPLETIONS.find(
      (object) => object.name === assignments(text, at).get(nameBefore(text, outerDot)),
    );
    const nested = (base?.methods ?? everyMethod()).find(
      (method) => method.label === member && method.methods,
    );
    if (nested) {
      return nested.methods;
    }
  }

  // A variable is looked up through what the script bound it from — `hero` was
  // built by `Character`, so `hero.` lists a character's members. A global
  // (`dialog`) is not a variable and is matched by its own name instead,
  // under either spelling: `舞台.` is `stage.`.
  const english = BUILTIN_ALIASES.get(member) ?? member;
  const owner =
    COMPLETIONS.find((object) => object.name === assignments(text, at).get(member)) ??
    COMPLETIONS.find(
      (object) => object.global && (object.name === member || object.name === english),
    );
  return owner?.methods ?? everyMethod();
}

// --- shorthand (.mpe) context ---

/**
 * The stage-wide calls a shorthand statement may open with, in both spellings.
 *
 * `enable ch bg` is `stage.enable(ch, bg)`: the stage is left out, so these
 * names belong at the start of a line even though the full syntax would only
 * reach them after a dot. The details come from the stage's own method list
 * where it has one, so the two lists cannot describe the same call differently.
 */
function bulkItems() {
  const stage = COMPLETIONS.find((object) => object.name === "stage");
  const details = new Map((stage?.methods ?? []).map((method) => [method.label, method.detail]));
  const fallback = (params) => `(${params.join(", ")} : 对象…) 舞台批量调用`;
  const items = [];
  for (const [name, params] of Object.entries(BULK_METHODS)) {
    items.push({
      label: name,
      kind: "method",
      detail: `省略 stage：${details.get(name) ?? fallback(params)}`,
    });
  }
  for (const [chinese, english] of BUILTIN_ALIASES) {
    if (!Object.hasOwn(BULK_METHODS, english)) continue;
    items.push({
      label: chinese,
      kind: "method",
      detail: `省略 舞台：${details.get(english) ?? fallback(BULK_METHODS[english])}`,
    });
  }
  return items;
}

/**
 * The stage's own calls as a statement may open with them.
 *
 * `guideline(true)` is `stage.guideline(true)` with the receiver left out: the
 * interpreter answers a bare name from the stage when no variable shadows it,
 * so these belong among the names a line starts with and not only after a dot.
 * The details are the stage's own, so the two lists cannot describe one call
 * differently.
 */
function bareStageItems() {
  const methods = stageMethods();
  const items = methods.map((method) => ({
    label: method.label,
    kind: "method",
    detail: `省略 stage：${method.detail}`,
  }));
  for (const [chinese, english] of BUILTIN_ALIASES) {
    const method = methods.find((entry) => entry.label === english);
    if (method && !items.some((item) => item.label === chinese)) {
      items.push({ label: chinese, kind: "method", detail: `省略 舞台：${method.detail}` });
    }
  }
  return items;
}

/** The stage's own calls, as they are written after `stage` in a shorthand line. */
function stageMethods() {
  // A constructor is reached with brackets in the full syntax, never as the
  // `stage <method> <arguments>` shorthand, so it is left out of this list.
  return (COMPLETIONS.find((object) => object.name === "stage")?.methods ?? []).filter(
    (method) => !method.fullOnly,
  );
}

/**
 * A method list with the interpreter's Chinese spellings beside each name:
 * `小帕 缩放` is as much a call as `ch scale`.
 */
function shorthandMethodItems(methods) {
  const items = methods.map(methodItem);
  for (const [chinese, english] of BUILTIN_ALIASES) {
    const method = methods.find((entry) => entry.label === english);
    if (method && !items.some((item) => item.label === chinese)) {
      items.push({ label: chinese, kind: "method", detail: method.detail });
    }
  }
  return items;
}

/** The methods a shorthand receiver answers to, from what the script built it with. */
function methodsOf(receiver, variables) {
  const owner =
    COMPLETIONS.find((object) => object.name === variables.get(receiver)) ??
    COMPLETIONS.find(
      (object) => object.global && (object.name === receiver || object.name === englishNameFor(receiver)),
    );
  return (owner?.methods ?? everyMethod()).filter((method) => !method.fullOnly);
}

/**
 * The objects a stage-wide call may name, as variable candidates.
 *
 * Only a name bound from a name is offered: `hp = 87` or `title = "字"` binds a
 * value of its own, and a stage-wide call has nothing to do with it. What is
 * left is either an object or a result the script cannot be asked about, and
 * the second is far more likely an object than the first is.
 */
function objectItems(variables) {
  return [...variables]
    .filter(([, type]) => type)
    .map(([name, type]) => ({
      label: name,
      kind: "variable",
      detail: COMPLETIONS.some((object) => object.name === type) ? `${type} 变量` : "变量",
    }));
}

/**
 * Where the last chain dot of `text` is, or `-1`.
 *
 * A chain dot stands by itself — `2.0` and `ch1.png` are words — so the last
 * dot of the line is a chain dot exactly when it has whitespace on both sides.
 * Everything left of it is a call already written.
 *
 * @param {string} text
 * @returns {number}
 */
function chainPointAt(text) {
  const at = text.lastIndexOf(".");
  if (at < 0) {
    return -1;
  }
  const before = at === 0 ? " " : text[at - 1];
  const after = at + 1 >= text.length ? " " : text[at + 1];
  return /\s/.test(before) && /\s/.test(after) ? at : -1;
}

/**
 * Which part of a shorthand statement the word at `start` is being written in.
 *
 * `.mpe` writes `target method arguments…` with spaces where the full syntax
 * would put a dot and brackets. `shorthandCallIn` reads a *finished* line; this
 * reads the complete words to the left of the caret, so a method or an object
 * can be offered while it is still being typed.
 *
 * @returns {{ kind: "head" | "stage" | "objects" | "method", head: string } | null}
 */
function shorthandContext(text, start, at) {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const before = text.slice(lineStart, start).trimStart();
  // A dot on its own ends the call written to its left; that call, and not the
  // dot, is what the word being typed belongs to.
  const chainAt = chainPointAt(before);
  const scope = chainAt < 0 ? before : before.slice(0, chainAt);
  // Brackets, a quote, an assignment or a comment belong to the full syntax (or
  // to prose), and so does a dot glued to a word — `hero.scale`. A standalone
  // dot is the chain's own, and the call before it is still the shorthand's.
  if (
    /[()[\]{}"'=]/.test(scope) ||
    /\/\/|\/\*|#/.test(scope) ||
    (chainAt < 0 && /[\p{L}_][\p{L}\p{N}_]*\s*\./u.test(scope))
  ) {
    return null;
  }
  const words = scope.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [];
  if (!words.length) {
    // A dot with nothing to the left of it names no receiver to ask.
    return chainAt < 0 ? { kind: "head", head: "" } : null;
  }
  const head = words[0];
  const headName = englishNameFor(head);
  if (STATEMENT_KEYWORDS.has(headName)) {
    return null;
  }
  const verb = words[1] ?? "";
  const verbName = verb ? englishNameFor(verb) : "";
  // `. move 0 -300`: another method of the receiver the line began with — the
  // object a constructor built, the object a method was made on, or the stage a
  // stage-wide call was made on.
  if (chainAt >= 0) {
    if (headName === "stage") {
      return { kind: "stage", head };
    }
    const stageWide =
      Object.hasOwn(BULK_METHODS, headName) && !(verb && BUILTIN_METHODS.has(verbName));
    return stageWide ? { kind: "stage", head: "stage" } : { kind: "method", head };
  }
  if (headName === "stage") {
    if (!verb) return { kind: "stage", head };
    // `stage say …` is prose; only the stage-wide calls go on to name objects.
    return Object.hasOwn(BULK_METHODS, verbName) ? { kind: "objects", head } : null;
  }
  // `enable ch bg`: every word after the method is an object to act on. This is
  // the shorthand that leaves `stage` out, and the reason the method itself has
  // to be offered at the start of a line.
  if (Object.hasOwn(BULK_METHODS, headName)) {
    return { kind: "objects", head };
  }
  if (BUILTIN_GLOBALS.has(headName)) {
    // `背景 教室.png` takes free text. A global that answers calls (`dialog`)
    // still takes a method in the second place.
    const globalObject = COMPLETIONS.find((object) => object.global && object.name === headName);
    return globalObject?.methods && !verb ? { kind: "method", head } : null;
  }
  // `ch sca` is `ch.scale(…)` in the making: the receiver's own methods.
  return verb ? null : { kind: "method", head };
}

/**
 * The candidates worth offering at `caret` in `source`.
 *
 * The caret is either at the end of a name — the constructors, the keywords,
 * the functions the script declared and the variables it bound so far are
 * listed — or just after a dot, where the methods of that value are listed
 * instead. The object is worked out from
 * the variable's own binding when the script makes it obvious, and from every
 * object at once otherwise. A dot after a namespace (`hero.transform.`) lists
 * that namespace's own members, one level deeper.
 *
 * In a shorthand (`.mpe`) script the words are separated by spaces instead of
 * a dot: a stage-wide method with the stage left out (`enable ch bg`) is offered
 * at the start of a line, `stage ena` offers the stage's methods, and the words
 * after either offer the objects the script has built.
 *
 * @param {string} source The script as it currently reads.
 * @param {number} caret Offset of the insertion point.
 * @param {{ shorthand?: boolean }} [options] `shorthand` for a `.mpe` file.
 * @returns {{ items: Array<object>, start: number, end: number } | null}
 *   The names and the span they would replace, or `null` when there is nothing
 *   to offer.
 */
export function suggest(source, caret, { shorthand = false } = {}) {
  const text = String(source ?? "");
  const at = Number.isFinite(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length;

  // Nothing is offered inside a comment or a string: those are prose and paths,
  // and a name inserted there would be a mistake.
  if (!isCode(text, at)) {
    return null;
  }

  const start = wordStart(text, at);
  const prefix = text.slice(start, at);
  const dot = memberDot(text, start);
  const context = shorthand && dot < 0 ? shorthandContext(text, start, at) : null;
  const variables = assignments(text, at, shorthand);

  let items;
  if (dot >= 0) {
    items = memberItems(text, dot, at).map(methodItem);
  } else if (context?.kind === "stage") {
    items = shorthandMethodItems(stageMethods());
  } else if (context?.kind === "objects") {
    items = objectItems(variables);
  } else if (context?.kind === "method") {
    items = shorthandMethodItems(methodsOf(context.head, variables));
  } else {
    // A bare name is completed only once something has been typed, so the list
    // does not open on every keystroke of an empty position. The contexts above
    // are the shorthand's equivalents of a dot, so they do open on a space.
    if (!prefix) {
      return null;
    }
    items = nameItems(
      variables,
      declaredFunctions(text, at),
      // A statement may open with any of the stage's calls: the receiver is
      // what a line leaves out, not what makes the call legal. The shorthand's
      // own list comes first so its wordings keep precedence.
      context?.kind === "head" ? [...bulkItems(), ...bareStageItems()] : bareStageItems(),
    );
  }

  const matched = items.filter((item) => matches(item.label, prefix));
  if (!matched.length) {
    return null;
  }
  // Alphabetical, case-insensitively, which is what the writer asked for: the
  // list is a reference they scan for a name they half-remember, and a stable
  // order they can learn is worth more than a ranking they cannot see. The
  // tables above are kept in the same order, so a name is where the list says
  // it is even before the sort runs — the sort is what holds them to it.
  //
  // A tie — the same name reached twice, which a variable shadowing a keyword
  // can produce — falls back to the declaration order, so the list does not
  // reshuffle between keystrokes.
  matched.sort((a, b) => {
    const left = a.label.toLowerCase();
    const right = b.label.toLowerCase();
    if (left !== right) {
      return left < right ? -1 : 1;
    }
    return 0;
  });
  return { items: matched, start, end: at };
}

/**
 * Replaces the span a suggestion was found for with `label`.
 *
 * @param {string} source
 * @param {{ start: number, end: number }} range The span `suggest` reported.
 * @param {string} label The chosen name.
 * @returns {{ text: string, caret: number }} The new text and where the caret
 *   belongs after it.
 */
export function applyCompletion(source, range, label) {
  const text = String(source ?? "");
  const start = Math.max(0, Math.min(range?.start ?? 0, text.length));
  const end = Math.max(start, Math.min(range?.end ?? start, text.length));
  return {
    text: `${text.slice(0, start)}${label}${text.slice(end)}`,
    caret: start + label.length,
  };
}

/** Names a writer may start a statement with: the objects, the keywords, the functions the script declared, the variables it bound, and any extra names the dialect allows at a line's start. */
function nameItems(variables, functions, extra = []) {
  const items = COMPLETIONS.map((object) => ({
    label: object.name,
    kind: object.kind,
    detail: object.detail,
  }));
  for (const keyword of KEYWORDS) {
    items.push({ label: keyword.label, kind: "keyword", detail: keyword.detail });
  }
  const taken = new Set(items.map((item) => item.label));
  for (const [name, params] of functions) {
    if (taken.has(name)) {
      continue;
    }
    taken.add(name);
    items.push({ label: name, kind: "function", detail: `(${params}) 脚本函数` });
  }
  for (const [name, type] of variables) {
    if (taken.has(name)) {
      continue;
    }
    taken.add(name);
    items.push({
      label: name,
      kind: "variable",
      detail: COMPLETIONS.some((object) => object.name === type) ? `${type} 变量` : "变量",
    });
  }
  for (const item of extra) {
    if (taken.has(item.label)) {
      continue;
    }
    taken.add(item.label);
    items.push(item);
  }
  return items;
}

/** @returns {{ label: string, kind: string, detail: string }} */
function methodItem(method) {
  return { label: method.label, kind: "method", detail: method.detail };
}

/** Whether a candidate is worth showing for what has been typed so far. */
function matches(label, prefix) {
  return label.toLowerCase().startsWith(prefix.toLowerCase());
}

/** Where the name being completed begins, which is the caret when it is empty. */
function wordStart(text, at) {
  let start = at;
  while (start > 0 && IDENT_PART.test(text[start - 1])) {
    start -= 1;
  }
  return start;
}

/**
 * The dot a name is being completed after, or `-1`.
 *
 * A dot that ends a number belongs to it — `move(1.` — rather than to a member
 * access. What tells the two apart is where the run of name characters before
 * the dot starts: an identifier may not begin with a digit, so `1` is a number
 * and `ch1` is a name. Reading only the character beside the dot would leave
 * `ch1.` and `ay1.` unanswered, which is every name a scene numbers.
 */
function memberDot(text, start) {
  if (start === 0 || text[start - 1] !== ".") {
    return -1;
  }
  let run = start - 1;
  while (run > 0 && IDENT_PART.test(text[run - 1])) {
    run -= 1;
  }
  return run < start - 1 && DIGIT.test(text[run]) ? -1 : start - 1;
}

/** The name immediately before `dot`, or `null` when there is not one. */
function nameBefore(text, dot) {
  let start = dot;
  while (start > 0 && IDENT_PART.test(text[start - 1])) {
    start -= 1;
  }
  return start === dot ? null : text.slice(start, dot);
}

/**
 * The whole-script scan, cached across calls.
 *
 * `assignments` and `declaredFunctions` are each called once per keystroke by
 * `suggest`, and the original spelling scanned `text.slice(0, at)` with a
 * `matchAll` every time — the longer the script, the slower the key. Both read
 * the same thing, though: the names the script binds and the `func`
 * declarations it makes before the caret. So the script is scanned once here,
 * the matches kept in ending-position order, and the two callers just take the
 * slice `end <= at`.
 *
 * Every binding is looked for, not only the ones made by a constructor: a
 * script that says `hp = 87` or `alias = hero` has a name a later line may
 * want back, and the list is the only place it would be found.
 *
 * The cache is keyed by the whole `text`. Moving the caret within a script
 * reuses it without rescanning — the common case — while a single edit rescans
 * once, which still sits well under a frame's budget for a few-thousand-line
 * script. This is the incremental layer: a per-line split could rescan only the
 * changed line later, behind the same interface, if profiling ever asks for it.
 *
 * @type {{ text: string | null, matches: Array<{ end: number, name: string, value: string, leading: string, kind: "assign" | "function" }> }}
 */
const declarationCache = { text: null, matches: [] };

/** Scans `text` once, returning its bindings and declarations by end position. */
function scanDeclarations(text) {
  if (text === declarationCache.text) {
    return declarationCache.matches;
  }
  const matches = [];
  scanBindings(text, matches);
  for (const match of text.matchAll(FUNCTION_DECLARATION)) {
    // The parameters are shown on one line, so a list split over several is
    // folded up rather than carrying its newlines into the list.
    matches.push({
      end: match.index + match[0].length,
      name: match[1],
      value: match[2].replace(/\s+/g, " ").trim(),
      leading: "",
      kind: "function",
    });
  }
  // Sorted by where each ends, so a caller wanting everything up to `at` can
  // walk the list and stop once `end` passes the caret.
  matches.sort((left, right) => left.end - right.end);
  declarationCache.text = text;
  declarationCache.matches = matches;
  return matches;
}

/**
 * Adds every name a statement binds to `matches`.
 *
 * The walk follows the tokeniser's own separators, cut down to what a binding
 * needs: strings and notes are stepped over (a name written in one is prose),
 * `(` and `[` are counted because a newline inside them is layout rather than a
 * separator, and every other separator — a newline, `;`, a block's brace —
 * starts a statement. Only at such a start can `=` be an assignment; anywhere
 * else it names an argument (`Character("ch.png", x = 300)`, `Video(…, mute =
 * false)`), and a name read from there would be a variable no line can read.
 *
 * Like the rest of this scan it is a hint rather than a scope: a name bound in
 * a branch that never runs is still a better suggestion than none. What it does
 * respect is where the language puts statements, because that is what keeps an
 * argument's name out of the list.
 *
 * @param {string} text
 * @param {Array<object>} matches The list the bindings are appended to.
 */
function scanBindings(text, matches) {
  let index = 0;
  // Whether the offset is the first character of a statement, and how many
  // brackets are open around it.
  let atStatement = true;
  let open = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === "\n" || char === ";" || char === "；" || char === "{" || char === "}") {
      // A newline inside a bracket breaks the line, not the statement.
      atStatement = char !== "\n" || open === 0;
      index += 1;
      continue;
    }

    if (char === " " || char === "\t" || char === "\r" || char === "\uFEFF") {
      index += 1;
      continue;
    }

    // A note is the author's, not the script's: what it says about a name is
    // not a binding. Stopping at the newline lets that separator be counted.
    if (char === "#" || (char === "/" && text[index + 1] === "/")) {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }

    if (char === '"' || char === "'" || QUOTE_CLOSERS.has(char)) {
      index = stringEnd(text, index);
      atStatement = false;
      continue;
    }

    if (char === "(" || char === "[" || char === "（") {
      open += 1;
      atStatement = false;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "）") {
      open = Math.max(0, open - 1);
      atStatement = false;
      index += 1;
      continue;
    }

    if (atStatement) {
      const binding = bindingAt(text, index);
      if (binding) {
        matches.push(binding);
        // The value was read by `bindingAt`; resuming after the head keeps the
        // brackets of the call — and a list spread over several lines — counted.
        index = binding.end;
        atStatement = false;
        continue;
      }
    }

    atStatement = false;
    index += 1;
  }
}

/**
 * The name the statement starting at `index` binds, or `null` when it binds none.
 *
 * Two forms are read: `name = value`, and the loop variable of `for name in`.
 * A `func` declaration has a scan of its own, so it is not asked about here.
 *
 * The binding counts from the end of its head — the `=` or the `in` — so a name
 * is offered as soon as the script is done naming it, even while its value is
 * still being typed.
 *
 * @param {string} text
 * @param {number} index
 * @returns {{ end: number, name: string, value: string, leading: string, kind: "assign" } | null}
 */
function bindingAt(text, index) {
  ASSIGNMENT_HEAD.lastIndex = index;
  const assigned = ASSIGNMENT_HEAD.exec(text);
  if (assigned) {
    const end = index + assigned[0].length;
    const { value, leading } = boundValue(text, end);
    return { end, name: assigned[1], value, leading, kind: "assign" };
  }

  FOR_HEAD.lastIndex = index;
  const looped = FOR_HEAD.exec(text);
  if (looped) {
    // A loop variable is whatever the collection holds: the script cannot say
    // what it is until it runs, so no kind is claimed for it.
    return {
      end: index + looped[0].length,
      name: looped[1],
      value: "",
      leading: "",
      kind: "assign",
    };
  }

  return null;
}

/**
 * What the value after `=` was built from, as `{ value, leading }`.
 *
 * `value` is the name a whole right side stands on: a call (`Character(…)`),
 * which names its kind before the bracket, or a binding copied from another
 * (`alias = hero`). It is empty for a value that is its own thing — a number, a
 * string, a list, a longer expression — and such a name is offered but claims
 * no kind, since there is none to claim.
 *
 * `leading` is the first name of the value whatever follows it, because the
 * shorthand dialect writes a call without brackets (`ch = Character 帕.png`)
 * and the scan cannot see a call there — only the name in front of the
 * arguments. A reader that knows the file is a shorthand one uses it.
 *
 * @param {string} text
 * @param {number} start Offset just past the `=`.
 * @returns {{ value: string, leading: string }}
 */
function boundValue(text, start) {
  let at = start;
  while (text[at] === " " || text[at] === "\t") {
    at += 1;
  }

  ASSIGNMENT_CALL.lastIndex = at;
  const called = ASSIGNMENT_CALL.exec(text);
  if (called) {
    const name = englishNameFor(called[1]);
    return { value: name, leading: name };
  }

  ASSIGNMENT_NAME.lastIndex = at;
  const named = ASSIGNMENT_NAME.exec(text);
  // `true` / `false` / `null` read like names but are values of their own.
  if (!named || LITERAL_WORDS.has(named[1])) {
    return { value: "", leading: "" };
  }
  const name = englishNameFor(named[1]);
  // `b = a` copies a binding, so its name is the whole value; `x = a + 1` only
  // starts with one, and a name is not a sum.
  VALUE_END.lastIndex = at + named[0].length;
  return { value: VALUE_END.test(text) ? name : "", leading: name };
}

/**
 * Where the string opening at `start` ends: the offset after its closing quote,
 * after the newline that cuts it short, or at the end of the text.
 *
 * The rules are the tokeniser's: an escape carries the character after it, the
 * string closes on its own quote (a Chinese quote on its partner mark), and a
 * newline ends it as well — which is what keeps one stray quote from turning
 * the rest of the script into prose.
 *
 * @param {string} text
 * @param {number} start Offset of the opening quote.
 * @returns {number}
 */
function stringEnd(text, start) {
  const quote = text[start];
  const closer = QUOTE_CLOSERS.get(quote) ?? quote;
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (char === closer || char === quote || char === "\n") {
      return index;
    }
  }
  return text.length;
}

/**
 * The variables bound before `at`, keyed by name, valued by what built them.
 *
 * The value is the name a binding was built from — `Character` for
 * `hero = Character(…)` — or empty when the right side is a value of its own.
 * A `shorthand` script takes the leading name of the value as well, because
 * `ch = Character 帕.png` is a constructor call without brackets, and the names
 * it binds are exactly the objects a stage-wide call (`enable ch bg`) names.
 */
function assignments(text, at, shorthand = false) {
  const found = new Map();
  for (const match of scanDeclarations(text)) {
    if (match.kind !== "assign" || match.end > at) {
      continue;
    }
    found.set(match.name, shorthand && !match.value ? match.leading : match.value);
  }
  return resolveBindings(found);
}

/**
 * Settles a binding made from another binding: `alias = hero` is whatever
 * `hero` is, not a kind called `hero`.
 *
 * A pair that names each other (`a = b` / `b = a`) settles on "no kind" rather
 * than walking the loop forever, and a name that is not a binding of its own —
 * a constructor, or a call the script wrote — stays as it is.
 *
 * @param {Map<string, string>} found Mutated in place.
 * @returns {Map<string, string>}
 */
function resolveBindings(found) {
  for (const [name, type] of [...found]) {
    if (!found.has(type)) {
      continue;
    }
    const walked = new Set([name]);
    let current = type;
    while (found.has(current) && !walked.has(current)) {
      walked.add(current);
      current = found.get(current);
    }
    found.set(name, walked.has(current) ? "" : current);
  }
  return found;
}

/**
 * The functions the script declared with `func` before `at`, keyed by name and
 * valued by their parameter list.
 *
 * Nothing is hoisted in the language, so a declaration only counts from the
 * line it is written on — the same reason `assignments` looks at the text
 * before the caret alone. Like that one, this is a flat scan and a hint rather
 * than a real scope: a declaration inside a block that never runs is still a
 * better name to offer than none.
 */
function declaredFunctions(text, at) {
  const found = new Map();
  for (const match of scanDeclarations(text)) {
    if (match.kind !== "function" || match.end > at) {
      continue;
    }
    found.set(match.name, match.value);
  }
  return found;
}

/**
 * Whether the offset sits in code rather than in a comment or a string.
 *
 * The whole text before the caret is walked rather than just its line, because
 * a block comment covers whatever it spans and a caret inside one may be
 * several lines below the pair of characters that opened it. The walk is in
 * step with the tokeniser: `#` and `//` end at the newline, a string ends there
 * too, and a block comment runs until it is closed — or, when it never is, to
 * the end.
 */
function isCode(text, at) {
  let quote = null;
  let block = false;

  for (let index = 0; index < at; index += 1) {
    const char = text[index];

    if (block) {
      if (char === "*" && text[index + 1] === "/") {
        block = false;
        index += 1;
      }
      continue;
    }

    if (char === "\n") {
      // Neither a string nor a line comment outlives the line it began on.
      quote = null;
      continue;
    }

    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" || (char === "/" && text[index + 1] === "/")) {
      const end = text.indexOf("\n", index);
      if (end < 0 || end >= at) {
        // The comment still covers the caret: nothing after it is code.
        return false;
      }
      index = end;
    } else if (char === "/" && text[index + 1] === "*") {
      block = true;
      index += 1;
    }
  }

  return quote === null && !block;
}

// --- editor wiring ---

/** Keys that move the caret without producing an `input` event. */
const CARET_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Shows suggestions while a script is typed.
 *
 * The list is drawn on demand and only ever mirrors `suggest`; it never edits
 * the script itself. Accepted names are spliced in through `applyCompletion`,
 * which the caller's `onChange` then hears about like any other edit — a
 * programmatic write fires no `input` event of its own.
 *
 * A list belongs to the caret it was opened at. Moving that caret by hand —
 * a click, an arrow key, a selection — dismisses it, and no repaint left over
 * from the last keystroke may bring it back; only a further edit can.
 *
 * @param {object} options
 * @param {HTMLTextAreaElement} options.textarea The script editor.
 * @param {() => void} [options.onChange] Runs after a suggestion is accepted.
 * @param {() => boolean} [options.isShorthand] Whether the open file is `.mpe`.
 * @returns {{ refresh: () => void, reposition: () => void, close: () => void,
 *   dismiss: () => void, handleKey: (event: KeyboardEvent) => boolean }}
 */
export function createCompletion({ textarea, onChange = () => {}, isShorthand = () => false }) {
  const popup = createPopup();
  document.body.append(popup.element);

  /** The span the open list would replace, or `null` when none is open. */
  let range = null;
  /** The caret the open list was built for. */
  let anchor = null;
  /** Set when the user leaves that caret; only an edit may open the list again. */
  let dismissed = false;

  const close = () => {
    range = null;
    popup.close();
  };

  /** Hides the list and keeps it hidden until the script is edited again. */
  const dismiss = () => {
    dismissed = true;
    close();
  };

  /**
   * An edit moves the caret as a side effect: that is the same word being
   * continued, not the user walking away from the list.
   */
  const noteEdit = () => {
    dismissed = false;
    anchor = textarea.selectionStart ?? 0;
  };

  /** Called whenever the caret may have been moved by hand. */
  const caretMoved = () => {
    if (dismissed) {
      return;
    }
    if (textarea.selectionStart === anchor && textarea.selectionEnd === anchor) {
      return;
    }
    dismiss();
  };

  const refresh = () => {
    // A repaint left over from typing must not reopen the list at a caret the
    // user has since left by hand.
    if (dismissed) {
      close();
      return;
    }
    // A selection is not an insertion point, so there is no name to complete.
    if (textarea.selectionStart !== textarea.selectionEnd) {
      dismiss();
      return;
    }
    const caret = textarea.selectionStart ?? 0;
    // Without this, a caret that moved without an edit would leave a list and
    // a `range` behind that splice the name into the wrong place on Enter.
    if (popup.isOpen() && caret !== anchor) {
      dismiss();
      return;
    }

    const found = suggest(textarea.value, caret, {
      shorthand: Boolean(isShorthand()),
    });
    if (!found) {
      close();
      return;
    }

    range = { start: found.start, end: found.end };
    anchor = caret;
    const point = caretPoint(textarea);
    popup.open(found.items, point.x, point.y, point.lineHeight);
  };

  const accept = () => {
    const item = popup.selected();
    if (!item || !range) {
      close();
      return;
    }
    const applied = applyCompletion(textarea.value, range, item.label);
    textarea.value = applied.text;
    textarea.setSelectionRange(applied.caret, applied.caret);
    close();
    onChange();
  };

  /**
   * Consumes the keys the open list owns.
   *
   * Anything with a modifier is left alone, so shortcuts such as Ctrl+Enter
   * keep working while the list is up.
   */
  const handleKey = (event) => {
    if (!popup.isOpen() || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return false;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      popup.move(event.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return true;
    }
    // These move the caret without an edit. Dismiss on the keydown itself, so
    // the list leaves with the caret instead of one key release later.
    if (CARET_KEYS.has(event.key)) {
      dismiss();
    }
    return false;
  };

  /**
   * Re-anchors an open list.
   *
   * Typing at the bottom of the editor scrolls it, which moves the caret on
   * screen without changing the text: the list has to follow rather than be
   * dismissed by the scroll it caused itself. A closed list stays closed, so a
   * plain scroll never opens one.
   */
  const reposition = () => {
    if (popup.isOpen()) {
      refresh();
    }
  };

  // Typing moves the caret as part of editing, so it is not a dismissal. Every
  // other way of moving it — a click, an arrow key, a selection, or a
  // `setSelectionRange` from elsewhere — is: the list belongs to the word that
  // was being typed, not to wherever the caret has wandered since.
  textarea.addEventListener?.("input", noteEdit);
  for (const name of ["click", "keyup", "select", "selectionchange"]) {
    textarea.addEventListener?.(name, caretMoved);
  }
  // Some engines only report a moved selection on the document. Another
  // field's selection is not the editor's caret; its `blur` deals with that.
  document.addEventListener?.("selectionchange", () => {
    if (document.activeElement && document.activeElement !== textarea) {
      return;
    }
    caretMoved();
  });

  return { refresh, reposition, close, dismiss, handleKey };
}

/** The list element the suggestions are drawn into. */
function createPopup() {
  const element = document.createElement("div");
  element.className = "completion";
  element.setAttribute("role", "listbox");
  element.hidden = true;

  const list = document.createElement("div");
  list.className = "completion__list";
  element.append(list);

  let items = [];
  let active = 0;

  const rows = () => [...list.children];

  const highlight = () => {
    rows().forEach((row, index) => {
      row.classList.toggle("is-active", index === active);
      row.setAttribute("aria-selected", String(index === active));
    });
  };

  /**
   * Brings the highlighted row into the list's own view.
   *
   * The popup is the element that scrolls — it is anchored to the caret and the
   * document behind it never moves — so the offset is read off the row and
   * written to this element rather than handed to `scrollIntoView`, which would
   * also scroll whichever ancestors it happened to find. The row is only moved
   * when it has left the view, so the list remains fixed until the highlight
   * reaches an edge.
   */
  const reveal = () => {
    const row = rows()[active];
    if (!row) {
      return;
    }
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  };

  return {
    element,

    isOpen: () => !element.hidden,

    selected: () => items[active] ?? null,

    close() {
      element.hidden = true;
      list.replaceChildren();
      items = [];
      active = 0;
    },

    /** Draws `next`, anchored at the caret `x`, `y` in viewport pixels. */
    open(next, x, y, lineHeight) {
      items = next;
      active = 0;
      list.replaceChildren(...items.map(createRow));
      // The rows are new, so the offset the last list was left at no longer
      // means anything: without this the top of a reopened list is cut off.
      element.scrollTop = 0;
      highlight();

      // Placed after mounting, so the list's own size is known and it can flip
      // back from the window edges rather than spilling off them.
      element.hidden = false;
      const rect = element.getBoundingClientRect();
      const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
      const below = y + lineHeight;
      const top =
        below + rect.height > window.innerHeight - 4
          ? Math.max(4, y - rect.height)
          : below;
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    },

    move(offset) {
      if (!items.length) {
        return;
      }
      active = (active + offset + items.length) % items.length;
      highlight();
      reveal();
    },
  };
}

/** One row of the list: the name, and what it does beside it. */
function createRow(item) {
  const row = document.createElement("div");
  row.className = `completion__item completion__item--${item.kind}`;
  row.setAttribute("role", "option");

  const name = document.createElement("span");
  name.className = "completion__name";
  name.textContent = item.label;

  const detail = document.createElement("span");
  detail.className = "completion__detail";
  detail.textContent = item.detail ?? "";

  row.append(name, detail);
  return row;
}

/**
 * Where the caret sits, in viewport pixels, with the line height beside it.
 *
 * The textarea does not wrap (`wrap="off"`), so a caret is a line and a column.
 * The column is measured by rendering the text before the caret in the same
 * font rather than multiplied out by a character width, which is what keeps a
 * tab from pushing the list away from the caret.
 */
function caretPoint(textarea) {
  const styles = getComputedStyle(textarea);
  const value = textarea.value;
  const caret = textarea.selectionStart ?? value.length;
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;

  let line = 0;
  for (let index = 0; index < caret; index += 1) {
    if (value[index] === "\n") {
      line += 1;
    }
  }

  const fontSize = Number.parseFloat(styles.fontSize) || 13;
  const measured = Number.parseFloat(styles.lineHeight);
  const lineHeight = Number.isFinite(measured) ? measured : fontSize * 1.6;
  const rect = textarea.getBoundingClientRect();

  return {
    x:
      rect.left +
      (Number.parseFloat(styles.paddingLeft) || 0) +
      textWidth(styles, value.slice(lineStart, caret)) -
      textarea.scrollLeft,
    y:
      rect.top +
      (Number.parseFloat(styles.paddingTop) || 0) +
      line * lineHeight -
      textarea.scrollTop,
    lineHeight,
  };
}

/**
 * The width `text` occupies in the editor's font.
 *
 * A hidden span is kept in the document for this: measuring through the layout
 * engine is the only way to size a string the way the textarea will.
 */
function textWidth(styles, text) {
  if (!ruler) {
    ruler = document.createElement("span");
    ruler.setAttribute("aria-hidden", "true");
    Object.assign(ruler.style, {
      position: "fixed",
      top: "0",
      left: "0",
      visibility: "hidden",
      whiteSpace: "pre",
      pointerEvents: "none",
    });
    document.body.append(ruler);
  }

  Object.assign(ruler.style, {
    fontFamily: styles.fontFamily,
    fontSize: styles.fontSize,
    fontWeight: styles.fontWeight,
    fontStyle: styles.fontStyle,
    letterSpacing: styles.letterSpacing,
    tabSize: styles.tabSize,
  });
  ruler.textContent = text;
  const width = ruler.getBoundingClientRect().width;
  ruler.textContent = "";
  return width;
}

/** The hidden span `textWidth` measures with, created on first use. */
let ruler = null;
