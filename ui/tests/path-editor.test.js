// 运动路径编辑器纯逻辑测试：坐标换算与几何计算。
// Tests for the motion path editor's pure half: the coordinate conversion the

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  applyControlDrag,
  beginBend,
  createPathEditor,
  curveHandles,
  dragBend,
  HANDLE_DIRECTIONS,
  handlePositions,
  hitControl,
  hitLine,
  hitObject,
  hitPoint,
  insertPoint,
  intoBox,
  mirrorBends,
  mirrorPoint,
  outOfBox,
  pathViewBox,
  shiftedPointAt,
  percentToStage,
  removePoint,
  resizeFromHandle,
  rotateFromHandle,
  simplifyFreehand,
  stageToPercent,
  stageToViewBox,
} from "../path-editor.js";
import {
  animatedSizes,
  buildPathFile,
  frameAt,
  keyframesOf,
  linkFromSegment,
  normalizePath,
  pathFromKeyframes,
  pointAt,
  sampleSegment,
  segmentFromLink,
} from "../path.js";
import { STAGE_HEIGHT, STAGE_WIDTH } from "../stage.js";

// --- 坐标换算 ---

test("坐标：舞台原点在画面正中", () => {
  assert.deepEqual(stageToPercent(0, 0), { left: 50, top: 50 });
});

test("坐标：x 向右、y 向上，正好与百分比相反", () => {
  const right = stageToPercent(STAGE_WIDTH / 2, 0);
  assert.equal(right.left, 100, "右边缘是 100%");
  assert.equal(right.top, 50);

  const up = stageToPercent(0, STAGE_HEIGHT / 2);
  assert.equal(up.left, 50);
  assert.equal(up.top, 0, "y 向上对应 top 变小");
});

test("坐标：换算可逆", () => {
  for (const [x, y] of [
    [0, 0],
    [123, -456],
    [-960, 540],
    [960, -540],
  ]) {
    const percent = stageToPercent(x, y);
    const back = percentToStage(percent.left, percent.top);
    assert.ok(Math.abs(back.x - x) < 1e-9, `x 往返 ${x} → ${back.x}`);
    assert.ok(Math.abs(back.y - y) < 1e-9, `y 往返 ${y} → ${back.y}`);
  }
});

// --- 命中 ---

test("命中：命中近处的点，未命中远处的", () => {
  const segment = {
    points: [
      [0, 0],
      [500, 0],
    ],
  };
  assert.equal(hitPoint(segment, 0, 0), 0);
  assert.equal(hitPoint(segment, 500, 0), 1);
  assert.equal(hitPoint(segment, 250, 0), -1, "两点中间是空的");
});

test("命中：半径按画面百分比算，不按舞台单位", () => {
  const segment = { points: [[0, 0]] };
  // One per-cent of the frame's width is 19.2 stage units, so 10 units away is
  // well inside the default grab radius and 100 units is outside it.
  assert.equal(hitPoint(segment, 10, 0), 0);
  assert.equal(hitPoint(segment, 100, 0), -1);
});

test("命中：多个点都在半径内时取最近的", () => {
  const segment = {
    points: [
      [0, 0],
      [12, 0],
    ],
  };
  // Both are inside the default radius; the second is the closer of the two.
  assert.equal(hitPoint(segment, 10, 0), 1);
  assert.equal(hitPoint(segment, 2, 0), 0);
});

test("命中：没有点时答 -1", () => {
  assert.equal(hitPoint({ points: [] }, 0, 0), -1);
  assert.equal(hitPoint(null, 0, 0), -1);
});

// --- 增删点 ---

test("加点：默认追加到末尾", () => {
  const points = insertPoint({ points: [[0, 0], [10, 0]] }, 2, 20, 5);
  assert.deepEqual(points, [
    [0, 0],
    [10, 0],
    [20, 5],
  ]);
});

test("加点：可以在中间插入，后面的点依次后移", () => {
  const points = insertPoint({ points: [[0, 0], [10, 0]] }, 1, 5, 5);
  assert.deepEqual(points, [
    [0, 0],
    [5, 5],
    [10, 0],
  ]);
});

test("加点：不改动原数组", () => {
  const original = { points: [[0, 0], [10, 0]] };
  insertPoint(original, 2, 99, 99);
  assert.equal(original.points.length, 2);
});

test("删点：删掉中间的点，后面的补上来", () => {
  const points = removePoint({ points: [[0, 0], [5, 5], [10, 0]] }, 1);
  assert.deepEqual(points, [
    [0, 0],
    [10, 0],
  ]);
});

test("删点：可以删到只剩一个点", () => {
  const points = removePoint({ points: [[0, 0], [10, 0]] }, 1);
  assert.deepEqual(points, [[0, 0]]);
  // The last point is protected: the helper does not empty a segment on its own.
  assert.equal(removePoint({ points: [[0, 0]] }, 0).length, 1);
});

test("删点：越界下标不动数组", () => {
  const points = removePoint({ points: [[0, 0], [5, 5], [10, 0]] }, 9);
  assert.equal(points.length, 3);
});

// --- 自由绘制简化 ---

test("简化：三个点里中间那个在直线上，被过滤", () => {
  const simplified = simplifyFreehand(
    [
      [0, 0],
      [50, 0],
      [100, 0],
    ],
    1,
  );
  assert.deepEqual(simplified, [
    [0, 0],
    [100, 0],
  ]);
});

test("简化：偏离直线的点被保留", () => {
  const simplified = simplifyFreehand(
    [
      [0, 0],
      [50, 30],
      [100, 0],
    ],
    1,
  );
  assert.equal(simplified.length, 3, "拐点必须留下");
});

test("简化：点太少时原样返回", () => {
  assert.deepEqual(simplifyFreehand([[0, 0]]), [[0, 0]]);
  assert.deepEqual(
    simplifyFreehand([
      [0, 0],
      [10, 10],
    ]),
    [
      [0, 0],
      [10, 10],
    ],
  );
  assert.deepEqual(simplifyFreehand(null), []);
});

test("简化：一段抖动的采样收敛到两端", () => {
  // A hand-drawn straight stroke: every sample wiggles a little around y = 0.
  const stroke = [];
  for (let index = 0; index <= 100; index += 1) {
    stroke.push([index * 2, index % 2 === 0 ? 0.2 : -0.2]);
  }
  const simplified = simplifyFreehand(stroke, 1);
  assert.ok(simplified.length < 6, `抖动应被压平，实际留下 ${simplified.length} 个点`);
  assert.deepEqual(simplified[0], stroke[0]);
  assert.deepEqual(simplified[simplified.length - 1], stroke[stroke.length - 1]);
});

test("简化：简化后仍保持原来的先后顺序", () => {
  const simplified = simplifyFreehand(
    [
      [0, 0],
      [10, 40],
      [20, 0],
      [30, 40],
      [40, 0],
    ],
    1,
  );
  for (let index = 1; index < simplified.length; index += 1) {
    assert.ok(simplified[index][0] >= simplified[index - 1][0], "x 单调不减");
  }
});

// --- 曲线控制点 ---

test("曲线：每三个点一对控制点，直线段没有", () => {
  const curve = { type: "curve", points: [[0, 0], [5, 5], [10, 0]] };
  assert.equal(curveHandles(curve).length, 1);
  assert.deepEqual(curveHandles(curve)[0], [
    [5, 5],
    [5, 5],
  ], "默认控制点落在途经点上");

  const long = { type: "curve", points: [[0, 0], [5, 5], [10, 0], [15, 5], [20, 0]] };
  assert.equal(curveHandles(long).length, 2);

  // A line has no control points to drag, and neither does a curve too short
  // to hold one bend.
  assert.equal(curveHandles({ type: "line", points: [[0, 0], [10, 0]] }).length, 0);
  assert.equal(curveHandles({ type: "curve", points: [[0, 0], [10, 0]] }).length, 0);
});

// --- 曲线控制点 ---

test("控制点：命中曲线上的控制点，未命中直线上的", () => {
  const curve = {
    type: "curve",
    points: [
      [0, 0],
      [50, 40],
      [100, 0],
    ],
  };
  // The default control pair sits on the waypoint, so grabbing there finds it.
  assert.deepEqual(hitControl(curve, 50, 40), { run: 0, side: 0 });
  assert.equal(hitControl(curve, 500, 500), null, "远处未命中");

  const line = { type: "line", points: [[0, 0], [10, 0]] };
  assert.equal(hitControl(line, 0, 0), null, "直线没有控制点");
});

test("控制点：多段曲线各自可抓", () => {
  const curve = {
    type: "curve",
    points: [
      [0, 0],
      [50, 40],
      [100, 0],
      [150, -40],
      [200, 0],
    ],
  };
  const first = hitControl(curve, 50, 40);
  const second = hitControl(curve, 150, -40);
  assert.equal(first.run, 0);
  assert.equal(second.run, 1);
});

test("控制点：拖一次就写进 segment.control，形状不再由点推算", () => {
  const curve = {
    type: "curve",
    points: [
      [0, 0],
      [50, 40],
      [100, 0],
    ],
  };
  assert.equal(curve.control, undefined, "拖动之前没有显式控制点");

  const grip = hitControl(curve, 50, 40);
  applyControlDrag(curve, grip, { x: 50, y: 200 });

  assert.ok(Array.isArray(curve.control), "拖动之后写下了 control");
  assert.deepEqual(curve.control[0][0], [50, 200], "被拖的那一侧挪到了新位置");
  // The other side keeps the derived value, so only the grabbed handle moved.
  assert.deepEqual(curve.control[0][1], [50, 40]);
});

test("控制点：拖另一侧只动另一侧", () => {
  const curve = {
    type: "curve",
    points: [
      [0, 0],
      [50, 40],
      [100, 0],
    ],
  };
  const grip = hitControl(curve, 50, 40);
  applyControlDrag(curve, { run: 0, side: 1 }, { x: -20, y: -30 });
  assert.deepEqual(curve.control[0][1], [-20, -30]);
  assert.deepEqual(curve.control[0][0], [50, 40]);
});

test("控制点：对直线或空手柄拖动是空操作", () => {
  const line = { type: "line", points: [[0, 0], [10, 0]] };
  applyControlDrag(line, { run: 0, side: 0 }, { x: 9, y: 9 });
  assert.equal(line.control, undefined);
  assert.doesNotThrow(() => applyControlDrag(null, null, { x: 0, y: 0 }));
});

// --- 拖线条改曲度 ---

test("线条：按在画出来的线上才命中", () => {
  const line = { type: "line", points: [[-100, 0], [100, 0]] };
  const middle = hitLine(line, 0, 0);
  assert.ok(middle, "线中间命中");
  assert.equal(middle.run, 0);
  assert.ok(Math.abs(middle.t - 0.5) < 0.05, "命中位置为中点");
  assert.equal(hitLine(line, 0, 400), null, "离得远就未命中");

  // A curve is grabbed where it is drawn, not where its chord is: the midpoint
  // of the two ends is not on the line once it bends.
  const curve = { type: "curve", points: [[-100, 0], [0, 200], [100, 0]] };
  assert.equal(hitLine(curve, 0, 0), null, "弦的中点上没有线");
  assert.ok(hitLine(curve, 0, 150), "画出来的线上有");
});

test("线条：多段直线各自可抓，run 按相邻点算", () => {
  const line = { type: "line", points: [[-200, 0], [-100, 0], [100, 0]] };
  assert.equal(hitLine(line, -150, 0).run, 0);
  assert.equal(hitLine(line, 0, 0).run, 1);
});

test("弯线：两点直线拖动变成经过指针的贝塞尔", () => {
  const segment = { type: "line", points: [[-100, 0], [100, 0]] };
  const grip = beginBend(segment, hitLine(segment, 0, 0));

  assert.equal(segment.type, "curve", "直线被展开成曲线");
  assert.equal(segment.points.length, 3, "补了一个途经点");
  assert.deepEqual(segment.points[1], [0, 0], "途经点先落在弦上，形状不变");

  dragBend(segment, grip, { x: 0, y: 120 });

  const walked = sampleSegment(segment);
  const middle = walked[Math.round((walked.length - 1) / 2)];
  assert.ok(Math.abs(middle[0]) < 1, "中点横坐标还在中间");
  assert.ok(Math.abs(middle[1] - 120) < 2, "画出来的线从指针下方经过");
});

test("弯线：多点直线展开后原来每个子段都能弯", () => {
  const segment = { type: "line", points: [[-200, 0], [-100, 0], [100, 0]] };
  const grip = beginBend(segment, { run: 1, t: 0.5 });

  assert.equal(segment.points.length, 5, "每个相邻对补一个途经点");
  assert.equal(grip.run, 1, "run 还是原来那个子段");
  // 展开本身不改形状：所有途经点都在同一条弦上，采样出来仍是水平直线。
  for (const [, y] of sampleSegment(segment)) {
    assert.ok(Math.abs(y) < 0.001, "展开后仍是直线");
  }

  dragBend(segment, grip, { x: 0, y: 100 });
  const walked = sampleSegment(segment);
  assert.ok(
    walked.some(([, y]) => y > 90),
    "被拖的那一段弯出来了",
  );
  assert.ok(
    walked.some(([, y]) => Math.abs(y) < 0.001),
    "没被拖的那一段还是直的",
  );
});

test("弯线：已有显式控制点的那一段，拖动后重新由途经点决定", () => {
  const curve = {
    type: "curve",
    points: [[0, 0], [50, 40], [100, 0]],
    control: [[[50, 200], [50, 200]]],
  };
  const grip = beginBend(curve, { run: 0, t: 0.5 });
  assert.equal(grip.run, 0);
  assert.equal(curve.control, null, "旧把手被清掉，否则拖不动线");
  assert.deepEqual(curve.points[1], [50, 40], "点本身没被动过");
});

test("弯线：只有两端的曲线段也能拖", () => {
  // 切成「曲线」但没有第三个点时，它还没有 cubic；拖线应当补上一个。
  const segment = { type: "curve", points: [[-100, 0], [100, 0]] };
  const grip = beginBend(segment, hitLine(segment, 0, 0));
  assert.ok(grip, "两点曲线也命中");
  assert.equal(segment.points.length, 3, "补了途经点");
  dragBend(segment, grip, { x: 0, y: 90 });
  const walked = sampleSegment(segment);
  assert.ok(Math.max(...walked.map(([, y]) => y)) > 60, "拖出了曲度");
});

test("弯线：坏输入是空操作", () => {
  assert.equal(beginBend({ type: "line", points: [[0, 0]] }, { run: 0, t: 0.5 }), null);
  assert.equal(beginBend(null, { run: 0, t: 0.5 }), null);
  const line = { type: "line", points: [[0, 0], [10, 0]] };
  assert.doesNotThrow(() => dragBend(line, { run: 0, t: 0.5 }, { x: 5, y: 5 }));
  assert.deepEqual(line.points, [[0, 0], [10, 0]], "直线不接受弯线拖动");
});

// --- 关键帧面板 ---

test("关键帧：面板默认关闭，载入后打开、关闭后收起", () => {
  // The editor is built over stand-in elements: what is checked is that
  // construction and the panel's own state work without a browser, which is
  // what the module guarantees — the dock is DOM, but whether it is open is not.
  // The whole sequence runs inside the stub: `load` and `render` build DOM, and
  // the stub is only in place for the duration of the callback.
  withFakeDom(() => {
    const mount = {
      children: [],
      append(...nodes) {
        mount.children.push(...nodes);
      },
    };
    const editor = createPathEditor({ mount });
    assert.equal(editor.isOpen(), false, "建好之后是关闭的");

    editor.load("kf1", { id: "kf1", start: { x: 0, y: 0 }, segments: [] });
    assert.equal(editor.isOpen(), true);
    assert.equal(editor.value().id, "kf1");
    // Loading a path does not open the dock: placing points is the common case.
    assert.equal(editor.value().version, 2, "写出的文件是当前版本");

    editor.close();
    assert.equal(editor.isOpen(), false);
    assert.equal(editor.value(), null, "关闭后不再持有路径");
  });
});

// --- 撤销 / 重做 / 返回 ---

test("撤销与重做：提交一个关键帧、撤回来、再重做掉", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    const editor = createPathEditor({ mount });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 100 }],
    });

    // No change yet: there is nothing to undo.
    assert.equal(editor.undo(), false);
    assert.equal(editor.keyframes().length, 2, "起点 + 一段 = 两帧");

    // The author drags the object somewhere else, turns it, then double-clicks
    // it to commit that whole state as a key frame.
    editor.setLiveState({ x: 240, y: 120, rotation: 90 });
    assert.equal(editor.commitFrame(), true);
    assert.equal(editor.keyframes().length, 3);
    assert.equal(editor.isDirty(), true);
    // The two connections are straight lines until the author bends one.
    assert.equal(editor.value().segments[0].type, "line");
    assert.equal(editor.value().segments[1].type, "line");

    assert.equal(editor.undo(), true);
    assert.equal(editor.keyframes().length, 2, "撤回来，新帧没了");

    assert.equal(editor.redo(), true);
    assert.equal(editor.keyframes().length, 3, "再重做，新帧回来了");
  });
});

test("撤销：载入另一份文件会清空历史，撤不到上一份去", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    const editor = createPathEditor({ mount });
    editor.load("a", {
      id: "a",
      start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 100 }],
    });
    editor.setLiveState({ x: 50 });
    editor.commitFrame();
    assert.equal(editor.undo(), true);
    // A new document starts a new history: undoing into the file that was open
    // before would be undoing a file the author never touched.
    editor.load("b", { id: "b", start: { x: 0, y: 0 }, segments: [] });
    assert.equal(editor.undo(), false);
    assert.equal(editor.value().id, "b");
  });
});

test("返回：有改动时先保存，再回到脚本", async () => {
  const saved = [];
  let backed = null;
  await withFakeDom(async () => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    const editor = createPathEditor({
      mount,
      onSave: (file) => saved.push(file),
      onBack: (id) => {
        backed = id;
      },
    });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 100 }],
    });
    // No changes: nothing is written, and the caller is still told to go back.
    await editor.back();
    assert.equal(saved.length, 0, "没改动就不写文件");
    assert.equal(backed, "ch");
    assert.equal(editor.isOpen(), false, "返回之后编辑器是关着的");
  });
});

/** A stand-in element, enough for the editor to be built in node. */
function fakeNode() {
  const listeners = new Map();
  const node = {
    className: "",
    hidden: false,
    style: {},
    childNodes: [],
    append(...children) {
      node.childNodes.push(...children);
    },
    replaceChildren(...children) {
      node.childNodes = children;
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    /** Fires one of the handlers the editor attached, so a drag is a real drag. */
    dispatch(type, detail = {}) {
      const event = {
        button: 0,
        clientX: 0,
        clientY: 0,
        pointerId: 1,
        shiftKey: false,
        preventDefault() {},
        stopPropagation() {},
        ...detail,
      };
      for (const handler of listeners.get(type) ?? []) {
        handler(event);
      }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
  };
  return node;
}

/** Runs `body` with a minimal `document`, so a DOM module can be constructed. */
function withFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => fakeNode(),
    createElementNS: () => fakeNode(),
  };
  const restore = () => {
    globalThis.document = previous;
  };
  let result;
  try {
    result = body();
  } catch (error) {
    restore();
    throw error;
  }
  // A test that awaits something — `save()` is asynchronous — must keep the
  // stand-in document until it settles: the editor redraws after the save, and
  // taking the document away first leaves that redraw with nothing to draw on.
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => {
        restore();
        return value;
      },
      (error) => {
        restore();
        throw error;
      },
    );
  }
  restore();
  return result;
}

// --- 起点绑定到对象 ---

test("起点：载入时绑到对象轮廓的中心", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    // An object standing off-centre, as it would be at the moment its key plays.
    const box = { x: 240, y: -180, width: 400, height: 600 };
    const editor = createPathEditor({ mount, objectBox: () => box });

    editor.load("ch", { id: "ch", start: { x: 999, y: 999 }, segments: [] });
    const saved = editor.value();
    assert.equal(saved.start.x, 240, "起点 x 取自对象，不是文件里写的");
    assert.equal(saved.start.y, -180, "起点 y 取自对象");
  });
});

test("起点：没有对象时保留文件里的起点", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    // No box: the object is not on the stage, so there is no true starting
    // point and the file's own value stands rather than being guessed at.
    const editor = createPathEditor({ mount, objectBox: () => null });
    editor.load("ch", { id: "ch", start: { x: 12, y: 34 }, segments: [] });
    const saved = editor.value();
    assert.equal(saved.start.x, 12);
    assert.equal(saved.start.y, 34);
  });
});

test("起点：载入时整体平移所有帧，帧间位移不被改写", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    // The object has moved since the file was drawn: it now stands at (200,-100).
    const editor = createPathEditor({
      mount,
      objectBox: () => ({ x: 200, y: -100, width: 100, height: 100 }),
    });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0 },
      segments: [{ type: "line", points: [[0, 0], [0, -300]], time: 500 }],
    });
    const file = editor.value();
    assert.equal(file.start.x, 200, "起点绑到对象当前位置");
    assert.equal(file.start.y, -100);
    assert.deepEqual(
      file.segments[0].points,
      [[200, -100], [200, -400]],
      "只重绑第 0 帧会把向下的 300 改写成 200，或整段抹平；两帧必须一起平移",
    );
  });
});

test("起点：保存时不把起点拉到当前预览帧，向下的位移原样保留", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    // `syncPreview` pushes the selected frame onto the preview stage, so its box
    // follows the author's drag — it is no longer the object's starting spot.
    let box = { x: 0, y: 0, width: 100, height: 100 };
    const editor = createPathEditor({ mount, objectBox: () => box });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 },
      segments: [],
    });
    editor.setLiveState({ x: 0, y: -300 });
    box = { x: 0, y: -300, width: 100, height: 100 };
    assert.equal(editor.commitFrame(), true);
    return editor.save().then(() => {
      const file = editor.value();
      assert.equal(file.start.y, 0, "起点仍是对象载入时站的位置");
      assert.deepEqual(
        file.segments[0].points,
        [[0, 0], [0, -300]],
        "保存前重绑会把起点拖到第 2 帧，运行时就只剩下一段零位移",
      );
    });
  });
});

// --- 坐标系统 ---

test("坐标：view box 以画面中心为原点，不是左上角", () => {
  // Regression case: a box of `0 0 1920 1080` puts the stage's origin — the
  // centre of the frame — at the picture's top-left corner, so a key created in
  // the middle of the stage drew its points in the corner.
  const box = pathViewBox().split(" ").map(Number);
  assert.deepEqual(box, [-960, -540, 1920, 1080]);
  // The stage's own origin is therefore the middle of the box.
  assert.equal(box[0] + box[2] / 2, 0, "x 的原点在框中央");
  assert.equal(box[1] + box[3] / 2, 0, "y 的原点在框中央");
});

test("坐标：绘制层与舞台层的同一个点落在同一处", () => {
  // Both halves are computed for the same stage points and must agree. They are
  // written in different conventions — percentages of the frame, and user units
  // inside a view box — so a mismatch is invisible in code and obvious on
  // screen.
  const points = [
    [0, 0],
    [960, 0],
    [-960, 0],
    [0, 540],
    [0, -540],
    [480, -270],
    [-240, 135],
  ];
  for (const [x, y] of points) {
    const percent = stageToPercent(x, y);
    const box = stageToViewBox(x, y);
    assert.ok(
      Math.abs(percent.left / 100 - box.left) < 1e-9,
      `x=${x} 的水平位置不一致：${percent.left / 100} vs ${box.left}`,
    );
    assert.ok(
      Math.abs(percent.top / 100 - box.top) < 1e-9,
      `y=${y} 的垂直位置不一致：${percent.top / 100} vs ${box.top}`,
    );
  }
});

test("坐标：舞台中心在两个系统里都落在正中间", () => {
  assert.deepEqual(stageToPercent(0, 0), { left: 50, top: 50 });
  assert.deepEqual(stageToViewBox(0, 0), { left: 0.5, top: 0.5 });
});

// --- 对象状态关键帧：八向手柄与旋转手柄 ---

/** A plain object state, so the handle tests can be read without a DOM. */
function objectState(overrides = {}) {
  return {
    x: 0,
    y: 0,
    rotation: 0,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    alpha: 1,
    ...overrides,
  };
}

/** A drawing-plane point back to stage coordinates (y grows up on the stage). */
const toStage = (point) => ({ x: point.x, y: -point.y });

test("八向手柄：八个方向齐全，旋转手柄在轮廓之外", () => {
  assert.equal(Object.keys(HANDLE_DIRECTIONS).length, 8);
  const { handles, rotate } = handlePositions(200, 100);
  assert.equal(handles.length, 8);
  assert.deepEqual(
    handles.find((h) => h.name === "upleft"),
    { name: "upleft", x: -100, y: -50 },
  );
  assert.deepEqual(
    handles.find((h) => h.name === "right"),
    { name: "right", x: 100, y: 0 },
  );
  assert.ok(rotate.y < -50, "旋转手柄在上边之外，可命中也才不会压住手柄");
});

test("八向手柄：对象转过角度后，本地坐标进出仍然可逆", () => {
  const centre = { x: 120, y: -60 };
  const local = { x: 55, y: -23 };
  const back = intoBox(outOfBox(local, centre, 37), centre, 37);
  assert.ok(Math.abs(back.x - local.x) < 1e-9, `x 回不去：${back.x}`);
  assert.ok(Math.abs(back.y - local.y) < 1e-9, `y 回不去：${back.y}`);
});

test("对象命中：旋转手柄、八向手柄、本体、空白各有归属", () => {
  const box = { width: 200, height: 100 };
  const live = objectState();
  const { handles, rotate } = handlePositions(200, 100);
  assert.deepEqual(hitObject(toStage(rotate), live, box), { kind: "rotate" });
  assert.deepEqual(
    hitObject(toStage(handles.find((h) => h.name === "downright")), live, box),
    { kind: "handle", name: "downright" },
  );
  assert.deepEqual(hitObject({ x: 0, y: 0 }, live, box), { kind: "move" });
  assert.equal(hitObject({ x: 600, y: 600 }, live, box), null);
});

test("八向手柄：四角等比缩放，对角那个点一动不动", () => {
  const box = { width: 200, height: 100 };
  const start = objectState();
  // Grabbing downright (100, 50) and pulling it to (200, 100) makes the box
  // 1.5 times as big: the far corner is the anchor, not the centre.
  const next = resizeFromHandle(start, box, "downright", { x: 200, y: -100 });
  assert.ok(Math.abs(next.scale - 1.5) < 1e-9, `等比缩放应为 1.5，实际 ${next.scale}`);
  assert.equal(next.scaleX, 1, "四角只动等比 scale，不变形");
  assert.equal(next.scaleY, 1);
  const anchor = outOfBox({ x: -100, y: -50 }, { x: 0, y: 0 }, 0);
  const after = outOfBox(
    { x: (-200 * next.scale) / 2, y: (-100 * next.scale) / 2 },
    { x: next.x, y: -next.y },
    next.rotation,
  );
  assert.ok(Math.abs(after.x - anchor.x) < 1e-9, "左上角 x 应该钉在原处");
  assert.ok(Math.abs(after.y - anchor.y) < 1e-9, "左上角 y 应该钉在原处");
});

test("八向手柄：四边单轴拉伸就是变形，另一轴与等比缩放都不动", () => {
  const box = { width: 200, height: 100 };
  const start = objectState();
  const wider = resizeFromHandle(start, box, "right", { x: 200, y: 0 });
  assert.ok(Math.abs(wider.scaleX - 1.5) < 1e-9, `横向拉到 1.5，实际 ${wider.scaleX}`);
  assert.equal(wider.scaleY, 1, "纵向一点没变");
  assert.equal(wider.scale, 1, "等比缩放也未修改");
  const taller = resizeFromHandle(start, box, "up", { x: 0, y: 100 });
  assert.ok(Math.abs(taller.scaleY - 1.5) < 1e-9, `纵向拉到 1.5，实际 ${taller.scaleY}`);
  assert.equal(taller.scaleX, 1);
});

test("旋转手柄：正上方是 0 度，右侧是 90 度", () => {
  const start = objectState();
  assert.ok(Math.abs(rotateFromHandle(start, { x: 0, y: 100 }).rotation - 0) < 1e-9);
  assert.ok(Math.abs(rotateFromHandle(start, { x: 100, y: 0 }).rotation - 90) < 1e-9);
});

// --- 对象状态关键帧：数据层 ---

test("关键帧序列：整份文件读成对象状态快照，再写回去一模一样", () => {
  const path = normalizePath({
    id: "rt",
    start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1 },
    segments: [
      {
        type: "line",
        points: [[0, 0], [100, 50]],
        time: 1000,
        end: { rotation: 90, scale: 2, alpha: 0.5, scaleX: 1.5, scaleY: 0.8 },
      },
    ],
  });
  const frames = keyframesOf(path);
  assert.equal(frames.length, 2, "起点 + 一段 = 两帧");
  assert.deepEqual(
    { x: frames[0].x, y: frames[0].y, rotation: frames[0].rotation },
    { x: 0, y: 0, rotation: 0 },
  );
  assert.equal(frames[1].x, 100);
  assert.equal(frames[1].scaleX, 1.5, "宽高独立的变形也是帧状态的一部分");

  const file = buildPathFile(pathFromKeyframes(path.id, path.name, frames));
  assert.equal(file.version, 2, "仍然写运行时认识的格式");
  assert.deepEqual(file.start, {
    x: 0, y: 0, rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1,
  });
  assert.deepEqual(file.segments[0].end, {
    rotation: 90, scale: 2, alpha: 0.5, scaleX: 1.5, scaleY: 0.8,
  });
  assert.deepEqual(file.segments[0].points, [[0, 0], [100, 50]]);
});

test("连接：0 个弯曲点是直线，1/2 个是曲线且往返不丢形状", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };
  const cases = [
    [],
    [{ x: 50, y: 20 }],
    [{ x: 30, y: 15 }, { x: 70, y: -10 }],
  ];
  for (const bends of cases) {
    const segment = segmentFromLink(from, to, { time: 1000, bends });
    assert.equal(segment.type, bends.length ? "curve" : "line");
    assert.equal(segment.points.length, bends.length ? bends.length * 2 + 1 : 2);
    const link = linkFromSegment(segment);
    assert.equal(link.bends.length, bends.length, "弯曲点个数往返一致");
    link.bends.forEach((bend, index) => {
      assert.ok(Math.abs(bend.x - bends[index].x) < 1e-9, `第 ${index} 个弯曲点 x 偏了`);
      assert.ok(Math.abs(bend.y - bends[index].y) < 1e-9, `第 ${index} 个弯曲点 y 偏了`);
    });
  }
});

test("双轴变形：帧间线性插值，旧文件三个属性的形状完全不变", () => {
  const path = normalizePath({
    id: "sz",
    start: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    segments: [
      { type: "line", points: [[0, 0], [10, 0]], time: 1000, end: { scaleX: 2, scaleY: 0.5 } },
    ],
  });
  assert.deepEqual(animatedSizes(path), { scaleX: true, scaleY: true });
  assert.ok(Math.abs(frameAt(path, 500).scaleX - 1.5) < 1e-9);
  assert.ok(Math.abs(frameAt(path, 500).scaleY - 0.75) < 1e-9);

  const old = normalizePath({
    id: "legacy",
    start: { x: 0, y: 0 },
    segments: [{ type: "line", points: [[0, 0], [10, 0]], time: 1000 }],
  });
  assert.deepEqual(animatedSizes(old), { scaleX: false, scaleY: false });
  assert.deepEqual(frameAt(old, 500), { rotation: null, scale: null, alpha: null });
});

// --- 关键帧面板 ---

test("关键帧面板：缩放与旋转不再是数字输入框，改由手柄操作", () => {
  const source = readFileSync(new URL("../path-editor.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /frameField\(\s*["']缩放/);
  assert.doesNotMatch(source, /frameField\(\s*["']旋转/);
  assert.match(source, /frameField\(\s*["']透明度/, "透明度没有手柄，仍保留输入框");
  assert.match(source, /handlePositions\(width, height\)/, "八向手柄由几何生成");
  assert.match(source, /kind: "rotate"/, "轮廓外有旋转手柄");
  assert.match(source, /commitFrame\(\)/, "双击对象才建立关键帧");
});

test("曲线：增删弯曲点，减到 0 个自然变回直线", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    const editor = createPathEditor({ mount });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 1000 }],
    });
    editor.selectFrame(1);
    assert.equal(editor.value().segments[0].type, "line", "两帧之间先是直线");

    editor.addPoint({ x: 50, y: 0 });
    assert.equal(editor.value().segments[0].type, "curve");
    assert.equal(editor.value().segments[0].points.length, 3, "一个弯曲点 = 一个 cubic");
    assert.equal(editor.keyframes()[1].link.bends.length, 1);

    editor.addPoint({ x: 70, y: 0 });
    assert.equal(editor.value().segments[0].points.length, 5, "两个弯曲点 = 两个 cubic");
    editor.removePoint();
    assert.equal(editor.keyframes()[1].link.bends.length, 1);

    editor.straighten();
    assert.equal(editor.value().segments[0].type, "line", "0 个弯曲点就是直线");
    assert.equal(editor.value().segments[0].points.length, 2);
  });
});

test("关键帧：拖动后的完整对象状态写进新帧", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    const editor = createPathEditor({ mount });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 1000 }],
    });
    editor.setLiveState({ x: 200, y: 100, rotation: 45, scaleX: 1.8, scaleY: 0.7, alpha: 0.4 });
    assert.equal(editor.commitFrame(), true);
    const file = editor.value();
    assert.equal(file.segments.length, 2, "新帧插入后两段连接");
    assert.equal(file.segments[0].type, "line", "自动生成的连接是直线");
    assert.equal(file.segments[0].end.rotation, 45);
    assert.equal(file.segments[0].end.scaleX, 1.8);
    assert.equal(file.segments[0].end.scaleY, 0.7);
    assert.equal(file.segments[0].end.alpha, 0.4);
  });
});

test("坐标：y 向上，在两个系统里都表现为位置上移", () => {
  // A point above the centre has a smaller `top` in both.
  assert.ok(stageToPercent(0, 270).top < 50);
  assert.ok(stageToViewBox(0, 270).top < 0.5);
});

// --- 曲线两侧对称拖动 ---

test("对称：镜像点在中点的正对面", () => {
  assert.deepEqual(mirrorPoint({ x: 10, y: 20 }, { x: 0, y: 0 }), { x: -10, y: -20 });
  assert.deepEqual(mirrorPoint({ x: 50, y: 200 }, { x: 50, y: 0 }), { x: 50, y: -200 });
});

test("对称：默认拖动仍然只动被抓的那一侧", () => {
  const curve = { type: "curve", points: [[0, 0], [50, 40], [100, 0]] };
  applyControlDrag(curve, { run: 0, side: 0 }, { x: 50, y: 200 });
  assert.deepEqual(curve.control[0][0], [50, 200]);
  assert.deepEqual(curve.control[0][1], [50, 40]);
});

test("对称：symmetric 模式让另一侧跟着镜像", () => {
  const first = { type: "curve", points: [[0, 0], [50, 40], [100, 0]] };
  applyControlDrag(first, { run: 0, side: 0 }, { x: 50, y: 200 }, { symmetric: true });
  assert.deepEqual(first.control[0][0], [50, 200]);
  assert.deepEqual(first.control[0][1], [50, -200], "弦中点 (50,0) 的另一面");

  const second = { type: "curve", points: [[0, 0], [50, 40], [100, 0]] };
  applyControlDrag(second, { run: 0, side: 1 }, { x: 20, y: -30 }, { symmetric: true });
  assert.deepEqual(second.control[0][1], [20, -30]);
  assert.deepEqual(second.control[0][0], [80, 30]);
});

test("对称：两个弯曲点拖一个带动另一个，输入不被改动", () => {
  const bends = [
    { x: 20, y: 0 },
    { x: 80, y: 0 },
  ];
  const centre = { x: 50, y: 0 };
  assert.deepEqual(mirrorBends(bends, 0, { x: 10, y: 60 }, centre), [
    { x: 10, y: 60 },
    { x: 90, y: -60 },
  ]);
  assert.deepEqual(bends, [{ x: 20, y: 0 }, { x: 80, y: 0 }], "传入的数组不变");
});

test("对称：单个弯曲点自己动，三个的中间点没有搭档", () => {
  const centre = { x: 50, y: 0 };
  assert.deepEqual(mirrorBends([{ x: 20, y: 0 }], 0, { x: 10, y: 60 }, centre), [
    { x: 10, y: 60 },
  ]);
  assert.deepEqual(
    mirrorBends([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], 1, { x: 9, y: 9 }, centre),
    [{ x: 1, y: 1 }, { x: 9, y: 9 }, { x: 3, y: 3 }],
  );
  assert.deepEqual(mirrorBends([], 0, { x: 9, y: 9 }, centre), []);
});

// --- 预览播放起点对位 ---

test("预览播放：与运行时一样按对象当前位置整体平移", () => {
  const path = {
    start: { x: 10, y: 20 },
    segments: [{ type: "line", points: [[10, 20], [110, 20]], time: 1000 }],
  };
  const plain = pointAt(path, 0);
  assert.deepEqual({ x: plain.x, y: plain.y }, { x: 10, y: 20 }, "原来的绝对起点");

  const start = shiftedPointAt(path, 0, { x: 300, y: -80 });
  assert.deepEqual({ x: start.x, y: start.y }, { x: 300, y: -80 }, "从对象真实位置起走");
  const middle = shiftedPointAt(path, 500, { x: 300, y: -80 });
  assert.deepEqual({ x: middle.x, y: middle.y }, { x: 350, y: -80 }, "途中保持同一个位移");
  assert.equal(middle.done, false);
});

test("预览播放：没有对象框时退回文件的绝对坐标", () => {
  const path = {
    start: { x: 10, y: 20 },
    segments: [{ type: "line", points: [[10, 20], [110, 20]], time: 1000 }],
  };
  assert.deepEqual(shiftedPointAt(path, 0, null), { x: 10, y: 20, done: false });
  assert.deepEqual(shiftedPointAt(path, 1000, null), { x: 110, y: 20, done: true });
});

test("重命名：编辑器保存时使用的是文件的新 id / 名字", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    const editor = createPathEditor({ mount });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 1000 }],
    });
    assert.equal(editor.value().id, "ch");
    editor.rehome("hero", "主角走位");
    assert.equal(editor.value().id, "hero", "下一次保存不会把旧 id 写回新文件");
    assert.equal(editor.value().name, "主角走位");
    editor.rehome("ch", "ch");
    assert.equal(editor.value().id, "ch", "撤销能把旧 id 放回来");
  });
});

// --- 真的按下并拖动：接线层而不只是纯函数 ---

/** Builds an editor with two bends, and answers its canvas and play button. */
function editorWithBends() {
  const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
  const editor = createPathEditor({ mount });
  editor.load("ch", {
    id: "ch",
    start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1 },
    segments: [
      {
        type: "line",
        points: [[0, 0], [400, 0]],
        time: 1000,
        end: { rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1 },
      },
    ],
  });
  editor.selectFrame(1);
  editor.addPoint({ x: 100, y: 0 });
  editor.addPoint({ x: 300, y: 0 });

  const toolbar = editor.node.childNodes[0];
  const preview = editor.node.childNodes[1];
  const frame = preview.childNodes[0];
  const canvas = frame.childNodes[1];
  // 1920×1080 at (0,0): a client point (x+960, 540-y) is stage point (x, y).
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 1920, height: 1080, right: 1920, bottom: 1080,
  });
  const play = toolbar.childNodes.find((child) => String(child.title ?? "").includes("试走"));
  return { editor, canvas, play };
}

const pointerAt = (x, y, extra = {}) => ({
  clientX: x + 960,
  clientY: 540 - y,
  ...extra,
});

/** Pointer coordinates come back through two floating-point conversions. */
const near = (point, x, y, tolerance = 1e-6, label = "") => {
  assert.ok(Math.abs(point.x - x) <= tolerance, `${label} x：${point.x} ≈ ${x}`);
  assert.ok(Math.abs(point.y - y) <= tolerance, `${label} y：${point.y} ≈ ${y}`);
};

test("接线：不按 Shift 时拖动只动被抓的那一个弯曲点", () => {
  withFakeDom(() => {
    const { editor, canvas } = editorWithBends();
    const start = editor.keyframes()[1].link.bends;
    near(start[0], 100, 0);
    near(start[1], 300, 0);

    canvas.dispatch("pointerdown", pointerAt(100, 0));
    canvas.dispatch("pointermove", pointerAt(100, 120));
    canvas.dispatch("pointerup", pointerAt(100, 120));

    const bends = editor.keyframes()[1].link.bends;
    near(bends[0], 100, 120, 1e-6, "抓住的点跟手");
    near(bends[1], 300, 0, 1e-6, "另一侧没动");
  });
});

test("接线：按住 Shift 拖动，另一侧关于连线中点镜像", () => {
  withFakeDom(() => {
    const { editor, canvas } = editorWithBends();
    canvas.dispatch("pointerdown", pointerAt(100, 0, { shiftKey: true }));
    canvas.dispatch("pointermove", pointerAt(100, 120));
    canvas.dispatch("pointerup", pointerAt(100, 120));

    const bends = editor.keyframes()[1].link.bends;
    near(bends[0], 100, 120, 1e-6);
    // 弦中点 (200, 0)：(100,120) 的对面是 (300,-120)。
    near(bends[1], 300, -120, 1e-6, "另一侧被带动");
  });
});

test("轮廓：位图解码后 refresh() 用真实尺寸重画，而不是整个编辑区", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    // `objectBox` answers the whole frame until the bitmap is decoded, then the
    // picture's own rectangle. The editor has to follow that change.
    let width = 1920;
    const editor = createPathEditor({
      mount,
      objectBox: () => ({ x: 0, y: 0, width, height: 1080 }),
    });
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0 },
      segments: [{ type: "line", points: [[0, 0], [100, 0]], time: 1000 }],
    }, "ch");
    const outlineWidth = () => {
      const preview = editor.node.childNodes[1];
      const frame = preview.childNodes[0];
      const canvas = frame.childNodes[1];
      const svg = canvas.childNodes[0];
      const group = svg.childNodes.find((child) => child.class === "path-editor__object");
      return Number(group?.childNodes?.[0]?.width);
    };
    assert.equal(outlineWidth(), 1920, "刚打开时使用的是 frame 尺寸");
    width = 800;
    editor.refresh();
    assert.equal(outlineWidth(), 800, "通知之后轮廓收缩到图片自己的矩形");
  });
});

test("接线：预览播放从第一帧位置起（path.start），而不是对象当前位置", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    let objectX = 300;
    let objectY = -80;
    const applied = [];
    const stage = {
      applyPreviewState: (name, state) => applied.push({ name, x: state.x, y: state.y }),
      objectBox: () => ({ x: objectX, y: objectY, width: 100, height: 100 }),
      clear() {},
    };
    const editor = createPathEditor({
      mount,
      buildStage: () => stage,
      objectBox: () => ({ x: objectX, y: objectY, width: 100, height: 100 }),
    });
    // ensureStage before load: the preview stage has to exist for the real
    // object to be driven at all.
    editor.ensureStage();
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0 },
      segments: [{ type: "line", points: [[300, -80], [600, -80]], time: 1000 }],
    }, "ch");
    // 文件把起点画在 (300,-80)；脚本后来把对象挪到了 (500,200)。
    objectX = 500;
    objectY = 200;
    const before = applied.length;
    const toolbar = editor.node.childNodes[0];
    const play = toolbar.childNodes.find((child) => String(child.title ?? "").includes("试走"));
    assert.ok(play, "工具栏上找得到预览播放按钮");

    // In node there is no requestAnimationFrame, so step() falls back to
    // setTimeout. Stubbing it out keeps the walk to exactly one frame.
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 0;
    try {
      play.dispatch("click");
    } finally {
      globalThis.setTimeout = realTimeout;
    }

    assert.ok(applied.length > before, "预览播放更新预览舞台上的对象");
    const first = applied[before];
    // 预览播放从当前关键帧组的第一帧位置开始（path.start），与对象当前被挪到哪无关——
    // 这正是「整组从头播放」的定义。文件里第一帧画在 (300,-80)，所以起点就是它，
    // 即使对象此刻在 (500,200)。计时器已走过零点几毫秒，第一帧会偏一点点，5 单位
    // 容差仍能把 (300,-80) 与 (500,200) 区分开。
    near(first, 300, -80, 5, "第一帧落在路径起点（第一帧位置），与对象当前位置无关");
  });
});

test("预览播放：编辑框随图像一起走，而不是停在选中帧", () => {
  withFakeDom(() => {
    const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
    const stage = {
      applyPreviewState: () => {},
      objectBox: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      clear() {},
    };
    const editor = createPathEditor({
      mount,
      buildStage: () => stage,
      objectBox: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    });
    editor.ensureStage();
    editor.load("ch", {
      id: "ch",
      start: { x: 0, y: 0 },
      segments: [{ type: "line", points: [[0, 0], [0, -300]], time: 1000 }],
    }, "ch");
    // Select the second frame, so `live` sits 300 below the path's start.
    editor.selectFrame(1);

    const preview = editor.node.childNodes[1];
    const frame = preview.childNodes[0];
    const canvas = frame.childNodes[1];
    const svg = canvas.childNodes[0];
    const rectY = () => {
      const group = svg.childNodes.find((child) => child.class === "path-editor__object");
      return Number(group?.childNodes?.[0]?.y);
    };
    // Without a walk the box centres on the selected frame: cy = 300, height 100.
    editor.refresh();
    const liveY = rectY();

    const toolbar = editor.node.childNodes[0];
    const play = toolbar.childNodes.find((child) => String(child.title ?? "").includes("试走"));
    assert.ok(play, "工具栏上找得到预览播放按钮");
    // In node there is no requestAnimationFrame, so step() falls back to
    // setTimeout. Stubbing it keeps the walk to exactly one frame at the start.
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 0;
    try {
      play.dispatch("click");
    } finally {
      globalThis.setTimeout = realTimeout;
    }
    // During the walk the box rides the path's start (y = 0 -> cy = 0), not `live`.
    const walkY = rectY();
    assert.ok(Math.abs(walkY - liveY) > 10, `试走时编辑框应随图像移动：选中帧 ${liveY} 试走 ${walkY}`);
    assert.ok(Math.abs(walkY - (-50)) < 1, `试走起点框应落在路径起点 (cy≈0, 高100 -> y≈-50)，实际 ${walkY}`);
  });

  test("预览播放：无论选中哪一帧，都从第一帧位置开始（不跟着选中帧跑）", () => {
    withFakeDom(() => {
      const mount = { children: [], append(...nodes) { mount.children.push(...nodes); } };
      // No `objectBox` callback, so the editor falls back to
      // `previewStage.objectBox(objectName)` — which `syncPreview` keeps pinned to
      // the selected frame. The earlier bug lived exactly here: 预览播放 read that
      // pose as its origin and started from the selected frame instead of the
      // group's first frame.
      const stage = {
        applied: null,
        applyPreviewState: (_name, pose) => { stage.applied = { x: pose.x, y: pose.y }; },
        // No objectBox callback, so the editor falls back to
        // `previewStage.objectBox(objectName)` — which `syncPreview` keeps pinned
        // to the selected frame. That was the old bug's source. The first
        // `syncPreview` (at load) runs before the object is pushed, so a non-null
        // fallback is needed to bootstrap the push; it equals frame 0 so rebaseTo
        // shifts nothing and path.start stays the first frame's position.
        objectBox: () => stage.applied ?? { x: 100, y: 100, width: 100, height: 100 },
        clear() {},
      };
      const editor = createPathEditor({ mount, buildStage: () => stage });
      editor.ensureStage();
      editor.load("ch", {
        id: "ch",
        start: { x: 100, y: 100 },
        segments: [{ type: "line", points: [[100, 100], [100, -200]], time: 1000 }],
      }, "ch");
      // First frame = (100,100), second frame = (100,-200).
      editor.selectFrame(1);

      const preview = editor.node.childNodes[1];
      const frame = preview.childNodes[0];
      const canvas = frame.childNodes[1];
      const svg = canvas.childNodes[0];
      // During the walk the on-canvas outline rides the interpolated pose, so its
      // group centre (cy) equals -pose.y. The first frame sits at (100,100) -> cy
      // -100; the second (selected) frame sits at (100,-200), giving cy 200. Assert
      // the walk starts at the first frame no matter which frame is selected.
      const centerY = () => {
        const group = svg.childNodes.find((c) => c.class === "path-editor__object");
        const rect = group?.childNodes?.[0];
        return Number(rect?.y) + Number(rect?.height) / 2;
      };
      const toolbar = editor.node.childNodes[0];
      const play = toolbar.childNodes.find((c) => String(c.title ?? "").includes("试走"));
      assert.ok(play, "工具栏上找得到预览播放按钮");
      const realTimeout = globalThis.setTimeout;
      globalThis.setTimeout = () => 0;
      try {
        play.dispatch("click");
      } finally {
        globalThis.setTimeout = realTimeout;
      }
      const cy = centerY();
      assert.ok(Math.abs(cy - (-100)) < 1, `试走应从第一帧(100,100)开始：框中心 cy 应为 -100，实际 ${cy}`);
      assert.ok(Math.abs(cy - 200) > 10, `试走不应从选中的第二帧(cy=200)开始，实际 ${cy}`);
    });
  });
});

