// 录制代理：复用 createStageGlobals 的形状，把动作写进时间线。
// Recording stage: the language sees the same globals, the timeline sees events.

import assert from "node:assert/strict";
import test from "node:test";

import { createAudioRecorder } from "../export-audio.js";
import { createVirtualClock } from "../export-clock.js";
import { stateAt, createTimeline } from "../export-timeline.js";
import {
  createRecordGlobals,
  createRecordingStage,
  DEFAULT_RECORDING,
  holdFor,
} from "../export-stage.js";

function harness() {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  return { clock, timeline, globals: createRecordGlobals({ clock, timeline }) };
}

test("holdFor uses an explicit time and otherwise paces by character count", () => {
  assert.equal(holdFor("你好", { time: 250 }, DEFAULT_RECORDING), 250);
  assert.equal(holdFor("你好", {}, DEFAULT_RECORDING), DEFAULT_RECORDING.minLineMs);
  const long = "一".repeat(80);
  assert.equal(holdFor(long, {}, DEFAULT_RECORDING), 80 * DEFAULT_RECORDING.msPerCharacter + DEFAULT_RECORDING.linePaddingMs);
});

test("the recording globals have the shape the interpreter expects", () => {
  const { globals } = harness();
  const context = { pending: [] };
  const built = globals(context);
  assert.equal(built.stage.kind, "Stage");
  assert.equal(built.dialog.kind, "Dialog");
  for (const name of ["Background", "Character", "Text", "Audio", "Effect", "Video"]) {
    assert.equal(typeof built.stage[name], "function", name);
  }
  assert.equal(typeof built.dialog.say, "function");
});

test("stage.pamela() records a full three-second intro, not just a jump in time", () => {
  const { clock, timeline, globals } = harness();
  const context = { pending: [] };
  const { stage } = globals(context);
  assert.equal(typeof stage.pamela, "function", "录制舞台也要有这个 API");
  stage.pamela();

  assert.equal(context.pending.length, 1, "解释器要等这段动画播完");
  const during = stateAt(timeline, 1500).pamelaIntro;
  assert.equal(during.active, true);
  assert.equal(during.start, 0);
  assert.equal(during.total, 3000);
  assert.equal(stateAt(timeline, 3000).pamelaIntro.active, false, "到点撤掉覆盖层");
  clock.tickMs(3000);
  assert.equal(clock.now(), 3000, "成片里照常占用 3 秒");
});

test("Effect objects write particle state instead of a picture layer", () => {
  const { timeline, globals } = harness();
  const { stage } = globals({ pending: [] });

  const rain = stage.Effect("rain", 1, 1, 1, 1, 1);
  rain.enable();

  assert.deepEqual(Object.keys(stateAt(timeline, 0)), ["effect:effect-1"]);
  const state = stateAt(timeline, 0)["effect:effect-1"];
  assert.equal(state.kind, "rain");
  assert.equal(state.visible, true);
  assert.equal(state.playing, true);
  assert.equal(state.epoch, 1);
});

test("crood is a per-object timeline switch, hidden by default", () => {
  const { timeline, globals } = harness();
  const { stage } = globals({ pending: [], assignee: "hero" });
  const hero = stage.Character("hero.png");
  hero.enable();

  assert.equal(stateAt(timeline, 0)["character:hero"].crood, false, "默认隐藏");
  hero.crood(true);
  assert.equal(stateAt(timeline, 0)["character:hero"].crood, true);
  hero.crood(false);
  assert.equal(stateAt(timeline, 0)["character:hero"].crood, false);
});

test("a text's colour is recorded as channels, so the movie fades it", () => {
  const { clock, timeline, globals } = harness();
  const { stage } = globals({ pending: [], assignee: "title" });
  const title = stage.Text("字", 0, 0, 48, "#000000");
  title.enable();
  title.color("#ffffff", 1000);

  // 通道从旧色开始插值；`color` 字符串本身是这次调用的目标，渲染端只在
  // `colorIsRgb` 为 false 时才读它。
  const start = stateAt(timeline, 0)["text:title"];
  assert.equal(start.color_r, 0);
  assert.equal(start.color_g, 0);
  assert.equal(start.color_b, 0);

  const mid = stateAt(timeline, 500)["text:title"];
  assert.equal(mid.colorIsRgb, true);
  assert.equal(Math.round(mid.color_r), 128);

  clock.tickMs(1000);
  const end = stateAt(timeline, 1000)["text:title"];
  assert.equal(end.color, "#ffffff");
  assert.equal(end.color_r, 255);
});

test("crood written before enable survives it, and a light has its own switch", () => {
  const { timeline, globals } = harness();
  const early = globals({ pending: [], assignee: "early" }).stage.Character("early.png");
  early.crood(true);
  early.enable();
  assert.equal(stateAt(timeline, 0)["character:early"].crood, true, "enable 前写下的开关不丢");

  const lamp = globals({ pending: [], assignee: "lamp" }).stage.Light("FFD9A0");
  lamp.enable();
  assert.equal(stateAt(timeline, 0)["light:lamp"].crood, false);
  lamp.crood(true);
  assert.equal(stateAt(timeline, 0)["light:lamp"].crood, true);
});

test("audio and effects accept crood without inventing axes", () => {
  const { globals } = harness();
  const { stage } = globals({ pending: [], assignee: "rain" });
  const rain = stage.Effect("rain", 1, 1, 1, 1, 1);
  assert.equal(rain.crood(true), rain, "没有三维坐标的对象也接得住这个开关");
  assert.equal(rain.crood(false), rain);
});

test("stage.autoVoice 开时，无配音的 say 登记合成效果音；显式配音优先", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createAudioRecorder({ clock });
  const { stage } = createRecordGlobals({ clock, timeline }, { audioRecorder: recorder })(
    { pending: [] },
  );
  stage.autoVoice(true);
  stage.say("这是一段文本");
  const synth = recorder.events.filter((event) => event.kind === "synth");
  assert.equal(synth.length, 1, "无配音的台词登记一次合成效果音");
  assert.equal(synth[0].chars, 6);
  assert.equal(synth[0].speed, 10, "默认速度 10 次/秒");

  // 显式配音优先：不会再记合成效果音。
  recorder.events.length = 0;
  stage.say("有配音的一句", 0, "vo");
  assert.equal(
    recorder.events.some((event) => event.kind === "synth"),
    false,
    "audio 优先于 autoVoice",
  );
});

test("stage.autoVoice 的整数参数控制播放速度，超界会被夹到 1~10", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createAudioRecorder({ clock });
  const { stage } = createRecordGlobals({ clock, timeline }, { audioRecorder: recorder })(
    { pending: [] },
  );

  stage.autoVoice(6);
  stage.say("按六次每秒");
  assert.equal(recorder.events[0].speed, 6);

  recorder.events.length = 0;
  stage.autoVoice(99);
  stage.say("超界夹到十");
  assert.equal(recorder.events[0].speed, 10, "上限 10");

  recorder.events.length = 0;
  stage.autoVoice(0);
  stage.say("零表示关闭");
  assert.equal(
    recorder.events.some((event) => event.kind === "synth"),
    false,
    "autoVoice(0) 关闭自动配音",
  );
});

test("translucent 是一个录制状态：角色默认挡光，其余类型默认透光", () => {
  const { timeline, globals } = harness();
  const hero = globals({ pending: [], assignee: "hero" }).stage.Character("hero.png");
  hero.enable();
  assert.equal(stateAt(timeline, 0)["character:hero"].lightPass, false, "角色默认挡光");

  hero.translucent();
  assert.equal(stateAt(timeline, 0)["character:hero"].lightPass, true);
  hero.translucent(false);
  assert.equal(stateAt(timeline, 0)["character:hero"].lightPass, false);

  const bg = globals({ pending: [], assignee: "bg" }).stage.Background("bg.png");
  bg.enable();
  assert.equal(stateAt(timeline, 0).background.lightPass, true, "背景画的是整个世界，默认透光");
});

test("rim 是一个录制状态：默认 0，写下的强度进时间线", () => {
  const { timeline, globals } = harness();
  const hero = globals({ pending: [], assignee: "hero" }).stage.Character("hero.png");
  hero.enable();
  assert.equal(stateAt(timeline, 0)["character:hero"].rim, 0, "默认不勾边");

  hero.rim(0.7);
  assert.equal(stateAt(timeline, 0)["character:hero"].rim, 0.7);
  hero.rim(5);
  assert.equal(stateAt(timeline, 0)["character:hero"].rim, 1, "超界夹到 1");
  hero.rim(0);
  assert.equal(stateAt(timeline, 0)["character:hero"].rim, 0, "0 就是关掉");
});

test("aa / eaa 是录制状态：角色默认 0，强度进时间线", () => {
  const { timeline, globals } = harness();
  const hero = globals({ pending: [], assignee: "hero" }).stage.Character("hero.png");
  hero.enable();
  assert.equal(stateAt(timeline, 0)["character:hero"].smooth, 0, "默认整图不处理");
  assert.equal(stateAt(timeline, 0)["character:hero"].edgeSmooth, 0, "默认边缘也不处理");

  assert.equal(hero.aa(1.2), hero);
  assert.equal(stateAt(timeline, 0)["character:hero"].smooth, 1.2);
  hero.aa(9);
  assert.equal(stateAt(timeline, 0)["character:hero"].smooth, 2, "超界夹到 2");
  hero.aa();
  assert.equal(stateAt(timeline, 0)["character:hero"].smooth, 0, "省略按 0");

  hero.eaa(0.6);
  assert.equal(stateAt(timeline, 0)["character:hero"].edgeSmooth, 0.6);
  assert.equal(stateAt(timeline, 0)["character:hero"].smooth, 0, "两档各记各的");
});

test("enable 前写下的抗锯齿不丢", () => {
  const { timeline, globals } = harness();
  const early = globals({ pending: [], assignee: "early" }).stage.Character("early.png");
  early.eaa(1.5);
  early.enable();
  assert.equal(stateAt(timeline, 0)["character:early"].edgeSmooth, 1.5, "enable 前写下的不丢");
});

test("enable 前写下的轮廓光不丢，灯与粒子也接得住这个方法", () => {
  const { timeline, globals } = harness();
  const early = globals({ pending: [], assignee: "early" }).stage.Character("early.png");
  early.rim(0.4);
  early.enable();
  assert.equal(stateAt(timeline, 0)["character:early"].rim, 0.4, "enable 前写下的开关不丢");

  const lamp = globals({ pending: [], assignee: "lamp" }).stage.Light("FFD9A0");
  assert.equal(lamp.rim(), lamp, "光源没有轮廓可勾，方法只为同名而存在");

  const rain = globals({ pending: [], assignee: "rain" }).stage.Effect("rain", 1, 1, 1, 1, 1);
  assert.equal(rain.rim(0.5), rain, "粒子同样接得住");
});

test("enable 前写下的透光不丢，灯与粒子也接得住这个方法", () => {
  const { timeline, globals } = harness();
  const early = globals({ pending: [], assignee: "early" }).stage.Character("early.png");
  early.translucent(true);
  early.enable();
  assert.equal(stateAt(timeline, 0)["character:early"].lightPass, true, "enable 前写下的开关不丢");

  const lamp = globals({ pending: [], assignee: "lamp" }).stage.Light("FFD9A0");
  assert.equal(lamp.translucent(), lamp, "光源自己不挡光，方法只为同名而存在");

  const rain = globals({ pending: [], assignee: "rain" }).stage.Effect("rain", 1, 1, 1, 1, 1);
  assert.equal(rain.translucent(true), rain, "粒子同样接得住");
});

test("Text records its words and styles on a text: layer", () => {
  const { timeline, globals } = harness();
  const context = { pending: [], assignee: "title" };
  const { stage } = globals(context);

  const title = stage.Text("你好", 100, -200, 64, "#ffd479");
  title.enable();

  const state = stateAt(timeline, 0)["text:title"];
  assert.equal(state.visible, true);
  assert.equal(state.text, "你好");
  assert.equal(state.size, 64);
  assert.equal(state.color, "#ffd479");
  assert.equal(state.x, 100, "构造位置是成片第一帧的位置");
  assert.equal(state.y, -200);

  title.moveTo(0, 0, undefined, 1000);
  assert.equal(stateAt(timeline, 500)["text:title"].x, 50, "移动照常插值");
  assert.equal(stateAt(timeline, 1000)["text:title"].x, 0);

  title.font("宋体");
  assert.equal(stateAt(timeline, 1000)["text:title"].fontFamily, "宋体");
  title.font("");
  assert.equal(stateAt(timeline, 1000)["text:title"].fontFamily, "", "空串是默认字体");

  assert.equal(state.fontWeight, 400, "不写字重时是常规");
  title.weight(700);
  assert.equal(stateAt(timeline, 1000)["text:title"].fontWeight, 700, "字重同样立即记录");
});

test("a sprite group records its list, speed and pause instead of one event per frame", () => {
  const { clock, timeline, globals } = harness();
  const context = { pending: [], assignee: "cg" };
  const { stage } = globals(context);

  const cg = stage.Character();
  cg.group("a.png", "b.png", "c.png");
  cg.enable();
  assert.equal(stateAt(timeline, 0)["character:cg"].path, "a.png", "group 之后停在第 1 张");

  const waiting = context.pending.length;
  cg.fps(10);
  const playing = stateAt(timeline, 0)["character:cg"];
  assert.equal(playing.groupPlaying, true);
  assert.equal(playing.groupFps, 10);
  assert.deepEqual(playing.group, ["a.png", "b.png", "c.png"]);
  assert.equal(context.pending.length, waiting + 1, "一遍播放要等它播完");

  // 10 fps、三张：一遍 300 毫秒。导出里由虚拟时钟推进，那一刻暂停算出的就是第 3 张。
  clock.tickMs(300);
  cg.pause();
  const paused = stateAt(timeline, 300)["character:cg"];
  assert.equal(paused.groupPlaying, false);
  assert.equal(paused.path, "c.png");

  cg.add("a.png", "a2.png");
  assert.deepEqual(stateAt(timeline, 300)["character:cg"].group, ["a.png", "a2.png", "b.png", "c.png"]);
  cg.remove(0);
  assert.deepEqual(stateAt(timeline, 300)["character:cg"].group, ["a2.png", "b.png", "c.png"]);
  cg.update("b.png", "b2.png");
  assert.deepEqual(stateAt(timeline, 300)["character:cg"].group, ["a2.png", "b2.png", "c.png"]);
  assert.equal(cg.element(0), "a2.png");
});

test("a looping sprite does not wait in the recording, or the export would never end", () => {
  const { timeline, globals } = harness();
  const context = { pending: [], assignee: "cg" };
  const { stage } = globals(context);

  const cg = stage.Character();
  cg.group("a.png", "b.png");
  cg.enable();
  const waiting = context.pending.length;
  cg.fps(16, true);
  assert.equal(context.pending.length, waiting, "循环播放不往 pending 里塞等待");
  assert.equal(stateAt(timeline, 0)["character:cg"].groupPlaying, true);
});

test("filters and tint are recorded for pictures instead of being dropped", () => {
  const { timeline, globals } = harness();
  const { stage } = globals({ pending: [] });

  const hero = stage.Character("hero.png");
  hero.blur(4).brightness(1.2).saturate(0.5);
  hero.rgb(20, -10, 0);

  const state = stateAt(timeline, 0)["character:character"];
  assert.deepEqual(state.look, { blur: 4, brightness: 1.2, contrast: 1, saturate: 0.5 });
  assert.deepEqual(state.tint, { r: 20, g: 0, b: 0 }, "负偏移夹到 0");

  hero.hex("#336699");
  assert.deepEqual(stateAt(timeline, 0)["character:character"].tint, { r: 51, g: 102, b: 153 });

  hero.rgbTo(10, 20, 30);
  assert.deepEqual(stateAt(timeline, 0)["character:character"].tint, { r: 10, g: 20, b: 30 });
});

test("filter and tint transitions interpolate on the timeline", () => {
  const { timeline, globals } = harness();
  const { stage } = globals({ pending: [] });

  const hero = stage.Character("hero.png");
  hero.blur(4, 1000);
  hero.rgb(20, 0, 0, 1000);

  const mid = stateAt(timeline, 500)["character:character"];
  assert.equal(mid.look_blur, 2, "模糊在 1 秒里从 0 到 4");
  assert.equal(mid.tint_r, 10, "红色偏移在 1 秒里从 0 到 20");

  const done = stateAt(timeline, 1000)["character:character"];
  assert.equal(done.look_blur, 4);
  assert.equal(done.tint_r, 20);
});

test("Audio objects go to the recorder instead of the timeline", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createAudioRecorder({ clock });
  const globals = createRecordGlobals({ clock, timeline }, { audioRecorder: recorder });
  const { stage } = globals({ pending: [], assignee: "bgm" });

  const bgm = stage.Audio("bgm.mp3", 0.3, true);
  bgm.play(400);
  bgm.loop();
  assert.equal(recorder.sounds.size, 1);
  assert.deepEqual(
    recorder.events.map((event) => event.kind),
    ["play", "loop"],
  );
  // 声音不进时间线：画面状态里没有任何 audio 字段。
  assert.equal(stateAt(timeline, 0).audio, undefined);
});

test("a line with a voice track tells the recorder to play it", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createAudioRecorder({ clock });
  const globals = createRecordGlobals({ clock, timeline }, { audioRecorder: recorder });
  const { stage } = globals({ pending: [], assignee: "配音" });
  stage.Audio("vo.mp3");

  stage.say("你好", 800, "配音");
  assert.deepEqual(
    recorder.events.map((event) => event.kind),
    ["play"],
    "台词开始处登记一次配音播放",
  );
});

test("sayLine writes a line, a typewriter tween and a timed hold", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({ clock, timeline });
  const waiting = recording.sayLine("旁白", "你好世界", { time: 1200 });
  assert.ok(waiting && typeof waiting.then === "function");
  assert.equal(clock.pending(), 1);

  const first = stateAt(timeline, 0);
  assert.equal(first.dialogue.text, "你好世界");
  assert.equal(first.dialogue.name, "旁白");
  assert.equal(first.dialogue.visible, true);
  assert.equal(first.dialogue.revealed, 0);
  assert.equal(stateAt(timeline, DEFAULT_RECORDING.typewriterMs).dialogue.revealed, 4);
  clock.tickMs(1200);
  await waiting;
  assert.equal(clock.pending(), 0);
});

test("recorded objects stay chainable and write tweens to the timeline", () => {
  const { clock, timeline, globals } = harness();
  const context = { assignee: "bg", pending: [] };
  const built = globals(context);
  const bg = built.stage.Background("bg.png");
  assert.equal(bg.kind, "Background");
  assert.equal(bg.then, undefined, "a recorded object must not look like a Promise");
  assert.equal(bg.enable().moveTo(120, -40, undefined, 300), bg);

  assert.equal(stateAt(timeline, 0).background.visible, true);
  assert.equal(stateAt(timeline, 0).background.x, 0);
  assert.equal(stateAt(timeline, 150).background.x, 60);
  assert.equal(stateAt(timeline, 300).background.x, 120);
  assert.equal(context.pending.length, 1, "the timed move joins context.pending");
  assert.equal(clock.pending(), 1);
});

test("rotate turns by its angle and scale compounds the size already held", () => {
  const { clock, timeline, globals } = harness();
  const built = globals({ assignee: "hero", pending: [] });
  const hero = built.stage.Character("hero.png");
  hero.enable().rotateTo(90).rotate(-45, 300).scaleTo(1.5).scale(2);
  clock.tickMs(300);

  const at = stateAt(timeline, 300)["character:hero"];
  assert.equal(at.rotation, 45, "rotate(-45) turns back from the 90 set before it");
  assert.equal(at.scale, 3, "scale(2) compounds onto the 1.5 set before it");
});

test("a character keeps its speaker name for say()", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "hero", pending: [] });
  const hero = built.stage.Character("hero.png");
  hero.name("小明").enable().say("我来了", 0);
  assert.equal(stateAt(timeline, 0).dialogue.name, "小明");
  assert.equal(stateAt(timeline, 0).dialogue.text, "我来了");
});

test("a free transform records one tween per control point and accumulates", () => {
  const { clock, timeline, globals } = harness();
  const built = globals({ assignee: "hero", pending: [] });
  const hero = built.stage.Character("hero.png");
  hero.enable().transform.upright(300, 300, 1000);
  clock.tickMs(1000);
  assert.equal(hero.transform.upright(100, -50, 500), hero);

  const at = (t) => stateAt(timeline, t)["character:hero"];
  assert.equal(at(500).mesh_upright_dx, 150);
  assert.equal(at(1000).mesh_upright_dx, 300);
  assert.equal(at(1000).mesh_upright_dy, 300);
  assert.equal(at(1250).mesh_upright_dx, 350);
  assert.equal(at(1500).mesh_upright_dx, 400);
  assert.equal(at(1500).mesh_upright_dy, 250);
  assert.equal(at(1500).mesh_upleft_dx ?? 0, 0, "没被拉动的点保持原位");
});

test("an absolute point target is measured against the decoded picture rect", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const assets = new Map([["hero.png", { width: 600, height: 900 }]]);
  const globals = createRecordGlobals({
    clock,
    timeline,
    assets,
    config: { width: 1920, height: 1080 },
  });
  const built = globals({ assignee: "hero", pending: [] });
  const hero = built.stage.Character("hero.png");
  hero.enable().transform.uprightTo(400, 300, 500);

  // contain: 600×900 → 720×1080，右上角原本在 (360, 540)。
  assert.equal(stateAt(timeline, 250)["character:hero"].mesh_upright_dx, 20);
  const end = stateAt(timeline, 500)["character:hero"];
  assert.equal(end.mesh_upright_dx, 40);
  assert.equal(end.mesh_upright_dy, -240);
});

test("an absolute point target accounts for the current pose", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const assets = new Map([["hero.png", { width: 1000, height: 1000 }]]);
  const globals = createRecordGlobals({ clock, timeline, assets });
  const built = globals({ assignee: "hero", pending: [] });
  const hero = built.stage.Character("hero.png");
  hero.enable().scale(0.5, 0).moveTo(100, 0, 0, 0).transform.uprightTo(670, 570, 0);

  // contain: 1000×1000 → 1080×1080；scale(0.5) → (270,270)，加 x → (370,270)。
  // 目标 (670,570) 因此是 (300,300) 的世界偏移，与舞台一致。
  const at = stateAt(timeline, 0)["character:hero"];
  assert.equal(at.mesh_upright_dx, 300);
  assert.equal(at.mesh_upright_dy, 300);
});

test("step() freezes a gif frame on the timeline", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "hero", pending: [] });
  const hero = built.stage.Character("hero.gif");
  hero.enable().step(3);
  assert.equal(stateAt(timeline, 0)["character:hero"].frame, 3);
  hero.step(0);
  assert.equal(stateAt(timeline, 0)["character:hero"].frame, 0);
});

// --- lights ---

test("a Light records a light: state instead of a picture layer", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "lamp", pending: [] });

  const lamp = built.stage.Light("FFD9A0", 1.5, 200, -100, 0.8, 90, 600, 0.3, 0.2, 300, 35, 60);

  const start = stateAt(timeline, 0)["light:lamp"];
  assert.equal(start.color, "FFD9A0");
  assert.equal(start.intensity, 1.5);
  assert.equal(start.x, 200);
  assert.equal(start.y, -100);
  assert.equal(start.opacity, 0.8);
  assert.equal(start.spread, 90);
  assert.equal(start.range, 600);
  assert.equal(start.bloom, 0.3);
  assert.equal(start.soft, 0.2);
  assert.equal(start.z, 300);
  assert.equal(start.rotateH, 35);
  assert.equal(start.rotateV, 60);
  assert.equal(start.width, 0, "a light without a width is a point light");
  assert.equal(start.visible, false, "a lamp is nothing until enable()");

  lamp.width(760);
  assert.equal(stateAt(timeline, 0)["light:lamp"].width, 760);

  lamp.enable();
  assert.equal(stateAt(timeline, 0)["light:lamp"].visible, true);
});

test("a light's numbers are tweened on the timeline like any other state", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "lamp", pending: [] });
  const lamp = built.stage.Light("FFFFFF", 1);
  lamp.enable().intensity(2, 1000).spread(60, 1000).width(800, 1000);

  assert.equal(stateAt(timeline, 500)["light:lamp"].intensity, 1.5);
  assert.equal(stateAt(timeline, 500)["light:lamp"].spread, 210);
  assert.equal(stateAt(timeline, 500)["light:lamp"].width, 400);
  assert.equal(stateAt(timeline, 1000)["light:lamp"].intensity, 2);
  assert.equal(stateAt(timeline, 1000)["light:lamp"].spread, 60);
  assert.equal(stateAt(timeline, 1000)["light:lamp"].width, 800);
});

test("exclude writes the target's own state key, and unexclude takes it back", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "lamp", pending: [] });
  const lamp = built.stage.Light("FFFFFF", 1);

  const hero = globals({ assignee: "hero", pending: [] }).stage.Character("hero.png");
  hero.enable();
  built.stage.exclude([lamp], [hero]);

  assert.deepEqual(stateAt(timeline, 0)["light:lamp"].excluded, ["character:hero"]);
  built.stage.unexclude([lamp], [hero]);
  assert.deepEqual(stateAt(timeline, 0)["light:lamp"].excluded, []);
});

test("the ambient brightness is a state of its own", () => {
  const { clock, timeline } = harness();
  createRecordingStage({ clock, timeline }).setAmbient(0.35);
  assert.equal(stateAt(timeline, 0).ambient.value, 0.35);
});

test("perspective and guideline are stage-wide states, recorded like ambient", () => {
  const { clock, timeline } = harness();
  const stage = createRecordingStage({ clock, timeline });

  assert.equal(stateAt(timeline, 0).perspective, undefined, "默认什么都不写");

  stage.setPerspective(true);
  assert.equal(stateAt(timeline, 0).perspective.value, true);

  stage.setGuideline(true);
  assert.equal(stateAt(timeline, 0).guideline.value, true);
  assert.equal(stateAt(timeline, 0).guideline.interval, undefined, "省略间隔时交给渲染端的默认值");

  stage.setGuideline(true, 200);
  assert.equal(stateAt(timeline, 0).guideline.interval, 200);

  // 关掉参考线只改开关：间隔留着，下一次打开还是同一个密度。
  stage.setGuideline(false);
  assert.equal(stateAt(timeline, 0).guideline.value, false);
  assert.equal(stateAt(timeline, 0).guideline.interval, 200);
});

test("a backdrop is recorded one step deeper than a character", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "bg", pending: [] });
  built.stage.Background("street.png").enable();
  const hero = globals({ assignee: "hero", pending: [] }).stage.Character("hero.png");
  hero.enable();

  assert.ok(
    stateAt(timeline, 0).background.z > stateAt(timeline, 0)["character:hero"].z,
    "背景比角色更远，导出时先画",
  );
  assert.equal(stateAt(timeline, 0).background.z, 1);
});

test("h / v are recorded exactly like x / y", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "hero", pending: [] });
  const hero = built.stage.Character("hero.png");
  hero.enable().hTo(100).h(40).vTo(-60).v(-20);

  const state = stateAt(timeline, 0)["character:hero"];
  assert.equal(state.x, 140);
  assert.equal(state.y, -80);
});
