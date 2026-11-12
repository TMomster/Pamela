// 光照原语：光源的几何、衰减与灯层合成。
// Pamela — light primitives: a lamp's geometry, falloff, and the layer it paints.
//
// 与 `filters.js` 同层：舞台（DOM）与导出（离屏 Canvas2D）都调用这里，两个后端
// 的观感才不会分叉。坐标系沿用 `stage.js`：1920×1080 逻辑空间、中心为原点、
// y 轴向上；`z` 朝画面深处为正（见 `ui/space.js`）。
// 画布是 y 轴向下的，只有绘制入口做那一次换算，其余计算都在逻辑空间。
//
// 这里做的是 2.5D 近似：没有遮挡、没有法线，一盏灯是「平面上的椭圆光斑 + 锥角
// 衰减 + 轮廓辉光」。`z` 是灯离舞台平面的深度：越远光斑越大、甩得越远，也让
// 它站到角色的背后去——灯在对象后面时，正面照不到，只剩一圈轮廓辉光。
//
// 灯是一支手电筒，不是一张立绘：三个角仍写在 `ui/space.js` 的同一套轴与面上，
// 但零度不同。刚创建时筒口朝 +x（画面里水平朝右，看到的是侧视图）；`rotateH`
// 在 H 面（水平面）上俯视顺时针转，90 度就把筒口转到 -z、正对镜头射过来，
// 这时镜头看到的是锥体的圆形横截面，而不是一片扇形。`rotateV` 绕世界平轴抬落。
//
// `rotate` 是**画面里的转动**：绕世界的推轴（那条视线）转，画面顺时针为正，
// 与立绘的 `rotate` 同一个方向。朝右的灯 `rotate(90)` 就变成朝下照，180 朝左。
// 它必须作用在 H / V 摆好之后 —— 灯的零度比立绘多转了 90 度，若把它当成灯自己
// 推轴上的滚动，滚的其实是筒身（世界里就是平轴，也就是 V 面），光束一动不动，
// 那正是「设了 rotate 却看不出变化」的来源。
//
// 光锥在画面上的轮廓按视角算：贴着画面擦过去是楔形，转向镜头时张成半平面，
// 正对镜头收成一个圆（见 `beamFrame` 的 `fan` / `shrink`）。

import { clampDepth, orientationOf, quadTriangles } from "./space.js";

/** 灯的默认值。`range` 为负表示无限远；画面上仍要有个有限的半径。 */
export const LIGHT_DEFAULTS = Object.freeze({
  color: "FFFFFF",
  intensity: 1,
  opacity: 1,
  spread: 360,
  range: -1,
  bloom: 0,
  soft: 0,
  x: 0,
  y: 0,
  z: 0,
  /** H 面（水平面）方位角：0 时光束朝 +x，俯视顺时针 90 度正对镜头。 */
  rotateH: 0,
  /** V 面（正立面）抬落角：0 是水平，正数低头（光束往 -y 压）。 */
  rotateV: 0,
  /** 画面里的转动：正数为画面上顺时针，90 度让朝右的光束转为朝下。 */
  rotate: 0,
  /**
   * 灯管的长度：0 是点光源，正数让灯本身变成一段有长度的发光体。
   *
   * 它描述的是**光源**：光从这段灯管上的每一点发出来，所以管身附近是灯的
   * 实际长度，远处按锥角张开——不是把光斑平移成一条等宽的带子。
   */
  width: 0,
});

/** 场地上一盏灯在无限远时的绘制半径，单位是逻辑像素。 */
export const LIGHT_FAR_REACH = 1400;

/** 同时参与合成的灯的上限；再多一张全屏 canvas 就只是在烧时间。 */
export const LIGHT_LIMIT = 8;

/** 一圈锥角边缘的柔化宽度，占整个锥角的比例。 */
const CONE_EDGE = 0.18;

/**
 * 受光对象自身亮度的增益。
 *
 * 灯层对画面是 `screen`，所以往灯层里加「对象的像素 × 光色 × 权重」时，观感就是
 * 对象被照亮的比例。0.7 是一盏摆正的光把对象抬到大约七成自身亮度：再高会烧白，
 * 再低就还是「蒙了一层色」。
 */
const LIT_GAIN = 0.7;

const RAD = Math.PI / 180;

/**
 * 灯比对象深多少，正面就完全照不到了。
 *
 * 0 是同深度（灯就贴在对象所在的平面上，正面照度按光斑算满）；再往里
 * 700 像素就是彻底逆光：只剩轮廓辉光。中间是渐变的，所以把灯从角色前面
 * 慢慢推到后面，正面会一路暗下去，不会「啪」地跳变。
 */
export const LIGHT_BACK_FADE = 700;

function clamp(value, low, high) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return low;
  }
  return Math.min(high, Math.max(low, number));
}

/** 一圈角度收进 0–360。 */
export function wrapAngle(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return ((number % 360) + 360) % 360;
}

/**
 * Reads a light's colour as `{ r, g, b }`.
 *
 * The stage validates the text a script wrote (see `parseHex`); this is the
 * forgiving read for everything else — a colour that cannot be read is white
 * rather than an exception, because a light is not worth failing a frame over.
 */
export function lightColor(value) {
  if (value && typeof value === "object") {
    return {
      r: clamp(value.r, 0, 255),
      g: clamp(value.g, 0, 255),
      b: clamp(value.b, 0, 255),
    };
  }
  const raw = String(value ?? "").trim().replace(/^#/, "");
  const full = /^[0-9a-fA-F]{3}$/.test(raw)
    ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2]
    : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return { r: 255, g: 255, b: 255 };
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** A fresh light: every property at its default. */
export function neutralLight() {
  return { ...LIGHT_DEFAULTS };
}

/**
 * Fills in and clamps a light's properties.
 *
 * Out-of-range numbers are clamped rather than refused, the way a filter's are:
 * `spread` past 360 is a whole circle, not an error. The three angles are not
 * wrapped: a timed turn has to be able to count through 360 without jumping
 * back, exactly like a picture's `rotate`.
 */
export function normalizeLight(source) {
  const input = source && typeof source === "object" ? source : {};
  const pick = (name) => (input[name] === undefined ? LIGHT_DEFAULTS[name] : input[name]);
  return {
    color: typeof pick("color") === "string" ? pick("color") : LIGHT_DEFAULTS.color,
    intensity: clamp(pick("intensity"), 0, 8),
    opacity: clamp(pick("opacity"), 0, 1),
    spread: clamp(pick("spread"), 1, 360),
    range: Number(pick("range")) < 0 ? -1 : clamp(pick("range"), 0, 20000),
    bloom: clamp(pick("bloom"), 0, 1),
    soft: clamp(pick("soft"), 0, 1),
    x: Number.isFinite(Number(pick("x"))) ? Number(pick("x")) : 0,
    y: Number.isFinite(Number(pick("y"))) ? Number(pick("y")) : 0,
    z: clampDepth(pick("z")),
    rotateH: Number.isFinite(Number(pick("rotateH"))) ? Number(pick("rotateH")) : 0,
    rotateV: Number.isFinite(Number(pick("rotateV"))) ? Number(pick("rotateV")) : 0,
    rotate: Number.isFinite(Number(pick("rotate"))) ? Number(pick("rotate")) : 0,
    width: clamp(pick("width"), 0, 4000),
  };
}

/**
 * 灯面喂给 `orientationOf` 的姿态：只有 H 面与 V 面的两个角。
 *
 * 立绘在 0 度时贴在 W 面上正对观众，手电筒在 0 度时筒口朝 +x —— 相当于已经
 * 沿 H 面转过了 +90 度。把 `rotateH` 换成 `90 - rotateH`，既挪了零度，也让
 * 正数成为「在 H 面上俯视顺时针」：+x → -z → -x，90 度正对镜头。
 *
 * `rotate` 不在这里，见 `lightOrientation`：它绕的是世界的推轴，而不是灯自己的。
 */
function lampPose(light) {
  return {
    rotateH: 90 - (Number(light?.rotateH) || 0),
    rotateV: light?.rotateV,
  };
}

/**
 * 画面里的一次转动：绕世界的推轴（+z，朝画面深处），与 `space.js` 的 W 面
 * 同向，也就与 CSS 的 `rotate()` 同向 —— 正数在画面上顺时针。
 */
function turnInPage(vector, degrees) {
  const radians = (Number(degrees) || 0) * RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    cos * vector[0] + sin * vector[1],
    -sin * vector[0] + cos * vector[1],
    vector[2],
  ];
}

/**
 * 一盏灯此刻的三根轴，世界坐标：先在 H / V 面上摆好方位与抬落，再整盏灯在
 * 画面里转到 `rotate`。
 *
 * 顺序就是「先摆进空间，再在画面上转」，所以在作者眼里 `rotate` 就是画面里的
 * 那个旋转：朝右的光 `rotate(90)` 朝下、`rotate(180)` 朝左，灯管与光束一起转。
 * 反过来（把 `rotate` 交给 `orientationOf` 当 W 面用）转的是灯自己的推轴，
 * 而这盏灯的推轴在零度时正指着 +x，滚起来只是筒身自转 —— 光束一动不动。
 *
 * 舞台的坐标轴覆盖层（`ui/axes.js`）也读它，`crood(true)` 画出来的推轴才会
 * 与画面上那束光同向。
 *
 * @param {object} light A light from {@link normalizeLight}.
 * @returns {{ right: number[], up: number[], normal: number[] }}
 */
export function lightOrientation(light) {
  const { right, up, normal } = orientationOf(lampPose(light));
  const turn = Number(light?.rotate) || 0;
  if (!turn) {
    return { right, up, normal };
  }
  return {
    right: turnInPage(right, turn),
    up: turnInPage(up, turn),
    normal: turnInPage(normal, turn),
  };
}

/**
 * 一盏灯的光束，以及这束光投到画面上的轮廓。
 *
 * 光束就是灯面推轴反着走的那条线，再经 `rotate` 在画面里转过：`rotateH = 0`、
 * `rotate = 0` 时是 (1, 0, 0)（画面右），`rotateH = 90` 时是 (0, 0, -1)（正对
 * 镜头射过来），而朝右的光 `rotate(90)` 就成了 (0, -1, 0)（朝下）。光束与 W 面的夹角越小，
 * 它要走越远才落到平面（`travel`），光斑也被拉得越长（`incidence` 越小则
 * `rx` 越大）。
 *
 * 返回的 `hx` / `hy` 是光束压在平面上的单位方向 —— 光斑往哪边甩、椭圆往哪
 * 边长，都看它；`heading` 是同一个方向的「从 +x 起顺时针」角，画布是 y 向下
 * 的，绘制时直接 `rotate(heading)` 就对齐了。斜着打的光用它真实的投影；正对
 * 镜头的光投影退化成一个点，就改用灯面的平轴（也就是灯管打滚到的那一边）。
 *
 * 除了方向，这里还算光锥的**视轮廓**：`fan` 是投影后的 2D 锥角，`shrink` 是
 * 正对镜头时锥底圆盘相对整片光斑的缩放。设锥体半张角 θ、光束与「朝观众」
 * 方向的夹角 φ：
 *
 *   - φ > θ：锥体斜着摆，投影是从灯心切出去的楔形，半张角 α 满足
 *     sin α = sin θ / sin φ（φ = 90° 时 α 正好是 θ，即原来的 2D 扇形）；
 *   - φ = θ：一条母线正好平行于视线，楔形张成半平面，α = 90°；
 *   - φ < θ：锥底把灯心包住，看到的是整个圆截面，fan 从 180° 涨到 360°。
 *
 * 手电筒正对镜头时，锥底半径是 `range · tan θ`，窄光束因此是一个小圆而不是
 * 铺满画面；`shrink` 把光斑的两个半径一起按这个比例收回去，侧视时保持 1。
 * 第三个数 `cut` 说的是扇形外面那一块到底该切多干净：镜头在锥外时是 1，进入
 * 锥里之后一路降到 0 —— 那时没有「锥外」，缺口只是灯自己挡住的背面。
 * 第四个数 `penumbra` 是扇形边缘往两侧各柔化多少度：只有 `fan` 正好等于
 * `spread`（侧视）时那条边才是真的锥边，扇形被投影撑得越开，它越是渐变，
 * 光晕里才不会留下一条从灯心射出去的折痕。
 */
function beamFrame(light) {
  const { normal, right } = lightOrientation(light);
  // 推轴指着 +z（贴图正对观众）时，光往 -z 打。
  const beam = { x: -normal[0], y: -normal[1], z: -normal[2] };
  const spread = light?.spread === undefined ? 360 : clamp(light.spread, 1, 360);
  const depth = Number(light?.z) || 0;
  const flatPart = Math.hypot(beam.x, beam.y);
  let hx = 1;
  let hy = 0;
  if (flatPart > 1e-9) {
    hx = beam.x / flatPart;
    hy = beam.y / flatPart;
  } else {
    // 光束正对镜头时压到 W 面上只剩一个点，本来就没有「往哪边甩」。但锥口、
    // 椭圆长轴、受光区都要有一个 0 度方向；它来自灯面自己滚到哪，也就是
    // 灯面的平轴。`rotate = 0` 是 +x，`rotate = 90` 是画面下方。
    const own = Math.hypot(right[0], right[1]);
    if (own > 1e-9) {
      hx = right[0] / own;
      hy = right[1] / own;
    }
  }
  // 光束与 W 面夹角的正弦：正对镜头时是 1，贴着平面擦过去时趋近 0。下限是
  // 为了让「躺平」的灯仍然画得出一个有限的椭圆，而不是一条无穷长的带。
  // 全向光（360°）没有光束方向，不该因为方位把光斑拉成长条：始终按正圆算。
  const incidence = spread >= 360 ? 1 : Math.max(0.05, Math.abs(beam.z));
  // 从灯所在深度走到舞台平面（z = 0）要走多远。打不到平面（光束朝画面深处
  // 去，或者灯本来就在观众这一侧）就不甩，光斑落回灯自己脚下。
  const travel = beam.z < 0 ? Math.max(0, depth / -beam.z) : 0;
  // `range` 是**光在空间里能走多远**，不是画在平面上的一个半径。灯自己离舞台
  // 平面就有 `|depth|` 这么深，这一段先被吃掉：光还能照到的平面区域是半径
  // `range` 的球与 z = 0 平面的交圆，半径 sqrt(range² − depth²)。深度一旦不小
  // 于射程，光在走到镜头这一层之前就已经衰减到零——平面上一点光都没有。
  const limit = Number(light?.range) > 0 ? Number(light.range) : 0;
  const away = Math.abs(depth);
  const reach = limit > 0
    ? (away < limit ? Math.sqrt(limit * limit - away * away) : 0)
    : LIGHT_FAR_REACH;
  // 光是走完 `depth` 才落到舞台平面上的，这一段射程已经花掉了：整片光斑都要
  // 按它再暗一次，否则「灯远到快够不着平面」时中心还是满亮。
  const exhaust = limit > 0 ? falloffAt(clamp(away / limit, 0, 1), false) : 1;

  // 3D 锥体投到画面上该用多大的扇形、多大的圆盘。
  let fan = 360;
  let shrink = 1;
  // 扇形之外那一块切掉多少：1 是整个切干净（镜头在锥外，看到的是真的锥边），
  // 0 是根本不切（镜头已经钻进锥里，那块「背面」在画面上看不见）。
  let cut = 1;
  // 扇形边缘往两侧各柔化多少度。见下面的赋值处。
  let penumbra = 0;
  if (spread < 360) {
    const theta = (spread / 2) * RAD;
    const phi = Math.acos(clamp(-beam.z, -1, 1));
    const front = clamp(1 - phi / theta, 0, 1);
    if (phi > theta) {
      const ratio = Math.sin(theta) / Math.max(1e-6, Math.sin(phi));
      fan = (2 * Math.asin(clamp(ratio, 0, 1))) / RAD;
    } else {
      fan = 180 + 180 * front;
    }
    const aperture = theta >= Math.PI / 2 ? 1 : clamp(Math.tan(theta), 0, 1);
    shrink = 1 - front * (1 - aperture);
    // 锥底越过灯心之后（`front` 从 0 涨到 1，`rotateH` 从擦边走到正对镜头），
    // 扇形里少的那个缺口本来就不是「锥外」了：锥底把灯心包住时，镜头四面都在
    // 锥里，缺口只是灯自己挡住的一小片，根本不该在画面里切出一道从灯心张开的
    // 黑楔子。所以它不再按硬边留着，而是很快就淡掉——否则正对镜头之前
    // （`rotateH` 60…90）光斑就像被啃掉一角的饼。
    cut = clamp(1 - front * 3, 0, 1);
    // 扇形边缘有多软。侧视时扇形正好等于书写的 `spread`，那条边是真正的锥边，
    // 该硬；扇形比 `spread` 宽出来的那一截，全是「斜着看锥体」投影出来的假边，
    // 撑得越开越不该是一条直线——否则光晕里会留一道从灯心射出去的折痕。所以
    // 柔化宽度跟着撑开的幅度一起长，并且不小于锥角自己的那一圈边缘。
    const half = fan / 2;
    const opened = Math.max(0, half - spread / 2);
    const room = Math.max(1, Math.min(half, 180 - half));
    penumbra = Math.min(room, Math.max(half * CONE_EDGE, opened));
  }
  return {
    beam,
    hx,
    hy,
    incidence,
    travel,
    reach,
    exhaust,
    heading: wrapAngle(Math.atan2(-hy, hx) / RAD),
    fan,
    shrink,
    cut,
    penumbra,
  };
}

/**
 * 灯管（`width`）在光斑自己的横截面里躺成什么方向。
 *
 * 灯管沿灯面自己的平轴躺着；它在横截面上指向哪，是「平轴投到 W 面上的方向」
 * 与「光束投到 W 面上的方向」之间的夹角 —— 三维里垂直的两根轴投下来一般并
 * 不垂直，所以这是个算出来的量，不是一个常数。三个转角都参与：`rotate` 让
 * 两者一起在画面里扫，灯管与光束的相对关系不变；`rotateH` / `rotateV` 才会
 * 把这个夹角拉开。
 *
 * 正对镜头的灯（`rotateH = 90`），横截面的 0 度方向就是灯面平轴（见
 * `beamFrame`），于是灯管被 `rotate` 带着走。只有灯管正好指着观众、在 W 面上
 * 连投影都没有时，才退回「横跨锥口」的 `(0, 1)`。
 *
 * @param {object} light A light from {@link normalizeLight}.
 * @param {number} hx 光束在 W 面上的单位方向（横截面的 +x）。
 * @param {number} hy
 * @returns {{ x: number, y: number }} 灯管的单位方向（横截面坐标）。
 */
function barInFrame(light, hx = 1, hy = 0) {
  const { right } = lightOrientation(light);
  const length = Math.hypot(right[0], right[1]);
  if (length < 1e-9) {
    return { x: 0, y: 1 };
  }
  const along = (right[0] * hx + right[1] * hy) / length;
  const across = (-right[0] * hy + right[1] * hx) / length;
  // 灯管是一条线，两个方向说的是同一条：统一取 +y 那一侧，动画里才不会
  // 在正中间翻个面。
  return across >= 0 ? { x: along, y: across } : { x: -along, y: -across };
}

/**
 * Where a light lands on the stage, in canvas pixels.
 *
 * `heading` is where the beam points once it is pressed flat onto the stage: a
 * lamp tilted by `rotateH` / `rotateV` throws its footprint along that heading
 * by how far it has to travel to reach the plane, which is what makes a side
 * light look like it is coming from off the frame.
 *
 * The footprint is an ellipse: `ry` across the beam, `rx` along it. The beam is
 * `range` wide (or the far reach when it is infinite), stretched by how flat it
 * grazes the stage — a lamp at the horizon smears into a long streak rather
 * than becoming a circle. A lamp aimed at the camera is the opposite: its cone
 * is seen end on, so `fan` is a whole circle and `shrink` pulls both radii back
 * to the cone's own aperture (`range · tan(spread / 2)`).
 *
 * @param {object} light A light from {@link normalizeLight}.
 * @param {number} scale Canvas pixels per logical pixel.
 * @param {{ width: number, height: number }} size
 * @returns {{ sx: number, sy: number, rx: number, ry: number, heading: number,
 *   w: number, half: number, scale: number, color: string, bar: {x: number, y: number},
 *   fan: number, shrink: number, cut: number, penumbra: number }}
 */
export function lightGeometry(light, scale = 1, size = { width: 0, height: 0 }) {
  const frame = beamFrame(light);
  const { hx, hy, heading, incidence, travel, reach, exhaust, fan, shrink, cut, penumbra } = frame;
  // `reach` 为 0 就是「光走不到这一层」：两个半径都留 0，`paintFootprint` 会
  // 直接跳过这盏灯，而不是画一个 1 像素的亮点。
  const alive = reach > 0;
  const radius = Math.max(1, reach);
  const ry = alive ? radius * shrink * scale : 0;
  // A beam at the horizon stretches without bound; six times is already a
  // streak across the whole frame, and it keeps every number finite.
  const rx = alive
    ? Math.min(radius * 6, radius / Math.max(0.2, incidence)) * shrink * scale
    : 0;
  // 光斑中心 = 灯的位置 + 光束压在平面上的那一截。正对观众时那一截是 0（不该
  // 因为有 `travel` 就把光斑推到一边去），所以乘的是光束自己而不是它的单位化。
  const { beam } = frame;
  const cx = (Number(light.x) || 0) + beam.x * travel;
  const cy = (Number(light.y) || 0) + beam.y * travel;
  const sx = (size.width || 0) / 2 + cx * scale;
  const sy = (size.height || 0) / 2 - cy * scale;
  // 宽度是逻辑像素，画布上按同一倍率放大；0 表示还是点光源。
  const ratio = Number(scale) > 0 ? Number(scale) : 1;
  const w = clamp(light.width, 0, 4000) * ratio;
  // 灯管长度的一半：绘制与遮罩都以它为「发光体」的半径。
  return {
    sx,
    sy,
    rx,
    ry,
    heading,
    w,
    half: w / 2,
    scale: ratio,
    color: lightColor(light.color),
    bar: barInFrame(light, hx, hy),
    fan,
    shrink,
    cut,
    penumbra,
    // 射程已经花掉的那一截：整片光斑按它整体压暗。
    fade: exhaust,
  };
}

/**
 * How much of a light falls on a point of the stage, 0–1.
 *
 * The distance is measured in the footprint's own ellipse, so a tilted lamp
 * dims faster along its beam than across it. The angle is measured in the
 * world, which is what a writer sees when they drag the arrow. Nothing here
 * knows about other objects: exclusion is the layer's business, not a lamp's.
 *
 * A light with a `width` is a bar, not a wider point: the bar is the emitter,
 * so distance is measured from the nearest point **on the bar** and the cone is
 * opened from that same point. Near the source the light is only as wide as the
 * bar; it spreads with distance from there.
 *
 * @param {object} light A normalized light.
 * @param {number} x Stage x, centre origin, y up.
 * @param {number} y
 * @returns {number}
 */
export function lightWeightAt(light, x, y) {
  if (!light || !(light.opacity > 0) || !(light.intensity > 0)) {
    return 0;
  }
  const { hx, hy, beam, incidence, travel, reach, heading, fan, shrink, cut, penumbra } = beamFrame(light);
  // 射程够不到舞台平面：这一层上没有任何光可谈。
  if (!(reach > 0)) {
    return 0;
  }
  const radius = Math.max(1, reach);
  const ry = radius * shrink;
  const rx = Math.min(radius * 6, radius / Math.max(0.2, incidence)) * shrink;
  // 光斑中心就是光束落到舞台平面上的那一点（`beamFrame` 的 travel）。
  const cx = (Number(light.x) || 0) + beam.x * travel;
  const cy = (Number(light.y) || 0) + beam.y * travel;
  const dx = x - cx;
  const dy = y - cy;
  const along = dx * hx + dy * hy;
  const across = -dx * hy + dy * hx;
  // 条光源：灯管在横截面里摆开，管上每一点都发光。管内的点离最近发光点的
  // 距离是 0，只有超出管长的那一段才计入；锥角也从最近那一点量。
  const barHalf = Math.max(0, Number(light.width) || 0) / 2;
  const bar = barInFrame(light, hx, hy);
  let fromX = cx;
  let fromY = cy;
  let r;
  if (barHalf > 0) {
    const onBar = Math.min(barHalf, Math.max(-barHalf, along * bar.x + across * bar.y));
    // 帧里的偏移 (onBar·bar.x, onBar·bar.y) 换回世界：帧的 x 轴是 (hx, hy)，
    // y 轴是 (-hy, hx)。
    const offsetAlong = onBar * bar.x;
    const offsetAcross = onBar * bar.y;
    fromX = cx + offsetAlong * hx - offsetAcross * hy;
    fromY = cy + offsetAlong * hy + offsetAcross * hx;
    const outAlong = along - offsetAlong;
    const outAcross = across - offsetAcross;
    r = Math.hypot(outAlong / rx, outAcross / ry);
  } else {
    r = Math.hypot(along / rx, across / ry);
  }
  if (!(r < 1)) {
    return 0;
  }
  // 锥角用投影后的视轮廓：正对镜头时 fan 是 360，光斑整个圆都受光。
  const spread = clamp(fan, 1, 360);
  let cone = 1;
  if (spread < 360) {
    const at = Math.atan2(-(y - fromY), x - fromX) / RAD;
    const off = Math.abs(((at - heading + 540) % 360) - 180);
    const halfAngle = spread / 2;
    // 扇形外面不一定全黑：镜头钻进锥里之后那一块淡出去（见 `beamFrame` 的
    // `cut`），所以外面的下限是 `1 - cut`，锥边也从它往 1 渐入。柔化宽度取
    // `penumbra`，它跟着扇形被投影撑开的幅度一起长大——那条边是假边。
    const outside = clamp(1 - (cut ?? 1), 0, 1);
    const fade = Math.max(0.5, Number(penumbra) || 0);
    const ramp = clamp((halfAngle + fade - off) / (2 * fade), 0, 1);
    cone = outside + (1 - outside) * ramp;
  }
  // 写了 `range` 的一盏灯，衰减量的是**光源到这个点的真实距离**：光要走完
  // `depth` 才落到平面上，这一段射程是先花掉的，所以不是「光斑中心就满亮」。
  // 没写 `range` 的灯没有射程可言，仍旧按光斑自己的半径归一化。
  const limit = Number(light.range) > 0 ? Number(light.range) : 0;
  if (limit > 0) {
    const distance = Math.hypot(x - fromX, y - fromY, Math.abs(Number(light.z) || 0));
    if (!(distance < limit)) {
      return 0;
    }
    return cone * falloffAt(distance / limit, false);
  }
  return cone * falloffAt(r, true);
}

/**
 * The share of a light's strength left at `t` of the way to its edge.
 *
 * Every lamp fades with distance; `range` only says where it has faded to
 * nothing. An unwritten `range` is not "the whole frame at full strength" — it
 * is "this lamp has no written limit", so the strength falls away smoothly
 * across the whole drawn radius instead of stopping at a visible circle.
 * Lighting the frame evenly is `stage.ambient`'s job, not a lamp's.
 *
 * @param {number} t 0 at the lamp, 1 at the footprint's edge.
 * @param {boolean} infinite
 * @returns {number}
 */
export function falloffAt(t, infinite) {
  const at = clamp(t, 0, 1);
  if (infinite) {
    return Math.pow(1 - at, 1.5);
  }
  return Math.pow(1 - at, 1.6);
}

/**
 * The strongest weight a light has anywhere on a rectangle's outline.
 *
 * A character's middle can sit outside a narrow beam while its shoulder is in
 * it; sampling the corners is what keeps a rim glow from disappearing on a big
 * picture that is only half lit.
 *
 * @param {object} light
 * @param {{ x: number, y: number, w: number, h: number }} rect Stage coordinates.
 * @returns {number}
 */
export function lightRectWeight(light, rect) {
  const halfW = (rect.w || 0) / 2;
  const halfH = (rect.h || 0) / 2;
  const points = [
    [rect.x, rect.y],
    [rect.x - halfW, rect.y - halfH],
    [rect.x + halfW, rect.y - halfH],
    [rect.x + halfW, rect.y + halfH],
    [rect.x - halfW, rect.y + halfH],
  ];
  let best = 0;
  for (const [x, y] of points) {
    best = Math.max(best, lightWeightAt(light, x, y));
  }
  return best;
}

/**
 * 正面还能被这盏灯照到多少：1 是照满，0 是完全逆光。
 *
 * 灯与对象同深度（或灯更靠观众一侧）时是 1；灯比对象更靠画面深处时一路降到
 * 0，灯就站到了对象背后——正面照不到，只剩轮廓辉光。
 *
 * 这条缓坡管的是**亮度**，不是遮挡：光是穿过还是被挡住，是二选一的事，由
 * `holesOf` 按深度直接挖洞；这里只负责让「灯慢慢退到背后」时正面一路暗下去，
 * 而不是啪地跳一下。
 *
 * @param {object} light A normalized light.
 * @param {number} [z] The object's depth.
 * @returns {number}
 */
export function lightFaceAt(light, z = 0) {
  const behind = (Number(light?.z) || 0) - (Number(z) || 0);
  return clamp(1 - behind / LIGHT_BACK_FADE, 0, 1);
}

/**
 * 逆光时这个对象自身该被压暗多少：1 是原样，0 是全黑。
 *
 * 灯层只能加光（`screen`），所以「背光面是暗部」不能靠加一层什么做到——得把
 * 对象自己的像素压下去。压多少由两件事相乘：
 *
 * - `lightFaceAt` 的反面：灯退到对象背后多深（0 是同深度，1 是彻底逆光）；
 * - 光场在这个对象上的权重：灯根本没扫到它，就不该有影子；
 *
 * 再乘灯的强度与不透明度：一盏 0.2 的补光挡不住多少光，只有满强度的灯才把
 * 正面压到全黑。深度到 `LIGHT_BACK_FADE`（700）时正面本来就照不到，压到 0。
 *
 * @param {object} light A normalized light.
 * @param {{ x: number, y: number, w: number, h: number }} rect 对象在舞台上的矩形。
 * @param {number} [z] The object's depth.
 * @returns {number}
 */
export function lightShadeAt(light, rect, z = 0) {
  if (!light || !(light.opacity > 0) || !(light.intensity > 0)) {
    return 1;
  }
  const back = 1 - lightFaceAt(light, z);
  if (!(back > 0)) {
    return 1;
  }
  // 够不够得到：写了 `range` 的灯，超出射程就是压根没照到这里。
  if (!(lightRectWeight(light, rect) > 0)) {
    return 1;
  }
  // 压多黑看的是「光场盖住它没有」，不是「这盏灯在那一段还剩几成亮」：射程
  // 的衰减会随灯的距离一路掉，拿它当影子，远处的逆光就永远压不黑。所以这一
  // 项去掉 `range` 再量，只留光斑的几何覆盖。
  const coverage = lightRectWeight(
    Number(light.range) > 0 ? { ...light, range: -1 } : light,
    rect,
  );
  if (!(coverage > 0)) {
    return 1;
  }
  const power = clamp(light.intensity, 0, 1) * clamp(light.opacity, 0, 1);
  return clamp(1 - back * coverage * power, 0, 1);
}

/**
 * 多盏灯一起压出来的暗部：每盏灯各自乘一次，所以两盏逆光比一盏更黑。
 *
 * 被这盏灯点名排除的对象不吃它的影子（「这盏灯不照它」在暗部上也成立）。
 *
 * @param {Array<object>} lights Normalized lights, each with an `excluded` set.
 * @param {{ x: number, y: number, w: number, h: number }} rect
 * @param {number} [z]
 * @param {string} [key] The object's key, for exclusion.
 * @returns {number}
 */
export function lightShadeOf(lights, rect, z = 0, key = "") {
  let shade = 1;
  for (const light of lights ?? []) {
    if (key && light?.excluded?.has(key)) {
      continue;
    }
    shade *= lightShadeAt(light, rect, z);
  }
  return shade;
}

/** A stop list that reads as `falloffAt` at four points. */
function falloffStops(infinite) {
  const values = [0, 0.4, 0.72, 0.9, 1];
  return values.map((t) => [t, falloffAt(t, infinite)]);
}

/**
 * 一条从灯管两端张开的扇形：近边就是灯管，两侧按锥角放远。
 *
 * 本地坐标里 +x 沿光束、y 横跨灯管，调用方负责平移与旋转。`bar` 是灯管在
 * 这个横截面里躺的方向（见 `barInFrame`），没有 `rotate` 时就是 +y。近边略微
 * 往回退一个 `cap`，让灯管本身也落在光里，而不是一条硬邦邦的直边。
 */
function beamPath(ctx, half, spread, depth, bar = { x: 0, y: 1 }) {
  const angle = (spread / 2) * RAD;
  const farX = Math.cos(angle) * depth;
  const farY = Math.sin(angle) * depth;
  const cap = Math.max(1, half * 0.12);
  const bx = bar.x || 0;
  const by = bar.y || 1;
  // 近边是灯管本身，两头各多退 `cap`；远边从两端按锥角张开。
  const e1x = -bx * half;
  const e1y = -by * half;
  const e2x = bx * half;
  const e2y = by * half;
  ctx.moveTo(e1x - bx * cap - cap, e1y - by * cap);
  ctx.lineTo(e1x + farX, e1y - farY);
  ctx.lineTo(e2x + farX, e2y + farY);
  ctx.lineTo(e2x + bx * cap - cap, e2y + by * cap);
  ctx.closePath();
}

/**
 * Paints one light's footprint into `ctx`, without any halo.
 *
 * A point light (`width` 0) is a circle of radius 1 drawn in a space scaled to
 * the footprint's two axes, which is the cheapest way to get an ellipse out of a
 * radial gradient.
 *
 * A light with a width is an **emitter bar**: the same point-light energy is
 * stamped a few times along the bar, so the light starts out as wide as the bar
 * and only widens with distance. A narrow beam is cut by a fan whose sides leave
 * the ends of the bar at the cone angle — not by a band that travels with the
 * beam, which would make the projected light look like the tube.
 *
 * The cone is an angular mask composited on top. Its width is `geometry.fan`,
 * the 3D cone's **projected** angle: edge on it is a narrow wedge, aimed at the
 * camera it opens into a whole circle and the mask is skipped. `lightWeightAt`
 * uses the same number, so the painted halo and the lit objects never disagree.
 * A wedge is only ever *fully* cut while the camera is outside the cone; once
 * the cone's base swallows it (`geometry.cut` dropping to 0) the missing part
 * fades out instead of leaving a hard notch through the middle of the spot.
 *
 * @returns {boolean} Whether anything was painted.
 */
function paintFootprint(ctx, light, geometry, size, masked = true) {
  const { sx, sy, rx, ry, heading, w = 0, scale = 1, bar = { x: 0, y: 1 }, cut = 1, fade: reachFade = 1 } = geometry;
  if (!(rx > 0 && ry > 0)) {
    return false;
  }
  const spread = clamp(geometry.fan ?? light.spread, 1, 360);
  // 扇形外面留多少光：`cut` 是「切掉多少」，1 是切干净，0 是根本不切
  // （镜头进了锥里，缺口只是灯自己挡住的背面，见 `beamFrame`）。
  const keep = clamp(1 - clamp(cut, 0, 1), 0, 1);
  // 一个取样点的 alpha 上限是 1，所以 1 以上的强度靠多填几遍累积——这正是
  // 「一盏灯过曝」该有的样子。遍数封顶四遍：再往上只是烧像素。
  const passes = Math.min(4, Math.max(1, Math.ceil(light.intensity)));
  // 光走完 `depth` 才落到这一层，那一段射程已经花掉了（`beamFrame` 的
  // `exhaust`）：整片光斑跟着它一起暗，中心和边缘都是。
  const alpha = clamp(light.intensity / passes, 0, 1) * clamp(reachFade, 0, 1);
  const { r, g, b } = geometry.color;
  const ink = (value, share = 1) =>
    `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${value * alpha * share})`;

  const half = Math.max(0, w) / 2;
  // 遮罩只要画到能量之外：再远的地方本来就是 0。
  const depth = Math.max(rx, ry) * 2;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  if (!masked && spread < 360 && keep >= 1 && !(half > 0 && spread >= 120)) {
    // 直接画在灯层上时不能用 `destination-in`：那会把别的灯一起擦掉。
    // 退而求其次，先剪出光的形状，边缘是硬的——只有拿不到离屏画布时才会走到这里。
    // 宽光束（≥120°）的条光不裁剪：那已经接近半球，减法比加法更糟。
    ctx.translate(sx, sy);
    ctx.rotate(heading * RAD);
    ctx.beginPath();
    if (half > 0) {
      beamPath(ctx, half, spread, depth, bar);
    } else {
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, depth, -(spread / 2) * RAD, (spread / 2) * RAD);
      ctx.closePath();
    }
    ctx.clip();
    ctx.rotate(-heading * RAD);
    ctx.translate(-sx, -sy);
  }
  ctx.translate(sx, sy);
  ctx.rotate(heading * RAD);

  if (half > 0) {
    // 灯管上的发光点：每个都是一盏完整的点光，叠在一起才是「一段会发光的
    // 实体」——管内是平顶，离开管身才按距离衰减。取样点太少会在管中间留暗带。
    if (typeof ctx.createRadialGradient !== "function") {
      ctx.restore();
      return false;
    }
    const samples = Math.min(5, Math.max(2, Math.ceil((half * 2) / Math.max(1, ry * 0.35))));
    const share = 1 / samples;
    const stops = falloffStops(light.range < 0);
    for (let pass = 0; pass < passes; pass += 1) {
      for (let index = 0; index < samples; index += 1) {
        const at = samples === 1 ? 0 : -half + (2 * half * index) / (samples - 1);
        ctx.save();
        // 取样点排在灯管自己躺的方向上：`rotate` 打滚时整段灯管跟着转。
        ctx.translate(at * (bar.x || 0), at * (bar.y || 1));
        ctx.scale(rx, ry);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        for (const [stop, value] of stops) {
          gradient.addColorStop(stop, ink(value, share));
        }
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  } else {
    // 点光：一个椭圆，两个半径分开缩放就是最省事的画法。
    ctx.scale(rx, ry);
    const gradient = ctx.createRadialGradient?.(0, 0, 0, 0, 0, 1);
    if (!gradient) {
      ctx.restore();
      return false;
    }
    for (const [at, value] of falloffStops(light.range < 0)) {
      gradient.addColorStop(at, ink(value));
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    for (let pass = 0; pass < passes; pass += 1) {
      ctx.fill();
    }
  }
  ctx.restore();

  if (!masked || spread >= 360 || keep >= 1) {
    return true;
  }
  if (half > 0 && spread < 120) {
    // 条光：遮罩的近边就是灯管本身，两侧从管端按锥角张开——光是从这段灯管
    // 上射出来的，近处只有管长那么宽，越远越宽。边缘用一次模糊软化。
    const blur = Math.max(1, Math.min(40 * scale, depth * 0.015));
    ctx.save();
    if ("filter" in ctx) {
      ctx.filter = `blur(${blur.toFixed(1)}px)`;
    }
    ctx.globalCompositeOperation = "destination-in";
    ctx.translate(sx, sy);
    ctx.rotate(heading * RAD);
    ctx.beginPath();
    beamPath(ctx, half, spread, depth, bar);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.restore();
    return true;
  }
  if (typeof ctx.createConicGradient !== "function") {
    // 老上下文没有锥形渐变：用一个硬边扇形代替，至少方向是对的。
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.translate(sx, sy);
    ctx.beginPath();
    const cone = (spread / 2) * RAD;
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, depth, heading * RAD - cone, heading * RAD + cone);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.fill();
    ctx.restore();
    return true;
  }
  // 锥形渐变从锥的一侧起算，把整段「亮」都放在 0…spread 这一截里，剩下的圆周
  // 落在 `keep` 上——切干净时就是 0。边缘半宽是 `penumbra`：扇形被投影撑得越
  // 开，这条边越是渐变（见 `beamFrame`），光晕里才不留一道从灯心射出的折痕。
  const halfAngle = spread / 2;
  const room = Math.max(0.5, Math.min(halfAngle, 180 - halfAngle));
  const fade = clamp(Number(geometry.penumbra) || 0, 0.5, room);
  const mid = keep + (1 - keep) * 0.5;
  const start = (heading - halfAngle) * RAD;
  const conic = ctx.createConicGradient(start, sx, sy);
  conic.addColorStop(0, `rgba(255,255,255,${mid})`);
  conic.addColorStop(fade / 360, "rgba(255,255,255,1)");
  conic.addColorStop((spread - fade) / 360, "rgba(255,255,255,1)");
  conic.addColorStop((spread + fade) / 360, `rgba(255,255,255,${keep})`);
  conic.addColorStop((360 - fade) / 360, `rgba(255,255,255,${keep})`);
  conic.addColorStop(1, `rgba(255,255,255,${mid})`);
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = conic;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.restore();
  return true;
}

/**
 * Draws one object's shape into `ctx` as a flat silhouette.
 *
 * The bitmap is used when there is one — an image's own alpha is exactly the
 * "non-transparent edge" a rim glow has to follow — and a plain rectangle
 * otherwise, which is what a text or a backdrop can offer.
 *
 * An object that has been turned out of the stage plane arrives with
 * `corners`: the four points its rectangle now covers, in stage coordinates.
 * Those are a projection rather than an affine image of the rectangle, so the
 * shape is drawn as the same two clipped triangles the export uses — the rim
 * glow then follows the picture's real outline instead of a squashed box.
 *
 * @param {object} ctx
 * @param {object} object `{ bitmap, x, y, w, h, rotation, scale, scaleX, scaleY, corners? }`
 * @param {{ width: number, height: number }} size
 * @param {number} scale Canvas pixels per logical pixel.
 */
export function drawSilhouette(ctx, object, size, scale) {
  const w = object.w ?? 0;
  const h = object.h ?? 0;
  if (!(w > 0) || !(h > 0)) {
    return;
  }
  const inPixels = (point) => ({
    x: size.width / 2 + point.x * scale,
    y: size.height / 2 - point.y * scale,
  });
  if (object.corners) {
    const source = [
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ];
    const target = object.corners.map(inPixels);
    for (const piece of quadTriangles(source, target)) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(piece.target[0].x, piece.target[0].y);
      ctx.lineTo(piece.target[1].x, piece.target[1].y);
      ctx.lineTo(piece.target[2].x, piece.target[2].y);
      ctx.closePath();
      ctx.clip();
      ctx.transform(piece.a, piece.b, piece.c, piece.d, piece.e, piece.f);
      paintSilhouette(ctx, object, w, h);
      ctx.restore();
    }
    return;
  }
  const sx = size.width / 2 + (object.x || 0) * scale;
  const sy = size.height / 2 - (object.y || 0) * scale;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate((Number(object.rotation) || 0) * RAD);
  const kx = (object.scale ?? 1) * (object.scaleX ?? 1) * scale;
  const ky = (object.scale ?? 1) * (object.scaleY ?? 1) * scale;
  ctx.scale(kx, ky);
  paintSilhouette(ctx, object, w, h);
  ctx.restore();
}

/**
 * 剪影在画布上占的那一块。也是「往里收」的中心：收缩必须绕对象自己的中心做，
 * 绕画布中心那圈边光会整条跑偏。
 *
 * @param {object} object 同 `drawSilhouette`。
 * @param {{ width: number, height: number }} size
 * @param {number} scale Canvas pixels per logical pixel.
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function silhouetteBox(object, size, scale) {
  const w = object.w ?? 0;
  const h = object.h ?? 0;
  if (!(w > 0) || !(h > 0)) {
    return null;
  }
  if (object.corners) {
    const xs = object.corners.map((point) => size.width / 2 + point.x * scale);
    const ys = object.corners.map((point) => size.height / 2 - point.y * scale);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return {
      x: (left + Math.max(...xs)) / 2,
      y: (top + Math.max(...ys)) / 2,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top,
    };
  }
  return {
    x: size.width / 2 + (object.x || 0) * scale,
    y: size.height / 2 - (object.y || 0) * scale,
    width: w * Math.abs((object.scale ?? 1) * (object.scaleX ?? 1) * scale),
    height: h * Math.abs((object.scale ?? 1) * (object.scaleY ?? 1) * scale),
  };
}

/**
 * 把同一个剪影**往里收** `erode` 个画布像素再画一遍，用来把轮廓光的内部挖空。
 *
 * 边光要的是一条**跨在轮廓上**的带：外缘由 `blur()` 散出去，内缘就是这一遍收
 * 进来的边界。Canvas2D 没有腐蚀，绕对象中心把剪影缩一点是最省事的近似——这条
 * 带只有几个像素宽，这点形变看不出来。
 *
 * @param {object} ctx
 * @param {object} object 同 `drawSilhouette`。
 * @param {{ width: number, height: number }} size
 * @param {number} scale Canvas pixels per logical pixel.
 * @param {number} erode 往里收多少画布像素。
 */
function drawErodedSilhouette(ctx, object, size, scale, erode) {
  const box = silhouetteBox(object, size, scale);
  if (!box) {
    return;
  }
  const shrink = (length) =>
    length > 0 ? clamp(1 - erode / (length / 2), 0.05, 1) : 1;
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(shrink(box.width), shrink(box.height));
  ctx.translate(-box.x, -box.y);
  drawSilhouette(ctx, object, size, scale);
  ctx.restore();
}

/**
 * 一张位图（或一个矩形）在 `-w/2, -h/2` 起的那个框里。
 *
 * 剪影也跟着对象自己的抗锯齿开关走（`aa`）：关掉抗锯齿的角色，边光和挡光也
 * 该是同一个硬边，否则轮廓上会多出一圈只有灯层才有的柔边。
 */
function paintSilhouette(ctx, object, w, h) {
  if (object.bitmap) {
    const previous = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = object.smooth !== false;
    try {
      ctx.drawImage(object.bitmap, -w / 2, -h / 2, w, h);
    } catch {
      // 一张还没解码完的位图不值得让整帧失败。
    }
    ctx.imageSmoothingEnabled = previous;
  } else {
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
}

/** The `blur()` a soft light asks for, in canvas pixels. */
function softBlur(light, scale) {
  return light.soft > 0 ? Math.max(1, light.soft * 60 * scale) : 0;
}

/**
 * The `blur()` a rim glow asks for, in canvas pixels：灯的泛光决定半径与柔度。
 *
 * 这是「往剪影外面糊开多少」，所以它就是边光那条线的宽度。它比泛光（`soft`）
 * 窄得多：轮廓光是一条贴着轮廓的亮线，糊成几十像素就变成人物外面的一层雾，
 * 反而把轮廓糊没了。
 */
function rimBlur(light, scale) {
  return Math.max(1.5, (2 + light.bloom * 12) * scale);
}

/**
 * Paints every light and every rim glow onto `ctx`.
 *
 * `ctx` is the light layer's own canvas: it is cleared here and expects to be
 * composited onto the scene by the caller (the stage with `screen`, the export
 * with `screen` as well), so that a lamp can only ever brighten.
 *
 * @param {object} ctx 2D context of the light layer.
 * @param {Array<object>} lights Normalized lights, each with an `excluded` set
 *   of object keys and a `silent` flag for a light that draws no halo.
 * @param {object} options
 * @param {{ width: number, height: number }} options.size Canvas size.
 * @param {number} [options.scale] Canvas pixels per logical pixel.
 * @param {Array<object>} [options.objects] Lit objects, see `drawSilhouette`.
 *   Their `z` is what puts them in front of a lamp — a lamp behind an object has
 *   its halo cut by that object's silhouette (`holesOf`); `cast: false` opts an
 *   object out of that (the backdrop does), because it is the world itself. Their
 *   `rim` (0–1, default 0) is how much of a rim light that object takes.
 * @param {{ light: object, rim: object, lit: object } | null} [options.scratch]
 *   Three offscreen canvases of the layer's size: the single lamp, the rim glow
 *   silhouette, and the lit object. Without them a soft light, a rim glow and a
 *   textured brighten cannot be produced, so the plain footprint is all.
 * @returns {boolean} Whether anything was painted.
 */
export function paintLights(ctx, lights, options = {}) {
  const { size = { width: 0, height: 0 }, scale = 1, objects = [], scratch = null } = options;
  // 没有真的 2D 上下文（node 测试、没拿到 canvas）就什么都不画：一帧没有灯
  // 比一帧因为灯而崩掉好。
  if (!ctx || typeof ctx.clearRect !== "function" || typeof ctx.createRadialGradient !== "function") {
    return false;
  }
  ctx.save();
  ctx.setTransform?.(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.restore();

  const list = (lights ?? []).filter(
    (light) => light && light.intensity > 0 && light.opacity > 0,
  );
  if (!list.length) {
    return false;
  }
  for (const light of list) {
    paintOneLight(ctx, light, { size, scale, objects, scratch });
  }
  return true;
}

/**
 * 这盏灯的光场要让开哪些对象。
 *
 * 两类：
 *
 * 1. `stage.exclude` 点名排除的（`light.excluded`）——作者说「这盏灯不照它」；
 * 2. 站在灯前面的：对象的 `z` 比灯小，它就挡在灯与观众之间，灯从它背后照过
 *    去，剪影里当然不该有光。灯比对象深多少都不影响这一步：深度就是前后顺序，
 *    差一个像素也是「在后面」——`lightFaceAt` 那条 700 像素的缓坡管的是正面
 *    照度，不是遮挡。
 *
 * `cast` 为假的对象从不按深度挡光：这就是「透光」（`object.translucent(true)`）。
 * 角色默认挡光，所以灯站在他背后时他的轮廓会把光晕挖开；作者让他透光之后，光
 * 就从他的轮廓中间穿过去。背景、文字、视频画面与光源默认就是透的 —— 背景画的
 * 是整个世界，把它挖掉等于把灯整个抹了。
 *
 * 点名排除仍然成立：透光说的是「光穿得过它」，排除说的是「这盏灯不照它」。
 *
 * @param {object} light A normalized light.
 * @param {Array<object>} objects Lit objects, each with `key`, `z` and `cast`.
 * @returns {Array<object>} The silhouettes to cut out of the halo.
 */
function holesOf(light, objects) {
  const depth = Number(light?.z) || 0;
  const holes = [];
  for (const object of objects) {
    if (light.excluded?.has(object.key)) {
      holes.push(object);
      continue;
    }
    if (object.cast === false) {
      continue;
    }
    if ((Number(object.z) || 0) < depth) {
      holes.push(object);
    }
  }
  return holes;
}

/** One lamp: footprint, holes, softness, rim glow. */
function paintOneLight(ctx, light, { size, scale, objects, scratch }) {
  const geometry = lightGeometry(light, scale, size);
  const halo = scratch?.light ?? null;
  const haloContext = halo?.getContext?.("2d") ?? null;
  // 没有离屏画布就没有柔光、也没有挖洞：直接画在灯层上，方向仍然对。
  if (haloContext) {
    haloContext.setTransform?.(1, 0, 0, 1, 0, 0);
    haloContext.globalAlpha = 1;
    haloContext.globalCompositeOperation = "source-over";
    haloContext.clearRect(0, 0, size.width, size.height);
    if (!paintFootprint(haloContext, light, geometry, size, true)) {
      return;
    }
  } else {
    // 没有离屏画布时直接画在灯层上，作用系数只能在这一层自己乘进去。
    ctx.save();
    ctx.globalAlpha = clamp(light.opacity, 0, 1);
    const painted = paintFootprint(ctx, light, geometry, size, false);
    ctx.restore();
    if (!painted) {
      return;
    }
  }
  if (haloContext) {
    const holes = holesOf(light, objects);
    if (holes.length) {
      haloContext.save();
      haloContext.globalCompositeOperation = "destination-out";
      haloContext.fillStyle = "#000";
      for (const object of holes) {
        drawSilhouette(haloContext, object, size, scale);
      }
      haloContext.restore();
    }
  }
  const alpha = clamp(light.opacity, 0, 1);
  if (haloContext) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha;
    const blur = softBlur(light, scale);
    if (blur > 0) {
      ctx.filter = `blur(${blur.toFixed(1)}px)`;
    }
    ctx.drawImage(halo, 0, 0);
    ctx.filter = "none";
    ctx.restore();
  }
  const field = haloContext ? halo : null;
  paintLitObjects(ctx, light, { size, scale, objects, scratch, halo: field });
  paintRim(ctx, light, { size, scale, objects, scratch, geometry, halo: field });
}

/**
 * 让受光的对象自己变亮，而不是只在画面上盖一层色。
 *
 * 灯层原本只是一片渐变，压在对象上就是「一张灰暗的贴图蒙了层色片」。这里换成
 * 对象自己的像素乘上光的颜色，再按受光权重加回灯层：加进去的量正比于它本身的
 * 明暗，所以纹理、明暗层次都还在，看上去才是「被照亮」——也就是把这一块的
 * 环境亮度抬上去，而不是盖一层灰。
 *
 * 权重来自灯自己的光场（那张已经画好的光晕画布）：近处浓、远处淡、锥外为零；
 * 再乘一次「正面照度」——灯站到对象背后时它是 0，正面不该被补光。
 * 用一个对象一个权重（矩形取最大）会把整块对象一起提亮，锥光只擦到半边时那
 * 半边之外也跟着亮了，所以这里用光场当遮罩。背景同样参与：它不参与泛光，但
 * 必须被照亮，否则整块地面只是蒙了层暖色。
 *
 * 需要第三张离屏画布：光色铺底 → `multiply` 画对象 → `destination-in` 再画一次
 * 剪影，得到「对象 × 光色」且只占对象那一块；有光场时再 `destination-in` 一次
 * 光晕。没有画布时按矩形权重退回平铺提亮。
 */
function paintLitObjects(ctx, light, { size, scale, objects, scratch, halo = null }) {
  const lit = scratch?.lit?.getContext?.("2d") ?? null;
  if (!lit) {
    return;
  }
  const { r, g, b } = lightColor(light.color);
  const color = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  const opacity = clamp(light.opacity, 0, 1);
  // 有光场时强度已经在遮罩的 alpha 里，再乘一次就成了平方。
  const gain = LIT_GAIN * opacity * (halo ? 1 : clamp(light.intensity, 0, 8));
  for (const object of objects) {
    if (object.lit === false || light.excluded?.has(object.key)) {
      continue;
    }
    // 光只是擦到边角就不必画了：贴图乘色的开销比一层光晕大得多。
    const weight = lightRectWeight(light, object);
    // 灯在对象后面时正面照不到：越靠里越暗，700 之后全黑，只剩泛光的轮廓。
    const face = lightFaceAt(light, object.z);
    const alpha = clamp(weight * gain * face, 0, 1);
    if (!(alpha > 0.02)) {
      continue;
    }
    lit.setTransform?.(1, 0, 0, 1, 0, 0);
    lit.globalAlpha = 1;
    lit.globalCompositeOperation = "source-over";
    lit.clearRect(0, 0, size.width, size.height);
    lit.fillStyle = color;
    lit.fillRect(0, 0, size.width, size.height);
    // `multiply` 的源用白色画剪影：位图给的是自己的颜色，矩形给的是一倍。
    lit.globalCompositeOperation = "multiply";
    lit.fillStyle = "#fff";
    drawSilhouette(lit, object, size, scale);
    // 只留对象那一块：底色与矩形以外的地方都要丢掉。
    lit.globalCompositeOperation = "destination-in";
    drawSilhouette(lit, object, size, scale);
    if (halo) {
      // 再乘一遍灯的光场：被照亮的是「这块对象的这一片」，不是整块对象。
      lit.drawImage(halo, 0, 0);
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = halo ? LIT_GAIN * opacity * face : alpha;
    ctx.drawImage(scratch.lit, 0, 0);
    ctx.restore();
  }
}

/**
 * 轮廓光（`<对象>.rim(强度)`）：逆光时贴着对象边缘勾出的那一圈辉光。
 *
 * 三个条件同时成立才画：
 *
 * 1. 灯自己的 `bloom` 大于 0 —— 它决定勾边的半径与柔度；
 * 2. 对象自己的 `rim` 大于 0 —— 它决定这一段边有多亮。默认 0，不写就不勾；
 * 3. 灯在对象背后 —— 正面照度小于 1 才有一圈边光。灯在正面时那叫补光，不叫
 *    轮廓光：一团光照在脸上不会给人描边。
 *
 * 留下的是一条**跨在轮廓上**的带：先把剪影糊开、填进光色，再扣掉往里收过一圈
 * 的剪影本身。既不能全留（整个人物会糊上一层平色，像蒙了块色片），也不能只留
 * 轮廓外面那一半——那一半压在光晕最亮的地方，加了也看不出来。锥光没扫到的对象
 * 不勾边（`lightRectWeight` 分档），逐个对象单独画，所以每个对象的强度互不影响。
 */
function paintRim(ctx, light, { size, scale, objects, scratch, geometry, halo = null }) {
  if (!(light.bloom > 0)) {
    return;
  }
  const canvas = scratch?.rim ?? null;
  const rimContext = canvas?.getContext?.("2d") ?? null;
  if (!rimContext) {
    return;
  }
  const { r, g, b } = geometry.color;
  const color = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  const strength = light.bloom * light.opacity * (halo ? 1 : Math.min(1, light.intensity));
  for (const object of objects) {
    const rim = Number(object.rim) || 0;
    if (!(rim > 0) || light.excluded?.has(object.key)) {
      continue;
    }
    // 逆光才算轮廓光：灯在正面或同深度时这一步是 0。
    const back = 1 - lightFaceAt(light, object.z);
    if (!(back > 0.02)) {
      continue;
    }
    // 只按「光场扫没扫到它」分档，不拿光晕本身当遮罩：光晕是渐变的，拿它乘
    // 一遍，贴着轮廓的那一圈本来就只剩五六成 alpha，乘完基本看不见了。
    const reach = clamp(lightRectWeight(light, object) / 0.35, 0, 1);
    if (!(reach > 0.01)) {
      continue;
    }
    rimContext.setTransform?.(1, 0, 0, 1, 0, 0);
    rimContext.globalAlpha = 1;
    rimContext.globalCompositeOperation = "source-over";
    rimContext.filter = "none";
    rimContext.clearRect(0, 0, size.width, size.height);
    // 先把剪影**糊开**再上色 —— 轮廓光就是往剪影外面散出去的那一圈。模糊必须
    // 发生在扣掉剪影之前：先画实心剪影、最后才靠 `ctx.filter` 去糊，那时画布上
    // 已经自己减自己减空了，糊出来的是一张空画布，边光永远不出现。
    const blur = rimBlur(light, scale);
    // 内缘：光从轮廓漫到人物身上的那一段。它比外缘短一点，但因为下面那一遍
    // 模糊会把这条界线摊成一段坡度，实际看到的宽度与它相当。
    const inner = blur * 0.7;
    rimContext.filter = `blur(${blur.toFixed(1)}px)`;
    rimContext.fillStyle = "#000";
    drawSilhouette(rimContext, object, size, scale);
    // 上色要用硬边，模糊只该发生在剪影这一步。
    rimContext.filter = "none";
    rimContext.globalCompositeOperation = "source-in";
    rimContext.fillStyle = color;
    rimContext.fillRect(0, 0, size.width, size.height);
    // 边光是**打在对象自己那条边上**的：往里收一圈再把里面挖掉，留下的带跨在
    // 轮廓上——外一半散进光晕，内一半落在人物身上才看得见。只留轮廓外面那一半
    // 时，那一半正好压在最亮的光晕上，加多少都像没加，人物一黑边光就整条消失；
    // 而一点都不挖，整个人物会被涂成一块平色，看着像蒙了色片而不是被逆光勾了边。
    rimContext.globalCompositeOperation = "destination-out";
    // 内缘也糊一遍：硬边扣出来的是台阶，光会像贴了一圈描线；糊过之后亮度从
    // 边缘往人物身上慢慢退下去，才像光漫进去。
    rimContext.filter = `blur(${(inner * 0.5).toFixed(1)}px)`;
    drawErodedSilhouette(rimContext, object, size, scale, inner);
    rimContext.filter = "none";

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // 糊开的边缘峰值只有一半 alpha，再乘一次亮度就没了；这里把强度还回去，
    // 让它成为画面里最亮的那一条，而不是贴着光晕的一层淡淡的重影。系数压在
    // 1.8 以下：再高一层就整条烧成纯白，颜色全丢了。
    ctx.globalAlpha = clamp(strength * rim * back * reach * 1.6, 0, 1);
    // 整条带再轻糊一次：外缘不会像一刀切出来的边，内缘在上一步已经摊成坡度，
    // 这里再软一层，才是「光漫到人物身上」而不是描了一圈线。
    ctx.filter = `blur(${(blur * 0.5).toFixed(1)}px)`;
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = "none";
    ctx.restore();
  }
}

/**
 * A light layer: one canvas over the stage, painted on demand.
 *
 * The stage owns the element and its place in the layer list; this only knows
 * how to draw, and only when something changed — a scene with a lamp standing
 * still must not repaint the frame sixty times a second.
 *
 * @param {object} options
 * @param {{ width: number, height: number }} options.size Logical stage size.
 * @param {number} [options.scale] Canvas pixels per logical pixel.
 * @param {() => Array<object>} [options.objects] Reads the lit objects.
 * @param {(run: () => void) => void} [options.schedule] Frame scheduler.
 * @returns {{ node: object, draw: (lights: Array<object>) => void,
 *   invalidate: () => void, setScale: (scale: number) => void, clear: () => void }}
 */
export function createLightLayer({
  size = { width: 1920, height: 1080 },
  scale = 0.5,
  objects = () => [],
  schedule = (run) => setTimeout(run, 16),
}) {
  const node = document.createElement("canvas");
  node.className = "stage__light";
  node.width = Math.max(1, Math.round(size.width * scale));
  node.height = Math.max(1, Math.round(size.height * scale));
  let context = typeof node.getContext === "function" ? node.getContext("2d") : null;
  let lightScratch = null;
  let rimScratch = null;
  let litScratch = null;
  const scratchFor = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  let current = [];
  let pending = false;

  const dimensions = () => ({ width: node.width || 0, height: node.height || 0 });

  const paint = (lights) => {
    if (!context) {
      return;
    }
    const canvasSize = dimensions();
    const scratchSize = { width: canvasSize.width, height: canvasSize.height };
    if (!lightScratch && canvasSize.width > 0 && canvasSize.height > 0) {
      lightScratch = scratchFor(canvasSize.width, canvasSize.height);
      rimScratch = scratchFor(canvasSize.width, canvasSize.height);
      litScratch = scratchFor(canvasSize.width, canvasSize.height);
    }
    paintLights(context, lights, {
      size: scratchSize,
      scale: node.width / (size.width || 1),
      objects: lights.length ? objects() : [],
      scratch: lightScratch
        ? { light: lightScratch, rim: rimScratch, lit: litScratch }
        : null,
    });
  };

  return {
    node,
    /** Draws `lights` now, and remembers them for the next change-driven draw. */
    draw(lights) {
      current = lights ?? [];
      pending = false;
      paint(current);
    },
    /**
     * Asks for a redraw on the next frame, coalescing a burst into one.
     *
     * `lights` replaces what the layer remembers; leaving it out repaints the
     * lights it already has, which is what a step of an animation does.
     */
    invalidate(lights) {
      if (lights) {
        current = lights;
      }
      if (pending) {
        return;
      }
      pending = true;
      schedule(() => {
        if (pending) {
          pending = false;
          paint(current);
        }
      });
    },
    /** Sizes the layer to a new frame, keeping the current lights. */
    setScale(next) {
      const ratio = Number(next) || 0;
      if (!(ratio > 0)) {
        return;
      }
      const width = Math.max(1, Math.round(size.width * ratio));
      const height = Math.max(1, Math.round(size.height * ratio));
      if (width === node.width && height === node.height) {
        return;
      }
      node.width = width;
      node.height = height;
      lightScratch = null;
      rimScratch = null;
      context = typeof node.getContext === "function" ? node.getContext("2d") : null;
      paint(current);
    },
    /** Drops the picture and the lights that were on it. */
    clear() {
      current = [];
      pending = false;
      lightScratch = null;
      rimScratch = null;
      context?.clearRect?.(0, 0, node.width || 0, node.height || 0);
    },
  };
}
