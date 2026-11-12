// 可视化编程画布：节点式剧本编辑器。
// Visual programming canvas — a ComfyUI-style node editor for Pamela.
// 定义连线与流程步骤分离；一个块只有一个出口。

import { createHistory, record, undo as histUndo, redo as histRedo, canUndo as histCanUndo, canRedo as histCanRedo } from "./history.js";
import { graphFromPamela } from "./map-parse.js";
import { attachCombo, createSelect } from "./select.js";
import { createIcon } from "./icons.js";
import {
  METHOD_SPECS,
  behaviorNodeKeys,
  behaviorSuffix,
  callNodeKeys,
  globalCallName,
  methodParams,
  methodTypes,
  nodeTitleFor,
  paramControl,
} from "./api-spec.js";

// --- geometry ---

/** Width of a leaf node. Containers size themselves instead. */
export const NODE_W = 210;
/** Header band of a leaf: its title and delete button. */
export const HEADER_H = 28;
/** Space above the first socket row, and below the last. */
export const PORTS_TOP = 6;
/** Vertical distance between two socket rows. */
export const PORT_ROW_H = 20;
/** A blank row between the exec band and the data band. */
export const PORT_GAP = 1;
/** The rail at the bottom of an object card that its behaviours hang from. */
export const DOCK_H = 6;
/**
 * The seam between the rail and the first behaviour, and between two of them.
 * It is zero: the cards meet on their own solid borders, so the connection is
 * a drawn outline rather than a strip of transparent canvas showing through.
 */
export const BEHAVIOR_GAP = 0;

/** Header band of a container: its title, its condition, and its sockets. */
export const CONTAINER_HEAD_H = 52;
/** The band naming a container's lanes (成立 / 否则 / 选项一 …). */
export const CONTAINER_LANE_HEAD_H = 28;
/** Space kept between a container's edge and the nodes inside it. */
export const CONTAINER_PAD = 14;
/** Smallest a container may be, even with nothing inside. */
export const CONTAINER_MIN_W = 280;
export const CONTAINER_MIN_H = 150;
/** Smallest width one lane gets, which is what a choice's options add up to. */
export const LANE_MIN_W = 220;
/** Rough height of one parameter row, used for the DOM-free layout maths. */
const PARAM_H = { text: 36, number: 36, select: 36, multiline: 62, bool: 24 };

// A wire may be dropped near a socket rather than exactly on it: this is the
// radius, in screen pixels, inside which the nearest socket wins. It is screen
// pixels (not world ones) so the aim does not change with the zoom.
const PORT_HIT_PX = 18;

// A press on a socket that never moves is a click, not a wire.
const LINK_MIN_DRAG = 4;

// The zoom the canvas allows. The floor matters: a `.flowmap` opened before the
// viewport has been laid out used to fit itself to a 0×0 box and land on the
// floor, which is the "初始缩放太小" the canvas opened at.
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
/** Zoom used when a map has never been framed before, and when 适应 is pressed. */
const FIT_MAX_SCALE = 1.2;
const DEFAULT_SCALE = 1;

// --- node palette ---

/**
 * Every behaviour a Pamela object answers to, with the shape of its call.
 *
 * This table is the one place a behaviour is described. From it come the node
 * types (one per method, so each box shows exactly the fields that call takes),
 * the 行为 menus, and the emitted code. `types` says which objects answer to the
 * method — a background has no `front`, a sound has no `move`.
 *
 * `params` describes the *call's* arguments, not the node's fields: each entry
 * becomes one input, and `time` is appended as a duration when the method takes
 * one. Nothing here is optional-but-unlisted: a method with no parameters
 * (`enable`, `front`) gets a box with no fields at all.
 */
const BEHAVIOR_SPECS = {
  enable: { title: "显示", types: ["Background", "Character", "Text", "Video"], params: [], hint: "() 显示到舞台" },
  hide: { title: "淡出", types: ["Background", "Character", "Text", "Video"], params: [{ key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  show: { title: "淡入", types: ["Background", "Character", "Text", "Video"], params: [{ key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  alpha: { title: "透明度", types: ["Background", "Character", "Text", "Video"], params: [{ key: "value", label: "0–1", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  moveTo: { title: "移到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "x", label: "X", type: "number", default: 0 }, { key: "y", label: "Y", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  move: { title: "移动", types: ["Background", "Character", "Text", "Video"], params: [{ key: "dx", label: "ΔX", type: "number", default: 0 }, { key: "dy", label: "ΔY", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  x: { title: "横移", types: ["Background", "Character", "Text", "Video"], params: [{ key: "dx", label: "ΔX", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  y: { title: "纵移", types: ["Background", "Character", "Text", "Video"], params: [{ key: "dy", label: "ΔY", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  z: { title: "深移", types: ["Background", "Character", "Text", "Video"], params: [{ key: "dz", label: "ΔZ(深度)", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  xTo: { title: "横到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "x", label: "X", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  yTo: { title: "纵到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "y", label: "Y", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  zTo: { title: "深到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "z", label: "Z(深度)", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  // HVD 拼写：H = 横（x）、V = 纵（y）。与 x / y 同一批调用，只是名字更精确。
  h: { title: "H 横移", types: ["Background", "Character", "Text", "Video"], params: [{ key: "dx", label: "ΔH", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  v: { title: "V 纵移", types: ["Background", "Character", "Text", "Video"], params: [{ key: "dy", label: "ΔV", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  hTo: { title: "H 横到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "x", label: "H", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  vTo: { title: "V 纵到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "y", label: "V", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  // 关键帧是独立语句，不是 `move` 的调用形式：`move` 仅负责位移，动画由 `key` 实现。
  // The `file` field is the key frame file the call plays, written as the
  // argument — `ch.key("key-ch.keyframes")` — and filled in automatically when
  // the author draws the animation from this node's right-click menu.
  key: {
    title: "路径帧",
    types: ["Background", "Character"],
    params: [
      { key: "file", label: "关键帧文件", type: "text", default: "", asset: "keyframes" },
    ],
    hint: "(\"key-ch.keyframes\") 播放这个对象的关键帧动画",
  },
  rotateTo: { title: "转到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "degrees", label: "角度", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  rotate: { title: "旋转", types: ["Background", "Character", "Text", "Video"], params: [{ key: "degrees", label: "角度", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  scaleTo: { title: "缩放到", types: ["Background", "Character", "Text", "Video"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  scale: { title: "缩放", types: ["Background", "Character", "Text", "Video"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  rgb: { title: "相对染色", types: ["Background", "Character", "Video"], params: [{ key: "r", label: "R", type: "number", default: 0 }, { key: "g", label: "G", type: "number", default: 0 }, { key: "b", label: "B", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  rgbTo: { title: "绝对染色", types: ["Background", "Character", "Video"], params: [{ key: "r", label: "R", type: "number", default: 0 }, { key: "g", label: "G", type: "number", default: 0 }, { key: "b", label: "B", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  hex: { title: "HEX 染色", types: ["Background", "Character", "Video"], params: [{ key: "hex", label: "HEX", type: "text", default: "#ffffff" }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  // The four look filters. Each sets one slider and leaves the other three
  // alone, which is why they are four calls rather than one `filter(...)`: a
  // node shows exactly the field it takes.
  blur: { title: "模糊", types: ["Background", "Character", "Video"], params: [{ key: "value", label: "像素", type: "number", default: 0 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  brightness: { title: "亮度", types: ["Background", "Character", "Video"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  contrast: { title: "对比度", types: ["Background", "Character", "Video"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  saturate: { title: "饱和度", types: ["Background", "Character", "Video"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  crossFade: { title: "交叉溶解", types: ["Background"], params: [{ key: "path", label: "目标图", type: "text", default: "" }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  // 文字字体：一个名字同时作用于中文与西文；留空是内置的默认字体。
  font: {
    title: "字体",
    types: ["Text"],
    // A family is always a literal, even when it looks like an identifier
    // (`Arial`): `font(Arial)` would name a variable.
    params: [{ key: "family", label: "字体名", type: "text", default: "", literal: true }],
    hint: '("宋体") 设置文字字体，中文与西文一起生效',
  },
  // 文字字重：CSS 数值刻度，400 常规、700 粗体。
  weight: {
    title: "字重",
    types: ["Text"],
    params: [{ key: "value", label: "字重 100–900", type: "number", default: 400 }],
    hint: "(700) 设置文字字重：400 常规、700 粗体",
  },
  front: { title: "到最前", types: ["Character"], params: [] },
  back: { title: "到最后", types: ["Character"], params: [] },
  name: { title: "设置姓名", types: ["Character"], params: [{ key: "value", label: "姓名", type: "text", default: "" }] },
  say: { title: "说话", types: ["Character"], params: [{ key: "text", label: "台词", type: "multiline", default: "" }] },
  play: { title: "播放", types: ["Audio"], params: [{ key: "time", label: "淡入(毫秒)", type: "number", default: 0 }] },
  stop: { title: "停止", types: ["Audio"], params: [{ key: "time", label: "淡出(毫秒)", type: "number", default: 0 }] },
  loop: { title: "循环", types: ["Audio", "Video"], params: [] },
  once: { title: "单次", types: ["Audio", "Video"], params: [] },
  volume: { title: "音量", types: ["Audio", "Video"], params: [{ key: "value", label: "0–1", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  pause: {
    title: "暂停",
    types: ["Effect", "Video", "Background", "Character"],
    params: [
      // 图片组可以停在一张指定的图上；音画对象没有这一项，空着就不写这个参数。
      { key: "value", label: "停在(序号/图名/图，空=当前)", type: "index", default: "", omitEmpty: true },
    ],
    hint: "() 暂停，保留播放位置；图片组可停在指定的一张",
  },
  mute: { title: "静音", types: ["Video"], params: [], hint: "() 静音；解除静音请在脚本里写 mute(false)" },
  speed: { title: "速度", types: ["Effect", "Video"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  speedTo: { title: "速度到", types: ["Effect", "Video"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  size: { title: "尺寸", types: ["Effect"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  sizeTo: { title: "尺寸到", types: ["Effect"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  density: { title: "密度", types: ["Effect"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  densityTo: { title: "密度到", types: ["Effect"], params: [{ key: "value", label: "倍率", type: "number", default: 1 }, { key: "time", label: "时长(毫秒)", type: "number", default: 0 }] },
  crood: { title: "坐标轴", types: ["Background", "Character", "Text", "Video"], params: [{ key: "value", label: "显示三维坐标轴", type: "bool", default: true }], hint: "(true/false) 显示或隐藏这个对象自己的三维坐标轴，默认隐藏" },
  translucent: { title: "透光", types: ["Background", "Character", "Text", "Video"], params: [{ key: "value", label: "光穿过它", type: "bool", default: true }], hint: "(true/false) 光穿过它、灯不按深度把它挖成剪影；角色默认挡光" },
  rim: { title: "轮廓光", types: ["Background", "Character", "Text", "Video"], params: [{ key: "value", label: "强度 0–1", type: "number", default: 1 }], hint: "(0–1) 灯在它背后时贴着轮廓勾出的光；默认 0 不勾" },
};

// 逐帧图片组：背景与角色共用这几个节点，参数是「序号或图名」而不是含糊的数值。
BEHAVIOR_SPECS.group = {
  title: "图片组",
  types: ["Background", "Character"],
  params: [{ key: "files", label: "图片(逗号分隔)", type: "list", default: "" }],
  hint: '("a.png", "b.png") 一组图片作为逐帧动画，停在第 1 张',
};
BEHAVIOR_SPECS.fps = {
  title: "逐帧播放",
  types: ["Background", "Character"],
  params: [
    { key: "value", label: "每秒张数 1–144", type: "number", default: 16 },
    { key: "loop", label: "循环播放", type: "bool", default: false },
  ],
  hint: "(16, true) 按每秒张数播放图片组，第二参 true 为循环",
};
BEHAVIOR_SPECS.element = {
  title: "取组内图片",
  types: ["Background", "Character"],
  params: [{ key: "index", label: "序号或图名", type: "index", default: 0 }],
  hint: "(1) 取组里一张图的路径",
};
BEHAVIOR_SPECS.add = {
  title: "插入图片",
  types: ["Background", "Character"],
  params: [
    { key: "index", label: "插在这张之后", type: "index", default: 0 },
    { key: "source", label: "新图片", type: "text", default: "" },
  ],
  hint: '(1, "ch2.png") 在组内某张之后插入一张新图',
};
BEHAVIOR_SPECS.remove = {
  title: "移除图片",
  types: ["Background", "Character"],
  params: [{ key: "index", label: "序号或图名", type: "index", default: 0 }],
  hint: "(1) 从组里移除一张",
};
BEHAVIOR_SPECS.update = {
  title: "替换图片",
  types: ["Background", "Character"],
  params: [
    { key: "index", label: "旧图(序号或图名)", type: "index", default: 0 },
    { key: "source", label: "新图片", type: "text", default: "" },
  ],
  hint: '(1, "ch2.png") 把组里某一张换成另一张',
};

/**
 * Every other behaviour is generated from the shared API table, so each method
 * the language answers to gets its own node instead of a hand-maintained list.
 * The entries above stay authoritative for the methods they already describe:
 * their labels, defaults and object-type limits are what existing maps use.
 */
function generatedBehaviors() {
  const out = {};
  for (const key of behaviorNodeKeys()) {
    const method = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
    const types = methodTypes(key);
    out[key] = {
      title: nodeTitleFor(key),
      // No type limit means the API belongs to no particular object; the node
      // stays searchable in the picker instead of appearing in every menu.
      types,
      params: methodParams(key).map((name) => paramControl(name, method)),
      hint: METHOD_SPECS.get(key)?.hint ?? "()",
    };
  }
  return out;
}

for (const [key, spec] of Object.entries(generatedBehaviors())) {
  const existing = BEHAVIOR_SPECS[key];
  if (!existing) {
    BEHAVIOR_SPECS[key] = spec;
    continue;
  }
  // 手写条目只负责标题、字段与提示；能挂在哪些类型上一律以 API 表为准。
  // 类型清单写成常量就会落后：`enable` 曾经只列图片，灯与特效明明也有这个
  // 方法，画布上却选不到。
  existing.types = spec.types;
}

/** The node-type name a behaviour method is drawn as (`beh:enable`). */
export const behaviorTypeName = (method) => `beh:${method}`;

/** The method a behaviour node type stands for, or null for any other type. */
export function behaviorMethodOf(type) {
  const m = /^beh:([A-Za-z_][\w.]*)$/.exec(String(type ?? ""));
  return m && BEHAVIOR_SPECS[m[1]] ? m[1] : null;
}

/**
 * The methods one kind of object answers to, in the order a menu should list
 * them: the everyday calls first, the occasional ones after.
 */
const EVERYDAY_METHODS = [
  "enable", "hide", "show", "alpha", "blur", "brightness", "contrast", "saturate",
  "moveTo", "move", "h", "hTo", "v", "vTo", "key", "rotateTo", "rotate", "scaleTo", "scale",
  "rgb", "rgbTo", "hex", "crossFade", "font", "front", "back",
  "name", "say", "play", "stop", "loop", "once", "volume",
];

// The everyday calls stay first; every other method the API table knows follows
// alphabetically, so a new API never needs a menu entry written by hand.
const METHOD_ORDER = [
  ...EVERYDAY_METHODS,
  ...Object.keys(BEHAVIOR_SPECS).filter((m) => !EVERYDAY_METHODS.includes(m)).sort(),
];

export function methodsFor(owner, graph = null) {
  const type = owner ? (graph ? objectTypeIn(graph, owner) : objectTypeOf(owner)) : null;
  return METHOD_ORDER.filter((method) => {
    const spec = BEHAVIOR_SPECS[method];
    if (!spec) return false;
    // With no object connected, every method is offered: the node can be placed
    // before the object it belongs to is known, and the type it names decides.
    return !type || spec.types.includes(type);
  });
}

/**
 * One node type per behaviour method.
 *
 * A behaviour node has a 行为 input and a 行为 output, both named 行为 so the
 * label matches the kind of wire that fits them. The two sockets are what lets
 * behaviours chain: `ch → enable → say` is `ch.enable().say()`, which is the same
 * thing as `ch.enable(); ch.say()` — one object, two calls.
 */
function behaviorNodeTypes() {
  const out = {};
  for (const [method, spec] of Object.entries(BEHAVIOR_SPECS)) {
    out[behaviorTypeName(method)] = {
      title: spec.title,
      category: "行为",
      color: "#b06fc4",
      behavior: method,
      // A behaviour has no sockets at all. Which object it belongs to, and
      // where it sits in that object's chain, are both read off the canvas:
      // the nodes stack under the object they call, top to bottom. That is what
      // keeps a scene's flow free of the little chains of 行为 wires that used
      // to compete with the flow for the eye.
      inputs: [],
      outputs: [],
      params: spec.params,
    };
  }
  return out;
}

/**
 * One node per global, stage-wide and dialog call — the APIs that belong to no
 * object on the canvas. Batch and variadic calls take their object list as one
 * free-form field; everything else gets a field per parameter from the API
 * table, so the writer never has to remember a signature.
 */
function globalCallNodeTypes() {
  const out = {};
  for (const key of callNodeKeys()) {
    const spec = METHOD_SPECS.get(key);
    const params = methodParams(key);
    out[`call:${key}`] = {
      title: nodeTitleFor(key),
      category: "调用",
      color: "#5b8cc4",
      inputs: ["执行"],
      outputs: ["执行"],
      params: spec?.bulk || spec?.variadic
        ? [{ key: "args", label: "对象 / 参数(逗号分隔)", type: "text", default: "" }]
        : params.map((name) => paramControl(name, key)),
    };
  }
  return out;
}

/** The 动作 node's method picker: every bare method in the API table. */
const STAGE_CALL_OPTIONS = behaviorNodeKeys().filter((key) => !key.includes("."));

// Each node type declares its exec ports, data ports and the parameters shown
// inside the box.
//
// Two axes describe how a node sits in the flow:
//
//   * `container` — the node is a *block*: `lanes` names the bands its body is
//     divided into, and the nodes inside belong to it rather than to the
//     top-level flow.
//   * `parallel` — the node may run several things at once, so its output may
//     feed more than one wire. Everything else is *serial*: one input, one
//     output, and an output that already leads somewhere cannot be pulled to a
//     second target. That is the ordinary shape of a script — one statement
//     after another — and it is what makes "开始 同时接了背景和角色" impossible
//     instead of merely discouraged.
export const NODE_TYPES = {
  Start: {
    title: "开始",
    category: "流程",
    color: "#e0a84e",
    inputs: [],
    outputs: ["执行"],
    params: [],
  },

  // --- objects ---
  //
  // Building an object and *using* it are two different jobs, and the canvas
  // keeps them apart:
  //
  //   新对象 ──赋值──▶ 角色 / 背景 / 音频      （定义：名字 + 资源）
  //   对象  ──流程──▶ …                        （使用：在这个位置调用它）
  //
  // The definition half never joins the flow. A 新对象 node names a variable
  // and hands its one 赋值 output to a *type* node, which is the constructor
  // call — `ch = Character("ch.png")`. Because nothing in the flow reaches
  // them, the cast of a scene reads as a tidy row beside the script instead of
  // being threaded through every statement, and the generated code puts every
  // definition first, so a name is always defined before it is used.
  //
  // The 对象 node is the other half: "this variable, here". Its behaviours are
  // the calls made on it at that point, stacked under it on the canvas.
  NewObject: {
    title: "新对象",
    category: "对象",
    color: "#4caf82",
    declares: true,
    inputs: [],
    outputs: ["赋值"],
    params: [{ key: "objectName", label: "名称", type: "text", default: "ch" }],
  },
  // A type node: the constructor a 新对象 is built with. Its only field is the
  // resource, which is all `Character("…")` takes.
  TypeCharacter: {
    title: "角色",
    category: "对象",
    color: "#4caf82",
    typeOf: "Character",
    inputs: ["赋值"],
    params: [{ key: "image", label: "立绘", type: "text", default: "" }],
  },
  TypeBackground: {
    title: "背景",
    category: "对象",
    color: "#3f7cc4",
    typeOf: "Background",
    inputs: ["赋值"],
    params: [{ key: "image", label: "背景图", type: "text", default: "" }],
  },
  TypeAudio: {
    title: "音频",
    category: "对象",
    color: "#c46aa6",
    typeOf: "Audio",
    inputs: ["赋值"],
    params: [{ key: "file", label: "文件", type: "text", default: "" }],
  },
  // An effect names a built-in kind rather than a file; a video reads one
  // under assets/Video/. Neither has an advanced (placed) constructor.
  TypeEffect: {
    title: "特效",
    category: "对象",
    color: "#4aa3c4",
    typeOf: "Effect",
    inputs: ["赋值"],
    params: [{ key: "effect", label: "特效名 (rain / snow)", type: "text", default: "rain" }],
  },
  TypeVideo: {
    title: "视频",
    category: "对象",
    color: "#8957e5",
    typeOf: "Video",
    inputs: ["赋值"],
    params: [{ key: "file", label: "文件", type: "text", default: "" }],
  },
  // 文字不读素材：字段就是画面上要显示的内容，可多行。
  TypeText: {
    title: "文字",
    category: "对象",
    color: "#d3a84c",
    typeOf: "Text",
    inputs: ["赋值"],
    params: [{ key: "text", label: "内容", type: "multiline", default: "" }],
  },
  // A light reads no asset: its first argument is the colour it casts.
  TypeLight: {
    title: "光源",
    category: "对象",
    color: "#e0c04e",
    typeOf: "Light",
    inputs: ["赋值"],
    params: [{ key: "color", label: "颜色", type: "text", default: "#ffffff" }],
  },
  // A group holds object names, not a quoted path — the declaration below
  // writes them through as bare identifiers.
  TypeArray: {
    title: "对象组",
    category: "对象",
    color: "#4caf82",
    typeOf: "Array",
    inputs: ["赋值"],
    params: [{ key: "members", label: "成员(对象名，逗号分隔)", type: "text", default: "" }],
  },
  // The advanced types carry the constructor arguments a writer would otherwise
  // have to add as behaviours: where the object starts and how big it is. They
  // emit them as *arguments* — `Character("ch.png", x = -300, y = -500)` —
  // which is exactly what a named argument is for.
  TypeCharacterAdv: {
    title: "角色(高级)",
    category: "对象",
    color: "#4caf82",
    typeOf: "Character",
    advanced: true,
    inputs: ["赋值"],
    params: [
      { key: "image", label: "立绘", type: "text", default: "" },
      { key: "x", label: "X", type: "number", default: 0 },
      { key: "y", label: "Y", type: "number", default: 0 },
      { key: "scale", label: "缩放", type: "number", default: 1 },
    ],
  },
  TypeBackgroundAdv: {
    title: "背景(高级)",
    category: "对象",
    color: "#3f7cc4",
    typeOf: "Background",
    advanced: true,
    inputs: ["赋值"],
    params: [
      { key: "image", label: "背景图", type: "text", default: "" },
      { key: "x", label: "X", type: "number", default: 0 },
      { key: "y", label: "Y", type: "number", default: 0 },
      { key: "scale", label: "缩放", type: "number", default: 1 },
    ],
  },
  // Using an object: the flow passes through it, and the calls stacked under it
  // run at that moment.
  Object: {
    title: "对象",
    category: "对象",
    color: "#7c8c9e",
    call: true,
    inputs: ["流程"],
    outputs: ["流程"],
    dataOut: ["对象(变量)"],
    params: [{ key: "objectName", label: "名称", type: "text", default: "ch" }],
  },

  // --- behaviour ---
  //
  // A behaviour node is one call on the object it hangs off: `hero.enable()`.
  // There is a node *per method* rather than one generic box, because the
  // methods do not share a parameter shape — `alpha` takes one number and a
  // duration, `moveTo` two numbers and a duration, `say` a line of text — and a
  // single box with a "参数(逗号分隔)" field made the writer remember the
  // signature. The table below is the single source of truth: it builds the
  // node types, the menus, and the emitted call.
  ...behaviorNodeTypes(),
  ...globalCallNodeTypes(),

  // --- statements ---
  Say: {
    title: "台词",
    category: "演出",
    color: "#9b6bd6",
    inputs: ["执行"],
    outputs: ["执行"],
    dataIn: [{ key: "speaker", label: "说话人(变量)" }],
    params: [
      { key: "speaker", label: "说话人(可空)", type: "text", default: "" },
      { key: "text", label: "台词", type: "multiline", default: "" },
    ],
  },
  Wait: {
    title: "等待",
    category: "演出",
    color: "#6c7a89",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [{ key: "ms", label: "毫秒", type: "number", default: 0 }],
  },
  // A generic call on a *named variable* — the escape hatch for a method that
  // has no behaviour node, or for an object that is not on the canvas.
  StageCall: {
    title: "动作",
    category: "演出",
    color: "#5b8cc4",
    inputs: ["执行"],
    outputs: ["执行"],
    dataIn: [{ key: "target", label: "目标(变量)" }],
    params: [
      { key: "target", label: "目标变量", type: "text", default: "hero" },
      {
        key: "method",
        label: "方法",
        type: "select",
        default: "move",
        options: STAGE_CALL_OPTIONS,
      },
      { key: "args", label: "参数(逗号分隔)", type: "text", default: "" },
      { key: "time", label: "时长(毫秒，可空)", type: "text", default: "" },
    ],
  },
  SetVar: {
    title: "变量",
    category: "脚本",
    color: "#7a8c3f",
    inputs: ["执行"],
    outputs: ["执行"],
    dataOut: ["值(变量)"],
    dataIn: [{ key: "value", label: "值(可连表达式)" }],
    params: [
      { key: "name", label: "变量名", type: "text", default: "count" },
      { key: "value", label: "值(表达式)", type: "text", default: "0" },
    ],
  },
  // A function is a definition, like a cast member: the node opens a body box
  // and is emitted above the flow, never as a step of it.
  FuncDef: {
    title: "函数",
    category: "脚本",
    color: "#8c6f3f",
    container: "func",
    lanes: ["函数体"],
    inputs: [],
    outputs: [],
    params: [
      { key: "name", label: "函数名", type: "text", default: "fn" },
      { key: "args", label: "参数名(逗号分隔)", type: "text", default: "" },
    ],
  },
  FuncCall: {
    title: "调用函数",
    category: "脚本",
    color: "#7a8c3f",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [
      { key: "name", label: "函数名", type: "text", default: "fn" },
      { key: "args", label: "实参(逗号分隔)", type: "text", default: "" },
    ],
  },
  Return: {
    title: "返回",
    category: "脚本",
    color: "#9e5b6f",
    inputs: ["执行"],
    outputs: ["执行"],
    dataIn: [{ key: "value", label: "返回值(可连表达式)" }],
    params: [{ key: "value", label: "返回值(表达式)", type: "text", default: "" }],
  },
  Break: {
    title: "跳出",
    category: "脚本",
    color: "#9e5b6f",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [],
  },
  Continue: {
    title: "继续",
    category: "脚本",
    color: "#9e5b6f",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [],
  },
  Include: {
    title: "包含",
    category: "脚本",
    color: "#5b6b8c",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [{ key: "file", label: "脚本", type: "text", default: "scene.pe" }],
  },
  Jump: {
    title: "跳转",
    category: "脚本",
    color: "#8c5b7a",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [{ key: "file", label: "场景", type: "text", default: "scene.pe" }],
  },
  Use: {
    title: "切换样式",
    category: "演出",
    color: "#b08c3f",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [{ key: "file", label: "样式文件", type: "text", default: "templates/x.dialog.json" }],
  },
  DialogEnable: {
    title: "对话开",
    category: "演出",
    color: "#6fae5b",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [],
  },
  DialogDisable: {
    title: "对话关",
    category: "演出",
    color: "#9e5b6f",
    inputs: ["执行"],
    outputs: ["执行"],
    params: [],
  },
  Filter: {
    title: "滤镜",
    category: "演出",
    color: "#c46a8c",
    inputs: ["执行"],
    outputs: ["执行"],
    dataIn: [{ key: "target", label: "目标(变量)" }],
    params: [
      { key: "target", label: "目标变量", type: "text", default: "hero" },
      {
        key: "mode",
        label: "模式",
        type: "select",
        default: "rgbTo",
        options: ["rgb", "rgbTo", "hex"],
      },
      { key: "r", label: "R", type: "number", default: 0 },
      { key: "g", label: "G", type: "number", default: 0 },
      { key: "b", label: "B", type: "number", default: 0 },
      { key: "hex", label: "HEX", type: "text", default: "#ffffff" },
    ],
  },

  // --- routing ---
  //
  // A route is pure layout: the setter ends one stretch of the flow, the getter
  // with the same name starts another. Neither emits any code; the walker jumps
  // from one to the other, so a long script can be laid out in pieces.
  RouteSet: {
    title: "路由设置",
    category: "路由",
    color: "#7d6fa8",
    inputs: ["执行"],
    outputs: [],
    params: [{ key: "name", label: "路由名", type: "text", default: "router" }],
  },
  RouteGet: {
    title: "路由取得",
    category: "路由",
    color: "#7d6fa8",
    inputs: [],
    outputs: ["执行"],
    params: [{ key: "name", label: "路由名", type: "text", default: "router" }],
  },

  // --- blocks ---
  If: {
    title: "条件",
    category: "流程",
    color: "#4aa3c4",
    container: "if",
    lanes: ["成立", "否则"],
    inputs: ["执行"],
    outputs: ["完成"],
    dataIn: [{ key: "cond", label: "条件(可连表达式)" }],
    params: [{ key: "cond", label: "条件", type: "text", default: "true" }],
  },
  While: {
    title: "循环",
    category: "流程",
    color: "#4aa3c4",
    container: "while",
    lanes: ["循环体"],
    inputs: ["执行"],
    outputs: ["完成"],
    dataIn: [{ key: "cond", label: "条件(可连表达式)" }],
    params: [{ key: "cond", label: "条件", type: "text", default: "true" }],
  },
  Choice: {
    title: "选择支",
    category: "流程",
    color: "#d6783b",
    container: "choice",
    inputs: ["执行"],
    outputs: ["完成"],
    params: [{ key: "options", label: "选项", type: "multiline", default: "选项一\n选项二" }],
  },
  // The one block whose whole point is running several things at once, so its
  // body is a *parallel* region: every statement in it starts together.
  Cue: {
    title: "并行",
    category: "流程",
    color: "#b06fc4",
    container: "cue",
    lanes: ["并行"],
    parallel: true,
    inputs: ["执行"],
    outputs: ["完成"],
    params: [],
  },
  For: {
    title: "循环",
    category: "流程",
    color: "#4aa3c4",
    container: "for",
    lanes: ["循环体"],
    inputs: ["执行"],
    outputs: ["完成"],
    dataIn: [{ key: "iter", label: "集合" }],
    params: [
      { key: "var", label: "循环变量", type: "text", default: "i" },
      { key: "iter", label: "集合(列表/字典/文本，可连表达式)", type: "text", default: "[1, 2, 3]" },
    ],
  },
  Switch: {
    title: "分支",
    category: "流程",
    color: "#d6783b",
    container: "switch",
    inputs: ["执行"],
    outputs: ["完成"],
    dataIn: [{ key: "expr", label: "表达式" }],
    params: [
      { key: "expr", label: "表达式", type: "text", default: "x" },
      { key: "cases", label: "case (每行一个值)", type: "multiline", default: "1\n2" },
      { key: "hasDefault", label: "有 default", type: "bool", default: true },
    ],
  },

  // --- expressions ---
  //
  // A value node: it carries no statement of its own, only a sub-expression
  // wired from other value nodes or from a data socket on a statement. `dataExprOf`
  // walks this little graph and turns it back into a Pamela expression, so the
  // canvas can build `a ?? b`, `a and b`, `not a` the same way the text editor does.
  Nullish: {
    title: "空值合并 ??",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "left", label: "左" }, { key: "right", label: "右" }],
    dataOut: ["结果"],
    params: [],
  },
  And: {
    title: "且 and",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "left", label: "左" }, { key: "right", label: "右" }],
    dataOut: ["结果"],
    params: [],
  },
  Or: {
    title: "或 or",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "left", label: "左" }, { key: "right", label: "右" }],
    dataOut: ["结果"],
    params: [],
  },
  Not: {
    title: "非 not",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "operand", label: "操作数" }],
    dataOut: ["结果"],
    params: [],
  },
  // The literal and operator nodes below let a writer build a value without
  // typing an expression: each one owns exactly one field or socket.
  NumLit: {
    title: "数字",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataOut: ["结果"],
    params: [{ key: "value", label: "数值", type: "number", default: 0 }],
  },
  StrLit: {
    title: "文本",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataOut: ["结果"],
    params: [{ key: "value", label: "文本", type: "text", default: "" }],
  },
  BoolLit: {
    title: "布尔",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataOut: ["结果"],
    params: [{ key: "value", label: "真 / 假", type: "bool", default: true }],
  },
  NullLit: {
    title: "空值 null",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataOut: ["结果"],
    params: [],
  },
  Compare: {
    title: "比较",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "left", label: "左" }, { key: "right", label: "右" }],
    dataOut: ["结果"],
    params: [
      { key: "op", label: "运算符", type: "select", default: "==", options: ["==", "!=", "<", "<=", ">", ">="] },
      { key: "left", label: "左(兜底)", type: "text", default: "" },
      { key: "right", label: "右(兜底)", type: "text", default: "" },
    ],
  },
  Arith: {
    title: "算术",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "left", label: "左" }, { key: "right", label: "右" }],
    dataOut: ["结果"],
    params: [
      { key: "op", label: "运算符", type: "select", default: "+", options: ["+", "-", "*", "/", "%"] },
      { key: "left", label: "左(兜底)", type: "text", default: "" },
      { key: "right", label: "右(兜底)", type: "text", default: "" },
    ],
  },
  ListLit: {
    title: "列表",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataOut: ["结果"],
    params: [{ key: "items", label: "元素(每行一个表达式)", type: "multiline", default: "" }],
  },
  Index: {
    title: "索引",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "target", label: "目标" }, { key: "key", label: "下标" }],
    dataOut: ["结果"],
    params: [
      { key: "target", label: "目标(兜底)", type: "text", default: "" },
      { key: "key", label: "下标(兜底)", type: "text", default: "0" },
    ],
  },
  Member: {
    title: "成员",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataIn: [{ key: "target", label: "目标" }],
    dataOut: ["结果"],
    params: [
      { key: "target", label: "目标(兜底)", type: "text", default: "" },
      { key: "name", label: "成员名", type: "text", default: "" },
    ],
  },
  CallExpr: {
    title: "函数调用(表达式)",
    category: "表达式",
    color: "#8c7d3f",
    inputs: [],
    outputs: [],
    dataOut: ["结果"],
    params: [
      { key: "name", label: "函数名", type: "text", default: "fn" },
      { key: "args", label: "实参(逗号分隔)", type: "text", default: "" },
    ],
  },
};

/** Whether a node type is a block rather than a single statement. */
export function isContainer(type) {
  return Boolean(NODE_TYPES[type]?.container);
}

/** Whether a node type is about objects at all (定义、类型、使用). */
export function isObjectNode(type) {
  const def = NODE_TYPES[type];
  return Boolean(def && (def.declares || def.typeOf || def.call));
}

/** Whether a node type declares a variable: `ch = …`. */
export function isDeclareNode(type) {
  return Boolean(NODE_TYPES[type]?.declares);
}

/** Whether a node type is a constructor (`角色` / `背景` / `音频`). */
export function isTypeNode(type) {
  return Boolean(NODE_TYPES[type]?.typeOf);
}

/** Whether a node type uses an object in the flow (对象). */
export function isCallNode(type) {
  return Boolean(NODE_TYPES[type]?.call);
}

/** Whether a node type is a behaviour on the object it hangs off. */
export function isBehaviorNode(type) {
  // A behaviour's `behavior` field is the *method* it calls (`"enable"`), not a
  // bare `true`: one node type per method is what lets each box show exactly the
  // fields that call takes.
  return Boolean(NODE_TYPES[type]?.behavior);
}

/**
 * Whether a node's output may feed more than one wire.
 *
 * Serial is the default: a statement has one next statement. A block marked
 * `parallel` is the exception, and so is the body of one — the statements
 * inside a 并行 block all start together, which is exactly a fan-out.
 *
 * `nodes` is needed for the second case: a node's parent is stored as an *id*,
 * so the parent has to be looked up in the graph to learn its type.
 */
export function isParallelNode(node, nodes = []) {
  if (!node) return false;
  if (NODE_TYPES[node.type]?.parallel) return true;
  if (!node.parent) return false;
  const parent = nodes.find((n) => n.id === node.parent);
  return Boolean(parent && NODE_TYPES[parent.type]?.parallel);
}

/** The labels of a container's body bands, one per lane. */
export function containerLanes(node) {
  const def = NODE_TYPES[node?.type];
  if (!def?.container) return [];
  if (def.container === "choice") {
    const options = choiceOptions(node);
    // A choice with no options still needs one lane to drop nodes into.
    return options.length ? options.map((label) => ({ label })) : [{ label: "选项一" }];
  }
  if (def.container === "switch") {
    const options = switchCases(node);
    const lanes = options.map((label) => ({ label }));
    if (node.params?.hasDefault) {
      lanes.push({ label: "default" });
    }
    return lanes.length ? lanes : [{ label: "case" }];
  }
  return (def.lanes ?? ["语句体"]).map((label) => ({ label }));
}

function choiceOptions(node) {
  const raw = String(node?.params?.options ?? "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function switchCases(node) {
  const raw = String(node?.params?.cases ?? "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function execInCount(node) {
  // 界面文案「赋值」表示定义连线而非流程步骤；类型节点不进入执行流。
  // 界面文案「赋值」表示定义连线而非流程步骤；类型节点不进入执行流。
  // 赋值 is a definition wire, not a step: a type node is not in the flow at
  // all, which is why the flow can start beside the cast rather than through it.
  return (NODE_TYPES[node?.type]?.inputs ?? []).filter((name) => name !== "赋值").length;
}

function execOutCount(node) {
  const def = NODE_TYPES[node?.type];
  if (!def) return 0;
  // 块只有一个出口，即界面文案「完成」，与块内语句结构无关。
  // A block has exactly one exit, the UI label `完成` (Complete), regardless of its body.
  // A function is a definition, not a step: it has no exit at all.
  if (def.container === "func") return 0;
  if (def.container) return 1;
  // 赋值 likewise: a 新对象 hands its variable to a type node, and the flow
  // never continues from it.
  return (def.outputs ?? []).filter((name) => name !== "赋值").length;
}

function dataInCount(node) {
  return NODE_TYPES[node?.type]?.dataIn?.length ?? 0;
}

function dataOutCount(node) {
  return NODE_TYPES[node?.type]?.dataOut?.length ?? 0;
}

/** A node inside a block. Its exec flow is the body's reading order. */
function isChild(node) {
  return Boolean(node?.parent);
}

/** The object a behaviour node belongs to, or null. */
export function behaviorOwner(node, nodes = []) {
  if (!isBehaviorNode(node?.type) || !node?.behaviorOf) return null;
  return nodes.find((n) => n.id === node.behaviorOf) ?? null;
}

/**
 * The kind of wire a socket takes, from the label it is drawn with.
 *
 * 赋值 is the definition wire (`新对象 → 角色`), and it is a third kind so it can
 * never be confused with the flow: a definition is not a step.
 */
function kindOfLabel(label) {
  return label === "赋值" ? "assign" : "exec";
}

/**
 * Every socket on a node, in render order.
 *
 * Four shapes are worth spelling out:
 *
 *   * a block has one 入 on the left and one 完成 on the right, level with its
 *     header, so a wire can never be mistaken for one of the lanes inside it;
 *   * a 新对象 has one 赋值 output and nothing else — it is a definition, not a
 *     step;
 *   * a type node (角色 / 背景 / 音频) has one 赋值 input and no output at all:
 *     it *is* the constructor call, and nothing continues from it;
 *   * a behaviour has no sockets: it belongs to the object it is stacked under,
 *     and its place in the chain is its place in the stack.
 *
 * A node inside a block has no exec sockets: its place in the flow is its place
 * in the body, not a wire. Data sockets stay, since a data wire is a value and
 * not a step.
 */
export function portsOf(node) {
  const def = NODE_TYPES[node?.type] ?? {};
  const list = [];
  if (isBehaviorNode(node.type)) {
    return list;
  }
  if (isContainer(node.type)) {
    list.push({ dir: "in", kind: "exec", port: 0, label: "入" });
    list.push({ dir: "out", kind: "exec", port: 0, label: "完成" });
    (def.dataIn ?? []).forEach((d, i) =>
      list.push({ dir: "in", kind: "data", port: i, label: d.label, slot: d.key }),
    );
    (def.dataOut ?? []).forEach((name, i) => list.push({ dir: "out", kind: "data", port: i, label: name }));
    return list;
  }
  if (!isChild(node)) {
    (def.inputs ?? []).forEach((name, i) =>
      list.push({ dir: "in", kind: kindOfLabel(name), port: i, label: name }),
    );
    (def.outputs ?? []).forEach((name, i) =>
      list.push({ dir: "out", kind: kindOfLabel(name), port: i, label: name }),
    );
  }
  (def.dataIn ?? []).forEach((d, i) =>
    list.push({ dir: "in", kind: "data", port: i, label: d.label, slot: d.key }),
  );
  (def.dataOut ?? []).forEach((name, i) => list.push({ dir: "out", kind: "data", port: i, label: name }));
  return list;
}

// The row (within the port band) a socket sits on. Exec ports keep their own
// index; data ports start after a gap row, so the two bands never overlap.
function portRow(node, dir, kind, port) {
  const inExec = isChild(node) ? 0 : execInCount(node);
  const outExec = isChild(node) ? 0 : execOutCount(node);
  if (dir === "in") {
    if (kind !== "data") return port;
    return inExec + PORT_GAP + port;
  }
  if (kind !== "data") return port;
  return outExec + PORT_GAP + port;
}

function sideRows(node, dir) {
  const exec = isChild(node) ? 0 : dir === "in" ? execInCount(node) : execOutCount(node);
  const data = dir === "in" ? dataInCount(node) : dataOutCount(node);
  return exec + (data ? data + PORT_GAP : 0);
}

function totalPortRows(node) {
  return Math.max(sideRows(node, "in"), sideRows(node, "out"));
}

/** How tall a leaf box is, from the same numbers the DOM lays it out with. */
function leafHeight(node) {
  // The estimate below is close, but the real box is what the browser lays out
  // (fonts, wrapping, a textarea's own height). Once a node has been rendered,
  // its measured height is kept on it as a non-enumerable `_h`: it is geometry,
  // not data, so it is dropped by `structuredClone` and by JSON, and a block
  // that grows to hold its body grows to the *real* size.
  if (Number.isFinite(node?._h) && node._h > 0) return node._h;
  const def = NODE_TYPES[node?.type];
  const params = def?.params ?? [];
  let paramsH = 0;
  if (params.length) {
    paramsH = 8 + params.length * 5;
    for (const p of params) paramsH += PARAM_H[p.type] ?? 36;
  }
  // An object card carries the rail its behaviours hang from, so the estimate
  // has to count it: the first behaviour starts at the card's bottom edge.
  const rows = totalPortRows(node);
  const portsH = rows ? PORTS_TOP * 2 + rows * PORT_ROW_H : 0;
  const dockH = isCallNode(node?.type) ? DOCK_H : 0;
  return HEADER_H + portsH + paramsH + dockH;
}

/**
 * The rectangle a node occupies in world coordinates.
 *
 * Leaves are a fixed width and a height derived from their sockets and fields.
 * Containers grow to hold what is inside them, so their rectangle is the union
 * of what the user resized them to and what their children need — that is what
 * keeps a dropped node from spilling out of the box that owns it.
 */
export function nodeRect(node, nodes = []) {
  if (isContainer(node?.type)) {
    return containerRect(node, nodes);
  }
  return { x: node?.x ?? 0, y: node?.y ?? 0, w: NODE_W, h: leafHeight(node) };
}

/** The rectangle a block occupies, hugging the nodes inside it. */
export function containerRect(node, nodes = []) {
  const lanes = Math.max(1, containerLanes(node).length);
  let w = Math.max(node?.w ?? 0, lanes * LANE_MIN_W + CONTAINER_PAD * 2, CONTAINER_MIN_W);
  let h = Math.max(node?.h ?? 0, CONTAINER_MIN_H);
  let right = (node?.x ?? 0) + w;
  let bottom = (node?.y ?? 0) + h;
  for (const child of nodes) {
    if (child.parent !== node.id) continue;
    const r = nodeRect(child, nodes);
    right = Math.max(right, r.x + r.w + CONTAINER_PAD);
    bottom = Math.max(bottom, r.y + r.h + CONTAINER_PAD);
  }
  return { x: node?.x ?? 0, y: node?.y ?? 0, w: right - (node?.x ?? 0), h: bottom - (node?.y ?? 0) };
}

/**
 * The bands a block's body is divided into, left to right.
 *
 * A band is where its statements are dropped: the first one for 成立, the second
 * for 否则, one per option of a choice. Their geometry is only a guide — a node
 * belongs to a band because `parentPort` says so, not because of where it sits —
 * but a drop picks the band under the pointer, and a body reads left to right.
 */
export function laneRects(node, nodes = []) {
  const rect = containerRect(node, nodes);
  const lanes = containerLanes(node);
  const top = rect.y + CONTAINER_HEAD_H + CONTAINER_LANE_HEAD_H;
  const height = Math.max(0, rect.y + rect.h - top);
  const width = (rect.w - CONTAINER_PAD * 2) / Math.max(1, lanes.length);
  return lanes.map((lane, i) => ({
    label: lane.label,
    port: i,
    x: rect.x + CONTAINER_PAD + i * width,
    y: top,
    w: width,
    h: height,
  }));
}

/** The band of a block a world point falls in, clamped to a real one. */
export function laneAt(node, x, nodes = []) {
  const rect = containerRect(node, nodes);
  const lanes = Math.max(1, containerLanes(node).length);
  const width = (rect.w - CONTAINER_PAD * 2) / lanes;
  if (width <= 0) return 0;
  const index = Math.floor((x - rect.x - CONTAINER_PAD) / width);
  return Math.min(lanes - 1, Math.max(0, index));
}

/** Centre of one socket, in world (canvas) coordinates. */
export function portPoint(node, dir, port, kind = "exec", nodes = []) {
  // A block has one socket on each side, level with the middle of its header,
  // so a wire can never be mistaken for one of the lanes inside it.
  if (isContainer(node?.type)) {
    const rect = containerRect(node, nodes);
    const y = rect.y + CONTAINER_HEAD_H / 2;
    return { x: dir === "in" ? rect.x : rect.x + rect.w, y };
  }
  // Every other socket — including a behaviour's 行为 pair — sits on the port
  // band below the header, at the same row `portLocalY` uses for the DOM. The
  // two must agree exactly: a mismatch is a wire that lands on the card's title
  // instead of on its socket.
  const row = portRow(node, dir, kind, port);
  return {
    x: dir === "in" ? node.x : node.x + NODE_W,
    y: node.y + HEADER_H + PORTS_TOP + row * PORT_ROW_H + PORT_ROW_H / 2,
  };
}

// The local (relative to the ports container) Y of a socket, used for the DOM
// `top` style; mirrors `portPoint`'s row arithmetic.
function portLocalY(node, dir, kind, port) {
  return PORTS_TOP + portRow(node, dir, kind, port) * PORT_ROW_H + PORT_ROW_H / 2;
}

/**
 * An SVG path for a wire from `a` to `b`.
 *
 * The two control points are pulled horizontally out of each socket, so a wire
 * always leaves an output to the right and enters an input from the left. How
 * far depends on the horizontal gap, which keeps a short hop tidy and gives a
 * wire that doubles back a wide loop instead of a straight line through both
 * nodes.
 */
export function wirePath(a, b) {
  const dx = Math.max(36, Math.abs(b.x - a.x) * 0.55);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/**
 * Resolves a completed drag into an edge, or null when the two ends do not fit.
 *
 * A wire has one output end and one input end whatever the user grabbed first,
 * so the anchor is put on whichever side it belongs to. An input takes one wire,
 * which the caller replaces. Exec and data wires are kept strictly apart by
 * `kind`, and so are behaviour wires: a 行为 socket only ever takes a behaviour.
 *
 * The fan-out rule is enforced by the caller, which is the only place that knows
 * the graph: see `outputCanFanOut`.
 */
export function linkEnds(anchor, target) {
  if (!anchor || !target) return null;
  if (anchor.node === target.node) return null;
  const ak = anchor.kind || "exec";
  const tk = target.kind || "exec";
  if (ak !== tk) return null;
  const anchorOut = anchor.dir === "out";
  const from = anchorOut ? anchor : target;
  const to = anchorOut ? target : anchor;
  if (from.dir !== "out" || to.dir !== "in") return null;
  return {
    from: { node: from.node, port: from.port },
    to: { node: to.node, port: to.port },
    kind: ak,
  };
}

/**
 * Whether an output that already leads somewhere may lead somewhere else too.
 *
 * Serial is the default: a statement has exactly one next statement, so 开始 can
 * only lead to one node — chaining 开始 → 背景 → 角色 is the way to run both. A
 * parallel node (并行 blocks, and the statements inside one) is the exception:
 * its outputs all start together, which is what fanning out means.
 */
export function outputCanFanOut(nodes, nodeId) {
  const node = nodes.find((n) => n.id === nodeId);
  return isParallelNode(node, nodes);
}

/**
 * The next free `prefixN` id among `items`.
 *
 * Both nodes and edges are numbered this way, so the caller passes the list it
 * is numbering. Counting only nodes made every edge "e1": two wires then shared
 * an id, and selecting one selected all of them.
 */
export function nextId(items, prefix) {
  let max = 0;
  for (const item of items) {
    const m = /^([a-z]+)(\d+)$/.exec(item.id);
    if (m && m[1] === prefix) {
      max = Math.max(max, Number(m[2]));
    }
  }
  return `${prefix}${max + 1}`;
}

// --- graph shape / serialization ---

/** The camera a fresh canvas starts with. */
export function defaultView() {
  return { ox: 40, oy: 40, scale: DEFAULT_SCALE };
}

/**
 * `.flowmap` format version. Version 4 adds `groups`: purely visual, named and
 * coloured rectangles around a set of nodes. Groups never reach the generated
 * script, so older files need nothing but the empty array.
 */
export const GRAPH_VERSION = 4;

export function emptyGraph() {
  return {
    version: GRAPH_VERSION,
    view: defaultView(),
    nodes: [{ id: "n1", type: "Start", x: 140, y: 140, params: {} }],
    edges: [],
    dataEdges: [],
    groups: [],
  };
}

export function serializeGraph(graph) {
  return JSON.stringify(graph, null, 2);
}

/**
 * Reads a `.flowmap`, filling in what older files left out.
 *
 * `view` is the camera: it is remembered per map so reopening one lands where it
 * was left, and a file written before it existed simply has none — the caller
 * frames the graph instead.
 *
 * Blocks used to be plain nodes with one output per branch, wired to the first
 * statement of each branch. Those files still open: the node becomes a block
 * again and the statement at the end of each branch wire is adopted into the
 * matching lane, which is the same scene the wires described.
 *
 * The object model changed since the first `.flowmap` was written, and the
 * change is repaired here rather than left for the user to redo by hand: an
 * object's variable used to be called `name` (now `objectName`), one box used to
 * be both the definition and the call (now a 新对象 + type node beside the flow,
 * and a 对象 node in it), and behaviours used to be wired (now stacked under
 * their object).
 */
export function parseGraph(text) {
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.nodes) && Array.isArray(data.edges)) {
      return normalizeGraph(data);
    }
  } catch {
    // Fall through to an empty graph; the caller reports the recovery.
  }
  return emptyGraph();
}

/**
 * Brings a document up to the shape this build writes, in place.
 *
 * Every reader goes through here — a file on disk, a reverse parse, an undo
 * snapshot — so a graph that arrives from anywhere ends up with one 开始, a name
 * on each object, and a behaviour stack rather than behaviour wires.
 *
 * Version 1 wrote a block's branches as wires out of the block; version 2 moved
 * the body inside the box. Version 3 split the object box in two — a definition
 * and a call — and replaced behaviour wires with a stack. Each step reads the
 * previous shape once and is skipped afterwards, so the repairs never run twice
 * over a file that is already current.
 *
 * @param {object} graph
 * @returns {object} The same graph.
 */
export function normalizeGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return graph;
  }
  if (!Array.isArray(graph.dataEdges)) graph.dataEdges = [];
  graph.view = normalizeView(graph.view);
  const version = Number(graph.version ?? 1);
  if (version < 2) {
    migrateBranchWires(graph);
    graph.version = 2;
  }
  migrateObjectNames(graph);
  if (Number(graph.version ?? 1) < 3) {
    // The wires are the truth about a chain in a v2 file, so they are read into
    // `behaviorOf` before the pile is rebuilt as a stack.
    migrateBehaviorOwners(graph);
    migrateObjects(graph);
    graph.version = 3;
  }
  // 执行流为单一线性结构，因此只有一个界面文案「开始」节点。
  // The flow is a single line, so there is one `开始` (Start) node.
  dedupeStart(graph);
  // Version 4 only adds the visual `groups` array. Older files and reverse
  // parses have none, so the migration is one empty array plus a version bump;
  // every reader (disk, reverse parse, undo snapshot) passes through here, and
  // running it twice must not change the graph.
  normalizeGroups(graph);
  if (Number(graph.version ?? 1) < GRAPH_VERSION) graph.version = GRAPH_VERSION;
  return graph;
}

/**
 * Gives every object node a usable `objectName`.
 *
 * The first object nodes called their variable `name`, which is now the
 * behaviour table's word for a *method*; a file from that era carries
 * `params.name` and no `objectName`, and reading it as-is emitted
 * `# 角色名无效: ""` even though the box on screen showed a name — because what
 * it showed was the field's default, not the model.
 */
export function migrateObjectNames(graph) {
  let changed = false;
  for (const node of graph.nodes) {
    // Every node that names a variable: the two halves of a definition and the
    // call node between them.
    if (!isDeclareNode(node.type) && !isCallNode(node.type) && !isLegacyObjectNode(node)) {
      continue;
    }
    const params = node.params ?? (node.params = {});
    if (!params.objectName && params.name) {
      params.objectName = params.name;
      changed = true;
    }
    // `name` is not an object field any more; leaving it behind would let a
    // stale key win over the new one on the next read.
    if (Object.prototype.hasOwnProperty.call(params, "name")) {
      delete params.name;
      changed = true;
    }
    if (!params.objectName) {
      params.objectName = NODE_TYPES[node.type].params?.find((p) => p.key === "objectName")?.default ?? "obj";
      changed = true;
    }
  }
  return changed;
}

/**
 * Recomputes every behaviour's object from the wires.
 *
 * `behaviorOf` is a cache of "which object does this chain start from", and the
 * wires are the truth. A file written before the cache existed has none, so the
 * canvas would draw every behaviour as 未连接 and the generated script would
 * report them as orphaned — even though the wires were right there.
 */
export function migrateBehaviorOwners(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of graph.edges ?? []) {
    if (e.to.port === 0) incoming.set(e.to.node, e.from.node);
  }
  let changed = false;
  const ownerOf = (node, seen = new Set()) => {
    if (!node || seen.has(node.id)) return null;
    seen.add(node.id);
    const from = byId.get(incoming.get(node.id));
    if (!from) return null;
    // Fed by an object: that object owns the chain.
    if (!isBehaviorNode(from.type)) return from.id;
    // Fed by another behaviour: same object, further up the chain.
    return ownerOf(from, seen);
  };
  for (const node of graph.nodes) {
    if (!isBehaviorNode(node.type)) continue;
    const next = ownerOf(node) ?? null;
    if ((node.behaviorOf ?? null) !== next) {
      node.behaviorOf = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * Whether a node is one of the old single-box objects.
 *
 * Version 3 split "build this" from "use this". A file from before that has one
 * node doing both — `Character` with a name, a picture and its behaviour wires
 * — and the generic `Object`, which carried its type as a parameter instead.
 */
function isLegacyObjectNode(node) {
  if (!node) return false;
  if (node.type === "Background" || node.type === "Character" || node.type === "Audio") {
    return true;
  }
  return node.type === "Object" && Object.hasOwn(node.params ?? {}, "objectType");
}

/**
 * Rewrites old single-box objects into the definition + call pair.
 *
 * A `Character` box used to be both `hero = Character("…")` and the place the
 * flow passed through, with its behaviours hanging off a 行为 socket. It now
 * becomes three things, placed so the canvas still reads the same way:
 *
 *   新对象(hero) ──赋值──▶ 角色("…")      beside the old spot, out of the flow
 *   对象(hero)                            exactly where the old box was
 *
 * The old 执行 wires are re-pointed at the 对象 node, which is what keeps the
 * scene's order. Behaviours move from wires to the stack: they are laid out
 * under their object in the order the wires gave them, and every 行为 wire is
 * dropped — the canvas no longer draws them, and leaving them would put the
 * behaviours back in the flow.
 */
export function migrateObjects(graph) {
  const legacy = (graph.nodes ?? []).filter(isLegacyObjectNode);
  if (!legacy.length) return false;
  const edges = graph.edges ?? (graph.edges = []);
  const nodes = graph.nodes;

  for (const old of legacy) {
    const p = old.params ?? {};
    const type = old.type === "Object" ? String(p.objectType ?? "Background") : old.type;
    const name = String(p.objectName ?? "").trim() || NAME_BASES[type] || "obj";
    // The old character box already carried a place; it becomes an argument of
    // the constructor rather than a `move` the flow had to pass through.
    const placed = type === "Character" && (asNumber(p.x) !== 0 || asNumber(p.y) !== 0);
    const typeKey = `Type${type}${placed ? "Adv" : ""}`;
    const params = NODE_TYPES[typeKey]?.params ?? [];
    const typeParams = {};
    for (const param of params) typeParams[param.key] = param.default;
    if (type === "Audio") typeParams.file = p.file ?? p.image ?? "";
    else typeParams.image = p.image ?? p.file ?? "";
    if (placed) {
      typeParams.x = asNumber(p.x);
      typeParams.y = asNumber(p.y);
      typeParams.scale = 1;
    }

    const declare = {
      id: nextId(nodes, "n"),
      type: "NewObject",
      x: Math.round(old.x - 360),
      y: Math.round(old.y - 20),
      params: { objectName: name },
    };
    nodes.push(declare);
    const ctor = {
      id: nextId(nodes, "n"),
      type: NODE_TYPES[typeKey] ? typeKey : "TypeCharacter",
      x: declare.x,
      y: Math.round(declare.y + leafHeight(declare) + 40),
      params: typeParams,
    };
    nodes.push(ctor);
    const call = {
      id: nextId(nodes, "n"),
      type: "Object",
      x: old.x,
      y: old.y,
      params: { objectName: name },
    };
    nodes.push(call);
    edges.push({
      id: nextId(edges, "e"),
      from: { node: declare.id, port: 0 },
      to: { node: ctor.id, port: 0 },
    });

    // The old box's place in the flow becomes the call node's.
    for (const edge of edges) {
      if (edge.from.node === old.id) edge.from.node = call.id;
      if (edge.to.node === old.id) edge.to.node = call.id;
    }

    // Behaviours: adopted by the call node, then stacked under it.
    const adopted = nodes
      .filter((n) => isBehaviorNode(n.type) && n.behaviorOf === old.id)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    let y = Math.round(call.y + leafHeight(call) + 20);
    for (const behavior of adopted) {
      behavior.behaviorOf = call.id;
      behavior.x = call.x;
      behavior.y = y;
      y += leafHeight(behavior) + 10;
    }

    // The old box is gone, and so is every wire it used to draw.
    const at = nodes.indexOf(old);
    if (at >= 0) nodes.splice(at, 1);
  }

  // A 行为 wire has no meaning any more: the stack is the chain.
  graph.edges = edges.filter((e) => !isBehaviorWire(graph, e));
  return true;
}

/** Whether a wire feeds a behaviour node's old 行为 socket. */
function isBehaviorWire(graph, edge) {
  const to = graph.nodes.find((n) => n.id === edge.to.node);
  const from = graph.nodes.find((n) => n.id === edge.from.node);
  return Boolean(
    (to && isBehaviorNode(to.type)) || (from && isBehaviorNode(from.type)),
  );
}

/**
 * Leaves at most one 开始 on the canvas.
 *
 * The flow is one line, so a second 开始 would be a second script with no way to
 * say which came first. A file that has one — written by hand, or by an older
 * build that allowed it — keeps the first and drops the rest, wires and all.
 */
export function dedupeStart(graph) {
  const starts = (graph.nodes ?? []).filter((n) => n.type === "Start");
  if (starts.length <= 1) return false;
  const [keep, ...extra] = starts;
  const drop = new Set(extra.map((n) => n.id));
  graph.nodes = graph.nodes.filter((n) => !drop.has(n.id));
  graph.edges = (graph.edges ?? []).filter(
    (e) => !drop.has(e.from.node) && !drop.has(e.to.node),
  );
  graph.dataEdges = (graph.dataEdges ?? []).filter(
    (e) => !drop.has(e.from.node) && !drop.has(e.to.node),
  );
  return keep.id !== "";
}

/**
 * Folds a pre-block file's branch wires into block membership.
 *
 * In the old shape a Choice/If/While had one exec output per branch and the
 * statement on each output *was* the branch. In the new shape the block owns its
 * body, so that statement (and, through the exec chain, the rest of the branch)
 * becomes a child of the block. Every adopted node keeps its place, and the body
 * is laid out inside its lane, so the scene still reads the way it was drawn.
 */
export function migrateBranchWires(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const node of graph.nodes) {
    if (!NODE_TYPES[node.type]?.container) continue;
    if (node.w === undefined) node.w = CONTAINER_MIN_W;
    if (node.h === undefined) node.h = CONTAINER_MIN_H;
    // The branches are the nodes on this block's outputs, and everything the
    // exec chain reaches from each of them.
    const outgoing = graph.edges.filter((e) => e.from.node === node.id);
    for (const edge of outgoing) {
      let cur = edge.to.node;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const child = byId.get(cur);
        if (!child || child.parent) break;
        child.parent = node.id;
        child.parentPort = edge.from.port;
        const next = graph.edges.find((e) => e.from.node === cur && e.from.port === 0);
        cur = next ? next.to.node : null;
      }
    }
    // A body's own order is its layout, so the wires that placed it are gone.
    graph.edges = graph.edges.filter((e) => e.from.node !== node.id);
  }
  layoutBodies(graph);
  return true;
}

/**
 * Gives every block body a tidy layout: one node per row, top to bottom, inside
 * its own lane.
 *
 * Bodies are ordered by position, so a file that was written by hand (or
 * migrated from wires) has nodes stacked wherever they happened to be. Laying
 * them out here means the canvas never opens with two statements on top of each
 * other — the order they already had is preserved, since the sort is stable on
 * the same reading order.
 */
export function layoutBodies(graph) {
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Deepest blocks first: a block's own size depends on its children.
  const blocks = nodes
    .filter((n) => NODE_TYPES[n.type]?.container)
    .sort((a, b) => depthIn(byId, b) - depthIn(byId, a));
  for (const block of blocks) {
    if (block.w === undefined) block.w = CONTAINER_MIN_W;
    if (block.h === undefined) block.h = CONTAINER_MIN_H;
    const lanes = containerLanes(block);
    for (let port = 0; port < lanes.length; port += 1) {
      const lane = laneRects(block, nodes).find((l) => l.port === port);
      if (!lane) continue;
      const body = childrenOf(nodes, block.id, port);
      // The first row clears the lane's label band, so a statement never sits
      // under the band that names it.
      let y = lane.y + BODY_TOP;
      for (const child of body) {
        child.x = Math.round(lane.x + BODY_LEFT);
        child.y = Math.round(y);
        y += nodeRect(child, nodes).h + BODY_GAP;
      }
    }
  }
}

/** Space kept between a lane's label band and the first statement in it. */
const BODY_TOP = 34;
/** Space kept between a lane's left edge and its statements. */
const BODY_LEFT = 14;
/** Space between two statements of a body. */
const BODY_GAP = 14;
/** How far a call may be dragged out of its object's column before it lets go. */
const BEHAVIOR_DETACH = 90;

function depthIn(byId, node) {
  let depth = 0;
  let cur = node;
  const seen = new Set();
  while (cur?.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    cur = byId.get(cur.parent);
    if (!cur) break;
    depth += 1;
  }
  return depth;
}

/** A camera that can be trusted, or null when the file did not carry one. */
export function normalizeView(view) {
  if (!view || typeof view !== "object") return null;
  const ox = Number(view.ox);
  const oy = Number(view.oy);
  const scale = Number(view.scale);
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(scale)) return null;
  return {
    ox: Math.round(ox),
    oy: Math.round(oy),
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 1000) / 1000)),
  };
}

// --- inference to Pamela ---

const quote = (value) => JSON.stringify(String(value ?? ""));

const asNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// A Pamela identifier, or null when the name cannot be used as one.
const asIdent = (value) => {
  const name = String(value ?? "").trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
};

/** Whether a parameter was left at the value that means "do nothing". */
const isOn = (value, fallback = true) => (value === undefined ? fallback : Boolean(value));

/**
 * The constructor a node type stands for.
 *
 * A type node (角色 / 背景 / 音频 / 它们的「高级」) knows its own; the older
 * single-box object node carried it as a parameter, and still answers that way
 * so a file written before the split can be read.
 */
export function objectTypeOf(node) {
  const def = NODE_TYPES[node?.type];
  if (def?.typeOf) return def.typeOf;
  const chosen = String(node?.params?.objectType ?? "").trim();
  if (NODE_TYPES[chosen]?.typeOf) return NODE_TYPES[chosen].typeOf;
  return chosen || "Character";
}

/**
 * The variable an object node is assigned to, or null when it cannot be one.
 *
 * The field's own default is used only when the model carries nothing: the
 * box on screen shows that default, so a node the user has never touched must
 * emit the name they can see. A name that was written but is not a usable
 * identifier is *not* replaced — silently renaming `3bad` to `hero` would hide
 * the mistake instead of reporting it.
 */
export function objectNameOf(node) {
  const raw = node?.params?.objectName;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    return asIdent(raw);
  }
  const fallback = NODE_TYPES[node?.type]?.params?.find((p) => p.key === "objectName")?.default;
  return asIdent(fallback);
}

/** The resource a type's constructor takes: a picture, a file, or words. */
function resourceOf(type, params) {
  const p = params ?? {};
  if (type === "Effect") return p.effect ?? "rain";
  if (type === "Text") return p.text ?? "";
  if (type === "Light") return p.color ?? "#ffffff";
  if (type === "Audio" || type === "Video") return p.file ?? p.image ?? "";
  return p.image ?? p.file ?? "";
}

/** How many objects of each kind a scene usually has, for a fresh name. */
const NAME_BASES = {
  Background: "bg",
  Character: "ch",
  Audio: "bgm",
  Effect: "ef",
  Video: "clip",
  Text: "txt",
  Light: "lamp",
  Array: "group",
};

/**
 * The type node a 新对象 builds itself with.
 *
 * The 赋值 wire is the whole link between the two halves of a definition, and
 * there is at most one: an input takes one wire, so a second type node simply
 * replaces the first. A 新对象 with no type node is still a name — it emits a
 * comment rather than a broken line.
 */
export function typeNodeFor(graph, declareNode) {
  const edge = (graph.edges ?? []).find(
    (e) => e.from.node === declareNode.id && e.from.port === 0,
  );
  if (!edge) return null;
  const node = (graph.nodes ?? []).find((n) => n.id === edge.to.node);
  return node && isTypeNode(node.type) ? node : null;
}

/**
 * The declaration a call node names, or null when nothing declares it.
 *
 * A 对象 node is only a name: what it is built from lives in the 新对象 / type
 * pair, which is why the canvas has to look the name up before it knows whether
 * `ch.front()` is even a call the object answers to.
 */
export function declarationNamed(graph, name, before = null) {
  const wanted = String(name ?? "").trim();
  if (!wanted) return null;
  const declarations = (graph.nodes ?? []).filter(
    (n) => isDeclareNode(n.type) && String(n.params?.objectName ?? "").trim() === wanted,
  );
  if (!declarations.length) return null;
  if (!before) return declarations[0];
  // A definition placed before the call is the one it means: an object may be
  // rebuilt mid-scene, and the later definition is what is live by then.
  const earlier = declarations.filter(
    (n) => n.y < before.y || (n.y === before.y && n.x <= before.x),
  );
  const pool = earlier.length ? earlier : declarations;
  return pool.reduce((best, n) => (n.y > best.y || (n.y === best.y && n.x > best.x) ? n : best));
}

/** The constructor a call node's variable was built with, or null. */
function objectTypeIn(graph, node) {
  if (isTypeNode(node?.type)) return objectTypeOf(node);
  const name = objectNameOf(node);
  if (!name) return null;
  const declaration = declarationNamed(graph, name, node);
  const typeNode = declaration ? typeNodeFor(graph, declaration) : null;
  return typeNode ? objectTypeOf(typeNode) : null;
}

/**
 * The lines that build an object: `hero = Character("…")`, with the arguments
 * the type node's own fields ask for.
 *
 * The 高级 types are the whole reason named arguments exist: a character that
 * starts off the centre and at twice its size is one call —
 * `Character("ch.png", x = -300, y = -500, scaleTo = 2)` — rather than a
 * constructor followed by three behaviours that the flow has to pass through.
 *
 * @param {object} declareNode The 新对象 node (its name is the variable).
 * @param {object | null} typeNode The constructor, or null when none is wired.
 * @returns {string[]} Raw lines.
 */
function declarationLines(declareNode, typeNode) {
  const ident = objectNameOf(declareNode);
  const written = declareNode.params?.objectName;
  if (!ident) {
    return [`# 对象名无效: ${quote(written)}`];
  }
  if (!typeNode) {
    return [`# ${ident} 还没有接上类型（用 赋值 接到 角色 / 背景 / 音频）`];
  }
  const type = objectTypeOf(typeNode);
  const p = typeNode.params ?? {};
  // A group takes object names, not a quoted path: `group = Array(ch, bg)`.
  const args = type === "Array"
    ? [String(p.members ?? "").trim()]
    : [quote(resourceOf(type, p))];
  if (NODE_TYPES[typeNode.type]?.advanced) {
    const x = asNumber(p.x);
    const y = asNumber(p.y);
    const scale = Number(p.scale);
    // A zero says nothing — a new object is at the origin already — and leaving
    // it out is what keeps the line readable: `Character("ch.png")` is a
    // character in the middle.
    if (x !== 0) args.push(`x = ${x}`);
    if (y !== 0) args.push(`y = ${y}`);
    if (Number.isFinite(scale) && scale !== 1 && scale !== 0) {
      args.push(`scaleTo = ${scale}`);
    }
  }
  return [`${ident} = ${type}(${args.join(", ")})`];
}

/**
 * Every definition on the canvas, in reading order.
 *
 * These are emitted *before* the flow, always: a name has to exist before a
 * statement can use it, and the canvas no longer threads definitions through
 * the flow to guarantee that. Reading order — top to bottom, then left to right
 * — is what an author sees, so a later definition wins over an earlier one, the
 * way a rebuilt variable does at run time.
 */
export function declarationLinesOf(graph) {
  const nodes = graph.nodes ?? [];
  const lines = [];
  const declarations = nodes
    .filter((n) => isDeclareNode(n.type))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const node of declarations) {
    lines.push(...declarationLines(node, typeNodeFor(graph, node)));
  }
  return lines;
}

/**
 * The arguments a behaviour node passes, in the order its spec declares them.
 *
 * A duration of 0 means "at once", which Pamela spells by leaving the argument
 * off — so a zero tail is dropped rather than written out. An empty text field
 * is written as an empty string only where the method needs it (`say`), and is
 * otherwise dropped, so `ch.enable()` does not become `ch.enable("")`.
 */
function behaviorArgs(node) {
  const method = behaviorMethodOf(node.type);
  const spec = BEHAVIOR_SPECS[method];
  if (!spec) return [];
  const p = node.params ?? {};
  const values = [];
  for (const param of spec.params) {
    // An `extra` parameter is not an argument of the call: the path frame
    // replaces the move, so it is read by `behaviorCall` rather than passed.
    if (param.extra) continue;
    const raw = p[param.key];
    if (param.type === "number") {
      const n = Number(raw);
      values.push(Number.isFinite(n) ? n : 0);
    } else if (param.type === "index") {
      // A position may be written as a number or as a picture name; a name is
      // a string the runtime compares, a position is the number itself.
      const text = String(raw ?? "").trim();
      if (!text) {
        if (param.omitEmpty) continue;
        values.push(quote(text));
      } else {
        values.push(/^\d+$/.test(text) ? text : quote(text));
      }
    } else if (param.type === "list") {
      // A variable-length call (a sprite group's pictures) is one text field on
      // the node and one argument per picture in the script.
      for (const one of String(raw ?? "").split(/[,，\n]/)) {
        const name = one.trim();
        if (name) values.push(quote(name));
      }
    } else if (param.type === "multiline") {
      values.push(quote(raw ?? ""));
    } else if (param.type === "bool") {
      // A missing boolean is its default, which the runtime reads as "on"; only
      // an explicit `false` is written, because `mute()` already means mute on.
      values.push(raw === false ? "false" : "true");
    } else {
      const text = String(raw ?? "");
      // A key frame file is a path the runtime reads, not a variable: it is
      // always quoted, even when its stem happens to be a plain identifier
      // (`key-ch.keyframes` has a dot, but a renamed one may not).
      if (param.asset === "keyframes" || param.literal) {
        values.push(quote(text));
      } else {
        // An unquoted text field is a literal path/name, so it is quoted; a
        // field that already looks like code (`hero`, `"x"`) is passed through.
        values.push(/^[A-Za-z_]\w*$/.test(text) || text.startsWith('"') ? text : quote(text));
      }
    }
  }
  // A key with no file names none: the call falls back to the object's own
  // name, which is what a script written before the argument plays. Writing
  // `ch.key("")` instead would name a file that cannot exist.
  if (method === "key") {
    return values.filter((value) => value !== '""');
  }
  // Trailing zero durations are the default, so they are not written.
  while (values.length && values[values.length - 1] === 0) values.pop();
  return values;
}

/**
 * One behaviour node's call: `.enable()`, `.move(10, 20)`, `.say("…")`.
 *
 * A behaviour is emitted as a *chain* on the object, not as a statement of its
 * own: `ch → enable → say` becomes `ch.enable().say()`, which Pamela reads as
 * the two calls in order. When a behaviour has no chain predecessor it still
 * starts from the object, because that is the thing being called.
 */
function behaviorCall(node) {
  const method = behaviorMethodOf(node.type);
  const args = behaviorArgs(node);
  // A two-dot key (`VideoMedia.blur`) writes `.media.blur(…)` on its object.
  return `.${behaviorSuffix(method)}(${args.join(", ")})`;
}

/**
 * One or more Pamela statements for a node, as raw (un-indented) lines.
 *
 * Blocks and objects are handled by the walker, not here. `dataExprOf` resolves
 * any data wire feeding a parameter (e.g. a Character → Say speaker).
 */
function statementsFor(node, dataExprOf) {
  const p = node.params ?? {};
  // A `call:` node is one global / stage / dialog API. Its fields came from the
  // same table, so the call is built from the declared parameter names rather
  // than a remembered signature.
  if (node.type.startsWith("call:")) {
    const key = node.type.slice("call:".length);
    const spec = METHOD_SPECS.get(key);
    if (spec?.bulk || spec?.variadic) {
      const args = String(p.args ?? "").trim();
      return [`${globalCallName(key)}(${args})`];
    }
    const values = methodParams(key).map((name) => {
      const control = paramControl(name, key);
      const raw = p[name];
      if (control.type === "number") return String(Number(raw) || 0);
      if (control.type === "bool") return raw === false ? "false" : "true";
      return quote(String(raw ?? ""));
    });
    while (values.length && values[values.length - 1] === "0") values.pop();
    return [`${globalCallName(key)}(${values.join(", ")})`];
  }
  switch (node.type) {
    case "Say": {
      const dataSp = dataExprOf(node.id, 0);
      if (dataSp) {
        return [`dialog.say(${quote(p.text)}, ${dataSp})`];
      }
      return p.speaker
        ? [`dialog.say(${quote(p.text)}, ${quote(p.speaker)})`]
        : [`dialog.say(${quote(p.text)})`];
    }
    case "Wait":
      return [`wait ${asNumber(p.ms)}`];
    case "StageCall": {
      const target = dataExprOf(node.id, 0) || asIdent(p.target) || "hero";
      const method = p.method || "move";
      const args = String(p.args ?? "").trim();
      const time = String(p.time ?? "").trim();
      const list = [args, time].filter((part) => part.length > 0).join(", ");
      return [`${target}.${method}(${list})`];
    }
    case "SetVar": {
      const ident = asIdent(p.name);
      if (!ident) {
        return [`# 变量名无效: ${quote(p.name)}`];
      }
      const value = dataExprOf(node.id, 0) || (p.value ?? "null");
      return [`${ident} = ${value}`];
    }
    case "FuncCall": {
      const name = asIdent(p.name);
      if (!name) return [`# 函数名无效: ${quote(p.name)}`];
      return [`${name}(${String(p.args ?? "").trim()})`];
    }
    case "Return": {
      const value = dataExprOf(node.id, 0) || String(p.value ?? "").trim();
      return [value ? `return ${value}` : "return"];
    }
    case "Break":
      return ["break"];
    case "Continue":
      return ["continue"];
    case "Include":
      return [`include ${quote(p.file)}`];
    case "Jump":
      return [`jump(${quote(p.file)})`];
    case "Use":
      return [`use ${quote(p.file)}`];
    case "DialogEnable":
      return [`dialog.enable()`];
    case "DialogDisable":
      return [`dialog.disable()`];
    case "Filter": {
      const target = dataExprOf(node.id, 0) || asIdent(p.target) || "hero";
      const mode = p.mode || "rgbTo";
      if (mode === "hex") {
        return [`${target}.${mode}(${quote(p.hex ?? "#ffffff")})`];
      }
      return [`${target}.${mode}(${asNumber(p.r)}, ${asNumber(p.g)}, ${asNumber(p.b)})`];
    }
    default:
      return [];
  }
}

/**
 * The nodes of one block body, in the order they read.
 *
 * A body is a list of statements, so it reads top to bottom; two statements on
 * the same line read left to right. That is the same order a script is written
 * in, and it is the only thing deciding the order — a body has no wires, which
 * is what makes "where does the block end" a question with one answer.
 */
export function childrenOf(nodes, parentId, port) {
  return nodes
    .filter((n) => n.parent === parentId && (n.parentPort ?? 0) === port)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The world-space frame around a set of nodes, with room for the group's title.
 *
 * A container carries its own width and height; a leaf's height comes from its
 * card, so a frame never clips the node it holds. Coordinates are node centres,
 * the same convention the canvas uses everywhere.
 */
export function groupBounds(members) {
  const PAD = 28;
  const TITLE = 30;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const node of members) {
    const w = node.w ?? NODE_W;
    const h = node.h ?? leafHeight(node);
    x1 = Math.min(x1, node.x - w / 2);
    y1 = Math.min(y1, node.y - h / 2);
    x2 = Math.max(x2, node.x + w / 2);
    y2 = Math.max(y2, node.y + h / 2);
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: Math.round(x1 - PAD),
    y: Math.round(y1 - PAD - TITLE),
    w: Math.round(x2 - x1 + PAD * 2),
    h: Math.round(y2 - y1 + PAD * 2 + TITLE),
  };
}

/** The nodes fully inside a world-space rectangle — a marquee only takes whole cards. */
export function nodesWithinRect(nodes, rect) {
  return nodes.filter((node) => {
    const w = node.w ?? NODE_W;
    const h = node.h ?? leafHeight(node);
    return (
      node.x - w / 2 >= rect.x &&
      node.y - h / 2 >= rect.y &&
      node.x + w / 2 <= rect.x + rect.w &&
      node.y + h / 2 <= rect.y + rect.h
    );
  });
}

/**
 * Makes a document's groups usable: valid members only, one node in one group,
 * and every field present. Older files simply have no groups at all.
 */
export function normalizeGroups(graph) {
  if (!Array.isArray(graph.groups)) {
    graph.groups = [];
    return graph;
  }
  const nodeIds = new Set((graph.nodes ?? []).map((n) => n.id));
  const claimed = new Set();
  graph.groups = graph.groups
    .filter((group) => group && typeof group === "object")
    .map((group, i) => ({
      id: typeof group.id === "string" && group.id ? group.id : `g${i + 1}`,
      name: typeof group.name === "string" && group.name ? group.name : `组 ${i + 1}`,
      color: typeof group.color === "string" && group.color ? group.color : "#4aa3c4",
      x: Number.isFinite(group.x) ? group.x : 0,
      y: Number.isFinite(group.y) ? group.y : 0,
      w: Number.isFinite(group.w) ? group.w : 0,
      h: Number.isFinite(group.h) ? group.h : 0,
      members: [...new Set((Array.isArray(group.members) ? group.members : []).filter((id) => nodeIds.has(id)))],
    }))
    .map((group) => {
      const members = group.members.filter((id) => !claimed.has(id));
      for (const id of members) claimed.add(id);
      return { ...group, members };
    })
    .filter((group) => group.members.length > 0);
  return graph;
}

/**
 * The behaviours stacked under an object, in the order they run.
 *
 * A behaviour has no wires at all: it belongs to the object node it was dropped
 * on (`behaviorOf`) and its place in the chain is its place in the stack, read
 * top to bottom. That is the same rule a block's body follows, and it is what
 * keeps a scene's calls together visually instead of drawing a second, orange
 * flow beside the real one.
 */
export function behaviorsOf(nodes, objectId) {
  return nodes
    .filter((n) => n.behaviorOf === objectId && isBehaviorNode(n.type))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The behaviour that runs before `node` on the same object, or null when `node`
 * starts the chain.
 *
 * The answer is positional, not a wire: the neighbour above in the stack. It is
 * computed rather than stored so dragging a call up or down reorders the code,
 * which is the only edit a stack needs.
 */
export function behaviorParent(node, nodes, edges = []) {
  if (!isBehaviorNode(node?.type) || !node?.behaviorOf) return null;
  const siblings = behaviorsOf(nodes, node.behaviorOf);
  const at = siblings.findIndex((n) => n.id === node.id);
  return at > 0 ? siblings[at - 1] : null;
}

/**
 * Walks a behaviour chain from its head: `[enable, say, …]`.
 *
 * The chain is the tail of the stack from `head` down. `edges` is accepted for
 * the callers that still pass it (and for files written before the stack), and
 * is not needed: the order is the layout.
 */
export function behaviorChain(head, nodes, edges = []) {
  if (!isBehaviorNode(head?.type) || !head?.behaviorOf) {
    return head ? [head] : [];
  }
  const siblings = behaviorsOf(nodes, head.behaviorOf);
  const at = siblings.findIndex((n) => n.id === head.id);
  return at < 0 ? [head] : siblings.slice(at);
}

/**
 * Emits a whole script from the canvas.
 *
 * Two passes, in this order, and the order is the point:
 *
 *   1. Definitions. Every 新对象/类型 pair becomes one line, in reading
 *      order. They are emitted first, whatever their place on the canvas,
 *      because a name has to exist before the flow can use it — which is why
 *      the flow no longer has to be routed through an object to declare it.
 *   2. The flow. From 开始, along the 执行 wires. An 对象 node emits the
 *      calls stacked under it, and nothing else: its definition is already
 *      above, in the first pass.
 *
 * A block's body is ordered by layout rather than by wire, so "where does the
 * block end" is never in doubt.
 */
export function inferGraph(graph) {
  const nodes = graph.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const e of graph.edges ?? []) {
    out.set(`${e.from.node}:${e.from.port}`, e);
  }
  const dataTo = new Map();
  for (const e of graph.dataEdges ?? []) {
    dataTo.set(`${e.to.node}:${e.to.port}`, e);
  }

  const targetOf = (nodeId, port) => {
    const edge = out.get(`${nodeId}:${port}`);
    return edge ? edge.to.node : null;
  };

  const dataFrom = (nodeId, port) => {
    const e = dataTo.get(`${nodeId}:${port}`);
    return e ? e.from.node : null;
  };
  // Walks a chain of value nodes back to a Pamela expression. An object or a
  // SetVar answers with its variable name; an expression node (`??`, `and`,
  // `or`, `not`) recurses into its inputs and wraps them. Returns null when a
  // wire is missing, so a half-wired expression falls back to the text field.
  const exprOf = (nodeId) => {
    if (!nodeId) return null;
    const node = byId.get(nodeId);
    if (!node) return null;
    if (isCallNode(node.type) || isDeclareNode(node.type)) {
      return objectNameOf(node) ?? "null";
    }
    if (node.type === "SetVar") {
      return asIdent(node.params?.name) ?? "null";
    }
    if (node.type === "Nullish" || node.type === "And" || node.type === "Or") {
      const left = exprOf(dataFrom(node.id, 0));
      const right = exprOf(dataFrom(node.id, 1));
      if (!left || !right) return null;
      const op = node.type === "Nullish" ? "??" : node.type === "And" ? "and" : "or";
      return `(${left} ${op} ${right})`;
    }
    if (node.type === "Not") {
      const operand = exprOf(dataFrom(node.id, 0));
      if (!operand) return null;
      return `(not ${operand})`;
    }
    // Literals.
    if (node.type === "NumLit") return String(Number(node.params?.value) || 0);
    if (node.type === "BoolLit") return node.params?.value === false ? "false" : "true";
    if (node.type === "NullLit") return "null";
    if (node.type === "StrLit") return quote(String(node.params?.value ?? ""));
    // Binary operators: a wired socket wins; the field is the fallback.
    if (node.type === "Compare" || node.type === "Arith") {
      const fallback = (key) => String(node.params?.[key] ?? "").trim() || null;
      const left = exprOf(dataFrom(node.id, 0)) ?? fallback("left");
      const right = exprOf(dataFrom(node.id, 1)) ?? fallback("right");
      if (!left || !right) return null;
      const op = String(node.params?.op ?? (node.type === "Compare" ? "==" : "+"));
      return `(${left} ${op} ${right})`;
    }
    if (node.type === "ListLit") {
      const items = String(node.params?.items ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return `[${items.join(", ")}]`;
    }
    if (node.type === "Index") {
      const target = exprOf(dataFrom(node.id, 0))
        ?? (String(node.params?.target ?? "").trim() || null);
      if (!target) return null;
      const key = exprOf(dataFrom(node.id, 1))
        ?? (String(node.params?.key ?? "0").trim() || "0");
      return `${target}[${key}]`;
    }
    if (node.type === "Member") {
      const target = exprOf(dataFrom(node.id, 0))
        ?? String(node.params?.target ?? "").trim();
      const name = asIdent(node.params?.name);
      if (!target || !name) return null;
      return `${target}.${name}`;
    }
    if (node.type === "CallExpr") {
      const name = asIdent(node.params?.name);
      if (!name) return null;
      return `${name}(${String(node.params?.args ?? "").trim()})`;
    }
    return null;
  };
  const dataExprOf = (nodeId, port) => exprOf(dataFrom(nodeId, port));

  const visited = new Set();
  const lines = [];
  const indent = (depth) => "  ".repeat(depth);

  // One node: a statement, a block with its body walked lane by lane, or an
  // object followed by its behaviours.
  const emit = (node, depth) => {
    if (!node || !NODE_TYPES[node.type]) return;
    if (isBehaviorNode(node.type)) {
      // Reached through its object, never through the flow.
      return;
    }
    if (isContainer(node.type)) {
      const lanes = containerLanes(node);
      const body = (port, inner) => {
        for (const child of childrenOf(nodes, node.id, port)) {
          emit(child, inner);
        }
      };
      if (node.type === "Choice") {
        lines.push(`${indent(depth)}choice {`);
        lanes.forEach((lane, i) => {
          lines.push(`${indent(depth + 1)}${quote(lane.label)} {`);
          body(i, depth + 2);
          lines.push(`${indent(depth + 1)}}`);
        });
        lines.push(`${indent(depth)}}`);
      } else if (node.type === "If") {
        const cond = dataExprOf(node.id, 0) || (node.params?.cond ?? "true");
        lines.push(`${indent(depth)}if (${cond}) {`);
        body(0, depth + 1);
        lines.push(`${indent(depth)}}`);
        lines.push(`${indent(depth)}else {`);
        body(1, depth + 1);
        lines.push(`${indent(depth)}}`);
      } else if (node.type === "While") {
        const cond = dataExprOf(node.id, 0) || (node.params?.cond ?? "true");
        lines.push(`${indent(depth)}while (${cond}) {`);
        body(0, depth + 1);
        lines.push(`${indent(depth)}}`);
      } else if (node.type === "For") {
        const varName = asIdent(node.params?.var) || "i";
        const iter = dataExprOf(node.id, 0) || node.params?.iter || "[]";
        lines.push(`${indent(depth)}for ${varName} in ${iter} {`);
        body(0, depth + 1);
        lines.push(`${indent(depth)}}`);
      } else if (node.type === "Switch") {
        const expr = dataExprOf(node.id, 0) || node.params?.expr || "null";
        const cases = switchCases(node);
        lines.push(`${indent(depth)}switch ${expr} {`);
        cases.forEach((value, i) => {
          lines.push(`${indent(depth + 1)}case ${value} {`);
          body(i, depth + 2);
          lines.push(`${indent(depth + 1)}}`);
        });
        if (node.params?.hasDefault) {
          lines.push(`${indent(depth + 1)}default {`);
          body(cases.length, depth + 2);
          lines.push(`${indent(depth + 1)}}`);
        }
        lines.push(`${indent(depth)}}`);
      } else if (node.type === "Cue") {
        // A cue with a time argument starts its group and proceeds after that many
        // milliseconds (or waits for everything when -1, or not at all when 0).
        const cueTime = node.params?.time;
        const head = Number.isFinite(cueTime) && cueTime !== 0 ? `cue(${cueTime})` : "cue";
        lines.push(`${indent(depth)}${head} {`);
        body(0, depth + 1);
        lines.push(`${indent(depth)}}`);
      } else if (node.type === "FuncDef") {
        const fnName = asIdent(node.params?.name) || "fn";
        const args = String(node.params?.args ?? "")
          .split(",")
          .map((part) => asIdent(part.trim()))
          .filter(Boolean);
        lines.push(`${indent(depth)}func ${fnName}(${args.join(", ")}) {`);
        body(0, depth + 1);
        lines.push(`${indent(depth)}}`);
      }
      return;
    }
    if (isCallNode(node.type)) {
      // The object is already built (pass 1); this is where it is *used*. The
      // calls stacked under the node become one chain — `ch.enable().say(…)` —
      // which is the same thing as the calls on separate lines, written the way
      // the language lets a writer write them.
      const ident = objectNameOf(node);
      const chain = behaviorsOf(nodes, node.id);
      if (!ident) {
        lines.push(`${indent(depth)}# 对象名无效: ${quote(node.params?.objectName)}`);
        return;
      }
      if (!chain.length) {
        // Nothing to call: the node is a marker, and a bare name would be an
        // expression statement that does nothing.
        return;
      }
      // A name nothing declares would be a runtime error, so it is reported at
      // the place it is used rather than left for the script to fail on.
      if (!declarationNamed(graph, ident, node)) {
        lines.push(`${indent(depth)}# ${ident} 没有对应的「新对象」定义`);
      }
      lines.push(`${indent(depth)}${ident}${chain.map((b) => behaviorCall(b)).join("")}`);
      return;
    }
    if (isDeclareNode(node.type) || isTypeNode(node.type)) {
      // Emitted in pass 1; a definition is not a step in the flow.
      return;
    }
    for (const line of statementsFor(node, dataExprOf)) {
      lines.push(`${indent(depth)}${line}`);
    }
  };

  // Routes pair by name, one setter to one getter. The getter is a start point,
  // not a step: its own input is ignored, and it is only reached by jumping.
  const routeGetters = new Map();
  for (const node of nodes) {
    if (node.type !== "RouteGet") continue;
    const name = String(node.params?.name ?? "").trim();
    if (!name) continue;
    if (!routeGetters.has(name)) routeGetters.set(name, []);
    routeGetters.get(name).push(node);
  }
  for (const list of routeGetters.values()) {
    list.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  // Follows exec wires from one node to the next. A node that belongs to a
  // block is never reached this way: its body owns it. A route is not a step
  // either: the setter jumps straight to the getter's outgoing wire.
  const walk = (nodeId, depth) => {
    let cur = nodeId;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      if (node.type === "RouteSet") {
        const name = String(node.params?.name ?? "").trim();
        if (!name) {
          lines.push("# 路由名无效");
          break;
        }
        const getters = routeGetters.get(name) ?? [];
        if (getters.length !== 1) {
          lines.push(`# 路由${getters.length ? "重名" : "未配对"}: ${name}`);
          break;
        }
        const getter = getters[0];
        if (getter.parent) {
          lines.push(`# 路由不能放进容器: ${name}`);
          break;
        }
        cur = targetOf(getter.id, 0);
        continue;
      }
      if (node.type === "RouteGet") {
        cur = targetOf(cur, 0);
        continue;
      }
      if (!isChild(node)) {
        emit(node, depth);
      }
      cur = targetOf(cur, 0);
    }
  };

  // The flow. Only one 开始 exists, so this is one walk; a graph with none
  // still emits its definitions, which is what makes a canvas of nothing but
  // declarations a valid file.
  const start = nodes.find((n) => n.type === "Start");
  if (start) {
    walk(start.id, 0);
  }
  // A route inside a block cannot be jumped to without breaking the block's
  // closing brace, so it is reported instead of producing broken code.
  for (const node of nodes) {
    if (node.type !== "RouteSet" && node.type !== "RouteGet") continue;
    if (node.parent) {
      lines.push(`# 路由不能放进容器: ${String(node.params?.name ?? "").trim()}`);
    }
  }
  // A behaviour with no object is not in the flow at all — nothing would call
  // it — so it is reported rather than silently dropped.
  for (const node of nodes) {
    if (!isBehaviorNode(node.type)) continue;
    if (node.behaviorOf) continue;
    lines.push(`# 行为没有连到对象: ${behaviorMethodOf(node.type) ?? "?"}`);
  }
  // A function body is a definition too: it is emitted with the declarations,
  // above the main line, never as a step of it.
  const functionLines = [];
  const functions = nodes
    .filter((n) => n.type === "FuncDef")
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const fn of functions) {
    const before = lines.length;
    emit(fn, 0);
    functionLines.push(...lines.splice(before));
  }
  // Definitions first: the flow may use any of them, and a script is read top
  // to bottom.
  const all = [...declarationLinesOf(graph), ...functionLines, ...lines];
  return all.join("\n") + (all.length ? "\n" : "");
}

// --- editor ---

export function createGraphEditor({
  element,
  writeFile,
  openFile,
  setMessage = () => {},
  onStatus = () => {},
  onChange = () => {},
  onGenerate = null,
  onImport = null,
  onConfirm = null,
  // Called when the author asks to draw the path frame a move node walks. The
  // host opens the path editor; the node's own field is written back through
  // `assignPath`, so the canvas never has to know where paths are stored.
  onEditPath = null,
  // Answers the files a node's kind may name, so a file field can offer them as
  // a picker. The host supplies this because it owns the project tree; a canvas
  // with no host simply has no suggestions and every box stays free text.
  listAssets = () => [],
}) {
  element.dataset.built = "1";

  const view = defaultView();
  let graph = emptyGraph();
  let currentPath = "";
  let dirty = false;
  const nodeEls = new Map();
  // Group frames are layout-only elements; the model lives in `graph.groups`.
  const groupEls = new Map();
  let groupDialog = null;
  let groupColorMenu = null;
  let selected = null; // { kind: "node" | "edge", id }
  // Set when a file has no camera of its own: the canvas frames the graph as
  // soon as it has a size to frame it in.
  let pendingFit = false;

  const history = createHistory();

  // SVG elements must be created in the SVG namespace, otherwise they become
  // HTMLUnknownElement and paths are not rendered.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SVG_TAGS = new Set(["svg", "path", "line", "circle", "polyline", "g"]);

  const el = (tag, props = {}, children = []) => {
    const isSvg = SVG_TAGS.has(tag);
    const node = isSvg
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") {
        // SVGElement.className is an SVGAnimatedString; use the attribute.
        if (isSvg) {
          node.setAttribute("class", value);
        } else {
          node.className = value;
        }
      } else if (key === "text") {
        node.textContent = value;
      } else if (key === "dataset") {
        Object.assign(node.dataset, value);
      } else if (key.startsWith("on")) {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value);
      }
    }
    for (const child of [].concat(children)) {
      if (child) {
        node.append(child);
      }
    }
    return node;
  };

  // --- undo / redo ---

  // Snapshots the current graph *before* a mutation. Deduplicated so a flurry of
  // identical snapshots (e.g. re-focusing a field) does not flood the stack.
  function recordSnap() {
    const snap = serializeGraph(graph);
    const top = history.past[history.past.length - 1];
    if (top && serializeGraph(top) === snap) return;
    record(history, graph);
    refreshUndoButtons();
  }

  function applyGraph(obj) {
    graph = structuredClone(obj);
    if (!graph.dataEdges) graph.dataEdges = [];
    nodeEls.clear();
    groupEls.clear();
    world.querySelectorAll(".gnode, .ggroup").forEach((n) => n.remove());
    closeGroupDialog();
    closeGroupColorMenu();
    selected = null;
    renderAll();
    markDirty();
    refreshUndoButtons();
  }

  function undoGraph() {
    const prev = histUndo(history, graph);
    if (!prev) return false;
    applyGraph(prev);
    return true;
  }

  function redoGraph() {
    const next = histRedo(history, graph);
    if (!next) return false;
    applyGraph(next);
    return true;
  }

  // --- build static chrome ---

  const undoBtn = el("button", { class: "graph__btn", title: "撤销 (Ctrl+Z)", onclick: undoGraph }, [createIcon("undo")]);
  const redoBtn = el("button", { class: "graph__btn", title: "重做 (Ctrl+Shift+Z)", onclick: redoGraph }, [createIcon("redo")]);
  const zoomLabel = el("span", { class: "graph__zoom", text: "100%" });

  function refreshUndoButtons() {
    undoBtn.disabled = !histCanUndo(history);
    redoBtn.disabled = !histCanRedo(history);
  }

  const toolbar = el("div", { class: "graph__toolbar" }, [
    undoBtn,
    redoBtn,
    el("button", { class: "graph__btn", title: "生成 .pe（Pamela 可执行文件）", onclick: generatePamela }, [createIcon("play")]),
    el("button", { class: "graph__btn", title: "保存", onclick: () => save() }, [createIcon("save")]),
    el("button", { class: "graph__btn", title: "从生成的脚本反向解析", onclick: reverseImport }, [createIcon("reverse")]),
    el("span", { class: "graph__spacer" }),
    zoomLabel,
    el("button", { class: "graph__btn", title: "缩小", onclick: () => zoomBy(0.9) }, [createIcon("minus")]),
    el("button", { class: "graph__btn", title: "放大", onclick: () => zoomBy(1.1) }, [createIcon("plus")]),
    el("button", { class: "graph__btn", title: "适应内容", onclick: () => fitView() }, [createIcon("maximize")]),
    el("button", { class: "graph__btn", title: "回到 1:1", onclick: () => resetView() }, [createIcon("percent")]),
  ]);

  const viewport = el("div", { class: "graph__viewport", tabindex: "0" });
  const world = el("div", { class: "graph__world" });
  // The wire layer sits *outside* the world, sized to the viewport, and copies
  // the world transform. A zero-sized SVG paints nothing at all — that is why
  // the wires were invisible — and even a sized one clips what falls outside
  // its box, so it may not be the world's child.
  const svg = el("svg", { class: "graph__edges" });
  const hint = el("div", {
    class: "graph__hint",
    text: "双击空白处添加节点 · 双击「对象」给它加一个行为 · 把节点拖进「条件 / 循环 / 选择支」就是它的语句体 · 滚轮缩放、拖空白平移",
  });
  viewport.append(svg, world, hint);
  viewport.addEventListener("mousedown", onViewportMouseDown);
  viewport.addEventListener("contextmenu", (event) => {
    // Right-clicking a wire deletes it; on a node it opens the node's own menu
    // (create an object of this type, add a behaviour); elsewhere the browser
    // menu stays.
    // A group's title opens its colour / delete menu.
    const groupHead = event.target.closest?.(".ggroup__head");
    if (groupHead) {
      const group = (graph.groups ?? []).find((g) => g.id === groupHead.dataset.group);
      if (group) {
        event.preventDefault();
        openGroupColorMenu(group, event.clientX, event.clientY);
        return;
      }
    }
    const line = event.target.closest?.(".graph__edge");
    if (line) {
      event.preventDefault();
      removeEdge(line.dataset.edge);
      return;
    }
    const nodeEl = event.target.closest?.(".gnode");
    if (nodeEl) {
      const node = nodeById(nodeEl.dataset.node);
      if (node) {
        event.preventDefault();
        openNodeMenu(node, event.clientX, event.clientY);
      }
    }
  });

  // Double-click: on empty canvas it opens the node picker, and on an object it
  // opens the list of calls that object answers to. Double-clicking the object
  // is the shortcut for "add another call here" — the new node is created under
  // it, already attached, so the gesture needs no wire at all.
  viewport.addEventListener("dblclick", (event) => {
    // A double-click in a field is a double-click on a word, not a gesture on
    // the canvas: selecting text must not open a menu over it.
    if (event.target.closest?.("input, textarea, select")) {
      return;
    }
    // Double-clicking a group's title renames it in place.
    const titleEl = event.target.closest?.(".ggroup__title");
    if (titleEl) {
      const group = (graph.groups ?? []).find(
        (g) => g.id === titleEl.closest(".ggroup__head")?.dataset.group,
      );
      if (group) {
        event.preventDefault();
        event.stopPropagation();
        startRenameGroup(titleEl, group);
        return;
      }
    }
    const nodeEl = event.target.closest?.(".gnode");
    if (!nodeEl) {
      event.preventDefault();
      openPicker(event.clientX, event.clientY);
      return;
    }
    const node = nodeById(nodeEl.dataset.node);
    if (!node || !isCallNode(node.type)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openPicker(event.clientX, event.clientY, {
      only: (type) => isBehaviorNode(type),
      onPick: (type) => {
        const method = behaviorMethodOf(type);
        if (method) addBehavior(node, method);
      },
    });
  });

  element.replaceChildren(toolbar, viewport);

  // --- node picker (double-click menu) ---

  let picker = null; // { root, close }

  function closePicker() {
    picker?.close();
    picker = null;
  }

  /**
   * The searchable node menu.
   *
   * `onPick` is what makes this more than an "insert here" menu: dropping a wire
   * on empty canvas opens the same list with the wire still live, so choosing a
   * node there is choosing *what the wire leads to* — the new node is created
   * and wired in one gesture.
   *
   * `only` narrows the list (a behaviour socket only takes behaviours).
   */
  function openPicker(clientX, clientY, { onPick = null, only = null } = {}) {
    closePicker();
    const rect = element.getBoundingClientRect();
    const at = screenToWorld(clientX, clientY);

    const search = el("input", {
      class: "graph__picker-search",
      type: "text",
      placeholder: only ? "搜索行为…" : "搜索控件…",
    });
    // `only` may be used for a behaviour list or for the types a definition can
    // be built with; the placeholder says which, because a list of eight calls
    // and a list of five types look the same otherwise.
    if (only) {
      search.placeholder = "搜索…";
    }
    const list = el("div", { class: "graph__picker-list" });
    const root = el("div", { class: "graph__picker" }, [search, list]);

    const build = (query) => {
      const q = query.trim().toLowerCase();
      const rows = Object.entries(NODE_TYPES).filter(([type, def]) => {
        if (only && !only(type, def)) return false;
        // The flow is one line, so the list offers 开始 only while there is
        // none: a second one would be a second script with no first.
        if (type === "Start" && graph.nodes.some((n) => n.type === "Start")) return false;
        // A behaviour is listed by its method name as well as its title, so
        // typing `enable` finds 显示.
        const method = def.behavior ? String(def.behavior) : "";
        return (
          !q ||
          def.title.toLowerCase().includes(q) ||
          type.toLowerCase().includes(q) ||
          method.toLowerCase().includes(q)
        );
      });
      list.replaceChildren(
        ...rows.map(([type, def]) =>
          el("button", { class: "graph__picker-item", type: "button", dataset: { type } }, [
            el("span", { class: "graph__picker-name", text: def.title }),
            el("small", {
              class: "graph__picker-cat",
              text: def.container
                ? `${def.category} · 语句块`
                : def.declares
                  ? `${def.category} · 定义变量`
                  : def.typeOf
                    ? `${def.category} · 构造 ${def.typeOf}`
                    : def.call
                      ? `${def.category} · 调用`
                      : def.behavior
                        ? `行为 · ${def.behavior}()`
                        : def.category,
            }),
          ]),
        ),
      );
      if (rows.length === 0) {
        list.append(el("div", { class: "graph__picker-empty", text: "没有匹配的控件" }));
      }
    };
    build("");

    const pick = (type) => {
      close();
      if (onPick) {
        onPick(type);
      } else {
        addNode(type, { x: at.x, y: at.y });
      }
    };

    list.addEventListener("click", (event) => {
      const item = event.target.closest(".graph__picker-item");
      if (item) {
        pick(item.dataset.type);
      }
    });
    search.addEventListener("input", () => build(search.value));
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        close();
      } else if (event.key === "Enter") {
        const first = list.querySelector(".graph__picker-item");
        if (first) {
          pick(first.dataset.type);
        }
      }
    });
    search.addEventListener("mousedown", (e) => e.stopPropagation());

    // Click anywhere else dismisses the picker.
    const onDocDown = (event) => {
      if (!root.contains(event.target)) {
        close();
      }
    };
    document.addEventListener("mousedown", onDocDown, true);

    function close() {
      document.removeEventListener("mousedown", onDocDown, true);
      root.remove();
    }

    root.style.left = `${Math.min(clientX - rect.left, Math.max(8, rect.width - 240))}px`;
    root.style.top = `${Math.min(clientY - rect.top, Math.max(8, rect.height - 320))}px`;
    element.append(root);
    picker = { root, close };
    search.focus();
  }

  // --- node context menu ---

  let nodeMenu = null; // { root, close }

  function closeNodeMenu() {
    nodeMenu?.close();
    nodeMenu = null;
  }

  /**
   * The menu a node opens on right-click.
   *
   * On an 对象 node it offers every behaviour that object answers to — one entry
   * per method — and a fresh declaration of the same kind, so a scene can grow a
   * second character without searching through the palette again.
   *
   * On a behaviour it offers the next call in the chain, which is how
   * `ch.enable().say()` is built without going back to the object.
   */
  function openNodeMenu(node, clientX, clientY) {
    closeNodeMenu();
    closePicker();
    const rect = element.getBoundingClientRect();
    const root = el("div", { class: "graph__menu" });

    const item = (text, hint, action) => {
      const button = el("button", { class: "graph__menu-item", type: "button" }, [
        el("span", { class: "graph__menu-name", text }),
        hint ? el("small", { class: "graph__menu-hint", text: hint }) : null,
      ]);
      button.addEventListener("click", () => {
        close();
        action();
      });
      return button;
    };

    if (isCallNode(node.type)) {
      root.append(
        el("div", {
          class: "graph__menu-group",
          text: `对象 ${objectNameOf(node) ?? "?"}`,
        }),
        el("div", { class: "graph__menu-group", text: "新行为" }),
      );
      // Behaviours: the calls this object answers to, one entry per method. The
      // new node lands under the last one, already attached.
      for (const method of methodsFor(node, graph)) {
        const spec = BEHAVIOR_SPECS[method];
        root.append(item(spec.title, `${method}()`, () => addBehavior(node, method)));
      }
    } else if (isBehaviorNode(node.type)) {
      // Chaining: the next call runs on the same object, after this one.
      const owner = behaviorOwner(node, graph.nodes);
      const method = behaviorMethodOf(node.type);
      // A path frame is authored on the stage it plays on, so a `key` node's
      // menu offers the way in. One item, one label: it does not describe
      // itself in brackets — the node's own header already names the object.
      if (method === "key" && onEditPath) {
        root.append(
          item("编辑路径帧…", "在舞台上画这个对象的路径帧", () => onEditPath(node)),
          el("div", { class: "graph__menu-sep" }),
        );
      }
      root.append(
        el("div", { class: "graph__menu-group", text: "在它之后接着调用" }),
      );
      for (const method of methodsFor(owner, graph)) {
        const spec = BEHAVIOR_SPECS[method];
        root.append(item(spec.title, `${method}()`, () => addBehaviorAfter(node, method)));
      }
      root.append(el("div", { class: "graph__menu-sep" }));
      if (node.behaviorOf) {
        root.append(
          item("脱离对象", "留在画布上，但不再属于任何对象", () => detachBehavior(node)),
        );
      }
      root.append(item("删除这个行为", "", () => removeNode(node.id)));
    } else if (isDeclareNode(node.type)) {
      root.append(
        el("div", { class: "graph__menu-group", text: `定义 ${objectNameOf(node) ?? "?"}` }),
        item("选择类型…", "用 赋值 接到 角色 / 背景 / 音频", () => {
          openPicker(clientX, clientY, {
            only: (type) => isTypeNode(type),
            onPick: (type) => attachType(node, type),
          });
        }),
        item("删除这个定义", "类型节点会留在画布上", () => removeNode(node.id)),
      );
    } else if (isTypeNode(node.type)) {
      root.append(
        el("div", {
          class: "graph__menu-group",
          text: NODE_TYPES[node.type]?.title ?? "类型",
        }),
        item("删除节点", "", () => removeNode(node.id)),
      );
    } else {
      root.append(item("删除节点", "", () => removeNode(node.id)));
    }

    const onDocDown = (event) => {
      if (!root.contains(event.target)) close();
    };
    document.addEventListener("mousedown", onDocDown, true);

    function close() {
      document.removeEventListener("mousedown", onDocDown, true);
      root.remove();
    }

    root.style.left = `${Math.min(clientX - rect.left, Math.max(8, rect.width - 260))}px`;
    root.style.top = `${Math.min(clientY - rect.top, Math.max(8, rect.height - 300))}px`;
    element.append(root);
    nodeMenu = { root, close };
  }

  /** An object name of this type that nothing on the canvas is using yet. */
  function uniqueObjectName(type) {
    const base = NAME_BASES[type] ?? "obj";
    // Only declarations own a name: a call node that names the same variable is
    // talking about it, not creating a second one.
    const used = new Set(
      graph.nodes.filter((n) => isDeclareNode(n.type)).map((n) => objectNameOf(n)),
    );
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}${i}`)) i += 1;
    return `${base}${i}`;
  }

  /**
   * A spot to the right of `from` that nothing else already occupies.
   *
   * Objects and behaviours are created from a menu rather than dropped at the
   * pointer, so without this the second one lands exactly on the first. The
   * search walks right until it finds a column where the candidate box overlaps
   * no node at all, which is what keeps a freshly created node readable.
   */
  function freeSpotBeside(from, width = NODE_W, gap = 70) {
    const base = nodeRect(from, graph.nodes);
    const taken = graph.nodes.map((n) => nodeRect(n, graph.nodes));
    const overlaps = (x, y) =>
      taken.some(
        (r) =>
          x < r.x + r.w + 8 &&
          x + width + 8 > r.x &&
          y < r.y + r.h + 8 &&
          y + 120 + 8 > r.y,
      );
    // Right of the node first, then *down* that same column, then the next
    // column: a column of behaviours under one object reads better than a row
    // of them extending beyond the right edge of the canvas.
    for (let row = 0; row < 12; row += 1) {
      const y = base.y + row * 130;
      const x = base.x + base.w + gap;
      if (!overlaps(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
    for (let col = 1; col < 12; col += 1) {
      const x = base.x + base.w + gap + col * (width + gap);
      if (!overlaps(x, base.y)) return { x: Math.round(x), y: Math.round(base.y) };
    }
    return { x: Math.round(base.x + base.w + gap), y: Math.round(base.y) };
  }

  /**
   * The world y the `index`th behaviour of `owner` sits on.
   *
   * The stack is a rail with fixed slots, not a loose column: the first call
   * starts on the card's bottom edge and every call after it starts exactly
   * where the one above ends. Nothing is estimated from the object alone — the
   * cards above are measured, so a call with three fields pushes the next one
   * down by its real height and no two cards ever overlap.
   */
  function stackY(owner, index, list = behaviorsOf(graph.nodes, owner.id)) {
    let y = Math.round(owner.y + nodeRect(owner, graph.nodes).h + BEHAVIOR_GAP);
    for (let i = 0; i < Math.min(index, list.length); i += 1) {
      y += Math.round(nodeRect(list[i], graph.nodes).h) + BEHAVIOR_GAP;
    }
    return y;
  }

  /**
   * The world y a new behaviour of `owner` should land on: the first free slot
   * under the calls already stacked there, so a chain reads top to bottom.
   */
  function stackEndY(owner, excludeId = null) {
    const existing = behaviorsOf(graph.nodes, owner.id).filter((n) => n.id !== excludeId);
    return stackY(owner, existing.length, existing);
  }

  /**
   * Puts every call of `owner` back on its slot.
   *
   * This is what makes attaching a magnetic snap rather than a hint: a call
   * that belongs to an object is *always* on the rail, at the exact x of the
   * card and at the exact y the call above it ends. The order of the stack is
   * the y order, so re-stacking after a drag is also how a call is moved within
   * the chain — drop it between two others and it stays there.
   */
  function restackBehaviors(owner) {
    if (!owner) return;
    const list = behaviorsOf(graph.nodes, owner.id);
    const x = Math.round(owner.x);
    let y = Math.round(owner.y + nodeRect(owner, graph.nodes).h + BEHAVIOR_GAP);
    for (const behavior of list) {
      if (behavior.x !== x || behavior.y !== y) {
        behavior.x = x;
        behavior.y = y;
        placeNode(behavior);
      }
      y += Math.round(nodeRect(behavior, graph.nodes).h) + BEHAVIOR_GAP;
    }
    // The rail reads as loaded once something hangs from it.
    const dock = nodeEls.get(owner.id)?.querySelector(".gnode__dock");
    if (dock) dock.classList.toggle("is-loaded", list.length > 0);
  }

  /** Whether a dragged call has been pulled clearly out of its object's column. */
  function outOfStack(node, owner) {
    const rect = nodeRect(owner, graph.nodes);
    const side = node.x < rect.x ? rect.x - node.x : node.x - (rect.x + rect.w);
    return Math.max(side, rect.y - node.y) > BEHAVIOR_DETACH;
  }

  /**
   * Adds a behaviour node to an object.
   *
   * The new node lands directly under the object — or under the last call
   * already there — and is attached by `behaviorOf` alone. There is no wire to
   * drop: the stack *is* the chain, which is what lets a scene read as one flow
   * with its calls collected under the object they belong to.
   */
  function addBehavior(owner, method) {
    return insertBehavior(method, { x: Math.round(owner.x), y: stackEndY(owner) }, owner.id);
  }

  /**
   * Adds a call to the end of the chain a behaviour belongs to.
   *
   * The new call is appended rather than wedged after the node that was
   * right-clicked: a chain is a list, and inserting in the middle would silently
   * reorder the calls.
   */
  function addBehaviorAfter(previous, method) {
    const ownerId = previous.behaviorOf ?? null;
    const owner = ownerId ? nodeById(ownerId) : null;
    const y = owner ? stackEndY(owner) : Math.round(previous.y + nodeRect(previous, graph.nodes).h + 12);
    return insertBehavior(method, { x: Math.round(previous.x), y }, ownerId);
  }

  /** Shared body of the two behaviour-creation gestures. */
  function insertBehavior(method, spot, ownerId) {
    const type = behaviorTypeName(method);
    if (!NODE_TYPES[type]) return null;
    recordSnap();
    // `behaviorOf` is set at creation, not after: the header names the object,
    // and a node drawn before that is known would say 未连接 forever.
    const node = addNode(type, spot, { corner: true, fields: { behaviorOf: ownerId ?? null } });
    if (!node) return null;
    placeNode(node);
    renderNode(node);
    renderEdges();
    markDirty();
    return node;
  }

  /**
   * Hangs a type node off a 新对象: the 赋值 wire is the definition.
   *
   * A definition has at most one type — the constructor it is built with — so a
   * second one replaces the first rather than adding a second call.
   */
  function attachType(declareNode, type) {
    if (!isTypeNode(type)) return null;
    recordSnap();
    const rect = nodeRect(declareNode, graph.nodes);
    const created = addNode(
      type,
      { x: Math.round(rect.x), y: Math.round(rect.y + rect.h + 44) },
      { corner: true },
    );
    if (!created) return null;
    placeNode(created);
    graph.edges = graph.edges.filter((e) => !(e.from.node === declareNode.id && e.from.port === 0));
    addConnection({
      from: { node: declareNode.id, port: 0 },
      to: { node: created.id, port: 0 },
      kind: "assign",
    });
    renderEdges();
    markDirty();
    return created;
  }

  // --- viewport transforms ---

  function applyTransform() {
    const transform = `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})`;
    world.style.transform = transform;
    // The wire layer shares the world's transform so its coordinates are the
    // same world coordinates the nodes are placed in.
    svg.style.transform = transform;
    zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  }

  /** Records the camera on the document, so reopening the map restores it. */
  function rememberView() {
    graph.view = {
      ox: Math.round(view.ox),
      oy: Math.round(view.oy),
      scale: Math.round(view.scale * 1000) / 1000,
    };
    markDirty();
  }

  function screenToWorld(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.ox) / view.scale,
      y: (clientY - rect.top - view.oy) / view.scale,
    };
  }

  function zoomBy(factor) {
    const rect = viewport.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    zoomAt(cx, cy, factor);
  }

  function zoomAt(clientX, clientY, factor) {
    const before = screenToWorld(clientX, clientY);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    if (scale === view.scale) return;
    view.scale = scale;
    const rect = viewport.getBoundingClientRect();
    // Keep the point under the cursor fixed.
    view.ox = clientX - rect.left - before.x * view.scale;
    view.oy = clientY - rect.top - before.y * view.scale;
    applyTransform();
    rememberView();
  }

  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.1 : 0.9);
    },
    { passive: false },
  );

  /** Puts the camera back to 1:1, keeping the viewport's centre in place. */
  function resetView() {
    const rect = viewport.getBoundingClientRect();
    const before = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    view.scale = DEFAULT_SCALE;
    view.ox = rect.width / 2 - before.x * view.scale;
    view.oy = rect.height / 2 - before.y * view.scale;
    applyTransform();
    rememberView();
  }

  /** Bounds of everything on the canvas, in world coordinates. */
  function contentBounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of graph.nodes) {
      if (isChild(node)) continue; // a body is inside its block already
      const r = nodeRect(node, graph.nodes);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function fitView() {
    const rect = viewport.getBoundingClientRect();
    // A hidden or not-yet-laid-out viewport has no size to fit into. Framing it
    // anyway is what used to drop a fresh canvas to the minimum zoom; instead
    // the fit waits until there is a box (see the ResizeObserver below).
    if (rect.width < 80 || rect.height < 80) {
      pendingFit = true;
      return;
    }
    pendingFit = false;
    const bounds = contentBounds();
    if (!bounds) {
      view.ox = 40;
      view.oy = 40;
      view.scale = DEFAULT_SCALE;
      applyTransform();
      return;
    }
    const pad = 60;
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(
      FIT_MAX_SCALE,
      Math.max(
        MIN_SCALE,
        Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h),
      ),
    );
    view.scale = scale;
    view.ox = pad - bounds.minX * scale + (rect.width - pad * 2 - w * scale) / 2;
    view.oy = pad - bounds.minY * scale + (rect.height - pad * 2 - h * scale) / 2;
    applyTransform();
    rememberView();
  }

  // A canvas opened while its view was still hidden gets framed as soon as the
  // editor is shown; a window resize re-frames nothing but keeps the box honest.
  let viewportObserver = null;
  if (typeof ResizeObserver !== "undefined") {
    viewportObserver = new ResizeObserver(() => {
      if (pendingFit) fitView();
    });
    viewportObserver.observe(viewport);
  }

  // --- node placement ---

  function defaultParams(type) {
    const params = {};
    for (const param of NODE_TYPES[type]?.params ?? []) {
      params[param.key] = param.default;
    }
    return params;
  }

  /**
   * Adds a node, centred on a world point (the middle of the viewport when
   * omitted).
   *
   * Returns the node, which is what lets a dropped wire create its target and
   * connect to it in one gesture. `corner` places the node's top-left corner
   * exactly instead — what a caller that already computed a free spot wants,
   * since centring there would shift it back under its neighbours.
   *
   * `fields` are written onto the node *before* it is rendered. That matters:
   * a node's header says what it belongs to (a behaviour names its object), and
   * rendering first would draw "未连接" and then never repaint, because the
   * caller's later assignment does not trigger a render of its own.
   */
  function addNode(type, at = null, { corner = false, fields = null } = {}) {
    const def = NODE_TYPES[type];
    if (!def) {
      return null;
    }
    // A route only makes sense at the top level: inside a block the jump would
    // have to break the block's closing brace.
    if (fields?.parent && (type === "RouteSet" || type === "RouteGet")) {
      setMessage("路由节点只能放在顶层，不能放进容器。", { error: true });
      return null;
    }
    // The flow is one line, so there is one 开始. A second one would be a second
    // script with no way to say which comes first.
    if (type === "Start" && graph.nodes.some((n) => n.type === "Start")) {
      setMessage("画布上只能有一个「开始」节点。", { error: true });
      return null;
    }
    const rect = viewport.getBoundingClientRect();
    const center =
      at ??
      screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const node = {
      id: nextId(graph.nodes, "n"),
      type,
      x: corner
        ? Math.round(center.x)
        : Math.round(center.x - (isContainer(type) ? CONTAINER_MIN_W / 2 : NODE_W / 2)),
      y: corner ? Math.round(center.y) : Math.round(center.y - 40),
      params: defaultParams(type),
      ...(fields ?? {}),
    };
    if (isContainer(type)) {
      node.w = CONTAINER_MIN_W;
      node.h = CONTAINER_MIN_H;
    }
    recordSnap();
    graph.nodes.push(node);
    renderNode(node);
    renderEdges();
    markDirty();
    return node;
  }

  // --- rendering ---

  function isConnected(nodeId, dir, kind, port) {
    const arr = kind === "data" ? graph.dataEdges : graph.edges;
    return arr.some((e) =>
      dir === "in"
        ? e.to.node === nodeId && e.to.port === port
        : e.from.node === nodeId && e.from.port === port,
    );
  }

  function nodeById(id) {
    return graph.nodes.find((n) => n.id === id);
  }

  /** How deep a node sits: 0 at the top level, 1 inside a block, and so on. */
  function depthOf(node) {
    let depth = 0;
    let cur = node;
    const seen = new Set();
    while (cur?.parent && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      cur = nodeById(cur.parent);
      depth += 1;
    }
    return depth;
  }

  /** The chain of blocks a node sits in, outermost first. */
  function ancestorsOf(node) {
    const list = [];
    let cur = node;
    const seen = new Set();
    while (cur?.parent && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      cur = nodeById(cur.parent);
      if (!cur) break;
      list.unshift(cur);
    }
    return list;
  }

  function renderNode(node) {
    if (isContainer(node.type)) {
      renderContainer(node);
      return;
    }
    const def = NODE_TYPES[node.type] ?? { title: node.type, color: "#555", inputs: [], outputs: [], params: [] };
    const behavior = isBehaviorNode(node.type);
    // A node with no socket has no port band at all: reserving the band's
    // padding for a behaviour put a 12px void between its title and its fields
    // and made every call look visually sparse.
    const portRows = totalPortRows(node);
    const portsAreaH = portRows ? PORTS_TOP * 2 + portRows * PORT_ROW_H : 0;

    const owner = behavior ? behaviorOwner(node, graph.nodes) : null;
    const existing = nodeEls.get(node.id);
    const box = existing ?? el("div", { class: "gnode" });
    box.className = [
      "gnode",
      behavior ? "gnode--behavior" : "",
      behavior && owner ? "is-attached" : "",
      isCallNode(node.type) ? "gnode--object gnode--call" : "",
      isDeclareNode(node.type) ? "gnode--object gnode--declare" : "",
      isTypeNode(node.type) ? "gnode--object gnode--type" : "",
      selected?.kind === "node" && selected.id === node.id ? "is-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    box.dataset.node = node.id;
    box.style.left = `${node.x}px`;
    box.style.top = `${node.y}px`;
    box.style.zIndex = String(2 + depthOf(node) * 2);
    // A leaf's box is its own: it must not be clipped by the block around it.
    // `--gnode-w` is the one source of truth for how wide a node is: the
    // stylesheet puts the output socket at `var(--gnode-w)` and the geometry
    // maths uses `NODE_W`, so the two can never drift apart.
    box.style.width = `${NODE_W}px`;
    box.style.setProperty("--gnode-w", `${NODE_W}px`);
    box.style.height = "auto";
    // The accent stripe tells node types apart at a glance, the way a wire's
    // colour does in ComfyUI.
    box.style.setProperty("--gnode-color", def.color ?? "#555");

    // What the header says about each half of an object:
    //   * 新对象 — the variable it defines;
    //   * a type node — the constructor, plus which variable it builds;
    //   * 对象 — the variable it uses;
    //   * a behaviour — the object it calls, or that it is attached to nothing.
    const declareOfCall = isCallNode(node.type)
      ? declarationNamed(graph, objectNameOf(node), node)
      : null;
    const declareOfType =
      isTypeNode(node.type) && node.id
        ? graph.nodes.find((n) => {
            if (!isDeclareNode(n.type)) return false;
            const typeNode = typeNodeFor(graph, n);
            return typeNode && typeNode.id === node.id;
          })
        : null;
    const subtitle = isDeclareNode(node.type)
      ? `${objectNameOf(node) ?? "?"}`
      : isTypeNode(node.type)
        ? `${objectTypeOf(node)}${declareOfType ? ` · ${objectNameOf(declareOfType)}` : ""}`
        : isCallNode(node.type)
          ? `${objectNameOf(node) ?? "?"}${declareOfCall ? "" : " · 未定义"}`
          : behavior
            ? `${objectNameOf(owner) ?? "未连接"}.${behaviorMethodOf(node.type) ?? "?"}`
            : "";

    const header = el("div", { class: "gnode__header" }, [
      el("span", { class: "gnode__title", text: def.title }),
      subtitle ? el("span", { class: "gnode__subtitle", text: subtitle }) : null,
      el("button", {
        class: "gnode__del",
        text: "×",
        title: "删除节点",
        onclick: (e) => {
          e.stopPropagation();
          removeNode(node.id);
        },
      }),
    ]);

    const ports = el("div", { class: "gnode__ports", style: `height:${portsAreaH}px` });

    // One hairline per socket row. The rows are what make a port band read as a
    // table rather than as labels drifting in empty space — a node with a
    // single socket no longer looks like a card with a hole in it.
    for (let row = 0; row < totalPortRows(node); row += 1) {
      ports.append(
        el("div", {
          class: "gnode__track",
          style: `top:${PORTS_TOP + row * PORT_ROW_H}px;height:${PORT_ROW_H}px`,
        }),
      );
    }

    for (const p of portsOf(node)) {
      const connected = isConnected(node.id, p.dir, p.kind, p.port);
      const cls = [
        "gsock",
        `gsock--${p.dir}`,
        p.kind === "data" ? "gsock--data" : "",
        p.kind === "assign" ? "gsock--assign" : "",
        // A serial output already in use cannot take a second wire: it reads as
        // full rather than as merely connected.
        p.dir === "out" && p.kind === "exec" && connected && !isParallelNode(node, graph.nodes) ? "is-serial" : "",
        connected ? "is-connected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      // Every socket's position comes from the same row arithmetic the wire
      // geometry uses (`portPoint`), so a wire always lands on the socket it was
      // drawn to. A behaviour's sockets are on its header line, which is what
      // `portRow` returns for them.
      const top = portLocalY(node, p.dir, p.kind, p.port);
      ports.append(
        el("div", {
          class: cls,
          style: `top:${top}px`,
          title: `${p.kind === "data" ? "数据" : p.kind === "assign" ? "赋值" : "执行"}：${p.label}`,
          dataset: { node: node.id, port: String(p.port), dir: p.dir, kind: p.kind },
        }),
        el("span", {
          class: `gsock__label gsock__label--${p.dir}`,
          text: p.label,
          style: `top:${top}px`,
        }),
      );
    }

    const paramsBox = el("div", { class: "gnode__params" });
    for (const param of def.params) {
      paramsBox.append(renderParam(node, param));
    }

    // An object owns the rail its calls hang from: a black strip along the
    // bottom edge. Behaviours are not scattered near the card — they are
    // slotted onto this rail, so a stack reads as a column with a seam.
    const dock = isCallNode(node.type)
      ? el("div", {
          class: `gnode__dock${behaviorsOf(graph.nodes, node.id).length ? " is-loaded" : ""}`,
          title: "把行为拖到这里，挂在这个对象上",
          dataset: { dock: node.id },
        })
      : null;

    box.replaceChildren(header, ports, paramsBox, ...(dock ? [dock] : []));
    if (!existing) {
      world.append(box);
      nodeEls.set(node.id, box);
    }
    // Remember the box the browser actually laid out: a block that holds this
    // node has to be big enough for the real thing, not for an estimate.
    measureNode(node, box);
  }

  /**
   * Keeps a node's measured size for the geometry maths.
   *
   * Only the height matters to a block — it has to grow down to hold its body —
   * and the width of a leaf is fixed. The number is a *non-enumerable* property
   * so neither `JSON.stringify` (it is geometry, not data) nor `structuredClone`
   * (undo snapshots) carries it into the `.flowmap`; the live graph uses it, and a
   * re-render refreshes it, which is how a longer line of text makes the box
   * taller on the next paint.
   */
  function measureNode(node, box) {
    const h = box.offsetHeight;
    if (!Number.isFinite(h) || h <= 0 || node._h === h) return;
    Object.defineProperty(node, "_h", {
      value: h,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    // The row geometry above is derived from `_h`, so the sockets have to move
    // with it: a textarea that grew a line is a taller box.
    if (nodeEls.get(node.id) === box) {
      const ports = box.querySelector(".gnode__ports");
      if (ports) {
        const rows = totalPortRows(node);
        ports.style.height = rows ? `${PORTS_TOP * 2 + rows * PORT_ROW_H}px` : "0px";
      }
    }
    // Growing a leaf may grow the block around it.
    refreshAncestors(node);
  }

  /**
   * A block: a header with its condition, one band per lane, and a resize grip.
   *
   * The nodes inside it are separate elements in the world, drawn above the
   * box; the box grows to hold them (see `containerRect`), which is what makes
   * "this is the body" visible without any wire.
   */
  function renderContainer(node) {
    const def = NODE_TYPES[node.type];
    const existing = nodeEls.get(node.id);
    const box = existing ?? el("div", { class: "gnode gnode--container" });
    box.className = [
      "gnode",
      "gnode--container",
      selected?.kind === "node" && selected.id === node.id ? "is-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    box.dataset.node = node.id;
    box.style.setProperty("--gnode-color", def.color ?? "#555");
    box.style.zIndex = String(1 + depthOf(node) * 2);

    const header = el("div", { class: "gnode__header gnode__header--container" }, [
      el("span", { class: "gnode__title", text: def.title }),
      el("span", { class: "gnode__header-fields" }),
      el("button", {
        class: "gnode__del",
        text: "×",
        title: "删除节点",
        onclick: (e) => {
          e.stopPropagation();
          removeNode(node.id);
        },
      }),
    ]);
    const fields = header.querySelector(".gnode__header-fields");
    for (const param of def.params) {
      // A choice's options *are* its lanes: each band already carries an
      // editable label, so a second textarea for them would be the same list
      // twice, and the shorter one would win.
      if (node.type === "Choice" && param.key === "options") continue;
      fields.append(renderParam(node, param, "inline"));
    }
    if (node.type === "Choice") {
      fields.append(
        el("button", {
          class: "gnode__mini",
          text: "＋选项",
          title: "增加一个选项",
          onclick: (e) => {
            e.stopPropagation();
            addOption(node);
          },
        }),
      );
    }

    const lanes = el("div", { class: "gnode__lanes" });
    for (const lane of laneRects(node, graph.nodes)) {
      const head = el("div", { class: "glane__head" }, [
        node.type === "Choice"
          ? laneLabelInput(node, lane.port, lane.label)
          : el("span", { class: "glane__label", text: lane.label }),
      ]);
      if (node.type === "Choice" && containerLanes(node).length > 1) {
        head.append(
          el("button", {
            class: "glane__del",
            text: "×",
            title: "删除这个选项",
            onclick: (e) => {
              e.stopPropagation();
              removeOption(node, lane.port);
            },
          }),
        );
      }
      lanes.append(
        el(
          "div",
          {
            class: "glane",
            dataset: { lane: String(lane.port) },
            style: `left:${lane.x - node.x}px;top:${lane.y - node.y}px;width:${lane.w}px;height:${lane.h}px`,
          },
          [head],
        ),
      );
    }

    const resize = el("div", { class: "gnode__resize", title: "拖动调整大小" });
    resize.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      startResize(node, event);
    });

    // Sockets live on the header band: in on the left, 完成 on the right.
    const sockets = [];
    for (const p of portsOf(node)) {
      const connected = isConnected(node.id, p.dir, p.kind, p.port);
      sockets.push(
        el("div", {
          class: ["gsock", `gsock--${p.dir}`, connected ? "is-connected" : ""].filter(Boolean).join(" "),
          style: p.dir === "in"
            ? `left:0;top:${CONTAINER_HEAD_H / 2}px`
            : `left:100%;top:${CONTAINER_HEAD_H / 2}px`,
          title: `执行：${p.label}`,
          dataset: { node: node.id, port: String(p.port), dir: p.dir, kind: p.kind },
        }),
        el("span", {
          class: `gsock__label gsock__label--${p.dir}`,
          text: p.label,
          style: p.dir === "in"
            ? `left:12px;top:${CONTAINER_HEAD_H / 2}px`
            : `right:12px;top:${CONTAINER_HEAD_H / 2}px`,
        }),
      );
    }

    box.replaceChildren(header, lanes, resize, ...sockets);
    if (!existing) {
      world.append(box);
      nodeEls.set(node.id, box);
    }
    layoutContainer(node);
  }

  /** Moves/resizes a block's box and its lane bands, without rebuilding it. */
  function layoutContainer(node) {
    const box = nodeEls.get(node.id);
    if (!box) return;
    const rect = containerRect(node, graph.nodes);
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.w}px`;
    box.style.height = `${rect.h}px`;
    const lanes = laneRects(node, graph.nodes);
    box.querySelectorAll(".glane").forEach((laneEl, i) => {
      const lane = lanes[i];
      if (!lane) return;
      laneEl.style.left = `${lane.x - rect.x}px`;
      laneEl.style.top = `${lane.y - rect.y}px`;
      laneEl.style.width = `${lane.w}px`;
      laneEl.style.height = `${lane.h}px`;
    });
  }

  /** Re-lays out every block a node sits in, after the node moved. */
  function refreshAncestors(node) {
    for (const parent of ancestorsOf(node)) {
      layoutContainer(parent);
    }
  }

  function laneLabelInput(node, port, label) {
    const input = el("input", { class: "glane__label-input", type: "text", value: label });
    input.addEventListener("focus", () => recordSnap());
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("change", () => {
      const options = choiceOptions(node);
      const text = input.value.trim();
      if (!text) {
        input.value = label;
        return;
      }
      options[port] = text;
      node.params.options = options.join("\n");
      markDirty();
      renderNode(node);
      renderEdges();
    });
    return input;
  }

  function addOption(node) {
    recordSnap();
    const options = choiceOptions(node);
    options.push(`选项${options.length + 1}`);
    node.params.options = options.join("\n");
    markDirty();
    renderNode(node);
    renderEdges();
  }

  function removeOption(node, port) {
    recordSnap();
    const options = choiceOptions(node);
    if (options.length <= 1) return;
    options.splice(port, 1);
    node.params.options = options.join("\n");
    // Nodes that lived in the removed band move into the last remaining one.
    const last = options.length - 1;
    for (const child of graph.nodes) {
      if (child.parent !== node.id) continue;
      const at = child.parentPort ?? 0;
      if (at === port) child.parentPort = Math.min(last, Math.max(0, port - 1));
      else if (at > port) child.parentPort = at - 1;
    }
    markDirty();
    renderNode(node);
    renderEdges();
  }

  /**
   * The `assets/` folder a node's file field reads from.
   *
   * A dedicated object node knows its kind (背景 / 角色 / 音频); the generic 对象
   * node carries it as a parameter. A `key` behaviour names a key frame file
   * instead of an asset — a different folder, and the reason the param carries
   * its own `asset` marker rather than being inferred from the node.
   *
   * @param {object} node
   * @param {object} [param]
   * @returns {string} `"Background"`, `"Character"`, `"Audio"`, `"keyframes"`,
   *   or "".
   */
  function assetKindOf(node, param) {
    if (!param) {
      return "";
    }
    // A key frame file is named by the param itself: it is not an asset, and it
    // does not depend on which object the behaviour hangs off.
    if (param.asset === "keyframes") {
      return "keyframes";
    }
    // Only a field that names a file is a file field: `objectName` is a variable
    // and `say`'s text is a line, and neither belongs in a folder listing.
    if (param.key !== "image" && param.key !== "file") {
      return "";
    }
    const type = objectTypeOf(node);
    // Effect has no file field at all: its `effect` param is a built-in kind.
    return ["Background", "Character", "Audio", "Video"].includes(type) ? type : "";
  }

  /**
   * The files a node's file field may name, or `null` when it names none.
   *
   * `null` means "this is an ordinary text box": the caller draws no picker at
   * all. An empty list means "the folder is there but empty", which the caller
   * says out loud rather than leaving the author wondering.
   */
  function assetFilesFor(node, param) {
    const kind = assetKindOf(node, param);
    if (!kind) {
      return null;
    }
    return listAssets(kind) ?? [];
  }

  function renderParam(node, param, mode = "block") {
    const wrap = el("label", {
      class: mode === "inline" ? "gnode__field gnode__field--inline" : "gnode__field",
    });
    if (param.type !== "bool") {
      wrap.append(el("span", { class: "gnode__field-label", text: param.label }));
    }
    let input;
    if (param.type === "bool") {
      input = el("input", { class: "gnode__check", type: "checkbox" });
      input.checked = node.params[param.key] !== false;
      input.addEventListener("change", () => {
        node.params[param.key] = input.checked;
        markDirty();
      });
      wrap.append(input, el("span", { class: "gnode__field-label", text: param.label }));
    } else if (param.type === "multiline") {
      input = el("textarea", {
        class: "gnode__input gnode__input--area",
        rows: mode === "inline" ? "2" : "3",
      });
      input.value = node.params[param.key] ?? param.default;
      input.addEventListener("input", () => {
        node.params[param.key] = input.value;
        if (param.key === "options" && node.type === "Choice") {
          // Options are the choice's lanes: the bands have to be rebuilt.
          renderNode(node);
          renderEdges();
        }
        markDirty();
      });
    } else if (param.type === "select") {
      input = createSelect({
        className: "gnode__input",
        options: param.options ?? [],
        value: node.params[param.key] ?? param.default,
        label: param.label,
      });
      input.addEventListener("change", () => {
        node.params[param.key] = input.value;
        // The 动作 node shows the signature of the method it now calls.
        if (node.type === "StageCall" && param.key === "method") {
          renderNode(node);
        }
        markDirty();
      });
    } else {
      input = el("input", {
        class: "gnode__input",
        type: param.type === "number" ? "number" : "text",
      });
      input.value = node.params[param.key] ?? param.default;
      input.addEventListener("input", () => {
        node.params[param.key] = input.value;
        markDirty();
      });
    }
    // A field naming a file is offered as a list as well as a box: the author
    // can type the name or pick one from the folder the object's kind owns.
    // The list is drawn by `attachCombo`, not by a `<datalist>`, so the popup
    // matches the rest of the app — and the box stays editable, because a name
    // that is not in the folder yet (a file about to be added) is allowed.
    const files = assetFilesFor(node, param);
    if (files) {
      // A text field is a value, not a path: the constructor wants the file's
      // own name, and the list offers exactly that — so a pick writes the name
      // the backend resolves inside the kind's folder.
      attachCombo(input, files, { label: param.label });
      wrap.append(input);
      if (!files.length) {
        wrap.append(
          el("span", {
            class: "gnode__hint",
            text: `assets/${assetKindOf(node, param)}/ 里还没有文件`,
          }),
        );
      }
    } else {
      wrap.append(input);
    }
    // Snapshot before editing so the whole edit is one undo step.
    input.addEventListener("focus", () => recordSnap());
    // Stop dragging the node when interacting with a field.
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    if (node.type === "StageCall" && param.key === "method") {
      wrap.append(
        el("span", {
          class: "gnode__hint",
          text: STAGE_CALL_HINTS[node.params.method] ?? "",
        }),
      );
    }
    return wrap;
  }

  function renderEdges() {
    // Only the committed wires live in the layer; the preview wire is a
    // separate element kept out of the graph until the drop.
    // `querySelectorAll` returns a static list — `children` is live, and
    // removing while iterating a live collection silently skips elements,
    // which left duplicate paths behind on every redraw.
    for (const child of svg.querySelectorAll("path:not(.graph__edge--temp)")) {
      child.remove();
    }
    const all = [
      // A wire's kind is read off the socket it leaves: 赋值 where the two ends
      // are a definition and a constructor, the flow everywhere else.
      ...(graph.edges ?? []).map((e) => ({ e, kind: edgeKindOf(e) })),
      ...(graph.dataEdges ?? []).map((e) => ({ e, kind: "data" })),
    ];
    for (const { e, kind } of all) {
      const from = nodeById(e.from.node);
      const to = nodeById(e.to.node);
      if (!from || !to) {
        continue;
      }
      const a = portPoint(from, "out", e.from.port, kind, graph.nodes);
      const b = portPoint(to, "in", e.to.port, kind, graph.nodes);
      const d = wirePath(a, b);
      const selectedEdge = selected?.kind === "edge" && selected.id === e.id;
      const tint = kind === "exec" ? "" : ` graph__edge--${kind}`;
      const hitTint = kind === "exec" ? "" : ` graph__edge-hit--${kind}`;
      const lineCls = `graph__edge${tint}${selectedEdge ? " is-selected" : ""}`;
      const hitCls = `graph__edge-hit${hitTint}`;
      const hit = el("path", { class: hitCls, d, dataset: { edge: e.id } });
      hit.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        // Selecting a wire must also take the keyboard focus, or Delete would
        // go to whatever else was focused and the wire would survive.
        viewport.focus({ preventScroll: true });
        select({ kind: "edge", id: e.id });
      });
      hit.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        removeEdge(e.id);
      });
      const line = el("path", { class: lineCls, d, dataset: { edge: e.id } });
      line.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        select({ kind: "edge", id: e.id });
      });
      svg.append(hit, line);
    }
  }

  // --- groups (visual frames) ---

  const GROUP_COLORS = ["#4aa3c4", "#6fae5b", "#d6783b", "#b06fc4", "#c46a8c", "#8c7d3f"];

  function closeGroupDialog() {
    groupDialog?.remove();
    groupDialog = null;
  }

  function closeGroupColorMenu() {
    groupColorMenu?.remove();
    groupColorMenu = null;
  }

  function openGroupDialog(members) {
    closeGroupDialog();
    const root = el("div", { class: "graph__group-dialog" });
    const input = el("input", { class: "graph__group-name", placeholder: "组名称" });
    input.value = `组 ${(graph.groups?.length ?? 0) + 1}`;
    let color = GROUP_COLORS[(graph.groups?.length ?? 0) % GROUP_COLORS.length];
    const swatches = el("div", { class: "graph__group-colors" });
    for (const candidate of GROUP_COLORS) {
      const button = el("button", { class: "graph__group-color", title: candidate });
      button.style.background = candidate;
      button.classList.toggle("is-on", candidate === color);
      button.addEventListener("click", () => {
        color = candidate;
        for (const other of swatches.children) {
          other.classList.toggle("is-on", other === button);
        }
      });
      swatches.append(button);
    }
    const cancel = el("button", { class: "graph__btn", text: "取消" });
    const create = el("button", { class: "graph__btn", text: "创建" });
    const commit = () => {
      recordSnap();
      graph.groups = graph.groups ?? [];
      graph.groups.push({
        id: nextId(graph.groups, "g"),
        name: input.value.trim() || `组 ${graph.groups.length + 1}`,
        color,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        members: members.map((node) => node.id),
      });
      closeGroupDialog();
      markDirty();
      renderAll();
    };
    create.addEventListener("click", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") closeGroupDialog();
    });
    cancel.addEventListener("click", closeGroupDialog);
    root.append(
      el("div", { class: "graph__group-dialog-title", text: "新建组" }),
      input,
      swatches,
      el("div", { class: "graph__group-actions" }, [cancel, create]),
    );
    root.style.left = "50%";
    root.style.top = "40%";
    root.style.transform = "translate(-50%, -50%)";
    element.append(root);
    groupDialog = root;
    input.focus();
    input.select();
  }

  function openGroupColorMenu(group, clientX, clientY) {
    closeGroupColorMenu();
    const root = el("div", { class: "graph__group-colors graph__group-colors--menu" });
    for (const candidate of GROUP_COLORS) {
      const button = el("button", { class: "graph__group-color", title: candidate });
      button.style.background = candidate;
      button.classList.toggle("is-on", candidate === group.color);
      button.addEventListener("click", () => {
        group.color = candidate;
        closeGroupColorMenu();
        markDirty();
        renderAll();
      });
      root.append(button);
    }
    const remove = el("button", { class: "graph__group-remove", text: "删除组" });
    remove.addEventListener("click", () => {
      recordSnap();
      graph.groups = (graph.groups ?? []).filter((g) => g.id !== group.id);
      closeGroupColorMenu();
      markDirty();
      renderAll();
    });
    root.append(remove);
    const rect = element.getBoundingClientRect();
    root.style.left = `${clientX - rect.left}px`;
    root.style.top = `${clientY - rect.top}px`;
    element.append(root);
    groupColorMenu = root;
  }

  function startRenameGroup(titleEl, group) {
    const input = el("input", { class: "ggroup__rename" });
    input.value = group.name;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) {
        group.name = input.value.trim() || group.name;
        markDirty();
      }
      renderAll();
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
  }

  function renderGroups() {
    const groups = graph.groups ?? [];
    const alive = new Set(groups.map((group) => group.id));
    for (const [id, box] of groupEls) {
      if (!alive.has(id)) {
        box.remove();
        groupEls.delete(id);
      }
    }
    for (const group of groups) {
      const members = (group.members ?? []).map(nodeById).filter(Boolean);
      if (!members.length) continue;
      // The frame always hugs its members; the stored box is only a cache so a
      // file opens with something to draw before the nodes are measured.
      const box = groupBounds(members);
      group.x = box.x;
      group.y = box.y;
      group.w = box.w;
      group.h = box.h;
      let frame = groupEls.get(group.id);
      if (!frame) {
        frame = el("div", { class: "ggroup", dataset: { group: group.id } });
        const head = el("div", { class: "ggroup__head", dataset: { group: group.id } });
        head.append(el("span", { class: "ggroup__title", text: group.name }));
        frame.append(head);
        groupEls.set(group.id, frame);
      }
      frame.style.left = `${box.x}px`;
      frame.style.top = `${box.y}px`;
      frame.style.width = `${box.w}px`;
      frame.style.height = `${box.h}px`;
      frame.style.setProperty("--ggroup-color", group.color);
      // A rename replaces the title element with an input; putting the span
      // back here is what makes the label return once the edit ends.
      let title = frame.querySelector(".ggroup__title");
      if (!title) {
        title = el("span", { class: "ggroup__title" });
        frame.querySelector(".ggroup__head")?.append(title);
      }
      title.textContent = group.name;
      world.prepend(frame);
    }
  }

  function renderAll() {
    renderGroups();
    // Remove stale node elements.
    for (const [id, box] of nodeEls) {
      if (!nodeById(id)) {
        box.remove();
        nodeEls.delete(id);
      }
    }
    // Blocks first, so their children are painted over them.
    const ordered = [...graph.nodes].sort((a, b) => depthOf(a) - depthOf(b));
    for (const node of ordered) {
      renderNode(node);
    }
    for (const node of graph.nodes) {
      if (isContainer(node.type)) layoutContainer(node);
    }
    // Every stack is put back on its rail after a repaint: a file whose calls
    // were placed manually, or a field that grew a line and made a card taller,
    // must not leave the column floating a few pixels off its slots.
    for (const node of graph.nodes) {
      if (isCallNode(node.type)) restackBehaviors(node);
    }
    renderEdges();
    applyTransform();
  }

  // --- selection / mutation ---

  function select(sel) {
    selected = sel;
    for (const [id, box] of nodeEls) {
      box.classList.toggle("is-selected", sel?.kind === "node" && sel.id === id);
    }
    renderEdges();
  }

  /** A node and everything inside it, deepest first. */
  function subtreeOf(id) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      for (const node of graph.nodes) {
        if (node.parent === cur) stack.push(node.id);
      }
    }
    return out;
  }

  function removeNode(id) {
    const node = nodeById(id);
    if (!node) return;
    recordSnap();
    // A deleted node leaves every group it belonged to; empty groups go.
    graph.groups = (graph.groups ?? [])
      .map((group) => ({
        ...group,
        members: (group.members ?? []).filter((member) => member !== id),
      }))
      .filter((group) => group.members.length > 0);
    // Deleting a call leaves a gap on its rail; the column closes up.
    const stackOwner =
      isBehaviorNode(node.type) && node.behaviorOf ? nodeById(node.behaviorOf) : null;
    // Deleting a block frees what was inside it: the body's nodes are not
    // deleted with their box, they simply have no box any more.
    for (const child of graph.nodes) {
      if (child.parent === id) {
        child.parent = null;
        child.parentPort = 0;
      }
      // A behaviour whose object is gone has nothing to act on.
      if (child.behaviorOf === id) {
        child.behaviorOf = null;
      }
    }
    graph.nodes = graph.nodes.filter((n) => n.id !== id);
    graph.edges = graph.edges.filter((e) => e.from.node !== id && e.to.node !== id);
    graph.dataEdges = graph.dataEdges.filter((e) => e.from.node !== id && e.to.node !== id);
    const box = nodeEls.get(id);
    if (box) {
      box.remove();
      nodeEls.delete(id);
    }
    if (selected?.id === id) {
      selected = null;
    }
    if (stackOwner) restackBehaviors(stackOwner);
    renderEdges();
    markDirty();
  }

  /**
   * Adds a wire, replacing whatever the input already had.
   *
   * Two rules live here rather than at each call site:
   *
   *   * an input takes exactly one wire — the new one replaces the old;
   *   * a *serial* output takes exactly one wire too, so wiring from an output
   *     that already leads somewhere moves that wire instead of adding a second
   *     one. A parallel output (并行 块及其语句体) keeps every wire.
   *
   * A 赋值 output follows the same rule, which is why a definition cannot end up
   * built by two constructors at once: the second type node replaces the first.
   */
  function addConnection(ends) {
    if (!ends) return null;
    const key = ends.kind === "data" ? "dataEdges" : "edges";
    graph[key] = graph[key].filter(
      (e) => !(e.to.node === ends.to.node && e.to.port === ends.to.port),
    );
    // Serial: an output leads to one place. Drop any wire it already had, so
    // connecting twice *moves* the wire rather than branching the flow.
    if (ends.kind !== "data" && !outputCanFanOut(graph.nodes, ends.from.node)) {
      graph[key] = graph[key].filter(
        (e) => !(e.from.node === ends.from.node && e.from.port === ends.from.port),
      );
    }
    const edge = {
      id: nextId(graph[key], ends.kind === "data" ? "d" : "e"),
      from: { node: ends.from.node, port: ends.from.port },
      to: { node: ends.to.node, port: ends.to.port },
    };
    graph[key].push(edge);
    // A definition's header names the variable it builds, and a call node's
    // header names whether that variable exists: both read the wires, so a newly
    // drawn one repaints the two nodes it joins.
    if (ends.kind === "assign") {
      repaintObjectNodes();
    }
    return edge;
  }

  /** Repaints every object node — used when a definition wire changes. */
  function repaintObjectNodes() {
    for (const node of graph.nodes) {
      if (isObjectNode(node.type)) renderNode(node);
    }
  }

  function removeEdge(id) {
    recordSnap();
    let removed = false;
    for (const key of ["edges", "dataEdges"]) {
      const before = graph[key].length;
      graph[key] = graph[key].filter((e) => e.id !== id);
      if (graph[key].length !== before) removed = true;
    }
    if (!removed) return;
    repaintObjectNodes();
    if (selected?.kind === "edge" && selected.id === id) {
      selected = null;
    }
    renderEdges();
    markDirty();
  }

  /**
   * Clears the object of any behaviour whose object is gone, and repaints every
   * behaviour.
   *
   * `behaviorOf` is now the truth rather than a cache of the wires, so there is
   * nothing to recompute — only a deleted object to notice. A behaviour left
   * pointing at an id that no longer exists would keep a header naming a
   * variable nothing defines.
   */
  function syncBehaviorOwners() {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const node of graph.nodes) {
      if (!isBehaviorNode(node.type)) continue;
      if (node.behaviorOf && !ids.has(node.behaviorOf)) node.behaviorOf = null;
      renderNode(node);
    }
  }

  /**
   * Which kind of wire an edge is, read off the two nodes it joins.
   *
   * The file stores both the flow and the definitions in `edges`, so the kind is
   * not written down: a 新对象 feeding a type node is a 赋值 wire, and anything
   * else that is not a data wire is the flow. Deriving it keeps old files —
   * which never had the distinction — readable without a second migration.
   */
  function edgeKindOf(edge) {
    const from = nodeById(edge.from.node);
    const to = nodeById(edge.to.node);
    if (from && to && isDeclareNode(from.type) && isTypeNode(to.type)) {
      return "assign";
    }
    return "exec";
  }

  function findEdgeTo(node, port, kind) {
    const key = kind === "data" ? "dataEdges" : "edges";
    return graph[key].find((e) => e.to.node === node && e.to.port === port);
  }

  /** The wire leaving one socket, if there is one. */
  function findEdgeFrom(node, port, kind) {
    const key = kind === "data" ? "dataEdges" : "edges";
    return graph[key].find((e) => e.from.node === node && e.from.port === port);
  }

  /** Drops the exec wires that reach a node, used when a body takes it over. */
  function pruneExecEdgesOf(id) {
    graph.edges = graph.edges.filter((e) => e.from.node !== id && e.to.node !== id);
  }

  /** Moves a node's element to where the model now says it is. */
  function placeNode(node) {
    const box = nodeEls.get(node.id);
    if (!box) return;
    box.style.left = `${node.x}px`;
    box.style.top = `${node.y}px`;
  }

  /**
   * Puts a node into a block's body, or back at the top level.
   *
   * A body is ordered by where its nodes sit, so the exec wires that used to
   * place the node in the top-level flow are dropped: they would say two
   * different things about the same node. Data wires are untouched — a value is
   * not a step.
   */
  function setParent(node, parent, port) {
    // Dropping a route into a block is refused here as well as at creation.
    if (parent && (node.type === "RouteSet" || node.type === "RouteGet")) {
      setMessage("路由节点只能放在顶层，不能放进容器。", { error: true });
      return;
    }
    const nextParent = parent ? parent.id : null;
    const nextPort = parent ? Math.max(0, port) : 0;
    if ((node.parent ?? null) === nextParent && (node.parentPort ?? 0) === nextPort) {
      return;
    }
    recordSnap();
    node.parent = nextParent;
    node.parentPort = nextPort;
    if (nextParent) {
      pruneExecEdgesOf(node.id);
      // A body is ordered by position, so a node that arrives inside a block is
      // dropped below whatever is already there: it becomes the next statement
      // rather than displacing the existing ones aside.
      const lane = laneRects(parent, graph.nodes).find((l) => l.port === nextPort);
      const siblings = childrenOf(graph.nodes, parent.id, nextPort).filter((n) => n.id !== node.id);
      const last = siblings[siblings.length - 1];
      node.x = Math.round((lane ? lane.x : parent.x) + BODY_LEFT);
      const firstRow = (lane ? lane.y : parent.y + CONTAINER_HEAD_H + CONTAINER_LANE_HEAD_H) + BODY_TOP;
      node.y = Math.round(last ? Math.max(firstRow, last.y + nodeRect(last, graph.nodes).h + BODY_GAP) : firstRow);
    }
    // The model moved the node to its new home; the box on screen has to follow,
    // or the canvas would draw it where it was dropped and a block would size
    // itself around a position nothing was ever at.
    placeNode(node);
    renderEdges();
    refreshAncestors(node);
    markDirty();
    if (nextParent) {
      const label = NODE_TYPES[parent.type]?.title ?? "语句块";
      setMessage(`已放入「${label}」的语句体：语句体内按从上到下的顺序执行`);
    } else {
      setMessage("已移到顶层：用连线把它接回执行流");
    }
  }

  // --- pointer interaction ---

  let drag = null; // { mode: "node"|"pan"|"link"|"resize", ... }

  /** Marks the socket (or node) a wire would land on, and only that one. */
  function setDropTarget(target) {
    for (const node of graph.nodes) {
      const box = nodeEls.get(node.id);
      if (!box) {
        continue;
      }
      const isNodeTarget = target?.kind === "node" && target.node === node.id;
      box.classList.toggle("is-drop", isNodeTarget);
      for (const sock of box.querySelectorAll(".gsock")) {
        const isPortTarget =
          target?.kind === "port" &&
          target.node === node.id &&
          sock.dataset.dir === target.dir &&
          sock.dataset.kind === target.kind &&
          sock.dataset.port === String(target.port);
        sock.classList.toggle("is-drop", isPortTarget);
      }
    }
  }

  function onViewportMouseDown(event) {
    if (event.button !== 0) {
      return;
    }
    // Focus the canvas so Delete/Backspace can act on the selection. The focus
    // must not scroll the canvas into view: that shifts the viewport, and every
    // coordinate computed for the drag that is starting would be off by it.
    viewport.focus({ preventScroll: true });

    // A group's title bar drags the whole frame, members and their bodies.
    const groupHead = event.target.closest?.(".ggroup__head");
    if (groupHead) {
      const group = (graph.groups ?? []).find((g) => g.id === groupHead.dataset.group);
      if (group) {
        recordSnap();
        const ids = new Set();
        for (const id of group.members ?? []) {
          for (const sub of subtreeOf(id)) ids.add(sub);
        }
        drag = {
          mode: "group",
          id: group.id,
          startWorld: screenToWorld(event.clientX, event.clientY),
          carried: [...ids]
            .map((id) => nodeById(id))
            .filter(Boolean)
            .map((node) => ({ id: node.id, x: node.x, y: node.y })),
          moved: false,
        };
        listenDrag();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const sock = event.target.closest?.(".gsock");
    if (sock) {
      startLink(
        {
          node: sock.dataset.node,
          port: Number(sock.dataset.port),
          dir: sock.dataset.dir,
          kind: sock.dataset.kind || "exec",
        },
        event,
      );
      return;
    }
    const nodeEl = event.target.closest?.(".gnode");
    if (nodeEl) {
      select({ kind: "node", id: nodeEl.dataset.node });
      const node = nodeById(nodeEl.dataset.node);
      if (!node) return;
      recordSnap();
      // What else has to move with the node: a block carries its body, so the
      // box never leaves its contents.
      //
      // A call is *not* carried this way. The stack under an object is a rail
      // with fixed slots, so its calls follow by being re-stacked every frame
      // (`restackBehaviors`) rather than by a frozen offset — that is what
      // keeps the column aligned when the object is dragged quickly. And a
      // behaviour being dragged moves alone: pulling one out of the column is
      // how the chain is rearranged.
      const followers = new Map();
      if (isContainer(node.type)) {
        for (const id of subtreeOf(node.id)) {
          const child = nodeById(id);
          if (child && child.id !== node.id) followers.set(child.id, { id, x: child.x, y: child.y });
        }
      }
      drag = {
        mode: "node",
        id: node.id,
        startWorld: screenToWorld(event.clientX, event.clientY),
        nodeStart: { x: node.x, y: node.y },
        carried: [...followers.values()],
        // The object whose rail this drag has to keep closed up behind it.
        stack: isCallNode(node.type) ? node.id : null,
        moved: false,
        drop: null,
      };
      listenDrag();
      event.preventDefault();
      return;
    }

    // Empty canvas: Shift drags a selection frame to group nodes; a plain drag
    // pans the view.
    select(null);
    if (event.shiftKey) {
      const box = el("div", { class: "graph__marquee" });
      viewport.append(box);
      drag = {
        mode: "marquee",
        startWorld: screenToWorld(event.clientX, event.clientY),
        currentWorld: screenToWorld(event.clientX, event.clientY),
        startScreen: { x: event.clientX, y: event.clientY },
        box,
        moved: false,
      };
      listenDrag();
      event.preventDefault();
      return;
    }
    drag = {
      mode: "pan",
      startX: event.clientX,
      startY: event.clientY,
      ox: view.ox,
      oy: view.oy,
    };
    listenDrag();
  }

  function startResize(node, event) {
    recordSnap();
    drag = {
      mode: "resize",
      id: node.id,
      startWorld: screenToWorld(event.clientX, event.clientY),
      startW: node.w ?? CONTAINER_MIN_W,
      startH: node.h ?? CONTAINER_MIN_H,
    };
    listenDrag();
  }

  function listenDrag() {
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
  }

  function unlistenDrag() {
    window.removeEventListener("mousemove", onWindowMouseMove);
    window.removeEventListener("mouseup", onWindowMouseUp);
  }

  /**
   * Starts a wire from a socket.
   *
   * The wire is drawn from the socket the user grabbed, whichever side it is on
   * — dragging backwards out of an input is the same gesture, and the ends are
   * sorted out when the wire lands. A short stub is drawn immediately so the
   * press visibly does something before the pointer has moved.
   *
   * Grabbing a *connected* input takes its existing wire off and puts the loose
   * end under the pointer, so a mis-wired edge can be re-routed in one gesture
   * instead of being deleted and redrawn. The edge is only really removed once
   * the pointer moves: a plain click on a socket must not silently delete the
   * wire plugged into it.
   */
  function startLink(anchor, event) {
    const node = nodeById(anchor.node);
    if (!node) {
      return;
    }
    let detach = null;
    if (anchor.dir === "in") {
      const existing = findEdgeTo(anchor.node, anchor.port, anchor.kind);
      if (existing) {
        detach = { id: existing.id, kind: anchor.kind, from: existing.from };
        // The loose end leaves the node that fed this input, so the drag
        // continues from the *output* end of the wire being taken off.
        anchor = {
          node: existing.from.node,
          port: existing.from.port,
          dir: "out",
          kind: anchor.kind,
        };
      }
    } else {
      // Grabbing an output that already leads somewhere takes *that* wire off,
      // the same way grabbing a wired input does. Without this a serial output
      // could never be re-pointed: the old wire would stay, `addConnection`
      // would replace it, and pulling it onto empty canvas would look like
      // nothing happened.
      const outgoing = findEdgeFrom(anchor.node, anchor.port, anchor.kind);
      if (outgoing) {
        detach = { id: outgoing.id, kind: anchor.kind, from: outgoing.from };
      }
    }
    const fromNode = nodeById(anchor.node);
    const start = portPoint(fromNode, anchor.dir, anchor.port, anchor.kind, graph.nodes);
    // The stub points the way a wire from this socket would leave it.
    const reach = anchor.dir === "out" ? 44 : -44;
    const cursor = { x: start.x + reach, y: start.y };
    const temp = el("path", { class: "graph__edge graph__edge--temp" });
    temp.setAttribute("d", wirePath(start, cursor));
    svg.append(temp);
    drag = {
      mode: "link",
      anchor,
      detach,
      detached: false,
      start,
      temp,
      cursor,
      target: null,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
    };
    listenDrag();
    event.preventDefault();
    event.stopPropagation();
  }

  /** Takes a grabbed wire off the graph, once, when the drag really starts. */
  function commitDetach() {
    if (!drag?.detach || drag.detached) {
      return;
    }
    drag.detached = true;
    const key = drag.detach.kind === "data" ? "dataEdges" : "edges";
    graph[key] = graph[key].filter((e) => e.id !== drag.detach.id);
    if (drag.detach.kind === "assign") {
      // A call without its constructor node is an incomplete definition; the
      // node says so on its face.
      repaintObjectNodes();
    }
    renderEdges();
  }

  /**
   * The innermost block whose body holds a world point.
   *
   * Blocks are hit by geometry rather than by the DOM: their children are
   * separate elements painted over them, so `elementFromPoint` would answer with
   * a child whenever the pointer is over one — and a drop there belongs to the
   * block all the same.
   */
  function blockAt(point, exclude = new Set()) {
    const blocks = graph.nodes
      .filter((n) => isContainer(n.type) && !exclude.has(n.id))
      .sort((a, b) => depthOf(b) - depthOf(a));
    for (const node of blocks) {
      const rect = containerRect(node, graph.nodes);
      const inside =
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y + CONTAINER_HEAD_H &&
        point.y <= rect.y + rect.h;
      if (inside) {
        return { node, port: laneAt(node, point.x, graph.nodes) };
      }
    }
    return null;
  }

  /**
   * The object node a dragged behaviour would attach to, or null.
   *
   * The hit area is a little larger than the node, because the gesture is
   * "drop it on the object" rather than "hit the box to the pixel".
   */
  function objectAt(point, exclude = new Set()) {
    const candidates = graph.nodes.filter(
      (n) => isCallNode(n.type) && !exclude.has(n.id),
    );
    for (const node of candidates) {
      const rect = nodeRect(node, graph.nodes);
      // The rail hangs below the card, so the drop zone reaches further down
      // than up: a call is let go *onto the rail*, which is where it lands.
      const padX = 28;
      const padTop = 28;
      const padBottom = DOCK_H + 56;
      const inside =
        point.x >= rect.x - padX &&
        point.x <= rect.x + rect.w + padX &&
        point.y >= rect.y - padTop &&
        point.y <= rect.y + rect.h + padBottom;
      if (inside) return node;
    }
    return null;
  }

  /**
   * Attaches a behaviour to an object, stacking it under the last call there.
   *
   * Attaching is the whole edit: the node's place in the stack is its place in
   * the chain, so there is no wire to draw and nothing to keep in sync.
   */
  function attachBehavior(node, owner) {
    const previous = node.behaviorOf ? nodeById(node.behaviorOf) : null;
    recordSnap();
    node.behaviorOf = owner.id;
    // The slot is geometry, not preference: the call goes on the rail at the
    // exact x of the card, in the last free slot, and the column closes up
    // behind it. There is no "near enough" — a call either hangs from the rail
    // or it does not belong to the object.
    node.x = Math.round(owner.x);
    node.y = stackEndY(owner, node.id);
    placeNode(node);
    renderNode(node);
    restackBehaviors(owner);
    if (previous && previous.id !== owner.id) restackBehaviors(previous);
    markDirty();
  }

  /**
   * Takes a call off its object, leaving it where it stands.
   *
   * Detaching is the only way a call floats free again, and it is deliberate:
   * a drag that ends away from the card, or 脱离对象 in the menu.
   */
  function detachBehavior(node) {
    const owner = node.behaviorOf ? nodeById(node.behaviorOf) : null;
    if (!owner) return;
    recordSnap();
    node.behaviorOf = null;
    renderNode(node);
    restackBehaviors(owner);
    markDirty();
  }

  /**
   * Puts a dropped call back on its rail.
   *
   * A call that belongs to an object is never left floating a few pixels off
   * its column: the drop either lands on another object (a new owner) or the
   * call returns to its slot. Its y is the order, so a call dropped between two
   * others is re-stacked there — that is how the chain is rearranged.
   */
  function snapBehavior(node) {
    const owner = node.behaviorOf ? nodeById(node.behaviorOf) : null;
    if (!owner) return;
    restackBehaviors(owner);
  }

  function onWindowMouseMove(event) {
    if (!drag) {
      return;
    }
    if (drag.mode === "pan") {
      view.ox = drag.ox + (event.clientX - drag.startX);
      view.oy = drag.oy + (event.clientY - drag.startY);
      applyTransform();
      return;
    }
    if (drag.mode === "group") {
      const point = screenToWorld(event.clientX, event.clientY);
      const dx = Math.round(point.x - drag.startWorld.x);
      const dy = Math.round(point.y - drag.startWorld.y);
      for (const carried of drag.carried) {
        const node = nodeById(carried.id);
        if (!node) continue;
        node.x = carried.x + dx;
        node.y = carried.y + dy;
        placeNode(node);
      }
      drag.moved = true;
      renderGroups();
      renderEdges();
      markDirty();
      return;
    }
    if (drag.mode === "marquee") {
      const point = screenToWorld(event.clientX, event.clientY);
      drag.currentWorld = point;
      const rect = viewport.getBoundingClientRect();
      drag.box.style.left = `${Math.min(drag.startScreen.x, event.clientX) - rect.left}px`;
      drag.box.style.top = `${Math.min(drag.startScreen.y, event.clientY) - rect.top}px`;
      drag.box.style.width = `${Math.abs(event.clientX - drag.startScreen.x)}px`;
      drag.box.style.height = `${Math.abs(event.clientY - drag.startScreen.y)}px`;
      drag.moved = true;
      return;
    }
    if (drag.mode === "resize") {
      const node = nodeById(drag.id);
      if (!node) return;
      const w = screenToWorld(event.clientX, event.clientY);
      node.w = Math.max(CONTAINER_MIN_W, Math.round(drag.startW + (w.x - drag.startWorld.x)));
      node.h = Math.max(CONTAINER_MIN_H, Math.round(drag.startH + (w.y - drag.startWorld.y)));
      layoutContainer(node);
      markDirty();
      return;
    }
    if (drag.mode === "node") {
      const w = screenToWorld(event.clientX, event.clientY);
      const node = nodeById(drag.id);
      if (!node) {
        return;
      }
      const dx = Math.round(drag.nodeStart.x + (w.x - drag.startWorld.x)) - drag.nodeStart.x;
      const dy = Math.round(drag.nodeStart.y + (w.y - drag.startWorld.y)) - drag.nodeStart.y;
      node.x = drag.nodeStart.x + dx;
      node.y = drag.nodeStart.y + dy;
      const box = nodeEls.get(node.id);
      box.style.left = `${node.x}px`;
      box.style.top = `${node.y}px`;
      drag.moved = true;
      // A block being dragged takes everything inside it along.
      for (const carried of drag.carried) {
        const child = nodeById(carried.id);
        if (!child) continue;
        child.x = carried.x + dx;
        child.y = carried.y + dy;
        const childBox = nodeEls.get(carried.id);
        if (childBox) {
          childBox.style.left = `${child.x}px`;
          childBox.style.top = `${child.y}px`;
        }
      }
      // An object drags its rail with it: the calls are re-slotted onto the new
      // position instead of being offset from where the drag started, so a fast
      // drag can never leave the column behind.
      if (drag.stack) restackBehaviors(nodeById(drag.stack));
      refreshAncestors(node);
      renderEdges();
      // Where this node would land: inside a block's body, or back at the top.
      const exclude = new Set(subtreeOf(node.id));
      drag.drop = blockAt(w, exclude);
      for (const block of graph.nodes) {
        if (!isContainer(block.type)) continue;
        nodeEls.get(block.id)?.classList.toggle("is-drop", drag.drop?.node.id === block.id);
      }
      // A behaviour looks for an object to hang off while it is being dragged,
      // and the object it is over says so before the drop.
      if (isBehaviorNode(node.type)) {
        const target = objectAt(w, exclude);
        drag.object = target;
        for (const other of graph.nodes) {
          nodeEls.get(other.id)?.classList.toggle("is-drop", target?.id === other.id);
        }
      }
      markDirty();
      return;
    }
    if (drag.mode === "link") {
      if (!drag.moved) {
        drag.moved =
          Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) > LINK_MIN_DRAG;
      }
      if (drag.moved) {
        commitDetach();
      }
      const w = screenToWorld(event.clientX, event.clientY);
      const target = dropTargetFor(event);
      if (target) {
        drag.cursor =
          target.kind === "port"
            ? portPoint(nodeById(target.node), target.dir, target.port, target.kind, graph.nodes)
            : portPoint(nodeById(target.node), drag.anchor.dir === "out" ? "in" : "out", 0, drag.anchor.kind, graph.nodes);
      } else {
        drag.cursor = w;
      }
      const changed =
        target?.kind !== drag.target?.kind ||
        target?.node !== drag.target?.node ||
        target?.port !== drag.target?.port;
      if (changed) {
        drag.target = target;
        setDropTarget(target);
      }
      // Draw from the anchor to the pointer, or to the socket it snapped to, so
      // the wire visibly locks on before the release.
      const a = drag.anchor.dir === "out" ? drag.start : drag.cursor;
      const b = drag.anchor.dir === "out" ? drag.cursor : drag.start;
      drag.temp.setAttribute("d", wirePath(a, b));
    }
  }

  /** The socket or node a link drag is currently over, as a link end. */
  function dropTargetFor(event) {
    const wanted = drag.anchor.dir === "out" ? "in" : "out";
    const port = portAt(event.clientX, event.clientY, wanted, drag.anchor.kind);
    if (port) {
      return { kind: "port", ...port };
    }
    const nodeEl = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".gnode");
    const node = nodeEl ? nodeById(nodeEl.dataset.node) : null;
    if (node && acceptsLink(drag.anchor, node)) {
      return { kind: "node", node: node.id };
    }
    return null;
  }

  /**
   * Whether a wire can leave this output at all.
   *
   * A serial output takes one wire. Pulling it out while it already leads
   * somewhere is fine — the old wire comes off with it — but the *result* can
   * only be one wire, so this only ever says no when the drag would create a
   * second one.
   */
  function outputIsFull(anchor) {
    // A data wire fans out; 赋值 does not: one definition, one type.
    if (anchor.kind === "data") return false;
    const node = nodeById(anchor.node);
    if (!node || isParallelNode(node, graph.nodes)) return false;
    return graph.edges.some((e) => e.from.node === anchor.node && e.from.port === anchor.port);
  }

  function onWindowMouseUp(event) {
    if (!drag) {
      return;
    }
    if (drag.mode === "node") {
      const node = nodeById(drag.id);
      // Whatever was lit up as a landing place while the drag was running goes
      // out again: a block's body, or an object a behaviour was hovering over.
      for (const other of graph.nodes) {
        nodeEls.get(other.id)?.classList.remove("is-drop");
      }
      // Only a drag that actually went somewhere changes the node's home: a
      // plain click must not take it out of the block it belongs to.
      if (node && drag.moved && isBehaviorNode(node.type)) {
        // A behaviour is attached by where it was let go, never by a wire. Let
        // go on a card (or its rail) and it slots in; let go away from it and
        // it either keeps its slot in the column or, pulled clear, is released.
        const target = objectAt(screenToWorld(event.clientX, event.clientY));
        const owner = node.behaviorOf ? nodeById(node.behaviorOf) : null;
        if (target) attachBehavior(node, target);
        else if (owner && outOfStack(node, owner)) detachBehavior(node);
        else snapBehavior(node);
      } else if (node && drag.moved) {
        if (drag.drop) {
          setParent(node, drag.drop.node, drag.drop.port);
        } else if (node.parent) {
          setParent(node, null, 0);
        }
      }
    }
    if (drag.mode === "group") {
      // Members moved; the frame is recomputed from their new positions.
      renderAll();
    }
    if (drag.mode === "marquee") {
      drag.box.remove();
      if (drag.moved) {
        const a = drag.startWorld;
        const b = drag.currentWorld;
        const rect = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w: Math.abs(b.x - a.x),
          h: Math.abs(b.y - a.y),
        };
        // Only whole, top-level cards: a node inside a block travels with the
        // block, so grouping it alone would break that ownership.
        const members = nodesWithinRect(
          graph.nodes.filter((node) => !node.parent),
          rect,
        );
        if (members.length) openGroupDialog(members);
      }
    }
    if (drag.mode === "pan") {
      rememberView();
    }
    if (drag.mode === "link") {
      setDropTarget(null);
      drag.temp.remove();
      const anchor = drag.anchor;
      let linked = false;
      let asked = false;
      if (drag.moved) {
        const target = dropTargetFor(event);
        const wantedDir = anchor.dir === "out" ? "in" : "out";
        if (target) {
          const node = nodeById(target.node);
          // Dropping on a node rather than on a socket takes that node's first
          // free socket, so a wire never needs pixel precision to land.
          const port =
            target.kind === "port" ? target.port : freePort(node, wantedDir, anchor.kind);
          if (port >= 0) {
            const ends = linkEnds(anchor, {
              node: node.id,
              dir: wantedDir,
              port,
              kind: anchor.kind,
            });
            if (ends) {
              recordSnap();
              addConnection(ends);
              linked = true;
            }
          }
        } else if (canExtend(anchor)) {
          // Dropped on empty canvas: ask what the wire leads to, then create
          // that node right there and wire it in. This is the ComfyUI gesture —
          // the wire is the question, the menu is the answer.
          const at = screenToWorld(event.clientX, event.clientY);
          asked = true;
          openPicker(event.clientX, event.clientY, {
            only:
              anchor.kind === "assign"
                ? (type) => isTypeNode(type)
                : anchor.kind === "behavior"
                  ? (type) => isBehaviorNode(type)
                  : null,
            onPick: (type) => extendFrom(anchor, type, at),
          });
        } else if (anchor.dir === "out" && outputIsFull(anchor)) {
          // A serial output is full: say so, rather than dropping the wire with
          // no explanation.
          setMessage("这是串行输出，已经接了一个节点。先断开它，或把节点放进「并行」块。", {
            error: true,
          });
        }
      }
      // A detached wire dropped on empty canvas stays removed — that is how a
      // link is deleted without searching for the thin line. A detached wire that
      // landed somewhere else is already rewired by `addConnection`.
      if (linked || drag.detached) {
        renderEdges();
        markDirty();
      } else if (asked) {
        // The wire was never attached to anything: nothing to redraw, but the
        // detached edge (if any) is already gone.
        renderEdges();
      }
    }
    drag = null;
    unlistenDrag();
  }

  /**
   * Whether a wire dropped on empty canvas can grow a new node at its end.
   *
   * Only an output can: an input that leads nowhere has nothing to grow from —
   * the new node would have to be *before* it, which is what dragging out of the
   * input and dropping on a node already does.
   *
   * A serial output that already leads somewhere cannot grow a second node, so
   * the menu is not even offered: the drop says why instead of opening a list
   * that would refuse the choice.
   */
  function canExtend(anchor) {
    if (anchor.dir !== "out") return false;
    if (anchor.kind === "data") return true;
    const node = nodeById(anchor.node);
    // A 赋值 output leads to a constructor — the type half of a definition.
    if (anchor.kind === "assign") return Boolean(node) && !outputIsFull(anchor);
    if (!node || execOutCount(node) <= 0) return false;
    return !outputIsFull(anchor);
  }

  /**
   * Creates a node at the end of a dropped wire and connects the two.
   *
   * This is what makes the drop-then-choose gesture work: the wire is still
   * live when the menu opens, and the node picked there is created where the
   * wire ended and wired in.
   */
  function extendFrom(anchor, type, at) {
    const fromNode = nodeById(anchor.node);
    if (!fromNode) return;
    const def = NODE_TYPES[type];
    if (!def) return;
    // A serial output that already leads somewhere cannot lead somewhere else:
    // say so instead of silently creating a second wire the model forbids.
    if (anchor.kind !== "data" && !isParallelNode(fromNode, graph.nodes)) {
      const existing = graph.edges.find(
        (e) => e.from.node === anchor.node && e.from.port === anchor.port,
      );
      if (existing) {
        setMessage("这是串行输出，只能接一个节点：先断开原有连线，或把节点放进「并行」块。", {
          error: true,
        });
        return;
      }
    }
    recordSnap();
    const node = addNode(type, {
      x: at.x + (isContainer(type) ? CONTAINER_MIN_W / 2 : NODE_W / 2) + 40,
      y: at.y,
    });
    if (!node) return;
    const dir = anchor.kind === "data" ? "data" : anchor.kind === "assign" ? "assign" : "exec";
    const port = freePort(node, "in", dir);
    if (port < 0) {
      // The node has no socket of that kind: it was the wrong choice, so it is
      // created but left unwired rather than silently connected somewhere odd.
      setMessage(`「${def.title}」没有可以接入的端口，已放置但未连线。`, { error: true });
      return;
    }
    const ends = linkEnds(anchor, { node: node.id, dir: "in", port, kind: dir });
    if (ends) {
      addConnection(ends);
      renderEdges();
      markDirty();
    }
  }

  /**
   * The socket on a node a wire dropped on its body should take.
   *
   * An unconnected socket wins, so dropping on a node with two inputs fills the
   * empty one instead of silently rewiring the one already in use. Falls back to
   * the first socket, and -1 when the node has no socket of that direction.
   */
  function freePort(node, dir, kind) {
    if (!node) {
      return -1;
    }
    const sockets = portsOf(node).filter((p) => p.dir === dir && p.kind === kind);
    if (!sockets.length) {
      return -1;
    }
    const key = kind === "data" ? "dataEdges" : "edges";
    for (const p of sockets) {
      const used = graph[key].some((e) =>
        dir === "in"
          ? e.to.node === node.id && e.to.port === p.port
          : e.from.node === node.id && e.from.port === p.port,
      );
      if (!used) {
        return p.port;
      }
    }
    return sockets[0].port;
  }

  /**
   * Whether a node body can accept a wire being dragged onto it.
   *
   * The drag's kind decides: an exec wire needs an exec input, a data wire a
   * data input, a behaviour wire an object's 行为 socket. A node inside a block
   * has no exec socket to take — its place is its position.
   */
  function acceptsLink(anchor, node) {
    if (!node || node.id === anchor.node) {
      return false;
    }
    if (anchor.kind === "data") {
      return dataInCount(node) > 0;
    }
    if (anchor.kind === "assign") {
      // Only a type node is built by a definition.
      return isTypeNode(node.type);
    }
    if (isBehaviorNode(node.type)) {
      return false;
    }
    if (isChild(node)) {
      return false;
    }
    return execInCount(node) > 0;
  }

  /**
   * The socket nearest to a screen point, in screen pixels, restricted to the
   * requested direction and wire kind. Sockets are small; aiming at one exactly
   * is imprecise, so a drop within `PORT_HIT_PX` still lands on it.
   */
  function portAt(clientX, clientY, wantedDir = null, wantedKind = null) {
    const rect = viewport.getBoundingClientRect();
    let best = null;
    let bestD = PORT_HIT_PX;
    for (const node of graph.nodes) {
      for (const p of portsOf(node)) {
        if (wantedDir && p.dir !== wantedDir) continue;
        if (wantedKind && p.kind !== wantedKind) continue;
        const pt = portPoint(node, p.dir, p.port, p.kind, graph.nodes);
        const sx = rect.left + view.ox + pt.x * view.scale;
        const sy = rect.top + view.oy + pt.y * view.scale;
        const d = Math.hypot(clientX - sx, clientY - sy);
        if (d < bestD) {
          bestD = d;
          best = { node: node.id, dir: p.dir, port: p.port, kind: p.kind };
        }
      }
    }
    return best;
  }

  // A resource dragged out of the tree can be dropped on a field: the path lands
  // where the pointer is, exactly as it does in the script editor. Only fields
  // take it — a drop on the canvas is not a way to create anything.
  const dropFieldAt = (target) => target?.closest?.(".gnode__input, .glane__label-input") ?? null;

  element.addEventListener("dragover", (event) => {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
    // A desktop file is refused; an empty list is accepted, since some builds
    // only report the types when the drop lands.
    const takesText = !types.includes("Files");
    if (takesText && dropFieldAt(event.target)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });

  element.addEventListener("drop", (event) => {
    const field = dropFieldAt(event.target);
    const text = event.dataTransfer?.getData("text/plain");
    if (!field || !text) {
      return;
    }
    event.preventDefault();
    let offset = field.selectionStart ?? field.value.length;
    const at = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (at?.offsetNode && field.contains(at.offsetNode)) {
      offset = at.offset;
    }
    offset = Math.min(Math.max(0, offset), field.value.length);
    field.focus();
    field.setRangeText(text, offset, offset, "end");
    // Both events: a node field commits on `input`, a lane label on `change`.
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });

  element.addEventListener("keydown", (event) => {
    const tag = event.target.tagName;
    // A dropdown is a button here rather than a `<select>`, so it has to be named
    // separately — Ctrl+Z inside one should not undo the graph behind it.
    const inField =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      Boolean(event.target.closest?.(".select"));
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z" && !inField) {
      event.preventDefault();
      undoGraph();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      ((event.shiftKey && event.key.toLowerCase() === "z") ||
        (!event.shiftKey && event.key.toLowerCase() === "y")) &&
      !inField
    ) {
      event.preventDefault();
      redoGraph();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selected && !inField) {
      if (selected.kind === "node") {
        removeNode(selected.id);
      } else if (selected.kind === "edge") {
        removeEdge(selected.id);
      }
      event.preventDefault();
      return;
    }
    // `f` frames the graph, the way every other canvas does.
    if (event.key.toLowerCase() === "f" && !inField && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      fitView();
    }
  });

  // --- persistence / inference ---

  function markDirty() {
    dirty = true;
    onChange();
  }

  function load(path, parsed) {
    currentPath = path;
    graph = parsed && Array.isArray(parsed.nodes) ? parsed : emptyGraph();
    if (!graph.dataEdges) graph.dataEdges = [];
    closePicker();
    closeGroupDialog();
    closeGroupColorMenu();
    nodeEls.clear();
    groupEls.clear();
    // Clear node and group elements from a previous file.
    world.querySelectorAll(".gnode, .ggroup").forEach((n) => n.remove());
    dirty = false;
    selected = null;
    history.past.length = 0;
    history.future.length = 0;
    // A document can arrive from anywhere — a file, a reverse parse, an undo
    // snapshot — so it is brought up to shape here rather than trusted. Doing it
    // before the first render is what makes the boxes show their real owner
    // instead of 未连接.
    normalizeGraph(graph);
    // The camera travels with the map: reopening one lands where it was left.
    const saved = normalizeView(graph.view);
    if (saved) {
      view.ox = saved.ox;
      view.oy = saved.oy;
      view.scale = saved.scale;
      pendingFit = false;
      graph.view = saved;
    } else {
      view.ox = 40;
      view.oy = 40;
      view.scale = DEFAULT_SCALE;
      pendingFit = true;
    }
    renderAll();
    if (pendingFit) {
      fitView();
    }
    refreshUndoButtons();
  }

  function serialize() {
    // The camera is part of the document, so it is written with it.
    graph.view = {
      ox: Math.round(view.ox),
      oy: Math.round(view.oy),
      scale: Math.round(view.scale * 1000) / 1000,
    };
    return serializeGraph(graph);
  }

  async function save() {
    try {
      await writeFile(currentPath, serialize());
      dirty = false;
      onChange();
      setMessage(`已保存 ${currentPath}`);
    } catch (error) {
      setMessage(`保存失败：${error?.message ?? error}`, { error: true });
    }
  }

  async function reverseImport() {
    if (!onImport) {
      setMessage("反向解析需要宿主支持（请先生成 .pe）", { error: true });
      return;
    }
    const code = await onImport(currentPath);
    if (code == null) {
      setMessage("没有可反向解析的脚本（先「生成 .pe」）", { error: true });
      return;
    }
    // The reverse parse throws away the canvas and rebuilds it from the script, so
    // an unsaved layout is lost. Both directions of conversion are manual, and both
    // ask before overwriting — this is the pe -> flowmap half.
    if (onConfirm) {
      const ok = await onConfirm({
        title: "反向解析",
        body: "用对应的 .pe 文本覆盖当前画布？未保存的改动会丢失。",
        confirmLabel: "覆盖",
        cancelLabel: "取消",
      });
      if (!ok) {
        setMessage("已取消反向解析", { error: true });
        return;
      }
    }
    const g = graphFromPamela(code);
    load(currentPath, g);
    markDirty();
    setMessage("已从脚本反向解析");
  }

  async function generatePamela() {
    if (!currentPath) {
      setMessage("请先保存画布再生成脚本。", { error: true });
      return;
    }
    // The actual target (scripts/p_<name>.pe) and the conflict prompt live
    // in the host, which knows the project tree: delegate there when provided.
    if (onGenerate) {
      const out = await onGenerate(currentPath);
      if (out) {
        setMessage(`已生成 ${out}`);
        onStatus(`推理生成 ${out}`);
      }
      return;
    }
    // Fallback when no host handler is supplied (e.g. isolated tests).
    const base = currentPath.split("/").pop().replace(/\.(?:flowmap|pmap)$/i, "");
    const target = `scripts/p_${base}.pe`;
    const code = inferGraph(graph);
    try {
      await writeFile(target, code);
      setMessage(`已生成 ${target}`);
      onStatus(`推理生成 ${target}`);
      if (openFile) {
        await openFile(target);
      }
    } catch (error) {
      setMessage(`生成失败：${error?.message ?? error}`, { error: true });
    }
  }

  function getDirty() {
    return dirty;
  }

  applyTransform();
  refreshUndoButtons();
  /**
   * The object name a `key` node's path frame belongs to.
   *
   * A key is bound to its object — `ch.key()` files its path under `ch` — so
   * there is no separate id to record: the node's own wire to the object is
   * what names it, and the canvas can read that off the graph. Answers "" when
   * the node is not a key, or its object has no name yet.
   *
   * @param {string} nodeId
   * @returns {string}
   */
  function pathOfNode(nodeId) {
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node || behaviorMethodOf(node.type) !== "key") {
      return "";
    }
    const owner = behaviorOwner(node, graph.nodes);
    return owner ? String(objectNameOf(owner) ?? "").trim() : "";
  }

  /**
   * Re-records a key node's object name, which is also its path frame's id.
   *
   * Called after the author renames the object on the canvas: the generated
   * script follows the wire, so nothing has to be stored for it, but the node
   * is redrawn so its header says the new name.
   */
  /**
   * Records the key frame file a `key` node plays, and redraws the node.
   *
   * The file is the node's own `file` field, which is what the generated script
   * writes as the argument — so drawing the animation from the node's menu is
   * enough to make `ch.key("key-ch.keyframes")` come out of 生成. The object's
   * name is not stored: it is read off the wire, which is what keeps a rename on
   * the canvas from leaving a stale copy behind.
   *
   * @param {string} nodeId
   * @param {string} [name] The object's name, accepted for the caller's sake.
   * @param {string} [file] The key frame file, project-relative or bare.
   * @returns {boolean} Whether the node was a key and the file was recorded.
   */
  function assignPath(nodeId, name, file) {
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node || behaviorMethodOf(node.type) !== "key") {
      return false;
    }
    const wanted = String(file ?? "")
      .replace(/\\/g, "/")
      .split("/")
      .pop();
    if (wanted) {
      node.params = node.params ?? {};
      node.params.file = wanted;
    }
    renderNode(node);
    markDirty();
    return Boolean(String(name ?? "").trim() || wanted);
  }

  return {
    node: element,
    load,
    serialize,
    save,
    generate: generatePamela,
    fit: fitView,
    undo: undoGraph,
    redo: redoGraph,
    assignPath,
    pathOfNode,
    get dirty() {
      return dirty;
    },
    /**
     * Releases the canvas's observer and window listeners.
     *
     * A drag listens on the window until the pointer comes up, and the viewport
     * is watched for a pending fit. A tab closed mid-drag would keep both — and
     * with them the whole graph — alive.
     */
    destroy() {
      viewportObserver?.disconnect();
      viewportObserver = null;
      unlistenDrag();
      element.remove();
    },
  };
}

/** The signature shown under the 动作 node's method picker. */
const STAGE_CALL_HINTS = Object.fromEntries(
  STAGE_CALL_OPTIONS.map((key) => [
    key,
    `${nodeTitleFor(key)} ${METHOD_SPECS.get(key)?.hint ?? "()"}`,
  ]),
);
