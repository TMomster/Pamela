// 真解释器驱动：脚本在虚拟时钟下跑完，动作落到时间线。
// Real interpreter under the virtual clock, recorded into the timeline.

import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualClock, flushTasks } from "../export-clock.js";
import { createTimeline, stateAt, timelineDuration } from "../export-timeline.js";
import {
  createExportPerformance,
  plateImageSources,
  preloadAssets,
  resolveScenePath,
} from "../export-performance.js";

test("plateImageSources collects visible image layers across both slots, once", () => {
  const doc = {
    styles: {
      dialog: {
        layers: [
          { type: "image", source: "ui/frame.png" },
          { type: "image", source: "ui/hidden.png", visible: false },
          { type: "rect", source: "ui/ignored.png" },
          { type: "image", source: "ui/frame.png" },
        ],
      },
      narration: { layers: [{ type: "image", source: "ui/box.png" }] },
    },
  };
  assert.deepEqual(plateImageSources(doc), ["ui/frame.png", "ui/box.png"]);
  assert.deepEqual(plateImageSources({ layers: [{ type: "image", source: "a.png" }] }), ["a.png"]);
  assert.deepEqual(plateImageSources(null), []);
});

test("preloadAssets decodes a gif into timed frames instead of one still image", async () => {
  const bytes = Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x02, 0x00, 0x81, 0x00, 0x00,
    0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
    0x02, 0x03, 0x44, 0x34, 0x05, 0x00, 0x3b,
  ]);
  const url = "data:image/gif;base64," + Buffer.from(bytes).toString("base64");
  const makeCanvas = (width, height) => ({
    width,
    height,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    }),
  });
  const assets = new Map();
  await preloadAssets('ch = Character("hero.gif")', async () => url, assets, new Set(), makeCanvas);

  const gif = assets.get("hero.gif");
  assert.equal(gif.kind, "gif");
  assert.equal(gif.frames.length, 1);
  assert.equal(gif.width, 2);
  assert.equal(gif.total, 100);
});

/** 一边 tick 虚拟时钟，一边让解释器推进，直到演出结束。 */
async function drive(performance, session, limit = 400) {
  let done = false;
  const running = Promise.resolve()
    .then(() => performance(session))
    .then(
      (result) => {
        done = true;
        return result;
      },
      (error) => {
        done = true;
        throw error;
      },
    );
  running.catch(() => {});
  await flushTasks();
  for (let step = 0; step < limit && !done; step += 1) {
    session.clock.tick();
    await flushTasks();
  }
  assert.equal(done, true, "演出没有在帧数上限内跑完");
  return running;
}

function sessionFor() {
  return {
    clock: createVirtualClock(),
    timeline: createTimeline(),
    assets: new Map(),
  };
}

test("resolveScenePath puts bare names under scripts/", () => {
  assert.equal(resolveScenePath("ch1.pe"), "scripts/ch1.pe");
  assert.equal(resolveScenePath("./ch1.pe"), "scripts/ch1.pe");
  assert.equal(resolveScenePath("chapters\\ch1.pe"), "chapters/ch1.pe");
  assert.equal(resolveScenePath("scripts/ch1.pe"), "scripts/ch1.pe");
});

test("a script with lines, waits and moves records a paced performance", async () => {
  const session = sessionFor();
  const performance = createExportPerformance({
    source: [
      'bg = Background("bg.png")',
      "bg.enable()",
      'hero = Character("hero.png")',
      'hero.name("小明")',
      "hero.enable()",
      'say("开场")',
      "wait 200",
      "hero.moveTo(100, 0, 0, 300)",
      'dialog.say("第二句", "旁白")',
    ].join("\n"),
    path: "scripts/main.pe",
    read: async () => "",
    preload: async () => {},
  });

  const result = await drive(performance, session);
  assert.equal(result.error, undefined);
  assert.notEqual(result.stopped, true);

  const early = stateAt(session.timeline, 100);
  assert.equal(early.dialogue.text, "开场");
  assert.equal(early.background.path, "bg.png");
  assert.equal(early.background.visible, true);
  assert.equal(early["character:hero"].visible, true);

  // timelineDuration 是最后一次画面变化的结束；演出还要把最后一句读完，
  // 那段时间由虚拟时钟覆盖（台词停留不产生新的画面事件）。
  assert.ok(session.clock.now() >= 2000, `虚拟时钟应走完台词停留，实际 ${session.clock.now()}ms`);
  const end = timelineDuration(session.timeline);
  assert.ok(end >= 1800, `画面事件应覆盖到打字机结束，实际 ${end}ms`);
  assert.equal(stateAt(session.timeline, end).dialogue.text, "第二句");
  assert.equal(stateAt(session.timeline, end)["character:hero"].x, 100);
});

test("choice takes the first option by default", async () => {
  const session = sessionFor();
  const performance = createExportPerformance({
    source: [
      "choice {",
      '  "继续" { say("走了继续") }',
      '  "结束" { say("就此结束") }',
      "}",
    ].join("\n"),
    path: "scripts/main.pe",
    read: async () => "",
  });
  const result = await drive(performance, session);
  assert.equal(result.error, undefined);
  assert.equal(
    stateAt(session.timeline, timelineDuration(session.timeline)).dialogue.text,
    "走了继续",
  );
});

test("include reads the resolved scene and records its line", async () => {
  const session = sessionFor();
  const asked = [];
  const performance = createExportPerformance({
    source: ['include "ch1.pe"', 'say("完")'].join("\n"),
    path: "scripts/main.pe",
    read: async (path) => {
      asked.push(path);
      return 'say("第一章")';
    },
  });
  const result = await drive(performance, session);
  assert.equal(result.error, undefined);
  assert.deepEqual(asked, ["scripts/ch1.pe"]);
  const lines = session.timeline.events
    .filter((event) => event.kind === "set" && event.target === "dialogue" && event.patch.text)
    .map((event) => event.patch.text);
  assert.ok(lines.includes("第一章"));
  assert.ok(lines.includes("完"));
});

test("a script error is surfaced with its line number", async () => {
  const session = sessionFor();
  const performance = createExportPerformance({
    source: "wait 100\n不认识的语句 ???",
    path: "scripts/main.pe",
    read: async () => "",
  });
  // 解析阶段的错误不会把演出停在某个 wait 上，直接 reject。
  await assert.rejects(performance(session), /脚本第 2 行/);
});

test("a bare cue starts all five free-transform points at once and they all land", async () => {
  const session = sessionFor();
  const performance = createExportPerformance({
    source: [
      'bg = Background("street.png")',
      'ch = Character("daoli.gif")',
      "enable(bg, ch)",
      "dialog.disable()",
      "ch.scale(0.5, 1000)",
      "cue {",
      "    ch.transform.upright(300, 300, 1000)",
      "    ch.transform.upleft(-300, 300, 1000)",
      "    ch.transform.up(0, 300, 1000)",
      "    ch.transform.downleft(100, 0, 1000)",
      "    ch.transform.downright(-100, 0, 1000)",
      "}",
    ].join("\n"),
    path: "scripts/main.pe",
    read: async () => "",
    preload: async () => {},
  });

  const result = await drive(performance, session);
  assert.equal(result.error, undefined);
  assert.equal(timelineDuration(session.timeline), 2000, "五个点都应动画到 2000ms");

  const at = (t) => stateAt(session.timeline, t)["character:ch"];
  assert.equal(at(1000).scale, 0.5);
  assert.equal(at(1500).mesh_upright_dx, 150);
  assert.equal(at(1500).mesh_upleft_dx, -150);
  assert.equal(at(1500).mesh_up_dy, 150);
  assert.equal(at(1500).mesh_downleft_dx, 50);
  assert.equal(at(1500).mesh_downright_dx, -50);

  const end = at(2000);
  assert.equal(end.mesh_upright_dx, 300);
  assert.equal(end.mesh_upright_dy, 300);
  assert.equal(end.mesh_upleft_dx, -300);
  assert.equal(end.mesh_up_dy, 300);
  assert.equal(end.mesh_downleft_dx, 100);
  assert.equal(end.mesh_downright_dx, -100);
});
