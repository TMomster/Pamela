// 离屏渲染后端测试：几何、CJK 断行、假 ctx 的绘制调用序列。
// Canvas2D backend: geometry, wrapping, and recorded draw calls.

import assert from "node:assert/strict";
import test from "node:test";

import { createExportMetrics } from "../export-metrics.js";
import {
  createCanvasRenderer,
  fitRect,
  lookString,
  meshNodes,
  wrapText,
} from "../export-render.js";

test("depth pulls a picture towards the centre and shrinks it", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", bitmap(600, 900)]]),
  });
  renderer.render({
    perspective: { value: true },
    "character:hero": { path: "hero.png", visible: true, x: 300, z: 1000 },
  });
  const flat = 2000 / 3000;
  const translate = calls.find((call) => call[0] === "translate");
  const scale = calls.find((call) => call[0] === "scale");
  assert.equal(translate[1], canvas.width / 2 + 300 * flat);
  assert.equal(translate[2], canvas.height / 2);
  assert.equal(scale[1], flat);
});

test("without perspective a picture keeps its size at any depth", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", bitmap(600, 900)]]),
  });
  renderer.render({ "character:hero": { path: "hero.png", visible: true, x: 300, z: 1000 } });
  // 正交空间：深度只决定谁盖住谁，不改变位置与大小。
  const translate = calls.find((call) => call[0] === "translate");
  const scale = calls.find((call) => call[0] === "scale");
  assert.equal(translate[1], canvas.width / 2 + 300);
  assert.equal(translate[2], canvas.height / 2);
  assert.equal(scale[1], 1);
});

test("stage.pamela() paints the black cover and the title during the three seconds", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({ canvas, assets: new Map() });
  renderer.render({ pamelaIntro: { active: true, start: 0, total: 3000 } }, 2200);
  assert.ok(
    calls.some((call) => call[0] === "fillRect" && call[3] === canvas.width && call[4] === canvas.height),
    "黑幕盖住整个镜头",
  );
  assert.ok(
    calls.some((call) => call[0] === "fillText" && call[1] === "Made with Pamela"),
    "成片里也有 Made with Pamela",
  );
});

test("an inactive pamelaIntro is neither painted nor mistaken for a picture", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({ canvas, assets: new Map() });
  renderer.render({ pamelaIntro: { active: false, start: 0, total: 3000 } }, 3000);
  assert.equal(calls.filter((call) => call[0] === "fillText").length, 0);
  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 0);
});

test("guideline lines are painted when the stage asks for them", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({ canvas, assets: new Map() });
  renderer.render({});
  const plain = calls.length;

  renderer.render({ guideline: { value: true, interval: 100 } });
  assert.ok(calls.length > plain, "参考线要多画几条线段");
  assert.ok(
    calls.some((call) => call[0] === "moveTo" || call[0] === "lineTo"),
    "参考线要落到画布上",
  );
});

test("a picture turned out of the stage plane is painted as two clipped triangles", () => {
  const hero = bitmap(600, 900);
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", hero]]),
  });
  renderer.render({ "character:hero": { path: "hero.png", visible: true, rotateH: 50 } });
  // 透视后的四边形不是仿射，`drawImage` 只能逐片贴：两片、各裁剪一次。
  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 2);
  assert.equal(calls.filter((call) => call[0] === "clip").length, 2);
  assert.equal(calls.some((call) => call[0] === "rotate"), false, "不再走纯旋转那条路");
});

test("a picture that never leaves the stage plane keeps the one-pass fast path", () => {
  const hero = bitmap(600, 900);
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", hero]]),
  });
  // 转过整整一圈等于没转：仍然是躺在 W 面里的那张纸，一笔画完。
  renderer.render({ "character:hero": { path: "hero.png", visible: true, rotateH: 360 } });
  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 1);
  assert.equal(calls.filter((call) => call[0] === "clip").length, 0);
});

test("the backdrop shares one order with the characters", () => {
  const street = bitmap(1920, 1080);
  const hero = bitmap(600, 900);
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["street.png", street], ["hero.png", hero]]),
  });
  const drawn = () =>
    calls.filter((call) => call[0] === "drawImage").map((call) => call[1]);

  // 角色写在前面，序号却要按 z：深背景先画、近角色后画。
  renderer.render({
    "character:hero": { path: "hero.png", visible: true, z: 0 },
    background: { path: "street.png", visible: true, z: 600 },
  });
  assert.deepEqual(drawn(), [street, hero]);

  // 背景拉到观众前面，就盖住角色，舞台的 z-index 也是同一个次序。
  calls.length = 0;
  renderer.render({
    background: { path: "street.png", visible: true, z: -80 },
    "character:hero": { path: "hero.png", visible: true, z: 0 },
  });
  assert.deepEqual(drawn(), [hero, street]);
});

test("on an equal depth the backdrop is painted before the characters", () => {
  const street = bitmap(1920, 1080);
  const hero = bitmap(600, 900);
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["street.png", street], ["hero.png", hero]]),
  });
  renderer.render({
    "character:hero": { path: "hero.png", visible: true },
    background: { path: "street.png", visible: true },
  });
  const drawn = calls.filter((call) => call[0] === "drawImage").map((call) => call[1]);
  assert.deepEqual(drawn, [street, hero], "z 相同也保持「背景在下」");
});

test("pictures are painted from the back to the front", () => {
  const back = bitmap(200, 200);
  const front = bitmap(200, 200);
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["back.png", back], ["front.png", front]]),
  });
  renderer.render({
    "character:a": { path: "back.png", visible: true, z: 900 },
    "character:b": { path: "front.png", visible: true, z: -100 },
  });
  const drawn = calls.filter((call) => call[0] === "drawImage").map((call) => call[1]);
  assert.deepEqual(drawn, [back, front], "the deeper picture is painted first");
});

test("mesh points live in stage space, so scale does not shrink a pull", () => {
  const rect = fitRect(1000, 1000, 1920, 1080, "contain");
  const plain = meshNodes({ path: "hero.png", scale: 1 }, rect);
  const small = meshNodes({ path: "hero.png", scale: 0.5 }, rect);
  const pulled = meshNodes(
    { path: "hero.png", x: 100, scale: 0.5, mesh_upright_dx: 300, mesh_upright_dy: 300 },
    rect,
  );
  assert.equal(plain.upright.x, 960 + 540);
  assert.equal(small.upright.x, 960 + 270);
  // 舞台：scale(0.5) 后右上角 (270,270)，加 x=100，再拉 (300,300) → (670,570)。
  assert.deepEqual(pulled.upright, { x: 960 + 670, y: 540 - 570 });
  assert.equal(pulled.upright.x - small.upright.x, 400, "偏移是 300 世界像素，不是 150");
  assert.equal(pulled.upright.y - small.upright.y, -300);
});

test("a deformed picture skips the ctx pose so offsets are not applied twice", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", bitmap(600, 900)]]),
  });
  renderer.render({
    "character:hero": {
      path: "hero.png",
      visible: true,
      scale: 0.5,
      rotation: 30,
      mesh_upright_dx: 300,
    },
  });
  assert.equal(calls.filter((call) => call[0] === "translate").length, 0);
  assert.equal(calls.filter((call) => call[0] === "rotate").length, 0);
  assert.equal(calls.filter((call) => call[0] === "scale").length, 0);
  assert.equal(calls.filter((call) => call[0] === "clip").length, 8);
});

test("a gif asset advances with virtual time and obeys a frozen step", () => {
  const { calls, canvas } = fakeCanvas();
  const first = bitmap(600, 900);
  const second = bitmap(600, 900);
  const gif = {
    kind: "gif",
    width: 600,
    height: 900,
    frames: [first, second],
    delays: [100, 100],
    total: 200,
  };
  const renderer = createCanvasRenderer({ canvas, assets: new Map([["hero.gif", gif]]) });
  const drawn = () => calls.filter((call) => call[0] === "drawImage").map((call) => call[1]);

  renderer.render({ "character:hero": { path: "hero.gif", visible: true } }, 0);
  assert.equal(drawn()[0], first);
  calls.length = 0;
  renderer.render({ "character:hero": { path: "hero.gif", visible: true } }, 100);
  assert.equal(drawn()[0], second);
  calls.length = 0;
  renderer.render({ "character:hero": { path: "hero.gif", visible: true, frame: 1 } }, 100);
  assert.equal(drawn()[0], first);
});

test("a sprite group picks the picture for the moment being drawn", () => {
  const first = bitmap(600, 900);
  const second = bitmap(600, 900);
  const third = bitmap(600, 900);
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([
      ["a.png", first],
      ["b.png", second],
      ["c.png", third],
    ]),
  });
  const drawn = () => calls.filter((call) => call[0] === "drawImage").map((call) => call[1]);
  const layer = {
    path: "a.png",
    visible: true,
    group: ["a.png", "b.png", "c.png"],
    groupFps: 10,
    groupStart: 0,
    groupLoop: false,
    groupPlaying: true,
  };

  renderer.render({ "character:cg": layer }, 0);
  assert.deepEqual(drawn(), [first]);
  calls.length = 0;
  renderer.render({ "character:cg": layer }, 100);
  assert.deepEqual(drawn(), [second]);
  calls.length = 0;
  renderer.render({ "character:cg": layer }, 350);
  assert.deepEqual(drawn(), [third], "一遍播完停在最后一张");

  calls.length = 0;
  renderer.render({ "character:cg": { ...layer, groupLoop: true } }, 300);
  assert.deepEqual(drawn(), [first], "循环绕回第一张");

  calls.length = 0;
  renderer.render({ "character:cg": { ...layer, groupPlaying: false, path: "b.png" } }, 300);
  assert.deepEqual(drawn(), [second], "暂停之后画 path 上那一张");
});

test("fitRect reproduces cover / contain / fill", () => {
  assert.deepEqual(fitRect(100, 100, 200, 100, "cover"), {
    dw: 200,
    dh: 200,
    dx: 0,
    dy: -50,
  });
  assert.deepEqual(fitRect(100, 100, 200, 100, "contain"), {
    dw: 100,
    dh: 100,
    dx: 50,
    dy: 0,
  });
  assert.deepEqual(fitRect(100, 50, 200, 100, "fill"), {
    dw: 200,
    dh: 100,
    dx: 0,
    dy: 0,
  });
  assert.equal(fitRect(0, 100, 200, 100), null);
});

test("wrapText breaks CJK by measured width and honours explicit newlines", () => {
  const measure = (text) => [...text].length * 10;
  assert.deepEqual(wrapText("一二三四", measure, 25), ["一二", "三四"]);
  assert.deepEqual(wrapText("上\n下", measure, 100), ["上", "下"]);
  assert.deepEqual(wrapText("", measure, 100), [""]);
});

test("a backlit character is darkened in the export as well", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", bitmap(600, 900)]]),
  });
  const filters = () =>
    calls.filter((call) => call[0] === "set" && call[1] === "filter").map((call) => call[2]);

  // 没灯：画面不该多写一条压暗的 filter。
  renderer.render({ "character:hero": { path: "hero.png", visible: true, scale: 0.5 } });
  assert.equal(filters().some((value) => value.includes("brightness")), false);

  // 灯退到角色背后：成片里也要把角色压暗，系数与舞台同源。
  calls.length = 0;
  renderer.render({
    "character:hero": { path: "hero.png", visible: true, scale: 0.5 },
    "light:lamp": { visible: true, color: "FFD9A0", intensity: 1, spread: 360, rotateH: 90, z: 500 },
  });
  assert.ok(
    filters().some((value) => /^brightness\((0?\.\d+)\)$/.test(value)),
    `成片里的角色应当被压暗，实际 ${filters().join(" | ")}`,
  );
});

test("lookString maps the neutral look to an empty filter", () => {
  assert.equal(lookString(null), "");
  assert.equal(lookString({ blur: 0, brightness: 1, contrast: 1, saturate: 1 }), "");
  assert.match(lookString({ blur: 4, brightness: 1, contrast: 1, saturate: 1 }), /blur\(4px\)/);
});

/** 记录所有方法与属性赋值的假 2D 上下文。 */
function fakeCanvas() {
  const calls = [];
  let measureCount = 0;
  const ctx = {
    filter: "none",
    globalAlpha: 1,
    fillStyle: "",
    font: "",
    textBaseline: "",
    save() {
      calls.push(["save"]);
    },
    restore() {
      calls.push(["restore"]);
    },
    clearRect(...args) {
      calls.push(["clearRect", ...args]);
    },
    fillRect(...args) {
      calls.push(["fillRect", ...args]);
    },
    fillText(...args) {
      calls.push(["fillText", ...args]);
    },
    drawImage(...args) {
      calls.push(["drawImage", ...args]);
    },
    translate(...args) {
      calls.push(["translate", ...args]);
    },
    rotate(...args) {
      calls.push(["rotate", ...args]);
    },
    scale(...args) {
      calls.push(["scale", ...args]);
    },
    beginPath() {
      calls.push(["beginPath"]);
    },
    moveTo(...args) {
      calls.push(["moveTo", ...args]);
    },
    lineTo(...args) {
      calls.push(["lineTo", ...args]);
    },
    arcTo(...args) {
      calls.push(["arcTo", ...args]);
    },
    closePath() {
      calls.push(["closePath"]);
    },
    clip() {
      calls.push(["clip"]);
    },
    stroke() {
      calls.push(["stroke"]);
    },
    setLineDash(...args) {
      calls.push(["setLineDash", ...args]);
    },
    arc(...args) {
      calls.push(["arc", ...args]);
    },
    rect(...args) {
      calls.push(["rect", ...args]);
    },
    ellipse(...args) {
      calls.push(["ellipse", ...args]);
    },
    fill() {
      calls.push(["fill"]);
    },
    setTransform(...args) {
      calls.push(["setTransform", ...args]);
    },
    transform(...args) {
      calls.push(["transform", ...args]);
    },
    measureText(text) {
      measureCount += 1;
      return { width: [...text].length * 10 };
    },
  };
  const proxy = new Proxy(ctx, {
    set(target, key, value) {
      calls.push(["set", key, value]);
      target[key] = value;
      return true;
    },
  });
  return {
    calls,
    canvas: { width: 1920, height: 1080, getContext: () => proxy },
    measureCount: () => measureCount,
  };
}

function bitmap(width, height) {
  return { width, height, tag: `bitmap-${width}x${height}` };
}

test("crood paints every open object's own axes and nothing otherwise", () => {
  const assets = new Map([["hero.png", bitmap(600, 900)]]);
  const state = {
    "character:hero": { path: "hero.png", visible: true, crood: true, x: 200, rotate: 90 },
    "text:title": { visible: true, crood: true, text: "你好", x: -100 },
    "character:rival": { path: "hero.png", visible: true, crood: false },
    "text:gone": { visible: false, crood: true, text: "隐藏" },
  };

  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas, assets }).render(state);
  assert.equal(
    calls.filter((call) => call[0] === "stroke").length,
    12,
    "两个开着的对象 × 三根轴 × 正负两笔",
  );
  const labels = calls.filter((call) => call[0] === "fillText").map((call) => call[1]);
  assert.ok(labels.includes("hero"), "原点旁写着对象名");
  assert.ok(labels.includes("title"));
  assert.equal(labels.includes("gone"), false, "隐藏的对象不画轴");

  // 默认隐藏：一个 crood 都没写的状态不该多出一笔线。
  const plain = fakeCanvas();
  createCanvasRenderer({ canvas: plain.canvas, assets }).render({
    "character:hero": { path: "hero.png", visible: true, x: 200 },
  });
  assert.equal(plain.calls.filter((call) => call[0] === "stroke").length, 0);
});

test("a text's colour is drawn from the interpolated channels when it has them", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({ canvas, assets: new Map() });
  renderer.render({
    "text:title": {
      visible: true,
      text: "字",
      color: "#000000",
      colorIsRgb: true,
      color_r: 128,
      color_g: 0,
      color_b: 255,
    },
  });
  // 背景先铺一层底色，文字的填充是这一帧最后写的那一次。
  const fill = calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").pop();
  assert.equal(fill?.[2], "rgb(128, 0, 255)");

  // 拆不出通道的颜色（CSS 颜色名）仍按作者写的字符串画。
  const plain = fakeCanvas();
  createCanvasRenderer({ canvas: plain.canvas, assets: new Map() }).render({
    "text:title": { visible: true, text: "字", color: "tomato", colorIsRgb: false },
  });
  const named = plain.calls
    .filter((call) => call[0] === "set" && call[1] === "fillStyle")
    .pop();
  assert.equal(named?.[2], "tomato");
});

test("a frame clears, draws pictures in layer order and types only revealed text", () => {
  const { calls, canvas } = fakeCanvas();
  const assets = new Map([
    ["bg.png", bitmap(1920, 1080)],
    ["hero.png", bitmap(600, 900)],
  ]);
  const renderer = createCanvasRenderer({ canvas, assets });
  const state = {
    background: { path: "bg.png", opacity: 0.5, x: 0, y: 0, rotation: 0, scale: 1 },
    "character:hero": { path: "hero.png", opacity: 1, x: 100, y: -50, rotation: 15, scale: 1 },
    dialogue: { name: "角色", text: "你好世界这是测试", revealed: 4, visible: true },
  };
  assert.equal(renderer.render(state), canvas);

  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 2);
  assert.equal(calls.filter((call) => call[0] === "clearRect").length, 1);
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "globalAlpha" && call[2] === 0.5));
  assert.ok(calls.some((call) => call[0] === "fillText" && call[1] === "角色"));
  assert.ok(calls.some((call) => call[0] === "fillText" && call[1] === "你好世界"));
  assert.equal(
    calls.some((call) => call[0] === "fillText" && call[1].includes("这是测试")),
    false,
  );
});

test("the dialogue box and its text scale with the export resolution", () => {
  const dialogue = { name: "角色", text: "这句话要出现在成片里。", visible: true };
  const renderAt = (width, height) => {
    const { calls, canvas } = fakeCanvas();
    createCanvasRenderer({ canvas, size: { width, height } }).render({ dialogue });
    return calls;
  };
  const plateAt = (calls, y) => calls.find(
    (call) => call[0] === "fillRect" && Math.abs(call[2] - y) < 0.001,
  );

  const full = renderAt(1920, 1080);
  const fullPlate = plateAt(full, 820);
  assert.ok(fullPlate, "1080p keeps the authored box");
  assert.equal(fullPlate[4], 210);
  assert.ok(full.some((call) => call[0] === "set" && call[1] === "font" && call[2].startsWith("32px ")),
    "1080p keeps the 32px body font");

  for (const [width, height, scale] of [[1280, 720, 2 / 3], [960, 540, 0.5]]) {
    const calls = renderAt(width, height);
    const plate = plateAt(calls, 820 * scale);
    assert.ok(plate, `${width}×${height} places the box at the scaled y`);
    assert.ok(Math.abs(plate[1] - 120 * scale) < 0.001, "x scales too");
    assert.ok(Math.abs(plate[3] - 1680 * scale) < 0.001, "width scales too");
    assert.ok(plate[2] + plate[4] <= height + 0.001, "the whole box stays inside the picture");

    const line = calls.find((call) => call[0] === "fillText" && call[1] === dialogue.text);
    assert.ok(line, "the line is still drawn, not dropped");
    assert.ok(line[3] < height, "the text lands inside the picture");
    assert.ok(calls.some((call) => call[0] === "set" && call[1] === "font" && call[2].startsWith(`${32 * scale}px`)),
      "the body font scales with the box");
  }
});

/** A style document with a plate and deliberately distinct fonts per slot. */
function dialoguePlate() {
  const font = (family, size, color) => ({ family, size, weight: 700, italic: false, color });
  const boxes = (size, color) => ({
    speaker: {
      x: 180, y: 786, width: 520, height: 64,
      font: font("思源黑体", size, "#ffd479"), align: "left", valign: "middle",
    },
    text: {
      x: 180, y: 862, width: 1560, height: 170,
      font: font("思源黑体", size, color), lineHeight: 1.4, align: "left", valign: "top",
    },
  });
  const layer = (id, fill) => ({
    id, type: "rect", visible: true, opacity: 1,
    x: 100, y: 800, width: 1600, height: 220, radius: 8, fill,
  });
  return {
    version: 2,
    canvas: { width: 1920, height: 1080 },
    active: "dialog",
    styles: {
      dialog: { layers: [layer("d", "#101018")], ...boxes(32, "#f2f2f2") },
      narration: { layers: [layer("n", "#202030")], ...boxes(28, "#ddeeff") },
    },
  };
}

test("a style's layers are painted into the frame by the shared painter", () => {
  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas, plate: dialoguePlate() }).render({
    dialogue: { name: "角色", text: "你好", visible: true },
  });

  assert.ok(calls.some((call) => call[0] === "scale"), "the logical plate is fitted to the frame");
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "fillStyle" && call[2] === "#101018"),
    "the layer's own fill is used");
  assert.equal(calls.filter((call) => call[0] === "clearRect").length, 1,
    "the plate is laid over the frame, not wiped onto it");
  assert.equal(calls.some((call) => call[0] === "fillRect" && call[1] === 120), false,
    "no built-in rectangle covers the authored layers");
});

test("a styled line takes its box, font and colour from the style file", () => {
  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas, plate: dialoguePlate() }).render({
    dialogue: { name: "角色", text: "你好", visible: true },
  });

  const line = calls.find((call) => call[0] === "fillText" && call[1] === "你好");
  assert.ok(line);
  assert.equal(line[2], 180, "x comes from styles.dialog.text");
  assert.equal(line[3], 862, "y comes from styles.dialog.text");
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "font" && call[2].includes('"思源黑体"')));
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "fillStyle" && call[2] === "#f2f2f2"));
});

test("a line with no name is drawn in the narration slot", () => {
  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas, plate: dialoguePlate() }).render({
    dialogue: { text: "旁白", visible: true },
  });

  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "fillStyle" && call[2] === "#202030"),
    "the narration slot's own plate");
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "fillStyle" && call[2] === "#ddeeff"),
    "the narration slot's own text colour");
});

test("the styled plate scales with the output resolution", () => {
  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas, plate: dialoguePlate(), size: { width: 1280, height: 720 } })
    .render({ dialogue: { name: "角色", text: "你好", visible: true } });

  assert.ok(calls.some((call) => call[0] === "scale" && Math.abs(call[1] - 2 / 3) < 0.001));
  const line = calls.find((call) => call[0] === "fillText" && call[1] === "你好");
  assert.ok(line[3] < 720, "the text stays inside the picture");
});

test("a style with no layers keeps a readable stand-in plate", () => {
  const plate = dialoguePlate();
  plate.styles.dialog.layers = [];
  plate.styles.narration.layers = [];
  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas, plate }).render({
    dialogue: { name: "角色", text: "你好", visible: true },
  });

  assert.ok(calls.some((call) => call[0] === "fillRect" && call[1] === 120 && call[2] === 820));
});

test("a long line is shrunk to fit instead of dropping its last lines", () => {
  const long = "长".repeat(815);
  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas }).render({ dialogue: { text: long, visible: true } });

  const drawn = calls.filter((call) => call[0] === "fillText").map((call) => call[1]).join("");
  assert.equal(drawn, long, "not one character is lost");
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "font" && parseFloat(call[2]) < 32),
    "the type was shrunk to make room");
});

test("a long name is capped at the plate's width", () => {
  const name = "很长的角色名字".repeat(20);
  const { calls, canvas } = fakeCanvas();
  createCanvasRenderer({ canvas }).render({ dialogue: { name, text: "你好", visible: true } });

  const drawn = calls.find((call) => call[0] === "fillText" && call[1] === name);
  assert.ok(drawn);
  assert.equal(drawn[4], 1632, "fillText receives a maxWidth inside the box");
});

test("a text object is drawn with fillText instead of being looked up as a bitmap", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({ canvas });

  renderer.render({
    "text:title": {
      visible: true,
      text: "上\n下",
      x: 0,
      y: 0,
      size: 64,
      color: "#ffd479",
      fontFamily: "宋体",
      opacity: 0.5,
    },
  });

  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 0);
  assert.deepEqual(
    calls.filter((call) => call[0] === "fillText").map((call) => call[1]),
    ["上", "下"],
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "set" &&
        call[1] === "font" &&
        call[2] === '400 64px "宋体", "JetBrains Mono", "Source Han Sans CN", sans-serif',
    ),
    "成片用与舞台相同的字体栈，不写字重时是常规 400",
  );
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "fillStyle" && call[2] === "#ffd479"));
  assert.ok(calls.some((call) => call[0] === "set" && call[1] === "globalAlpha" && call[2] === 0.5));

  calls.length = 0;
  renderer.render({
    "text:title": { visible: true, text: "粗", fontWeight: 700 },
  });
  assert.ok(
    calls.some((call) => call[0] === "set" && call[1] === "font" && call[2].startsWith("700 ")),
    "字重写进 canvas 的 font",
  );

  calls.length = 0;
  renderer.render({ "text:title": { visible: false, text: "不该出现" } });
  assert.equal(calls.filter((call) => call[0] === "fillText").length, 0);
});

test("missing assets and hidden layers are skipped without throwing", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({ canvas, assets: new Map() });
  renderer.render({
    background: { path: "missing.png", visible: true },
    dialogue: { text: "隐藏", visible: false },
  });
  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 0);
  assert.equal(calls.filter((call) => call[0] === "fillText").length, 0);
});

test("an undeformed character keeps the single-drawImage path", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", bitmap(600, 900)]]),
  });
  renderer.render({ "character:hero": { path: "hero.png", visible: true } });
  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 1);
  assert.equal(calls.filter((call) => call[0] === "clip").length, 0);
});

test("a deformed character is drawn through eight clipped triangles", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", bitmap(600, 900)]]),
  });
  renderer.render({
    "character:hero": {
      path: "hero.png",
      visible: true,
      scale: 0.5,
      mesh_upright_dx: 300,
      mesh_upright_dy: 300,
      mesh_upleft_dx: -300,
      mesh_upleft_dy: 300,
      mesh_up_dy: 300,
      mesh_downleft_dx: 100,
      mesh_downright_dx: -100,
    },
  });

  assert.equal(calls.filter((call) => call[0] === "clip").length, 8);
  assert.equal(calls.filter((call) => call[0] === "transform").length, 8);
  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 8);
});

test("a video layer is drawn from the frame source between characters and the dialogue", async () => {
  const { calls, canvas } = fakeCanvas();
  const element = { tag: "video-element" };
  const seeks = [];
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["hero.png", bitmap(600, 900)]]),
    video: {
      frames: {
        async seek(path, seconds) {
          seeks.push([path, seconds]);
          return { element, width: 1280, height: 720 };
        },
      },
      playheads: { mediaTimeAt: (target, t) => (target === "video:clip" ? t * 2 : 0) },
    },
  });

  const pending = renderer.render(
    {
      "character:hero": { path: "hero.png", visible: true },
      "video:clip": { path: "opening.mp4", visible: true },
      dialogue: { text: "你好", visible: true },
    },
    3000,
  );
  assert.equal(typeof pending.then, "function", "取帧要等 seek，所以是异步的");
  assert.equal(await pending, canvas);

  assert.deepEqual(seeks, [["opening.mp4", 6]], "播放头 3 秒 → 素材 6 秒");

  const videoDraw = calls.findIndex((call) => call[0] === "drawImage" && call[1] === element);
  const heroDraw = calls.findIndex((call) => call[0] === "drawImage" && call[1] !== element);
  const textDraw = calls.findIndex((call) => call[0] === "fillText");
  assert.ok(heroDraw >= 0, "角色照常画");
  assert.ok(heroDraw < videoDraw, "视频在角色之上");
  assert.ok(videoDraw < textDraw, "视频在对话盒之下");
  // 1280×720 按 contain 铺进 1920×1080。
  assert.deepEqual(calls[videoDraw].slice(2), [-960, -540, 1920, 1080]);
});

test("a tinted layer is redrawn through a per-pixel channel offset", () => {
  const { calls, canvas } = fakeCanvas();
  const scratchCtx = {
    pixels: new Uint8ClampedArray([10, 20, 30, 255, 250, 5, 5, 128]),
    clearRect() {},
    drawImage(...args) {
      this.drawn = args;
    },
    getImageData() {
      return { data: this.pixels };
    },
    putImageData() {
      this.put = true;
    },
  };
  const scratch = { width: 0, height: 0, getContext: () => scratchCtx, tag: "scratch" };
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", bitmap(1920, 1080)]]),
    createScratch: (w, h) => {
      scratch.width = w;
      scratch.height = h;
      return scratch;
    },
  });

  renderer.render({
    background: { path: "bg.png", visible: true, tint: { r: 20, g: -5, b: 0 } },
  });

  assert.equal(scratch.width, 1920);
  assert.equal(scratch.height, 1080);
  assert.deepEqual([...scratchCtx.pixels], [30, 15, 30, 255, 255, 0, 5, 128], "加偏移并夹在 0–255");
  assert.equal(scratchCtx.put, true);
  assert.equal(calls.find((call) => call[0] === "drawImage")[1], scratch, "主画布画染色后的画布");
});

test("分项计时覆盖同步渲染与调色，且不把同步路径变成 Promise", () => {
  const { canvas } = fakeCanvas();
  let now = 0;
  const metrics = createExportMetrics({ clock: () => (now += 1) });
  const scratchCtx = {
    pixels: new Uint8ClampedArray(4),
    clearRect() {},
    drawImage() {},
    getImageData() {
      return { data: this.pixels };
    },
    putImageData() {},
  };
  const scratch = { getContext: () => scratchCtx };
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", bitmap(1920, 1080)]]),
    createScratch: () => scratch,
    metrics,
  });

  const result = renderer.render({
    background: { path: "bg.png", visible: true, tint: { r: 10, g: 0, b: 0 } },
  });
  assert.equal(result, canvas, "同步渲染必须仍同步返回同一个画布");
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.stages.render.calls, 1);
  assert.equal(snapshot.stages.tint.calls, 1);
  assert.ok(snapshot.stages.render.ms > 0);
  assert.ok(snapshot.stages.tint.ms > 0);
});

test("分项计时覆盖视频取帧，且不改变异步返回值", async () => {
  const { canvas } = fakeCanvas();
  let now = 0;
  const metrics = createExportMetrics({ clock: () => (now += 1) });
  const renderer = createCanvasRenderer({
    canvas,
    video: {
      frames: {
        async seek() {
          return { element: { tag: "video" }, width: 1280, height: 720 };
        },
      },
      playheads: { mediaTimeAt: () => 1000 },
    },
    metrics,
  });

  const pending = renderer.render({ "video:clip": { path: "op.mp4", visible: true } }, 0);
  assert.equal(typeof pending.then, "function", "有视频时仍是异步的");
  assert.equal(await pending, canvas);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.stages.render.calls, 1);
  assert.equal(snapshot.stages.seek.calls, 1);
  assert.ok(snapshot.stages.seek.ms > 0);
});

test("打字机逐字显示时台词宽度跨帧复用，换台词才重新测量", () => {
  const { canvas, measureCount } = fakeCanvas();
  const renderer = createCanvasRenderer({ canvas });
  const text = "一二三四五六七八九十";
  for (let revealed = 1; revealed <= 10; revealed += 1) {
    renderer.render({ dialogue: { text, revealed, visible: true } });
  }
  // 无缓存时每帧要把所有前缀重新测一遍（累计约 45 次）；缓存后只剩不同前缀。
  const measured = measureCount();
  assert.ok(measured < 20, `测量次数应远小于逐帧全量，实际 ${measured}`);
  renderer.render({ dialogue: { text, revealed: 10, visible: true } });
  assert.equal(measureCount(), measured, "同一台词同一进度重复渲染不再测量");
  renderer.render({ dialogue: { text: "另一句话", revealed: 4, visible: true } });
  assert.ok(measureCount() > measured, "换台词后清空缓存并重新测量新前缀");
});

test("缺省调色画布按尺寸复用，不再每帧新建", () => {
  const previous = globalThis.OffscreenCanvas;
  let created = 0;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      created += 1;
      this.width = w;
      this.height = h;
      const pixels = new Uint8ClampedArray(w * h * 4);
      const sctx = {
        clearRect() {},
        drawImage() {},
        getImageData: () => ({ data: pixels }),
        putImageData() {},
      };
      this.getContext = () => sctx;
    }
  };
  try {
    const { canvas } = fakeCanvas();
    const renderer = createCanvasRenderer({
      canvas,
      size: { width: 8, height: 8 },
      assets: new Map([["bg.png", bitmap(4, 4)]]),
    });
    for (let i = 0; i < 5; i += 1) {
      renderer.render({ background: { path: "bg.png", visible: true, tint_r: 10 } });
    }
    assert.equal(created, 1, "同一尺寸只建一张离屏画布");
  } finally {
    if (previous === undefined) {
      delete globalThis.OffscreenCanvas;
    } else {
      globalThis.OffscreenCanvas = previous;
    }
  }
});

test("四类层一次分类后，gif/video 目标与层序规则不变", () => {
  const { calls, canvas } = fakeCanvas();
  const bg = bitmap(1920, 1080);
  const hero = bitmap(600, 900);
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([
      ["bg.png", bg],
      ["hero.png", hero],
    ]),
  });
  renderer.render({
    "gif:skip": { path: "bg.png", visible: true },
    "video:skip": { path: "op.mp4", visible: true },
    background: { path: "bg.png", visible: true },
    "character:hero": { path: "hero.png", visible: true },
    dialogue: { text: "你好", visible: true },
  });
  const drawn = calls.filter((call) => call[0] === "drawImage").map((call) => call[1]);
  assert.deepEqual(drawn, [bg, hero], "gif: / video: 目标不进位图层，没有视频源也不取帧");
  assert.ok(calls.some((call) => call[0] === "fillText" && call[1] === "你好"));
});

test("相邻静止帧跳过重画，画布对象与同步性不变", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", bitmap(1920, 1080)]]),
  });
  const state = { background: { path: "bg.png", visible: true } };
  assert.equal(renderer.render(state, 0), canvas);
  assert.ok(calls.length > 0, "第一帧要真的画");
  calls.length = 0;

  assert.equal(renderer.render(state, 33), canvas, "仍返回同一个画布供 VideoFrame 取帧");
  assert.equal(calls.length, 0, "状态未变、t 变了也不重画");

  calls.length = 0;
  renderer.render({ background: { path: "bg.png", visible: true, x: 10 } }, 66);
  assert.ok(calls.some((call) => call[0] === "drawImage"), "状态变化后重新绘制");
});

test("粒子与 GIF 层按时间变化，禁用静止帧复用", () => {
  const particles = fakeCanvas();
  const particleRenderer = createCanvasRenderer({ canvas: particles.canvas });
  const particleState = { "effect:rain": { type: "rain" } };
  particleRenderer.render(particleState, 0);
  particles.calls.length = 0;
  particleRenderer.render(particleState, 33);
  assert.ok(particles.calls.length > 0, "粒子按 t 推进，不能跳过");

  const gif = {
    kind: "gif",
    width: 600,
    height: 900,
    frames: [bitmap(600, 900), bitmap(600, 900)],
    delays: [100, 100],
    total: 200,
  };
  const gifFake = fakeCanvas();
  const gifRenderer = createCanvasRenderer({
    canvas: gifFake.canvas,
    assets: new Map([["a.gif", gif]]),
  });
  const gifState = { "character:a": { path: "a.gif", visible: true } };
  gifRenderer.render(gifState, 0);
  gifFake.calls.length = 0;
  gifRenderer.render(gifState, 100);
  assert.ok(
    gifFake.calls.some((call) => call[0] === "drawImage"),
    "GIF 按 t 选帧，不能跳过",
  );
});

test("复用帧数进计时器计数，视频路径不参与复用", async () => {
  const { canvas } = fakeCanvas();
  const metrics = createExportMetrics({ clock: () => 0 });
  const plain = createCanvasRenderer({ canvas, metrics });
  const state = { dialogue: { text: "静止", visible: true } };
  plain.render(state, 0);
  plain.render(state, 33);
  plain.render(state, 66);
  assert.equal(metrics.snapshot().counters.reuse, 2);

  const withVideo = createCanvasRenderer({
    canvas,
    metrics,
    video: {
      frames: {
        async seek() {
          return { element: { tag: "video" }, width: 100, height: 100 };
        },
      },
      playheads: { mediaTimeAt: () => 1000 },
    },
  });
  const videoState = { "video:clip": { path: "op.mp4", visible: true } };
  await withVideo.render(videoState, 100);
  await withVideo.render(videoState, 133);
  assert.equal(metrics.snapshot().counters.reuse, 2, "视频播放头按 t 变，不能复用");
});

test("flat look and tint fields are what a transitioning frame uses", () => {
  const { canvas } = fakeCanvas();
  const bg = bitmap(1920, 1080);
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", bg]]),
    createScratch: () => null,
  });
  renderer.render({
    background: {
      path: "bg.png",
      visible: true,
      look_blur: 2,
      look_brightness: 1.5,
      look_contrast: 1,
      look_saturate: 1,
      tint_r: 0,
      tint_g: 0,
      tint_b: 0,
    },
  });
  const ctx = canvas.getContext("2d");
  assert.match(ctx.filter, /blur\(2px\)/);
  assert.match(ctx.filter, /brightness\(1\.5\)/);
});

test("a neutral tint keeps the plain drawImage path", () => {
  const { calls, canvas } = fakeCanvas();
  let scratches = 0;
  const bg = bitmap(1920, 1080);
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", bg]]),
    createScratch: () => {
      scratches += 1;
      return null;
    },
  });
  renderer.render({ background: { path: "bg.png", visible: true, tint: { r: 0, g: 0, b: 0 } } });
  assert.equal(scratches, 0);
  assert.equal(calls.find((call) => call[0] === "drawImage")[1], bg);
});

test("a looping video wraps its media time into the file", async () => {
  const { canvas } = fakeCanvas();
  const seeks = [];
  const renderer = createCanvasRenderer({
    canvas,
    video: {
      frames: {
        async load() {
          return { duration: 10, width: 1280, height: 720 };
        },
        async seek(path, seconds) {
          seeks.push(seconds);
          return { element: { tag: "loop" }, width: 1280, height: 720 };
        },
      },
      playheads: { mediaTimeAt: () => 12_000, loopsAt: () => true },
    },
  });
  await renderer.render({ "video:clip": { path: "op.mp4", visible: true } }, 0);
  assert.deepEqual(seeks, [2], "素材 10 秒，播放头 12 秒 → 第 2 秒");
});

test("a hidden video is never seeked and a broken one does not block the frame", async () => {
  const { calls, canvas } = fakeCanvas();
  let seeks = 0;
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", bitmap(1920, 1080)]]),
    video: {
      frames: {
        async seek() {
          seeks += 1;
          throw new Error("解不开");
        },
      },
      playheads: { mediaTimeAt: () => 0 },
    },
  });

  const hidden = renderer.render({ "video:clip": { path: "x.mp4", visible: false } }, 0);
  assert.equal(hidden, canvas, "没有可见视频时同步返回");
  assert.equal(seeks, 0);

  const broken = await renderer.render(
    {
      background: { path: "bg.png", visible: true },
      "video:clip": { path: "x.mp4", visible: true },
    },
    0,
  );
  assert.equal(broken, canvas);
  assert.equal(seeks, 1);
  assert.equal(calls.filter((call) => call[0] === "drawImage").length, 1, "其他图层照常画");
});

test("a light is lit on its own layer, and never mistaken for a picture", async () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createCanvasRenderer({
    canvas,
    assets: new Map([["bg.png", bitmap(1920, 1080)]]),
    // 没有离屏画布时灯层只能跳过——这一帧仍要照常画完。
    createScratch: () => null,
  });

  const frame = await renderer.render(
    {
      background: { path: "bg.png", visible: true },
      ambient: { value: 0.5 },
      "light:lamp": {
        color: "FFD9A0",
        intensity: 1.5,
        x: 200,
        y: 100,
        visible: true,
        excluded: [],
      },
    },
    0,
  );

  assert.equal(frame, canvas);
  assert.equal(
    calls.filter((call) => call[0] === "drawImage").length,
    1,
    "只有背景被画：灯没有变成一层找不到素材的图片",
  );
  assert.ok(
    calls.some((call) => call[0] === "fillRect"),
    "背景色照旧铺满",
  );
});
