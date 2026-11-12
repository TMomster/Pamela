// 中文剧本编写测试。
// Tests for writing Pamela in Chinese.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BUILTIN_ALIASES,
  BUILTIN_GLOBALS,
  BUILTIN_METHODS,
  englishNameFor,
  run,
  tokenize,
} from "../pamela.js";

const ROOT = new URL("../", import.meta.url);

/** Types and values of a clean token list. */
function tokensOf(source) {
  const scanned = tokenize(source);
  assert.equal(scanned.error, undefined, "expected a clean scan");
  return scanned.tokens
    .filter((token) => token.type !== "newline" && token.type !== "eof")
    .map((token) => `${token.type}:${token.value}`);
}

/** A constructor that records what a script did to it. */
function recording(name, calls) {
  const object = {
    [name]: true,
    enable() {
      calls.push([name, "enable"]);
      return object;
    },
    say(text) {
      calls.push([name, "say", text]);
      return object;
    },
    scale(value, time) {
      calls.push([name, "scale", value, time]);
      return object;
    },
    move(dx, dy, dz, time) {
      calls.push([name, "move", dx, dy, time]);
      return object;
    },
    transform: {
      upleft(dx, dy, time) {
        calls.push([name, "upleft", dx, dy, time]);
        return object;
      },
    },
  };
  return object;
}

test("中文标点：逗号与括号按英文符号解析", () => {
  assert.deepEqual(tokensOf("小帕.缩放（2.0，3000）"), [
    "ident:小帕",
    "punct:.",
    "ident:缩放",
    "punct:(",
    "number:2",
    "punct:,",
    "number:3000",
    "punct:)",
  ]);
  // 分号与冒号同样按对应 ASCII 记号解析。
  assert.deepEqual(tokensOf("x = 1；y = 2"), [
    "ident:x",
    "punct:=",
    "number:1",
    "punct:;",
    "ident:y",
    "punct:=",
    "number:2",
  ]);
});

test("中文引号：成对使用，内容原样保留", () => {
  assert.deepEqual(tokensOf("对话框.说（“你好，世界”）"), [
    "ident:对话框",
    "punct:.",
    "ident:说",
    "punct:(",
    "string:你好，世界",
    "punct:)",
  ]);
  // 单引号同样可以。
  assert.deepEqual(tokensOf("说（‘单引号’）"), [
    "ident:说",
    "punct:(",
    "string:单引号",
    "punct:)",
  ]);
});

test("字符串里的中文标点不受影响", () => {
  assert.deepEqual(tokensOf('say("（全角），逗号")'), [
    "ident:say",
    "punct:(",
    "string:（全角），逗号",
    "punct:)",
  ]);
  // 英文引号串里出现的中文引号也只是文字。
  assert.deepEqual(tokensOf('say("他说“好”")'), [
    "ident:say",
    "punct:(",
    "string:他说“好”",
    "punct:)",
  ]);
});

test("中文标识符：变量、函数与参数都能用中文命名", async () => {
  const result = await run(
    ['分数 = 3', 'func 增加(数量) {', '  分数 += 数量', '}', '增加(4)', "x = 分数"].join("\n"),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.value, 7);
});

test("中文方法名：与英文名作用相同", async () => {
  const calls = [];
  const constructors = { 角色: (args) => recording(`角色:${args[0]}`, calls) };
  const result = await run(
    ['小帕 = 角色("帕梅拉.png")', "小帕.启用（）", "小帕.缩放（2.0，3000）", "小帕.说（“你好”）"].join("\n"),
    { constructors },
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [
    ["角色:帕梅拉.png", "enable"],
    ["角色:帕梅拉.png", "scale", 2, 3000],
    ["角色:帕梅拉.png", "say", "你好"],
  ]);
});

test("中文参数名：横、纵与英文的 x、y 落在同一个位置", async () => {
  const calls = [];
  const constructors = {
    角色: (args) => {
      calls.push(args);
      return recording(`角色:${args[0]}`, calls);
    },
  };
  const result = await run('小帕 = 角色("帕梅拉.png", 横 = 300, 纵 = -500)', {
    constructors,
  });
  assert.equal(result.error, undefined);
  // The slots the names stand for are filled: this is what
  // `Character("…", x = …, y = …)` becomes after the two spellings are resolved.
  assert.equal(calls[0][0], "帕梅拉.png");
  assert.equal(calls[0][1], 300, "横 是 x");
  assert.equal(calls[0][2], -500, "纵 是 y");
});

test("中文参数名：创建对象时没有相对偏移", async () => {
  // A new object is already at the origin, so 横移 / 纵移 同 xTo / yTo 一起取消。
  const calls = [];
  const constructors = { 角色: (args) => recording(`角色:${args[0]}`, calls) };
  const result = await run('小帕 = 角色("帕梅拉.png", 横移 = 300)', { constructors });
  assert.ok(result.error, "横移 不是构造参数");
  assert.match(result.error.message, /横移/);
});

test("中文参数名：方法参数同样可用", async () => {
  const calls = [];
  const constructors = { 角色: (args) => recording(`角色:${args[0]}`, calls) };
  const result = await run('小帕 = 角色("a.png")\n小帕.移动（横向 = 10，纵向 = 20，时间 = 300）', {
    constructors,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [["角色:a.png", "move", 10, 20, 300]]);
});

test("中文成员：自由变换的八个点也能用中文读", async () => {
  const calls = [];
  const constructors = { 角色: (args) => recording(`角色:${args[0]}`, calls) };
  const result = await run('小帕 = 角色("a.png")\n小帕.变换.左上（10，20，300）', {
    constructors,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [["角色:a.png", "upleft", 10, 20, 300]]);
});

test("中文内置名：无接收者的调用按英文名解析", async () => {
  const calls = [];
  const globals = {
    对话框: {
      say: (text) => calls.push(["dialog", text]),
    },
  };
  const result = await run('对话框.说（“一行”）\n说（“旁白”）', {
    globals,
    constructors: {
      say: (args) => calls.push(["say", args[0]]),
    },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [
    ["dialog", "一行"],
    ["say", "旁白"],
  ]);
});

test("中文名是回退：脚本自己绑定的名字优先", async () => {
  // `说` 被绑成数字之后，读到的就是它；内置的旁白不再覆盖。
  const result = await run('说 = 1\nx = 说');
  assert.equal(result.error, undefined);
  assert.equal(result.value, 1);
  // 函数也一样。
  const own = await run('func 说(值) {\n  return "自己的"\n}\nx = 说("hi")');
  assert.equal(own.error, undefined);
  assert.equal(own.value, "自己的");
});

test("报错保留作者写的词，不翻译成英文", async () => {
  const calls = [];
  const result = await run('x = 1\nx.跳（3）', {
    constructors: { 角色: (args) => recording(`角色:${args[0]}`, calls) },
  });
  assert.ok(result.error);
  assert.match(result.error.message, /没有方法 跳/);
});

test("内置名对照表：值唯一，且每个目标仍是真实的内置名", () => {
  const sources = ["stage.js", "audio.js", "pamela.js"]
    .map((name) => readFileSync(new URL(name, ROOT), "utf8"))
    .join("\n");

  const seen = new Set();
  for (const [chinese, english] of BUILTIN_ALIASES) {
    assert.ok(chinese && english, "别名不能为空");
    assert.equal(seen.has(chinese), false, `中文名重复：${chinese}`);
    seen.add(chinese);

    // 自由变换的绝对写法是运行时拼出来的（`${name}To`），所以按名字根检查。
    const base = english.endsWith("To") ? english.slice(0, -2) : english;
    assert.match(
      sources,
      new RegExp(`\\b${base}\\b`),
      `别名 ${chinese}→${english} 指向了不存在的内置名`,
    );
  }

  // 英文名本身查询后仍是自己。
  assert.equal(englishNameFor("scale"), "scale");
  assert.equal(englishNameFor("缩放"), "scale");
  assert.equal(BUILTIN_METHODS.has("scale"), true);
  assert.equal(BUILTIN_GLOBALS.has("Character"), true);
});
