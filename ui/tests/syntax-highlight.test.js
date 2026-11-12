import test from "node:test";
import assert from "node:assert/strict";
import { highlightMpe, highlightPamela } from "../syntax-highlight.js";

// 语法高亮测试。
/** The source a highlighted copy must still be, once the markup is stripped. */
// 移除高亮标记并反转义后，剩余文本必须等于源文本。
function unmarked(html) {
  return html
    .replace(/<span class="[^"]*">/g, "")
    .replace(/<\/span>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("keywords are wrapped in the keyword class", () => {
  const html = highlightPamela("if x == 1 { }");
  assert.match(html, /<span class="tok-keyword">if<\/span>/);
});

test("strings keep their quotes and get the string class", () => {
  const html = highlightPamela('say "hello"');
  assert.match(html, /<span class="tok-string">"hello"<\/span>/);
});

test("numbers get the number class", () => {
  const html = highlightPamela("x = 42");
  assert.match(html, /<span class="tok-number">42<\/span>/);
});

test("line comments get the comment class", () => {
  const html = highlightPamela("# a note\nx = 1");
  assert.match(html, /<span class="tok-comment"># a note<\/span>/);
});

test("block comments get the comment class", () => {
  const html = highlightPamela("/* hold */ x = 1");
  assert.match(html, /<span class="tok-comment">\/\* hold \*\/<\/span>/);
});

test("plain identifiers are not coloured as keywords", () => {
  const html = highlightPamela("hero = Character(\"a\")");
  assert.doesNotMatch(html, /tok-keyword/);
  assert.match(html, /Character/);
});

test("angle brackets are escaped, never injected as raw tags", () => {
  const html = highlightPamela("x < y");
  assert.match(html, /&lt;/);
  assert.doesNotMatch(html, /<span[^>]*><\/span>/);
});

test("operators get the operator class", () => {
  const html = highlightPamela("a + b");
  assert.match(html, /<span class="tok-operator">\+<\/span>/);
});

test("an unterminated string falls back to escaped plain text", () => {
  const html = highlightPamela('say "oops');
  assert.doesNotMatch(html, /tok-string/);
  assert.match(html, /oops/);
});

test("the highlighted copy preserves every character of the source", () => {
  const source = "# title\nCharacter(\"hero\", 1)\n  .move(0, 100)\n# done";
  const html = highlightPamela(source);
  // 移除高亮标记并反转义后，剩余文本必须等于源文本。
  assert.equal(unmarked(html), source);
});

// --- 内置 API 的名字 ---
//
// 中文名与英文名是同一个 API（`BUILTIN_ALIASES` 把它们对起来），所以两种写法
// 都用同一个颜色；而 `上`、`左`、`移动` 这些词也可能是作者自己的变量，只有调用
// 位置才算 API。

test("a builtin call in either spelling gets the builtin class", () => {
  assert.match(highlightPamela('Character("a.png")'), /<span class="tok-builtin">Character<\/span>/);
  assert.match(highlightPamela('角色("a.png")'), /<span class="tok-builtin">角色<\/span>/);
  assert.match(highlightPamela('背景("教室.png")'), /<span class="tok-builtin">背景<\/span>/);
});

test("a method call in either spelling gets the builtin class", () => {
  assert.match(highlightPamela('hero.say("hi")'), /<span class="tok-builtin">say<\/span>/);
  assert.match(highlightPamela('hero.说("你好")'), /<span class="tok-builtin">说<\/span>/);
  assert.match(highlightPamela('hero.move(0, 100)'), /<span class="tok-builtin">move<\/span>/);
});

test("a call written with Chinese punctuation is still a call", () => {
  // 全角括号与中文引号由词法层读作对应的 ASCII 记号，所以括号里的调用仍成立。
  assert.match(highlightPamela('小帕.说（“你好”）'), /<span class="tok-builtin">说<\/span>/);
});

test("a name that is not being called stays a plain identifier", () => {
  // `上` is the Chinese name of `up()` and is also a valid variable name.
  assert.doesNotMatch(highlightPamela("上 = 1"), /tok-builtin/);
  assert.doesNotMatch(highlightPamela("说 = 1"), /tok-builtin/);
  assert.doesNotMatch(highlightPamela("hero = say"), /tok-builtin/);
});

test("a name the script declared is not painted as a builtin", () => {
  assert.doesNotMatch(highlightPamela("func act() { }"), /tok-builtin/);
});

// --- 简写（.mpe） ---

test("mpe: the call and its argument are coloured apart", () => {
  const html = highlightMpe("背景 教室.png");
  assert.match(html, /<span class="tok-builtin">背景<\/span>/);
  assert.match(html, /<span class="tok-string">教室\.png<\/span>/);
});

test("mpe: a receiver, the call, and the free text", () => {
  const html = highlightMpe("小帕 说 你好，我是帕梅拉！");
  assert.match(html, /<span class="tok-ident">小帕<\/span>/);
  assert.match(html, /<span class="tok-builtin">说<\/span>/);
  assert.match(html, /<span class="tok-string">你好，我是帕梅拉！<\/span>/);
});

test("mpe: an assignment keeps the receiver as a name", () => {
  const html = highlightMpe("小帕 = 角色 帕梅拉.png");
  assert.match(html, /<span class="tok-ident">小帕<\/span>/);
  assert.match(html, /<span class="tok-builtin">角色<\/span>/);
  assert.match(html, /<span class="tok-string">帕梅拉\.png<\/span>/);
});

test("mpe: numbers, literals and expressions in the argument list", () => {
  const html = highlightMpe("小帕 缩放 {scale + 0.5} 300 true");
  assert.match(html, /<span class="tok-operator">\{<\/span>/);
  assert.match(html, /<span class="tok-ident">scale<\/span>/, "花括号里按完整语法读");
  assert.match(html, /<span class="tok-number">0\.5<\/span>/);
  assert.match(html, /<span class="tok-number">300<\/span>/);
  assert.match(html, /<span class="tok-keyword">true<\/span>/);
});

test("mpe: a parameter written with = is still coloured", () => {
  // The named-argument run used to call the tag helper through a shadowed name,
  // which threw and left the whole file uncoloured: one `=` was enough.
  const html = highlightMpe("ch = Character ch.png x=300 y=-500 scale=2");
  assert.match(html, /<span class="tok-builtin">Character<\/span>/);
  assert.match(html, /<span class="tok-ident">x<\/span>=<span class="tok-number">300<\/span>/);
  assert.match(html, /<span class="tok-number">-500<\/span>/);
  // Still exactly the line that was written, once the markup is stripped.
  assert.equal(unmarked(html), "ch = Character ch.png x=300 y=-500 scale=2");
});

test("mpe: a trailing comment is a comment, not part of the name", () => {
  const html = highlightMpe("背景 教室.png // 夜景");
  assert.match(html, /<span class="tok-string">教室\.png<\/span>/);
  assert.match(html, /<span class="tok-comment">\/\/ 夜景<\/span>/);
});

test("mpe: a group is built with names, not with a line of dialogue", () => {
  const html = highlightMpe("ay1 = Array ch1 ch2");
  assert.match(html, /<span class="tok-ident">ay1<\/span>/);
  assert.match(html, /<span class="tok-builtin">Array<\/span>/);
  assert.match(html, /<span class="tok-ident">ch1<\/span>/);
  assert.match(html, /<span class="tok-ident">ch2<\/span>/);
  // `add` 与 `del` 之后同样是对象名。
  assert.match(highlightMpe("ay1 add ch3"), /<span class="tok-ident">ch3<\/span>/);
});

test("mpe: a cue line colours its head and the statement it starts", () => {
  const html = highlightMpe("cue 3000 ch scale 0.5");
  assert.match(html, /<span class="tok-keyword">cue<\/span>/);
  assert.match(html, /<span class="tok-number">3000<\/span>/);
  // The statement after the head is shorthand, so its call is the API colour.
  assert.match(html, /<span class="tok-ident">ch<\/span>/);
  assert.match(html, /<span class="tok-builtin">scale<\/span>/);
  assert.equal(unmarked(html), "cue 3000 ch scale 0.5");
});

test("mpe: a line the dialect does not rewrite is coloured as full syntax", () => {
  const html = highlightMpe("wait 800");
  assert.match(html, /<span class="tok-keyword">wait<\/span>/);
  assert.match(html, /<span class="tok-number">800<\/span>/);
  assert.match(highlightMpe("// 注释"), /<span class="tok-comment">\/\/ 注释<\/span>/);
});

test("mpe: a stage-wide call with the stage left out is coloured", () => {
  const html = highlightMpe("enable ch bg");
  assert.match(html, /<span class="tok-builtin">enable<\/span>/);
  assert.match(html, /<span class="tok-ident">ch<\/span>/);
  assert.match(html, /<span class="tok-ident">bg<\/span>/);
  assert.equal(unmarked(html), "enable ch bg");
  // The Chinese spelling, the numeric-argument form and the form that keeps
  // the receiver all colour the call itself the same way.
  assert.match(highlightMpe("隐藏 小帕 小白"), /<span class="tok-builtin">隐藏<\/span>/);
  assert.match(highlightMpe("scale 2.0 300"), /<span class="tok-builtin">scale<\/span>/);
  assert.match(highlightMpe("stage enable ch bg"), /<span class="tok-builtin">enable<\/span>/);
});

test("mpe: a chained call, the dot is punctuation and the method a call", () => {
  const html = highlightMpe("ch scale 2.0 . move 0 -300");
  // 小数点留在数字里，句点单独是一段标点。
  assert.match(html, /<span class="tok-number">2\.0<\/span>/);
  assert.match(html, /<span class="tok-operator">\.<\/span>/);
  assert.match(html, /<span class="tok-builtin">move<\/span>/);
  assert.equal(unmarked(html), "ch scale 2.0 . move 0 -300");
  // 台词里的句点仍是台词。
  assert.match(highlightMpe("说 你好 . 世界"), /<span class="tok-string">你好 \. 世界<\/span>/);
});

test("mpe: a bare bulk method is coloured before its objects are written", () => {
  assert.match(highlightMpe("enable"), /<span class="tok-builtin">enable<\/span>/);
  const html = highlightMpe("  启用  ");
  assert.match(html, /<span class="tok-builtin">启用<\/span>/);
  assert.equal(unmarked(html), "  启用  ");
});

test("mpe: the highlighted copy preserves every character of the source", () => {
  const source = [
    "小帕 = 角色 帕梅拉.png",
    "",
    "小帕 说 你好，我是帕梅拉！",
    "背景 教室.png // 夜景",
    "  小帕 缩放 {scale + 0.5} 300",
    "wait 800",
    "// 收尾",
  ].join("\n");
  assert.equal(unmarked(highlightMpe(source)), source);
});
