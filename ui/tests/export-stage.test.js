// 录制代理：复用 createStageGlobals 的形状，把动作写进时间线。
// Recording stage: the language sees the same globals, the timeline sees events.

import assert from "node:assert/strict";
import test from "node:test";

import { createAudioRecorder } from "../export-audio.js";
import { createVirtualClock, flushTasks } from "../export-clock.js";
import { stateAt, createTimeline } from "../export-timeline.js";
import {
  createRecordGlobals,
  createRecordingStage,
  DEFAULT_RECORDING,
  holdFor,
} from "../export-stage.js";
import { methodName, run } from "../pamela.js";
import { PAMELA_INTRO_MS } from "../pamela-intro.js";

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
  for (const name of ["Background", "Character", "Text", "Audio", "Effect", "Video", "Light", "Camera"]) {
    assert.equal(typeof built.stage[name], "function", name);
  }
  assert.equal(typeof built.dialog.say, "function");
});

test("stage.pamela() records a full intro, not just a jump in time", () => {
  const { clock, timeline, globals } = harness();
  const context = { pending: [] };
  const { stage } = globals(context);
  assert.equal(typeof stage.pamela, "function", "录制舞台也要有这个 API");
  stage.pamela();

  assert.equal(context.pending.length, 1, "解释器要等这段动画播完");
  const during = stateAt(timeline, 1500).pamelaIntro;
  assert.equal(during.active, true);
  assert.equal(during.start, 0);
  assert.equal(during.total, PAMELA_INTRO_MS);
  assert.equal(stateAt(timeline, PAMELA_INTRO_MS).pamelaIntro.active, false, "到点撤掉覆盖层");
  clock.tickMs(PAMELA_INTRO_MS);
  assert.equal(clock.now(), PAMELA_INTRO_MS, "成片里照常占用整段动画的时间");
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

test("Camera objects record one active view and tween their numbers", () => {
  const { clock, timeline, globals } = harness();
  const { stage } = globals({ pending: [] });

  const wide = stage.Camera(0, 0, -2000, 60);
  wide.enable();
  clock.tickMs(1000);
  const tele = stage.Camera(0, 0, -2000, 30);
  tele.enable();
  clock.tickMs(1000);

  assert.equal(stateAt(timeline, 500)["camera:camera-1"].active, true);
  assert.equal(stateAt(timeline, 1500)["camera:camera-1"].active, false);
  assert.equal(stateAt(timeline, 1500)["camera:camera-2"].active, true);
  assert.equal(stateAt(timeline, 1500)["camera:camera-2"].fov, 30);

  tele.fov(50, 400);
  assert.equal(stateAt(timeline, 2000)["camera:camera-2"].fov, 30);
  assert.equal(stateAt(timeline, 2200)["camera:camera-2"].fov, 40);
  assert.equal(stateAt(timeline, 2400)["camera:camera-2"].fov, 50);
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
  // 台词现在按顺序排队，一句还没说完时下一句不会开场；这里每种速度单独建一套
  // 录制舞台，专心看 autoVoice 的取值。
  const say = (speed, text) => {
    const clock = createVirtualClock();
    const timeline = createTimeline();
    const recorder = createAudioRecorder({ clock });
    const { stage } = createRecordGlobals({ clock, timeline }, { audioRecorder: recorder })(
      { pending: [] },
    );
    stage.autoVoice(speed);
    stage.say(text);
    return recorder;
  };

  assert.equal(say(6, "按六次每秒").events[0].speed, 6);
  assert.equal(say(99, "超界夹到十").events[0].speed, 10, "上限 10");
  assert.equal(
    say(0, "零表示关闭").events.some((event) => event.kind === "synth"),
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

test("文字的滤镜也写进时间线，enable 前后都保留并逐帧插值", () => {
  const { clock, timeline, globals } = harness();

  const early = globals({ pending: [], assignee: "early" }).stage.Text("早", 0, 0, 48, "#ffffff");
  early.blur(3);
  early.enable();
  assert.equal(stateAt(timeline, 0)["text:early"].look_blur, 3, "enable 前的滤镜不丢");

  const title = globals({ pending: [], assignee: "title" }).stage.Text("字", 0, 0, 48, "#ffffff");
  title.enable();
  title.blur(8, 1000).saturate(0.2, 1000);
  assert.equal(stateAt(timeline, 0)["text:title"].look_blur, 0, "带时长的滤镜从原样起步");

  clock.tickMs(500);
  const mid = stateAt(timeline, 500)["text:title"];
  assert.equal(mid.look_blur, 4, "模糊在 1 秒里从 0 到 8");
  assert.equal(mid.look_saturate, 0.6, "饱和度从 1 到 0.2");

  clock.tickMs(500);
  const done = stateAt(timeline, 1000)["text:title"];
  assert.equal(done.look_blur, 8);
  assert.equal(done.look_saturate, 0.2);
});

test("文字也能用 flush 复原四个滤镜", () => {
  const { timeline, globals } = harness();
  const { stage } = globals({ pending: [], assignee: "title" });
  const title = stage.Text("字", 0, 0, 48, "#ffffff");
  title.blur(4).brightness(0.5).contrast(2).saturate(0);
  title.flush(methodName("blur"), methodName("saturate"));

  const state = stateAt(timeline, 0)["text:title"];
  assert.equal(state.look_blur, 0);
  assert.equal(state.look_saturate, 1, "饱和度的原样是 1");
  assert.equal(state.look_brightness, 0.5, "未点名的滤镜留着");

  title.flush();
  const all = stateAt(timeline, 0)["text:title"];
  assert.equal(all.look_brightness, 1);
  assert.equal(all.look_contrast, 1);
});

test("flush 在录制里复原效果，给时间就成为一次过渡", () => {
  const { timeline, globals } = harness();
  const { stage } = globals({ pending: [] });

  const hero = stage.Character("hero.png");
  hero.scale(2).blur(4).rgb(20, 0, 0).move(300, -200).alpha(0.5);
  hero.flush(
    methodName("scale"),
    methodName("blur"),
    methodName("rgb"),
    methodName("move"),
    methodName("alpha"),
    1000,
  );

  const mid = stateAt(timeline, 500)["character:character"];
  assert.equal(mid.scale, 1.5, "倍率 2 → 1 的一半");
  assert.equal(mid.look_blur, 2);
  assert.equal(mid.tint_r, 10);
  assert.equal(mid.x, 150);
  assert.equal(mid.opacity, 0.75);

  const done = stateAt(timeline, 1000)["character:character"];
  assert.equal(done.scale, 1);
  assert.equal(done.look_blur, 0);
  assert.equal(done.tint_r, 0);
  assert.equal(done.x, 0);
  assert.equal(done.opacity, 1);
});

test("flush 不写名字时这一层的全部效果一起复原，而且立刻生效", () => {
  const { timeline, globals } = harness();
  const { stage } = globals({ pending: [] });

  const hero = stage.Character("hero.png");
  hero.scale(2).rotate(45).blur(4).rgb(20, 10, 0).alpha(0.5);
  hero.flush();

  const state = stateAt(timeline, 0)["character:character"];
  assert.equal(state.scale, 1);
  assert.equal(state.rotation, 0);
  assert.equal(state.look_blur, 0);
  assert.equal(state.tint_r, 0);
  assert.equal(state.opacity, 1);
});

test("角色 hide().enable().show(ms) 在录制里渐显而非瞬现", () => {
  // 复现自动播放 / 导出时立绘直接显示、没有渐变的问题：录制路径曾把 show/hide
  // 别名成 enable/disable，而后者只切 visible、不碰透明度，于是 hide→enable→show
  // 在成片里落到全不透明的固定值，完全没有 0→1 的过渡。
  const { timeline, globals } = harness();
  const ch = globals({ pending: [], assignee: "ch" }).stage.Character("ch.png");
  ch.hide().enable().show(1500);

  const target = "character:ch";
  const start = stateAt(timeline, 0)[target];
  assert.equal(start.visible, true, "enable 后可见");
  assert.equal(start.opacity, 0, "上台时透明度为 0（hide 已压到 0）");

  const mid = stateAt(timeline, 750)[target];
  assert.ok(mid.opacity > 0 && mid.opacity < 1, "中途处于半透明渐变中");

  assert.equal(stateAt(timeline, 1500)[target].opacity, 1, "到时完全显示");
});

test("文字 enable(ms) 在录制里从透明渐显，而不是瞬间出现", () => {
  const { timeline, globals } = harness();
  const context = { pending: [], assignee: "title" };
  const title = globals(context).stage.Text("字", 0, 0, 48, "#ffffff");
  title.enable(2000);

  const target = "text:title";
  assert.equal(stateAt(timeline, 0)[target].visible, true, "enable 后可见");
  assert.equal(stateAt(timeline, 0)[target].opacity, 0, "带时长时从透明上台");
  const mid = stateAt(timeline, 1000)[target];
  assert.ok(mid.opacity > 0 && mid.opacity < 1, "中途处于半透明渐变中");
  assert.equal(stateAt(timeline, 2000)[target].opacity, 1, "到时完全显示");
  assert.equal(context.pending.length, 1, "解释器要等这次渐显跑完");
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

test("sayLine 把颜色标记从台词里去掉，分段另存给成片上色", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({ clock, timeline });
  recording.sayLine("旁白", "这里的{red}重要文本{/red}", {});

  const first = stateAt(timeline, 0);
  assert.equal(first.dialogue.text, "这里的重要文本", "标记不进文本");
  assert.deepEqual(first.dialogue.runs, [
    { text: "这里的", color: null },
    { text: "重要文本", color: "red" },
  ]);
  // 字数只数看得见的字：逐字揭示的终点是 7（标记不算）。
  assert.equal(
    stateAt(timeline, DEFAULT_RECORDING.typewriterMs).dialogue.revealed,
    7,
  );

  clock.tickMs(5000);
});

test("没有颜色标记的台词分段里也没有颜色", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({ clock, timeline });
  recording.sayLine("旁白", "一句普通台词", { time: 900 });
  assert.deepEqual(stateAt(timeline, 0).dialogue.runs, [
    { text: "一句普通台词", color: null },
  ]);
  clock.tickMs(900);
});

test("彩色台词之后的一句普通台词不会沿用上一句的颜色", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({ clock, timeline });
  recording.sayLine("旁白", "{红}红字{/}", { time: 900 });
  clock.tickMs(900);
  // 上一句的停留刚到期，队列在微任务里放开；下一句才轮到。
  await flushTasks();
  recording.sayLine("旁白", "普通台词", { time: 900 });

  const next = stateAt(timeline, 900);
  assert.equal(next.dialogue.text, "普通台词");
  assert.deepEqual(next.dialogue.runs, [{ text: "普通台词", color: null }]);
  clock.tickMs(900);
});

test("sayLine 的逐字速度由录制层 config.typewriterMs 控制", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  // 菜单把「文字显示速度」透传成 typewriterMs：200 比整句停留短，所以全部揭示
  // 在 200ms 内完成，而不是录制层内置的 420ms 默认。
  const recording = createRecordingStage({ clock, timeline, config: { typewriterMs: 200 } });
  recording.sayLine("旁白", "你好世界", { time: 1200 });
  assert.equal(stateAt(timeline, 0).dialogue.revealed, 0);
  assert.equal(stateAt(timeline, 200).dialogue.revealed, 4, "快档在 200ms 内显完");
});

test("sayLine 显式配音：停顿点取文字与语音较晚者再加 800ms", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({
    clock,
    timeline,
    onVoiceDuration: async () => 3000,
  });
  const waiting = recording.sayLine("旁白", "你好世界", { time: 1200, audio: "vo" });
  // 配音时长还没解析时不排定 hold：异步解析期间画面照常显示本句，不卡死帧循环。
  assert.equal(clock.pending(), 0, "解析前不排定 hold");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.pending(), 1, "解析后排出一条 hold");
  // 停顿点 = max(1200, 3000) + 800 = 3800ms，所以 1200ms 时仍未到期。
  clock.tickMs(1200);
  assert.equal(clock.pending(), 1, "1200ms 时还没到 3800ms 的停顿点");
  clock.tickMs(3800);
  await waiting;
  assert.equal(clock.pending(), 0);
});

test("sayLine 文本比语音长时以文本为准再加 800ms", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({
    clock,
    timeline,
    onVoiceDuration: async () => 500,
  });
  // 80 字 → holdFor 远大于 500ms；停顿点 = max(textDone, 500) + 800 = textDone + 800。
  const textDone = holdFor("字".repeat(80), {}, DEFAULT_RECORDING);
  const waiting = recording.sayLine("旁白", "字".repeat(80), { audio: "vo" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.pending(), 1);
  clock.tickMs(textDone + 800 - 1);
  assert.equal(clock.pending(), 1, "还差 1ms 不到期");
  clock.tickMs(textDone + 800);
  await waiting;
  assert.equal(clock.pending(), 0);
});

test("csayLine 接在上一句后面，已显示字数从上一句接着数", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({ clock, timeline });

  recording.sayLine("旁白", "你好，", { time: 300 });
  clock.tickMs(300);
  await flushTasks();
  recording.csayLine("旁白", "我是小明", { time: 400 });

  const at = stateAt(timeline, 300);
  assert.equal(at.dialogue.text, "你好，我是小明", "整句留在画面上");
  assert.equal(at.dialogue.revealed, 3, "前面三个字保持已显示，不被重放");
  clock.tickMs(400);
  assert.equal(stateAt(timeline, 700).dialogue.revealed, 7, "新增的四字写到末尾");
});

test("setAutoPause(0) 让成片里配音一结束就切句", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({
    clock,
    timeline,
    onVoiceDuration: async () => 1000,
  });
  recording.setAutoPause(0);
  const waiting = recording.sayLine("旁白", "你好世界", { time: 500, audio: "vo" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.pending(), 1);
  clock.tickMs(1000);
  await waiting;
  assert.equal(clock.pending(), 0, "语音结束时就是停顿点，不再多等 800ms");
});

test("sayLine 配音读不到 / 解不出时直接抛错中止导出", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recording = createRecordingStage({
    clock,
    timeline,
    onVoiceDuration: async () => {
      throw new Error("找不到配音 vo.wav");
    },
  });
  await assert.rejects(
    (async () => {
      const w = recording.sayLine("旁白", "你好", { audio: "vo" });
      await w;
    })(),
    /找不到配音 vo\.wav/,
  );
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

test("a character's say/csay read a trailing voice track by type, not by position", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createAudioRecorder({ clock });
  const { stage } = createRecordGlobals({ clock, timeline }, { audioRecorder: recorder })(
    { pending: [], assignee: "hero" },
  );
  const hero = stage.Character("hero.png");
  hero.name("小明").enable();

  hero.say("我来了", "Audio/vo.wav");
  assert.deepEqual(recorder.events.map((e) => e.kind), ["play"], "第二个实参是字符串时按配音名读取");
  assert.equal(stateAt(timeline, 0).dialogue.name, "小明");
  assert.equal(stateAt(timeline, 0).dialogue.text, "我来了");

  // 第一句按三字给 900ms 停留；走完并放开队列，第二句才轮到。
  clock.tickMs(900);
  await flushTasks();
  recorder.events.length = 0;
  hero.csay("接着说", 800, "Audio/vo.wav");
  assert.deepEqual(recorder.events.map((e) => e.kind), ["play"], "csay 与数字时间混写也能识别配音");
  assert.equal(stateAt(timeline, 900).dialogue.text, "我来了接着说", "csay 接在上一句后面");

  clock.tickMs(800);
  await flushTasks();
  recorder.events.length = 0;
  hero.say("最后一句", "Audio/vo.wav", 800);
  assert.deepEqual(recorder.events.map((e) => e.kind), ["play"], "配音写在时间前面同样成立");
});

test("a character's explicit voice suppresses autoVoice in export", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createAudioRecorder({ clock });
  const { stage } = createRecordGlobals({ clock, timeline }, { audioRecorder: recorder })(
    { pending: [], assignee: "hero" },
  );
  stage.autoVoice(true);
  const hero = stage.Character("hero.png");

  hero.say("我来了", "Audio/vo.wav");
  assert.deepEqual(
    recorder.events.map((e) => e.kind),
    ["play"],
    "显式配音优先，不再登记自动合成音效",
  );
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

test("a timed ambient change is a tween and holds the script", () => {
  const { clock, timeline } = harness();
  const stage = createRecordingStage({ clock, timeline });

  stage.setAmbient(0.4);
  const waiting = stage.setAmbient(1, 1000);
  assert.ok(waiting && typeof waiting.then === "function", "剧本要等这段过渡走完");
  assert.equal(stateAt(timeline, 0).ambient.value, 0.4, "从当前亮度起步");
  assert.equal(stateAt(timeline, 500).ambient.value, 0.7, "中途按线性插值");
  assert.equal(stateAt(timeline, 1000).ambient.value, 1);

  // 还在走的时候又调一次：新的一段从画面上正在显示的值起步，而不是旧目标。
  clock.tickMs(500);
  stage.setAmbient(0.2, 500);
  assert.ok(Math.abs(stateAt(timeline, 750).ambient.value - 0.45) < 1e-9);
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

test("the interpreter drives a Text look in the movie with Chinese aliases and @ time", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const globals = createRecordGlobals({ clock, timeline });

  // 一边让虚拟时钟往前走，一边推进解释器，直到整段演出结束。
  let done = false;
  const running = Promise.resolve()
    .then(() =>
      run(['title = Text("字")', "title.enable()", "title.模糊(8) @ 1000"].join("\n"), {
        globals,
        sleep: (ms) => clock.wait(ms),
      }),
    )
    .then(
      (value) => {
        done = true;
        return value;
      },
      (error) => {
        done = true;
        throw error;
      },
    );
  running.catch(() => {});
  await flushTasks();
  for (let step = 0; step < 200 && !done; step += 1) {
    clock.tick();
    await flushTasks();
  }
  const result = await running;
  assert.equal(result.error, undefined, result.error?.message);

  // 中文「模糊」与 `@ 1000` 都落到时间线：从 0 在 1 秒里插到 8。
  const doneState = stateAt(timeline, 1000)["text:title"];
  assert.equal(doneState.look_blur, 8);
  assert.equal(stateAt(timeline, 500)["text:title"].look_blur, 4);
});


test("del works on a recording object and takes the layer off the timeline", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const globals = createRecordGlobals({ clock, timeline });

  let done = false;
  const running = Promise.resolve()
    .then(() =>
      run(['hero = Character("hero.png")', "hero.enable()", "wait 500", "del hero"].join("\n"), {
        globals,
        sleep: (ms) => clock.wait(ms),
      }),
    )
    .then(
      (value) => {
        done = true;
        return value;
      },
      (error) => {
        done = true;
        throw error;
      },
    );
  running.catch(() => {});
  await flushTasks();
  for (let step = 0; step < 200 && !done; step += 1) {
    clock.tick();
    await flushTasks();
  }
  const result = await running;
  assert.equal(result.error, undefined, result.error?.message);

  assert.equal(stateAt(timeline, 0)["character:hero"].visible, true);
  assert.equal(stateAt(timeline, 499)["character:hero"].visible, true);
  assert.equal(
    stateAt(timeline, 500)["character:hero"].visible,
    false,
    "del 在当下把这一层收掉",
  );
});

test("a cue's line holds the next say back, as the player's dialogue queue does", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const globals = createRecordGlobals({ clock, timeline });

  // 第一句 10 个字：1150ms 的停留；后面的 say 写在 800ms 处，必须等到 1150ms
  // 才上屏，否则成片里两句会挤在一起（预览里是排队等前一句的）。
  const program = [
    'cue say("一二三四五六七八九十")',
    "wait 800",
    'say("后一句")',
  ].join("\n");

  let done = false;
  const running = Promise.resolve()
    .then(() => run(program, { globals, sleep: (ms) => clock.wait(ms) }))
    .then(
      (value) => {
        done = true;
        return value;
      },
      (error) => {
        done = true;
        throw error;
      },
    );
  running.catch(() => {});
  await flushTasks();
  // 按 10ms 步进：等待落在整毫秒上，方便断言台词换屏的时刻。
  for (let step = 0; step < 500 && !done; step += 1) {
    clock.tickMs(10);
    await flushTasks();
  }
  const result = await running;
  assert.equal(result.error, undefined, result.error?.message);

  assert.equal(stateAt(timeline, 0).dialogue.text, "一二三四五六七八九十");
  assert.equal(
    stateAt(timeline, 1149).dialogue.text,
    "一二三四五六七八九十",
    "前一句还没走完，后一句不能上屏",
  );
  assert.equal(stateAt(timeline, 1150).dialogue.text, "后一句");
  assert.equal(clock.now(), 1150 + 900, "后一句自己还要走 900ms 的停留");
});

test("Audio's enable / disable are recorded as play / stop, as on the stage", async () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const audioRecorder = createAudioRecorder({ clock });
  const globals = createRecordGlobals({ clock, timeline, audioRecorder });

  const result = await run(
    ['eff = Audio("Audio/咻.wav")', "eff.enable()", "eff.disable()"].join("\n"),
    { globals, sleep: (ms) => clock.wait(ms) },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.deepEqual(
    audioRecorder.events.map((event) => event.kind),
    ["play", "stop"],
    "声音的统一开关就是带淡变的 play / stop",
  );
});

test("key() stays a method: the timeline target name no longer shadows it", () => {
  const { globals } = harness();
  const built = globals({ assignee: "bg", pending: [] });
  const bg = built.stage.Background("bg.png");

  assert.equal(typeof bg.key, "function", "`key` 不能被时间线的目标名盖成字符串");
  assert.doesNotThrow(() => bg.key("key-bg.keyframes"));
});

test("画面轨把移动转给视频画面，不吞调用", () => {
  const { timeline, globals } = harness();
  const built = globals({ assignee: "vid", pending: [] });
  const vid = built.stage.Video("v.mp4");
  vid.enable();
  vid.media.moveTo(120, -40, 100);

  const state = stateAt(timeline, 0)["video:vid"];
  assert.equal(state.x, 120);
  assert.equal(state.y, -40);
  assert.equal(state.z, 100);
});

test("文字的「颜色」解析成 color，而不是图片的 hex", async () => {
  const { timeline, globals } = harness();
  const result = await run(
    ['title = Text("字")', 'title.颜色("#ff0000")'].join("\n"),
    { globals },
  );
  assert.equal(result.error, undefined, result.error?.message);

  const state = stateAt(timeline, 0)["text:title"];
  // 走 `color` 才写文字颜色；若错走 `hex`，改的会是调色（`tint_*`）而不是这里。
  assert.equal(state.color, "#ff0000");
  assert.equal(state.color_r, 255);
  assert.equal(state.tint_r, undefined, "文字没有调色，不该走 hex");
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
