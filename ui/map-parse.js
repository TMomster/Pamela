// 反向解析：把 Pamela 剧本还原为 `.flowmap` 图。
// Reverse parsing: turn a Pamela script back into a `.flowmap` graph.
//
// 块解析为块节点，不生成分支连线。方法识别、参数形状与节点类型全部来自
// 画布与 API 表（`graph-editor.js` 的 `NODE_TYPES` 与 `api-spec.js`），不再各写
// 一份方法清单；中文别名反向归一化到英文，便于不写代码的人也能用中文脚本
// 反解成节点图。
// The reverse parser is the inverse of `inferGraph`: the behaviour nodes, the
// call nodes and the constructor types are exactly the ones the canvas emits, so
// a parsed script re-infers to the same lines (no lost statements, no `#`
// comments).
import { NODE_TYPES } from "./graph-editor.js";
import { METHOD_SPECS, CONSTRUCTORS } from "./api-spec.js";
import { BUILTIN_ALIASES } from "./pamela.js";

const NODE_DEFAULTS = {
  Start: {},
  // The two halves of an object: a name, and the constructor it is built with.
  NewObject: { objectName: "ch" },
  TypeCharacter: { image: "" },
  TypeBackground: { image: "" },
  TypeAudio: { file: "" },
  // An effect names a built-in kind, not a file; a video names one under
  // assets/Video/. Both use the plain (non-advanced) constructor shape.
  TypeEffect: { effect: "rain" },
  TypeVideo: { file: "" },
  // 文字的第一参数是内容，不是文件。
  TypeText: { text: "" },
  TypeCharacterAdv: { image: "", x: 0, y: 0, scale: 1 },
  TypeBackgroundAdv: { image: "", x: 0, y: 0, scale: 1 },
  TypeLight: { color: "#ffffff" },
  TypeArray: { members: "" },
  // …and the node that uses the name in the flow.
  Object: { objectName: "ch" },
  Say: { speaker: "", text: "" },
  Wait: { ms: 0 },
  Choice: { options: "选项一\n选项二" },
  If: { cond: "true" },
  While: { cond: "true" },
  For: { var: "i", iter: "[1, 2, 3]" },
  Switch: { expr: "x", cases: "1\n2", hasDefault: true },
  Cue: {},
  StageCall: { target: "hero", method: "move", args: "", time: "" },
  SetVar: { name: "count", value: "0" },
  Include: { file: "scene.pe" },
  Jump: { file: "scene.pe" },
  Use: { file: "" },
  DialogEnable: {},
  DialogDisable: {},
  FuncDef: { name: "fn", args: "" },
  FuncCall: { name: "fn", args: "" },
  Return: { value: "" },
  Break: {},
  Continue: {},
  Filter: { target: "hero", mode: "rgb", r: 0, g: 0, b: 0, hex: "#ffffff" },
};

/** Chinese / shorthand → the English name the runtime answers to. */
const ENGLISH_OF = new Map();
for (const [chinese, english] of BUILTIN_ALIASES) {
  ENGLISH_OF.set(chinese, english);
}
/** Resolve a written name (maybe Chinese) to its English spelling. */
const englishOf = (name) => ENGLISH_OF.get(name) ?? name;

/** The behaviour method keys that have a node on the canvas (e.g. `move`, `VideoMedia.blur`). */
let _behaviorKeys = null;
function behaviorKeys() {
  if (!_behaviorKeys) {
    _behaviorKeys = new Set(
      Object.keys(NODE_TYPES)
        .filter((t) => t.startsWith("beh:"))
        .map((t) => t.slice(4)),
    );
  }
  return _behaviorKeys;
}
/** The parameter keys a behaviour node takes, in order. */
function behaviorParamKeys(key) {
  return NODE_TYPES[`beh:${key}`]?.params?.map((p) => p.key) ?? [];
}

/** The constructors the canvas knows (`Character`, `Light`, `Array`, …). */
const CONSTRUCTOR_NAMES = new Set(CONSTRUCTORS.map((c) => c.name));
/** A namespace receiver's spelling in a real call: `.media.blur(…)`. */
const NS_RECEIVER = { media: "VideoMedia", audio: "VideoAudio", transform: "Transform" };
/** An identifier may be Chinese (a script written without code), so the regex
 *  has to accept those letters too. */
const ID = "[A-Za-z_一-鿿][A-Za-z_一-鿿0-9]*";
/** The stage calls that take a trailing duration, for the 动作 fallback node. */
const TAKES_TIME = /^(hide|show|alpha|blur|brightness|contrast|saturate|moveTo|move|rotateTo|rotate|scaleTo|scale|rgb|rgbTo|hex|crossFade)$/;
/** A 动作 node can stand in for these object calls when the object is unknown. */
const STAGE_CALL_METHODS = new Set([
  "enable", "hide", "show", "alpha", "blur", "brightness", "contrast", "saturate",
  "moveTo", "move", "rotateTo", "rotate", "scaleTo", "scale",
  "rgb", "rgbTo", "hex", "front", "back", "crossFade",
  "name", "say",
]);

function unquote(s) {
  if (!s) return "";
  const t = String(s).trim();
  const m = /^["'](.*)["']$/.exec(t);
  const inner = m ? m[1] : t;
  return inner.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

// Splits top-level commas only (so `rgb(1, 2, 3)` stays one piece, and a
// hex colour with no commas is a single piece too).
function splitArgs(s) {
  s = (s ?? "").trim();
  if (!s) return [];
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

// Removes `//` and `#` line comments, but never inside a quoted string.
function stripComment(line) {
  let out = "";
  let inStr = false;
  let q = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inStr) {
      out += c;
      if (c === q && line[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      q = c;
      out += c;
      continue;
    }
    if (c === "#") break;
    if (c === "/" && line[i + 1] === "/") break;
    out += c;
  }
  return out;
}

export function graphFromPamela(code) {
  const rawLines = String(code ?? "")
    .split("\n")
    .map((l) => stripComment(l).trimEnd())
    .filter((l) => l.trim().length > 0);

  // --- tokenize into statements and block open/close markers ---
  const tokens = [];
  for (const raw of rawLines) {
    let t = raw.trim();

    // `} else {` is both a block close and an opener on one line: split it so
    // the `else` becomes its own open token after the closing brace.
    if (t.startsWith("}") && t.length > 1) {
      tokens.push({ type: "close" });
      t = t.slice(1).trim();
    }

    if (t === "}") {
      tokens.push({ type: "close" });
      continue;
    }
    if (t.endsWith("{")) {
      const m = /^(.*?)\s*\{$/.exec(t);
      const head = m ? m[1].trim() : t;
      if (head === "choice") {
        tokens.push({ type: "open", kind: "choice" });
      } else if (head === "else") {
        tokens.push({ type: "open", kind: "else" });
      } else if (/^if\s*\(/.test(head)) {
        const cond = head.slice(head.indexOf("(") + 1, head.lastIndexOf(")"));
        tokens.push({ type: "open", kind: "if", cond });
      } else if (/^while\s*\(/.test(head)) {
        const cond = head.slice(head.indexOf("(") + 1, head.lastIndexOf(")"));
        tokens.push({ type: "open", kind: "while", cond });
      } else if (/^cue(?:\s*\(\s*(-?\d+(?:\.\d+)?)\s*\))?\s*$/.test(head)) {
        const m = /^cue(?:\s*\(\s*(-?\d+(?:\.\d+)?)\s*\))?\s*$/.exec(head);
        tokens.push({ type: "open", kind: "cue", time: m[1] !== undefined ? Number(m[1]) : null });
      } else if (/^for\s+([A-Za-z_]\w*)\s+in\s+(.+)$/.test(head)) {
        const m = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+)$/.exec(head);
        tokens.push({ type: "open", kind: "for", var: m[1], iter: m[2].trim() });
      } else if (/^switch\s+(.+)$/.test(head)) {
        const m = /^switch\s+(.+)$/.exec(head);
        tokens.push({ type: "open", kind: "switch", expr: m[1].trim() });
      } else if (/^case\s+(.+)$/.test(head)) {
        const m = /^case\s+(.+)$/.exec(head);
        tokens.push({ type: "open", kind: "case", value: m[1].trim() });
      } else if (head === "default") {
        tokens.push({ type: "open", kind: "default" });
      } else if (/^func\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*$/.test(head)) {
        const m = /^func\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*$/.exec(head);
        tokens.push({ type: "open", kind: "func", name: m[1], args: m[2] ? m[2].trim() : "" });
      } else if (/^"((?:[^"\\]|\\.)*)"\s*$/.test(head)) {
        let label = head;
        try {
          label = JSON.parse(head);
        } catch {
          label = unquote(head);
        }
        tokens.push({ type: "open", kind: "option", label });
      } else {
        tokens.push({ type: "open", kind: "block" });
      }
      continue;
    }
    tokens.push({ type: "stmt", text: t });
  }

  // --- build a tree from brace structure ---
  let i = 0;
  function parseBlock() {
    const stmts = [];
    while (i < tokens.length) {
      const tk = tokens[i];
      if (tk.type === "close") {
        i += 1;
        return stmts;
      }
      if (tk.type === "open") {
        i += 1;
        const body = parseBlock();
        if (tk.kind === "if") {
          // An `else` sibling (from `} else {`) is merged in below, not nested
          // inside this body.
          stmts.push({ block: "if", cond: tk.cond, body, elseBody: [] });
        } else if (tk.kind === "choice") {
          const options = body
            .filter((b) => b.block === "option")
            .map((b) => ({ label: b.label, body: b.body }));
          stmts.push({ block: "choice", options });
        } else if (tk.kind === "while") {
          stmts.push({ block: "while", cond: tk.cond, body });
        } else if (tk.kind === "for") {
          stmts.push({ block: "for", var: tk.var, iter: tk.iter, body });
        } else if (tk.kind === "switch") {
          const cases = body
            .filter((b) => b.block === "case")
            .map((b) => ({ value: b.value, body: b.body }));
          const def = body.filter((b) => b.block === "default");
          stmts.push({
            block: "switch",
            expr: tk.expr,
            cases,
            defaultBody: def.length ? def[0].body : [],
          });
        } else if (tk.kind === "cue") {
          stmts.push({ block: "cue", body, time: tk.time ?? null });
        } else if (tk.kind === "func") {
          stmts.push({ block: "func", name: tk.name, args: tk.args, body });
        } else if (tk.kind === "else") {
          // Attach to the nearest preceding `if` at this level.
          for (let k = stmts.length - 1; k >= 0; k -= 1) {
            if (stmts[k].block === "if") {
              stmts[k].elseBody = body;
              break;
            }
          }
        } else if (tk.kind === "case") {
          stmts.push({ block: "case", value: tk.value, body });
        } else if (tk.kind === "default") {
          stmts.push({ block: "default", body });
        } else if (tk.kind === "option") {
          stmts.push({ block: "option", label: tk.label, body });
        } else {
          stmts.push({ block: "block", body });
        }
        continue;
      }
      stmts.push({ stmt: tk.text });
      i += 1;
    }
    return stmts;
  }
  const tree = parseBlock();

  // --- emit nodes and exec edges ---
  // Keep in step with GRAPH_VERSION in graph-editor.js; a reverse parse never
  // invents groups — they are a layout-only feature of the canvas.
  const graph = { version: 4, nodes: [], edges: [], dataEdges: [], groups: [] };
  const nodes = graph.nodes;
  const edges = graph.edges;
  const dataEdges = graph.dataEdges;
  const varToNode = Object.create(null); // variable name -> node id
  const knownVars = new Set();
  const objectTypeByName = Object.create(null); // variable name -> constructor type

  let nodeCounter = 0;
  let edgeCounter = 0;
  let dataCounter = 0;

  function addNode(type, parent = null, parentPort = 0) {
    const id = `n${++nodeCounter}`;
    const params = { ...(NODE_DEFAULTS[type] || {}) };
    const node = {
      id,
      type,
      // Positions are assigned by the layout pass at the end; a body is laid
      // out inside its own box, so the numbers here are only a starting point.
      x: 140,
      y: 120,
      params,
    };
    if (["If", "While", "Choice", "Cue", "For", "Switch", "FuncDef"].includes(type)) {
      node.w = type === "FuncDef" ? 300 : 280;
      node.h = type === "FuncDef" ? 160 : 150;
    }
    if (parent) {
      node.parent = parent;
      node.parentPort = parentPort;
    }
    nodes.push(node);
    return node;
  }

  function connectExec(fromId, fromPort, toId) {
    if (!fromId || !toId) return;
    edges.push({
      id: `e${++edgeCounter}`,
      from: { node: fromId, port: fromPort },
      to: { node: toId, port: 0 },
    });
  }

  function addDataEdge(fromId, fromPort, toId, toPort) {
    dataEdges.push({
      id: `d${++dataCounter}`,
      from: { node: fromId, port: fromPort },
      to: { node: toId, port: toPort },
    });
  }

  function nodeById(id) {
    return nodes.find((n) => n.id === id);
  }

  /** A name of this type that no object on the canvas is using yet. */
  function uniqueName(type) {
    const base = {
      Background: "bg",
      Character: "ch",
      Audio: "bgm",
      Effect: "ef",
      Video: "clip",
      Text: "txt",
      Light: "lamp",
      Array: "group",
    }[type] ?? "obj";
    // Only a declaration owns a name; a 对象 node is talking about one.
    const used = new Set(
      nodes.filter((n) => n.type === "NewObject").map((n) => n.params.objectName),
    );
    if (!used.has(base)) return base;
    let k = 2;
    while (used.has(`${base}${k}`)) k += 1;
    return `${base}${k}`;
  }

  /**
   * Records a call as a behaviour node hanging off its object.
   *
   * The call's arguments are filled positionally into the behaviour node's
   * own fields — the same fields `inferGraph` reads back — so a parsed script
   * re-emits to the exact same call.
   */
  function addBehavior(owner, methodKey, args) {
    if (!behaviorKeys().has(methodKey)) return null;
    const type = `beh:${methodKey}`;
    const n = addNode(type);
    n.behaviorOf = owner.id;
    if (methodKey === "key") {
      // A key with no file names none: it falls back to the object's own name,
      // so the node keeps no argument rather than writing `key("")`.
      n.params = {};
      return n;
    }
    if (methodKey === "group") {
      // A sprite group is variable-length: every picture is one field in the
      // node, joined back into one argument per picture when the script is
      // written out (see `behaviorArgs`).
      n.params = {
        files: args
          .map((raw) => (raw.startsWith('"') || raw.startsWith("'") ? unquote(raw) : raw))
          .join(", "),
      };
      return n;
    }
    const paramKeys = behaviorParamKeys(methodKey);
    args.forEach((raw, idx) => {
      const key = paramKeys[idx];
      if (!key) return;
      n.params[key] = raw.startsWith('"') || raw.startsWith("'") ? unquote(raw) : raw;
    });
    return n;
  }

  /** The 对象 node a `<name>.method(...)` call belongs to, if any. */
  function objectFor(name) {
    const id = varToNode[name];
    const node = id ? nodeById(id) : null;
    return node && node.type === "Object" ? node : null;
  }

  /** The declaration a name refers to, or null. */
  function declareFor(name) {
    const call = objectFor(name);
    if (!call) return null;
    return nodes.find(
      (n) => n.type === "NewObject" && n.params.objectName === call.params.objectName,
    );
  }

  /**
   * Builds one object: a 新对象, the type it is constructed with, and the 对象
   * node that uses it.
   */
  function makeObject(name, type, args) {
    const [resource, ...rest] = args;
    // Named arguments, as the canvas writes them: `x = -300`.
    const named = {};
    for (const arg of rest) {
      const m = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(arg.trim());
      if (m) named[m[1]] = m[2].trim();
    }
    // Only pictures have an "advanced" constructor with a place and a size.
    const advanced =
      (type === "Character" || type === "Background") &&
      ["x", "y", "scale", "scaleTo"].some((key) => named[key] !== undefined);

    const declare = addNode("NewObject");
    declare.params.objectName = name;

    const typeKey = advanced ? `Type${type}Adv` : `Type${type}`;
    const ctor = addNode(typeKey);
    if (type === "Effect") ctor.params.effect = resource ? unquote(resource) : "rain";
    else if (type === "Text") ctor.params.text = resource ? unquote(resource) : "";
    else if (type === "Light") ctor.params.color = resource ? unquote(resource) : "#ffffff";
    else if (type === "Array") ctor.params.members = args.join(", ");
    else if (type === "Audio" || type === "Video") ctor.params.file = resource ? unquote(resource) : "";
    else ctor.params.image = resource ? unquote(resource) : "";
    if (advanced) {
      ctor.params.x = Number(named.x ?? 0) || 0;
      ctor.params.y = Number(named.y ?? 0) || 0;
      ctor.params.scale = Number(named.scaleTo ?? named.scale ?? 1) || 1;
    }
    edges.push({
      id: `e${++edgeCounter}`,
      from: { node: declare.id, port: 0 },
      to: { node: ctor.id, port: 0 },
    });

    const call = addNode("Object");
    call.params.objectName = name;
    varToNode[name] = call.id;
    knownVars.add(name);
    objectTypeByName[name] = type;
    return call;
  }

  /** Splits `target.rest`, where `rest` may carry a `.media` / `.audio` / `.transform` namespace. */
  function splitObjectCall(text) {
    const target = new RegExp(`^(${ID})`).exec(text)?.[1];
    if (!target) return null;
    const rest = text.slice(target.length);
    const segments = [];
    const re = new RegExp(`\\.(${ID})(?=\\.)|\\.(${ID})\\(([^()]*)\\)`, "g");
    let ns = null;
    let mm;
    while ((mm = re.exec(rest))) {
      if (mm[1]) {
        ns = mm[1];
        continue;
      }
      segments.push({ namespace: ns, method: mm[2], args: mm[3] });
      ns = null;
    }
    if (!segments.length) return null;
    return { target, segments };
  }

  /** `dialog.say("hi", hero)` → Say node, the second arg becoming a data wire. */
  function makeDialogSay(argText) {
    const args = splitArgs(argText);
    const n = addNode("Say");
    n.params.text = args[0] ? unquote(args[0]) : "";
    if (args[1] !== undefined) {
      const sp = args[1].trim();
      if (/^[A-Za-z_]\w*$/.test(sp) && varToNode[sp]) {
        addDataEdge(varToNode[sp], 0, n.id, 0);
      } else {
        n.params.speaker = sp;
      }
    }
    return n;
  }

  /** A `call:` node for a stage / dialog / global API. */
  function addCallNode(key, argText) {
    const n = addNode(`call:${key}`);
    const spec = METHOD_SPECS.get(key);
    if (spec?.bulk || spec?.variadic) {
      // One free-form field holds the whole list (a variadic call keeps its `:`).
      n.params.args = String(argText ?? "").trim();
      return n;
    }
    const keys = NODE_TYPES[`call:${key}`]?.params?.map((p) => p.key) ?? [];
    splitArgs(argText).forEach((raw, idx) => {
      const k = keys[idx];
      if (!k) return;
      n.params[k] = raw.startsWith('"') || raw.startsWith("'") ? unquote(raw) : raw;
    });
    return n;
  }

  /** The 动作 fallback node for a call on an object the canvas does not know. */
  function addStageCall(target, method, argText) {
    const n = addNode("StageCall");
    n.params.target = target;
    n.params.method = method;
    const args = splitArgs(argText);
    const timeArg = args.length > 1 ? args[args.length - 1] : undefined;
    if (TAKES_TIME.test(method) && timeArg !== undefined && /^\d+$/.test(timeArg) && args.length > 1) {
      n.params.args = args.slice(0, -1).join(", ");
      n.params.time = timeArg;
    } else {
      n.params.args = args.join(", ");
      n.params.time = "";
    }
    return n;
  }

  /** `ch.rgbTo(...)` on an unknown object → the generic 滤镜 node. */
  function addFilter(target, mode, argText) {
    const n = addNode("Filter");
    n.params.target = target;
    n.params.mode = mode;
    const args = splitArgs(argText);
    if (mode === "hex") {
      n.params.hex = args[0] ? unquote(args[0]) : "#ffffff";
    } else {
      n.params.r = Number(args[0] || 0);
      n.params.g = Number(args[1] || 0);
      n.params.b = Number(args[2] || 0);
    }
    return n;
  }

  /** A call on an object, or on the stage / dialog, resolved through the API table. */
  function stageCall(text) {
    const parsed = splitObjectCall(text);
    if (!parsed) return null;
    const { target, segments } = parsed;
    const owner = objectFor(target);
    const firstSeg = segments[0];
    // The older `followPath("id")` spelling folds into the 关键帧 node.
    if (firstSeg && englishOf(firstSeg.method) === "followPath") {
      firstSeg.method = "key";
      firstSeg.args = "";
    }

    // The stage and dialog own the calls that take no object receiver.
    if (target === "stage" || target === "dialog") {
      const seg = segments[0];
      const en = englishOf(seg.method);
      if (target === "dialog" && en === "say") return makeDialogSay(seg.args);
      if (target === "dialog" && en === "enable") return addNode("DialogEnable");
      if (target === "dialog" && en === "disable") return addNode("DialogDisable");
      const key = `${target === "stage" ? "Stage" : "Dialog"}.${en}`;
      if (NODE_TYPES[`call:${key}`]) return addCallNode(key, seg.args);
      return addStageCall(target, en, seg.args);
    }

    const ownerType = owner ? objectTypeByName[target] : null;
    let first = null;
    for (const seg of segments) {
      const method = englishOf(seg.method);
      let key;
      if (seg.namespace) {
        const receiver = NS_RECEIVER[englishOf(seg.namespace)];
        key = `${receiver}.${method}`;
      } else if (ownerType && NODE_TYPES[`beh:${ownerType}.${method}`]) {
        key = `${ownerType}.${method}`;
      } else {
        key = method;
      }
      let n = null;
      if (owner && behaviorKeys().has(key)) {
        n = addBehavior(owner, key, splitArgs(seg.args));
      } else if (method === "rgb" || method === "rgbTo" || method === "hex") {
        n = addFilter(target, method, seg.args);
      } else if (owner && behaviorKeys().has(method)) {
        n = addBehavior(owner, method, splitArgs(seg.args));
      } else {
        n = addStageCall(target, method, seg.args);
      }
      if (n && !first) first = n;
    }
    return first;
  }

  function makeNode(text) {
    // `<name> = <Type>("resource", x = …)` — the definition's own shape. The
    // arguments after the resource become the type node's fields.
    const obj = /^([A-Za-z_]\w*)\s*=\s*([A-Za-z_一-鿿]+)\(([\s\S]*)\)$/.exec(text);
    if (obj) {
      const type = englishOf(obj[2]);
      if (CONSTRUCTOR_NAMES.has(type)) {
        return makeObject(obj[1], type, splitArgs(obj[3]));
      }
    }
    // A bare `Background("x.png")` with no assignment: the canvas still wants a
    // name for it, so it gets one that is not already taken.
    const bare = /^([A-Za-z_一-鿿]+)\(([\s\S]*)\)$/.exec(text);
    if (bare) {
      const type = englishOf(bare[1]);
      if (CONSTRUCTOR_NAMES.has(type)) {
        return makeObject(uniqueName(type), type, splitArgs(bare[2]));
      }
    }
    // The narrator's line: `dialog.say(…)`, `stage.say(…)`, or a bare `say(…)`
    // — the last two are the same call, since a bare `say` is the stage's.
    const say = /^(?:dialog\.say|stage\.say|say)\(\s*("(?:[^"\\]|\\.)*"|'[^']*')(?:\s*,\s*([^)]*))?\s*\)$/.exec(text);
    if (say) {
      const n = addNode("Say");
      n.params.text = unquote(say[1]);
      if (say[2] !== undefined) {
        const sp = say[2].trim();
        // A bare variable reference becomes a data connection from that node.
        if (/^[A-Za-z_]\w*$/.test(sp) && varToNode[sp]) {
          addDataEdge(varToNode[sp], 0, n.id, 0);
        } else {
          n.params.speaker = sp;
        }
      }
      return n;
    }
    const wait = /^wait\s+(\d+)$/.exec(text);
    if (wait) {
      const n = addNode("Wait");
      n.params.ms = Number(wait[1]);
      return n;
    }
    const use = /^use\s+("(?:[^"\\]|\\.)*"|'[^']*')$/.exec(text);
    if (use) {
      const n = addNode("Use");
      n.params.file = unquote(use[1]);
      return n;
    }
    if (/^dialog\.enable\(\)$/.test(text)) return addNode("DialogEnable");
    if (/^dialog\.disable\(\)$/.test(text)) return addNode("DialogDisable");
    const inc = /^include\s+("(?:[^"\\]|\\.)*"|'[^']*')$/.exec(text);
    if (inc) {
      const n = addNode("Include");
      n.params.file = unquote(inc[1]);
      return n;
    }
    const jmp = /^jump\(\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\)$/.exec(text);
    if (jmp) {
      const n = addNode("Jump");
      n.params.file = unquote(jmp[1]);
      return n;
    }
    const assign = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(text);
    if (assign) {
      const n = addNode("SetVar");
      n.params.name = assign[1];
      n.params.value = assign[2].trim();
      varToNode[assign[1]] = n.id;
      knownVars.add(assign[1]);
      return n;
    }
    // `return x` / `break` / `continue` — statements a function or loop emits.
    const ret = /^return\s*(.*)$/.exec(text);
    if (ret) {
      const n = addNode("Return");
      n.params.value = ret[1].trim();
      return n;
    }
    if (/^break\s*$/.test(text)) return addNode("Break");
    if (/^continue\s*$/.test(text)) return addNode("Continue");
    // A bare `name(args)` with no receiver is a function call or a global the
    // canvas has a node for (`str`, `len`, …); otherwise it is a function call.
    const call = /^([A-Za-z_]\w*)\(([^)]*)\)$/.exec(text);
    if (call) {
      const name = englishOf(call[1]);
      if (NODE_TYPES[`call:${name}`]) return addCallNode(name, call[2]);
      const n = addNode("FuncCall");
      n.params.name = name;
      n.params.args = String(call[2] ?? "").trim();
      return n;
    }
    // A call on a stage object: everything the canvas has a box for, plus the
    // generic 动作 node for the rest.
    return stageCall(text);
  }

  /**
   * Emits one block's statements as nodes inside the block.
   *
   * Returns the id of the first node, which the caller wires from the block's
   * input (or from the previous statement). The nodes carry `parent`/
   * `parentPort`, so no wires are needed *inside* a body: position is the order.
   */
  function emitBody(stmts, parentId, parentPort) {
    let prev = null;
    let first = null;
    for (const s of stmts) {
      let node = null;
      if (s.stmt) {
        node = makeNode(s.stmt);
      } else {
        node = makeBranch(s, parentId, parentPort);
      }
      if (!node) continue;
      // A behaviour is not a step in the flow: it is stacked under the object it
      // calls, so the exec chain must not link through it — nor start from it.
      if (node.type.startsWith("beh:")) {
        continue;
      }
      // A function definition is emitted separately (above the flow), so it must
      // not be wired into the main exec chain.
      if (node.type === "FuncDef") {
        continue;
      }
      // A statement written inside a block belongs to it: the block is its
      // body, and position is its order, so no wire is drawn for it.
      if (parentId && !node.parent) {
        node.parent = parentId;
        node.parentPort = parentPort ?? 0;
      }
      if (!parentId && prev) connectExec(prev, 0, node.id);
      if (!first) first = node.id;
      prev = node.id;
    }
    return first;
  }

  function makeBranch(block, parentId, parentPort) {
    if (block.block === "if") {
      const n = addNode("If", parentId, parentPort);
      n.params.cond = block.cond || "true";
      emitBody(block.body, n.id, 0);
      emitBody(block.elseBody || [], n.id, 1);
      return n;
    }
    if (block.block === "choice") {
      const n = addNode("Choice", parentId, parentPort);
      const options = block.options || [];
      n.params.options = (options.length ? options : [{ label: "选项一", body: [] }])
        .map((o) => o.label)
        .join("\n");
      options.forEach((opt, idx) => {
        emitBody(opt.body, n.id, idx);
      });
      return n;
    }
    if (block.block === "while") {
      const n = addNode("While", parentId, parentPort);
      n.params.cond = block.cond || "true";
      emitBody(block.body, n.id, 0);
      return n;
    }
    if (block.block === "for") {
      const n = addNode("For", parentId, parentPort);
      n.params.var = block.var || "i";
      n.params.iter = block.iter || "[]";
      emitBody(block.body, n.id, 0);
      return n;
    }
    if (block.block === "switch") {
      const n = addNode("Switch", parentId, parentPort);
      n.params.expr = block.expr || "null";
      const cases = block.cases || [];
      n.params.cases = cases.length ? cases.map((c) => c.value).join("\n") : "1";
      n.params.hasDefault = Boolean(block.defaultBody && block.defaultBody.length);
      cases.forEach((c, idx) => emitBody(c.body, n.id, idx));
      if (block.defaultBody) emitBody(block.defaultBody, n.id, cases.length);
      return n;
    }
    if (block.block === "cue") {
      const n = addNode("Cue", parentId, parentPort);
      // `time` survives a text → graph → text round trip: reverse import keeps it,
      // and the generator emits `cue(N)` when it is set.
      if (block.time !== null && block.time !== undefined) {
        n.params.time = block.time;
      }
      emitBody(block.body, n.id, 0);
      return n;
    }
    if (block.block === "func") {
      // A function is one of the canvas's definitions: it is emitted above the
      // flow, so its body is placed inside it but it is never a step of the flow.
      const n = addNode("FuncDef", parentId, parentPort);
      n.params.name = block.name || "fn";
      n.params.args = block.args || "";
      emitBody(block.body, n.id, 0);
      return n;
    }
    // An unlabelled block is a plain group: its statements belong to the level
    // it was written at.
    return emitBody(block.body, parentId, parentPort) ? null : null;
  }

  const start = addNode("Start");
  const first = emitBody(tree, null, 0);
  connectExec(start.id, 0, first);

  layout(graph);
  return graph;
}

/**
 * Places the graph: the top level left to right, every body inside its box.
 */
function layout(graph) {
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Top level: follow the exec chain from Start and lay the statements out in a
  // column, which is the shape a script reads in.
  const start = nodes.find((n) => n.type === "Start");
  let y = 120;
  let x = 140;
  const seen = new Set();
  let cur = start?.id ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    node.x = x;
    node.y = y;
    y += nodeHeight(node) + 60;
    const edge = graph.edges.find((e) => e.from.node === cur && e.from.port === 0);
    cur = edge ? edge.to.node : null;
  }

  // Definitions: their own column to the left of the flow, which is where they
  // belong — `ch = Character("…")` is not a step, and reading a scene should not
  // mean stepping over the cast. Each name sits above the constructor it uses.
  let defY = 120;
  for (const declare of nodes.filter((n) => n.type === "NewObject")) {
    declare.x = 40;
    declare.y = defY;
    const ctor = nodes.find((n) =>
      graph.edges.some((e) => e.from.node === declare.id && e.to.node === n.id),
    );
    if (ctor) {
      ctor.x = 40;
      ctor.y = defY + 100;
      defY = ctor.y + 150;
    } else {
      defY += 160;
    }
  }

  // Functions: another definition, kept off to the left so they do not collide
  // with the cast or the flow.
  let fnY = 120;
  for (const fn of nodes.filter((n) => n.type === "FuncDef")) {
    fn.x = -380;
    fn.y = fnY;
    fnY += fn.h + 80;
  }

  // Behaviours: stacked under the object they call, in the order they were
  // written — the stack is the chain.
  for (const call of nodes.filter((n) => n.type === "Object")) {
    let y = call.y + nodeHeight(call);
    for (const behavior of nodes.filter((n) => n.behaviorOf === call.id)) {
      behavior.x = call.x;
      behavior.y = y;
      y += nodeHeight(behavior);
    }
  }

  // Bodies: one node per row inside its lane. Outermost boxes first, because a
  // box's size has to be known before its children can be placed in it.
  const depthOf = (node) => {
    let d = 0;
    let c = node;
    const guard = new Set();
    while (c?.parent && !guard.has(c.parent)) {
      guard.add(c.parent);
      c = byId.get(c.parent);
      if (!c) break;
      d += 1;
    }
    return d;
  };
  const laneCount = (parent) => {
    if (parent.type === "Choice") {
      const n = String(parent.params.options ?? "").split("\n").filter((s) => s.trim()).length;
      return Math.max(1, n);
    }
    if (parent.type === "Switch") {
      const parts = String(parent.params.cases ?? "").split("\n").filter((s) => s.trim());
      const extra = parent.params.hasDefault ? 1 : 0;
      return Math.max(1, parts.length + extra);
    }
    return parent.type === "If" ? 2 : 1;
  };
  const parents = [...new Set(nodes.filter((n) => n.parent).map((n) => n.parent))]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => depthOf(a) - depthOf(b));

  for (const parent of parents) {
    const lanes = laneCount(parent);
    parent.w = Math.max(parent.w ?? 0, lanes * LANE_W + 28);
    parent.h = Math.max(parent.h ?? 0, 150);
    const rows = new Map();
    const body = nodes
      .filter((n) => n.parent === parent.id)
      .sort((a, b) => (a.parentPort ?? 0) - (b.parentPort ?? 0) || a.id.localeCompare(b.id, "en", { numeric: true }));
    for (const node of body) {
      const port = Math.min(node.parentPort ?? 0, lanes - 1);
      const row = rows.get(port) ?? 0;
      rows.set(port, row + 1);
      node.x = parent.x + 14 + port * LANE_W + 10;
      node.y = parent.y + HEAD_H + row * ROW_STEP;
      // A box inside a box pushes its own box out to hold it.
      parent.w = Math.max(parent.w, node.x - parent.x + (node.w ?? 210) + 14);
      parent.h = Math.max(parent.h, node.y - parent.y + nodeHeight(node) + 20);
    }
  }
}

/** Width reserved for one lane of a block. */
const LANE_W = 260;
/** Where the first row of a body starts, below the lane's label band. */
const HEAD_H = 110;
/** Vertical distance between two statements of a body. */
const ROW_STEP = 130;

/** Approximate height of a node, used by the layout pass. */
function nodeHeight(node) {
  if (["If", "While", "Choice", "Cue", "FuncDef"].includes(node.type)) {
    return Math.max(node.h ?? 0, 150);
  }
  if (node.type === "Say") return 150;
  if (node.type === "Character" || node.type === "TypeCharacter" || node.type === "TypeCharacterAdv") return 190;
  if (node.type === "StageCall" || node.type === "Filter") return 200;
  if (node.type.startsWith("beh:")) return 110;
  return 110;
}
