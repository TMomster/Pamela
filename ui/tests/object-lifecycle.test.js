// enable / disable 的时间参数、del 语句与 autoModify 的预处理。
import assert from "node:assert/strict";
import test from "node:test";

import {
  OBJECT_DESTROY,
  run,
  scanDebugCommands,
} from "../pamela.js";
import { createStageObjects } from "../stage.js";

/** 只记录调用的对象替身，用来核对解释器有没有跳过/销毁。 */
function mockActor(kind = "Character") {
  const calls = [];
  const actor = {
    kind,
    active: false,
    destroyed: false,
    enable(...args) {
      calls.push({ method: "enable", args });
      this.active = true;
      return this;
    },
    disable(...args) {
      calls.push({ method: "disable", args });
      this.active = false;
      return this;
    },
    move(...args) {
      calls.push({ method: "move", args });
      return this;
    },
    scale(...args) {
      calls.push({ method: "scale", args });
      return this;
    },
    [OBJECT_DESTROY]() {
      calls.push({ method: "destroy" });
      this.destroyed = true;
    },
  };
  return { actor, calls };
}

function minimalStage() {
  const fades = [];
  return {
    fades,
    setBackground() {},
    setCharacter() {},
    moveCharacter() {},
    transformCharacter() {},
    setCharacterAlpha(slot, value, time) {
      fades.push({ slot, value, time });
    },
    applyTint() {},
    applyLook() {},
    releaseCharacter() {},
    setText() {},
    releaseText() {},
    removeLight() {},
    animateLight() {},
    deactivateCamera() {},
  };
}

test("新增的三条 debug 开关都能在开演前被扫描到", () => {
  const found = scanDebugCommands(
    [
      "# debug::com.enable.autoShow=0",
      "# debug::com.enable.autoShow=1",
      "# debug::com.player.autoModify",
    ].join("\n"),
  );
  assert.equal(found.length, 3);
  assert.ok(found.every((command) => command.known));
  assert.equal(found[0].autoShow, false);
  assert.equal(found[1].autoShow, true);
  assert.equal(found[2].command, "autoModify");
  assert.equal(found[2].setting, true);
});

test("enable / disable 接受时间参数与 @ 时长", async () => {
  const { actor, calls } = mockActor();
  const result = await run(
    'ch = Character("hero.png")\nch.enable() @ 3000\nch.disable(1200)',
    { constructors: { Character: () => actor } },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.deepEqual(calls, [
    { method: "enable", args: [3000] },
    { method: "disable", args: [1200] },
  ]);
});

test("del 语句销毁对象并解开变量名", async () => {
  const { actor, calls } = mockActor();
  const result = await run(
    'ch = Character("hero.png")\ndel ch\nch.enable()',
    { constructors: { Character: () => actor } },
  );
  assert.equal(actor.destroyed, true);
  assert.deepEqual(calls, [{ method: "destroy" }]);
  assert.match(result.error?.message ?? "", /未定义的变量：ch/);
});

test("autoModify 跳过失活对象之后的无效调用，并在终结处释放", async () => {
  const { actor, calls } = mockActor();
  const result = await run(
    [
      'ch = Character("hero.png")',
      "ch.enable()",
      "ch.disable()",
      "ch.move(10)",
      "ch.scale(2) @ 5000",
    ].join("\n"),
    { autoModify: true, constructors: { Character: () => actor } },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.deepEqual(calls, [
    { method: "enable", args: [] },
    { method: "disable", args: [] },
    { method: "destroy" },
  ]);
});

test("disable 之后又 enable，中间的调用依然有效", async () => {
  const { actor, calls } = mockActor();
  const result = await run(
    [
      'ch = Character("hero.png")',
      "ch.enable()",
      "ch.disable()",
      "ch.move(10)",
      "ch.enable()",
    ].join("\n"),
    { autoModify: true, constructors: { Character: () => actor } },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(calls.filter((call) => call.method === "move").length, 1);
  assert.equal(calls.filter((call) => call.method === "destroy").length, 0);
});

test("autoModify 不会剪掉夹着普通调用的语句", async () => {
  const { actor } = mockActor();
  actor.name = () => "小帕";
  let noted = null;
  const result = await run(
    [
      'ch = Character("hero.png")',
      "ch.enable()",
      "ch.disable()",
      "note(ch.name())",
    ].join("\n"),
    {
      autoModify: true,
      constructors: { Character: () => actor },
      globals: { stage: { note: (name) => { noted = name; } } },
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(noted, "小帕", "读失活对象属性的普通语句仍要执行");
});

test("autoModify 遇到分支时保守放弃优化", async () => {
  const { actor, calls } = mockActor();
  const result = await run(
    [
      'ch = Character("hero.png")',
      "ch.enable()",
      "ch.disable()",
      "if true { ch.enable() }",
      "ch.move(10)",
    ].join("\n"),
    { autoModify: true, constructors: { Character: () => actor } },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(calls.filter((call) => call.method === "move").length, 1);
});

test("enable 自带渐显；autoShow 关闭后只有 show 才让对象露面", async () => {
  const stage = minimalStage();
  const result = await run(
    'ch = Character("hero.png")\nch.enable(1500)\nch.show(200)',
    { autoShow: false, constructors: createStageObjects(stage) },
  );
  assert.equal(result.error, undefined, result.error?.message);
  // enable 只写下透明度 0；autoShow=0 时没有那次淡到 1。
  assert.equal(stage.fades[0].value, 0);
  assert.equal(stage.fades.some((fade) => fade.value === 1 && fade.time === 1500), false);
  assert.equal(stage.fades.at(-1).value, 1);
  assert.equal(stage.fades.at(-1).time, 200);
});

test("图片解码迟到时，已经被 hide 的对象不会被入场动画重新点亮", async () => {
  let reveal;
  const ready = new Promise((resolve) => { reveal = resolve; });
  const stage = minimalStage();
  stage.setCharacter = () => ready;
  const objects = createStageObjects(stage);
  const context = { assignee: "ch", pending: [] };
  const ch = objects.Character(["hero.png"], context);

  ch.enable(0);
  ch.hide(0);
  reveal();
  await Promise.all(context.pending.splice(0));

  assert.equal(stage.fades.some((fade) => fade.value === 1), false);
  assert.equal(stage.fades.at(-1).value, 0);
});

test("图片解码迟到但没有后续操作时，enable 的入场仍然执行", async () => {
  let reveal;
  const ready = new Promise((resolve) => { reveal = resolve; });
  const stage = minimalStage();
  stage.setCharacter = () => ready;
  const objects = createStageObjects(stage);
  const context = { assignee: "ch", pending: [] };
  const ch = objects.Character(["hero.png"], context);

  ch.enable(0);
  reveal();
  await Promise.all(context.pending.splice(0));

  assert.equal(stage.fades.at(-1).value, 1);
});

test("对象初始为失活，disable 后 show 不能把它带回画面", async () => {
  const stage = minimalStage();
  const objects = createStageObjects(stage);
  const ch = objects.Character(["hero.png"], { assignee: "ch", pending: [] });
  assert.equal(ch.active, false);
  ch.show(200);
  assert.equal(stage.fades.length, 0, "失活对象即使写了 show 也不画到舞台上");
  ch.enable(300);
  ch.disable();
  assert.equal(ch.active, false);
  ch.show(100);
  assert.equal(stage.fades.at(-1).value, 0, "disable 后 show 只改属性，不露面");
});
