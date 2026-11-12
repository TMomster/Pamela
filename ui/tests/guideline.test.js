// 空间参考线：间隔的收口、每个深度截面的几何，以及正交 / 透视下画出来的区别。
// Tests for the spatial reference lines `stage.guideline(true, interval)`.

import assert from "node:assert/strict";
import test from "node:test";

import {
  GUIDELINE_INTERVAL,
  GUIDELINE_MAX_SECTIONS,
  GUIDELINE_MIN_INTERVAL,
  guidelineInterval,
  guidelineLines,
  paintGuideline,
} from "../guideline.js";

/** 舞台平面上的横纵两组线（关掉透视时能看到的全部）。 */
const planeLines = (lines) => lines.filter((line) => line.kind === "plane");
/** 深度截面上的网格：只有透视开着时才有。 */
const depthLines = (lines) => lines.filter((line) => line.kind === "depth");
/** 一幅参考线里有几圈截面（每圈竖线两头到中线的距离就是一个圈的号）。 */
const sectionsOf = (lines) => new Set(
  depthLines(lines)
    .filter((line) => line.from.x === line.to.x)
    .map((line) => Math.abs(line.from.y)),
).size;

/** 只记下画了几条线的假 ctx。 */
function fakeContext() {
  const strokes = [];
  let current = null;
  return {
    strokes,
    save() {},
    restore() {},
    setTransform() {},
    setLineDash() {},
    beginPath() {
      current = null;
    },
    moveTo(x, y) {
      current = { x, y };
    },
    lineTo(x, y) {
      strokes.push({ from: current, to: { x, y } });
    },
    stroke() {},
    clearRect() {},
  };
}

test("the interval defaults to 100 and never goes below 10", () => {
  assert.equal(GUIDELINE_INTERVAL, 100);
  assert.equal(GUIDELINE_MIN_INTERVAL, 10);
  assert.equal(guidelineInterval(), 100);
  assert.equal(guidelineInterval(undefined), 100);
  assert.equal(guidelineInterval(200), 200);
  assert.equal(guidelineInterval("150"), 150);
  assert.equal(guidelineInterval(5), 10, "小于 10 的间隔按 10 算");
  assert.equal(guidelineInterval(-400), 10);
  assert.equal(guidelineInterval(12.6), 13, "间隔是整数：小数四舍五入");
  assert.equal(guidelineInterval(0), 10);
});

test("a non-numeric interval is a script error", () => {
  assert.throws(() => guidelineInterval("nope"), /参考线间隔/);
  assert.throws(() => guidelineInterval(Number.NaN), /参考线间隔/);
});

test("the plane lines cover the frame, and depth sections only appear under perspective", () => {
  const ortho = guidelineLines({ perspective: false });
  const perspective = guidelineLines({ perspective: true });

  // 舞台平面上的横纵线：原点各一条（strong），其余等距铺满整个画幅。
  const plane = planeLines(ortho);
  const vertical = plane.filter((line) => line.from.x === line.to.x);
  const horizontal = plane.filter((line) => line.from.y === line.to.y);
  assert.equal(vertical.length, 19, "960 / 100 的格点：-900…900");
  assert.equal(horizontal.length, 11, "540 / 100 的格点：-500…500");
  assert.equal(plane.filter((line) => line.strong).length, 2, "只有过原点的那两条更亮");
  for (const line of vertical) {
    assert.equal(Math.abs(line.from.y - line.to.y), 1080, "竖线贯穿整个画幅");
  }

  // 正交空间里没有截面：深度不改变画面上的位置，每一圈都与舞台平面重合。
  assert.equal(depthLines(ortho).length, 0, "没有透视时只有横纵两组线");
  assert.equal(planeLines(perspective).length, plane.length, "开关透视不改变舞台平面的那组");

  // 每个截面都是同一圈横纵线，按该深度缩小：19 竖、11 横，各去掉与中轴重合的
  // 那一条（中轴舞台平面已经画了）。
  const depth = depthLines(perspective);
  const columns = depth.filter((line) => line.from.x === line.to.x);
  const rows = depth.filter((line) => line.from.y === line.to.y);
  assert.equal(columns.length, GUIDELINE_MAX_SECTIONS * 18, "每圈 18 竖");
  assert.equal(rows.length, GUIDELINE_MAX_SECTIONS * 10, "每圈 10 横");

  // 回归：一旦把线铺在 H 面（v = 0）或 V 面（h = 0）上，它们就整条压进中轴，
  // 看上去仍是平面网格 —— 截面里不该再出现躺在中轴上的线。
  for (const line of depth) {
    assert.ok(!(line.from.y === 0 && line.to.y === 0), "没有一条躺在水平中轴上");
    assert.ok(!(line.from.x === 0 && line.to.x === 0), "没有一条躺在竖直中轴上");
  }

  // 一圈套一圈：每圈的竖线两头关于中线对称、越远的一圈越矮，两圈之间越挤 ——
  // 这就是「远近」在画面上的读法。
  const halfHeights = [...new Set(columns.map((line) => Math.abs(line.from.y)))]
    .sort((left, right) => right - left);
  assert.equal(halfHeights.length, GUIDELINE_MAX_SECTIONS, "20 圈截面");
  assert.ok(halfHeights[0] < 540, "最靠前的一圈也已经比舞台平面小");
  for (const line of columns) {
    assert.equal(line.from.y, -line.to.y, "竖线两头关于中线对称");
  }
  for (let index = 1; index < halfHeights.length; index += 1) {
    assert.ok(halfHeights[index] < halfHeights[index - 1], "越远的一圈越小");
  }
  const gaps = halfHeights.slice(1).map((value, index) => halfHeights[index] - value);
  for (let index = 1; index < gaps.length; index += 1) {
    assert.ok(gaps[index] < gaps[index - 1], "越远两圈之间越挤");
  }
});

test("a finer interval draws more lines, and none of them overlap", () => {
  const coarse = planeLines(guidelineLines({ interval: 200 }));
  const fine = planeLines(guidelineLines({ interval: 100 }));
  assert.ok(fine.length > coarse.length);
  const xs = new Set(
    fine
      .filter((line) => line.from.x === line.to.x)
      .map((line) => line.from.x),
  );
  assert.equal(xs.size, 19);

  // 截面跟着同一个间隔走：间隔减半，同一圈里的线更密。
  const coarseDepth = depthLines(guidelineLines({ interval: 200, perspective: true }));
  const fineDepth = depthLines(guidelineLines({ interval: 100, perspective: true }));
  assert.ok(fineDepth.length > coarseDepth.length);
});

test("the number of depth sections is capped, however fine the interval", () => {
  const fine = guidelineLines({ interval: GUIDELINE_MIN_INTERVAL, perspective: true });
  assert.equal(sectionsOf(fine), GUIDELINE_MAX_SECTIONS, "截面圈数不随间隔无限增长");
  assert.equal(
    sectionsOf(guidelineLines({ perspective: true })),
    GUIDELINE_MAX_SECTIONS,
    "间隔 100 时一个相机距离正好是这个圈数",
  );
});

test("painting draws the depth sections only when perspective is on", () => {
  const ortho = fakeContext();
  assert.equal(paintGuideline(ortho, { size: { width: 1920, height: 1080 } }), true);
  assert.equal(ortho.strokes.length, 30, "正交空间只看得到横纵两组线");

  const perspective = fakeContext();
  paintGuideline(perspective, {
    size: { width: 1920, height: 1080 },
    perspective: true,
  });
  assert.equal(
    perspective.strokes.length,
    30 + GUIDELINE_MAX_SECTIONS * 28,
    "透视下每一圈截面都画出来",
  );
});

test("a missing 2D context is not an error", () => {
  assert.equal(paintGuideline(null), false);
  assert.equal(paintGuideline({}), false);
});
