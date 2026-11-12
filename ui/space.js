// 三维空间的公共约定 —— 三个轴、三个面与一台相机，都只在这里定义一次。
// Pamela — the one place the frame of reference is defined.
//
// 轴：x 平轴（向右）、y 升轴（向上）、z 推轴（朝画面深处为正）。
//
// 内部一律用 HVD 称呼这三根轴，而不是纠结 x / y / z 哪个字母是哪根：
//
//   H = Horizontal axis 平轴，向右为正
//   V = Vertical axis   升轴（垂轴），向上为正
//   D = Depth axis      推轴（深轴），朝画面深处为正
//
// 脚本里的 `move(h, v, d, time)` 就是这三个分量；`x` / `y` / `z` 是它们的
// 旧拼写，`h` / `v` / `z` 是新拼写，两套同时可用，落到对象上的字段只有一套
// `x / y / z`。
//
// 透视（`stage.perspective(true)`）默认关闭：正交空间里 z 只决定前后，不决定
// 大小，同一个 z 方向上的物体在画面里完全重叠。打开以后相机才有灭点，z 越大
// 的对象越远、越小。默认关闭是刻意的：没写过 z 的剧本一个像素都不会动。
//
// 面：过原点、两两垂直的三个平面，每个平面上画着一个圈：
//
//   H 面 = 水平面（xoz）　蓝圈　绕升轴转 —— `rotateH`
//   V 面 = 正立面（yoz）　绿圈　绕平轴转 —— `rotateV`
//   W 面 = 侧立面（xoy）　橙圈　绕推轴转 —— `rotate`
//
// 舞台就是 W 面：z = 0 的那张纸。相机在 z = -CAMERA_DISTANCE 那一侧，沿 +z
// 看过来，拍到的是 -W 面 —— 也就是观众看到的画面。所以 z 越大越靠画面深处，
// z 越小越朝观众。
//
// 三个转角合起来是物体在空间里的朝向。每个角都绕**固定的世界轴**转，让物体
// 在对应的那个圈上走；按 W → H → V 依次作用，矩阵就是
//
//     R = V(rotateV) · H(rotateH) · W(rotate)
//
// 右边的先算：先在 W 面（画面）的橙圈里滚，再在 H 面（水平面）的蓝圈里转开，
// 最后在 V 面（正立面）的绿圈里抬落。三者在 0 度时都等于「物体自身的坐标系
// 与世界的重合」。于是 `rotateH = 0` 时平轴指着 +x，`rotateV = 0` 时升轴指着
// +y，`rotate = 0` 时推轴指着 +z ——三个都为 0 就是贴图正对观众、平铺在 W
// 面上，也就是最平常的一张立绘。
//
// 正方向各取观众看着最自然的那一边：`rotate` 与 CSS 的 `rotate()` 同向
// （画面上顺时针），`rotateH` 把物体转向观众的右边，`rotateV` 让它低头。
//
// 灯不是立绘：手电筒的 0 度是筒口朝 +x，所以 `ui/light.js` 把它的 `rotateH`
// 换算成 `90 - 角` 再调 `orientationOf`（正数因此在 H 面上俯视顺时针，90 度
// 正对镜头）。轴、面、相机与转动矩阵本身仍是这里这一套，没有第二套空间。
//
// 灯只有 `rotateH` / `rotateV` 走这道乘积：它的 `rotate` 是**画面里**的转动
// （绕世界推轴），在 `ui/light.js` 里于 H / V 摆好之后再作用一次。对一盏灯来说
// 这跟立绘不是同一个动作 —— 它的推轴（筒口）零度时正指着 +x，绕它滚只是筒身
// 自转，光束一动不动，作者写下的 `rotate(90)` 会像没生效。
//
// 为什么 V 排在最后：绕世界 x 轴的旋转不动 x 分量，所以从相机看过去
// `rotateV` 只在 yOz 里走，永远不会有左右。W 最先作用，因此它转的是物体那张
// **面在画面里的朝向**，而不是把已经摆好的光束重新扫到别的平面上去。
//
// 透视只有一个焦距：相机在 z = -CAMERA_DISTANCE，投到 z = 0 的平面上，
// 于是 z 处的点按 `CAMERA_DISTANCE / (CAMERA_DISTANCE + z)` 缩小并向中心收敛。
// z = 0 时比例正好是 1，所以没写过 z 的剧本一个像素都不会动。
//
// 舞台（DOM）与导出（Canvas2D）都从这里取同一套数，两个后端的近大远小与
// 三维朝向才不会分叉。

/** 相机到舞台平面的距离，单位是逻辑像素。越大越接近正交投影。 */
export const CAMERA_DISTANCE = 2000;

/** z 能取到的范围：再靠前会把比例推到无穷，再靠后就没有画面了。 */
export const DEPTH_LIMIT = Object.freeze({ near: -1500, far: 8000 });

/**
 * 三个轴。
 *
 * `index` 是它在坐标三元组里的位置，`label` 是脚本文档里的叫法：平、升、推，
 * `name` 是内部统一的 HVD 英文名（Horizontal / Vertical / Depth axis）。
 */
export const AXIS = Object.freeze({
  x: Object.freeze({ key: "x", label: "平轴", name: "Horizontal axis", index: 0 }),
  y: Object.freeze({ key: "y", label: "升轴", name: "Vertical axis", index: 1 }),
  z: Object.freeze({ key: "z", label: "推轴", name: "Depth axis", index: 2 }),
});

/**
 * 三个面，以及每个面「装」的那个转角。
 *
 * `axes` 是张成这个面的两根轴，`normal` 是它的法轴 —— 转动就是绕法轴转、
 * 让点在面里的那个圈上走。`angle` 是脚本里写这个转角的方法名。
 */
export const PLANE = Object.freeze({
  H: Object.freeze({ key: "H", label: "水平面", axes: "xz", normal: "y", angle: "rotateH" }),
  V: Object.freeze({ key: "V", label: "正立面", axes: "yz", normal: "x", angle: "rotateV" }),
  W: Object.freeze({ key: "W", label: "侧立面", axes: "xy", normal: "z", angle: "rotate" }),
});

/** 舞台所在的那个面。 */
export const STAGE_PLANE = "W";

/** 观众看到的那一面：相机从 -z 一侧拍到的 -W 面。 */
export const VIEW_FACE = "-W";

const RAD = Math.PI / 180;

/**
 * 一个 z 的透视比例，1 是舞台平面。
 *
 * `perspective` 为假时按正交投影算：深度不再改变大小，比例恒为 1。舞台默认
 * 就是这种空间（`stage.perspective(true)` 才打开灭点），所以「同一个 z 方向
 * 上的所有物体都是重叠的」——只有 z 决定谁盖住谁，不决定谁更大。
 *
 * @param {number} z 深度。
 * @param {boolean} [perspective] 是否按透视投影；省略按透视算（几何函数本身
 *   的语义），舞台与导出都会把自己的开关显式传进来。
 */
export function depthScale(z, perspective = true) {
  if (!perspective) {
    return 1;
  }
  const depth = clampDepth(z);
  return CAMERA_DISTANCE / (CAMERA_DISTANCE + depth);
}

/** 把 z 收进可取的范围；写错的数字当作 0（舞台平面）。 */
export function clampDepth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(DEPTH_LIMIT.far, Math.max(DEPTH_LIMIT.near, number));
}

/**
 * 同一层里从前到后的顺序：z 大的先画（在后面），z 小的后画（在前面）。
 *
 * 舞台用 DOM 顺序表达它，导出按同一个比较器排序，两边的前后关系一致。
 * 同一个 z 保持原来的先后，所以没写过 z 的剧本顺序不变。
 */
export function byDepth(a, b) {
  return (Number(b?.z) || 0) - (Number(a?.z) || 0);
}

/**
 * 场景对象能用的 z-index 上限。
 *
 * 视频、粒子、文字、灯、对话框、选项这些覆盖层从 1000 起，所以背景与角色
 * 排序后写出的序号落在 0–999：既能把角色放到背景后面，也不会盖住界面。
 */
export const ORDER_CEILING = 999;

/** 场景对象的兜底层序：z 相同时，背景最下、角色在上，文字留到二期。 */
export const SCENE_RANK = Object.freeze({ background: 0, character: 1, text: 2 });

/**
 * 背景的默认深度。
 *
 * Pamela 里 z 越大越远，所以背景取 +1：比角色（默认 0）远一层，一创建就垫在
 * 角色后面，不会被角色盖住。舞台与导出后端共用这一个数。
 */
export const BACKGROUND_DEPTH = 1;

/**
 * 整幅画面的前后顺序：背景与角色放进同一套比较，供舞台与导出共用。
 *
 * 依次比较三件事，任何一步分出胜负就停下：
 *
 * 1. `z` 大的在前（更远、先画、序号小）；`byDepth` 是同一个比较器。
 * 2. `z` 相同按 `kind` 的兜底层序：背景在角色之下。
 * 3. 同 `z` 同层保持传入顺序，也就是舞台的入场序与 `front()` / `back()`。
 *
 * 返回的是传进来的那些对象本身（按绘制顺序：远的在前）。舞台把它写成
 * `z-index`，导出用它决定 `drawImage` 的先后，两边不会分叉。
 *
 * @param {Array<{ z?: number, kind?: string }>} entries
 * @returns {Array<{ z?: number, kind?: string }>}
 */
export function sceneOrder(entries) {
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const depth = byDepth(left.entry, right.entry);
      if (depth !== 0) {
        return depth;
      }
      const rank = (SCENE_RANK[left.entry.kind] ?? SCENE_RANK.character)
        - (SCENE_RANK[right.entry.kind] ?? SCENE_RANK.character);
      if (rank !== 0) {
        return rank;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

// --- 朝向 ------------------------------------------------------------------
//
// 一个物体的朝向就是一个 3×3 的旋转矩阵，行主序存在 9 个数字里。下面三个
// 函数各自给出某一个面里的转动；`orientationOf` 把三个乘起来。

/**
 * 一个面里的转动矩阵（行主序 3×3）。
 *
 * 三个都是绕**世界轴**转，转动的点沿法轴对应的那个圈走：
 *
 * - `W` 绕推轴转，平轴在 W 面（画面）里从 +x 走向 -y，也就是顺时针 ——
 *   与 CSS 的 `rotate()` 完全同向；
 * - `H` 绕升轴转，平轴在 H 面里从 +x 走向 +z，物体转向观众的右边，它的
 *   左侧因此朝观众转过来，画面左右方向被透视压短；
 * - `V` 绕平轴转，升轴在 V 面里从 +y 走向 -z，物体低头，顶边朝观众倒过来，
 *   画面上下方向被压短。
 *
 * 对着一盏灯来说，前两个就是光束往右边摆、往下压；`W` 在这里是绕物体自己的
 * 推轴滚，改的是那张面在画面里的朝向。灯不从这里拿 `rotate`：它的推轴就是
 * 筒口，绕它滚不会改光束，所以 `ui/light.js` 改用绕世界推轴的那次转动。
 *
 * @param {"H" | "V" | "W"} plane
 * @param {number} degrees
 * @returns {number[]} 9 个数，行主序。
 */
export function turnMatrix(plane, degrees) {
  const radians = (Number(degrees) || 0) * RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  if (plane === "H") {
    return [cos, 0, -sin, 0, 1, 0, sin, 0, cos];
  }
  if (plane === "V") {
    return [1, 0, 0, 0, cos, sin, 0, -sin, cos];
  }
  return [cos, sin, 0, -sin, cos, 0, 0, 0, 1];
}

/** 两个 3×3（行主序）相乘。 */
function multiply(left, right) {
  const out = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 3 + column] =
        left[row * 3] * right[column]
        + left[row * 3 + 1] * right[3 + column]
        + left[row * 3 + 2] * right[6 + column];
    }
  }
  return out;
}

/** 一个姿态里的三个角，缺的当 0；`rotation` 是 `rotate` 的旧拼写。 */
function anglesOf(pose = {}) {
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    turn: number(pose.rotate ?? pose.rotation),
    h: number(pose.rotateH),
    v: number(pose.rotateV),
  };
}

/**
 * 一个姿态在空间里的朝向。
 *
 * 返回的 `matrix` 作用于物体自身的坐标（平轴 x、升轴 y、推轴 z），得到世界
 * 坐标里的同一个方向；`right` / `up` / `normal` 是它的三根轴在世界里的样子。
 * `normal` 是这张纸的背面朝向：它指着 +z（远离观众）时，观众看到的是正面。
 *
 * @param {{ rotate?: number, rotation?: number, rotateH?: number, rotateV?: number }} pose
 * @returns {{ matrix: number[], right: number[], up: number[], normal: number[] }}
 */
export function orientationOf(pose = {}) {
  const angles = anglesOf(pose);
  // 三个角都是绕**固定世界轴**转的，按 W → H → V 的顺序作用，所以矩阵乘成
  // R = V · H · W（右边的最先作用）：
  //
  //   先在 W 面（画面）的橙圈里滚一下，再在 H 面（水平面）的蓝圈里转开，
  //   最后在 V 面（正立面）的绿圈里抬落。
  //
  // V 排在最外层是关键：绕世界 x 轴的旋转**不改变 x 分量**，于是 `rotateV`
  // 在摄影机看来永远只有上下与深浅，不可能平白出现左右。把 W 放到最外层会
  // 把 V 的竖直倾斜一起转到 xOy 里去，正是那张截图里的毛病。
  //
  // 代价（也是几何事实）：W 最先作用，物体自己的推轴 +z 经它不变，所以
  // `rotate` 不会重新瞄准光束 —— 它转的是灯面在画面里的方向（锥口、灯管），
  // 光束的仰角只由 H / V 决定。
  const matrix = multiply(
    multiply(turnMatrix("V", angles.v), turnMatrix("H", angles.h)),
    turnMatrix("W", angles.turn),
  );
  return {
    matrix,
    right: [matrix[0], matrix[3], matrix[6]],
    up: [matrix[1], matrix[4], matrix[7]],
    normal: [matrix[2], matrix[5], matrix[8]],
  };
}

/**
 * 这个姿态是不是躺在 W 面里（只绕推轴转过）。
 *
 * 是的话朝向就是一个平面上的旋转，可以走「纯 2D 变换」的快路径：舞台写
 * `rotate()` + `scale()`，导出一次 `drawImage`。没写过 `rotateH` / `rotateV`
 * 的剧本因此一点都不比以前贵。
 */
export function isFlatPose(pose = {}) {
  const angles = anglesOf(pose);
  return Math.abs(Math.sin(angles.h * RAD)) < 1e-9 && Math.abs(Math.sin(angles.v * RAD)) < 1e-9;
}

// --- 投影 ------------------------------------------------------------------

/**
 * 世界里的一个点投到 W 面上。
 *
 * 从相机 (0, 0, -CAMERA_DISTANCE) 沿 +z 打出的一条射线，穿过这一点之后落在
 * z = 0 处的那个位置。返回的是舞台坐标（原点在中心、y 向上）与那次投影的
 * 比例 —— 舞台上写 `left/top` 与导出的 `ctx.translate` 都用它。
 *
 * `perspective` 为假时是正交投影：位置原样搬过去，比例 1，深度只决定前后。
 *
 * @param {{ x?: number, y?: number, z?: number }} point
 * @param {{ perspective?: boolean }} [options]
 * @returns {{ x: number, y: number, scale: number }}
 */
export function projectPoint(point = {}, { perspective = true } = {}) {
  const x = Number(point.x) || 0;
  const y = Number(point.y) || 0;
  if (!perspective) {
    return { x, y, scale: 1 };
  }
  const depth = clampDepth(point.z);
  const scale = CAMERA_DISTANCE / Math.max(1, CAMERA_DISTANCE + depth);
  return { x: x * scale, y: y * scale, scale };
}

/** 一个盒子四个角在自身坐标里的位置（y 在上），按顺时针排。 */
const CORNER_AXES = Object.freeze({
  upleft: Object.freeze([-1, 1]),
  upright: Object.freeze([1, 1]),
  downright: Object.freeze([1, -1]),
  downleft: Object.freeze([-1, -1]),
});

/** 四个角的名字，顺时针。舞台、导出与灯光剪影都按这个顺序走。 */
export const CORNERS = Object.freeze(Object.keys(CORNER_AXES));

/** 两个三角形覆盖同一个四边形，绘制时按这个顺序拆。 */
export const QUAD_TRIANGLES = Object.freeze([
  Object.freeze(["upleft", "upright", "downright"]),
  Object.freeze(["upleft", "downright", "downleft"]),
]);

/**
 * 一个物体投到舞台上之后的四个角、中心与朝向。
 *
 * 盒子取自姿态本身（位置、深度、缩放、两个轴向拉伸），朝向取自三个转角，
 * 取景则走 `projectPoint` 那一套透视。所以：
 *
 * - 三个角都是 0 时，四个角就是一个转过 `rotate`、缩过 `scale` 的矩形，
 *   `flat` 为真 —— 舞台与导出的老快路径正对着它；
 * - 写了 `rotateH` / `rotateV` 之后，四个角近大远小、朝向真实的缩短，
 *   背面时 `facing` 为假。
 *
 * @param {object} pose 位置（x/y/z）、转角（rotate/rotateH/rotateV）、scale/scaleX/scaleY
 * @param {{ w?: number, h?: number, scale?: number, scaleX?: number, scaleY?: number }} box
 *   物体自身盒子的尺寸（逻辑像素），`scale` 缺省从 `pose` 里取。
 * @param {{ perspective?: boolean }} [options] `perspective` 为假时按正交投影算：
 *   四角与中心都只是搬过来，深度不再让近的大、远的小。
 * @returns {{ flat: boolean, center: {x: number, y: number}, corners: Record<string, {x: number, y: number}>,
 *   depth: number, orientation: object, facing: boolean }}
 */
export function projectPose(pose = {}, box = {}, { perspective = true } = {}) {
  const depth = clampDepth(pose.z);
  const x = Number(pose.x) || 0;
  const y = Number(pose.y) || 0;
  const scale = Number(box.scale ?? pose.scale ?? 1) || 1;
  const scaleX = Number(box.scaleX ?? pose.scaleX ?? 1) || 1;
  const scaleY = Number(box.scaleY ?? pose.scaleY ?? 1) || 1;
  const halfW = ((Number(box.w) || 0) * scale * scaleX) / 2;
  const halfH = ((Number(box.h) || 0) * scale * scaleY) / 2;
  const orientation = orientationOf(pose);
  const { matrix } = orientation;
  const corners = {};
  for (const [handle, [ax, ay]] of Object.entries(CORNER_AXES)) {
    const lx = ax * halfW;
    const ly = ay * halfH;
    // 物体自身坐标 → 世界坐标：R·(lx, ly, 0) + (x, y, depth)。
    const wx = matrix[0] * lx + matrix[1] * ly + x;
    const wy = matrix[3] * lx + matrix[4] * ly + y;
    const wz = matrix[6] * lx + matrix[7] * ly + depth;
    // 正交空间里每个角都不按深度缩放：转过身的物体仍会被压短，但不会朝
    // 灭点收过去。
    const flat = perspective
      ? CAMERA_DISTANCE / Math.max(1, CAMERA_DISTANCE + wz)
      : 1;
    corners[handle] = { x: wx * flat, y: wy * flat };
  }
  return {
    flat: isFlatPose(pose),
    center: projectPoint({ x, y, z: depth }, { perspective }),
    corners,
    depth,
    orientation,
    // 法轴指着 +z（背对观众）时，观众看到的是这张纸的正面；转过 90° 之后
    // 法轴掉到 -z 一侧，我们看到的就是镜像过去的背面。
    facing: orientation.normal[2] > 0,
  };
}

// --- 四点投影 ---------------------------------------------------------------
//
// 一个平面矩形经过透视之后还是一个四边形，但从矩形到四边形的那次映射不再是
// 仿射的 —— CSS 的 `matrix()` 与 Canvas2D 的 `transform()` 都只能表达仿射。
// 舞台用 `matrix3d` 把这次投影整个塞进去（浏览器会自己做透视除法），导出则
// 按 `QUAD_TRIANGLES` 拆成两片仿射，逐片裁剪着画。

/**
 * 四点之间的一次投影变换（单应），行主序 3×3。
 *
 * 输入与输出都按 (0,0)、(1,0)、(1,1)、(0,1) 的顺序给四个点；矩阵把源四边形
 * 投到目标四边形上。退化（三点共线、面积为 0）时返回 `null`。
 *
 * @param {Array<{x: number, y: number}>} source
 * @param {Array<{x: number, y: number}>} target
 * @returns {number[] | null} 9 个数 h00…h22：`[x', y', w'] = H·[x, y, 1]`。
 */
export function quadHomography(source, target) {
  const toUnit = unitSquareFrom(source);
  const fromUnit = unitSquareTo(target);
  if (!toUnit || !fromUnit) {
    return null;
  }
  // 先把源四边形拉成单位正方形，再从单位正方形铺到目标四边形。
  const product = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      product[row * 3 + column] =
        fromUnit[row * 3] * toUnit[column]
        + fromUnit[row * 3 + 1] * toUnit[3 + column]
        + fromUnit[row * 3 + 2] * toUnit[6 + column];
    }
  }
  return product;
}

/** 单位正方形 → 一个四边形。 */
function unitSquareTo(points) {
  const [p0, p1, p2, p3] = points;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (dx3 === 0 && dy3 === 0) {
    // 平行四边形：仿射就够了，第三行是 (0, 0, 1)。
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  }
  if (!Number.isFinite(det) || det === 0) {
    return null;
  }
  const a13 = (dx3 * dy2 - dx2 * dy3) / det;
  const a23 = (dx1 * dy3 - dx3 * dy1) / det;
  return [
    p1.x - p0.x + a13 * p1.x,
    p3.x - p0.x + a23 * p3.x,
    p0.x,
    p1.y - p0.y + a13 * p1.y,
    p3.y - p0.y + a23 * p3.y,
    p0.y,
    a13,
    a23,
    1,
  ];
}

/** 一个四边形 → 单位正方形，就是 `unitSquareTo` 的逆（伴随矩阵）。 */
function unitSquareFrom(points) {
  const forward = unitSquareTo(points);
  if (!forward) {
    return null;
  }
  const [a, b, c, d, e, f, g, h, i] = forward;
  const adjugate = [
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d,
  ];
  const scale = adjugate[8];
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) {
    return null;
  }
  return adjugate.map((value) => value / scale);
}

/**
 * 把一个以逻辑像素表达的投影换成以元素自身像素表达。
 *
 * 舞台里的元素是按百分比摆放的，它自己的一个像素等于 `units` 个逻辑像素；
 * 而 `matrix3d` 作用在元素自己的像素上。投影矩阵在输入与其「齐次输出」都乘
 * 同一个倍率时不变，所以只需把两边各自换算一次。
 *
 * @param {number[]} matrix 行主序 3×3，输入输出都是逻辑像素。
 * @param {number} units 每个逻辑像素对应多少个元素像素。
 * @returns {number[]}
 */
export function homographyInPixels(matrix, units) {
  const ratio = Number(units) > 0 ? Number(units) : 1;
  const out = [...matrix];
  // 两边各换算一次：输入被放大 `ratio` 倍，齐次输出也跟着放大 `ratio` 倍，
  // 除法之后落的还是同一个位置。
  out[2] *= ratio;
  out[5] *= ratio;
  out[6] /= ratio;
  out[7] /= ratio;
  return out;
}

/**
 * 一个四边形拆成的两片三角形，每片配一个仿射。
 *
 * 导出（Canvas2D）与灯光剪影都靠它把一张图铺到透视后的四边形上：源矩形按
 * `QUAD_TRIANGLES` 切开，每片算一个仿射，然后裁剪着画。没有面积的那片跳过。
 *
 * @param {Array<{x: number, y: number}>} source 源矩形的四个角，顺序同上
 * @param {Array<{x: number, y: number}>} target 它们要去的四个位置
 * @returns {Array<{ source: Array<{x:number,y:number}>, target: Array<{x:number,y:number}>,
 *   a: number, b: number, c: number, d: number, e: number, f: number }>}
 */
export function quadTriangles(source, target) {
  const pieces = [];
  for (const triangle of QUAD_TRIANGLES) {
    const from = triangle.map((handle) => source[CORNERS.indexOf(handle)] ?? null);
    const to = triangle.map((handle) => target[CORNERS.indexOf(handle)] ?? null);
    if (from.some((point) => !point) || to.some((point) => !point)) {
      continue;
    }
    const at = triangleAffine(from, to);
    if (at) {
      pieces.push({ source: from, target: to, ...at });
    }
  }
  return pieces;
}

/**
 * 三点到三点的仿射矩阵。
 *
 * `matrix(a, b, c, d, e, f)` 读作 x' = ax + cy + e、y' = bx + dy + f，所以
 * `a`、`b` 是源自身 x 轴落到哪里，`c`、`d` 是它的 y 轴。
 */
export function triangleAffine(source, target) {
  const [s1, s2, s3] = source;
  const [t1, t2, t3] = target;
  const u = { x: s2.x - s1.x, y: s2.y - s1.y };
  const v = { x: s3.x - s1.x, y: s3.y - s1.y };
  const U = { x: t2.x - t1.x, y: t2.y - t1.y };
  const V = { x: t3.x - t1.x, y: t3.y - t1.y };
  const det = u.x * v.y - u.y * v.x;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    return null;
  }
  const a = (U.x * v.y - V.x * u.y) / det;
  const c = (u.x * V.x - v.x * U.x) / det;
  const b = (U.y * v.y - V.y * u.y) / det;
  const d = (u.x * V.y - v.x * U.y) / det;
  return {
    a,
    b,
    c,
    d,
    e: t1.x - (a * s1.x + c * s1.y),
    f: t1.y - (b * s1.x + d * s1.y),
  };
}
