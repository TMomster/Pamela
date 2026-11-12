// flowmap 对齐（阶段 1）：单一 API 表的覆盖断言与 `.flowmap` v4 兼容。
// Stage 1 of the alignment plan: the API table must know every name the
// language answers to, and older maps must still open with groups = [].

import assert from "node:assert/strict";
import test from "node:test";

import {
  API_TABLE,
  CONSTRUCTORS,
  GLOBAL_CALLS,
  METHOD_SPECS,
  BULK_CALLS,
  OBJECT_METHOD_GROUPS,
  allApiKeys,
  aliasesFor,
  behaviorNodeKeys,
  behaviorSuffix,
  callNodeKeys,
  globalCallName,
  paramControl,
} from "../api-spec.js";
import {
  PARAM_SPECS,
  BUILTIN_GLOBALS,
  BUILTIN_METHODS,
  BUILTIN_ALIASES,
  BULK_METHODS,
  VARIADIC_CALLS,
  KEYWORDS,
} from "../pamela.js";
import { COMPLETIONS } from "../completion.js";
import {
  GRAPH_VERSION,
  NODE_TYPES,
  behaviorMethodOf,
  behaviorTypeName,
  emptyGraph,
  groupBounds,
  inferGraph,
  isBehaviorNode,
  methodsFor,
  nodesWithinRect,
  normalizeGraph,
  normalizeGroups,
  parseGraph,
  serializeGraph,
} from "../graph-editor.js";
import { graphFromPamela } from "../map-parse.js";

const keys = allApiKeys();

test("API 表：PARAM_SPECS 的每条签名都在表里", () => {
  for (const key of Object.keys(PARAM_SPECS)) {
    assert.ok(keys.has(key), `缺少签名 ${key}`);
    assert.ok(METHOD_SPECS.has(key), `METHOD_SPECS 缺 ${key}`);
    assert.deepEqual(
      METHOD_SPECS.get(key).params,
      PARAM_SPECS[key],
      `${key} 的参数顺序必须与语言一致`,
    );
  }
});

test("API 表：全局名、内建方法、中文别名目标一个不落", () => {
  for (const name of BUILTIN_GLOBALS) assert.ok(keys.has(name), `缺少全局名 ${name}`);
  for (const name of BUILTIN_METHODS) assert.ok(keys.has(name), `缺少内建方法 ${name}`);
  for (const [chinese, english] of BUILTIN_ALIASES) {
    assert.ok(keys.has(english), `${chinese} → ${english} 在 API 表里没有对应项`);
  }
  for (const name of Object.keys(BULK_METHODS)) assert.ok(keys.has(name), `缺少批量调用 ${name}`);
  for (const name of Object.keys(VARIADIC_CALLS)) assert.ok(keys.has(name), `缺少变长调用 ${name}`);
  for (const name of KEYWORDS) assert.ok(API_TABLE.keywords.has(name), `缺少关键字 ${name}`);
});

test("API 表：补全里的每个方法名都由表覆盖", () => {
  for (const entry of COMPLETIONS) {
    for (const member of entry.methods ?? []) {
      assert.ok(keys.has(member.label), `${entry.name}.${member.label} 未覆盖`);
      for (const sub of member.methods ?? []) {
        assert.ok(keys.has(sub.label), `${entry.name}.${member.label}.${sub.label} 未覆盖`);
      }
    }
  }
});

test("API 表：构造器与全局调用都带中文别名", () => {
  const constructorNames = new Set(CONSTRUCTORS.map((c) => c.name));
  for (const name of ["Background", "Character", "Audio", "Effect", "Video", "Text", "Light", "Array"]) {
    assert.ok(constructorNames.has(name), `缺少构造器 ${name}`);
  }
  const globalNames = new Set(GLOBAL_CALLS.map((g) => g.name));
  for (const name of ["say", "click", "auto", "str", "jump", "len", "dialog", "stage"]) {
    assert.ok(globalNames.has(name), `缺少全局调用 ${name}`);
  }
  assert.ok(aliasesFor("Light").includes("光源"));
  assert.ok(aliasesFor("show").includes("渐入"), "同一个英文名的多个中文写法都要保留");
});

test("API 表：两级点调用、舞台批量与变长调用", () => {
  for (const key of [
    "Effect.play", "Video.play", "VideoMedia.play", "VideoAudio.play",
    "VideoMedia.blur", "VideoAudio.mute", "Transform.upleft", "Transform.downTo",
    "Stage.say", "Dialog.say", "Stage.click", "Stage.auto",
    "Stage.enable", "Stage.move", "Stage.exclude", "Stage.unexclude",
  ]) {
    assert.ok(METHOD_SPECS.has(key), `缺少 ${key}`);
  }
  assert.equal(BULK_CALLS.length, Object.keys(BULK_METHODS).length);
  assert.equal(METHOD_SPECS.get("Stage.exclude").variadic, true);
  assert.equal(METHOD_SPECS.get("Stage.enable").bulk, true);
  const video = OBJECT_METHOD_GROUPS.get("Video");
  assert.ok(video?.namespaces.some((ns) => ns.name === "media"));
  assert.ok(video?.namespaces.some((ns) => ns.name === "audio"));
});

test("参数控件：布尔 / 数值 / 多行文本 / 关键帧资源", () => {
  assert.equal(paramControl("dx").type, "number");
  assert.equal(paramControl("time").type, "number");
  assert.equal(paramControl("value", "crood").type, "bool");
  assert.equal(paramControl("value", "alpha").type, "number");
  assert.equal(paramControl("loop").type, "bool");
  assert.equal(paramControl("text").type, "multiline");
  assert.equal(paramControl("hex").type, "text");
  assert.equal(paramControl("file", "key").asset, "keyframes");
  for (const method of METHOD_SPECS.values()) {
    assert.ok(Array.isArray(method.params), `${method.key} 的参数不是数组`);
    assert.ok(typeof method.hint === "string" && method.hint.startsWith("("));
  }
});

test("flowmap v4：空图带 groups，旧文件读入后幂等升级", () => {
  assert.equal(GRAPH_VERSION, 4);
  const empty = emptyGraph();
  assert.equal(empty.version, GRAPH_VERSION);
  assert.deepEqual(empty.groups, []);

  const old = { version: 3, nodes: [], edges: [], dataEdges: [] };
  const upgraded = normalizeGraph(old);
  assert.equal(upgraded.version, GRAPH_VERSION);
  assert.deepEqual(upgraded.groups, []);
  assert.deepEqual(normalizeGraph(upgraded), upgraded, "重复读入不得改变图");

  const parsed = parseGraph(JSON.stringify({ nodes: [], edges: [] }));
  assert.equal(parsed.version, GRAPH_VERSION);
  assert.deepEqual(parsed.groups, []);
});

test("flowmap v4：groups 随文档序列化往返，且反向解析不生成组", () => {
  const graph = emptyGraph();
  graph.groups.push({
    id: "g1", name: "开场", color: "#4aa3c4",
    x: 0, y: 0, w: 400, h: 300, members: ["n1"],
  });
  const back = parseGraph(serializeGraph(graph));
  assert.equal(back.version, GRAPH_VERSION);
  assert.deepEqual(back.groups, graph.groups);

  const reversed = graphFromPamela("");
  assert.equal(reversed.version, GRAPH_VERSION, "反向解析必须与画布同版本");
  assert.deepEqual(reversed.groups, [], "反向解析不生成组");
});

// --- 阶段 2：每个 API 都有专属节点 ---

test("阶段 2：构造器 / 对象方法 / 全局调用都有专属节点", () => {
  for (const c of CONSTRUCTORS) {
    assert.ok(
      Object.values(NODE_TYPES).some((def) => def.typeOf === c.name),
      `缺少构造器节点 ${c.name}`,
    );
  }
  const behaviorKeys = behaviorNodeKeys();
  for (const key of behaviorKeys) {
    const type = behaviorTypeName(key);
    assert.ok(NODE_TYPES[type], `缺少行为节点 ${type}`);
    assert.equal(behaviorMethodOf(type), key);
    assert.equal(isBehaviorNode(type), true);
  }
  for (const key of callNodeKeys()) {
    const def = NODE_TYPES[`call:${key}`];
    assert.ok(def, `缺少调用节点 ${key}`);
    assert.deepEqual(def.inputs, ["执行"]);
    assert.deepEqual(def.outputs, ["执行"]);
  }
  assert.equal(methodsFor(null).length, behaviorKeys.length, "菜单不能再漏方法");
});

test("阶段 2：两级点、舞台批量与动作下拉都由 API 表决定", () => {
  assert.equal(behaviorSuffix("VideoMedia.blur"), "media.blur");
  assert.equal(behaviorSuffix("VideoAudio.mute"), "audio.mute");
  assert.equal(behaviorSuffix("Transform.upleft"), "transform.upleft");
  assert.equal(behaviorSuffix("Effect.play"), "play");
  assert.equal(globalCallName("Stage.ambient"), "stage.ambient");
  assert.equal(globalCallName("Dialog.say"), "dialog.say");
  assert.ok(callNodeKeys().includes("Stage.ambient"));
  const options = NODE_TYPES.StageCall.params.find((p) => p.key === "method").options;
  const bare = behaviorNodeKeys().filter((k) => !k.includes("."));
  assert.equal(options.length, bare.length, "动作下拉与 API 表必须同集合");
  for (const key of bare) assert.ok(options.includes(key), `动作下拉缺 ${key}`);
});

test("阶段 2：新节点生成的脚本是合法的 .pe", () => {
  const node = (id, type, params, extra = {}) => ({ id, type, x: 0, y: 0, params, ...extra });
  const edge = (id, from, to) => ({
    id, from: { node: from, port: 0 }, to: { node: to, port: 0 },
  });
  const graph = {
    version: GRAPH_VERSION,
    nodes: [
      node("s", "Start", {}),
      node("d1", "NewObject", { objectName: "v" }),
      node("t1", "TypeVideo", { file: "a.mp4" }),
      node("d2", "NewObject", { objectName: "lamp" }),
      node("t2", "TypeLight", { color: "#ffffff" }),
      node("d3", "NewObject", { objectName: "group" }),
      node("t3", "TypeArray", { members: "v, lamp" }),
      node("o", "Object", { objectName: "v" }),
      node("b", "beh:VideoMedia.blur", { value: 2, time: 0 }, { behaviorOf: "o" }),
      node("c1", "call:Stage.ambient", { value: 1.2 }),
      node("c2", "call:Stage.enable", { args: "v, lamp" }),
    ],
    edges: [
      edge("a1", "d1", "t1"), edge("a2", "d2", "t2"), edge("a3", "d3", "t3"),
      edge("e1", "s", "o"), edge("e2", "o", "c1"), edge("e3", "c1", "c2"),
    ],
    dataEdges: [],
    groups: [],
  };
  const code = inferGraph(graph);
  assert.ok(code.includes('v = Video("a.mp4")'));
  assert.ok(code.includes('lamp = Light("#ffffff")'));
  assert.ok(code.includes("group = Array(v, lamp)"));
  assert.ok(code.includes("v.media.blur(2)"));
  assert.ok(code.includes("stage.ambient(1.2)"));
  assert.ok(code.includes("stage.enable(v, lamp)"));
});

// --- 阶段 3：表达式、变量与函数 ---

test("阶段 3：表达式节点接成数据线后生成正确表达式", () => {
  const n = (id, type, params, extra = {}) => ({ id, type, x: 0, y: 0, params, ...extra });
  const d = (id, from, to, toPort) => ({
    id, from: { node: from, port: 0 }, to: { node: to, port: toPort },
  });
  const graph = {
    version: GRAPH_VERSION,
    nodes: [
      n("s", "Start", {}),
      n("x", "SetVar", { name: "x", value: "0" }),
      n("y", "SetVar", { name: "y", value: "0" }),
      n("z", "SetVar", { name: "z", value: "0" }),
      n("a", "Arith", { op: "+", left: "", right: "" }),
      n("n1", "NumLit", { value: 1 }),
      n("n2", "NumLit", { value: 2 }),
      n("c", "Compare", { op: "==", left: "", right: "" }),
      n("m", "Member", { target: "", name: "hp" }),
      n("str", "StrLit", { value: "hi" }),
      n("l", "ListLit", { items: "1\n2" }),
      n("i", "Index", { target: "", key: "0" }),
      n("k", "NumLit", { value: 1 }),
      n("fc", "FuncCall", { name: "show", args: "x" }),
    ],
    edges: [
      { id: "e1", from: { node: "s", port: 0 }, to: { node: "x", port: 0 } },
      { id: "e2", from: { node: "x", port: 0 }, to: { node: "y", port: 0 } },
      { id: "e3", from: { node: "y", port: 0 }, to: { node: "z", port: 0 } },
      { id: "e4", from: { node: "z", port: 0 }, to: { node: "fc", port: 0 } },
    ],
    dataEdges: [
      d("d1", "a", "x", 0), d("d2", "n1", "a", 0), d("d3", "n2", "a", 1),
      d("d4", "c", "y", 0), d("d5", "m", "c", 0), d("d6", "str", "c", 1),
      d("d7", "i", "z", 0), d("d8", "l", "i", 0), d("d9", "k", "i", 1),
      d("d10", "x", "m", 0),
    ],
    groups: [],
  };
  const code = inferGraph(graph);
  assert.ok(code.includes("x = (1 + 2)"), code);
  assert.ok(code.includes('y = (x.hp == "hi")'), code);
  assert.ok(code.includes("z = [1, 2][1]"), code);
  assert.ok(code.includes("show(x)"), code);
});

test("阶段 3：函数容器框生成定义段 func 块，调用 / return / break / continue 可用", () => {
  const n = (id, type, params, extra = {}) => ({ id, type, x: 0, y: 0, params, ...extra });
  const graph = {
    version: GRAPH_VERSION,
    nodes: [
      n("s", "Start", {}),
      n("fn", "FuncDef", { name: "show", args: "who" }),
      n("say", "Say", { text: "hi", speaker: "" }, { parent: "fn", parentPort: 0, y: 10 }),
      n("ret", "Return", { value: "1" }, { parent: "fn", parentPort: 0, y: 20 }),
      n("call", "FuncCall", { name: "show", args: "hero" }),
      n("w", "While", { cond: "true" }),
      n("br", "Break", {}, { parent: "w", parentPort: 0, y: 10 }),
      n("co", "Continue", {}, { parent: "w", parentPort: 0, y: 20 }),
    ],
    edges: [
      { id: "e1", from: { node: "s", port: 0 }, to: { node: "call", port: 0 } },
      { id: "e2", from: { node: "call", port: 0 }, to: { node: "w", port: 0 } },
    ],
    dataEdges: [],
    groups: [],
  };
  const code = inferGraph(graph);
  assert.ok(code.includes("func show(who) {"), code);
  assert.ok(code.includes('dialog.say("hi")'), code);
  assert.ok(code.includes("return 1"), code);
  assert.ok(code.indexOf("func show(who)") < code.indexOf("show(hero)"), "定义段必须在主流程之前");
  assert.ok(code.includes("while (true) {"), code);
  assert.ok(code.includes("break"), code);
  assert.ok(code.includes("continue"), code);
});

// --- 阶段 4：路由 ---

test("阶段 4：路由按名称从设置跳到取得，本身不产生代码", () => {
  const n = (id, type, params = {}) => ({ id, type, x: 0, y: 0, params });
  const e = (id, from, to) => ({
    id, from: { node: from, port: 0 }, to: { node: to, port: 0 },
  });
  const graph = {
    version: GRAPH_VERSION,
    nodes: [
      n("s", "Start"),
      n("a", "SetVar", { name: "a", value: "1" }),
      n("b", "SetVar", { name: "b", value: "2" }),
      n("set", "RouteSet", { name: "r" }),
      n("get", "RouteGet", { name: "r" }),
      n("c", "SetVar", { name: "c", value: "3" }),
      n("d", "SetVar", { name: "d", value: "4" }),
    ],
    edges: [
      e("1", "s", "a"), e("2", "a", "b"), e("3", "b", "set"),
      e("4", "get", "c"), e("5", "c", "d"),
    ],
    dataEdges: [],
    groups: [],
  };
  const code = inferGraph(graph);
  assert.ok(code.includes("a = 1"), code);
  assert.ok(code.includes("b = 2"), code);
  assert.ok(code.includes("c = 3"), code);
  assert.ok(code.includes("d = 4"), code);
  assert.ok(code.indexOf("b = 2") < code.indexOf("c = 3"), "b 之后必须接 c");
  assert.ok(!code.includes("路由"), "路由不得出现在代码里");
});

test("阶段 4：未配对 / 重名 / 容器内的路由给注释", () => {
  const n = (id, type, params = {}, extra = {}) => ({ id, type, x: 0, y: 0, params, ...extra });
  const e = (id, from, to) => ({
    id, from: { node: from, port: 0 }, to: { node: to, port: 0 },
  });
  const unpaired = inferGraph({
    version: GRAPH_VERSION,
    nodes: [n("s", "Start"), n("set", "RouteSet", { name: "r" })],
    edges: [e("1", "s", "set")],
    dataEdges: [], groups: [],
  });
  assert.ok(unpaired.includes("# 路由未配对: r"), unpaired);

  const duplicate = inferGraph({
    version: GRAPH_VERSION,
    nodes: [
      n("s", "Start"), n("set", "RouteSet", { name: "r" }),
      n("g1", "RouteGet", { name: "r" }), n("g2", "RouteGet", { name: "r" }),
    ],
    edges: [e("1", "s", "set")],
    dataEdges: [], groups: [],
  });
  assert.ok(duplicate.includes("# 路由重名: r"), duplicate);

  const inside = inferGraph({
    version: GRAPH_VERSION,
    nodes: [
      n("s", "Start"), n("i", "If", { cond: "true" }),
      n("set", "RouteSet", { name: "r" }, { parent: "i", parentPort: 0, y: 10 }),
    ],
    edges: [e("1", "s", "i")],
    dataEdges: [], groups: [],
  });
  assert.ok(inside.includes("# 路由不能放进容器: r"), inside);
});

// --- 阶段 5：组 ---

test("阶段 5：组边界包围成员，框选只取完整包含的节点", () => {
  const a = { id: "a", x: 0, y: 0, w: 100, h: 60 };
  const b = { id: "b", x: 200, y: 100, w: 100, h: 60 };
  const box = groupBounds([a, b]);
  assert.ok(box.x <= -50, "左边界要包住 a 的左缘");
  assert.ok(box.y <= -30, "上边界要包住 a 的上缘");
  assert.ok(box.x + box.w >= 250, "右边界要包住 b 的右缘");
  assert.ok(box.y + box.h >= 130, "下边界要包住 b 的下缘");

  const nodes = [{ ...a }, { id: "c", x: 500, y: 0, w: 100, h: 60 }];
  assert.deepEqual(
    nodesWithinRect(nodes, { x: -60, y: -60, w: 200, h: 200 }).map((n) => n.id),
    ["a"],
    "只框住一半的节点不算选中",
  );
  assert.deepEqual(
    nodesWithinRect(nodes, { x: -60, y: -60, w: 700, h: 300 }).map((n) => n.id),
    ["a", "c"],
  );
});

test("阶段 5：组规范化只保留有效成员，一个节点只属于一个组", () => {
  const graph = {
    version: GRAPH_VERSION,
    nodes: [{ id: "n1" }, { id: "n2" }],
    groups: [
      { id: "g1", name: "A", members: ["n1", "n1", "gone"] },
      { id: "g2", members: ["n1", "n2"] },
      { id: "g3", members: ["gone"] },
    ],
  };
  normalizeGroups(graph);
  assert.deepEqual(graph.groups.map((g) => g.id), ["g1", "g2"]);
  assert.deepEqual(graph.groups[0].members, ["n1"]);
  assert.deepEqual(graph.groups[1].members, ["n2"]);
  assert.equal(graph.groups[0].name, "A");
  assert.ok(graph.groups[1].name.startsWith("组"));
  assert.ok(graph.groups[0].color);
});

// --- 阶段 6：反向解析共用 API 表 + 中文别名 + 往返 ---

const byType = (g, type) => g.nodes.filter((n) => n.type === type);
// 真正的报错注释形如 `# 行为没有连到对象`，而颜色 `"#fff"` 里的 `#` 不是注释。
const hasErrorComment = (s) => String(s).split("\n").some((l) => l.trimStart().startsWith("# "));

test("阶段 6：两级点调用被反解为对应行为节点并往返", () => {
  const code = [
    'v = Video("a.mp4")',
    "v.media.blur(2)",
    "v.audio.mute()",
    'ch = Character("c.png")',
    "ch.transform.upleft(1, 2, 3)",
  ].join("\n");
  const g = graphFromPamela(code);
  const blur = byType(g, "beh:VideoMedia.blur")[0];
  assert.ok(blur, "v.media.blur 应折回 beh:VideoMedia.blur");
  assert.equal(blur.params.value, "2");
  assert.ok(byType(g, "beh:VideoAudio.mute")[0], "v.audio.mute 应折回 beh:VideoAudio.mute");
  assert.ok(byType(g, "beh:Transform.upleft")[0], "ch.transform.upleft 应折回 beh:Transform.upleft");
  const back = inferGraph(g);
  // 同一对象上的行为在生成时会被串成一条链：v.media.blur(2).audio.mute(true)。
  assert.ok(back.includes("v.media.blur(2)"), back);
  assert.ok(back.includes("audio.mute(true)"), back);
  assert.ok(back.includes("ch.transform.upleft(1, 2, 3)"), back);
  assert.ok(!hasErrorComment(back), "不应有报错注释");
});

test("阶段 6：舞台全局 / 批量 / 变长调用反解并往返", () => {
  const code = [
    "stage.ambient(1.2)",
    "stage.enable(hero, bg)",
    "stage.exclude(lamp : hero)",
    "stage.click(1000)",
  ].join("\n");
  const g = graphFromPamela(code);
  assert.ok(byType(g, "call:Stage.ambient")[0], "ambient");
  assert.ok(byType(g, "call:Stage.enable")[0], "enable(批量)");
  assert.ok(byType(g, "call:Stage.exclude")[0], "exclude(变长)");
  assert.ok(byType(g, "call:Stage.click")[0], "click");
  const back = inferGraph(g);
  assert.ok(back.includes("stage.ambient(1.2)"), back);
  assert.ok(back.includes("stage.enable(hero, bg)"), back);
  assert.ok(back.includes("stage.exclude(lamp : hero)"), back);
  assert.ok(back.includes("stage.click(1000)"), back);
  assert.ok(!hasErrorComment(back), "不应有报错注释");
});

test("阶段 6：逐帧图片组的调用折回行为节点，并原样写回", () => {
  const code = [
    "cg = Character()",
    'cg.group("ch1.png", "ch2.png")',
    "cg.fps(16, true)",
    "cg.pause(1)",
    'cg.add(0, "ch3.png")',
  ].join("\n");
  const g = graphFromPamela(code);

  const group = byType(g, "beh:group")[0];
  assert.ok(group, "cg.group(…) 应折回 beh:group");
  assert.equal(group.params.files, "ch1.png, ch2.png");
  const fps = byType(g, "beh:fps")[0];
  assert.ok(fps, "cg.fps(…) 应折回 beh:fps");
  assert.equal(fps.params.value, "16");
  assert.equal(fps.params.loop, "true");
  assert.ok(byType(g, "beh:pause")[0], "cg.pause(1) 应折回 beh:pause");
  assert.ok(byType(g, "beh:add")[0], "cg.add(…) 应折回 beh:add");

  const back = inferGraph(g);
  assert.ok(back.includes('group("ch1.png", "ch2.png")'), back);
  assert.ok(back.includes("fps(16, true)"), back);
  assert.ok(back.includes("pause(1)"), back);
  assert.ok(back.includes('add(0, "ch3.png")'), back);
  assert.ok(!hasErrorComment(back), "不应有报错注释");
});

test("阶段 6：光源与对象组构造器反解并往返", () => {
  const code = ['lamp = Light("#ffffff")', 'group = Array(hero, bg)'].join("\n");
  const g = graphFromPamela(code);
  assert.equal(byType(g, "TypeLight")[0].params.color, "#ffffff");
  assert.equal(byType(g, "TypeArray")[0].params.members, "hero, bg");
  const back = inferGraph(g);
  assert.ok(back.includes('lamp = Light("#ffffff")'), back);
  assert.ok(back.includes("group = Array(hero, bg)"), back);
});

test("阶段 6：中文别名反解成英文节点", () => {
  const code = [
    'ch = 角色("c.png")',
    "ch.移动(10, 20)",
    "ch.显示()",
    'ch.姓名("帕梅拉")',
  ].join("\n");
  const g = graphFromPamela(code);
  assert.equal(byType(g, "TypeCharacter")[0].params.image, "c.png");
  assert.equal(byType(g, "beh:move")[0].params.dx, "10");
  assert.ok(byType(g, "beh:show")[0], "显示 → show");
  assert.equal(byType(g, "beh:name")[0].params.value, "帕梅拉");
  const back = inferGraph(g);
  // 同一对象上的行为被串成一条链：move → show → name。
  assert.ok(back.includes('Character("c.png")'), back);
  assert.ok(back.includes("move(10, 20)"), back);
  assert.ok(back.includes("show()"), back);
  assert.ok(back.includes('name("帕梅拉")'), back);
});

test("阶段 6：函数定义、返回值与跳出反解并往返", () => {
  const code = [
    "func show(who) {",
    '  dialog.say("hi", who)',
    "  return 1",
    "}",
    "show(hero)",
    "while (true) {",
    "  break",
    "  continue",
    "}",
  ].join("\n");
  const g = graphFromPamela(code);
  const fn = byType(g, "FuncDef")[0];
  assert.ok(fn, "func 应折回 FuncDef");
  assert.equal(fn.params.name, "show");
  assert.equal(fn.params.args, "who");
  assert.ok(byType(g, "Return")[0], "return");
  assert.ok(byType(g, "Break")[0], "break");
  assert.ok(byType(g, "Continue")[0], "continue");
  assert.ok(byType(g, "FuncCall")[0], "show(hero) 应折回 FuncCall");
  const back = inferGraph(g);
  assert.ok(back.includes("func show(who) {"), back);
  assert.ok(back.includes("return 1"), back);
  assert.ok(back.includes("break"), back);
  assert.ok(back.includes("continue"), back);
  assert.ok(back.includes("show(hero)"), back);
  assert.ok(!hasErrorComment(back), "不应有报错注释");
});

test("阶段 6：每个行为节点都能被反向解析识别（反解与画布同表）", () => {
  const keys = behaviorNodeKeys();
  for (const key of keys) {
    if (key.includes(".")) continue; // 两级点由命名空间测试覆盖
    if (key === "key") continue; // 关键帧由专门测试覆盖
    const g = graphFromPamela(`ch = Character("c.png")\nch.${key}(0)`);
    assert.ok(byType(g, `beh:${key}`)[0], `反解应能识别 ${key}`);
  }
});

test("阶段 6：每个 call: 节点都来自 API 表", () => {
  for (const type of Object.keys(NODE_TYPES)) {
    if (!type.startsWith("call:")) continue;
    const key = type.slice("call:".length);
    assert.ok(callNodeKeys().includes(key), `call:${key} 必须在 API 表中`);
  }
});

test("阶段 6：inferGraph → graphFromPamela → inferGraph 不丢行、不报错", () => {
  const n = (id, type, params, extra = {}) => ({ id, type, x: 0, y: 0, params, ...extra });
  const e = (id, from, to) => ({
    id, from: { node: from, port: 0 }, to: { node: to, port: 0 },
  });
  const graph = {
    version: GRAPH_VERSION,
    nodes: [
      n("s", "Start", {}),
      n("d1", "NewObject", { objectName: "v" }),
      n("t1", "TypeVideo", { file: "a.mp4" }),
      n("d2", "NewObject", { objectName: "lamp" }),
      n("t2", "TypeLight", { color: "#fff" }),
      n("o", "Object", { objectName: "v" }),
      n("b", "beh:VideoMedia.blur", { value: 2 }, { behaviorOf: "o" }),
      n("c1", "call:Stage.ambient", { value: 1.2 }),
      n("c2", "call:Stage.enable", { args: "v, lamp" }),
      n("fn", "FuncDef", { name: "show", args: "who" }),
      n("say", "Say", { text: "hi", speaker: "" }, { parent: "fn", parentPort: 0, y: 10 }),
      n("ret", "Return", { value: "1" }, { parent: "fn", parentPort: 0, y: 20 }),
      n("fc", "FuncCall", { name: "show", args: "v" }),
    ],
    edges: [
      e("a1", "d1", "t1"), e("a2", "d2", "t2"), e("e1", "s", "o"),
      e("e2", "o", "c1"), e("e3", "c1", "c2"), e("e4", "c2", "fc"),
    ],
    dataEdges: [],
    groups: [],
  };
  const code1 = inferGraph(graph);
  const back = graphFromPamela(code1);
  const code2 = inferGraph(back);
  const norm = (s) => s.split("\n").filter(Boolean).sort().join("\n");
  assert.equal(norm(code2), norm(code1), "往返应一致");
  assert.ok(!hasErrorComment(code2), "往返不应产生报错注释");
});

