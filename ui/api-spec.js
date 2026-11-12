// flowmap / 反向解析共用的唯一剧本 API 表。
// Single source of truth for the script API: the canvas and the reverse parser
// both read this, so neither can drift away from what `.pe` / `.mpe` accept.
//
// Everything here is derived, at module load, from the language itself
// (`pamela.js`) and the editor's completion table (`completion.js`); no API name
// is written down a second time.

import {
  PARAM_SPECS,
  BUILTIN_GLOBALS,
  BUILTIN_METHODS,
  BUILTIN_ALIASES,
  BULK_METHODS,
  VARIADIC_CALLS,
  KEYWORDS,
} from "./pamela.js";
import { COMPLETIONS } from "./completion.js";

/** Chinese → English is the direction the language resolves; this is the inverse. */
const ALIASES_BY_ENGLISH = new Map();
for (const [chinese, english] of BUILTIN_ALIASES) {
  if (!ALIASES_BY_ENGLISH.has(english)) ALIASES_BY_ENGLISH.set(english, []);
  ALIASES_BY_ENGLISH.get(english).push(chinese);
}

/** Every Chinese spelling of one English name. */
export function aliasesFor(english) {
  return ALIASES_BY_ENGLISH.get(english) ?? [];
}

const PARAM_LABELS = {
  source: "资源", file: "文件", path: "路径", text: "文本", time: "时长(毫秒)",
  value: "值", x: "X", y: "Y", z: "Z(深度)", dx: "ΔX", dy: "ΔY", dz: "ΔZ(深度)",
  degrees: "角度", r: "R", g: "G", b: "B", hex: "HEX", family: "字体名",
  name: "名称", frame: "帧", color: "颜色", interval: "间隔", digits: "小数位数",
  members: "成员(对象…)", rotation: "旋转", rotateTo: "转到", rotateH: "水平角",
  rotateV: "垂直角", scale: "缩放", scaleTo: "缩放到", alpha: "透明度",
  blur: "模糊", brightness: "亮度", contrast: "对比度", saturate: "饱和度",
  volume: "音量", loop: "循环", mute: "静音", size: "尺寸", density: "密度",
  speed: "速度", intensity: "强度", spread: "散射角", range: "传播距离",
  bloom: "泛光", soft: "柔光", width: "灯宽", audio: "配音", weight: "字重",
  // 自动配音：true / false，或 1–10 的语速。
  on: "自动配音",
  // 逐帧图片组：序号从 0 起，也可以直接写图片名。
  index: "序号或图名",
};

const NUMBER_PARAMS = new Set([
  "time", "x", "y", "z", "dx", "dy", "dz", "value", "degrees", "r", "g", "b",
  "frame", "interval", "digits", "intensity", "spread", "range", "bloom", "soft",
  "width", "rotateH", "rotateV", "rotation", "rotateTo", "alpha", "blur",
  "brightness", "contrast", "saturate", "scale", "scaleTo", "volume", "size",
  "sizeTo", "density", "densityTo", "speed", "speedTo",
  "weight",
]);

const BOOL_PARAMS = new Set(["loop", "mute", "hasDefault"]);
const BOOL_VALUE_METHODS = new Set(["crood", "translucent", "mute", "exclude", "unexclude"]);
/** `value` is a colour (written as text) for these calls, not a number. */
const TEXT_VALUE_METHODS = new Set(["color"]);

/**
 * One call argument → the control a node shows for it.
 *
 * A `value` is a number for most calls but a switch for the boolean ones;
 * `key`'s `file` is an asset picker rather than a bare text field.
 *
 * @param {string} name
 * @param {string} [method]
 * @returns {{ key: string, label: string, type: string, default: unknown, asset?: string }}
 */
export function paramControl(name, method = "") {
  let type = "text";
  if (name === "value" && BOOL_VALUE_METHODS.has(method)) {
    type = "bool";
  } else if (name === "value" && TEXT_VALUE_METHODS.has(method)) {
    type = "text";
  } else if (BOOL_PARAMS.has(name)) {
    type = "bool";
  } else if (NUMBER_PARAMS.has(name)) {
    type = "number";
  } else if (name === "text") {
    type = "multiline";
  }
  const control = {
    key: name,
    label: PARAM_LABELS[name] ?? name,
    type,
    default: type === "number" ? 0 : type === "bool" ? true : "",
  };
  if (name === "file" && method === "key") control.asset = "keyframes";
  return control;
}

/** Constructor names: the capitalised PARAM_SPECS keys, plus the group type. */
const CONSTRUCTOR_NAMES = new Set([
  ...Object.keys(PARAM_SPECS).filter((k) => /^[A-Z]/.test(k) && !k.includes(".")),
  "Array",
]);

/** `Character("ch.png", x = …)` — a type built by the stage. */
export const CONSTRUCTORS = Object.freeze(
  [...CONSTRUCTOR_NAMES].sort().map((name) => ({
    name,
    params: name === "Array" ? ["members"] : [...PARAM_SPECS[name]],
    aliases: aliasesFor(name),
  })),
);

const GLOBAL_PARAMS = {
  say: PARAM_SPECS.say,
  click: PARAM_SPECS["Stage.click"],
  auto: PARAM_SPECS["Stage.auto"],
  autoVoice: PARAM_SPECS["Stage.autoVoice"],
  str: ["value", "digits"],
  jump: ["path"],
  len: ["value"],
  dialog: [],
  stage: [],
};

/** Names a script may call without building them first. */
export const GLOBAL_CALLS = Object.freeze(
  [...BUILTIN_GLOBALS]
    .filter((name) => !CONSTRUCTOR_NAMES.has(name))
    .sort()
    .map((name) => ({
      name,
      params: [...(GLOBAL_PARAMS[name] ?? [])],
      aliases: aliasesFor(name),
    })),
);

/** What each object answers to, including two-dot namespaces. */
export const OBJECT_METHOD_GROUPS = new Map();
for (const entry of COMPLETIONS) {
  if (!Array.isArray(entry.methods)) continue;
  const own = [];
  const namespaces = [];
  for (const member of entry.methods) {
    if (member.namespace || Array.isArray(member.methods)) {
      namespaces.push({
        name: member.label,
        methods: member.methods.map((m) => m.label),
      });
    } else {
      own.push(member.label);
    }
  }
  OBJECT_METHOD_GROUPS.set(entry.name, { own, namespaces });
}

const NAMESPACE_RECEIVERS = {
  "Video.media": "VideoMedia",
  "Video.audio": "VideoAudio",
  "Character.transform": "Transform",
};

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * key → { key, receiver, params, aliases, hint, bulk, variadic }.
 *
 * Keys are either a bare method (`enable`), a dotted stage/global signature
 * (`Stage.say`, `Effect.play`) or a two-dot namespace call (`VideoMedia.blur`,
 * `VideoAudio.mute`, `Transform.upleft`). `receiver` is what a node has to name
 * as the call's owner.
 */
export const METHOD_SPECS = new Map();

function putMethod(key, { receiver = "Object", params = [], bulk = false, variadic = false } = {}) {
  if (!key || METHOD_SPECS.has(key)) return;
  const english = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  METHOD_SPECS.set(key, {
    key,
    receiver,
    params: [...params],
    aliases: aliasesFor(english),
    hint: `(${params.join(", ")})`,
    bulk,
    variadic,
  });
}

// 1. Every signature the language itself declares.
for (const [key, params] of Object.entries(PARAM_SPECS)) {
  const receiver = key.includes(".") ? key.slice(0, key.indexOf(".")) : "Object";
  putMethod(key, { receiver, params });
}

// 2. Names the language answers to after a dot but that have no signature
//    (group membership, namespaces, exclusions).
for (const name of BUILTIN_METHODS) putMethod(name);

// 3. Two-dot namespaces: `video.media.blur(…)`, `ch.transform.upleft(…)`.
for (const [objectName, group] of OBJECT_METHOD_GROUPS) {
  for (const ns of group.namespaces) {
    const receiver = NAMESPACE_RECEIVERS[`${objectName}.${ns.name}`]
      ?? `${objectName}${capitalise(ns.name)}`;
    for (const method of ns.methods) {
      putMethod(`${receiver}.${method}`, {
        receiver,
        params: PARAM_SPECS[method] ?? [],
      });
    }
  }
}

// 4. Stage-wide batch calls and the two variadic light exclusions.
export const BULK_CALLS = Object.freeze(
  Object.entries(BULK_METHODS).map(([name, params]) => ({
    name,
    params: [...params],
    aliases: aliasesFor(name),
  })),
);
for (const call of BULK_CALLS) {
  putMethod(`Stage.${call.name}`, { receiver: "Stage", params: call.params, bulk: true });
}
for (const name of Object.keys(VARIADIC_CALLS)) {
  putMethod(`Stage.${name}`, { receiver: "Stage", variadic: true });
  putMethod(name);
}
// 环境亮度属于舞台自己：既不是对象方法，也不在批量调用表里。
putMethod("Stage.ambient", { receiver: "Stage", params: PARAM_SPECS.ambient });

/** Every spelling this table knows, for the coverage assertions in the tests. */
export function allApiKeys() {
  const keys = new Set();
  for (const c of CONSTRUCTORS) keys.add(c.name);
  for (const g of GLOBAL_CALLS) keys.add(g.name);
  for (const [objectName, group] of OBJECT_METHOD_GROUPS) {
    keys.add(objectName);
    for (const m of group.own) keys.add(m);
    for (const ns of group.namespaces) {
      keys.add(ns.name);
      for (const m of ns.methods) keys.add(m);
    }
  }
  for (const name of BUILTIN_METHODS) keys.add(name);
  for (const key of METHOD_SPECS.keys()) {
    keys.add(key);
    keys.add(key.slice(key.lastIndexOf(".") + 1));
  }
  for (const name of Object.keys(BULK_METHODS)) keys.add(name);
  for (const name of Object.keys(VARIADIC_CALLS)) keys.add(name);
  return keys;
}

/** The words that open a statement rather than name an API. */
export const STATEMENT_KEYWORDS = KEYWORDS;

/** One frozen view of the whole table for callers that prefer a single object. */
export const API_TABLE = Object.freeze({
  constructors: CONSTRUCTORS,
  globalCalls: GLOBAL_CALLS,
  methods: METHOD_SPECS,
  objectGroups: OBJECT_METHOD_GROUPS,
  bulkCalls: BULK_CALLS,
  aliases: BUILTIN_ALIASES,
  keywords: STATEMENT_KEYWORDS,
  paramControl,
  allApiKeys,
});

// --- node-facing helpers: one canvas node per API key (阶段 2) ---

/** A namespace receiver's spelling in a real call: `.media.blur(…)`. */
const NAMESPACE_SUFFIX = {
  VideoMedia: "media",
  VideoAudio: "audio",
  Transform: "transform",
};

/** The object types that exist on the canvas. */
export const OBJECT_TYPES = Object.freeze([
  "Background", "Character", "Text", "Audio", "Effect", "Video", "Light", "Array",
]);

/** What a behaviour node writes after the object's name. */
export function behaviorSuffix(key) {
  const dot = key.indexOf(".");
  if (dot < 0) return key;
  const receiver = key.slice(0, dot);
  const method = key.slice(dot + 1);
  // `Effect.play` is the same call as `play`; only namespaces need a second dot.
  return NAMESPACE_SUFFIX[receiver]
    ? `${NAMESPACE_SUFFIX[receiver]}.${method}`
    : method;
}

/** Names that name a namespace or a stage global, never an object method. */
const NOT_OBJECT_METHODS = new Set([
  "media", "audio", "transform", "exclude", "unexclude",
  "ambient", "perspective", "guideline", "pamela",
]);

/** Every method key that gets its own `beh:` node on the canvas. */
export function behaviorNodeKeys() {
  // The eight free-transform points are reached through `ch.transform.<point>`;
  // their bare spelling is only the language's fallback signature, not a second
  // node the canvas should offer on every kind of object.
  const transformMethods = new Set(
    (OBJECT_METHOD_GROUPS.get("Character")?.namespaces ?? [])
      .filter((ns) => ns.name === "transform")
      .flatMap((ns) => ns.methods),
  );
  const out = [];
  for (const [key, spec] of METHOD_SPECS) {
    if (spec.receiver === "Stage" || spec.receiver === "Dialog") continue;
    if (key.startsWith("Stage.") || key.startsWith("Dialog.")) continue;
    if (key.includes(".")) {
      out.push(key);
      continue;
    }
    if (NOT_OBJECT_METHODS.has(key)) continue;
    // A name no object type answers to (`autoVoice(…)`, a stage global) has no
    // behaviour to hang off: it gets a `call:` node below instead. `say` is
    // both a global and a character method, and stays a behaviour because of
    // the second one.
    if (methodTypes(key).length === 0) continue;
    if (/^[A-Z]/.test(key)) continue; // constructors are type nodes, not behaviours
    if (transformMethods.has(key)) continue;
    out.push(key);
  }
  return out;
}

/** Every global / stage / dialog call that gets its own `call:` node. */
export function callNodeKeys() {
  const keys = new Set();
  for (const g of GLOBAL_CALLS) {
    if (g.name !== "dialog" && g.name !== "stage") keys.add(g.name);
  }
  for (const [key, spec] of METHOD_SPECS) {
    if (spec.receiver === "Stage" || spec.receiver === "Dialog") keys.add(key);
  }
  return [...keys].sort();
}

/** `Stage.enable` → `stage.enable`; a bare key stays bare. */
export function globalCallName(key) {
  if (key.startsWith("Stage.")) return `stage.${key.slice(6)}`;
  if (key.startsWith("Dialog.")) return `dialog.${key.slice(7)}`;
  return key;
}

/** The object types a method may be called on (used by the behaviour menu). */
export function methodTypes(key) {
  if (key.includes(".")) {
    const receiver = key.slice(0, key.indexOf("."));
    if (NAMESPACE_SUFFIX[receiver]) {
      return receiver === "Transform" ? ["Character"] : ["Video"];
    }
    if (receiver === "Effect" || receiver === "Video") return [receiver];
    return [...OBJECT_TYPES];
  }
  const types = [];
  for (const [name, group] of OBJECT_METHOD_GROUPS) {
    if (group.own.includes(key)) types.push(name);
  }
  return types.filter((t) => OBJECT_TYPES.includes(t));
}

const TITLE_PREFIX = {
  VideoMedia: "画面轨·", VideoAudio: "声音轨·", Transform: "自由变换·",
  Stage: "舞台·", Dialog: "对话框·",
};

/** A Chinese node title, named after the API's own Chinese spelling. */
export function nodeTitleFor(key) {
  const method = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  const receiver = key.includes(".") ? key.slice(0, key.indexOf(".")) : "";
  return (TITLE_PREFIX[receiver] ?? "") + (aliasesFor(method)[0] ?? method);
}

/** The parameter names a call node shows, from the shared table. */
export function methodParams(key) {
  return METHOD_SPECS.get(key)?.params
    ?? GLOBAL_CALLS.find((g) => g.name === key)?.params
    ?? [];
}
