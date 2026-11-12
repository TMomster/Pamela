// 运动路径测试：文件结构、采样与关键帧数据。
// Tests for motion paths: the file shape, the sampling the editor and the

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPathFile,
  cleanId,
  copyNameFor,
  CURVE_STEPS,
  rehomePathDocument,
  animatedProps,
  frameAt,
  freeKeyFrameIndex,
  keyFrameStemFor,
  keyFrames,
  normalizeFrame,
  orderedPathFileFor,
  resolveFrame,
  segmentControls,
  DEFAULT_SPEED,
  idFromKeyArgument,
  idFromPathFile,
  insertPointOnPath,
  isPathFile,
  newPathId,
  normalizePath,
  normalizeSegment,
  pathDuration,
  pathEnd,
  pathFileFor,
  pathFileFromArgument,
  PATHS_DIR,
  pointAt,
  referencedIds,
  removePointAt,
  samplePath,
  sampleSegment,
  segmentLength,
  segmentTime,
  setCurvature,
  unreferencedPaths,
} from "../path.js";
import { run } from "../pamela.js";
import { createStage, createStageGlobals, createStageObjects } from "../stage.js";

/** A minimal element, so a stage can be built in node. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: {},
    get offsetWidth() {
      return 0;
    },
    childNodes: [],
    classList: { toggle() {} },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    replaceChildren(...children) {
      node.childNodes = children;
    },
    append(...children) {
      node.childNodes.push(...children);
    },
    hidden: false,
    alt: "",
    draggable: false,
    src: "",
    textContent: "",
    volume: 1,
    loop: false,
    currentTime: 0,
    paused: true,
    play() {
      node.paused = false;
      return Promise.resolve();
    },
    pause() {
      node.paused = true;
    },
    decode() {
      return Promise.resolve();
    },
    removeAttribute(name) {
      node[name] = "";
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
  return node;
}

/** Runs `body` with a minimal `document`, so the stage can be built in node. */
async function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return await body();
  } finally {
    globalThis.document = previous;
  }
}

/** A path with one straight segment, for the timing cases. */
function straightPath(time = 1000) {
  return normalizePath({
    id: "abc12345",
    start: { x: 0, y: 0 },
    segments: [{ type: "line", points: [[0, 0], [100, 0]], time }],
  });
}

// --- ids and file names ---

test("id：只留安全字符，路径不会跳出 data/", () => {
  assert.equal(cleanId("a1b2"), "a1b2");
  assert.equal(cleanId("../evil"), "evil");
  assert.equal(cleanId("a/b\\c"), "abc");
  assert.equal(cleanId("A-1_2"), "A-1_2");
  assert.equal(cleanId("  pad  "), "pad");
  assert.equal(cleanId(null), "");
});

test("id：文件名的往返", () => {
  // The file is JSON inside but carries the `.keyframes` suffix, which is what
  // tells the tree to open it in the key frame editor rather than as a script.
  assert.equal(pathFileFor("ch"), "data/key-ch.keyframes");
  assert.equal(idFromPathFile("data/key-ch.keyframes"), "ch");
  // Files written before the rename are still read, under both old spellings.
  assert.equal(idFromPathFile("data/key-ch.json"), "ch");
  assert.equal(idFromPathFile("data\\path-a1b2.json"), "a1b2");
  assert.equal(idFromPathFile("data/other.json"), "");
  assert.equal(idFromPathFile("scripts/x.pe"), "");
  assert.equal(isPathFile("data/key-ch.keyframes"), true);
  assert.equal(isPathFile("data/key-.keyframes"), false);
});

test("id：生成的路径帧按 对象-剧本-后缀-编号 命名", () => {
  // `ch` keyed in `main.pe` → `data/ch-main-pe-1.keyframes`. The suffix stays
  // on the file so the tree opens it in the key frame editor.
  assert.equal(keyFrameStemFor("ch", "scripts/main.pe"), "ch-main-pe");
  assert.equal(keyFrameStemFor("ch", "main.pe"), "ch-main-pe");
  assert.equal(keyFrameStemFor("ch", "main.mpe"), "ch-main-mpe");
  assert.equal(keyFrameStemFor("ch", "main"), "ch-main");
  assert.equal(keyFrameStemFor("", "main.pe"), "");
  assert.equal(orderedPathFileFor("ch-main-pe-1"), "data/ch-main-pe-1.keyframes");
  assert.equal(idFromPathFile("data/ch-main-pe-1.keyframes"), "ch-main-pe-1");
  assert.equal(isPathFile("data/ch-main-pe-1.keyframes"), true);
  // An object called `path` is a whole id, not the old `path-` prefix: that
  // prefix only ever applied to `.json` files, so its stem survives.
  assert.equal(idFromPathFile("data/path-main-pe-1.keyframes"), "path-main-pe-1");
});

test("id：编号从小到大的空位补，删除不牵连其它编号", () => {
  assert.equal(freeKeyFrameIndex("ch-main-pe", []), 1);
  assert.equal(freeKeyFrameIndex("ch-main-pe", ["ch-main-pe-1", "ch-main-pe-2"]), 3);
  // 1 and 3 on disk: the next file takes 2, then 4. Neither 1 nor 3 moves.
  assert.equal(
    freeKeyFrameIndex("ch-main-pe", ["ch-main-pe-1", "ch-main-pe-3"]),
    2,
  );
  assert.equal(
    freeKeyFrameIndex("ch-main-pe", ["ch-main-pe-1", "ch-main-pe-2", "ch-main-pe-3"]),
    4,
  );
  // Another object or script shares no numbers.
  assert.equal(freeKeyFrameIndex("ch-main-pe", ["bg-main-pe-1", "ch-other-pe-1"]), 1);
  assert.equal(freeKeyFrameIndex("ch-main-pe", ["ch-main-pe-1x", "ch-main-pe"]), 1);
});

test("id：key() 的参数指向 data/ 下的文件", () => {
  // A bare file name is the default: the folder is implied, the same way
  // `assets/` is for a picture.
  assert.equal(pathFileFromArgument("key-ch.keyframes"), "data/key-ch.keyframes");
  assert.equal(pathFileFromArgument("data/key-ch.keyframes"), "data/key-ch.keyframes");
  assert.equal(pathFileFromArgument(""), "");
  assert.equal(idFromKeyArgument("key-ch.keyframes"), "ch");
  assert.equal(idFromKeyArgument("data/key-ch.keyframes"), "ch");
  assert.equal(idFromKeyArgument("nope.png"), "");
  // A generated name is a bare file in `data/`, and the reference scan keeps it
  // out of the "unreferenced" sweep.
  assert.equal(idFromKeyArgument("ch-main-pe-1.keyframes"), "ch-main-pe-1");
  assert.ok(referencedIds('ch.key("ch-main-pe-1.keyframes")').has("ch-main-pe-1"));
  assert.deepEqual(unreferencedPaths(["data/ch-main-pe-1.keyframes"], 'ch.key("ch-main-pe-1.keyframes")'), []);
});

test("id：新 id 是八位十六进制，且不重复", () => {
  const seen = new Set();
  for (let index = 0; index < 50; index += 1) {
    const id = newPathId();
    assert.match(id, /^[0-9a-f]{8}$/);
    seen.add(id);
  }
  assert.ok(seen.size > 1, "随机 id 不该全都一样");
});

test("id：注入随机数可复现", () => {
  assert.equal(newPathId(() => 0), "00000000");
  assert.equal(newPathId(() => 0.5), "88888888");
});

// --- 文件形状 ---

test("文件：缺 id 的文档读不出来", () => {
  assert.equal(normalizePath(null), null);
  assert.equal(normalizePath([]), null);
  assert.equal(normalizePath({ segments: [] }), null);
  assert.equal(normalizePath({ id: "  " }), null);
});

test("文件：缺省字段被补上，无效段被过滤", () => {
  const path = normalizePath({
    id: "p1",
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 100 },
      { type: "line", points: [[0, 0]] },
      "junk",
      { type: "curve", points: [[0, 0], [5, 5], [10, 0]], time: 200 },
    ],
  });
  assert.equal(path.id, "p1");
  // The start is the path's first key frame: a file naming only a position
  // answers the defaults for the rest.
  assert.deepEqual(path.start, { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 });
  assert.equal(path.segments.length, 2, "一句一点的段和无效数据都被过滤");
  assert.equal(path.segments[1].type, "curve");
});

test("文件：段的时间必须是正的，超长被夹到上限", () => {
  assert.equal(segmentTime({ time: -5 }), 0);
  assert.equal(segmentTime({ time: 0 }), 0);
  assert.equal(segmentTime({ time: 250 }), 250);
  const long = normalizeSegment({ type: "line", points: [[0, 0], [1, 1]], time: 10 ** 9 });
  assert.equal(long.time, 600_000);
});

test("文件：写出的形状总是当前版本", () => {
  const file = buildPathFile({ id: "x9", start: { x: 3, y: 4 }, segments: [] });
  // Version 2 added key frames. A path that animates nothing writes nothing
  // about the properties: it only moves the object.
  assert.equal(file.version, 2);
  assert.deepEqual(file, { version: 2, id: "x9", name: "x9", start: { x: 3, y: 4 }, segments: [] });

  // A path that does drive them writes exactly those, and nothing else.
  const animated = buildPathFile({ id: "y1", start: { x: 0, y: 0, rotation: 45 }, segments: [] });
  assert.deepEqual(animated.start, { x: 0, y: 0, rotation: 45 }, "只写声明过的属性");
});

// --- 采样 ---

test("采样：直线段答自己的点", () => {
  const points = sampleSegment({ type: "line", points: [[0, 0], [10, 5], [20, 0]] });
  assert.deepEqual(points, [
    [0, 0],
    [10, 5],
    [20, 0],
  ]);
});

test("采样：曲线段被细分，且首尾落在作者给的点上", () => {
  const points = sampleSegment({
    type: "curve",
    points: [
      [0, 0],
      [50, 40],
      [100, 0],
    ],
  });
  assert.equal(points.length, CURVE_STEPS + 1);
  assert.deepEqual(points[0], [0, 0]);
  assert.deepEqual(points[points.length - 1], [100, 0]);
  // A cubic pulled toward the waypoint must leave the chord it would have been.
  const middle = points[Math.floor(CURVE_STEPS / 2)];
  assert.ok(middle[1] > 5, "曲线应当被拉离直线");
});

test("控制点：默认取途经点，曲线被拉向它（不是穿过）", () => {
  const segment = {
    type: "curve",
    points: [
      [0, 0],
      [50, 40],
      [100, 0],
    ],
  };
  const controls = segmentControls(segment);
  assert.equal(controls.length, 1, "三点一段，一对控制点");
  // Both controls sit on the waypoint, so the curve is pulled toward it.
  assert.deepEqual(controls[0], [
    [50, 40],
    [50, 40],
  ]);

  // A cubic only touches its control points at its own ends, so the halfway
  // sample stands three quarters of the way to the waypoint: 30, not 40. This
  // is the shape the editor draws, so it is worth pinning rather than assuming.
  const walk = sampleSegment(segment);
  const middle = walk[Math.floor(CURVE_STEPS / 2)];
  assert.ok(Math.abs(middle[0] - 50) < 1, `中点应在 x=50，实际 ${middle[0]}`);
  assert.ok(Math.abs(middle[1] - 30) < 1, `中点 y 应是途经点的 3/4，实际 ${middle[1]}`);
});

test("控制点：显式 control 优先于途经点", () => {
  const segment = {
    type: "curve",
    points: [
      [0, 0],
      [50, 0],
      [100, 0],
    ],
    // A handle dragged well off the straight line between the ends.
    control: [
      [
        [0, 200],
        [100, 200],
      ],
    ],
  };
  const controls = segmentControls(segment);
  assert.deepEqual(controls[0], [
    [0, 200],
    [100, 200],
  ]);
  // The bow is upward, where no point is; a derived control would have stayed flat.
  const walk = sampleSegment(segment);
  const middle = walk[Math.floor(CURVE_STEPS / 2)];
  assert.ok(middle[1] > 100, `显式控制点应把曲线拉高，实际 y=${middle[1]}`);
});

test("控制点：多段曲线各有一对，缺的那对回落途经点", () => {
  const segment = {
    type: "curve",
    points: [
      [0, 0],
      [50, 50],
      [100, 0],
      [150, -50],
      [200, 0],
    ],
    control: [
      [
        [10, 90],
        [90, 90],
      ],
      null,
    ],
  };
  const controls = segmentControls(segment);
  assert.equal(controls.length, 2);
  assert.deepEqual(controls[0], [
    [10, 90],
    [90, 90],
  ]);
  assert.deepEqual(controls[1], [
    [150, -50],
    [150, -50],
  ]);
});

test("采样：整条路径从 start 起，按段接上，并去掉重复接点", () => {
  const path = normalizePath({
    id: "p",
    start: { x: 0, y: 0 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 100 },
      { type: "line", points: [[10, 0], [10, 10]], time: 100 },
    ],
  });
  const points = samplePath(path);
  assert.deepEqual(points[0], [0, 0]);
  assert.deepEqual(points[points.length - 1], [10, 10]);
  // The join (10, 0) must appear once, not twice.
  assert.equal(points.filter((p) => p[0] === 10 && p[1] === 0).length, 1);
});

test("采样：起点与首段起点不同时，路径仍从 start 出发", () => {
  const path = normalizePath({
    id: "p",
    start: { x: -5, y: -5 },
    segments: [{ type: "line", points: [[0, 0], [10, 0]], time: 100 }],
  });
  assert.deepEqual(samplePath(path)[0], [-5, -5]);
});

// --- 时长与位置 ---

test("时长：按段累加", () => {
  const path = normalizePath({
    id: "p",
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 300 },
      { type: "line", points: [[10, 0], [20, 0]], time: 700 },
    ],
  });
  assert.equal(pathDuration(path), 1000);
});

test("时长：没写时间的段按距离折算，不是瞬间", () => {
  // 100 units at the default speed, so the segment still takes time.
  const path = normalizePath({
    id: "p",
    segments: [{ type: "line", points: [[0, 0], [100, 0]] }],
  });
  assert.equal(pathDuration(path), Math.round(100 / DEFAULT_SPEED));
  assert.ok(pathDuration(path) > 0);
});

test("位置：起点、中途、终点", () => {
  const path = straightPath(1000);
  assert.deepEqual(pointAt(path, 0), { x: 0, y: 0, done: false });
  const middle = pointAt(path, 500);
  assert.ok(Math.abs(middle.x - 50) < 1e-6);
  assert.ok(Math.abs(middle.y - 0) < 1e-6);
  assert.equal(middle.done, false);

  const end = pointAt(path, 1000);
  assert.ok(Math.abs(end.x - 100) < 1e-6);
  assert.equal(end.done, true);
});

test("位置：超过总时长停在终点", () => {
  const path = straightPath(1000);
  const over = pointAt(path, 99999);
  assert.ok(Math.abs(over.x - 100) < 1e-6);
  assert.equal(over.done, true);
});

test("位置：按弧长走，不是按点的序号", () => {
  // The second leg is nine times longer, so at the halfway point in time the
  // object has not yet reached the corner.
  const path = normalizePath({
    id: "p",
    start: { x: 0, y: 0 },
    segments: [
      {
        type: "line",
        points: [
          [0, 0],
          [10, 0],
          [100, 0],
        ],
        time: 1000,
      },
    ],
  });
  const middle = pointAt(path, 500);
  assert.ok(middle.x > 40 && middle.x < 60, `按弧长应到中段，实际 ${middle.x}`);
});

test("位置：没有段时停在起点并算走完", () => {
  const path = normalizePath({ id: "p", start: { x: 7, y: 8 }, segments: [] });
  assert.deepEqual(pointAt(path, 0), { x: 7, y: 8, done: true });
});

test("位置：pathEnd 就是终点", () => {
  const path = straightPath(1000);
  const end = pathEnd(path);
  assert.ok(Math.abs(end.x - 100) < 1e-6);
  assert.ok(Math.abs(end.y) < 1e-6);
});

test("长度：直线段按欧氏距离", () => {
  assert.equal(segmentLength({ type: "line", points: [[0, 0], [3, 4]] }), 5);
});

// --- 引用扫描与清理 ---

test("引用：支持识别 key() 命名的文件", () => {
  const ids = referencedIds(`
    hero.key("key-hero.keyframes")
    bg.key("key-bg.keyframes")
  `);
  assert.deepEqual([...ids].sort(), ["bg", "hero"]);
});

test("引用：不带参数的旧 key() 仍然算数", () => {
  // A project made before the argument existed must not lose its files on the
  // next integrity check.
  const ids = referencedIds(`
    hero.key()
    bg.key()
  `);
  assert.deepEqual([...ids].sort(), ["bg", "hero"]);
});

test("引用：旧写法 followPath(\"id\") 仍然算数", () => {
  // A project made before keys were bound to objects must not lose its files on
  // the next integrity check, so the old spelling is read as well.
  const ids = referencedIds(`ch.followPath("a1b2")`);
  assert.deepEqual([...ids], ["a1b2"]);
});

test("引用：注释里提到也算数（保守），但认不出的东西不判定为", () => {
  assert.equal(referencedIds(`// hero.key()`).has("hero"), true);
  assert.equal(referencedIds(`hero.move(1, 2, 100)`).size, 0);
  assert.equal(referencedIds(`key(变量)`).size, 0, "不是方法调用不判定为");
});

test("清理：只删 data/ 下没人引用的关键帧文件", () => {
  const existing = [
    "data/key-hero.keyframes",
    "data/key-drop.keyframes",
    "scripts/main.pe",
    "assets/Background/bg.png",
  ];
  const dropped = unreferencedPaths(existing, 'hero.key("key-hero.keyframes")');
  assert.deepEqual(dropped, ["data/key-drop.keyframes"]);
});

test("清理：一条引用都没有时，所有关键帧文件都被删", () => {
  const existing = ["data/key-a.keyframes", "data/key-b.json"];
  assert.deepEqual(unreferencedPaths(existing, ""), existing);
});

// --- 舞台播放 ---

test("舞台：沿路径走到终点，位置被记住", async () => {
  await inFakeDom(async () => {
    const path = straightPath(40);
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: (id) => (id === "hero" ? path : null),
    });
    // Build a character through the same constructor the script uses.
    const character = createStageObjects(stage).Character(["hero.png"], {
      assignee: "hero",
    });
    character.enable();
    const returned = character.key();
    assert.equal(returned, character, "followPath 可链式");
    // The end of the path is where the object now stands.
    await wait(150);
    assert.ok(Math.abs(character.px - 100) < 1e-6, `终点 x 应为 100，实际 ${character.px}`);
    assert.ok(Math.abs(character.py) < 1e-6);
    stage.clear();
  });
});

test("舞台：读不到的路径被报出，调用本身不抛出异常", async () => {
  await inFakeDom(async () => {
    const missing = [];
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => null,
      onMissingPath: (id) => missing.push(id),
    });
    const character = createStageObjects(stage).Character(["hero.png"], {
      assignee: "hero",
    });
    character.enable();
    character.key();
    assert.deepEqual(missing, ["hero"], "报出的是对象名，路径按它查表");
    stage.clear();
  });
});

test("舞台：重放时路径一次到位，不等任何一帧", async () => {
  await inFakeDom(async () => {
    const path = straightPath(5000);
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => path,
    });
    stage.setReplay(true);
    const character = createStageObjects(stage).Character(["hero.png"], {
      assignee: "hero",
    });
    character.enable();
    character.key();
    // Nothing was awaited: a replay travels rather than performs.
    assert.ok(Math.abs(character.px - 100) < 1e-6, "重放应立刻在终点");
    stage.setReplay(false);
    stage.clear();
  });
});

// --- 预览行程定位 ---

/**
 * Runs a script up to the line a key sits on, the way the path editor does.
 *
 * This is the same shape as `main.js::stageAtKey`: preview mode, choices take
 * their first branch, and the run is unwound by a thrown signal when it reaches
 * the key's line. Kept here so the *mechanism* can be tested without a DOM
 * editor around it.
 */
async function travelToKey(stage, source, targetLine) {
  const STOP = Symbol("stopAtKey");
  let found = false;
  stage.setPreview(true);
  let result = null;
  try {
    result = await run(source, {
      constructors: createStageObjects(stage),
      globals: createStageGlobals(stage),
      preview: true,
      choose: (labels) => Promise.resolve(labels?.length ? 0 : -1),
      onNode: (_at, statement) => {
        if (Number.isFinite(statement?.line) && statement.line >= targetLine) {
          found = true;
          throw STOP;
        }
      },
    });
  } catch (error) {
    if (error !== STOP) {
      throw error;
    }
  } finally {
    stage.setPreview(false);
  }
  // A script that fails partway ends the journey silently otherwise: `run`
  // reports an error by returning, not by throwing, so it has to be read.
  if (!found && result?.error) {
    throw new Error(`行程中途报错：${result.error.message}`);
  }
  return found;
}

test("预览行程：越过 say / wait / choice 走到 key", async () => {
  await inFakeDom(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => null,
      onMissingPath: () => {},
    });
    const lines = [
      'ch = Character("hero.png")', // 1
      "ch.enable()", // 2
      'ch.say("先说一句")', // 3 ← 等点击
      "wait 5000", // 4 ← 停顿五秒
      'dialog.say("旁白")', // 5 ← 又一句
      "choice {", // 6
      '  "选项一" { ch.alpha(0.5) }', // 7
      '  "选项二" { ch.alpha(1) }', // 8
      "}", // 9
      "ch.key()", // 10 ← 目标
      "ch.key()", // 11
    ].join("\n");

    const started = Date.now();
    const found = await travelToKey(stage, lines, 10);
    const elapsed = Date.now() - started;

    assert.equal(found, true, "应当走到 key 那一行");
    // The journey must not be paced by the script: `wait 5000` alone would blow
    // this budget if pauses still held, and the `say` would hang forever.
    assert.ok(elapsed < 1000, `行程不该被剧本拖慢，实际 ${elapsed}ms`);
    stage.clear();
  });
});

test("预览行程：不预览时 say 会把运行挂住（对照）", async () => {
  await inFakeDom(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => null,
    });
    // Regression case: without preview, a line before the key waits for a
    // click that never occurs, so the editor would never open.
    let settled = false;
    run(['ch = Character("hero.png")', "ch.enable()", 'ch.say("等点击")', "ch.key()"].join("\n"), {
      constructors: createStageObjects(stage),
    }).then(() => {
      settled = true;
    });
    await wait(80);
    assert.equal(settled, false, "没有预览时，台词会一直等下去");
    stage.clear();
  });
});

test("预览行程：pause 真的被跳过（而不是只快了一点）", async () => {
  await inFakeDom(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => null,
    });
    const lines = ["wait 3000", "wait 3000", "ch.key()"].join("\n");
    const started = Date.now();
    const found = await travelToKey(stage, lines, 3);
    const elapsed = Date.now() - started;
    assert.equal(found, true);
    // Two three-second pauses: anything near that means they still held.
    assert.ok(elapsed < 200, `两段 wait 应被跳过，实际 ${elapsed}ms`);
    stage.clear();
  });
});

/** Resolves after `ms` milliseconds. */
function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("脚本：hero.followPath(\"id\") 能被真实解释器调用", async () => {
  const { run } = await import("../pamela.js");
  const path = straightPath(30);
  await inFakeDom(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: (id) => (id === "hero" ? path : null),
    });
    const result = await run(
      ['hero = Character("hero.png")', "hero.enable()", 'hero.key()'].join(
        "\n",
      ),
      { constructors: createStageObjects(stage) },
    );
    assert.equal(result.error, undefined, `脚本不该报错：${result.error?.message}`);
    stage.clear();
  });
});

// --- 关键帧 ---

test("关键帧：起点是第 0 帧，每段贡献一帧", () => {
  const path = normalizePath({
    id: "k1",
    start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 100, end: { rotation: 90 } },
      { type: "line", points: [[10, 0], [20, 0]], time: 200, end: { rotation: 180 } },
    ],
  });
  const frames = keyFrames(path);
  assert.equal(frames.length, 3, "起点 + 两段");
  assert.deepEqual(
    frames.map((f) => f.time),
    [0, 100, 300],
    "时间按各段时长累加",
  );
  assert.equal(frames[1].rotation, 90);
  assert.equal(frames[2].rotation, 180);
});

test("关键帧：没写 end 的段沿用上一帧", () => {
  const path = normalizePath({
    id: "k2",
    start: { x: 0, y: 0, rotation: 45, scale: 2, alpha: 0.5 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 100 },
      { type: "line", points: [[10, 0], [20, 0]], time: 100, end: { alpha: 1 } },
    ],
  });
  const frames = keyFrames(path);
  assert.equal(frames[1].rotation, 45, "第一段没写 end，保持起点");
  assert.equal(frames[1].scale, 2);
  assert.equal(frames[1].alpha, 0.5);
  assert.equal(frames[2].rotation, 45, "第二段只写了 alpha，其余仍沿用");
  assert.equal(frames[2].alpha, 1);
});

test("关键帧：帧之间的属性线性插值", () => {
  const path = normalizePath({
    id: "k3",
    start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
    segments: [
      { type: "line", points: [[0, 0], [100, 0]], time: 1000, end: { rotation: 90, scale: 2, alpha: 0 } },
    ],
  });
  const half = frameAt(path, 500);
  assert.ok(Math.abs(half.rotation - 45) < 1e-9);
  assert.ok(Math.abs(half.scale - 1.5) < 1e-9);
  assert.ok(Math.abs(half.alpha - 0.5) < 1e-9);
});

test("关键帧：旋转不折返，0 到 720 是两整圈", () => {
  const path = normalizePath({
    id: "k4",
    start: { x: 0, y: 0 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 1000, end: { rotation: 720 } },
    ],
  });
  assert.ok(Math.abs(frameAt(path, 500).rotation - 360) < 1e-9, "中途是 360 而非 0");
});

test("关键帧：超出总时长停在最后一帧", () => {
  const path = normalizePath({
    id: "k5",
    start: { x: 0, y: 0 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 100, end: { rotation: 90, alpha: 0.25 } },
    ],
  });
  const after = frameAt(path, 99999);
  assert.equal(after.rotation, 90);
  assert.equal(after.alpha, 0.25);
});

test("关键帧：透明度被夹在 0–1，缩放 0 被丢弃而不是照用", () => {
  // `normalizeFrame` keeps only what is usable; what it drops is carried over
  // by `resolveFrame`, which is the only place that knows the frame before.
  const frame = normalizeFrame({ alpha: 5, scale: 0 });
  assert.equal(frame.alpha, 1, "超过 1 夹到 1");
  assert.equal("scale" in frame, false, "缩放 0 不可用，被丢弃");
  assert.equal(resolveFrame(frame).scale, 1, "丢弃后由上一帧/默认补上");
  assert.equal(normalizeFrame({ alpha: -3 }).alpha, 0, "小于 0 夹到 0");
  // A property that was never written is absent, not defaulted.
  assert.deepEqual(normalizeFrame({}), {});
});

test("关键帧：旧文件（无 end、无属性）仍播放", () => {
  const path = normalizePath({
    id: "old",
    start: { x: 0, y: 0 },
    segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 1000 }],
  });
  const frames = keyFrames(path);
  assert.equal(frames.length, 2);
  // Nothing animates but the position, which is what a pre-key-frame file meant.
  // `null` says "this path does not specify", so the runtime leaves the object's
  // own rotation, size and opacity alone rather than resetting them to defaults.
  const half = frameAt(path, 500);
  assert.deepEqual(half, { rotation: null, scale: null, alpha: null });
  assert.deepEqual(animatedProps(path), { rotation: false, scale: false, alpha: false });
});

test("关键帧：写文件时保留 end，没写的段不凭空加", () => {
  const file = buildPathFile({
    id: "k6",
    start: { x: 0, y: 0 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 100, end: { rotation: 90 } },
      { type: "line", points: [[10, 0], [20, 0]], time: 100 },
    ],
  });
  // A written frame is written whole, so the file reads without needing the
  // frame before it; a segment that named none has no `end` key at all.
  assert.deepEqual(file.segments[0].end, { rotation: 90, scale: 1, alpha: 1 });
  assert.equal("end" in file.segments[1], false, "没写的段不编造 end");
});

test("舞台：一次 followPath 同时驱动位置、旋转、缩放、透明度", async () => {
  await inFakeDom(async () => {
    const path = normalizePath({
      id: "anim1",
      start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
      segments: [
        {
          type: "line",
          points: [[0, 0], [100, 0]],
          time: 40,
          end: { rotation: 90, scale: 2, alpha: 0 },
        },
      ],
    });
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => path,
    });
    const character = createStageObjects(stage).Character(["hero.png"], { assignee: "hero" });
    character.enable();
    character.key();
    await wait(150);

    assert.ok(Math.abs(character.px - 100) < 1e-6, `位置应到终点，实际 ${character.px}`);
    assert.ok(Math.abs(character.rotation - 90) < 1e-6, `旋转应到 90，实际 ${character.rotation}`);
    assert.ok(Math.abs(character.size - 2) < 1e-6, `缩放应到 2，实际 ${character.size}`);
    stage.clear();
  });
});

test("舞台：重放时关键帧也一次到位", async () => {
  await inFakeDom(async () => {
    const path = normalizePath({
      id: "anim2",
      start: { x: 0, y: 0 },
      segments: [
        { type: "line", points: [[0, 0], [100, 0]], time: 5000, end: { rotation: 180, scale: 3 } },
      ],
    });
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => path,
    });
    stage.setReplay(true);
    const character = createStageObjects(stage).Character(["hero.png"], { assignee: "hero" });
    character.enable();
    character.key();
    // No await: a replay lands on the last key frame at once.
    assert.ok(Math.abs(character.px - 100) < 1e-6);
    assert.ok(Math.abs(character.rotation - 180) < 1e-6, "旋转应已到 180");
    assert.ok(Math.abs(character.size - 3) < 1e-6, "缩放应已到 3");
    stage.setReplay(false);
    stage.clear();
  });
});

test("舞台：没有关键帧的旧路径不改变旋转与缩放", async () => {
  await inFakeDom(async () => {
    const path = normalizePath({
      id: "old2",
      start: { x: 0, y: 0 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 30 }],
    });
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolvePath: () => path,
    });
    const character = createStageObjects(stage).Character(["hero.png"], { assignee: "hero" });
    character.rotate(45);
    character.enable();
    character.key();
    await wait(120);
    assert.ok(Math.abs(character.px - 100) < 1e-6, "位置照常走");
    assert.ok(Math.abs(character.rotation - 45) < 1e-6, `旋转应保持不变，实际 ${character.rotation}`);
    assert.ok(Math.abs(character.size - 1) < 1e-6, "缩放应保持 1");
    stage.clear();
  });
});

test("舞台：cue 里 rotate 比 key 长，路径走完后仍转到终点", async () => {
  await inFakeDom(async () => {
    const created = [];
    const make = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => {
      const node = make(tag);
      created.push(node);
      return node;
    };
    try {
      // A 40 ms walk beside a 160 ms turn: before the fix the turn stopped with
      // the walk at 40/160 = 25% of 360°, leaving the character at 90°.
      const path = normalizePath({
        id: "spin1",
        start: { x: 0, y: 0 },
        segments: [
          { type: "line", points: [[0, 0], [0, -300]], time: 40, end: { rotation: 0 } },
        ],
      });
      const stage = createStage({
        element: fakeElement(),
        surface: fakeElement(),
        resolveAsset: () => Promise.resolve("data:image/png;base64,"),
        resolvePath: () => path,
      });
      const character = createStageObjects(stage).Character(["hero.png"], { assignee: "hero" });
      character.enable();
      const image = created.find((node) => node.className === "stage__character");
      assert.ok(image, "角色图片已建好");
      character.key();
      character.rotate(360, 160);
      await wait(260);

      const degrees = Number(/rotate\(([-\d.]+)deg\)/.exec(String(image.style.transform))?.[1]);
      assert.ok(Math.abs(degrees - 360) < 0.01, `舞台上应转满 360°，实际 ${degrees}°`);
      assert.ok(
        Math.abs(character.rotation - 360) < 1e-6,
        `写回脚本对象的应是终点角度，实际 ${character.rotation}`,
      );
      assert.ok(Math.abs(character.py + 300) < 1e-6, `位移不受旋转影响，实际 ${character.py}`);
      stage.clear();
    } finally {
      globalThis.document.createElement = make;
    }
  });
});

test("关键帧：只有一段声明了属性，整条路径都算驱动了它", () => {
  const path = normalizePath({
    id: "mix",
    start: { x: 0, y: 0 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 100 },
      { type: "line", points: [[10, 0], [20, 0]], time: 100, end: { alpha: 0.5 } },
    ],
  });
  // The first segment says nothing, the second names alpha — so the path does
  // drive opacity, and does not drive rotation or scale.
  assert.deepEqual(animatedProps(path), { rotation: false, scale: false, alpha: true });
  assert.equal(frameAt(path, 0).alpha, 1, "起点取默认 1");
  assert.equal(frameAt(path, 200).alpha, 0.5);
  assert.equal(frameAt(path, 100).rotation, null, "旋转路径不管");
});

test("关键帧：start 里写了的属性从第一帧就生效", () => {
  const path = normalizePath({
    id: "s",
    start: { x: 0, y: 0, rotation: 30, scale: 0.5, alpha: 0.8 },
    segments: [{ type: "line", points: [[0, 0], [10, 0]], time: 100 }],
  });
  assert.deepEqual(animatedProps(path), { rotation: true, scale: true, alpha: true });
  const at0 = frameAt(path, 0);
  assert.equal(at0.rotation, 30);
  assert.equal(at0.scale, 0.5);
  assert.equal(at0.alpha, 0.8);
});

// --- 路径编辑：删点 / 加点 / 曲率 ---

test("编辑：删掉中间的点，前后两点连成一段", () => {
  // a b c → a c. The line is reconnected through the neighbours rather than
  // left with a gap, which is the key constraint of the edit.
  const segment = {
    type: "line",
    points: [
      [0, 0],
      [100, 0],
      [200, 0],
    ],
  };
  const next = removePointAt(segment, 1);
  assert.deepEqual(next.points, [
    [0, 0],
    [200, 0],
  ]);
  assert.equal(samplePath({ start: { x: 0, y: 0 }, segments: [next] }).length, 2);
});

test("编辑：两个点也能删到只剩一个起始点", () => {
  const segment = {
    type: "line",
    points: [
      [0, 0],
      [100, 0],
    ],
  };
  const next = removePointAt(segment, 1);
  assert.deepEqual(next.points, [[0, 0]]);
  // The last point is the protected one: deleting it would leave nothing to
  // draw, so it answers unchanged.
  assert.deepEqual(removePointAt({ type: "line", points: [[0, 0]] }, 0).points, [
    [0, 0],
  ]);
});

test("编辑：删点会一并收掉曲线把手，形状不会错位", () => {
  const segment = {
    type: "curve",
    points: [
      [0, 0],
      [50, 50],
      [100, 0],
      [150, -50],
      [200, 0],
    ],
    control: [
      [
        [10, 10],
        [90, 10],
      ],
      [
        [110, -10],
        [190, -10],
      ],
    ],
  };
  // Removing the first waypoint leaves one run, so one pair survives.
  const next = removePointAt(segment, 1);
  assert.equal(next.points.length, 4);
  assert.equal(next.control.length, 1);
  assert.deepEqual(next.control[0], [
    [10, 10],
    [90, 10],
  ]);
});

test("编辑：在路径上加点，新点在两邻点之间", () => {
  const segment = {
    type: "line",
    points: [
      [0, 0],
      [200, 0],
    ],
  };
  const next = insertPointOnPath(segment, 1, 100, 0);
  assert.deepEqual(next.points, [
    [0, 0],
    [100, 0],
    [200, 0],
  ]);
});

test("编辑：曲线加点按 de Casteljau 劈成两段，形状一点没变", () => {
  // A curve's points are start → waypoint → end per run, so splitting one run
  // makes two: the new point on the line, plus the waypoint the second half
  // bends through. What must hold is that the drawn curve is the same curve.
  const segment = {
    type: "curve",
    points: [
      [0, 0],
      [50, 50],
      [100, 0],
    ],
  };
  const before = sampleSegment(segment);
  const next = insertPointOnPath(segment, 1, 50, 37.5);
  assert.equal(next.points.length, 5, "一段变两段，点也变两组");
  assert.equal(next.control.length, 2);
  const after = sampleSegment({ type: "curve", ...next });
  // Same shape: every sample of the split curve is within a rounding error of
  // the original at the matching parameter.
  const at = (t) => before[Math.round(t * (before.length - 1))];
  const at2 = (t) => after[Math.round(t * (after.length - 1))];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const a = at(t);
    const b = at2(t);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 6, `t=${t} 处的形状`);
  }
});

test("编辑：曲率 0 拉直、1 是默认弯度、2 更弯", () => {
  const make = () => ({
    type: "curve",
    points: [
      [0, 0],
      [100, 100],
      [200, 0],
    ],
  });

  const straight = make();
  setCurvature(straight, 0, 0);
  assert.deepEqual(straight.control[0], [
    [0, 0],
    [200, 0],
  ]);

  const normal = make();
  setCurvature(normal, 0, 1);
  assert.deepEqual(normal.control[0], [
    [100, 100],
    [100, 100],
  ]);

  const deeper = make();
  setCurvature(deeper, 0, 2);
  assert.deepEqual(deeper.control[0], [
    [200, 200],
    [0, 200],
  ]);
});

test("编辑：曲率只作用于指定的那一小段", () => {
  const segment = {
    type: "curve",
    points: [
      [0, 0],
      [50, 50],
      [100, 0],
      [150, -50],
      [200, 0],
    ],
  };
  assert.equal(setCurvature(segment, 1, 0), true);
  assert.equal(segment.control[0], null, "第一段未修改");
  assert.ok(segment.control[1], "第二段写下了显式把手");
  // A run that does not exist is refused rather than invented.
  assert.equal(setCurvature(segment, 9, 1), false);
});

// --- 关键帧文件的复制 / 重命名 ---

test("副本名：生成的是合法 id，且避开已存在的名字", () => {
  assert.equal(copyNameFor("key-ch.keyframes"), "key-ch-copy.keyframes");
  assert.equal(idFromPathFile(`data/${copyNameFor("key-ch.keyframes")}`), "ch-copy");
  assert.equal(
    copyNameFor("key-ch.keyframes", ["key-ch.keyframes", "key-ch-copy.keyframes"]),
    "key-ch-copy2.keyframes",
  );
  // 老工程里的 .json 也仍能复制，仍是被识其它关键帧文件。
  assert.equal(idFromPathFile(`data/${copyNameFor("key-ch.json")}`), "ch-copy");
});

test("副本名：不会用通用 uniqueName 那种带空格的中文名", () => {
  const name = copyNameFor("key-ch.keyframes");
  assert.equal(/\s/.test(name), false);
  assert.equal(isPathFile(`data/${name}`), true);
});

test("重命名：文档 id 与默认名跟着新文件走，动画一点不变", () => {
  const original = buildPathFile({
    id: "ch",
    start: { x: 10, y: 20, rotation: 30, scale: 1.2, alpha: 0.5 },
    segments: [
      { type: "line", points: [[10, 20], [110, 20]], time: 800, end: { rotation: 90 } },
    ],
  });
  const rebuilt = rehomePathDocument(original, "data/key-hero.keyframes");
  assert.equal(rebuilt.id, "hero");
  assert.equal(rebuilt.name, "hero");
  assert.deepEqual(rebuilt.start, original.start);
  assert.deepEqual(rebuilt.segments, original.segments);
  assert.equal(original.id, "ch", "原文档不被改动");
  assert.ok(referencedIds('hero.key("key-hero.keyframes")').has("hero"));
  assert.equal(
    unreferencedPaths(["data/key-hero.keyframes"], 'hero.key("key-hero.keyframes")').length,
    0,
    "改写后的引用让新文件不再被当成孤儿",
  );
});

test("重命名：作者手写的名字保留，从旧 id 派生的名字重新派生", () => {
  const named = buildPathFile({ id: "ch", name: "主角走位", segments: [] });
  assert.equal(rehomePathDocument(named, "data/key-hero.keyframes").name, "主角走位");
  const plain = buildPathFile({ id: "ch", segments: [] });
  assert.equal(rehomePathDocument(plain, "data/key-hero.keyframes").name, "hero");
});

test("重命名：目标不是关键帧文件时原样返回", () => {
  const original = buildPathFile({ id: "ch", segments: [] });
  assert.equal(rehomePathDocument(original, "assets/pic.png"), original);
  assert.equal(rehomePathDocument(null, "data/key-hero.keyframes"), null);
  assert.equal(rehomePathDocument("not a document", "data/key-hero.keyframes"), "not a document");
});
