// 编辑器辅助功能执行的剧本行编辑测试。
// Tests for the script-line edits the editor's helpers perform in

import assert from "node:assert/strict";
import test from "node:test";

import {
  callAtColumn,
  dropArgumentAt,
  fillImageArg,
  fillTintLine,
  findImageDropLine,
  findTintLines,
  mpeDropTargetAt,
  mpeFillDropAt,
} from "../editor-extras.js";
import { transpile } from "../mpe.js";

test("findTintLines marks rgbTo and hex lines, not rgb", () => {
  const text = [
    "bg = Background(\"bg.png\")",
    "bg.rgbTo(255, 0, 0, 0)",
    "bg.hex(\"fff\", 0)",
    "bg.rgb(10, 10, 10, 0)",
    "hero.say(\"哈\")",
  ].join("\n");
  const found = findTintLines(text);
  assert.deepEqual(
    found.map((line) => ({ index: line.index, kind: line.kind })),
    [
      { index: 1, kind: "rgbTo" },
      { index: 2, kind: "hex" },
    ],
  );
});

test("findTintLines reads the colour already named back from the call", () => {
  const found = findTintLines("bg.rgbTo(255, 128, 0, 0)\nbg.hex(\"abcdef\", 0)");
  assert.equal(found[0].hex, "FF8000");
  assert.equal(found[1].hex, "ABCDEF");
  // A colour that cannot be parsed yet is reported as null, not a crash.
  const partial = findTintLines("bg.rgbTo(?, ?, ?, 0)");
  assert.equal(partial[0].hex, null);
});

test("fillTintLine rewrites a rgbTo call to the picked colour, keeping the time", () => {
  assert.equal(fillTintLine("bg.rgbTo(10, 20, 30, 2000)", "FF0000"), "bg.rgbTo(255, 0, 0, 2000)");
  assert.equal(fillTintLine("bg.rgbTo(1, 2, 3, 0)", "010203"), "bg.rgbTo(1, 2, 3, 0)");
});

test("fillTintLine rewrites a hex call to the picked colour, quoting it", () => {
  assert.equal(fillTintLine('bg.hex("fff", 0)', "FF0000"), 'bg.hex("FF0000", 0)');
  assert.equal(fillTintLine("bg.hex(abcdef, 0)", "ABCDEF"), 'bg.hex("ABCDEF", 0)');
});

test("fillTintLine returns an untouched line when no colour call is there", () => {
  const line = "bg.rgb(10, 10, 10, 0)";
  assert.equal(fillTintLine(line, "FF0000"), line);
});

test("findImageDropLine accepts an empty or empty-string argument", () => {
  assert.equal(findImageDropLine("Character()", 0), true);
  assert.equal(findImageDropLine('Character("")', 0), true);
});

test("findImageDropLine rejects a call that already names a path", () => {
  assert.equal(findImageDropLine('Character("hero.png")', 0), false);
  assert.equal(findImageDropLine('Background("bg.png")', 0), false);
  // A subfolder path is still a path, so the line is not fillable.
  assert.equal(findImageDropLine('Character("sub/folder.png")', 0), false);
});

test("findImageDropLine only matches Background and Character lines", () => {
  assert.equal(findImageDropLine('hero.say("hi")', 0), false);
  // A line index past the end of the text is not a drop target.
  assert.equal(findImageDropLine("Character()", 5), false);
});

test("fillImageArg drops a path into an empty argument", () => {
  assert.equal(fillImageArg("Character()", "hero.png"), 'Character("hero.png")');
  assert.equal(fillImageArg('Character("")', "hero.png"), 'Character("hero.png")');
  assert.equal(fillImageArg("Background()", "bg.png"), 'Background("bg.png")');
});

test("fillImageArg keeps a subfolder path as written, with forward slashes", () => {
  assert.equal(
    fillImageArg("Character()", "subfolder/file.png"),
    'Character("subfolder/file.png")',
  );
  assert.equal(
    fillImageArg("Character()", "sub\\folder\\file.png"),
    'Character("sub/folder/file.png")',
  );
});

test("fillImageArg leaves a call that already has a path untouched", () => {
  const line = 'Character("hero.png")';
  assert.equal(fillImageArg(line, "other.png"), line);
});

// --- 拖文件到函数上 ---

test("callAtColumn 把整个调用当成目标，不只是括号内", () => {
  const line = 'hero.say("hi")';
  // 函数名、参数、右括号都算；光标在名字上也能命中。
  assert.ok(callAtColumn(line, 0), "按在名字最左边");
  assert.ok(callAtColumn(line, 6), "按在括号里");
  assert.ok(callAtColumn(line, 11), "按在右括号上");
  // 左边留 2 个字符的余量。
  assert.ok(callAtColumn("   func()", 2), "名字左边两个字符");
  assert.equal(callAtColumn("   func()", 0), null, "再远不判定为");
  assert.equal(callAtColumn("x = 1", 2), null, "不是调用");
});

test("callAtColumn 取指针下最内层的那个调用", () => {
  const line = "wrapper(inner(x))";
  const hit = callAtColumn(line, 12);
  assert.equal(hit.start, 8, "命中的是 inner");
});

test("callAtColumn 不把字符串里的括号当成结尾", () => {
  const line = 'func("a)b", 1)';
  const hit = callAtColumn(line, 3);
  assert.equal(hit.end, line.lastIndexOf(")"), "结尾是真正的右括号");
});

test("dropArgumentAt：空参数列表补第一个参数", () => {
  assert.equal(dropArgumentAt("func()", 2, "ch.png"), 'func("ch.png")');
  assert.equal(dropArgumentAt("func(  )", 2, "ch.png"), 'func("ch.png")');
  // 空的引号对是"还没有值"，名字替换它而不是追加。
  assert.equal(dropArgumentAt('Character("")', 12, "ch.png"), 'Character("ch.png")');
});

test("dropArgumentAt：已有参数就追加到后面", () => {
  assert.equal(dropArgumentAt("func(a)", 5, "ch.png"), 'func(a, "ch.png")');
  assert.equal(dropArgumentAt("hero.say(1, 2)", 4, "ch.png"), 'hero.say(1, 2, "ch.png")');
  assert.equal(dropArgumentAt('say("hi")', 4, "ch.png"), 'say("hi", "ch.png")');
});

test("dropArgumentAt：没写完的调用会被补上右括号", () => {
  assert.equal(dropArgumentAt("func(", 4, "ch.png"), 'func("ch.png")');
  assert.equal(dropArgumentAt("func(a,", 5, "ch.png"), 'func(a, "ch.png")');
});

test("dropArgumentAt：名字里的引号会被转义", () => {
  assert.equal(dropArgumentAt("func()", 2, 'a"b.png'), 'func("a\\"b.png")');
});

test("dropArgumentAt：单字符串函数已有值就整体替换", () => {
  // Background / Character / Audio / key 仅接受一个字符串，拖入直接覆盖旧值。
  assert.equal(dropArgumentAt('Background("old.png")', 12, "new.png"), 'Background("new.png")');
  assert.equal(dropArgumentAt('Character("old.png")', 12, "new.png"), 'Character("new.png")');
  assert.equal(dropArgumentAt('Audio("old.mp3")', 8, "new.mp3"), 'Audio("new.mp3")');
  assert.equal(dropArgumentAt('key("old")', 6, "new"), 'key("new")');
  // 半写未闭合也补成完整调用。
  assert.equal(dropArgumentAt('Character("old', 12, "new.png"), 'Character("new.png")');
  // 空值仍是替换成带名调用（与旧行为一致）。
  assert.equal(dropArgumentAt('Background()', 10, "new.png"), 'Background("new.png")');
});

test("dropArgumentAt：非单字符串函数仍追加参数", () => {
  assert.equal(dropArgumentAt('say("hi")', 4, "ch.png"), 'say("hi", "ch.png")');
  assert.equal(dropArgumentAt("func(a)", 5, "ch.png"), 'func(a, "ch.png")');
});

test("dropArgumentAt：不在调用上就返回 null", () => {
  assert.equal(dropArgumentAt("x = 1", 2, "ch.png"), null);
  assert.equal(dropArgumentAt("", 0, "ch.png"), null);
  assert.equal(dropArgumentAt("func()", 2, ""), null);
});

test("dropArgumentAt：存储于对象上的 key 也是单字符串", () => {
  // `key` 命名一个文件，无论动画存储于哪个对象上；追加第二个参数就是另一个调用了。
  assert.equal(dropArgumentAt('ch.key("old.keyframes")', 3, "new.keyframes"), 'ch.key("new.keyframes")');
  assert.equal(dropArgumentAt("ch.key()", 3, "new.keyframes"), 'ch.key("new.keyframes")');
});

// --- 拖文件到简写语句上 ---

test("mpeFillDropAt：没有参数就写上，已有的名字直接换掉", () => {
  assert.equal(mpeFillDropAt("背景", 0, "教室.png"), "背景 教室.png");
  assert.equal(mpeFillDropAt("背景 ", 0, "教室.png"), "背景 教室.png");
  assert.equal(mpeFillDropAt("角色 旧.png", 0, "新.png"), "角色 新.png");
  assert.equal(mpeFillDropAt("音频 旧.mp3", 0, "新.mp3"), "音频 新.mp3");
  // 中文名与英文名都支持识别。
  assert.equal(mpeFillDropAt("Character 旧.png", 0, "新.png"), "Character 新.png");
  // 引号、花括号里已经写了值，仍为替换。
  assert.equal(mpeFillDropAt('音频 "旧.mp3"', 0, "新.mp3"), "音频 新.mp3");
  assert.equal(mpeFillDropAt("背景 {bgName}", 0, "教室.png"), "背景 教室.png");
});

test("mpeFillDropAt：方法写法与赋值写法都保得住", () => {
  assert.equal(
    mpeFillDropAt("小帕 动画 旧.keyframes", 3, "新.keyframes"),
    "小帕 动画 新.keyframes",
  );
  assert.equal(mpeFillDropAt("小帕 动画", 3, "新.keyframes"), "小帕 动画 新.keyframes");
  assert.equal(
    mpeFillDropAt("小帕 = 角色 旧.png", 0, "新.png"),
    "小帕 = 角色 新.png",
  );
  assert.equal(mpeFillDropAt("  背景 旧.png", 2, "新.png"), "  背景 新.png");
});

test("mpeFillDropAt：行尾注释留在原处", () => {
  assert.equal(mpeFillDropAt("背景 旧.png // 夜景", 0, "新.png"), "背景 新.png // 夜景");
  assert.equal(mpeFillDropAt("音频 旧.mp3 // 循环", 0, "新.mp3"), "音频 新.mp3 // 循环");
});

test("mpeFillDropAt：只有那四个单资源调用是目标", () => {
  // 简写没有「追加一个参数」的写法，其它调用不该被改。
  assert.equal(mpeFillDropAt("小帕 说 你好", 3, "a.png"), null);
  assert.equal(mpeFillDropAt("小帕 移动 100 0 800", 3, "a.png"), null);
  assert.equal(mpeFillDropAt("x = 1", 2, "a.png"), null);
  assert.equal(mpeFillDropAt("// 背景 旧.png", 5, "a.png"), null);
  assert.equal(mpeFillDropAt("背景 旧.png", 40, "a.png"), null, "指针不在语句上");
  assert.equal(mpeFillDropAt("背景", 0, ""), null);
});

test("mpeDropTargetAt：整条语句是目标，行尾之后不判定为", () => {
  const line = "背景 教室.png";
  const whole = { start: 0, end: line.length - 1 };
  assert.deepEqual(mpeDropTargetAt(line, 0), whole);
  assert.deepEqual(mpeDropTargetAt(line, 5), whole);
  assert.deepEqual(mpeDropTargetAt(line, line.length - 1), whole);
  assert.equal(mpeDropTargetAt(line, line.length), null, "行尾之后");
  // 赋值写法里，等号左边的接收者也在这一行之内。
  const assigned = "小帕 = 角色 旧.png";
  assert.deepEqual(mpeDropTargetAt(assigned, 0), { start: 0, end: assigned.length - 1 });
  // 缩进之后算起，缩进左边留两个字符的余量，与括号调用一致。
  assert.deepEqual(mpeDropTargetAt("  背景 教室.png", 2), { start: 2, end: 10 });
  assert.deepEqual(mpeDropTargetAt("  背景 教室.png", 0), { start: 2, end: 10 });
  assert.equal(mpeDropTargetAt("    背景 教室.png", 0), null);
});

test("mpe：填进去的名字编译后正好是这个调用的参数", () => {
  // 两条路结果一致：改写后的那一行，编译出来就是 `.pe` 的同一个调用。
  assert.equal(transpile(mpeFillDropAt("背景", 0, "教室.png")), '背景("教室.png")');
  assert.equal(
    transpile(mpeFillDropAt("小帕 = 角色 旧.png", 0, "新.png")),
    '小帕 = 角色("新.png")',
  );
  assert.equal(
    transpile(mpeFillDropAt("小帕 动画", 3, "小帕.keyframes")),
    '小帕.动画("小帕.keyframes")',
  );
});

test("mpe：级联行上拖资源，只替换它自己的那个名字", () => {
  // 句点之后是作者写的调用，不归这个资源管。
  assert.equal(mpeFillDropAt("背景 教室.png . 模糊 200", 5, "夜晚.png"), "背景 夜晚.png . 模糊 200");
  assert.equal(
    transpile(mpeFillDropAt("背景 教室.png . 模糊 200", 5, "夜晚.png")),
    '背景("夜晚.png").模糊(200)',
  );
});
