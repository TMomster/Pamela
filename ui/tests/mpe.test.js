// `.mpe` 简写方言测试。
// Tests for the `.mpe` shorthand dialect.

import assert from "node:assert/strict";
import test from "node:test";

import { isMpePath, shorthandCallIn, transpile } from "../mpe.js";
import { run } from "../pamela.js";

/** Compiles one line and answers the result. */
function line(source) {
  return transpile(source);
}

test("mpe：对象调用写成「目标 方法 参数」，台词免引号", () => {
  assert.equal(line("ch scale 2.0 3000"), "ch.scale(2.0, 3000)");
  assert.equal(line("ch say 你好，我是帕梅拉！"), 'ch.say("你好，我是帕梅拉！")');
  assert.equal(line("ch move -100 0 500"), "ch.move(-100, 0, 500)");
  assert.equal(line("ch enable"), "ch.enable()");
  // 中文名原样保留，由解释器的对照表解析。
  assert.equal(line("小帕 缩放 2.0 3000"), "小帕.缩放(2.0, 3000)");
  assert.equal(line("小帕 说 你好，我是帕梅拉！"), '小帕.说("你好，我是帕梅拉！")');
});

test("mpe：带引号的参数原样保留，可多于一个", () => {
  assert.equal(line('ch say "你好" "旁白"'), 'ch.say("你好", "旁白")');
  assert.equal(line("ch say “中文引号”"), "ch.say(“中文引号”)");
  assert.equal(line("ch say '单引号'"), "ch.say('单引号')");
});

test("mpe：花括号参数传表达式，数字与字面量原样", () => {
  assert.equal(line("ch move {x + 1} 0 500"), "ch.move(x + 1, 0, 500)");
  assert.equal(line("ch show true"), "ch.show(true)");
  // 花括号之后就不是自由文本了，后面的词仍按参数读。
  assert.equal(line("ch say {分数} 分"), 'ch.say(分数, "分")');
});

test("mpe：赋值右侧是简写调用时一并编译", () => {
  assert.equal(line("小帕 = 角色 帕梅拉.png"), '小帕 = 角色("帕梅拉.png")');
  assert.equal(line("bg = 背景 教室.png"), 'bg = 背景("教室.png")');
  // 普通赋值原样通过，`==` 不会被认成赋值。
  assert.equal(line("x = 1"), "x = 1");
  assert.equal(line("x == 1"), "x == 1");
  assert.equal(line("x = 角色(\"a.png\")"), 'x = 角色("a.png")');
});

test("mpe：无接收者的内置名按函数调用编译", () => {
  assert.equal(line("背景 教室.png"), '背景("教室.png")');
  assert.equal(line("说 旁白一句。"), '说("旁白一句。")');
  assert.equal(line("转文本 {分数}"), "转文本(分数)");
  // 接收者同名时仍按方法读：dialog 是对象，不是构造器调用。
  assert.equal(line("dialog say 你好"), 'dialog.say("你好")');
});

test("mpe：舞台的批量调用，冒号跳过中间的参数", () => {
  // 舞台替一组对象调用：一行写完原本逐个写的一串。
  assert.equal(line("stage enable ch bg"), "stage.enable(ch, bg)");
  assert.equal(line("舞台 启用 小帕 小白"), "舞台.启用(小帕, 小白)");
  // 省掉接收者，方法名开头的行后面全是对象。
  assert.equal(line("enable ch bg 按钮"), "enable(ch, bg, 按钮)");
  assert.equal(line("隐藏 小帕 小白"), "隐藏(小帕, 小白)");
  // 固定参数在前，对象在后；数字仍是数字。
  assert.equal(line("舞台 缩放 2.0 2000 小帕 小白"), "舞台.缩放(2.0, 2000, 小帕, 小白)");
  // 冒号之前是固定参数，之后全是对象——time 不必占位。
  assert.equal(line("舞台 缩放 2.0 : 小帕 小白"), "舞台.缩放(2.0 : 小帕, 小白)");
  assert.equal(line("stage scale 0.5 : ch"), "stage.scale(0.5 : ch)");
  // 不是批量方法的行不受影响：舞台自己的调用、台词里的冒号都仍。
  assert.equal(line("舞台 说 你好：世界"), '舞台.说("你好：世界")');
  assert.equal(line("ch say : 他说"), 'ch.say(": 他说")');
  assert.equal(line("ch say 你好"), 'ch.say("你好")');
});

test("mpe：参数可以按名字给，位置随之自由", () => {
  // `名字=值` 是一个参数：名字保留，值按普通规则识别。
  assert.equal(line("ch moveTo y=200 x=640 time=500"), "ch.moveTo(y = 200, x = 640, time = 500)");
  assert.equal(line("ch = Character ch.png x=300 y=-500"), 'ch = Character("ch.png", x = 300, y = -500)');
  assert.equal(line("ch = 角色 ch.png 横=300 纵=-500"), 'ch = 角色("ch.png", 横 = 300, 纵 = -500)');
  // 目录用点号写：点不是数字小数点，整段仍是资源名文本。
  assert.equal(line("ch = Character ori.si.png"), 'ch = Character("ori.si.png")');
  assert.equal(
    line("ch = Character a.b.c.png x=300"),
    'ch = Character("a.b.c.png", x = 300)',
  );
  // 等号两侧的空格可有可无，值可以是字面量、引号或表达式。
  assert.equal(line("ch alpha value = 0.5"), "ch.alpha(value = 0.5)");
  assert.equal(line("ch name 姓名=“帕梅拉”"), "ch.name(姓名 = “帕梅拉”)");
  assert.equal(line("ch moveTo x={a + 1}"), "ch.moveTo(x = a + 1)");
  // 未被认作名字的等号仍原样通过：`==` 是表达式里的比较。
  assert.equal(line("x == 1"), "x == 1");
});

test("mpe：注释被去掉，整行注释与完整语法原样通过", () => {
  assert.equal(line("ch say 你好 // 注释"), 'ch.say("你好")');
  assert.equal(line("ch say 你好 /* 注释 */"), 'ch.say("你好")');
  // 行首注释不是语句。
  assert.equal(line("// ch say 你好"), "// ch say 你好");
  assert.equal(line("# 旧写法"), "# 旧写法");
  // 完整语法的行一行都不改写。
  for (const source of [
    "x = 1",
    "x += 2",
    "if hp <= 0 {",
    "}",
    "else {",
    "title()",
    "wait 800",
    'include "a.mpe"',
    "ch.key(\"a.keyframes\")",
    "choice {",
    '  "去学校" {',
  ]) {
    assert.equal(line(source), source);
  }
});

test("mpe：缩进保留，行数不变", () => {
  const source = ["if x {", "  ch say 你好", "}", "", "// 尾注"].join("\n");
  const compiled = transpile(source);
  assert.equal(compiled.split("\n").length, source.split("\n").length);
  assert.equal(compiled.split("\n")[1], '  ch.say("你好")');
});

test("mpe：批量调用编译出来可执行", async () => {
  const calls = [];
  const actor = (name) => ({
    kind: "Character",
    name,
    启用() {
      calls.push([name, "enable"]);
      return this;
    },
    缩放(value, time) {
      calls.push([name, "scale", value, time]);
      return this;
    },
  });
  let count = 0;
  const constructors = {
    角色: () => {
      count += 1;
      return actor(`ch${count}`);
    },
  };

  const source = [
    "小帕 = 角色 帕梅拉.png",
    "小白 = 角色 小白.png",
    "启用 小帕 小白",
    "stage 缩放 2.0 : 小帕 小白",
  ].join("\n");
  const result = await run(transpile(source), {
    constructors,
    globals: { stage: { kind: "Stage" } },
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [
    ["ch1", "enable"],
    ["ch2", "enable"],
    ["ch1", "scale", 2, undefined],
    ["ch2", "scale", 2, undefined],
  ]);
});

test("mpe：后缀判定", () => {
  assert.equal(isMpePath("scripts/a.mpe"), true);
  assert.equal(isMpePath("scripts/A.MPE"), true);
  assert.equal(isMpePath("scripts/a.pe"), false);
  assert.equal(isMpePath("scripts/a.mpe.bak"), false);
  assert.equal(isMpePath(null), false);
});

test("mpe：句点级联，一个方法接着一个方法", () => {
  assert.equal(line("ch scale 2.0 . move 0 -300"), "ch.scale(2.0).move(0, -300)");
  assert.equal(line("小帕 缩放 2.0 . 移动 0 -300"), "小帕.缩放(2.0).移动(0, -300)");
  assert.equal(
    line("ch scale 2.0 . move 0 -300 . blur 200"),
    "ch.scale(2.0).move(0, -300).blur(200)",
  );
  // 不带参数的方法也能接：回值是接收者本身。
  assert.equal(line("ch hide . blur 200"), "ch.hide().blur(200)");
  // 构造出来的对象接着点，赋值照旧。
  assert.equal(line("背景 教室.png . 模糊 200"), '背景("教室.png").模糊(200)');
  assert.equal(line("小帕 = 角色 帕梅拉.png . 缩放 2"), '小帕 = 角色("帕梅拉.png").缩放(2)');
  // 省掉舞台的批量调用回值也是舞台，级联照常；带冒号的批量调用同理。
  assert.equal(line("enable ch bg . blur 200"), "enable(ch, bg).blur(200)");
  assert.equal(line("舞台 模糊 200 : 小帕 小白 . 隐藏"), "舞台.模糊(200 : 小帕, 小白).隐藏()");
});

test("mpe：小数、文件名和台词里的点都不是级联", () => {
  assert.equal(line("ch moveTo 1.5 2.5"), "ch.moveTo(1.5, 2.5)");
  assert.equal(line("背景 教室.png"), '背景("教室.png")');
  // 句点后面不是方法名，就还是台词的一部分。
  assert.equal(line("说 你好 . 世界"), '说("你好 . 世界")');
});

test("mpe：级联调用跑起来就是一路调下去", async () => {
  const calls = [];
  const character = {
    scale(value, time) {
      calls.push(["scale", value, time]);
      return character;
    },
    move(dx, dy) {
      calls.push(["move", dx, dy]);
      return character;
    },
    hide() {
      calls.push(["hide"]);
      return character;
    },
  };
  const constructors = { Character: () => character };

  const result = await run(transpile("ch = Character ch.png . 缩放 2 . 移动 0 -300 . 隐藏"), {
    constructors,
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [["scale", 2, undefined], ["move", 0, -300], ["hide"]]);
});

test("mpe：cue 后面直接接一条级联调用，不必写花括号", () => {
  assert.equal(
    line("cue 3000 ch scale 0.5 . move 0 -300"),
    "cue(3000) ch.scale(0.5).move(0, -300)",
  );
  // 时间已经写在括号里的行照常编译，括号保留。
  assert.equal(
    line("cue(3000) ch scale 0.5 . move 0 -300"),
    "cue(3000) ch.scale(0.5).move(0, -300)",
  );
  // 不带时间也是同一条 cue。
  assert.equal(line("cue ch hide"), "cue ch.hide()");
  assert.equal(line("cue -1 小帕 隐藏"), "cue(-1) 小帕.隐藏()");
  // 行尾的 wait 属于 cue，不会变成最后一个方法的参数。
  assert.equal(line("cue 3000 ch hide wait"), "cue(3000) ch.hide() wait");
  // 缩进与行尾注释照旧。
  assert.equal(line("  cue 200 说 你好 // 旁白"), '  cue(200) 说("你好")');
  // 块写法是完整语法，一行都不改写。
  for (const source of ["cue {", "cue(3000) {", "cue 3000 {"]) {
    assert.equal(line(source), source);
  }
  // 以 cue 开头的名字仍是普通调用，不是关键字。
  assert.equal(line("cuePoint hide"), "cuePoint.hide()");
});

test("mpe：cue 简写行编译出来可执行", async () => {
  const calls = [];
  const character = {
    scale(value, time) {
      calls.push(["scale", value, time]);
      return character;
    },
    move(dx, dy) {
      calls.push(["move", dx, dy]);
      return undefined;
    },
  };
  const result = await run(transpile("ch = Character ch.png\ncue 3000 ch scale 0.5 . move 0 -300"), {
    constructors: { Character: () => character },
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [
    ["scale", 0.5, undefined],
    ["move", 0, -300],
  ]);
});

test("mpe：cue 块逐行编译，块后的 wait 5000 属于 cue", () => {
  for (const closing of ["} wait 5000", "} wait(5000)"]) {
    const source = ["cue {", "  ch scale 2.0 2000", "  ch blur 20 2000", closing].join("\n");
    assert.equal(
      transpile(source),
      ["cue {", "  ch.scale(2.0, 2000)", "  ch.blur(20, 2000)", closing].join("\n"),
    );
  }
  // 带时间的块头也是完整语法，一行都不改写。
  for (const head of ["cue {", "cue(5000) {", "cue 5000 {"]) {
    assert.equal(line(head), head);
  }
  // 块内的行也可以是一条 cue 简写。
  assert.equal(line("  cue ch hide"), "  cue ch.hide()");
});

test("mpe：cue 块里的简写行同时开始，块按 wait 的时间放行", async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const events = [];
  const character = {
    scale(value, time) {
      events.push(["scale", value, time]);
    },
    blur(value, time) {
      events.push(["blur", value, time]);
    },
    say(text) {
      events.push(["say", text]);
    },
  };
  const source = [
    "ch = Character ch.png",
    "cue {",
    "  ch scale 2.0 2000",
    "  ch blur 20 2000",
    "} wait 5000",
    "ch say 结束",
  ].join("\n");

  const running = run(transpile(source), {
    constructors: { Character: () => character },
    sleep,
  });

  await settle();
  assert.deepEqual(events, [
    ["scale", 2, 2000],
    ["blur", 20, 2000],
  ]);
  assert.deepEqual(timers.map((timer) => timer.ms), [5000], "块后的 wait 是一次等待");

  timers[0].resolve();
  for (let i = 0; i < 50 && !events.some((event) => event[0] === "say"); i++) {
    await settle();
  }
  assert.deepEqual(events.at(-1), ["say", "结束"]);

  const result = await running;
  assert.equal(result.error, undefined);
});

test("mpe：纯数字参数后的行尾注释不再被当成字符串", () => {
  assert.equal(line("ch blur 200 // 淡入"), "ch.blur(200)");
});

test("mpe：编译结果可执行", async () => {
  const calls = [];
  const character = {
    启用() {
      calls.push("enable");
      return character;
    },
    缩放(scale, time) {
      calls.push(["scale", scale, time]);
      return character;
    },
    说(text) {
      calls.push(["say", text]);
      return character;
    },
  };
  const constructors = {
    角色: (args) => {
      calls.push(["new", args[0]]);
      return character;
    },
    say: (args) => calls.push(["narrator", args[0]]),
  };

  const source = [
    "小帕 = 角色 帕梅拉.png",
    "小帕 启用",
    "小帕 缩放 2.0 3000",
    "小帕 说 你好，我是帕梅拉！",
    "说 旁白一句",
  ].join("\n");
  const result = await run(transpile(source), { constructors });

  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [
    ["new", "帕梅拉.png"],
    "enable",
    ["scale", 2, 3000],
    ["say", "你好，我是帕梅拉！"],
    ["narrator", "旁白一句"],
  ]);
});

test("mpe：出错时行号仍是作者写的那一行", async () => {
  const source = ["x = 1", "ch 不存在的方法 2", "y = 3"].join("\n");
  const result = await run(transpile(source), { constructors: {} });
  assert.ok(result.error, "expected an error");
  // `ch` 没有绑定，第 2 行就是它。
  assert.equal(result.error.line, 2);
  assert.match(result.error.message, /未定义的变量：ch/);
});

// --- 一条语句的各部分在哪里 ---
//
// 拖动资源时要用这些偏移量改写那一行，所以它们指向的是 `line` 本身，而不是
// 去掉缩进、注释之后的某段文本。

test("mpe：一条内置语句的名字与参数", () => {
  const call = shorthandCallIn("背景 教室.png");
  assert.equal(call.head, "背景");
  assert.equal(call.verb, "");
  assert.equal(call.name, "背景");
  assert.equal(call.nameStart, 0);
  assert.equal(call.nameEnd, 2);
  assert.equal(call.args, "教室.png");
  assert.equal(call.argsStart, 3);
  assert.equal(call.argsEnd, 9);
  assert.equal(call.comment, "");
});

test("mpe：只写了名字，参数为空", () => {
  const call = shorthandCallIn("背景");
  assert.equal(call.args, "");
  assert.equal(call.argsStart, call.nameEnd);
  assert.equal(call.argsEnd, call.nameEnd);
  assert.equal(call.comment, "");
});

test("mpe：方法写法，缩进算在偏移里", () => {
  const call = shorthandCallIn("  小帕 动画 小帕.keyframes");
  assert.equal(call.indent, "  ");
  assert.equal(call.head, "小帕");
  assert.equal(call.verb, "动画");
  assert.equal(call.name, "小帕 动画");
  assert.equal(call.nameStart, 2);
  assert.equal(call.nameEnd, 7);
  assert.equal(call.args, "小帕.keyframes");
  assert.equal(call.argsStart, 8);
  assert.equal(call.argsEnd, 20);
});

test("mpe：赋值写法，调用在等号右边", () => {
  const call = shorthandCallIn("小帕 = 角色 帕梅拉.png");
  assert.equal(call.assignee, "小帕");
  assert.equal(call.head, "角色");
  assert.equal(call.nameStart, 5);
  assert.equal(call.nameEnd, 7);
  assert.equal(call.args, "帕梅拉.png");
  assert.equal(call.argsStart, 8);
});

test("mpe：行尾注释放进 comment，引号里的不判定为", () => {
  const commented = shorthandCallIn("音频 风.mp3 // 循环");
  assert.equal(commented.args, "风.mp3");
  assert.equal(commented.argsEnd, 8);
  assert.equal(commented.comment, "// 循环");

  const quoted = shorthandCallIn('音频 "风 // 循环.mp3"');
  assert.equal(quoted.comment, "");
});

test("mpe：不重写的行答 null", () => {
  const lines = [
    "",
    "   ",
    "// 背景 x.png",
    "# 背景",
    "wait 800",
    "x = 1",
    "小帕",
    'ch.key("a.keyframes")',
    "小帕 说 {",
  ];
  for (const line of lines) {
    assert.equal(shorthandCallIn(line), null, JSON.stringify(line));
  }
});

test("mpe：答出的调用名与编译出来的那个一致", () => {
  for (const line of [
    "背景 教室.png",
    "小帕 动画 小帕.keyframes",
    "小帕 = 角色 帕梅拉.png",
    "音频 风.mp3 // 循环",
  ]) {
    const call = shorthandCallIn(line);
    const called = call.verb ? `${call.head}.${call.verb}` : call.head;
    assert.ok(transpile(line).includes(`${called}(`), `${line} → 编译里应有 ${called}(`);
  }
});

test("mpe：省掉 stage 的批量调用，头一个词就是调用名", () => {
  const call = shorthandCallIn("enable ch bg");
  assert.equal(call.head, "enable");
  assert.equal(call.verb, "", "ch 是第一个对象，不是 enable 的方法");
  assert.equal(call.name, "enable");
  assert.equal(call.nameStart, 0);
  assert.equal(call.nameEnd, 6);
  assert.equal(call.args, "ch bg");
  assert.equal(call.argsStart, 7);

  const chinese = shorthandCallIn("隐藏 小帕 小白");
  assert.equal(chinese.head, "隐藏");
  assert.equal(chinese.verb, "");
  assert.equal(chinese.args, "小帕 小白");

  // 第一个参数不是名字也仍是批量调用（`scale 2.0 300`）。
  const numeric = shorthandCallIn("scale 2.0 300");
  assert.equal(numeric.name, "scale");
  assert.equal(numeric.args, "2.0 300");

  // 带 stage 的写法仍按「接收者 方法」读。
  const withStage = shorthandCallIn("stage enable ch bg");
  assert.equal(withStage.verb, "enable");
  assert.equal(withStage.name, "stage enable");
  assert.equal(withStage.args, "ch bg");
});

test("mpe：级联行标出第一次调用在哪儿结束", () => {
  const call = shorthandCallIn("背景 教室.png . 模糊 200 // 夜景");
  // `args` 仍是这一行整段参数：高亮要照着它上色。
  assert.equal(call.args, "教室.png . 模糊 200");
  // 第一次调用的参数到句点之前为止：拖进来的名字替换的是这一段。
  assert.equal(call.args.slice(0, call.firstArgsEnd - call.argsStart), "教室.png");
  assert.equal(call.comment, "// 夜景");
  // 没有级联时，两者是同一个位置。
  const plain = shorthandCallIn("背景 教室.png");
  assert.equal(plain.firstArgsEnd, plain.argsEnd);
});

test("mpe：对象组的参数按对象名读，不按台词读", () => {
  // 建组：`Array a b c` 的三个词都是对象名。
  assert.equal(transpile("ay1 = Array ch1 ch2 bg1"), "ay1 = Array(ch1, ch2, bg1)");
  assert.equal(transpile("对象组 ch1 ch2"), "对象组(ch1, ch2)");
  // 增删：组的 add / del 之后同样是对象名。
  assert.equal(transpile("ay1 add ch3 ch4"), "ay1.add(ch3, ch4)");
  assert.equal(transpile("ay1 删除 ch2"), "ay1.删除(ch2)");
  // 批量调用照旧：冒号之后是对象，而组本身就是其中一个。
  assert.equal(transpile("舞台 模糊 200 : ay1"), "舞台.模糊(200 : ay1)");
  assert.equal(transpile("stage blur 200 : ay1"), "stage.blur(200 : ay1)");
});

test("mpe：组的调用在 shorthandCallIn 里也标成「参数是名字」", () => {
  for (const line of [
    "ay1 = Array ch1 ch2",
    "Array ch1 ch2",
    "ay1 add ch3",
    "stage enable ch bg",
    "enable ch bg",
  ]) {
    assert.equal(shorthandCallIn(line).names, true, line);
  }
  // 参数是值的行仍按值读：台词、文件名、数字。
  for (const line of ["背景 教室.png", "小帕 说 你好", "小帕 缩放 2.0 3000"]) {
    assert.equal(shorthandCallIn(line).names, false, line);
  }
});
