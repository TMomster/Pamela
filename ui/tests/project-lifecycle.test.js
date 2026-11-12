// 项目生命周期的行为测试：偏好的读改写、打开项目、默认目录。
// Tests for the project lifecycle and the preferences file.

import assert from "node:assert/strict";
import test from "node:test";

import { createProjectLifecycle } from "../project-lifecycle.js";

function harness({
  stored = {},
  loadFails = false,
  saveFails = false,
  dirty = false,
  discard = true,
  session = { project: null },
  opened = null,
} = {}) {
  const messages = [];
  const writes = [];
  const applied = [];
  const busy = [];
  const lifecycle = createProjectLifecycle({
    session,
    getActions: () => ({
      loadState: async () => {
        if (loadFails) {
          throw new Error("偏好文件损坏");
        }
        return stored;
      },
      saveState: async (next) => {
        if (saveFails) {
          throw new Error("磁盘只读");
        }
        writes.push(next);
        return next;
      },
      openRoot: async (root) => {
        if (opened instanceof Error) {
          throw opened;
        }
        return opened ?? { name: "demo", root };
      },
    }),
    setMessage: (text, options = {}) => messages.push({ text, error: Boolean(options.error) }),
    isEditorDirty: () => dirty,
    confirmDiscard: async () => discard,
    applyProject: (project) => applied.push(project),
    setBusy: (active) => busy.push(active),
  });
  return { lifecycle, busy, messages, writes, applied };
}

test("恢复：读到什么就是什么，并回答上次的项目", async () => {
  const { lifecycle } = harness({ stored: { last_project: "G:/demo", mode: "player", width: 1280 } });

  const remembered = await lifecycle.restore();

  assert.equal(remembered, "G:/demo");
  assert.deepEqual(lifecycle.state, { last_project: "G:/demo", mode: "player", width: 1280 });
});

test("恢复失败：从空偏好起步，不把上一个项目带进来", async () => {
  const { lifecycle } = harness({ loadFails: true });

  const remembered = await lifecycle.restore();

  assert.equal(remembered, null);
  assert.deepEqual(lifecycle.state, {});
});

test("保存：在磁盘上的旧字段之上写，只覆盖自己知道的", async () => {
  const { lifecycle, writes } = harness({ stored: { last_project: "G:/demo", zoom: 1.25 } });
  await lifecycle.restore();

  lifecycle.state.width = 1600;
  await lifecycle.save();

  assert.deepEqual(writes, [{ last_project: "G:/demo", zoom: 1.25, width: 1600 }], "不认识的字段要留下");
});

test("保存：写失败要上报，且不假装写成功了", async () => {
  const { lifecycle, messages } = harness({ saveFails: true });

  await lifecycle.save();

  assert.equal(messages.at(-1).error, true);
  assert.match(messages.at(-1).text, /保存偏好失败/);
});

test("保存：连续两次改动按顺序落地", async () => {
  const { lifecycle, writes } = harness();

  lifecycle.state.width = 800;
  const first = lifecycle.save();
  lifecycle.state.mode = "player";
  const second = lifecycle.save();
  await Promise.all([first, second]);

  assert.deepEqual(writes, [
    { width: 800 },
    { width: 800, mode: "player" },
  ]);
});

test("打开项目：脏文件被放弃就什么都不做", async () => {
  const { lifecycle, applied, writes } = harness({ dirty: true, discard: false });
  let opened = 0;

  await lifecycle.withProject(async () => {
    opened += 1;
    return { name: "demo", root: "G:/demo" };
  });

  assert.equal(opened, 0);
  assert.deepEqual(applied, []);
  assert.deepEqual(writes, []);
});

test("打开项目：成功时换项目、记住路径", async () => {
  const { lifecycle, applied, writes } = harness();

  await lifecycle.withProject(async () => ({ name: "demo", root: "G:/demo" }));

  assert.equal(applied.length, 1);
  assert.equal(lifecycle.state.last_project, "G:/demo");
  // 模式不进偏好文件：打开项目只记住路径。
  assert.equal("mode" in lifecycle.state, false);
  assert.deepEqual(writes, [{ last_project: "G:/demo" }]);
});

test("打开项目：选择器返回空时不动当前项目", async () => {
  const { lifecycle, applied, writes } = harness();

  await lifecycle.withProject(async () => null);

  assert.deepEqual(applied, []);
  assert.deepEqual(writes, []);
});

test("打开项目：后端报错只上状态栏，旧项目留着", async () => {
  const { lifecycle, applied, messages } = harness();

  await lifecycle.withProject(async () => {
    throw new Error("不是 Pamela 项目");
  });

  assert.deepEqual(applied, []);
  assert.equal(messages.at(-1).error, true);
  assert.match(messages.at(-1).text, /不是 Pamela 项目/);
});

test("打开项目：被后发请求取代的那次不报错，也不换项目", async () => {
  const { lifecycle, applied, messages } = harness();

  await lifecycle.withProject(async () => {
    // 后端作废了这次加载：另一次打开已经胜出，这里只是收尾。
    throw "项目已被另一次打开操作取代";
  });

  assert.deepEqual(applied, []);
  assert.deepEqual(messages, [], "作废的加载不该在状态栏留一条错误");
});

test("打开项目：两次打开并发时，先完成的那次不提前解锁输入", async () => {
  const { lifecycle, busy } = harness();
  /** @type {() => void} */
  let finishSlow = () => {};

  const slow = lifecycle.withProject(
    () =>
      new Promise((resolve) => {
        finishSlow = () => resolve({ name: "slow", root: "G:/slow" });
      }),
  );

  await lifecycle.withProject(async () => ({ name: "fast", root: "G:/fast" }));
  assert.deepEqual(busy, [true], "另一侧还在加载，编辑器得继续锁着");

  finishSlow();
  await slow;
  assert.deepEqual(busy, [true, false], "最后一次结束才解锁");
});

test("默认目录：没有项目时不指路，有项目时落在它的旁边", () => {
  const empty = harness({ session: { project: null } });
  assert.equal(empty.lifecycle.defaultPath(), undefined);

  const open = harness({ session: { project: { root: "G:/work/demo" } } });
  assert.equal(open.lifecycle.defaultPath(), "G:/work");
});

test("恢复上次项目：路径为空直接返回，找不到时上报并返回空", async () => {
  const empty = harness();
  assert.equal(await empty.lifecycle.openRemembered(null), null);

  const missing = harness({ opened: new Error("目录已不存在") });
  assert.equal(await missing.lifecycle.openRemembered("G:/gone"), null);
  assert.equal(missing.messages.at(-1).error, true);
});
