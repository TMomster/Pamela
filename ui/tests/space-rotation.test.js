import assert from "node:assert/strict";
import test from "node:test";

import {
  AXIS,
  CAMERA_DISTANCE,
  CORNERS,
  PLANE,
  STAGE_PLANE,
  VIEW_FACE,
  homographyInPixels,
  isFlatPose,
  orientationOf,
  projectPoint,
  projectPose,
  quadHomography,
  quadTriangles,
  turnMatrix,
} from "../space.js";

/** 一个 400×200 的盒子，够看清左右上下四边的差别。 */
const BOX = { w: 400, h: 200 };

/** 四个角里最左 / 最右 / 最上 / 最下的 y，用来判断哪边近哪边远。 */
const heights = (corners) => ({
  left: { top: corners.upleft.y, bottom: corners.downleft.y },
  right: { top: corners.upright.y, bottom: corners.downright.y },
});

const near = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);
};

test("三个轴与三个面各就各位", () => {
  assert.equal(AXIS.x.label, "平轴");
  assert.equal(AXIS.y.label, "升轴");
  assert.equal(AXIS.z.label, "推轴");
  assert.deepEqual(
    [PLANE.H.axes, PLANE.H.normal, PLANE.H.angle],
    ["xz", "y", "rotateH"],
    "H 面是水平面，绕升轴转",
  );
  assert.deepEqual([PLANE.V.axes, PLANE.V.normal, PLANE.V.angle], ["yz", "x", "rotateV"]);
  assert.deepEqual([PLANE.W.axes, PLANE.W.normal, PLANE.W.angle], ["xy", "z", "rotate"]);
  assert.equal(STAGE_PLANE, "W", "舞台就是 W 面");
  assert.equal(VIEW_FACE, "-W", "摄影机拍的是 -W 面");
});

test("三个角都是 0 时，物体的坐标系就是世界的", () => {
  const { matrix, right, up, normal } = orientationOf({});
  assert.deepEqual(matrix, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(right, [1, 0, 0]);
  assert.deepEqual(up, [0, 1, 0]);
  assert.deepEqual(normal, [0, 0, 1]);
  assert.ok(isFlatPose({}), "躺在 W 面里");
});

test("每个转角都只在一个面里划圈", () => {
  // W 面：平轴在 xoy 里走，从 +x 走向 -y —— 画面上是顺时针。
  const w = turnMatrix("W", 90);
  near(w[0], 0, "平轴留在 W 面里");
  near(w[3], -1, "90° 之后平轴指向 -y（画面下方）");
  // H 面：平轴在 xoz 里走，从 +x 走向 +z —— 右侧退到画面深处。
  const h = turnMatrix("H", 90);
  near(h[0], 0, "平轴离开 +x");
  near(h[6], 1, "90° 之后平轴指向 +z（画面深处）");
  // V 面：升轴在 yoz 里走，从 +y 走向 -z —— 顶边朝观众倒。
  const v = turnMatrix("V", 90);
  near(v[4], 0, "升轴离开 +y");
  near(v[7], -1, "90° 之后升轴指向 -z（观众这一侧）");
});

test("每个转角都把自己那个面的法轴留在原地", () => {
  const apply = (matrix, vector) => [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
  ];
  for (const angle of [17, 90, 233, -61]) {
    // W 面绕推轴：推轴不动，平轴留在 xoy 里。
    const w = turnMatrix("W", angle);
    near(apply(w, [0, 0, 1])[2], 1, "推轴不动");
    near(apply(w, [1, 0, 0])[2], 0, "平轴被转出画面深处");
    // H 面绕升轴：升轴不动，平轴留在 xoz 里。
    const h = turnMatrix("H", angle);
    near(apply(h, [0, 1, 0])[1], 1, "升轴不动");
    near(apply(h, [1, 0, 0])[1], 0, "平轴被转出竖直方向");
    // V 面绕平轴：平轴不动，升轴留在 yoz 里。
    const v = turnMatrix("V", angle);
    near(apply(v, [1, 0, 0])[0], 1, "平轴不动");
    near(apply(v, [0, 1, 0])[0], 0, "升轴被转出左右方向");
  }
});

test("rotateV 只在 yOz 里走：摄影机看来永远不会有左右", () => {
  // R = V·H·W，W 最先作用、V 最后作用。绕世界 x 轴的旋转不动 x 分量，
  // 所以哪怕先写 `rotate(90)` 把那张面滚到朝下，再写 `rotateV` 也只能让它
  // 上下／深浅变化，不会被拖到 xOy 平面里横着扫。这是物体的这套乘法；
  // 灯的 `rotate` 不走这里（见 `ui/light.js` 的 `lightOrientation`）。
  for (const tilt of [0, 30, 60, 90, -45, -90]) {
    const radians = tilt * Math.PI / 180;
    const { normal } = orientationOf({ rotate: 90, rotateV: tilt });
    near(normal[0], 0, `rotateV(${tilt}) 没有左右分量`);
    near(normal[1], Math.sin(radians), "上下是倾角的正弦");
    near(normal[2], Math.cos(radians), "深浅是倾角的余弦");
  }

  // 连 H 已经给出左右分量时也一样：那个分量是固定的，V 一点都不加。
  for (const tilt of [0, 25, 70, 90]) {
    const { normal } = orientationOf({ rotate: 90, rotateH: 45, rotateV: tilt });
    near(normal[0], -Math.sin(Math.PI / 4), "左右只由 rotateH 决定");
  }
});

test("rotate 最先作用：它滚的是那张面，不重新瞄准推轴", () => {
  const facing = orientationOf({ rotate: 90 });
  near(facing.normal[0], 0, "推轴还在 +z");
  near(facing.normal[2], 1, "那张面仍正对观众");
  // 但它自己的平轴已经沿橙圈滚到了 -y，也就是画面下方。
  near(facing.right[0], 0);
  near(facing.right[1], -1);

  // W 在最内层，作用于物体自身坐标：推轴 (0,0,1) 经它不变，平轴会变。
  const plain = orientationOf({ rotateH: 60, rotateV: 20 });
  for (const turn of [30, 90, 200, 355]) {
    const turned = orientationOf({ rotateH: 60, rotateV: 20, rotate: turn });
    for (let axis = 0; axis < 3; axis += 1) {
      near(turned.normal[axis], plain.normal[axis], "光束的仰角不受 rotate 影响");
    }
    assert.notDeepEqual(turned.right, plain.right, "灯面在画面里确实滚过");
  }
});

test("躺在 W 面里时，四个角就是转过 rotate、缩过 scale 的那个矩形", () => {
  const pose = { x: 100, y: 50, rotation: 30 };
  const projected = projectPose(pose, BOX);
  assert.ok(projected.flat);
  near(projected.center.x, 100, "中心不偏");
  near(projected.center.y, 50, "中心不偏");

  // 手算：绕中心顺时针转 30°，等于 CSS 的 rotate(30deg)。
  const radians = Math.PI / 6;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  for (const [handle, [lx, ly]] of Object.entries({
    upleft: [-200, 100],
    upright: [200, 100],
    downright: [200, -100],
    downleft: [-200, -100],
  })) {
    near(projected.corners[handle].x, 100 + lx * cos + ly * sin, `${handle} x`);
    near(projected.corners[handle].y, 50 - lx * sin + ly * cos, `${handle} y`);
  }
});

test("rotateH 把物体转向观众的右边，右侧因此退远、左侧因此变大", () => {
  const turned = projectPose({ rotateH: 60 }, BOX);
  assert.equal(turned.flat, false, "转出 W 面就不再是平面旋转了");
  const { left, right } = heights(turned.corners);
  const flat = projectPose({}, BOX);
  assert.ok(
    right.top - right.bottom < left.top - left.bottom,
    "远的那条边被压短，左边比右边高",
  );
  assert.ok(right.top - right.bottom < flat.corners.upright.y - flat.corners.downright.y);
  assert.ok(turned.facing, "60° 还没转到背面");
  assert.equal(projectPose({ rotateH: 120 }, BOX).facing, false, "转过 90° 就是背面");
});

test("rotateV 让物体低头，顶边因此朝观众倒过来", () => {
  const tipped = projectPose({ rotateV: 60 }, BOX);
  const flat = projectPose({}, BOX);
  const tall = (corners) => corners.upleft.y - corners.downleft.y;
  assert.ok(tall(tipped.corners) < tall(flat.corners), "整个盒子被压矮");
  // 顶边的每一个点都在 -z 一侧：投出来比原地更高（更近）。
  assert.ok(tipped.corners.upleft.y > 100 * Math.cos(Math.PI / 3) - 1e-9);
});

test("三个角都为整圈时，又回到躺在 W 面里的样子", () => {
  assert.ok(isFlatPose({ rotateH: 360, rotateV: 720 }));
  assert.ok(isFlatPose({ rotateH: -360 }));
  assert.equal(isFlatPose({ rotateH: 30 }), false);
});

test("深度是一台相机：z = 0 是原样，远的更小更靠中心", () => {
  near(projectPoint({ x: 300, y: 40, z: 0 }).x, 300, "z = 0 不动");
  const far = projectPoint({ x: 300, y: 40, z: CAMERA_DISTANCE });
  near(far.x, 150, "退到一倍焦距处正好减半");
  near(far.y, 20, "y 同比收缩");
  const nearBy = projectPoint({ x: 300, y: 40, z: -1000 });
  assert.ok(nearBy.x > 300, "朝观众挪过来会放大");
});

test("四点投影把源四边形精确地送到目标四边形", () => {
  const source = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  const target = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 150, y: 200 },
    { x: 50, y: 200 },
  ];
  const matrix = quadHomography(source, target);
  const apply = (point) => {
    const w = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
    return {
      x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / w,
      y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / w,
    };
  };
  source.forEach((point, index) => {
    near(apply(point).x, target[index].x, `第 ${index} 个角的 x`);
    near(apply(point).y, target[index].y, `第 ${index} 个角的 y`);
  });
});

test("退化成一个点的四边形不画出任何东西", () => {
  const line = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  assert.equal(quadHomography(line, line), null);
  assert.deepEqual(quadTriangles(line, line), []);
});

test("元素自己的像素与逻辑像素之间那一步换算不会改掉形状", () => {
  const matrix = [2, 0.5, 6, -0.25, 3, -8, 0.001, 0.002, 1];
  const scaled = homographyInPixels(matrix, 2);
  const apply = (m, point) => {
    const w = m[6] * point.x + m[7] * point.y + m[8];
    return {
      x: (m[0] * point.x + m[1] * point.y + m[2]) / w,
      y: (m[3] * point.x + m[4] * point.y + m[5]) / w,
    };
  };
  // 输入乘 2（元素像素是逻辑像素的两倍），输出也是 2 倍：同一个形状。
  for (const point of [{ x: 3, y: -7 }, { x: -120, y: 45 }]) {
    const logical = apply(matrix, point);
    const pixels = apply(scaled, { x: point.x * 2, y: point.y * 2 });
    near(pixels.x, logical.x * 2, "x 同比");
    near(pixels.y, logical.y * 2, "y 同比");
  }
});

test("两片三角形盖住同一个四边形", () => {
  const source = [
    { x: -50, y: -50 },
    { x: 50, y: -50 },
    { x: 50, y: 50 },
    { x: -50, y: 50 },
  ];
  const target = [
    { x: 0, y: 0 },
    { x: 100, y: 10 },
    { x: 90, y: 120 },
    { x: 10, y: 100 },
  ];
  const pieces = quadTriangles(source, target);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].target.length, 3);
  assert.equal(CORNERS.length, 4, "角的顺序是共用契约");
  // 每片自己把源三角形的重心送到目标三角形的重心上。
  for (const piece of pieces) {
    const centre = (points) => ({
      x: (points[0].x + points[1].x + points[2].x) / 3,
      y: (points[0].y + points[1].y + points[2].y) / 3,
    });
    const from = centre(piece.source);
    const to = centre(piece.target);
    near(piece.a * from.x + piece.c * from.y + piece.e, to.x, "重心 x");
    near(piece.b * from.x + piece.d * from.y + piece.f, to.y, "重心 y");
  }
});
