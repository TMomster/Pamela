import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../pamela.js";

// 跳转测试。
/** A project of scripts, answering readScene the way the host would. */
// 桩项目按宿主方式响应 `readScene`。
function sceneFiles(files) {
  const asked = [];
  return {
    asked,
    readScene: (path) => {
      asked.push(path);
      return path in files ? Promise.resolve(files[path]) : Promise.reject(new Error("文件不在"));
    },
  };
}

test("jump ends the current run and starts the target file from the top", async () => {
  const { asked, readScene } = sceneFiles({ "second.pamela": "x = 2" });
  const result = await run('jump("second.pamela")', { readScene, source: "main.pamela" });
  assert.equal(result.error, undefined);
  assert.equal(result.value, 2);
  assert.deepEqual(asked, ["second.pamela"]);
});

test("jump abandons the rest of the current file", async () => {
  const { readScene } = sceneFiles({ "second.pamela": "x = 1" });
  // The `x = 5` after the jump never runs, so x keeps the value the target set.
  const result = await run('jump("second.pamela")\nx = 5', { readScene });
  assert.equal(result.value, 1);
});

test("jump chains through several files until one ends", async () => {
  const { asked, readScene } = sceneFiles({
    "a.pamela": 'jump("b.pamela")',
    "b.pamela": 'jump("c.pamela")',
    "c.pamela": "x = 7",
  });
  const result = await run('jump("a.pamela")', { readScene });
  assert.equal(result.value, 7);
  assert.deepEqual(asked, ["a.pamela", "b.pamela", "c.pamela"]);
});

test("jump with no readScene is reported, not skipped", async () => {
  const result = await run('jump("second.pamela")');
  assert.match(result.error.message, /jump 不可用/);
});

test("a jump to a file that cannot be read names the path", async () => {
  const { readScene } = sceneFiles({});
  const result = await run('jump("missing.pamela")', { readScene });
  assert.match(result.error.message, /missing\.pamela/);
  assert.equal(result.error.file, "missing.pamela");
});

test("jump is a fresh run: the target does not see the caller's variables", async () => {
  const { readScene } = sceneFiles({ "second.pamela": "y = x + 1" });
  // `x` set before the jump is gone in the target's scope, so the add errors.
  const result = await run('x = 99\njump("second.pamela")', { readScene });
  assert.ok(result.error, "expected an error because x is undefined in the target");
});

test("jump inside an if branch still transitions", async () => {
  const { readScene } = sceneFiles({ "second.pamela": "x = 3" });
  const result = await run('if true {\n  jump("second.pamela")\n}\nx = 0', { readScene });
  assert.equal(result.value, 3);
});

test("jump from inside a function body still transitions", async () => {
  const { readScene } = sceneFiles({ "second.pamela": "x = 4" });
  const result = await run('func go() {\n  jump("second.pamela")\n}\ngo()\nx = 0', { readScene });
  assert.equal(result.value, 4);
});

test("jump target can be a variable holding the path", async () => {
  const { readScene } = sceneFiles({ "second.pamela": "x = 2" });
  const result = await run('next = "second.pamela"\njump(next)', { readScene });
  assert.equal(result.value, 2);
});

test("jump target can be a concatenated string", async () => {
  const { readScene } = sceneFiles({ "second.pamela": "x = 3" });
  const result = await run('name = "second"\njump(name + ".pamela")', { readScene });
  assert.equal(result.value, 3);
});

test("jump target can come from a function call", async () => {
  const { readScene } = sceneFiles({ "second.pamela": "x = 4" });
  const result = await run('func where() {\n  return "second.pamela"\n}\njump(where())', { readScene });
  assert.equal(result.value, 4);
});

test("jump with a non-string target is a runtime error", async () => {
  assert.match((await run("jump(3)\n")).error.message, /文本路径/);
});

test("jump with an empty or blank target is rejected", async () => {
  assert.match((await run('jump("")\n')).error.message, /文本路径/);
  const { readScene } = sceneFiles({});
  assert.match((await run('p = ""\njump(p)\n')).error.message, /文本路径/);
});
