// 反向解析测试：`graphFromPamela` 把剧本还原为 `.pmap` 图。
// Reverse parsing: `graphFromPamela` turns a Pamela script into a `.pmap` graph.

import assert from "node:assert/strict";
import test from "node:test";

import { graphFromPamela } from "../map-parse.js";
import { inferGraph } from "../graph-editor.js";

function nodeTypes(graph) {
  return graph.nodes.map((n) => n.type);
}

function byType(graph, type) {
  return graph.nodes.filter((n) => n.type === type);
}

function execOut(graph, nodeId) {
  return graph.edges.filter((e) => e.from.node === nodeId);
}

test("key() 反解成独立的关键帧节点", () => {
  const code = [
    'hero = Character("hero.png")',
    "hero.enable()",
    'hero.key()',
  ].join("\n");

  const g = graphFromPamela(code);
  // A definition is two nodes: the name, and the constructor it is built with.
  const declare = byType(g, "NewObject")[0];
  const ctor = byType(g, "TypeCharacter")[0];
  assert.ok(declare && ctor, "定义由「新对象」与类型节点共同组成");
  assert.equal(declare.params.objectName, "hero");
  assert.equal(ctor.params.image, "hero.png");
  assert.equal(byType(g, "Object")[0].params.objectName, "hero");

  // The animation is a behaviour of its own, stacked under the 对象 node.
  const walk = byType(g, "beh:key")[0];
  assert.ok(walk, "key() 应折回 beh:key");
  assert.deepEqual(walk.params, {}, "key 没有字段：对象名就是它的 id");
  assert.equal(walk.behaviorOf, byType(g, "Object")[0].id);
});

test("key() 与 move 往返不互相污染", () => {
  // Neither a move nor a key is written on the definition: both are calls, so
  // both come back as behaviours and the constructor keeps only its resource.
  const straight = graphFromPamela(
    ['hero = Character("hero.png")', "hero.enable()", "hero.move(10, 20, 0, 300)"].join("\n"),
  );
  const walk = graphFromPamela(
    ['hero = Character("hero.png")', "hero.enable()", 'hero.followPath("p9")'].join("\n"),
  );

  assert.equal(byType(straight, "TypeCharacter")[0].params.image, "hero.png");
  assert.equal(byType(straight, "beh:move")[0].params.dx, "10");
  assert.equal(byType(straight, "beh:move")[0].params.dy, "20");

  assert.ok(byType(walk, "beh:key")[0], "key() 产生关键帧节点");
  assert.equal(byType(walk, "beh:move").length, 0, "动画不该同时产生移动");
});

test("parses a linear script into the matching node types", () => {
  const code = [
    'bg = Background("bg.png")',
    "bg.enable()",
    'hero = Character("hero.png")',
    "hero.move(100, 200)",
    'title = Text("旧书店")',
    "title.enable()",
    'title.font("宋体")',
    'dialog.say("hi", hero)',
    "wait 500",
    'bgm = Audio("bgm.mp3")',
    "bgm.loop()",
    'use "templates/x.dialog.json"',
    "dialog.enable()",
    "dialog.disable()",
    "count = 3",
    'jump("scene.pamela")',
    'include "other.pamela"',
    "hero.rgbTo(10, 20, 30)",
    'hero.hex("#abcdef")',
  ].join("\n");

  const g = graphFromPamela(code);

  assert.equal(byType(g, "Start").length, 1);
  const bgDeclare = byType(g, "NewObject").find((n) => n.params.objectName === "bg");
  assert.ok(bgDeclare, "背景的定义是一个「新对象」");
  assert.equal(byType(g, "TypeBackground")[0].params.image, "bg.png");

  const heroDeclare = byType(g, "NewObject").find((n) => n.params.objectName === "hero");
  assert.equal(heroDeclare.params.objectName, "hero");
  assert.equal(byType(g, "TypeCharacter")[0].params.image, "hero.png");
  // `hero.move(...)` is a call, so it comes back as a behaviour.
  assert.equal(byType(g, "beh:move")[0].params.dx, "100");

  // A Text's first argument is its content, so it must land in `text` rather
  // than in the image field.
  assert.equal(byType(g, "TypeText")[0].params.text, "旧书店");
  assert.equal(byType(g, "beh:font")[0].params.family, "宋体");
  assert.equal(byType(g, "beh:enable").length, 2, "bg 与 title 各有一个「显示」");

  const hero = byType(g, "Object").find((n) => n.params.objectName === "hero");
  const say = byType(g, "Say")[0];
  assert.equal(say.params.text, "hi");
  // `dialog.say("hi", hero)` becomes a data wire from the 对象 node, not a literal.
  assert.equal(say.params.speaker, "");
  assert.equal(g.dataEdges.length, 1);
  assert.equal(g.dataEdges[0].from.node, hero.id);
  assert.equal(g.dataEdges[0].to.node, say.id);

  assert.equal(byType(g, "Wait")[0].params.ms, 500);
  assert.equal(byType(g, "TypeAudio")[0].params.file, "bgm.mp3");
  assert.equal(byType(g, "Use")[0].params.file, "templates/x.dialog.json");
  assert.equal(byType(g, "DialogEnable").length, 1);
  assert.equal(byType(g, "DialogDisable").length, 1);
  assert.equal(byType(g, "SetVar")[0].params.value, "3");
  assert.equal(byType(g, "Jump")[0].params.file, "scene.pamela");
  assert.equal(byType(g, "Include")[0].params.file, "other.pamela");

  // Calls on a known object come back as behaviours, not as free-standing nodes.
  const behaviors = g.nodes.filter((n) => n.type.startsWith("beh:"));
  assert.deepEqual(
    behaviors.map((b) => b.type),
    ["beh:enable", "beh:move", "beh:enable", "beh:font", "beh:loop", "beh:rgbTo", "beh:hex"],
  );
  assert.ok(behaviors.every((b) => b.behaviorOf), "every behaviour belongs to an object");
});

/** The nodes that live inside a block, in reading order. */
function body(graph, blockId, port = 0) {
  return graph.nodes
    .filter((n) => n.parent === blockId && (n.parentPort ?? 0) === port)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

test("parses a choice block into lanes, one per option", () => {
  const code = [
    "choice {",
    '  "左" {',
    '    dialog.say("左")',
    "  }",
    '  "右" {',
    '    dialog.say("右")',
    "  }",
    "}",
  ].join("\n");
  const g = graphFromPamela(code);
  const choice = byType(g, "Choice")[0];
  assert.equal(choice.params.options, "左\n右");
  // The statements are *inside* the block: one per lane, no branch wires.
  assert.equal(execOut(g, choice.id).length, 0);
  assert.equal(body(g, choice.id, 0)[0].params.text, "左");
  assert.equal(body(g, choice.id, 1)[0].params.text, "右");
});

test("parses an if/else block with its statements inside the box", () => {
  const code = [
    "if (hp > 0) {",
    '  dialog.say("活")',
    "} else {",
    '  dialog.say("死")',
    "}",
  ].join("\n");
  const g = graphFromPamela(code);
  const iff = byType(g, "If")[0];
  assert.equal(iff.params.cond, "hp > 0");
  // A block has one way out; its branches are lanes, not wires.
  assert.equal(execOut(g, iff.id).length, 0);
  assert.equal(body(g, iff.id, 0)[0].params.text, "活");
  assert.equal(body(g, iff.id, 1)[0].params.text, "死");
});

test("parses a while block and puts its body inside it", () => {
  const code = ["while (true) {", '  dialog.say("loop")', "}"].join("\n");
  const g = graphFromPamela(code);
  const loop = byType(g, "While")[0];
  assert.equal(loop.params.cond, "true");
  assert.equal(execOut(g, loop.id).length, 0);
  assert.equal(body(g, loop.id, 0)[0].params.text, "loop");
});

test("parses a cue block", () => {
  const code = ["cue {", '  dialog.say("同时")', "}"].join("\n");
  const g = graphFromPamela(code);
  const cue = byType(g, "Cue")[0];
  assert.ok(cue, "cue is a block");
  assert.equal(body(g, cue.id, 0)[0].params.text, "同时");
});

test("a block's statements keep their written order", () => {
  const code = [
    "if (x) {",
    '  dialog.say("一")',
    '  dialog.say("二")',
    '  dialog.say("三")',
    "}",
  ].join("\n");
  const g = graphFromPamela(code);
  const iff = byType(g, "If")[0];
  assert.deepEqual(
    body(g, iff.id, 0).map((n) => n.params.text),
    ["一", "二", "三"],
  );
  // And they are laid out as a column, top to bottom, inside the box.
  const ys = body(g, iff.id, 0).map((n) => n.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys);
});

test("a statement after a block is a sibling, not part of its body", () => {
  const code = [
    "if (x) {",
    '  dialog.say("内")',
    "}",
    'dialog.say("外")',
  ].join("\n");
  const g = graphFromPamela(code);
  const iff = byType(g, "If")[0];
  const outside = g.nodes.find((n) => n.params?.text === "外");
  assert.equal(outside.parent, undefined);
  assert.ok(execOut(g, iff.id).some((e) => e.to.node === outside.id), "wired from 完成");
});

test("parses Character.enable and the other stage calls", () => {
  const code = [
    'hero = Character("h.png")',
    "hero.enable()",
    "hero.rotate(90, 500)",
    "hero.front()",
  ].join("\n");
  const g = graphFromPamela(code);
  const hero = byType(g, "Object")[0];
  // Every call on the character is a behaviour stacked under that object: that
  // is the shape the canvas draws, so reading it back any other way would lose
  // it.
  const behaviors = g.nodes.filter((n) => n.type.startsWith("beh:"));
  assert.deepEqual(
    behaviors.map((b) => b.type),
    ["beh:enable", "beh:rotate", "beh:front"],
  );
  assert.equal(behaviors[1].params.degrees, "90");
  assert.equal(behaviors[1].params.time, "500");
  assert.ok(behaviors.every((b) => b.behaviorOf === hero.id));
  // Nothing is wired: the stack is the chain, and the calls are in order.
  assert.equal(g.edges.filter((e) => e.from.port !== 0).length, 0);
  assert.deepEqual(
    [...behaviors].sort((a, b) => a.y - b.y).map((b) => b.type),
    ["beh:enable", "beh:rotate", "beh:front"],
  );
});

test("a call on a variable that is not an object stays a 动作 node", () => {
  const g = graphFromPamela(["hero.rotate(90)", "thing.enable()"].join("\n"));
  const calls = byType(g, "StageCall");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.params.target), ["hero", "thing"]);
});

test("round-trips inferGraph through graphFromPamela", () => {
  // Build a small graph, infer it, then parse the result back and re-infer — the
  // second inference should match the first (structure preserved end to end).
  const graph = {
    version: 3,
    nodes: [
      { id: "n1", type: "Start", x: 0, y: 0, params: {} },
      { id: "d1", type: "NewObject", x: 0, y: -400, params: { objectName: "hero" } },
      {
        id: "t1",
        type: "TypeCharacterAdv",
        x: 0,
        y: -280,
        params: { image: "h.png", x: 640, y: 360, scale: 1 },
      },
      { id: "n2", type: "Object", x: 0, y: 0, params: { objectName: "hero" } },
      { id: "n3", type: "Say", x: 0, y: 0, params: { speaker: "", text: "hi" } },
      { id: "n4", type: "While", x: 0, y: 0, w: 300, h: 200, params: { cond: "true" } },
      { id: "n5", type: "Say", x: 0, y: 0, parent: "n4", parentPort: 0, params: { speaker: "", text: "again" } },
      { id: "n6", type: "beh:enable", x: 0, y: 100, behaviorOf: "n2", params: {} },
    ],
    edges: [
      { id: "a1", from: { node: "d1", port: 0 }, to: { node: "t1", port: 0 } },
      { id: "e1", from: { node: "n1", port: 0 }, to: { node: "n2", port: 0 } },
      { id: "e2", from: { node: "n2", port: 0 }, to: { node: "n3", port: 0 } },
      { id: "e3", from: { node: "n3", port: 0 }, to: { node: "n4", port: 0 } },
    ],
    // The speaker is the 对象 node's variable, which is a data wire — the same
    // shape `inferGraph` reads as `dialog.say("hi", hero)`.
    dataEdges: [{ id: "w1", from: { node: "n2", port: 0 }, to: { node: "n3", port: 0 } }],
  };

  const code = inferGraph(graph);
  const back = graphFromPamela(code);
  const code2 = inferGraph(back);

  // The second inference keeps the same statements (order-insensitive compare).
  const norm = (s) => s.split("\n").filter(Boolean).sort().join("\n");
  assert.equal(norm(code2), norm(code));
});
