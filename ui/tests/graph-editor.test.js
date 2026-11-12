// 可视化编程图测试：序列化与到 Pamela 的推断。
// Tests for the visual programming graph: serialization and inference to Pamela.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse, tokenize } from "../pamela.js";
import { graphFromPamela } from "../map-parse.js";

import {
  BEHAVIOR_GAP,
  DOCK_H,
  GRAPH_VERSION,
  HEADER_H,
  NODE_TYPES as NODE_TYPES_FOR_TEST,
  PORTS_TOP,
  PORT_ROW_H,
} from "../graph-editor.js";

import {
  behaviorChain,
  behaviorMethodOf,
  behaviorOwner,
  behaviorParent,
  behaviorTypeName,
  childrenOf,
  containerLanes,
  containerRect,
  emptyGraph,
  inferGraph,
  isBehaviorNode,
  isCallNode,
  isContainer,
  isDeclareNode,
  isObjectNode,
  isTypeNode,
  isParallelNode,
  laneAt as laneAtForTest,
  laneRects as laneRectsForTest,
  linkEnds,
  methodsFor,
  nextId,
  nodeRect,
  objectNameOf,
  objectTypeOf,
  outputCanFanOut,
  parseGraph,
  portsOf,
  portPoint,
  serializeGraph,
  wirePath,
} from "../graph-editor.js";

function chain(types) {
  const graph = emptyGraph();
  let prev = graph.nodes[0]; // Start
  types.forEach((type, i) => {
    const node = { id: `n${i + 2}`, type, x: i * 60, y: 0, params: {} };
    graph.nodes.push(node);
    graph.edges.push({
      id: `e${i + 1}`,
      from: { node: prev.id, port: 0 },
      to: { node: node.id, port: 0 },
    });
    prev = node;
  });
  return graph;
}

/**
 * One object, the way the canvas builds it now: a 新对象, the type it is built
 * with, and — in the flow — the 对象 node that uses it with its calls stacked
 * under it.
 *
 * `behaviors` are given top to bottom, which is the order they run in: a stack
 * is a list, and its order is its layout.
 */
function scene({
  name = "ch",
  type = "TypeCharacter",
  typeParams = { image: "h.png" },
  behaviors = [],
  at = 0,
} = {}) {
  const graph = emptyGraph();
  const declare = { id: `d${at + 1}`, type: "NewObject", x: 0, y: -400, params: { objectName: name } };
  const ctor = { id: `t${at + 1}`, type, x: 0, y: -280, params: typeParams };
  const call = { id: `c${at + 1}`, type: "Object", x: 0, y: 0, params: { objectName: name } };
  graph.nodes.push(declare, ctor, call);
  graph.edges.push(
    { id: `a${at + 1}`, from: { node: declare.id, port: 0 }, to: { node: ctor.id, port: 0 } },
    { id: `x${at + 1}`, from: { node: "n1", port: 0 }, to: { node: call.id, port: 0 } },
  );
  behaviors.forEach((behavior, i) => {
    graph.nodes.push({
      id: `b${at + 1}_${i + 1}`,
      type: behaviorTypeName(behavior.method),
      x: 0,
      y: 60 + i * 100,
      behaviorOf: call.id,
      params: behavior.params ?? {},
    });
  });
  return { graph, declare, ctor, call };
}

/**
 * A block with a body.
 *
 * `body` maps a lane index to the statements inside it, in reading order. The
 * nodes get a parent and a position — that is the whole of "inside the box".
 */
function block(type, params, body = {}) {
  const graph = emptyGraph();
  const parent = { id: "n2", type, x: 0, y: 0, w: 300, h: 200, params };
  graph.nodes.push(parent);
  graph.edges.push({ id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } });
  let n = 3;
  for (const [port, stmts] of Object.entries(body)) {
    stmts.forEach((stmt, row) => {
      const node = {
        id: `n${n}`,
        type: stmt.type,
        x: 20 + Number(port) * 260,
        y: 100 + row * 130,
        parent: "n2",
        parentPort: Number(port),
        params: stmt.params ?? {},
      };
      n += 1;
      graph.nodes.push(node);
    });
  }
  return graph;
}

test("emptyGraph starts with a single Start node", () => {
  const graph = emptyGraph();
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].type, "Start");
  assert.deepEqual(graph.edges, []);
});

test("serialize and parse round-trip", () => {
  // A round trip must give back the same *document*. Reading also repairs what
  // an older file would have left out, so the graph is built in the current
  // shape first and the repair is a no-op — that is what "round-trips" means now.
  const { graph } = scene({ behaviors: [{ method: "enable" }] });
  const say = { id: "s1", type: "Say", x: 300, y: 0, params: { text: "嗨" } };
  graph.nodes.push(say);
  graph.edges.push({ id: "x2", from: { node: "c1", port: 0 }, to: { node: "s1", port: 0 } });
  const text = serializeGraph(graph);
  const back = parseGraph(text);
  assert.deepEqual(back.nodes, graph.nodes);
  assert.deepEqual(back.edges, graph.edges);
});

test("reading a file repairs what an older one left out", () => {
  // A file from before the split: one box does both jobs, its variable was
  // called `name`, and its behaviour hung off a 行为 wire.
  const old = {
    version: 2,
    nodes: [
      { id: "n1", type: "Start", x: 0, y: 0, params: {} },
      { id: "n2", type: "Character", x: 0, y: 0, params: { name: "hero", image: "h.png" } },
      { id: "n3", type: "beh:enable", x: 0, y: 0, params: {} },
    ],
    edges: [
      { id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } },
      { id: "e2", from: { node: "n2", port: 1 }, to: { node: "n3", port: 0 } },
    ],
    dataEdges: [],
  };
  const back = parseGraph(JSON.stringify(old));
  assert.equal(back.version, GRAPH_VERSION);
  // The single box became a declaration, a constructor and a call.
  const declare = back.nodes.find((n) => n.type === "NewObject");
  const ctor = back.nodes.find((n) => n.type === "TypeCharacter");
  const call = back.nodes.find((n) => n.type === "Object");
  assert.ok(declare && ctor && call, "the old box is split in two");
  assert.equal(declare.params.objectName, "hero", "the variable survives the rename");
  assert.equal("name" in declare.params, false, "the stale key is gone");
  assert.equal(ctor.params.image, "h.png", "the picture moves to the constructor");
  // The behaviour is attached to the call node, and its old wire is gone.
  assert.equal(back.nodes.find((n) => n.id === "n3").behaviorOf, call.id);
  assert.equal(back.edges.some((e) => e.id === "e2"), false, "行为 wires are dropped");
  // And the scene still compiles to the same thing, definition first.
  assert.equal(inferGraph(back).trim(), 'hero = Character("h.png")\nhero.enable()');
});

test("parseGraph falls back to an empty graph on bad input", () => {
  const graph = parseGraph("not json at all {{{");
  assert.equal(graph.nodes[0].type, "Start");
});

test("inferGraph emits a linear chain in edge order", () => {
  const { graph } = scene({ name: "bg", type: "TypeBackground", typeParams: { image: "bg.png" } });
  const say = { id: "s1", type: "Say", x: 300, y: 0, params: { text: "你好" } };
  graph.nodes.push(say);
  graph.edges.push({ id: "x2", from: { node: "c1", port: 0 }, to: { node: "s1", port: 0 } });
  const code = inferGraph(graph);
  const lines = code.split("\n").filter(Boolean);
  assert.equal(lines[0], 'bg = Background("bg.png")');
  assert.equal(lines[1], 'dialog.say("你好")');
});

test("inferGraph nests a choice block per option, with the body inside the box", () => {
  const graph = block("Choice", { options: "去左边\n去右边" }, {
    0: [{ type: "Say", params: { text: "左" } }],
    1: [{ type: "Say", params: { text: "右" } }],
  });
  const code = inferGraph(graph);
  assert.match(code, /choice \{/);
  assert.match(code, /"去左边" \{/);
  assert.match(code, /"去右边" \{/);
  // The statements are indented inside their lane: they are the body.
  assert.match(code, /\n {4}dialog\.say\("左"\)\n/);
  assert.match(code, /\n {4}dialog\.say\("右"\)\n/);
});

test("a block's body runs in reading order, not wire order", () => {
  const graph = block("If", { cond: "hp > 0" }, {
    0: [
      { type: "Say", params: { text: "一" } },
      { type: "Say", params: { text: "二" } },
      { type: "Say", params: { text: "三" } },
    ],
  });
  const code = inferGraph(graph);
  const order = ["一", "二", "三"].map((t) => code.indexOf(`"${t}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "body statements keep their reading order");
});

test("a block's body is ordered top to bottom, then left to right", () => {
  const graph = block("Cue", {}, {
    0: [
      { type: "Say", params: { text: "先" } },
      { type: "Say", params: { text: "后" } },
    ],
  });
  // Put the second statement *above* the first: position is the order, so it
  // must come out first.
  const body = graph.nodes.filter((n) => n.parent === "n2");
  body[0].y = 300;
  body[1].y = 100;
  const code = inferGraph(graph);
  assert.match(code, /cue \{/);
  assert.ok(code.indexOf('"后"') < code.indexOf('"先"'), "top-to-bottom order wins");
});

test("inferGraph emits if/else branches", () => {
  const graph = block("If", { cond: "hp > 0" }, {
    0: [{ type: "Say", params: { text: "活" } }],
    1: [{ type: "Say", params: { text: "死" } }],
  });
  const code = inferGraph(graph);
  assert.match(code, /if \(hp > 0\) \{/);
  assert.match(code, /else \{/);
  assert.match(code, /"活"/);
  assert.match(code, /"死"/);
});

test("a statement after a block comes from its 完成 output", () => {
  const graph = block("While", { cond: "true" }, {
    0: [{ type: "Say", params: { text: "循环" } }],
  });
  graph.nodes.push({ id: "n9", type: "Say", x: 0, y: 500, params: { text: "之后" } });
  graph.edges.push({ id: "e9", from: { node: "n2", port: 0 }, to: { node: "n9", port: 0 } });
  const code = inferGraph(graph);
  const lines = code.split("\n");
  const whileAt = lines.findIndex((l) => l.startsWith("while"));
  const closeAt = lines.findIndex((l, i) => i > whileAt && l === "}");
  const afterAt = lines.findIndex((l) => l.includes('"之后"'));
  assert.ok(whileAt >= 0 && closeAt > whileAt, "the while block is closed");
  assert.ok(afterAt > closeAt, "the following statement is outside the block");
});

test("inferGraph terminates on a cycle without double-emitting", () => {
  const graph = emptyGraph();
  const say = { id: "n2", type: "Say", x: 0, y: 0, params: { text: "循环" } };
  graph.nodes.push(say);
  graph.edges.push(
    { id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } },
    // Back-edge that would loop forever if not guarded.
    { id: "e2", from: { node: "n2", port: 0 }, to: { node: "n1", port: 0 } },
  );
  const code = inferGraph(graph);
  const sayCount = code.split('dialog.say("循环")').length - 1;
  assert.equal(sayCount, 1);
});

// --- wires ---

test("portPoint puts an output on the right edge and an input on the left", () => {
  const node = { id: "n1", type: "Say", x: 100, y: 50, params: {} };
  const out = portPoint(node, "out", 0);
  const in0 = portPoint(node, "in", 0);
  assert.equal(out.x, 100 + 210);
  assert.equal(in0.x, 100);
  assert.equal(out.y, in0.y);

  // Ports stack one row apart below the header.
  const in1 = portPoint(node, "in", 1);
  assert.equal(in1.y - in0.y, PORT_ROW_H);
});

test("wirePath leaves an output to the right and enters an input from the left", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 200, y: 40 };
  const path = wirePath(a, b);
  // A cubic from `a` to `b` whose control points sit past each endpoint.
  assert.match(path, /^M 0 0 C /);
  const [, c1x, , c2x] = path.match(/C ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+),/) ?? [];
  assert.ok(Number(c1x) > a.x, "first control point must pull right");
  assert.ok(Number(c2x) < b.x, "second control point must pull left");
  assert.match(path, / 200 40$/);
});

test("wirePath keeps a wide loop when the wire doubles back", () => {
  // An input to the left of an output would otherwise draw a straight line
  // through both nodes; the control points have to bow outward instead.
  const path = wirePath({ x: 400, y: 0 }, { x: 0, y: 0 });
  const [, c1x, , c2x] = path.match(/C ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+),/) ?? [];
  assert.ok(Number(c1x) > 400, "the wire must leave to the right");
  assert.ok(Number(c2x) < 0, "and re-enters from the left");
});

test("linkEnds orders an edge output-to-input whichever end was grabbed", () => {
  const out = { node: "a", port: 0, dir: "out" };
  const input = { node: "b", port: 1, dir: "in" };
  assert.deepEqual(linkEnds(out, input), {
    from: { node: "a", port: 0 },
    to: { node: "b", port: 1 },
    kind: "exec",
  });
  // Dragging backwards out of the input must produce the same edge.
  assert.deepEqual(linkEnds(input, out), {
    from: { node: "a", port: 0 },
    to: { node: "b", port: 1 },
    kind: "exec",
  });
});

test("linkEnds refuses two outputs, two inputs, and a node onto itself", () => {
  const out = { node: "a", port: 0, dir: "out" };
  assert.equal(linkEnds(out, { node: "b", port: 0, dir: "out" }), null);
  assert.equal(
    linkEnds({ node: "a", port: 0, dir: "in" }, { node: "b", port: 0, dir: "in" }),
    null,
  );
  assert.equal(linkEnds(out, { node: "a", port: 0, dir: "in" }), null);
  assert.equal(linkEnds(out, null), null);
});

test("the wire layer is sized and is not the world's child", () => {
  // Prior defect: a `width: 0; height: 0` SVG paints nothing in Chromium,
  // so every wire was in the DOM with a correct `d` and simply never appeared.
  // An SVG also clips to its own box, so it cannot live inside the world.
  const css = readFileSync(new URL("../styles/graph.css", import.meta.url), "utf8");
  const start = css.indexOf(".graph__edges {");
  assert.notEqual(start, -1, "expected the wire layer rule");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /width:\s*100%/, "the wire layer must have a real width");
  assert.match(rule, /height:\s*100%/, "the wire layer must have a real height");
  assert.match(rule, /overflow:\s*visible/, "a wire may reach outside the layer");
  assert.equal(
    /width:\s*0/.test(rule) || /height:\s*0/.test(rule),
    false,
    "a zero-sized SVG paints nothing at all",
  );
});

test("a wire is clicked through a wider invisible path", () => {
  // The visible line is 3px: far too fine a target to select or delete, and the
  // hit path must not paint or it would double the line's brightness.
  const css = readFileSync(new URL("../styles/graph.css", import.meta.url), "utf8");
  const start = css.indexOf(".graph__edge-hit {");
  assert.notEqual(start, -1, "expected a hit-area rule");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /stroke:\s*transparent/);
  assert.match(rule, /pointer-events:\s*stroke/);
  const width = Number(rule.match(/stroke-width:\s*([\d.]+)px/)?.[1]);
  assert.ok(width >= 10, `the hit area must be generous, got ${width}px`);
});

test("nextId numbers against the list it is given", () => {
  // It used to scan only the nodes, so every edge came out as "e1": two wires
  // shared an id, and selecting one selected all of them.
  const edges = [
    { id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } },
    { id: "e2", from: { node: "n1", port: 1 }, to: { node: "n3", port: 0 } },
  ];
  assert.equal(nextId(edges, "e"), "e3");
  assert.equal(nextId([], "e"), "e1");
  assert.equal(nextId([{ id: "n4" }, { id: "e9" }], "n"), "n5");
  // An id that is not `prefix + digits` must not be read as a counter.
  assert.equal(nextId([{ id: "n2b" }, { id: "nn7" }], "n"), "n1");
});

// --- new node types & data wires ---

test("emptyGraph carries a dataEdges array", () => {
  const graph = emptyGraph();
  assert.deepEqual(graph.dataEdges, []);
});

test("inferGraph emits the new statement nodes", () => {
  const graph = emptyGraph();
  const use = { id: "n2", type: "Use", x: 0, y: 0, params: { file: "templates/x.dialog.json" } };
  const en = { id: "n3", type: "DialogEnable", x: 0, y: 0, params: {} };
  const dis = { id: "n4", type: "DialogDisable", x: 0, y: 0, params: {} };
  const filt = { id: "n5", type: "Filter", x: 0, y: 0, params: { target: "hero", mode: "rgbTo", r: 1, g: 2, b: 3, hex: "#fff" } };
  const wh = { id: "n6", type: "While", x: 0, y: 0, params: { cond: "hp > 0" } };
  graph.nodes.push(use, en, dis, filt, wh);
  graph.edges.push(
    { id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } },
    { id: "e2", from: { node: "n2", port: 0 }, to: { node: "n3", port: 0 } },
    { id: "e3", from: { node: "n3", port: 0 }, to: { node: "n4", port: 0 } },
    { id: "e4", from: { node: "n4", port: 0 }, to: { node: "n5", port: 0 } },
    { id: "e5", from: { node: "n5", port: 0 }, to: { node: "n6", port: 0 } },
  );
  const code = inferGraph(graph);
  const lines = code.split("\n").filter(Boolean);
  assert.equal(lines[0], 'use "templates/x.dialog.json"');
  assert.equal(lines[1], "dialog.enable()");
  assert.equal(lines[2], "dialog.disable()");
  assert.equal(lines[3], "hero.rgbTo(1, 2, 3)");
  assert.match(lines[4], /^while \(hp > 0\) \{$/);
});

test("inferGraph uses a data wire for the Say speaker", () => {
  const { graph } = scene({ name: "hero" });
  const say = { id: "s1", type: "Say", x: 300, y: 0, params: { speaker: "", text: "hi" } };
  graph.nodes.push(say);
  graph.edges.push({ id: "x2", from: { node: "c1", port: 0 }, to: { node: "s1", port: 0 } });
  graph.dataEdges.push({ id: "d1", from: { node: "c1", port: 0 }, to: { node: "s1", port: 0 } });
  const code = inferGraph(graph);
  assert.equal(code.trim(), 'hero = Character("h.png")\ndialog.say("hi", hero)');
});

test("linkEnds keeps exec and data wires apart by kind", () => {
  const out = { node: "a", port: 0, dir: "out", kind: "data" };
  const input = { node: "b", port: 0, dir: "in", kind: "data" };
  assert.deepEqual(linkEnds(out, input), {
    from: { node: "a", port: 0 },
    to: { node: "b", port: 0 },
    kind: "data",
  });
  // An exec output cannot connect to a data input.
  assert.equal(linkEnds({ node: "a", port: 0, dir: "out", kind: "exec" }, input), null);
});

// --- blocks (containers) ---

test("the branch types are blocks, and a block has one way out", () => {
  for (const type of ["If", "While", "Choice", "Cue"]) {
    assert.equal(isContainer(type), true, `${type} is a block`);
  }
  assert.equal(isContainer("Say"), false);
  const iff = { id: "n2", type: "If", x: 0, y: 0, params: { cond: "true" } };
  // One 完成 socket, not one per branch: the branches are lanes inside the box.
  assert.equal(portPoint(iff, "out", 0).x, portPoint(iff, "out", 0).x);
  const graph = block("If", { cond: "true" }, { 0: [{ type: "Say", params: {} }] });
  const blockNode = graph.nodes.find((n) => n.type === "If");
  // There is no second output to wire a branch to.
  assert.equal(portPoint(blockNode, "out", 1).y, portPoint(blockNode, "out", 0).y);
});

test("a block's lanes are its options", () => {
  const choice = { type: "Choice", params: { options: "甲\n乙\n丙" } };
  assert.deepEqual(
    containerLanes(choice).map((l) => l.label),
    ["甲", "乙", "丙"],
  );
  const iff = { type: "If", params: {} };
  assert.deepEqual(containerLanes(iff).map((l) => l.label), ["成立", "否则"]);
  // A choice with no options still has a lane to drop a node into.
  assert.equal(containerLanes({ type: "Choice", params: { options: "" } }).length, 1);
});

test("a block grows to hold the nodes inside it", () => {
  const graph = block("If", { cond: "true" }, {
    0: [{ type: "Say", params: { text: "a" } }],
  });
  const blockNode = graph.nodes.find((n) => n.type === "If");
  const before = containerRect(blockNode, graph.nodes);
  const child = graph.nodes.find((n) => n.parent === "n2");
  child.y += 400;
  const after = containerRect(blockNode, graph.nodes);
  assert.ok(after.h > before.h, "the box must grow downwards to contain the body");
  assert.ok(after.h >= child.y - blockNode.y, "the body stays inside the box");
});

test("a node inside a block has no exec socket: its place is its order", () => {
  const child = { id: "n3", type: "Say", x: 0, y: 0, parent: "n2", parentPort: 0, params: {} };
  const ports = portsOf(child);
  assert.deepEqual(
    ports.filter((p) => p.kind === "exec"),
    [],
    "a body's statements are placed, not wired",
  );
});

test("childrenOf reads a body top to bottom, then left to right", () => {
  // A body is a list of statements: it reads the way a script is written, one
  // line under the next. Two statements on the same line read left to right.
  const nodes = [
    { id: "a", x: 200, y: 100, parent: "p", parentPort: 0 },
    { id: "b", x: 100, y: 100, parent: "p", parentPort: 0 },
    { id: "c", x: 100, y: 300, parent: "p", parentPort: 0 },
    { id: "d", x: 100, y: 100, parent: "p", parentPort: 1 },
    { id: "e", x: 100, y: 100, parent: "q", parentPort: 0 },
  ];
  assert.deepEqual(childrenOf(nodes, "p", 0).map((n) => n.id), ["b", "a", "c"]);
  assert.deepEqual(childrenOf(nodes, "p", 1).map((n) => n.id), ["d"]);
});

test("a v1 file's branch wires are read as block bodies", () => {
  // The old shape: the block had one output per branch, wired to the statement
  // that *was* the branch. Opening it must not lose the scene.
  const v1 = {
    version: 1,
    nodes: [
      { id: "n1", type: "Start", x: 0, y: 0, params: {} },
      { id: "n2", type: "If", x: 0, y: 100, params: { cond: "hp > 0" } },
      { id: "n3", type: "Say", x: 0, y: 200, params: { text: "活" } },
      { id: "n4", type: "Say", x: 300, y: 200, params: { text: "死" } },
    ],
    edges: [
      { id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } },
      { id: "e2", from: { node: "n2", port: 0 }, to: { node: "n3", port: 0 } },
      { id: "e3", from: { node: "n2", port: 1 }, to: { node: "n4", port: 0 } },
    ],
  };
  const graph = parseGraph(JSON.stringify(v1));
  assert.equal(graph.version, GRAPH_VERSION, "every repair has been applied");
  const then = graph.nodes.find((n) => n.id === "n3");
  const otherwise = graph.nodes.find((n) => n.id === "n4");
  assert.equal(then.parent, "n2");
  assert.equal(then.parentPort, 0);
  assert.equal(otherwise.parent, "n2");
  assert.equal(otherwise.parentPort, 1);
  // The wires that placed them are gone: a body is ordered by position.
  assert.deepEqual(graph.edges.map((e) => e.id), ["e1"]);
  const code = inferGraph(graph);
  assert.match(code, /if \(hp > 0\) \{/);
  assert.match(code, /"活"/);
  assert.match(code, /"死"/);
});

// --- camera ---

test("the camera is saved with the map and restored when it is opened", () => {
  const graph = emptyGraph();
  graph.view = { ox: -120, oy: 64, scale: 1.35 };
  const back = parseGraph(serializeGraph(graph));
  assert.deepEqual(back.view, { ox: -120, oy: 64, scale: 1.35 });
});

test("a map with no camera parses as having none, so the canvas frames it", () => {
  const back = parseGraph(JSON.stringify({ version: 2, nodes: [], edges: [] }));
  assert.equal(back.view, null);
});

test("a camera is clamped to the zoom the canvas allows", () => {
  const wild = parseGraph(
    JSON.stringify({ version: 2, nodes: [], edges: [], view: { ox: 0, oy: 0, scale: 900 } }),
  );
  assert.equal(wild.view.scale, 2.5);
  const tiny = parseGraph(
    JSON.stringify({ version: 2, nodes: [], edges: [], view: { ox: 0, oy: 0, scale: 0.0001 } }),
  );
  assert.equal(tiny.view.scale, 0.25);
  // Invalid data in the field is treated as "no camera", not as a camera at NaN.
  const bad = parseGraph(
    JSON.stringify({ version: 2, nodes: [], edges: [], view: { ox: "x", oy: null, scale: 1 } }),
  );
  assert.equal(bad.view, null);
});

test("a new map opens at 1:1 rather than at the minimum zoom", () => {
  // Regression case: a canvas fitted before it had been laid out landed on
  // the 0.25 floor, so every new map opened far too small.
  assert.equal(emptyGraph().view.scale, 1);
});

// --- objects, behaviours and the serial/parallel rule ---

test("a definition names the variable and builds it", () => {
  const { graph } = scene({ name: "hero" });
  assert.equal(inferGraph(graph).trim(), 'hero = Character("h.png")');
});

test("the type node decides the constructor, the definition the variable", () => {
  const { graph } = scene({ name: "school", type: "TypeBackground", typeParams: { image: "bg.png" } });
  assert.equal(inferGraph(graph).trim(), 'school = Background("bg.png")');
});

test("a text definition writes its content as the constructor's argument", () => {
  const { graph } = scene({ name: "title", type: "TypeText", typeParams: { text: "旧书店" } });
  assert.equal(inferGraph(graph).trim(), 'title = Text("旧书店")');
});

test("a font behaviour writes the family as a literal, even when it looks like a name", () => {
  const { graph } = scene({
    name: "title",
    type: "TypeText",
    typeParams: { text: "字" },
    behaviors: [{ method: "font", params: { family: "Arial" } }],
  });
  assert.ok(inferGraph(graph).includes('title.font("Arial")'), "Arial 要加引号，否则会被当成变量");
});

test("a Text answers to the frame methods but not the bitmap-only ones", () => {
  const { graph, call } = scene({
    name: "title",
    type: "TypeText",
    typeParams: { text: "字" },
  });
  const methods = methodsFor(call, graph);
  assert.ok(methods.includes("move"));
  assert.ok(methods.includes("alpha"));
  assert.ok(methods.includes("scaleTo"));
  assert.ok(methods.includes("font"));
  assert.equal(methods.includes("key"), false);
  assert.equal(methods.includes("front"), false);
  assert.equal(methods.includes("say"), false);
});

test("a 新对象 with no type says which wire is missing", () => {
  const graph = emptyGraph();
  graph.nodes.push({ id: "d1", type: "NewObject", x: 0, y: 0, params: { objectName: "ch" } });
  const code = inferGraph(graph);
  assert.match(code, /^# ch 还没有接上类型/);
  assert.equal(tokenize(code).error, undefined);
});

test("a definition whose name is not an identifier says so", () => {
  const { graph } = scene({ name: "3bad" });
  const code = inferGraph(graph);
  assert.match(code, /^# 对象名无效/);
  assert.equal(tokenize(code).error, undefined);
});

test("an advanced type puts its place and size in the constructor's arguments", () => {
  const { graph } = scene({
    type: "TypeCharacterAdv",
    typeParams: { image: "ch.png", x: -300, y: -500, scale: 2 },
  });
  assert.equal(
    inferGraph(graph).trim(),
    'ch = Character("ch.png", x = -300, y = -500, scaleTo = 2)',
  );
});

test("a place and a size that change nothing are left out", () => {
  const { graph } = scene({
    type: "TypeCharacterAdv",
    typeParams: { image: "ch.png", x: 200, y: 0, scale: 1 },
  });
  // A zero — the origin a new object already sits at — and a scale of 1 say
  // nothing, so the call stays `Character("ch.png", x = 200)`.
  assert.equal(inferGraph(graph).trim(), 'ch = Character("ch.png", x = 200)');
});

test("definitions are emitted before the flow, wherever they sit", () => {
  // The call node is wired to 开始; its definition is drawn far below it, which
  // is the key constraint of the split — a name does not have to be threaded
  // through the flow to exist before it is used.
  const { graph, declare, ctor } = scene({ name: "late" });
  declare.y = 4000;
  ctor.y = 4200;
  assert.equal(inferGraph(graph).trim(), 'late = Character("h.png")');
});

test("a call node stacks its behaviours in reading order", () => {
  const { graph, call } = scene({
    behaviors: [
      { method: "enable" },
      { method: "say", params: { text: "hi" } },
    ],
  });
  const [first, second] = graph.nodes.filter((n) => n.behaviorOf === call.id);
  // Put the second above the first: the stack's order is its layout.
  first.y = 200;
  second.y = 60;
  assert.equal(inferGraph(graph).trim(), 'ch = Character("h.png")\nch.say("hi").enable()');
});

test("each behaviour method writes its own arguments", () => {
  // 关键约束：每个节点对应一个方法，节点字段即该调用的参数。
  const { graph } = scene({
    behaviors: [
      { method: "alpha", params: { value: 0.5, time: 300 } },
      { method: "moveTo", params: { x: 10, y: -20, time: 0 } },
      { method: "rotate", params: { degrees: 90, time: 500 } },
      { method: "hex", params: { hex: "#ff0000", time: 0 } },
      { method: "name", params: { value: "小明" } },
      { method: "say", params: { text: "你好" } },
      { method: "enable", params: {} },
    ],
  });
  assert.equal(
    inferGraph(graph).trim(),
    'ch = Character("h.png")\n' +
      'ch.alpha(0.5, 300).moveTo(10, -20).rotate(90, 500).hex("#ff0000").name("小明").say("你好").enable()',
  );
});

test("a behaviour with no object says so instead of calling nothing", () => {
  const graph = emptyGraph();
  graph.nodes.push({
    id: "n2",
    type: behaviorTypeName("enable"),
    x: 0,
    y: 0,
    behaviorOf: null,
    params: {},
  });
  const code = inferGraph(graph);
  assert.match(code, /^# 行为没有连到对象/);
  assert.equal(tokenize(code).error, undefined);
});

test("the object's variable is what a data wire carries", () => {
  const { graph } = scene({ name: "hero" });
  const say = { id: "s1", type: "Say", x: 300, y: 0, params: { text: "hi", speaker: "" } };
  graph.nodes.push(say);
  graph.edges.push({ id: "x2", from: { node: "c1", port: 0 }, to: { node: "s1", port: 0 } });
  graph.dataEdges.push({ id: "d1", from: { node: "c1", port: 0 }, to: { node: "s1", port: 0 } });
  assert.equal(inferGraph(graph).trim(), 'hero = Character("h.png")\ndialog.say("hi", hero)');
});

test("a call node naming nothing declared is reported", () => {
  const graph = emptyGraph();
  graph.nodes.push({
    id: "c1",
    type: "Object",
    x: 0,
    y: 0,
    params: { objectName: "ghost" },
  });
  graph.nodes.push({ id: "b1", type: behaviorTypeName("enable"), x: 0, y: 100, behaviorOf: "c1", params: {} });
  graph.edges.push({ id: "x1", from: { node: "n1", port: 0 }, to: { node: "c1", port: 0 } });
  const code = inferGraph(graph);
  assert.match(code, /# ghost 没有对应的「新对象」定义/);
  assert.equal(tokenize(code).error, undefined);
});

test("an old single-box 对象 node is split when it is read", () => {
  const old = {
    version: 2,
    nodes: [
      { id: "n1", type: "Start", x: 0, y: 0, params: {} },
      {
        id: "n2",
        type: "Object",
        x: 0,
        y: 0,
        params: { objectType: "Audio", objectName: "se", file: "click.mp3" },
      },
    ],
    edges: [{ id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } }],
    dataEdges: [],
  };
  const graph = parseGraph(JSON.stringify(old));
  assert.equal(
    graph.nodes.filter((n) => n.type === "Object" && Object.hasOwn(n.params, "objectType")).length,
    0,
    "the generic box is gone",
  );
  assert.equal(inferGraph(graph).trim(), 'se = Audio("click.mp3")');
});

// --- serial vs parallel ---

test("a serial output cannot feed two nodes", () => {
  // 开始 → 背景 and 开始 → 角色 at the same time is exactly what the serial rule
  // forbids: the two must be chained instead.
  const nodes = [
    { id: "n1", type: "Start" },
    { id: "n2", type: "Background" },
    { id: "n3", type: "Character" },
  ];
  assert.equal(outputCanFanOut(nodes, "n1"), false);
  // A parallel block is the exception.
  const withCue = [...nodes, { id: "n4", type: "Cue", params: {} }];
  assert.equal(outputCanFanOut(withCue, "n4"), true);
  // …and so are the statements inside one.
  const inCue = [...withCue, { id: "n5", type: "Say", parent: "n4", parentPort: 0 }];
  assert.equal(outputCanFanOut(inCue, "n5"), true);
});

test("a block's 完成 is serial like any other output", () => {
  const nodes = [
    { id: "n1", type: "If", params: { cond: "true" } },
    { id: "n2", type: "Say" },
  ];
  assert.equal(outputCanFanOut(nodes, "n1"), false);
});

test("a definition wire cannot be mistaken for the flow", () => {
  const assign = linkEnds(
    { node: "d1", port: 0, dir: "out", kind: "assign" },
    { node: "t1", port: 0, dir: "in", kind: "assign" },
  );
  assert.equal(assign.kind, "assign");
  // A definition is not a step, so neither kind may stand in for the other.
  assert.equal(
    linkEnds(
      { node: "d1", port: 0, dir: "out", kind: "assign" },
      { node: "s1", port: 0, dir: "in", kind: "exec" },
    ),
    null,
  );
  assert.equal(
    linkEnds(
      { node: "s1", port: 0, dir: "out", kind: "exec" },
      { node: "t1", port: 0, dir: "in", kind: "assign" },
    ),
    null,
  );
});

test("the method list follows the object's type", () => {
  const bg = { id: "n1", type: "TypeBackground", params: {} };
  const ch = { id: "n2", type: "TypeCharacter", params: {} };
  const au = { id: "n3", type: "TypeAudio", params: {} };
  assert.ok(methodsFor(bg).includes("crossFade"));
  assert.ok(!methodsFor(bg).includes("front"), "a background has no layer order");
  assert.ok(methodsFor(ch).includes("front"));
  assert.ok(!methodsFor(ch).includes("crossFade"));
  assert.deepEqual(methodsFor(au), ["play", "stop", "loop", "once", "volume", "duration"]);
  // Unconnected: everything, so the node can be placed before it is wired.
  assert.ok(methodsFor(null).includes("enable"));
  assert.ok(methodsFor(null).includes("play"));
});

test("a type gets every method the API table gives it, not a stale hand list", () => {
  const light = { id: "l", type: "TypeLight", params: {} };
  const effect = { id: "e", type: "TypeEffect", params: {} };
  const text = { id: "t", type: "TypeText", params: {} };
  // 灯也能启用、移位、染色；特效也能播放、淡入淡出。
  assert.ok(methodsFor(light).includes("enable"));
  assert.ok(methodsFor(light).includes("moveTo"));
  assert.ok(methodsFor(light).includes("hex"));
  assert.ok(methodsFor(effect).includes("play"));
  assert.ok(methodsFor(effect).includes("alpha"));
  // 文字改色是 `color`，图片的 `hex` 不属于它。
  assert.ok(methodsFor(text).includes("color"));
  assert.ok(!methodsFor(text).includes("hex"));
});

test("a call node's method list comes from the type its variable is built with", () => {
  const { graph, call } = scene({ type: "TypeAudio", typeParams: { file: "a.mp3" } });
  assert.deepEqual(methodsFor(call, graph), ["play", "stop", "loop", "once", "volume", "duration"]);
});

test("a 新对象 has one 赋值 out; a type node one 赋值 in and no way out", () => {
  const declare = { id: "d", type: "NewObject", x: 0, y: 0, params: {} };
  assert.deepEqual(
    portsOf(declare).map((p) => [p.dir, p.kind, p.label]),
    [["out", "assign", "赋值"]],
  );
  const ctor = { id: "t", type: "TypeCharacter", x: 0, y: 0, params: {} };
  assert.deepEqual(
    portsOf(ctor).map((p) => [p.dir, p.kind]),
    [["in", "assign"]],
    "nothing continues out of a constructor",
  );
});

test("a 对象 node is a step in the flow: 流程 in and 流程 out", () => {
  const call = { id: "c", type: "Object", x: 100, y: 50, params: { objectName: "ch" } };
  const ports = portsOf(call).filter((p) => p.kind === "exec");
  assert.deepEqual(
    ports.map((p) => [p.dir, p.label]),
    [
      ["in", "流程"],
      ["out", "流程"],
    ],
  );
  const rect = nodeRect(call, [call]);
  for (const p of ports) {
    const pt = portPoint(call, p.dir, p.port, p.kind, [call]);
    if (p.dir === "in") assert.equal(pt.x, rect.x, "an input sits on the left edge");
    else assert.equal(pt.x, rect.x + rect.w, "an output sits on the right edge");
  }
});

test("a behaviour has no sockets at all", () => {
  // The difference this pins: a behaviour is not wired, it is stacked. Its
  // object and its place in the chain are both read off the canvas.
  const behavior = { id: "n1", type: behaviorTypeName("enable"), params: {} };
  assert.deepEqual(portsOf(behavior), []);
  assert.equal(isBehaviorNode(behavior.type), true);
  assert.equal(isObjectNode(behavior.type), false);
});

test("behaviourParent and behaviorChain read a chain off the stack", () => {
  const nodes = [
    { id: "n1", type: behaviorTypeName("enable"), behaviorOf: "obj", y: 100 },
    { id: "n2", type: behaviorTypeName("say"), behaviorOf: "obj", y: 200 },
    { id: "n3", type: behaviorTypeName("front"), behaviorOf: "obj", y: 300 },
    { id: "obj", type: "Object", y: 0 },
  ];
  assert.equal(behaviorParent(nodes[0], nodes), null, "the first call has no behaviour parent");
  assert.equal(behaviorParent(nodes[1], nodes)?.id, "n1");
  assert.deepEqual(behaviorChain(nodes[0], nodes).map((n) => n.id), ["n1", "n2", "n3"]);
  // Dragging a call above another is the whole edit: the order is the layout.
  nodes[0].y = 400;
  assert.deepEqual(
    behaviorChain(nodes[2], nodes).map((n) => n.id),
    ["n3", "n1"],
    "the tail of the stack follows the move",
  );
});

test("a detached behaviour has no chain and no object", () => {
  const nodes = [
    { id: "n1", type: behaviorTypeName("enable"), behaviorOf: null, y: 100 },
    { id: "n2", type: behaviorTypeName("say"), behaviorOf: null, y: 200 },
  ];
  assert.equal(behaviorParent(nodes[1], nodes), null);
  assert.equal(behaviorOwner(nodes[1], nodes), null);
  assert.deepEqual(behaviorChain(nodes[1], nodes).map((n) => n.id), ["n2"]);
});

test("a wire lands on the socket, not on the card's title", () => {
  // Regression case: `portPoint` put a socket on the header line while the DOM
  // put it on the port band below it, so every wire landed ~26px high — on the
  // title.
  const node = { id: "n1", type: "Say", x: 100, y: 100, params: {} };
  const port = portsOf(node).find((p) => p.dir === "in");
  const point = portPoint(node, "in", port.port, port.kind, [node]);
  // The DOM puts sockets below the header, inside the ports band.
  assert.ok(
    point.y > node.y + HEADER_H,
    `the socket must sit below the header, got y=${point.y}`,
  );
  assert.ok(
    point.y < node.y + HEADER_H + PORTS_TOP + PORT_ROW_H + PORTS_TOP,
    `and inside the ports band, got y=${point.y}`,
  );
  // And the stylesheet must not nudge them: a CSS `top` override is what broke
  // the agreement between the two in the first place.
  const css = readFileSync(new URL("../styles/graph.css", import.meta.url), "utf8");
  const start = css.indexOf(".gnode--behavior .gsock {");
  assert.equal(start, -1, "no per-type socket override");
});

test("every node is one width, and its sockets sit on that width", () => {
  // Regression case: the stylesheet forced behaviour cards to 190px while the
  // socket rule still said `left: 210px`, so every behaviour's output socket
  // hung 20px outside its own card. Width now has one source: `NODE_W`, written
  // onto the element as `--gnode-w`.
  const css = readFileSync(new URL("../styles/graph.css", import.meta.url), "utf8");

  const sockOut = css.indexOf(".gsock--out {");
  assert.notEqual(sockOut, -1);
  const sockRule = css.slice(sockOut, css.indexOf("}", sockOut));
  assert.match(
    sockRule,
    /left:\s*var\(--gnode-w/,
    "the output socket must follow the node's width, not a literal",
  );
  assert.equal(/left:\s*\d+px/.test(sockRule), false, "no hard-coded socket offset");

  // No node type may override the width the geometry uses.
  assert.equal(
    /\.gnode--behavior\s*\{[^}]*\bwidth\s*:/s.test(css),
    false,
    "a node's width belongs to NODE_W, not to a per-type override",
  );

  // The element carries the width the sockets and the wires both use.
  const source = readFileSync(new URL("../graph-editor.js", import.meta.url), "utf8");
  assert.match(source, /setProperty\("--gnode-w", `\$\{NODE_W\}px`\)/);
});

test("a socket never lands outside its own node", () => {
  for (const type of ["Say", behaviorTypeName("enable"), behaviorTypeName("say"), "TypeCharacter"]) {
    const node = { id: "n1", type, x: 100, y: 100, params: {} };
    const rect = nodeRect(node, [node]);
    for (const p of portsOf(node)) {
      const pt = portPoint(node, p.dir, p.port, p.kind, [node]);
      assert.ok(pt.x >= rect.x - 0.01, `${type} ${p.dir} socket starts inside`);
      assert.ok(pt.x <= rect.x + rect.w + 0.01, `${type} ${p.dir} socket ends inside`);
    }
  }
});

test("the newly supported calls each get a node", () => {
  for (const method of [
    "color",
    "duration",
    "VideoMedia.rotateH",
    "VideoMedia.rotateHTo",
    "VideoMedia.rotateV",
    "VideoMedia.rotateVTo",
  ]) {
    assert.ok(NODE_TYPES_FOR_TEST[behaviorTypeName(method)], `missing node type for ${method}`);
  }
  // 颜色是文本字段，不是数字：节点上不能填 `255` 之类。
  const colorNode = NODE_TYPES_FOR_TEST[behaviorTypeName("color")];
  assert.equal(colorNode.params[0].key, "value");
  assert.equal(colorNode.params[0].type, "text");
  // autoVoice 是舞台的全局调用，不是挂在对象上的行为。
  assert.ok(NODE_TYPES_FOR_TEST["call:autoVoice"]);
  assert.equal(isBehaviorNode(behaviorTypeName("autoVoice")), false);
});

test("every behaviour method has its own node type", () => {
  // One node per method is the point: each box shows only that call's fields.
  for (const method of methodsFor(null)) {
    const type = behaviorTypeName(method);
    assert.ok(NODE_TYPES_FOR_TEST[type], `missing node type for ${method}`);
    assert.equal(behaviorMethodOf(type), method);
    assert.equal(isBehaviorNode(type), true);
    assert.equal(isObjectNode(type), false);
  }
  // A type that is not a behaviour reports no method.
  assert.equal(behaviorMethodOf("Say"), null);
  assert.equal(behaviorMethodOf("beh:nope"), null);
});

test("a behaviour node's fields are the call's arguments", () => {
  const alpha = NODE_TYPES_FOR_TEST[behaviorTypeName("alpha")];
  assert.deepEqual(alpha.params.map((p) => p.key), ["value", "time"]);
  const moveTo = NODE_TYPES_FOR_TEST[behaviorTypeName("moveTo")];
  // `move` keeps only its own job — no path field: the animation is a separate
  // `key` behaviour now.
  assert.deepEqual(moveTo.params.map((p) => p.key), ["x", "y", "time"]);
  const move = NODE_TYPES_FOR_TEST[behaviorTypeName("move")];
  assert.deepEqual(move.params.map((p) => p.key), ["dx", "dy", "time"]);
  // A key names the key frame file it plays, which is the call's one argument;
  // the object it hangs off is still read off the wire.
  const key = NODE_TYPES_FOR_TEST[behaviorTypeName("key")];
  assert.deepEqual(key.params.map((p) => p.key), ["file"]);
  const enable = NODE_TYPES_FOR_TEST[behaviorTypeName("enable")];
  assert.deepEqual(enable.params, [], "a call with no arguments has no fields");
});

test("a behaviour's object is what it was dropped on", () => {
  // Regression case: a behaviour created by a gesture was rendered before its
  // owner was known, so its header kept showing the unlinked label.
  const nodes = [
    { id: "obj", type: "Object", params: { objectName: "hero" }, y: 0 },
    { id: "b1", type: behaviorTypeName("enable"), behaviorOf: "obj", params: {}, y: 100 },
    { id: "b2", type: behaviorTypeName("say"), behaviorOf: "obj", params: {}, y: 200 },
  ];
  assert.equal(behaviorOwner(nodes[1], nodes)?.id, "obj");
  assert.equal(behaviorParent(nodes[1], nodes), null, "it heads the chain");
  assert.equal(behaviorParent(nodes[2], nodes)?.id, "b1");
});

test("an object node is recognised by type, not by a flag on the node", () => {
  // Regression case: `nodes.filter(isObjectNode)` passed a *node* where a type
  // was expected, so nothing matched and two objects could share one variable.
  assert.equal(isObjectNode("NewObject"), true);
  assert.equal(isObjectNode("TypeCharacter"), true);
  assert.equal(isObjectNode("Object"), true);
  assert.equal(isObjectNode("Say"), false);
  assert.equal(isObjectNode({ type: "NewObject" }), false);
  // Each half answers its own question.
  assert.equal(isDeclareNode("NewObject"), true);
  assert.equal(isTypeNode("TypeCharacter"), true);
  assert.equal(isCallNode("Object"), true);
  assert.equal(isTypeNode("Object"), false);
});

// --- the 动作 node ---

test("a 动作 node emits the call it names, with its duration last", () => {
  const graph = chain(["StageCall"]);
  graph.nodes[1].params = { target: "hero", method: "rotate", args: "90", time: "500" };
  assert.equal(inferGraph(graph).trim(), "hero.rotate(90, 500)");
});

test("a 动作 node with no arguments emits an empty call", () => {
  const graph = chain(["StageCall"]);
  graph.nodes[1].params = { target: "hero", method: "front", args: "", time: "" };
  assert.equal(inferGraph(graph).trim(), "hero.front()");
});

// --- the canvas chrome that the geometry depends on ---

test("a block's header, lanes and resize grip exist and are styled", () => {
  // These are the pieces the "where does the block end" answer is made of, so
  // they must not quietly disappear from the stylesheet.
  const css = readFileSync(new URL("../styles/graph.css", import.meta.url), "utf8");
  for (const rule of [".gnode--container {", ".glane {", ".gnode__resize {", ".gnode__check {"]) {
    assert.notEqual(css.indexOf(rule), -1, `expected ${rule}`);
  }
  // A block's body sits above the box, so the box must not eat their clicks.
  const start = css.indexOf(".gnode--container {");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(rule, /box-sizing:\s*border-box/, "a block's width must include its border");
});

test("a block's lanes are laid out inside its own rectangle", () => {
  const graph = block("Choice", { options: "甲\n乙" }, {});
  const choice = graph.nodes.find((n) => n.type === "Choice");
  const rect = containerRect(choice, graph.nodes);
  const lanes = laneRectsForTest(choice, graph.nodes);
  assert.equal(lanes.length, 2);
  for (const lane of lanes) {
    assert.ok(lane.x >= rect.x, "a lane starts inside the box");
    assert.ok(lane.x + lane.w <= rect.x + rect.w + 0.5, "and ends inside it");
    assert.ok(lane.y >= rect.y + 28, "the lanes sit below the header");
  }
  // Two lanes split the width, left to right.
  assert.ok(lanes[0].x < lanes[1].x);
  assert.equal(laneAtForTest(choice, lanes[0].x + 5, graph.nodes), 0);
  assert.equal(laneAtForTest(choice, lanes[1].x + 5, graph.nodes), 1);
});

test("the zoom controls are in the toolbar and show the current zoom", () => {
  const source = readFileSync(new URL("../graph-editor.js", import.meta.url), "utf8");
  // A camera the user cannot read or reset is a camera they cannot trust.
  assert.match(source, /graph__zoom/);
  // The toolbar buttons are icon-only now; the labels live in `title` so they
  // still surface as tooltips. "适应内容" is the fit-to-content button.
  assert.match(source, /title: "适应内容"/);
  // The zoom readout itself stays as text next to the buttons.
  assert.match(source, /text: "100%"/);
  // The map's camera is written back with it, not kept only in memory.
  assert.match(source, /graph\.view = \{/);
});

// --- the generated script is real Pamela ---

test("every statement the canvas emits parses as Pamela", () => {
  // The canvas' job is to write a script the interpreter accepts. This walks
  // one node of every type — including a body inside every kind of block —
  // through the real tokenizer and parser rather than pattern-matching text.
  const graph = emptyGraph();
  let n = 2;
  let prev = "n1";
  const add = (type, params, extra = {}) => {
    const node = { id: `n${n}`, type, x: 0, y: n * 50, params, ...extra };
    n += 1;
    graph.nodes.push(node);
    return node.id;
  };
  const wire = (from, to) => graph.edges.push({ id: `e${n++}`, from: { node: from, port: 0 }, to: { node: to, port: 0 } });

  for (const [type, params] of [
    ["Background", { image: "bg.png", enable: true }],
    ["Character", { name: "hero", image: "h.png", enable: true, x: 10, y: -20, alpha: 0.5 }],
    ["Say", { speaker: "小明", text: "你好" }],
    ["Wait", { ms: 500 }],
    ["Audio", { file: "bgm.mp3", action: "loop" }],
    ["StageCall", { target: "hero", method: "rotate", args: "90", time: "500" }],
    ["StageCall", { target: "hero", method: "crossFade", args: '"a.png"', time: "300" }],
    ["StageCall", { target: "bg", method: "front", args: "", time: "" }],
    ["SetVar", { name: "count", value: "3" }],
    ["Include", { file: "other.pamela" }],
    ["Jump", { file: "scene.pamela" }],
    ["Use", { file: "templates/x.dialog.json" }],
    ["DialogEnable", {}],
    ["DialogDisable", {}],
    ["Filter", { target: "hero", mode: "hex", r: 0, g: 0, b: 0, hex: "#ff0000" }],
  ]) {
    const id = add(type, params);
    wire(prev, id);
    prev = id;
  }

  const iff = add("If", { cond: "true" });
  wire(prev, iff);
  add("Say", { text: "成立" }, { parent: iff, parentPort: 0 });
  add("Say", { text: "否则" }, { parent: iff, parentPort: 1 });
  const loop = add("While", { cond: "count < 10" });
  wire(iff, loop);
  add("Say", { text: "循环" }, { parent: loop, parentPort: 0 });
  const cue = add("Cue", {});
  wire(loop, cue);
  add("Say", { text: "同时" }, { parent: cue, parentPort: 0 });
  const choice = add("Choice", { options: "甲\n乙" });
  wire(cue, choice);
  add("Say", { text: "甲" }, { parent: choice, parentPort: 0 });
  add("Say", { text: "乙" }, { parent: choice, parentPort: 1 });

  const code = inferGraph(graph);
  const tokens = tokenize(code);
  assert.equal(tokens.error, undefined, "the generated script must tokenize");
  const parsed = parse(tokens.tokens ?? tokens);
  assert.equal(parsed.error, undefined, `the generated script must parse: ${parsed.error?.message}`);

  // And the reverse direction produces something that parses too.
  const back = graphFromPamela(code);
  const again = tokenize(inferGraph(back));
  assert.equal(again.error, undefined);
});



// --- 关键帧文件与资源列表 ---

test("a key behaviour emits the key frame file it names", () => {
  const { graph } = scene({ behaviors: [{ method: "key", params: { file: "key-ch.keyframes" } }] });
  const code = inferGraph(graph);
  assert.match(code, /ch\.key\("key-ch\.keyframes"\)/);
});

test("a key with no file names none, so the old fallback still works", () => {
  const { graph } = scene({ behaviors: [{ method: "key", params: {} }] });
  // `ch.key("")` would name a file that cannot exist; the call falls back to
  // the object's own name instead, which is what an old script plays.
  assert.match(inferGraph(graph), /ch\.key\(\)/);
});

test("the type nodes name a file field, and only that field gets a picker", () => {
  const background = NODE_TYPES_FOR_TEST.TypeBackground;
  assert.deepEqual(background.params.map((p) => p.key), ["image"]);
  const character = NODE_TYPES_FOR_TEST.TypeCharacter;
  assert.deepEqual(character.params.map((p) => p.key), ["image"]);
  const audio = NODE_TYPES_FOR_TEST.TypeAudio;
  assert.deepEqual(audio.params.map((p) => p.key), ["file"]);
  // A Text has no file: its one field is the words it shows.
  const text = NODE_TYPES_FOR_TEST.TypeText;
  assert.deepEqual(text.params.map((p) => p.key), ["text"]);
  // The advanced types add the arguments a writer would otherwise wire as
  // behaviours: where it starts, and how big it is.
  const advanced = NODE_TYPES_FOR_TEST.TypeCharacterAdv;
  assert.deepEqual(
    advanced.params.map((p) => p.key),
    ["image", "x", "y", "scale"],
  );
  // The definition half only names the variable.
  assert.deepEqual(
    NODE_TYPES_FOR_TEST.NewObject.params.map((p) => p.key),
    ["objectName"],
  );
});

test("the object/behaviour joint is a solid outline, not a transparent gap", () => {
  const css = readFileSync(new URL("../styles/graph.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const body = css.slice(css.indexOf(selector));
    return body.slice(0, body.indexOf("}"));
  };
  // Geometry and painting must agree on the rail's height, and no canvas may
  // show through between the two cards.
  assert.equal(DOCK_H, 6);
  assert.match(rule(".gnode__dock {"), /height:\s*6px/);
  assert.equal(BEHAVIOR_GAP, 0);
  assert.match(rule(".gnode__dock {"), /border:\s*1px solid #/);
  assert.match(rule(".gnode--behavior {"), /border-color:\s*#[0-9a-f]{6}/i);
  const seam = rule(".gnode--behavior.is-attached {");
  assert.doesNotMatch(seam, /transparent/);
  assert.match(seam, /border-top-color:\s*#[0-9a-f]{6}/i);
});
