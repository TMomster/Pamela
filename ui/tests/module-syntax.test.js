// 回归场景：`ui/` 目录下出现过两次的模块解析缺陷。
// Regression case: a module-resolution defect observed twice under `ui/`.
// 已知隐患：`node --check` 以脚本模式解析 `.js` 文件，无法检出该类错误。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const UI_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Every `.js` file directly under `ui/`. */
function modulesInUi() {
  return readdirSync(UI_DIR)
    .filter((name) => name.endsWith(".js"))
    .sort();
}

test("每个 ui/*.js 都能按 ES 模块解析", () => {
  const files = modulesInUi();
  // A silent zero would make this test pass by doing nothing, which is the
  // failure mode it exists to prevent.
  assert.ok(files.length > 10, `应当找到多个模块，实际 ${files.length}`);

  const dir = mkdtempSync(join(tmpdir(), "pamela-esm-"));
  try {
    const broken = [];
    for (const name of files) {
      const source = readFileSync(join(UI_DIR, name), "utf8");
      const copy = join(dir, `${name.replace(/\.js$/, "")}.mjs`);
      writeFileSync(copy, source);
      const result = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" });
      if (result.status !== 0) {
        // Only the app's own file matters in the message; the copy's path is
        // visual clutter the reader cannot act on.
        const detail = String(result.stderr ?? "").split("\n").slice(0, 5).join("\n");
        broken.push(`${name}\n${detail}`);
      }
    }
    assert.deepEqual(broken, [], "这些模块按 ES 模块解析失败");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模块解析检查可检出 await 写在非 async 函数里", () => {
  // Pins the reason the check above exists. If Node ever stops treating this as
  // a syntax error, the guard would silently become a no-op and this says so.
  const dir = mkdtempSync(join(tmpdir(), "pamela-esm-neg-"));
  try {
    const broken = join(dir, "broken.mjs");
    writeFileSync(broken, "function f() {\n  const x = await g();\n  return x;\n}\nexport default f;\n");
    const result = spawnSync(process.execPath, ["--check", broken], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "非 async 函数里的 await 应当解析失败");
    assert.match(String(result.stderr), /await|reserved/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
