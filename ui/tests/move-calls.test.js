// 在剧本编辑器中按光标偏移定位 `key()` 调用的测试。
// Tests for finding a `key()` in the script editor: which call a caret offset

import assert from "node:assert/strict";
import test from "node:test";

import {
  fontCallAt,
  fontCallsIn,
  keyCallAt,
  keyCallsIn,
  offsetAtPoint,
  rewriteKeyReferences,
  splitOffset,
  withFontFamily,
  withKeyFile,
  withoutKeyFile,
} from "../move-calls.js";
import { referencedIds } from "../path.js";

// --- 找出调用 ---

test("调用：支持识别 key()", () => {
  const calls = keyCallsIn(['ch.key()', "bg.key()", "hero.enable().key()"].join("\n"));
  assert.deepEqual(
    calls.map((c) => c.target),
    ["ch", "bg", "hero"],
  );
});

test("调用：方法名与括号之间可以有空白", () => {
  const calls = keyCallsIn("ch . key ( )");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "ch");
  // The name's own offsets must land on the name, not one character off it.
  assert.equal("ch . key ( )".slice(calls[0].nameStart).startsWith("key"), true);
  assert.equal("ch . key ( )"[calls[0].start], ".");
});

test("调用：链式调用里的 key 也算，且取链首的对象名", () => {
  const calls = keyCallsIn("hero.enable().key()");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "hero");
});

test("调用：move 不再被当成 key", () => {
  // `move` keeps its own job; only a `key()` call opens the path editor.
  assert.equal(keyCallsIn("hero.move(10, 20, 300)").length, 0);
  assert.equal(keyCallsIn("hero.moveTo(1, 2)").length, 0);
  assert.equal(keyCallsIn('hero.followPath("a1b2")').length, 0, "旧写法不再是 key");
});

test("调用：带文件名的 key 支持识别，文件名被读出来", () => {
  const calls = keyCallsIn('ch.key("key-ch.keyframes")');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "ch");
  assert.equal(calls[0].file, "key-ch.keyframes");
});

test("调用：不带文件名的 key 仍然支持识别，file 是空的", () => {
  // Every script written before the argument existed looks like this, and it
  // still has to open the editor.
  const calls = keyCallsIn("ch.key()");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "");
});

test("调用：括号里不是字符串字面量的 key 不判定为", () => {
  // `key(x + 1)` is some other call the author wrote; offering the key frame
  // editor for it would be wrong.
  assert.equal(keyCallsIn("ch.key(x + 1)").length, 0);
  assert.equal(keyCallsIn('ch.key(name)').length, 0);
});

test("调用：写回文件名时只替换括号里的内容", () => {
  const source = ['ch.enable().key()', 'bg.key("old.keyframes")'].join("\n");
  const [first, second] = keyCallsIn(source);
  assert.equal(
    withKeyFile(source, first, "key-ch.keyframes"),
    ['ch.enable().key("key-ch.keyframes")', 'bg.key("old.keyframes")'].join("\n"),
  );
  // An existing argument is replaced, not appended to.
  assert.equal(
    withKeyFile(source, second, "key-bg.keyframes"),
    ['ch.enable().key()', 'bg.key("key-bg.keyframes")'].join("\n"),
  );
  // Offsets that no longer match the text leave it alone rather than splicing
  // a name into the middle of some other call.
  assert.equal(withKeyFile("x = 1", { open: 2, close: 3 }, "k.keyframes"), "x = 1");
});

test("调用：清空文件名时回到 key()，链式调用不断", () => {
  const source = ['ch.enable().key("ch-main-pe-1.keyframes")', 'bg.key("bg-main-pe-1.keyframes")'].join(
    "\n",
  );
  const [first, second] = keyCallsIn(source);
  assert.equal(
    withoutKeyFile(source, first),
    ['ch.enable().key()', 'bg.key("bg-main-pe-1.keyframes")'].join("\n"),
  );
  assert.equal(
    withoutKeyFile(source, second),
    ['ch.enable().key("ch-main-pe-1.keyframes")', "bg.key()"].join("\n"),
  );
  // Offsets that no longer match the text leave it alone rather than splicing
  // an empty argument into some other call.
  assert.equal(withoutKeyFile("x = 1", { open: 2, close: 3 }), "x = 1");
});

test("调用：没闭合的括号不产生调用", () => {
  assert.equal(keyCallsIn("ch.key(").length, 0);
});

// --- 光标落在哪个调用 ---

test("光标：落在括号里就选中那个调用", () => {
  const source = "ch.key()";
  for (const at of [0, 2, 3, 5, 6, 7]) {
    const call = keyCallAt(source, at);
    assert.equal(call?.target, "ch", `偏移 ${at} 应命中 ch.key()`);
  }
});

test("光标：落在 key 这个词上也选中", () => {
  const source = 'bg = Background("x.png")\nbg.key()';
  const call = keyCallAt(source, source.indexOf("key") + 1);
  assert.equal(call.target, "bg");
});

test("光标：同一行有多个调用时取最近的", () => {
  const source = "a.key(); b.key()";
  assert.equal(keyCallAt(source, source.indexOf("a.key")).target, "a");
  assert.equal(keyCallAt(source, source.indexOf("b.key")).target, "b");
});

test("光标：落在其它行上不选这一行的调用", () => {
  const source = ["hero.key()", "count = 3"].join("\n");
  assert.equal(keyCallAt(source, source.indexOf("count")), null);
});

test("光标：没有 key 时答 null", () => {
  assert.equal(keyCallAt('hero.say("hi")', 2), null);
  assert.equal(keyCallAt("", 0), null);
  assert.equal(keyCallAt("hero.key()", NaN), null);
});

// --- 指针 → 光标偏移 ---

/**
 * A synthetic monospace layout of `text`: 10px per character, 20px per line,
 * `lineChars` characters wide before wrapping.
 *
 * This is what `measure` answers for the real highlight layer, minus the
 * browser's own metrics — the search is about picking the right offset, and a
 * grid makes the expected answer obvious.
 */
function gridMeasure(text, { charWidth = 10, lineHeight = 20, lineChars = 20, originX = 0, originY = 0 } = {}) {
  return (offset) => {
    const at = Math.min(Math.max(0, offset), text.length);
    const before = text.slice(0, at);
    const line = before.split("\n").length - 1;
    const lastLine = before.slice(before.lastIndexOf("\n") + 1);
    const column = lastLine.length % lineChars;
    const wrapped = line + Math.floor(lastLine.length / lineChars);
    const left = originX + column * charWidth;
    return {
      left,
      right: left + charWidth,
      top: originY + wrapped * lineHeight,
      bottom: originY + wrapped * lineHeight + lineHeight,
    };
  };
}

test("指针：落在某行某列，答那个偏移", () => {
  const text = "abc\ndefg\nhi";
  const measure = gridMeasure(text);
  // Line 1 (top 20), third character: x inside the third cell.
  const offset = offsetAtPoint(measure, text.length, 25, 25);
  assert.equal(text[offset], "f", `应落在 f，实际落在 ${JSON.stringify(text[offset])}`);
});

test("指针：行的开头答行首", () => {
  const text = "abc\ndefg";
  const measure = gridMeasure(text);
  assert.equal(offsetAtPoint(measure, text.length, 0, 25), 4, "第二行行首是偏移 4");
});

test("指针：超出文本右边答行尾附近", () => {
  const text = "abc\ndefg";
  const measure = gridMeasure(text);
  const offset = offsetAtPoint(measure, text.length, 9999, 5);
  assert.ok(offset >= 2 && offset <= 3, `第一行靠右，实际 ${offset}`);
});

test("指针：超出文本下边落在最后一行上", () => {
  const text = "abc\ndefg";
  const measure = gridMeasure(text);
  // Below everything, the nearest line is the last one; with x at the left of
  // it the caret goes to that line's start rather than to the file's end.
  const offset = offsetAtPoint(measure, text.length, 0, 9999);
  assert.ok(offset >= 4 && offset <= text.length, `应在最后一行内，实际 ${offset}`);
});

test("指针：空文本返回 0", () => {
  assert.equal(offsetAtPoint(gridMeasure(""), 0, 100, 100), 0);
});

test("指针：折行时按最上面那一行找", () => {
  // 40 characters over a 20-wide grid is two visual lines for one text line.
  const text = "0123456789012345678901234567890123456789";
  const measure = gridMeasure(text);
  const offset = offsetAtPoint(measure, text.length, 5, 25);
  assert.ok(offset >= 20 && offset <= 21, `应落在第二视觉行，实际 ${offset}`);
});

test("指针：结果总是一个合法的偏移", () => {
  const text = "hero.key()\nbg.key()";
  const measure = gridMeasure(text);
  for (const [x, y] of [
    [0, 0],
    [7, 12],
    [123, 40],
    [-20, -20],
    [500, 500],
  ]) {
    const offset = offsetAtPoint(measure, text.length, x, y);
    assert.ok(Number.isInteger(offset), "偏移是整数");
    assert.ok(offset >= 0 && offset <= text.length, `偏移在范围内：${offset}`);
  }
});

// --- 跨文本节点的偏移 ---

test("偏移：把全文偏移拆到各个文本节点上", () => {
  // A highlighted line is several runs: `hero` | `.` | `key` | `(` | `)`.
  const lengths = [4, 1, 3, 1, 1];
  // Offset 0 is the first character of the first run.
  assert.deepEqual(splitOffset(lengths, 0), { index: 0, offset: 0 });
  // Offset 3 is the last character of `hero`.
  assert.deepEqual(splitOffset(lengths, 3), { index: 0, offset: 3 });
  // Offset 4 sits on the boundary between `hero` and `.`. It is reported at the
  // end of the first run: that caret and the one at the start of the next run
  // are the same visual spot, and taking the earlier node keeps the walk
  // monotonic.
  assert.deepEqual(splitOffset(lengths, 4), { index: 0, offset: 4 });
  // Offset 5 opens `key`.
  assert.deepEqual(splitOffset(lengths, 5), { index: 1, offset: 1 });
  // Offset 7 is inside `key` — the runs laid out are hero(0-3) .(4) key(5-7),
  // so offset 7 is the last character of the name.
  assert.deepEqual(splitOffset(lengths, 7), { index: 2, offset: 2 });
});

test("偏移：越界夹到末尾，负数夹到开头", () => {
  const lengths = [3, 3];
  assert.deepEqual(splitOffset(lengths, 999), { index: 1, offset: 3 });
  assert.deepEqual(splitOffset(lengths, -5), { index: 0, offset: 0 });
});

test("偏移：空文本节点被跳过，不影响位置", () => {
  // Zero-length runs happen when the highlighter emits an empty span.
  const lengths = [0, 4, 0, 2];
  assert.deepEqual(splitOffset(lengths, 0), { index: 0, offset: 0 });
  assert.deepEqual(splitOffset(lengths, 4), { index: 1, offset: 4 });
  assert.deepEqual(splitOffset(lengths, 5), { index: 3, offset: 1 });
});

test("偏移：没有文本节点时不抛出异常", () => {
  assert.deepEqual(splitOffset([], 0), { index: 0, offset: 0 });
  assert.deepEqual(splitOffset([], 10), { index: 0, offset: 0 });
});

test("偏移：全文每一个位置都落在某个节点里，且位置正确", () => {
  const lengths = [2, 3, 1, 4];
  const total = lengths.reduce((a, b) => a + b, 0);
  // Rebuild the mapping by walking every offset: the node index must never go
  // backwards, and the reported offset must be inside its node.
  let previousIndex = -1;
  for (let at = 0; at <= total; at += 1) {
    const where = splitOffset(lengths, at);
    assert.ok(where.offset >= 0 && where.offset <= lengths[where.index], `偏移 ${at} 落在节点外`);
    assert.ok(where.index >= previousIndex, `偏移 ${at} 的节点序号倒退了`);
    previousIndex = where.index;
  }
});

// --- 重命名时的引用改写 ---

test("引用：key() 指向新文件，其它调用与同名的对白不动", () => {
  const source = [
    'ch.enable().key("key-ch.keyframes")',
    'npc.key("key-npc.keyframes")',
    'say("key-ch.keyframes")',
  ].join("\n");
  const next = rewriteKeyReferences(source, "key-ch.keyframes", "key-hero.keyframes");
  assert.equal(next.split("\n")[0], 'ch.enable().key("key-hero.keyframes")');
  assert.equal(next.split("\n")[1], 'npc.key("key-npc.keyframes")');
  assert.equal(next.split("\n")[2], 'say("key-ch.keyframes")');
  assert.ok(referencedIds(next).has("hero"), "引用扫描器支持识别改后的文件");
  assert.equal(referencedIds(next).has("ch"), false);
});

test("引用：带 data/ 前缀和同行多个调用都精确改写", () => {
  const source = 'a.key("data/key-ch.keyframes"); b.key("key-ch.keyframes")';
  assert.equal(
    rewriteKeyReferences(source, "data/key-ch.keyframes", "key-hero.keyframes"),
    'a.key("key-hero.keyframes"); b.key("key-hero.keyframes")',
  );
});

test("引用：flowmap 的 params.file 跟着改，其它文件字段不动", () => {
  const map = JSON.stringify({
    nodes: [{ params: { file: "key-ch.keyframes" } }, { params: { file: "scene.pe" } }],
  });
  const next = rewriteKeyReferences(map, "key-ch.keyframes", "key-hero.keyframes");
  assert.equal(JSON.parse(next).nodes[0].params.file, "key-hero.keyframes");
  assert.equal(JSON.parse(next).nodes[1].params.file, "scene.pe");
});

test("引用：旧 followPath(id) 只在 id 真的变了时才跟着改", () => {
  const source = 'hero.followPath("ch")';
  assert.equal(
    rewriteKeyReferences(source, "key-ch.keyframes", "key-hero.keyframes", {
      fromId: "ch",
      toId: "hero",
    }),
    'hero.followPath("hero")',
  );
  assert.equal(
    rewriteKeyReferences(source, "key-ch.keyframes", "key-hero.keyframes", {
      fromId: "ch",
      toId: "ch",
    }),
    source,
  );
});

test("引用：没有匹配、参数为空、无参旧 key() 都原样返回", () => {
  const source = 'ch.key("key-npc.keyframes")';
  assert.equal(rewriteKeyReferences(source, "key-ch.keyframes", "key-hero.keyframes"), source);
  assert.equal(rewriteKeyReferences(source, "", "x"), source);
  assert.equal(rewriteKeyReferences(source, "a", ""), source);
  assert.equal(rewriteKeyReferences("ch.key()", "key-ch.keyframes", "key-hero.keyframes"), "ch.key()");
  assert.equal(rewriteKeyReferences(null, "a", "b"), "");
});

// --- 字体调用 ---

test("字体调用：font 与 字体 都识别，读出括号里的名字", () => {
  const calls = fontCallsIn(['title.font("宋体")', 'note.字体("Arial")', "label.font()"].join("\n"));
  assert.deepEqual(
    calls.map((call) => call.family),
    ["宋体", "Arial", ""],
  );
  assert.deepEqual(
    calls.map((call) => call.target),
    ["title", "note", "label"],
  );
});

test("字体调用：括号里不是字符串字面量的不判定为", () => {
  assert.equal(fontCallsIn("title.font(family)").length, 0);
  assert.equal(fontCallsIn('title.font("a" + b)').length, 0);
});

test("字体调用：右键要落在调用内部，同一行的别处不算", () => {
  const source = 'title.enable()\ntitle.font("宋体")';
  const inside = source.indexOf("宋体");
  const found = fontCallAt(source, inside);
  assert.equal(found.target, "title");
  assert.equal(found.family, "宋体");

  // The first line has no font call; a caret on it must not open the menu.
  assert.equal(fontCallAt(source, source.indexOf("enable")), null);
  // Nor does the tail of the line after the call.
  assert.equal(fontCallAt(source, source.length), null);
});

test("字体调用：写回只换括号里的名字，空名字清空参数", () => {
  const source = ['title.font("宋体")', 'note.font()'].join("\n");
  const [title, note] = fontCallsIn(source);
  assert.equal(
    withFontFamily(source, title, "Microsoft YaHei"),
    ['title.font("Microsoft YaHei")', 'note.font()'].join("\n"),
  );
  assert.equal(
    withFontFamily(source, title, ""),
    ['title.font()', 'note.font()'].join("\n"),
  );
  assert.equal(
    withFontFamily(source, note, "Arial"),
    ['title.font("宋体")', 'note.font("Arial")'].join("\n"),
  );
});

test("字体调用：偏移过期时不改坏脚本", () => {
  const source = 'title.font("宋体")';
  const call = fontCallsIn(source)[0];
  assert.equal(withFontFamily("changed", call, "Arial"), "changed");
});
