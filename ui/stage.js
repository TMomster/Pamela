// 舞台：剧本输出的呈现层。
// Pamela — the stage: where a script's output is shown.
// 舞台不依赖剧本语言的语法细节；预览播放一次性应用全部变更。

import { antialiasAmount, antialiasBitmap, antialiasIsOn } from "./antialias.js";
import { axesOf, createAxesLayer } from "./axes.js";
import { createAudioFactory } from "./audio.js";
import {
  createVoiceEffect,
  AUTOVOICE_DEFAULT_SPEED,
  AUTOVOICE_MIN_SPEED,
  AUTOVOICE_MAX_SPEED,
} from "./voice-effect.js";
import { createChoices } from "./choice.js";
import { createDialogue } from "./dialog.js";
import { createEffectFactory } from "./effect.js";
import {
  addTint,
  clampChannel,
  lookFilter,
  lookFilterFull,
  lookIsNeutral,
  neutralLook,
  parseHex,
  tintMatrix,
  toHex,
  withLook,
} from "./filters.js";
import { applyStep, decodeGif, gifBytesFromDataUrl, isGifPath } from "./gif.js";
import {
  LIGHT_LIMIT,
  createLightLayer,
  lightOrientation,
  lightShadeOf,
  neutralLight,
  normalizeLight,
} from "./light.js";
import { frameAt, pathDuration, pathEnd, pointAt } from "./path.js";
import { PARAM_SPECS, boolArg } from "./pamela.js";
import {
  PAMELA_INTRO_MS,
  drawPamelaIntro,
  pamelaIntroState,
} from "./pamela-intro.js";
import {
  BACKGROUND_DEPTH,
  CAMERA_DISTANCE,
  CORNERS,
  byDepth,
  clampDepth,
  depthScale,
  homographyInPixels,
  isFlatPose,
  orientationOf,
  projectPose,
  quadHomography,
  ORDER_CEILING,
  sceneOrder,
} from "./space.js";
import {
  GUIDELINE_INTERVAL,
  createGuidelineLayer,
  guidelineInterval,
} from "./guideline.js";
import { createSpritePlayer } from "./sprite-group.js";
import { TEXT_FONT_WEIGHT, textFontStack, textFontWeight } from "./text-font.js";
import { createVideoFactory } from "./video.js";

/**
 * The stage's logical size.
 *
 * The coordinates a script passes to `move`/`moveTo` are in this fixed space,
 * not in device pixels, so one script lays out the same on every screen: the
 * frame is scaled as a whole while the numbers a writer typed keep their
 * meaning. The ratio matches the frame's 16:9 aspect, so logical units and
 * frame pixels stay proportional at any window size.
 */
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/**
 * The stage point under a pointer, or null when the pointer is outside.
 *
 * `box` is the frame's own client rect. The answer is in the same space the
 * script's `moveTo` takes — origin at the centre, y up, rounded to whole units
 * so the reading does not flicker between 319.7 and 320.3 while the hand
 * shakes. Outside the frame there is no answer: a coordinate the pointer is not
 * standing on is worse than no coordinate at all.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ left: number, top: number, width: number, height: number }} box
 * @returns {{ x: number, y: number } | null}
 */
export function pointInStage(clientX, clientY, box) {
  if (!(box.width > 0 && box.height > 0)) {
    return null;
  }
  const across = (clientX - box.left) / box.width;
  const down = (clientY - box.top) / box.height;
  if (across < 0 || across > 1 || down < 0 || down > 1) {
    return null;
  }
  return {
    x: Math.round((across - 0.5) * STAGE_WIDTH),
    y: Math.round((0.5 - down) * STAGE_HEIGHT),
  };
}

/**
 * Whether the run on the stage is a replay of a loaded save.
 *
 * A replay seeks a node rather than performing a scene: lines are not shown,
 * nothing is waited for, and no animation takes time, so the stage ends up on
 * the picture the saved node stood on. One stage is built per application and
 * the flag is asked of the same place every animation reads its duration
 * from, which is why it lives here rather than being threaded through.
 */
let replaying = false;

/**
 * 舞台是否正在定位到某一时刻以供查看，而非执行剧本。
 * playing a scene.
 *
 * The path editor needs the frame the key plays on: the backdrop that is up, the
 * characters that are on, where they stand. Getting there means running the
 * script up to that statement — but the script may show a line first, and a
 * line waits for a click that no click occurs, so the run would hang
 * and the editor would never open.
 *
 * 预览播放一次性应用全部变更，不等待逐条语句的交互确认。
 * 预览播放一次性应用全部变更，不等待逐条语句的交互确认。
 * nothing is waited for. Unlike a replay, the line is drawn, because the
 * frame the author is placing a path against includes the dialogue box.
 */
let previewing = false;

/**
 * Reads the point a `move`/`moveTo` call names.
 *
 * @param {string} kind Object name, for the message a writer sees.
 * @param {unknown} x
 * @param {unknown} y
 * @returns {{ x: number, y: number }}
 */
function point(kind, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${kind} 的坐标需要数字`);
  }
  return { x, y };
}

/**
 * Reads how long an animation takes, in milliseconds.
 *
 * Omitting it means "at once", which is what a writer wants when setting an
 * initial place rather than performing a movement. Every animated method —
 * moving, turning or resizing — takes its duration through here, so they all
 * read an omitted time the same way.
 *
 * @param {string} kind Object name, for the message a writer sees.
 * @param {unknown} time
 * @returns {number}
 */
function duration(kind, time) {
  if (replaying || previewing) {
    // A replay is travelling to a node, and a preview to a key: both land every
    // change at once, so the stage is on the right picture when the moment
    // arrives rather than partway through an animation no user is present.
    return 0;
  }
  if (time === undefined || time === null) {
    return 0;
  }
  if (!Number.isFinite(time) || time < 0) {
    throw new Error(`${kind} 的时间需要非负的毫秒数`);
  }
  return time;
}

/**
 * Reads the angle a `rotate`/`rotateTo` call names, in degrees.
 *
 * Angles are not wrapped into 0–360: a script is free to write `rotate(720)`
 * for two full turns, or a negative angle to turn the other way, and the turn
 * is animated through the whole of it rather than by the shortest route.
 *
 * @param {string} kind Object name, for the message a writer sees.
 * @param {unknown} value
 * @returns {number}
 */
function angle(kind, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${kind} 的角度需要数字`);
  }
  return value;
}

/**
 * Reads the factor a `scale`/`scaleTo` call names, where 1 is the image's own
 * size and 2 is twice it.
 *
 * Only a positive factor is meaningful: zero collapses the image and a
 * negative one mirrors it, neither of which is what "a multiplier" says. A
 * writer who wants either can be given a method for it when it is asked for.
 *
 * @param {string} kind Object name, for the message a writer sees.
 * @param {unknown} value
 * @returns {number}
 */
function factor(kind, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${kind} 的倍率需要大于 0 的数字`);
  }
  return value;
}

/**
 * Reads one channel of a colour filter call.
 *
 * Like the other readers, this only names the channel so a writer sees which
 * argument was wrong; the clamping to 0–255 happens later, in `clampChannel`,
 * because `rgb` needs the current value added in before the clamp and `rgbTo`
 * does not.
 *
 * @param {string} kind Object name, for the message a writer sees.
 * @param {unknown} value
 * @param {string} name The channel, for the message.
 * @returns {number}
 */
function tintChannel(kind, value, name) {
  if (!Number.isFinite(value)) {
    throw new Error(`${kind} 的${name}需要数字`);
  }
  return value;
}

/**
 * Where an object keeps the writer that turns and resizes its image.
 *
 * The key is a symbol because it is not script API: the interpreter reads a
 * member with a plain `object[name]` and only ever has a string to look up
 * (`ui/pamela.js::readMember`), so a symbol-keyed field is out of a script's
 * reach. `Character.transform` used to be this writer; that name now belongs to
 * the free transform below, hence the move.
 */
const APPLY_FRAME = Symbol("applyFrame");

/**
 * Where an object keeps the writer that sets its opacity.
 *
 * A symbol for the same reason `APPLY_FRAME` is one: the interpreter reads a
 * member by its string name, so a symbol-keyed field cannot be reached from a
 * script, and `alpha` stays the only way in.
 */
const APPLY_ALPHA = Symbol("applyAlpha");

/**
 * Where an object keeps the writer that hands an action to the interpreter.
 *
 * A symbol for the same reason the two above are ones: a script reads members
 * by string name, so this stays out of reach. `move` and `alpha` keep their own
 * copies in a closure inside the constructor; `followPath` is a class method
 * and so needs the writer kept on the object.
 */
const APPLY_REPORT = Symbol("applyReport");

/**
 * The eight points a free transform may take hold of, as a pair of axis signs.
 *
 * `-1` and `1` are the two sides of an axis — left / right and down / up — and
 * `0` means "this axis is not the one being dragged". The names are the ones a
 * script writes, built from `up` / `down` / `left` / `right` the way the
 * corners of a box are named.
 */
const HANDLES = {
  upleft: [-1, 1],
  up: [0, 1],
  upright: [1, 1],
  right: [1, 0],
  downright: [1, -1],
  down: [0, -1],
  downleft: [-1, -1],
  left: [-1, 0],
};



/**
 * The box a free transform works on.
 *
 * A character's box is the rectangle its bitmap occupies, measured in logical
 * pixels; until the bitmap is decoded nothing is known about it, so the frame
 * itself stands in — which is exactly the box the stylesheet draws before any
 * free transform is asked for.
 */
function boxOf(entry) {
  return { w: entry.w ?? STAGE_WIDTH, h: entry.h ?? STAGE_HEIGHT };
}

/**
 * 物体自身坐标里的一个点，落到画面上是哪里。
 *
 * 两条路，按 `rotateH` / `rotateV` 是否为空来分：
 *
 * - 只转过 `rotate`（躺在 W 面里）时是一次平面上的转动再按深度缩放，
 *   与 CSS 的 `rotate()` 完全一致；
 * - 转出 W 面之后，点先被朝向矩阵搬到空间里，再由相机投到画面上 —— 近的
 *   一半变大、远的一半变小，正是透视缩短。
 *
 * @param {object} entry 舞台上的一个对象（带 x/y/z 与三个转角）
 * @param {number} lx 在物体自身坐标里离中心多远（右为正）
 * @param {number} ly 同上（上为正）
 * @param {boolean} [perspective] 舞台是否开着透视；关着时按正交投影算。
 * @returns {{x: number, y: number}} 舞台坐标
 */
function outOfBox(entry, lx, ly, perspective = false) {
  const originX = Number(entry.x) || 0;
  const originY = Number(entry.y) || 0;
  if (isFlatPose(entry)) {
    const radians = ((Number(entry.rotation) || 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return { x: originX + lx * cos + ly * sin, y: originY - lx * sin + ly * cos };
  }
  const { matrix } = orientationOf(entry);
  const depth = clampDepth(entry.z);
  const wx = matrix[0] * lx + matrix[1] * ly + originX;
  const wy = matrix[3] * lx + matrix[4] * ly + originY;
  const wz = matrix[6] * lx + matrix[7] * ly + depth;
  const flat = perspective
    ? CAMERA_DISTANCE / Math.max(1, CAMERA_DISTANCE + wz)
    : 1;
  return { x: wx * flat, y: wy * flat };
}

/**
 * 一个已经在舞台坐标里的点，跟着这个物体的朝向投到画面上。
 *
 * 自由变换之后的八个点是「作者坐标」，它们本身不带朝向；一个转过身的物体
 * 把它们整体当作一块刚体转过去再投影，形状才不会一半在里一半在外。
 */
function projectStagePoint(entry, at, perspective = false) {
  if (isFlatPose(entry)) {
    const flat = depthScale(entry.z, perspective);
    return { x: at.x * flat, y: at.y * flat };
  }
  return outOfBox(
    entry,
    at.x - (Number(entry.x) || 0),
    at.y - (Number(entry.y) || 0),
    perspective,
  );
}

/**
 * 一个三点投影写成 CSS 的 `matrix3d(...)`。
 *
 * 平面图形的透视投影是**投影变换**而不是仿射，`matrix()` 表达不了；`matrix3d`
 * 的第四行就是那次除法，浏览器自己会做。这里按列主序摊开一个 3×3：前两列是
 * 元素自身的两个轴落到哪里，第三列是平移，第三行是透视的除数。
 */
function matrix3dOf(h) {
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = h;
  return `matrix3d(${h00}, ${h10}, 0, ${h20}, ${h01}, ${h11}, 0, ${h21}, 0, 0, 1, 0, ${h02}, ${h12}, 0, ${h22})`;
}

/**
 * 一个物体的 `transform`：躺在 W 面里时是纯转+缩，转出去之后是整次投影。
 *
 * 两种写法给的是同一个结果——前者只是后者的特例，但它沿用了几千行剧本都用
 * 惯的那条路径，也让没写过 `rotateH` / `rotateV` 的画面一个像素都不变。
 *
 * @param {object} entry 舞台上的一个对象。
 * @param {number} units 舞台一个逻辑像素对应多少个元素像素。
 * @returns {{ left: number, top: number, transform: string }}
 *   中心点的位置（百分比）与整条 transform。
 */
function frameOf(entry, units, perspective = false) {
  const pose = projectPose(entry, boxOf(entry), { perspective });
  const left = 50 + ((pose.center.x / STAGE_WIDTH) * 100);
  const top = 50 - ((pose.center.y / STAGE_HEIGHT) * 100);
  if (pose.flat) {
    const flat = pose.center.scale;
    const sx = entry.scaleX ?? 1;
    const sy = entry.scaleY ?? 1;
    const size = (entry.scale ?? 1) * flat;
    const scale =
      sx === 1 && sy === 1
        ? `scale(${size})`
        : `scale(${size * sx}, ${size * sy})`;
    return {
      left,
      top,
      transform: `translate(-50%, -50%) rotate(${entry.rotation}deg) ${scale}`,
    };
  }
  const box = boxOf(entry);
  // 源是这个元素自己的矩形（元素像素、y 向下），目标是投到画面上的四个角。
  const source = CORNERS.map((handle) => {
    const [ax, ay] = HANDLES[handle];
    return { x: (ax * box.w) / 2, y: (-ay * box.h) / 2 };
  });
  const target = CORNERS.map((handle) => {
    const at = pose.corners[handle];
    return { x: at.x - pose.center.x, y: -(at.y - pose.center.y) };
  });
  const matrix = quadHomography(source, target);
  if (!matrix) {
    // 四个角退化成一条线（转到正侧面 90 度）：这一帧没有东西可画。
    return { left, top, transform: "translate(-50%, -50%)" };
  }
  return {
    left,
    top,
    transform: `translate(-50%, -50%) ${matrix3dOf(homographyInPixels(matrix, units))}`,
  };
}

/**
 * The eight points a character is drawn through, in the stage's own
 * coordinates.
 *
 * These are the truth a free transform works on, and the reason the box above
 * is only ever a starting shape: each point is held on its own, so pulling one
 * leaves the other seven exactly where they were. A picture drawn through
 * eight free points is a mesh — a box could only ever grow and shrink about
 * its far side, which is what used to make a slanted edge impossible.
 *
 * The points start as the box's own rectangle whenever the bitmap's size
 * becomes known, which is what keeps a character that was never pulled on
 * drawn exactly as it was. The plain image draws that rectangle through
 * `rotate(...) scale(...)`, so the turn, the uniform scale and the two axes
 * have to be part of the shape too: without them a pull asked for after a
 * `scale()` would start from an unscaled rectangle and snap the picture back
 * to its original size. `outOfBox` turns about the image's centre, which is
 * the point the CSS transform turns about.
 *
 * @param {object} entry A frame with a known `w` and `h`.
 * @returns {Record<string, {x: number, y: number}>}
 */
function pointsOf(entry, perspective = false) {
  const box = boxOf(entry);
  const scale = entry.scale ?? 1;
  const scaleX = entry.scaleX ?? 1;
  const scaleY = entry.scaleY ?? 1;
  const points = {};
  for (const [handle, [ax, ay]] of Object.entries(HANDLES)) {
    points[handle] = outOfBox(
      entry,
      (ax * box.w * scale * scaleX) / 2,
      (ay * box.h * scale * scaleY) / 2,
      perspective,
    );
  }
  return points;
}

/**
 * The eight points that describe what the object is drawing right now.
 *
 * Until the first pull the plain image is the whole of the drawing, and its
 * pose is the only truth there is: `entry.points` is only the rectangle that
 * was settled when the bitmap decoded, and every `move`, `rotate` and `scale`
 * since then has left it behind. Rebuilding the points from the pose is what
 * lets a free transform inherit that state rather than rewind it. Once a
 * point has been pulled the mesh is free-form and its points are the truth.
 *
 * @param {object} entry A frame with a settled box.
 * @returns {Record<string, {x: number, y: number}>}
 */
function currentPoints(entry, perspective = false) {
  return entry.deformed ? entry.points : pointsOf(entry, perspective);
}

// 四个角的名字与顺序（`CORNERS`）定义在 `ui/space.js`：网格、投影与灯光
// 剪影都按同一套顺序走。

/**
 * The middle of the four corners.
 *
 * A turn and a resize both work about this point rather than about the box's
 * centre: once the corners have been pulled apart there is no box left to have
 * a centre, and the corners' average is the shape a pull still leaves intact.
 */
function centroidOf(points) {
  const sum = CORNERS.reduce(
    (total, name) => ({ x: total.x + points[name].x, y: total.y + points[name].y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / CORNERS.length, y: sum.y / CORNERS.length };
}

/** A copy of `points`, every one of them slid by `dx`, `dy`. */
function shiftedPoints(points, dx, dy) {
  const moved = {};
  for (const [handle, at] of Object.entries(points)) {
    moved[handle] = { x: at.x + dx, y: at.y + dy };
  }
  return moved;
}

/**
 * A copy of `points`, every one of them turned `degrees` clockwise about
 * `about`.
 *
 * Clockwise is the language's positive turn, which is why the sine terms carry
 * the signs they do: `y` grows upwards on the stage, the opposite of the way a
 * screen's own axes run.
 */
function turnedPoints(points, about, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const turned = {};
  for (const [handle, at] of Object.entries(points)) {
    const dx = at.x - about.x;
    const dy = at.y - about.y;
    turned[handle] = { x: about.x + dx * cos + dy * sin, y: about.y - dx * sin + dy * cos };
  }
  return turned;
}

/** A copy of `points`, every one of them scaled by `factor` about `about`. */
function scaledPoints(points, about, factor) {
  const scaled = {};
  for (const [handle, at] of Object.entries(points)) {
    scaled[handle] = {
      x: about.x + (at.x - about.x) * factor,
      y: about.y + (at.y - about.y) * factor,
    };
  }
  return scaled;
}

/**
 * The eight points `progress` of the way from one shape to another.
 *
 * Every point is walked along its own straight line, which is what a mesh
 * between two shapes means: each one is drawn between where it is and where it
 * is going, and the triangles between them follow.
 */
function betweenPoints(from, to, progress) {
  const mixed = {};
  for (const [handle, at] of Object.entries(from)) {
    const end = to[handle];
    mixed[handle] = {
      x: at.x + (end.x - at.x) * progress,
      y: at.y + (end.y - at.y) * progress,
    };
  }
  return mixed;
}

/**
 * A copy of `points` with `handle` alone sent to `x`, `y`.
 *
 * The other seven are handed on untouched — that is the whole of what a free
 * transform promises, and what makes an edge's midpoint able to leave the line
 * between its two corners.
 */
function pulledPoints(points, handle, x, y) {
  return { ...points, [handle]: { x, y } };
}

/**
 * Where one of the eight points is now.
 *
 * Before the bitmap has landed there is no shape yet, so the answer is the one
 * the box would put it at. Later it is read from the pose the plain image is
 * drawing — or from the mesh's own points once a pull has happened — so a
 * relative pull starts from where the object actually stands.
 */
function boxPoint(entry, handle, perspective = false) {
  const points = currentPoints(entry, perspective);
  return points ? points[handle] : pointsOf(entry, perspective)[handle];
}

/**
 * Builds the `transform` namespace of a character.
 *
 * Each of the eight points gets two methods, following the language's split
 * between a relative call and an absolute one: `upleft(dx, dy, ms)` moves the
 * point from where it is, `upleftTo(x, y, ms)` puts it at a point of the
 * stage. Both answer the character, so the calls chain — but note that the
 * interpreter hands the *namespace* to a method as `this`, so each one closes
 * over its character instead of reading `this`.
 *
 * @param {object} character The `Character` the namespace belongs to.
 * @param {(started: unknown) => void} report Hands a started action to the
 *   interpreter, which is what makes a timed call something to wait for.
 * @param {{ to: Function, by: Function }} box The stage's two box operations.
 * @returns {Record<string, (x: number, y: number, time?: number) => object>}
 */
function createTransform(character, report, box) {
  const transform = {};
  for (const name of Object.keys(HANDLES)) {
    const kind = "Character";
    transform[name] = (dx, dy, time) => {
      point(kind, dx, dy);
      report(box.by(name, dx, dy, duration(kind, time)));
      return character;
    };
    transform[`${name}To`] = (x, y, time) => {
      point(kind, x, y);
      report(box.to(name, x, y, duration(kind, time)));
      return character;
    };
  }
  return transform;
}

/**
 * Moves a stage object to `x`, `y`, `z` over `time` milliseconds.
 *
 * The object remembers the point whether or not it is on the stage yet, so a
 * script may place something before enabling it; a relative `move` then has
 * something to count from. `object.place` is only called once the object has
 * been enabled, since it is the image on the stage that actually moves.
 *
 * `z` is the stage's depth: 0 is the stage plane, positive goes away from the
 * viewer. `null` (the argument left out) keeps the depth the object already
 * had, which is what a two-coordinate move asked for.
 *
 * @param {object} object A `Background`, `Character` or `Text`.
 * @param {number|null} z Depth, or null to leave it alone.
 * @returns {object} `object`, so calls may be chained.
 */
function placeAt(object, kind, x, y, z, time) {
  const to = point(kind, x, y);
  const ms = duration(kind, time);
  const depth = z === undefined || z === null ? null : clampDepth(z);
  object.px = to.x;
  object.py = to.y;
  if (depth !== null) {
    object.depth = depth;
  }
  if (object.placed) {
    object.place(to.x, to.y, depth, ms);
  }
  return object;
}

/** Moves a stage object by `dx`, `dy`, `dz` from where it already is. */
function shiftBy(object, kind, dx, dy, dz, time) {
  const by = point(kind, dx, dy);
  const depth = dz === undefined || dz === null ? null : object.depth + Number(dz);
  return placeAt(object, kind, object.px + by.x, object.py + by.y, depth, time);
}

/**
 * Turns a stage object to `degrees`, over `time` milliseconds.
 *
 * The object remembers the angle whether or not it is on the stage yet, so a
 * script may set a facing before enabling it; a relative `rotate` then has
 * something to count from. Turning and resizing share one `transform` on the
 * image, so both are written together through `object[APPLY_FRAME]`.
 *
 * @param {object} object A `Background` or `Character`.
 * @returns {object} `object`, so calls may be chained.
 */
function turnTo(object, kind, degrees, time) {
  const to = angle(kind, degrees);
  const ms = duration(kind, time);
  object.rotation = to;
  if (object.placed) {
    object[APPLY_FRAME](object.rotation, object.size, ms);
  }
  return object;
}

/** Turns a stage object by `degrees` from the angle it already holds. */
function turnBy(object, kind, degrees, time) {
  const by = angle(kind, degrees);
  return turnTo(object, kind, object.rotation + by, time);
}

/** 两个「离开 W 面」的转角存在对象上的字段名。 */
const TILT_FIELD = Object.freeze({ H: "angleH", V: "angleV" });

/**
 * 把一个对象沿 H 面（水平面）或 V 面（正立面）的圈转到 `degrees`。
 *
 * 这两个角与 `rotate` 一起构成物体在空间里的朝向（见 `ui/space.js`）：
 * `rotate` 是躺在 W 面里转，这两个是转出 W 面。和其它角度一样不回卷 ——
 * `rotateH(720)` 是两整圈，动画也不会在 360 处跳回来。
 *
 * @param {object} object A `Background`, `Character` or `Text`.
 * @param {"H" | "V"} plane Which circle the object travels along.
 * @returns {object} `object`, so calls may be chained.
 */
function tiltTo(object, kind, plane, degrees, time) {
  const to = angle(kind, degrees);
  const ms = duration(kind, time);
  object[TILT_FIELD[plane]] = to;
  if (object.placed) {
    object[APPLY_FRAME](object.rotation, object.size, ms, {
      [plane === "H" ? "rotateH" : "rotateV"]: to,
    });
  }
  return object;
}

/** 沿某个面的圈再转 `degrees`。 */
function tiltBy(object, kind, plane, degrees, time) {
  const by = angle(kind, degrees);
  return tiltTo(object, kind, plane, object[TILT_FIELD[plane]] + by, time);
}

/**
 * Resizes a stage object to `value`, where 1 is its own size.
 *
 * @param {object} object A `Background` or `Character`.
 * @returns {object} `object`, so calls may be chained.
 */
function resizeTo(object, kind, value, time) {
  const to = factor(kind, value);
  const ms = duration(kind, time);
  object.size = to;
  if (object.placed) {
    object[APPLY_FRAME](object.rotation, object.size, ms);
  }
  return object;
}

/** Resizes a stage object by `value`, relative to the size it already has. */
function resizeBy(object, kind, value, time) {
  const by = factor(kind, value);
  return resizeTo(object, kind, object.size * by, time);
}

/**
 * Sets a stage object's opacity to `value` (0–1), over `time` milliseconds.
 *
 * The object remembers the opacity whether or not it is on the stage yet, the
 * same way it remembers a position, so a script may fade something in before
 * enabling it. Zero is a hidden object rather than a special case: an image at
 * opacity 0 still occupies the stage, which is what a script that fades back in
 * wants, while `hide()` is the one that takes it out of the picture entirely.
 *
 * @param {object} object A `Background` or `Character`.
 * @returns {object} `object`, so calls may be chained.
 */
function fadeTo(object, kind, value, time) {
  const to = opacity(kind, value);
  const ms = duration(kind, time);
  object.opacity = to;
  if (object.placed) {
    object[APPLY_ALPHA](to, ms);
  }
  return object;
}

/**
 * Reads an opacity: a number from 0 to 1, clamped rather than refused.
 *
 * 数值按 0–1 夹取，与 `volume` 一致：`alpha(1.02)` 表示完全不透明，小幅越界不按错误处理。
 */
function opacity(kind, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${kind} 的透明度需要 0–1 的数字`);
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Reads the rim-light strength an object was given: 0–1, clamped like opacity.
 *
 * @param {string} kind Object name, for the message a writer sees.
 * @param {unknown} value
 * @returns {number}
 */
function rimAmount(kind, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${kind} 的轮廓光强度需要 0–1 的数字`);
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Writes an opacity onto an element.
 *
 * A full opacity is written as no inline style at all, which leaves the
 * stylesheet's own value in charge and keeps a faded-out picture's element from
 * carrying a style it does not need.
 */
function paintAlpha(element, value) {
  if (!element?.style) {
    return;
  }
  element.style.opacity = value >= 1 ? "" : String(value);
}

/**
 * The inline styles a picture's frame writes onto its element.
 *
 * A picture is drawn through one element for as long as it is on the stage — a
 * GIF is a `<canvas>` from the moment it arrives (see `pictureFor`), so nothing
 * has to move. The one exception is a GIF whose bytes cannot be decoded: it is
 * handed back to the browser as an `<img>`, which is a different node, and every
 * one of these properties belongs to the picture rather than to the node. They
 * have to be carried across that swap or the picture arrives unposed — and its
 * filters, which live only in this string, disappear entirely.
 */
const PICTURE_STYLES = [
  "visibility",
  "display",
  "left",
  "top",
  "width",
  "height",
  "transform",
  "objectFit",
  "opacity",
  "filter",
  "transition",
];

/**
 * Copies the frame's inline styles from one picture element onto another.
 *
 * Used when a GIF is given back to the browser: the `<canvas>` it was drawn
 * through is swapped for the `<img>` that can play the bytes itself, and the two
 * are different nodes, so anything written onto the old one is otherwise lost
 * and the picture would land unblurred, unfaded and unplaced.
 *
 * @param {HTMLElement} from
 * @param {HTMLElement} to
 */
function copyInheritedStyles(from, to) {
  if (!from?.style || !to?.style) {
    return;
  }
  for (const property of PICTURE_STYLES) {
    const value = from.style[property];
    if (value) {
      to.style[property] = value;
    }
  }
}

/**
 * The element a picture is drawn through: an `<img>`, or the `<canvas>` a GIF is
 * painted onto frame by frame.
 *
 * The canvas has to be chosen here, before the bytes are read, rather than
 * swapped in once they have been decoded. A swap replaces the element an
 * animation was armed on, and the new node arrives carrying nothing but the
 * final `left`/`top`/`transform`/`filter` — so a `move`, a `scale` or a `blur`
 * written next to `enable()`, which is long before the bytes arrive, would land
 * at once instead of running over the time it was given. Picking the right
 * element up front is what keeps those animations running.
 *
 * @param {string} className
 * @param {string} path The asset path, whose extension decides the element.
 * @returns {HTMLElement}
 */
function pictureFor(className, path) {
  const gif = isGifPath(path);
  const element = document.createElement(gif ? "canvas" : "img");
  element.className = className;
  if (!gif) {
    element.alt = "";
  }
  element.draggable = false;
  return element;
}

/**
 * The properties a picture's `transition` may carry, in the order they are
 * written.
 *
 * A move, a turn, a resize and a fade are separate timelines on one element,
 * and CSS keeps one `transition` list for all of them. The order is fixed here
 * rather than left to whichever call came last, so the same state always reads
 * the same way — and so a test can hold the list to what it promises.
 */
const TRANSITION_PROPERTIES = [
  "left", "top", "transform", "width", "height", "opacity", "filter", "color",
];

/**
 * How long each of those properties is currently transitioning, per element.
 *
 * The element's `transition` string cannot be the source of truth: it is
 * rewritten whole by every call, and a rewrite that drops a property still in
 * flight snaps it to its target. Keeping the durations here lets each call
 * change only its own properties and leave the others running.
 */
const transitionTimes = new WeakMap();

/**
 * Writes `patch` into an element's transition, keeping the properties it does
 * not name.
 *
 * A duration of zero removes the property rather than writing `0ms`, which is
 * what makes a jump land at once; an element with nothing left to run is set to
 * `none` rather than to an empty string, because an empty declaration would
 * leave whatever the stylesheet says in charge.
 *
 * @param {HTMLElement | null} element
 * @param {Record<string, number>} patch Milliseconds per property; zero removes.
 * @param {number} [flush] When positive, layout is read between the transition
 *   and the values it should run from and to, so the browser has somewhere to
 *   animate away from. A whole run happens in one tick, and without the read
 *   the browser would meet only the values the call ends on.
 */
function writeTransition(element, patch, flush = 0) {
  if (!element?.style) {
    return;
  }
  const times = { ...(transitionTimes.get(element) ?? {}) };
  for (const [property, time] of Object.entries(patch)) {
    if (time > 0) {
      times[property] = time;
    } else {
      delete times[property];
    }
  }
  transitionTimes.set(element, times);
  const running = TRANSITION_PROPERTIES.filter((property) => times[property] > 0).map(
    (property) => `${property} ${times[property]}ms linear`,
  );
  element.style.transition = running.length ? running.join(", ") : "none";
  if (flush > 0 && running.length) {
    void element.offsetWidth;
  }
}

/**
 * Plays the key frame file `file` on `object`.
 *
 * Shared by `Background.key` and `Character.key` because the two differ only in
 * which entry of the stage they walk: the lookup, the walk, and the values the
 * object keeps afterwards are the same.
 *
 * The file is named by the call; a call that names none (`ch.key()`, which is
 * every script written before the argument existed) falls back to the object's
 * own name — that was the old binding, and keeping it means no old scene breaks.
 *
 * @param {object} object The `Background` or `Character` being animated.
 * @param {"Background" | "Character"} kind For the message when it is missing.
 * @param {unknown} [file] The file the call named, if any.
 * @returns {object} The object, so calls may be chained.
 */
function playKey(object, kind, file) {
  const stage = object.stage;
  const asked = typeof file === "string" ? file.trim() : "";
  // The name a key is filed under is the file's own stem, so `key-ch.keyframes`
  // is object `ch`. An argument that names nothing usable falls back the same
  // way a call with no argument does.
  const id = asked ? keyIdOf(asked) : String(stage.objectNameOf?.(object) ?? "");
  const path = id ? stage.resolvePath?.(id) ?? null : null;
  if (!path) {
    stage.onMissingPath?.(asked || id);
    return object;
  }
  const started =
    kind === "Character"
      ? stage.followCharacterPath?.(object.slot, path)
      : stage.followBackgroundPath?.(path);
  object[APPLY_REPORT](started);
  // The object keeps the journey's end, so a later relative call counts from
  // where the walk finished rather than from where it began — position and the
  // animated properties alike.
  const end = pathEnd(path);
  if (end) {
    object.px = end.x;
    object.py = end.y;
  }
  // The journey's end is written back to the script-facing object only once the
  // walk finishes — not at the moment it starts. While the path runs, `rotation`
  // (and `size`/`opacity`) must keep the value the walk began from, so a `rotate`
  // fired in the same `cue` block counts its degrees from where the path starts,
  // not where it will land. A `rotate` that walked with the path is baked back in
  // too, so the object and the stage agree on the angle afterwards.
  const writeBack = () => {
    const endFrame = frameAt(path, pathDuration(path));
    // `slotOf` and `background` belong to createStage's closure, not here.
    // Ask the stage for the one number the walk needs through its public API.
    const spin = stage.spinOf?.(kind === "Character" ? object.slot : "background") || 0;
    if (endFrame.rotation != null) {
      object.rotation = endFrame.rotation + spin;
    }
    if (endFrame.scale != null) object.size = endFrame.scale;
    if (endFrame.alpha != null) object.opacity = endFrame.alpha;
  };
  if (started && typeof started.then === "function") {
    // A walk that is cut short (the stage was cleared, or the run stopped) is
    // rejected rather than resolved; the pose it reached is not written back,
    // and the rejection is still handled so it cannot surface as unhandled.
    started.then(writeBack).catch(() => {});
  } else {
    writeBack();
  }
  return object;
}

/**
 * The id a key file name carries, read without the `data/` folder.
 *
 * `key-ch.keyframes`, `data/key-ch.keyframes` and the older `key-ch.json` all
 * answer `ch`. A generated file carries its whole stem — `ch-main-pe-1` — so
 * only the legacy names have a prefix to strip. Kept here rather than imported
 * from `path.js` so the stage has no dependency on the editor's file model: it
 * only needs the stem.
 *
 * @param {string} asked
 * @returns {string}
 */
function keyIdOf(asked) {
  const name = String(asked ?? "")
    .replace(/\\/g, "/")
    .slice(String(asked ?? "").replace(/\\/g, "/").lastIndexOf("/") + 1);
  const legacyJson = /^(?:key|path)-([A-Za-z0-9_-]+)\.json$/i.exec(name);
  if (legacyJson) {
    return legacyJson[1];
  }
  const legacyKey = /^key-([A-Za-z0-9_-]+)\.keyframes$/i.exec(name);
  if (legacyKey) {
    return legacyKey[1];
  }
  if (/^key-/i.test(name)) {
    return "";
  }
  return name.replace(/\.(keyframes|json)$/i, "");
}

/**
 * The frame's own pixel size, which is the measure the piece matrices work in.
 *
 * A frame that reports nothing — one built over a document with no layout at
 * all — is taken to be the stage's own size, which leaves the matrices in the
 * same logical pixels as everything else here.
 */
function frameSizeOf(surface) {
  return {
    width: surface.clientWidth || STAGE_WIDTH,
    height: surface.clientHeight || STAGE_HEIGHT,
  };
}

/**
 * Reads the asset path every stage object takes.
 *
 * The path is relative to the project's `assets/` directory; the host resolves
 * it there, so a script writes `"bg.png"` rather than spelling the folder out.
 *
 * An empty path is the empty definition a sprite group needs: `Character()`
 * builds the object and `group(…)` supplies the pictures. Nothing is drawn
 * until one of them arrives, and any other type still gets its picture refused
 * by the call that needs one.
 *
 * @param {string} kind Object name, for the message a writer sees.
 * @param {unknown} path
 * @returns {string}
 */
function imagePath(kind, path) {
  if (path === undefined || path === null) {
    return "";
  }
  if (typeof path !== "string") {
    throw new Error(`${kind} 需要一个图片路径`);
  }
  return path.trim();
}

/** What a character is called until `name` says otherwise. */
const DEFAULT_DISPLAY_NAME = "undefinedName";

/**
 * Reads the text a `name` call sets.
 *
 * Unlike `imagePath`, an empty string is allowed: a writer may want a blank
 * plate, and `say` already knows to hide it.
 */
function displayNameOf(value) {
  if (typeof value !== "string") {
    throw new Error("Character 的名字需要文本");
  }
  return value;
}

/** Reads the text a `say` call displays. */
function lineText(value) {
  if (typeof value !== "string") {
    throw new Error("say 的台词需要文本；数字等值请先用 str(值) 变成文本");
  }
  return value;
}

/**
 * 从 `say` 的尾部实参解析 `time` 与 `audio`：数值为 `time`，字符串为音频文件名。
 * 字符串位置参数解析为音频文件名；角色与旁白的 `say` 不占用独立的 name 位，故不会与该参数混淆。
 *
 * @param {unknown[]} rest 去掉首参（文本）与 name 之后的剩余实参。
 * @param {unknown[]} rest Remaining arguments after the text argument and the name are removed.
 * @returns {{ time: number, audio: string | null }}
 */
function sayTiming(rest) {
  let time = 0;
  let audio = null;
  for (const a of rest) {
    if (typeof a === "number" && Number.isFinite(a)) {
      time = a;
    } else if (typeof a === "string" && a.length > 0) {
      audio = a;
    }
  }
  return { time, audio };
}

/**
 * A constructor's arguments, read by name.
 *
 * The interpreter has already turned `Character("ch.png", x = 300)` into a
 * positional list — that is what `PARAM_SPECS` in `pamela.js` is for — so all
 * this does is pair each slot with its name. A slot that was skipped stays out
 * of the object, which is how "not given" is told apart from "given as 0".
 *
 * @param {string} specKey The constructor's name in `PARAM_SPECS`.
 * @param {unknown[]} args
 * @returns {Record<string, unknown>}
 */
function ctorOptions(specKey, args) {
  const spec = PARAM_SPECS[specKey] ?? [];
  const out = {};
  spec.forEach((name, index) => {
    const value = args[index];
    if (value !== undefined) out[name] = value;
  });
  return out;
}

/** A number a constructor was given, or null when it was not given at all. */
function givenNumber(options, name, kind) {
  const raw = options?.[name];
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${kind} 的 ${name} 需要数字，收到${typeof raw === "string" ? `"${raw}"` : String(raw)}`);
  }
  return value;
}

/**
 * Puts the frame a constructor was asked for onto a fresh object.
 *
 * `x` / `y` place the object outright — the same as `moveTo`, and the only
 * position a constructor needs, since a fresh object starts at the origin.
 * `scale` compounds while `scaleTo` replaces. Everything here only writes the
 * remembered frame — `enable()` is what paints it — so a call that is never
 * enabled changes nothing on the stage, exactly like a `move` before `enable()`.
 *
 * @param {object} target A `Background` or a `Character`.
 * @param {Record<string, unknown>} options From `ctorOptions`.
 * @param {string} kind `"Background"` / `"Character"`, for error messages.
 */
function applyFrameOptions(target, options, kind) {
  const x = givenNumber(options, "x", kind);
  const y = givenNumber(options, "y", kind);
  const depth = givenNumber(options, "z", kind);
  const scale = givenNumber(options, "scale", kind);
  const scaleTo = givenNumber(options, "scaleTo", kind);
  const rotation = givenNumber(options, "rotation", kind);
  const rotateTo = givenNumber(options, "rotateTo", kind);
  const tiltH = givenNumber(options, "rotateH", kind);
  const tiltV = givenNumber(options, "rotateV", kind);
  const alpha = givenNumber(options, "alpha", kind);
  if (x !== null) target.px = x;
  if (y !== null) target.py = y;
  // 深度存在 `depth` 上：字段不能叫 `z`，否则会盖住同名的 `z()` 方法。
  if (depth !== null) target.depth = clampDepth(depth);
  if (scaleTo !== null) target.size = scaleTo;
  if (scale !== null) target.size *= scale;
  if (rotateTo !== null) target.rotation = rotateTo;
  if (rotation !== null) target.rotation += rotation;
  // 两个「转出 W 面」的角：构造时只能给绝对值，相对的那种交给 `rotateH`。
  if (tiltH !== null) target.angleH = tiltH;
  if (tiltV !== null) target.angleV = tiltV;
  if (alpha !== null) target.opacity = Math.min(1, Math.max(0, alpha));
  // The four look filters are the same sliders the methods set, so a picture
  // built with `blur = 3` starts blurred rather than becoming blurred later.
  for (const property of ["blur", "brightness", "contrast", "saturate"]) {
    const value = givenNumber(options, property, kind);
    if (value !== null) target.look = withLook(target.look, property, value, kind);
  }
}

/**
 * A background image the script can enable.
 *
 * The constructor takes the image path; `enable()` puts it on the stage. Every
 * Pamela object follows this shape — build it, then call a method to act.
 */
class Background {
  /**
   * @param {string} path Project-relative image path.
   * @param {object} stage The stage this background draws on.
   * @param {object} [context] The interpreter's context, whose `pending` list
   *   the actions below report into.
   */
  constructor(path, stage, context = {}, options = {}) {
    this.path = imagePath("Background", path);
    this.stage = stage;
    // The backdrop's place, in the stage's own coordinates. The origin is the
    // stage centre, so (0, 0) — the default — fills the frame exactly.
    this.px = 0;
    this.py = 0;
    // 深度：0 是舞台平面，正数往画面深处（更远、更小），负数朝观众。
    // 背景默认在 +1：比角色（默认 0）远一层，一创建就垫在角色后面。
    // 存在 `depth` 而非 `z` 上：字段叫 `z` 会盖住下面同名的 `z()` 方法。
    this.depth = BACKGROUND_DEPTH;
    // The turn and the size, remembered the same way: degrees clockwise from
    // upright, and a multiplier on the image's own size. The size is not called
    // `scale`, which is the name of the method below — a field would hide it
    // from the script.
    this.rotation = 0;
    // 另外两个转角：沿 H 面（水平面）与 V 面（正立面）的圈转，0 是贴在 W 面上。
    this.angleH = 0;
    this.angleV = 0;
    this.size = 1;
    // How opaque the picture is, 0–1. Remembered like the rest, so a fade asked
    // for before `enable()` is applied as soon as there is a picture to fade.
    this.opacity = 1;
    // Whether `enable()` has put this image on the stage yet. A move made
    // before then is remembered and applied by `enable()`.
    this.placed = false;
    // The name a filter error names, and the key the stage looks the picture up
    // by: the backdrop is the one background layer, so its key is fixed.
    this.kind = "Background";
    this.filterTarget = "background";
    // The colour offset the script has built up, in the 0–255 range. It starts
    // at nothing and is what `rgb` adds to and `rgbTo`/`hex` set outright.
    this.tint = { r: 0, g: 0, b: 0 };
    // The look — blur, brightness, contrast, saturation — the script has built
    // up. It starts neutral, which is what makes an untouched picture carry no
    // `filter` declaration at all.
    this.look = neutralLook();
    // What an action starts is handed to the interpreter, which waits for it
    // when the script asks for statements to run one after another. Kept in the
    // closure rather than on the object, so a script cannot reach it.
    const report = (started) => {
      if (started) {
        context.pending?.push(started);
      }
    };
    this.place = (x, y, z, time) => report(stage.moveBackground(x, y, z, time));
    this[APPLY_FRAME] = (rotation, scale, time, pose) =>
      report(stage.transformBackground(rotation, scale, time, pose));
    this[APPLY_ALPHA] = (value, time) => report(stage.setBackgroundAlpha(value, time));
    this[APPLY_REPORT] = report;
    /**
     * 逐帧图片组：一组图、一个速度。每换一张都走 `setBackground`，所以位置、
     * 透明度、调色与滤镜都留在同一块背景上，不会因为换图而重来。
     *
     * 播放器建在对象上、登记到舞台上：重建变量时舞台会先停掉旧的那个，
     * 清理舞台时也一样，不会有计时器在画面之外继续推进。
     */
    this.sprite = createSpritePlayer({
      kind: "Background",
      show: (path) => {
        this.path = path;
        if (this.placed) {
          stage.setBackground(path);
        }
      },
    });
    stage.registerSprite?.("Background", "background", this.sprite);
    // The place, size, turn and look the box asked for when it was built:
    // `Background("room.png", x = 40, scaleTo = 1.2)`.
    applyFrameOptions(this, options, "Background");
  }

  /** Shows this image on the stage, behind any character. */
  enable() {
    // 换一张静图意味着不再逐帧播放：`group` 停在当前这张，播放到此为止。
    this.sprite.stop();
    // 空定义（`Background()`）也要占住这一层：`setBackground("")` 会把画面
    // 清空，而随后 `group` 给的第一张就落在同一块背景上。
    this.stage.setBackground(this.path);
    // A tint asked for before the image is on the stage is remembered on the
    // object and replayed now that there is a picture to paint it onto.
    this.stage.applyTint(this.filterTarget, this.tint.r, this.tint.g, this.tint.b, 0);
    // The same for the look: a blur asked for before the picture is up lands on
    // it the moment there is one to paint.
    this.stage.applyLook(this.filterTarget, this.look, 0);
    this.placed = true;
    // 位置与深度一起交出去：`enable()` 之前写下的 z（或者背景默认的 −1）不会
    // 被这里改成舞台平面。
    this.place(this.px, this.py, this.depth);
    // 两个转角要一起交出去：`enable()` 之前写下的姿态（构造参数或重建变量
    // 继承来的）才会落到舞台上，而不是等下一次转身才生效。
    this[APPLY_FRAME](this.rotation, this.size, 0, {
      rotateH: this.angleH,
      rotateV: this.angleV,
    });
    this[APPLY_ALPHA](this.opacity, 0);
    return this;
  }

  /**
   * Fades the backdrop in or out to `value`, over `time` milliseconds.
   *
   * 0 is invisible, 1 is solid. Out-of-range values are clamped rather than
   * refused, the way a volume is.
   *
   * @param {number} value Opacity from 0 to 1.
   * @param {number} [time] Milliseconds the fade takes; omitted is at once.
   */
  alpha(value, time) {
    return fadeTo(this, "Background", value, time);
  }

  /** Fades the backdrop out and takes it off the stage, over `time` ms. */
  hide(time) {
    return this.alpha(0, time);
  }

  /** Fades the backdrop back in, over `time` milliseconds. */
  show(time) {
    return this.alpha(1, time);
  }

  /**
   * Steps the backdrop's GIF.
   *
   * With a positive frame number the GIF freezes on that frame (1-based) and
   * stops; with `0`, no argument or any non-positive value it resumes from the
   * frame it was last showing. A non-GIF backdrop ignores the call.
   *
   * @param {number} [frame]
   */
  step(frame) {
    this.stage.stepGif("background", frame);
    return this;
  }

  /**
   * Replaces the backdrop with `path`, dissolving over `time` milliseconds.
   *
   * A hard cut is what `Background(path).enable()` does; a dissolve needs both
   * pictures on the stage at once, one fading out under the other. The outgoing
   * picture is left where it was — a dissolve is not a move — and it is dropped
   * when the fade is over rather than kept underneath.
   *
   * The object keeps drawing the new picture: `path` is updated, so a later
   * `enable()` re-shows what is on screen rather than the old one.
   */
  crossFade(path, time = 0) {
    // 一张新图顶替逐帧动画：播放停在这一张上，不再回到组里。
    this.sprite.stop();
    this.path = imagePath("Background", path);
    this.stage.crossFadeBackground(this.path, duration("Background", time));
    this.placed = true;
    this[APPLY_ALPHA](this.opacity, 0);
    return this;
  }

  /**
   * 把一组图片交给这个背景，作为逐帧动画的帧。
   *
   * 组是背景自己的一份列表：`group("a.png", "b.png")` 之后画面停在第 1 张，
   * 用 `fps` 才会按速度往下走。空着调用会清掉整组并停住播放，正在显示的那张
   * 图仍然留在画面上。
   *
   * @param {...string} paths 图片路径，按播放顺序。
   */
  group(...paths) {
    this.sprite.setGroup(paths);
    return this;
  }

  /**
   * 以每秒 `value` 张的速度播放这组图，1–144，默认只播一遍。
   *
   * 播放会阻塞流程：一遍播完才继续下一句。第二个参数写 `true` 就是循环播放，
   * 这时流程会一直等下去，要用 `cue { … }` 和 `pause` 从旁停下。再次调用时从
   * 当前这张接着播，而不是从头开始。
   *
   * @param {number} value 每秒张数，1–144。
   * @param {boolean} [loop] 是否循环。
   */
  fps(value, loop) {
    this[APPLY_REPORT](this.sprite.play(value, loop));
    return this;
  }

  /**
   * 取组里一张图的路径：`element(0)` 或 `element("ch2.png")`。
   *
   * 序号从 0 起；答案就是当初写进组里的那个路径，可以直接交给 `Background`。
   *
   * @param {number | string} index 0 起的序号或图片名。
   * @returns {string}
   */
  element(index) {
    return this.sprite.element(index);
  }

  /**
   * 暂停播放，停在当前这张。
   *
   * 给序号或组内图片名就停在那一张；给一个组外的路径也会显示它，但组本身
   * 不变，之后再 `fps` 仍然播组里的图。
   *
   * @param {number | string} [value]
   */
  pause(value) {
    this.sprite.pause(value);
    return this;
  }

  /**
   * 在组内某张图之后插入一张新图。
   *
   * @param {number | string} index 插入位置的序号或图片名。
   * @param {string} path 新图。
   */
  add(index, path) {
    this.sprite.add(index, path);
    return this;
  }

  /**
   * 从组里移除某一张图；正在显示的那张仍留在画面上。
   *
   * @param {number | string} index 序号或图片名。
   */
  remove(index) {
    this.sprite.remove(index);
    return this;
  }

  /**
   * 把组里某一张换成另一张，位置不变；换的正是当前这张时画面立即跟着换。
   *
   * @param {number | string} index 旧图的序号或图片名。
   * @param {string} path 新图。
   */
  update(index, path) {
    this.sprite.update(index, path);
    return this;
  }

  /**
   * Moves the backdrop to `x`, `y`, `z`, measured from the stage centre.
   *
   * @param {number} x Distance right of the centre; negative goes left.
   * @param {number} y Distance above the centre; negative goes down.
   * @param {number} [z] Depth: 0 is the stage plane, positive goes away.
   *   Left out, the backdrop keeps the depth it already had.
   * @param {number} [time] Milliseconds the move takes; omitted is at once.
   */
  moveTo(x, y, z, time) {
    return placeAt(this, "Background", x, y, z, time);
  }

  /**
   * Moves the backdrop by `dx`, `dy`, `dz` from where it already is.
   *
   * @param {number} dx Distance right when positive.
   * @param {number} dy Distance up when positive.
   * @param {number} [dz] Depth to add; left out, the depth stays.
   * @param {number} [time] Milliseconds the move takes; omitted is at once.
   */
  move(dx, dy, dz, time) {
    return shiftBy(this, "Background", dx, dy, dz, time);
  }

  /**
   * 沿 x 轴相对移动这张背景：正数向右、负数向左。
   *
   * @param {number} dx 向右的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  x(dx, time) {
    return this.move(dx, 0, undefined, time);
  }

  /**
   * 沿 y 轴相对移动这张背景：正数向上、负数向下。
   *
   * @param {number} dy 向上的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  y(dy, time) {
    return this.move(0, dy, undefined, time);
  }

  /**
   * 沿 z 轴（深度）相对移动这张背景：正数往画面深处（更远、更小），负数朝观众。
   *
   * 与 `zTo` 的区别同 `move` / `moveTo`：`z` 是累加，每次再往深处推一点。
   *
   * @param {number} dz 深度增量；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  z(dz, time) {
    return this.move(0, 0, dz, time);
  }

  /**
   * 把这张背景的绝对 x 坐标设成 `x`：原点在舞台中心，正数向右。
   *
   * y 与深度保持不变。
   *
   * @param {number} x 横向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  xTo(x, time) {
    return this.moveTo(x, this.py, undefined, time);
  }

  /**
   * 把这张背景的绝对 y 坐标设成 `y`：原点在舞台中心，正数向上。
   *
   * x 与深度保持不变。
   *
   * @param {number} y 纵向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  yTo(y, time) {
    return this.moveTo(this.px, y, undefined, time);
  }

  /**
   * 把这张背景放到绝对深度 `value`：0 是舞台平面，正数往画面深处（更远、更小）。
   *
   * 这是 `z` 从「绝对」改名后的绝对写法；原来的 `hero.z(200)` 深度脚本请改用
   * `hero.zTo(200)`。x 与 y 保持不变。
   *
   * @param {number} value 深度，负数朝观众。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  zTo(value, time) {
    return this.moveTo(this.px, this.py, value, time);
  }

  /**
   * 沿 H（平轴，即 x）相对移动这张背景：与 `x` 同一个调用。
   *
   * H / V / D 是内部统一的三轴叫法：Horizontal（平）、Vertical（升）、
   * Depth（推）。`h` / `v` / `z` 与 `x` / `y` / `z` 完全等价。
   */
  h(dh, time) {
    return this.move(dh, 0, undefined, time);
  }

  /** 沿 V（升轴，即 y）相对移动这张背景：与 `y` 同一个调用。 */
  v(dv, time) {
    return this.move(0, dv, undefined, time);
  }

  /** 把这张背景的绝对 H（即 x）坐标设成 `h`。 */
  hTo(h, time) {
    return this.moveTo(h, this.py, undefined, time);
  }

  /** 把这张背景的绝对 V（即 y）坐标设成 `v`。 */
  vTo(v, time) {
    return this.moveTo(this.px, v, undefined, time);
  }

  /**
   * Plays the key frames in `file`.
   *
   * A key names the file it plays — `ch.key("key-ch.keyframes")` — because that
   * is what the author sees in the tree and what the editor writes when the
   * animation is saved. The file's name is the object's own name by default,
   * so the older `ch.key()` with no argument still works: it is read as "the
   * key filed under this object".
   *
   * The animation starts where the object already stands, so there is never a
   * question of whether it teleports to the first frame or walks there.
   *
   * A key that has not been authored is reported and the call does nothing, so
   * a scene with a missing key still plays.
   *
   * @param {string} [file] The key frame file to play.
   * @returns {object} The backdrop, so calls may be chained.
   */
  key(file) {
    return playKey(this, "Background", file);
  }

  /**
   * Turns the backdrop to `degrees`, measured clockwise from upright.
   *
   * @param {number} degrees Any angle: it is not wrapped into 0–360, so 720
   *   is two whole turns and a negative angle turns the other way.
   * @param {number} [time] Milliseconds the turn takes; omitted is at once.
   */
  rotateTo(degrees, time) {
    return turnTo(this, "Background", degrees, time);
  }

  /**
   * Turns the backdrop by `degrees` from the angle it already holds.
   *
   * @param {number} degrees Degrees to turn clockwise; negative turns back.
   * @param {number} [time] Milliseconds the turn takes; omitted is at once.
   */
  rotate(degrees, time) {
    return turnBy(this, "Background", degrees, time);
  }

  /**
   * 沿 H 面（水平面）的蓝圈把这张图转出画面 `degrees` 度。
   *
   * 转轴是升轴（y）：图转向观众的右边，它的左侧因此朝观众转过来，画面左右
   * 方向被透视压短。0 是贴在 W 面上、正对观众，90 是转到正侧面（只剩一条线）。
   *
   * @param {number} degrees 度数，正值转向观众的右边；不回卷。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  rotateH(degrees, time) {
    return tiltBy(this, "Background", "H", degrees, time);
  }

  /**
   * 沿 V 面（正立面）的绿圈把这张图抬落 `degrees` 度。
   *
   * 转轴是平轴（x）：图的顶边朝观众倒下来或向后仰。0 是正对观众，90 是
   * 平躺下来。
   *
   * @param {number} degrees 度数，正值让顶边朝观众倒；不回卷。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  rotateV(degrees, time) {
    return tiltBy(this, "Background", "V", degrees, time);
  }

  /** 把 H 面的转角直接设成 `degrees`（不是累加）。 */
  rotateHTo(degrees, time) {
    return tiltTo(this, "Background", "H", degrees, time);
  }

  /** 把 V 面的转角直接设成 `degrees`（不是累加）。 */
  rotateVTo(degrees, time) {
    return tiltTo(this, "Background", "V", degrees, time);
  }

  /**
   * Resizes the backdrop to `value`, where 1 is its own size.
   *
   * @param {number} value A positive multiplier: 0.5 is half, 2 is double.
   * @param {number} [time] Milliseconds the resize takes; omitted is at once.
   */
  scaleTo(value, time) {
    return resizeTo(this, "Background", value, time);
  }

  /**
   * Resizes the backdrop by `value`, relative to the size it already has.
   *
   * @param {number} value A positive multiplier; the sizes compound, so two
   *   calls of `scale(2)` leave the image at four times its own size.
   * @param {number} [time] Milliseconds the resize takes; omitted is at once.
   */
  scale(value, time) {
    return resizeBy(this, "Background", value, time);
  }

  /**
   * Tints the backdrop by a relative offset, over `time` milliseconds.
   *
   * Each channel is added to the offset already there and clamped at 255, so a
   * red of `254` plus an offset of `10` only reaches `255` — the part that would
   * spill past the top is dropped. Returns the backdrop so calls chain.
   */
  rgb(dr, dg, db, time) {
    const next = addTint(
      this.tint,
      tintChannel(this.kind, dr, "红"),
      tintChannel(this.kind, dg, "绿"),
      tintChannel(this.kind, db, "蓝"),
    );
    return this.applyTintValues(next.r, next.g, next.b, time);
  }

  /**
   * Tints the backdrop to an absolute offset, over `time` milliseconds.
   *
   * Unlike `rgb`, each channel is the offset itself rather than added to the
   * current one, so it overrides whatever tint was there. Returns the backdrop.
   */
  rgbTo(r, g, b, time) {
    return this.applyTintValues(
      clampChannel(tintChannel(this.kind, r, "红")),
      clampChannel(tintChannel(this.kind, g, "绿")),
      clampChannel(tintChannel(this.kind, b, "蓝")),
      time,
    );
  }

  /**
   * Tints the backdrop to a hex colour, over `time` milliseconds.
   *
   * The string is read case-insensitively (`FFFFFF` and `ffffff` are the same),
   * so a writer may paste a colour from anywhere. Returns the backdrop.
   */
  hex(hex, time) {
    const { r, g, b } = parseHex(hex);
    return this.applyTintValues(r, g, b, time);
  }

  /**
   * Remembers a tint and asks the stage to paint it, returning the backdrop so
   * calls chain — the shared body of `rgb`, `rgbTo` and `hex`.
   */
  applyTintValues(r, g, b, time) {
    this.tint = { r, g, b };
    this.stage.applyTint(this.filterTarget, r, g, b, duration(this.kind, time));
    return this;
  }

  /**
   * Softens the backdrop with a blur of `value` pixels, over `time`.
   *
   * Zero is sharp, which is where every picture starts. The value is clamped at
   * 100 rather than refused, the way opacity is: a script that overshoots means
   * "as blurred as it goes".
   *
   * @param {number} value Blur radius in stage pixels.
   * @param {number} [time] Milliseconds the change takes; omitted is at once.
   */
  blur(value, time) {
    return this.applyLookValues("blur", value, time);
  }

  /** Brightens (`>1`) or darkens (`<1`) the backdrop, over `time`. */
  brightness(value, time) {
    return this.applyLookValues("brightness", value, time);
  }

  /** Raises (`>1`) or lowers (`<1`) the backdrop's contrast, over `time`. */
  contrast(value, time) {
    return this.applyLookValues("contrast", value, time);
  }

  /** Saturates (`>1`) or greys out (`0`) the backdrop, over `time`. */
  saturate(value, time) {
    return this.applyLookValues("saturate", value, time);
  }

  /**
   * Remembers one look property and asks the stage to paint it, returning the
   * backdrop so calls chain — the shared body of the four filter calls.
   *
   * One property is set and the rest keep their values, so `bg.saturate(0)`
   * after `bg.blur(4)` leaves the blur on: the four are sliders on one picture,
   * not four filters that replace each other.
   */
  applyLookValues(property, value, time) {
    this.look = withLook(this.look, property, value, this.kind);
    this.stage.applyLook(this.filterTarget, this.look, duration(this.kind, time));
    return this;
  }
}

/**
 * Numbers characters the script never assigned to a name.
 *
 * The count belongs to the run rather than to this module: the same script
 * performed twice (or performed again after being interrupted) has to number
 * the same character the same way, and a module-wide counter would not. Keeping
 * it on the interpreter's `context` gives each run a count of its own, so one
 * run can never shift the slots another run occupies.
 */
function nextCharacterNumber(context) {
  context.characterSeq = (context.characterSeq ?? 0) + 1;
  return context.characterSeq;
}

/**
 * A character the script can enable.
 *
 * The same shape as `Background`, but it draws on the layer above it, so a
 * character is always visible over the backdrop it was given. Unlike a
 * background, several characters may share the stage at once.
 */
class Character {
  /**
   * @param {string} path Project-relative image path.
   * @param {object} stage The stage this character draws on.
   * @param {object} [context] The interpreter's context, carrying `assignee`
   *   and the `pending` list the actions below report into.
   */
  constructor(path, stage, context = {}, options = {}) {
    this.path = imagePath("Character", path);
    this.stage = stage;
    // The slot the character draws in. Naming it after the variable it was
    // assigned to is what makes rebuilding that variable replace the old
    // character; an unassigned call gets its own slot and adds a new one.
    this.slot = context.assignee ?? `character-${nextCharacterNumber(context)}`;
    // What the slot was already drawing, so a rebuilt variable carries on from
    // there instead of starting over. A slot nothing has been put in answers
    // the defaults, which is the same state a brand-new character is in.
    const inherited = stage.characterState?.(this.slot) ?? null;
    // The character's place, in the stage's own coordinates. The origin is the
    // stage centre, so (0, 0) — the default — centres the character.
    this.px = inherited?.x ?? 0;
    this.py = inherited?.y ?? 0;
    // 深度：0 是舞台平面，正数往画面深处（更远、更小），负数朝观众。
    this.depth = inherited?.depth ?? 0;
    // The turn and the size, remembered the same way: degrees clockwise from
    // upright, and a multiplier on the image's own size. The size is not called
    // `scale`, which is the name of the method below — a field would hide it
    // from the script.
    this.rotation = inherited?.rotation ?? 0;
    // 另外两个转角：沿 H 面（水平面）与 V 面（正立面）的圈转，0 是贴在 W 面上。
    // 换一张表情不该把角色转回正面，所以它们跟着 `inherited` 走。
    this.angleH = inherited?.angleH ?? 0;
    this.angleV = inherited?.angleV ?? 0;
    this.size = inherited?.size ?? 1;
    // How opaque the picture is, 0–1; remembered across a rebuild like the rest
    // of the frame, so changing an expression does not make a faded-out
    // character reappear.
    this.opacity = inherited?.opacity ?? 1;
    // Whether `enable()` has put this character on the stage yet. A move made
    // before then is remembered and applied by `enable()`.
    this.placed = false;
    // The name a filter error names, and the key the stage looks the picture up
    // by: a character draws in the slot it was given.
    this.kind = "Character";
    this.filterTarget = this.slot;
    // The colour offset the script has built up, in the 0–255 range, shared with
    // `Background`'s three calls.
    this.tint = inherited?.tint ? { ...inherited.tint } : { r: 0, g: 0, b: 0 };
    // The look the slot already has, so changing an expression keeps a blur or
    // a greyed-out filter the way it keeps the place and the opacity.
    this.look = inherited?.look ? { ...neutralLook(), ...inherited.look } : neutralLook();
    // What an action starts is handed to the interpreter, which waits for it
    // when the script asks for statements to run one after another. Kept in the
    // closure rather than on the object, so a script cannot reach it.
    const report = (started) => {
      if (started) {
        context.pending?.push(started);
      }
    };
    this.place = (x, y, z, time) => report(stage.moveCharacter(this.slot, x, y, z, time));
    this[APPLY_FRAME] = (rotation, scale, time, pose) =>
      report(stage.transformCharacter(this.slot, rotation, scale, time, pose));
    this[APPLY_ALPHA] = (value, time) => report(stage.setCharacterAlpha(this.slot, value, time));
    this[APPLY_REPORT] = report;
    // The free transform: eight points of the picture's own box, each with a
    // relative and an absolute call. Taking one moves that side of the box and
    // leaves the far side where it is.
    this.transform = createTransform(this, report, {
      to: (handle, x, y, time) => stage.transformCharacterPoint(this.slot, handle, x, y, time),
      by: (handle, dx, dy, time) => stage.moveCharacterPoint(this.slot, handle, dx, dy, time),
    });
    // The name the dialogue box shows. It lives in the closure rather than on
    // the object for the same reason `report` does: the interpreter reads a
    // member with a plain `object[name]`, so a field here would be reachable
    // from the script — and a field named `name` would hide `name()` itself.
    let displayName = inherited?.name ?? DEFAULT_DISPLAY_NAME;
    /**
     * Sets the name the box shows for this character.
     *
     * A setter, not a reader: a character is called `undefinedName` until a
     * script says otherwise, and a script has no reason to ask for it back.
     * The name is kept on the slot as well as here, so the next rebuild of the
     * same variable still speaks under it.
     */
    this.name = (value) => {
      displayName = displayNameOf(value);
      stage.rememberCharacterName?.(this.slot, displayName);
      return this;
    };
    /**
     * Shows a line of dialogue as this character.
     *
     * What this reports is what blocks the script until the player clicks, so
     * a line is never skipped over.
     *
     * The trailing arguments are read by type, not by position past the text:
     * a number is how long the line may take (`time`, ms) and a string names a
     * voice track (`audio`). A character's `say` has no name slot of its own —
     * the character *is* the name — so neither can be mistaken for one.
     */
    this.say = (value, ...rest) => {
      report(stage.sayLine(displayName, lineText(value), sayTiming(rest)));
      return this;
    };
    /**
     * 逐帧图片组：一组立绘、一个速度。每换一张都走 `setCharacter`，所以这个
     * 槽位的位置、透明度、滤镜与自由变形都留在同一张图上。
     *
     * 播放器登记在舞台上：同一个槽位被重建（换了变量）时，旧的计时器先停，
     * 不会有两个播放器同时往一个槽位里塞图。
     */
    this.sprite = createSpritePlayer({
      kind: "Character",
      show: (path) => {
        this.path = path;
        if (this.placed) {
          stage.setCharacter(this.slot, path);
        }
      },
    });
    stage.registerSprite?.("Character", this.slot, this.sprite);
    // The place, size, turn, opacity and look the call itself asked for:
    // `Character("ch.png", x = 300, y = -500, scaleTo = 2)`.
    applyFrameOptions(this, options, "Character");
    // A name given at construction is the same as `.name("…")` right after it,
    // so a character can speak under its name from its very first line.
    if (options?.name !== undefined) {
      this.name(options.name);
    }
  }

  /** Shows this image on the stage, over the background. */
  enable() {
    // 换一张静图意味着不再逐帧播放：`group` 停在当前这张，播放到此为止。
    this.sprite.stop();
    // 空定义（`Character()`）也要占住槽位：`setCharacter(slot, "")` 建一个空
    // 槽位而不画图，位置、透明度与滤镜先落在上面，等 `group` 的第一张图来用。
    this.stage.setCharacter(this.slot, this.path);
    // A tint asked for before the image is on the stage is remembered on the
    // object and replayed now that there is a picture to paint it onto.
    this.stage.applyTint(this.filterTarget, this.tint.r, this.tint.g, this.tint.b, 0);
    // The same for the look: a blur asked for before the picture is up lands on
    // it the moment there is one to paint.
    this.stage.applyLook(this.filterTarget, this.look, 0);
    this.placed = true;
    // 位置与深度一起交出去：`enable()` 之前写下的 z 不会被这里改成舞台平面。
    this.place(this.px, this.py, this.depth);
    // 两个转角要一起交出去：`enable()` 之前写下的姿态（构造参数或重建变量
    // 继承来的）才会落到舞台上，而不是等下一次转身才生效。
    this[APPLY_FRAME](this.rotation, this.size, 0, {
      rotateH: this.angleH,
      rotateV: this.angleV,
    });
    this[APPLY_ALPHA](this.opacity, 0);
    return this;
  }

  /**
   * Fades the character in or out to `value`, over `time` milliseconds.
   *
   * 0 is invisible, 1 is solid; out-of-range values are clamped. A faded-out
   * character still occupies its slot, so a fade back in is the same object.
   *
   * @param {number} value Opacity from 0 to 1.
   * @param {number} [time] Milliseconds the fade takes; omitted is at once.
   */
  alpha(value, time) {
    return fadeTo(this, "Character", value, time);
  }

  /**
   * Fades the character out, over `time` milliseconds.
   *
   * The picture is not removed — it is at opacity 0 — so `show()` brings the
   * same character back at the same place. `enable()` with another picture is
   * what replaces it outright.
   */
  hide(time) {
    return this.alpha(0, time);
  }

  /** Fades the character back in, over `time` milliseconds. */
  show(time) {
    return this.alpha(1, time);
  }

  /**
   * Steps this character's GIF.
   *
   * With a positive frame number the GIF freezes on that frame (1-based) and
   * stops; with `0`, no argument or any non-positive value it resumes from the
   * frame it was last showing. A non-GIF character ignores the call.
   *
   * @param {number} [frame]
   */
  step(frame) {
    this.stage.stepGif(this.slot, frame);
    return this;
  }

  /**
   * 把一组立绘交给这个角色，作为逐帧动画的帧。
   *
   * 组是角色自己的一份列表：`group("ch1.png", "ch2.png")` 之后画面停在第 1 张，
   * 用 `fps` 才会按速度往下走。空着调用会清掉整组并停住播放，正在显示的那张
   * 图仍然留在画面上。
   *
   * @param {...string} paths 图片路径，按播放顺序。
   */
  group(...paths) {
    this.sprite.setGroup(paths);
    return this;
  }

  /**
   * 以每秒 `value` 张的速度播放这组图，1–144，默认只播一遍。
   *
   * 播放会阻塞流程：一遍播完才继续下一句。第二个参数写 `true` 就是循环播放，
   * 这时流程会一直等下去，要用 `cue { … }` 和 `pause` 从旁停下。再次调用时从
   * 当前这张接着播，而不是从头开始。
   *
   * @param {number} value 每秒张数，1–144。
   * @param {boolean} [loop] 是否循环。
   */
  fps(value, loop) {
    this[APPLY_REPORT](this.sprite.play(value, loop));
    return this;
  }

  /**
   * 取组里一张图的路径：`element(0)` 或 `element("ch2.png")`。
   *
   * 序号从 0 起；答案就是当初写进组里的那个路径，可以直接交给 `Character`。
   *
   * @param {number | string} index 0 起的序号或图片名。
   * @returns {string}
   */
  element(index) {
    return this.sprite.element(index);
  }

  /**
   * 暂停播放，停在当前这张。
   *
   * 给序号或组内图片名就停在那一张；给一个组外的路径也会显示它，但组本身
   * 不变，之后再 `fps` 仍然播组里的图。
   *
   * @param {number | string} [value]
   */
  pause(value) {
    this.sprite.pause(value);
    return this;
  }

  /**
   * 在组内某张图之后插入一张新图。
   *
   * @param {number | string} index 插入位置的序号或图片名。
   * @param {string} path 新图。
   */
  add(index, path) {
    this.sprite.add(index, path);
    return this;
  }

  /**
   * 从组里移除某一张图；正在显示的那张仍留在画面上。
   *
   * @param {number | string} index 序号或图片名。
   */
  remove(index) {
    this.sprite.remove(index);
    return this;
  }

  /**
   * 把组里某一张换成另一张，位置不变；换的正是当前这张时画面立即跟着换。
   *
   * @param {number | string} index 旧图的序号或图片名。
   * @param {string} path 新图。
   */
  update(index, path) {
    this.sprite.update(index, path);
    return this;
  }

  /**
   * Draws the character over the others on the stage.
   *
   * Characters are drawn in the order they were enabled, which is the order a
   * script writes them in — but a scene often wants the speaker brought
   * forward. This moves the character's own elements to the end of the layer,
   * which is the last thing painted. It is a jump rather than a fade: a
   * reordering has no duration.
   */
  front() {
    this.stage.raiseCharacter(this.slot);
    return this;
  }

  /** Draws the character under the others on the stage. */
  back() {
    this.stage.lowerCharacter(this.slot);
    return this;
  }

  /**
   * Moves the character to `x`, `y`, `z`, measured from the stage centre.
   *
   * @param {number} x Distance right of the centre; negative goes left.
   * @param {number} y Distance above the centre; negative goes down.
   * @param {number} [z] Depth: 0 is the stage plane, positive goes away.
   *   Left out, the character keeps the depth it already had.
   * @param {number} [time] Milliseconds the move takes; omitted is at once.
   */
  moveTo(x, y, z, time) {
    return placeAt(this, "Character", x, y, z, time);
  }

  /**
   * Moves the character by `dx`, `dy`, `dz` from where it already is.
   *
   * @param {number} dx Distance right when positive.
   * @param {number} dy Distance up when positive.
   * @param {number} [dz] Depth to add; left out, the depth stays.
   * @param {number} [time] Milliseconds the move takes; omitted is at once.
   */
  move(dx, dy, dz, time) {
    return shiftBy(this, "Character", dx, dy, dz, time);
  }

  /**
   * 沿 x 轴相对移动这个角色：正数向右、负数向左。
   *
   * @param {number} dx 向右的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  x(dx, time) {
    return this.move(dx, 0, undefined, time);
  }

  /**
   * 沿 y 轴相对移动这个角色：正数向上、负数向下。
   *
   * @param {number} dy 向上的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  y(dy, time) {
    return this.move(0, dy, undefined, time);
  }

  /**
   * 沿 z 轴（深度）相对移动这个角色：正数往画面深处（更远、更小），负数朝观众。
   *
   * 与 `zTo` 的区别同 `move` / `moveTo`：`z` 是累加。深度变化时角色层的先后会
   * 按「远的先画」重排，与原来 `z` 的行为一致。
   *
   * @param {number} dz 深度增量；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  z(dz, time) {
    return this.move(0, 0, dz, time);
  }

  /**
   * 把这个角色的绝对 x 坐标设成 `x`：原点在舞台中心，正数向右。
   *
   * y 与深度保持不变。
   *
   * @param {number} x 横向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  xTo(x, time) {
    return this.moveTo(x, this.py, undefined, time);
  }

  /**
   * 把这个角色的绝对 y 坐标设成 `y`：原点在舞台中心，正数向上。
   *
   * x 与深度保持不变。
   *
   * @param {number} y 纵向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  yTo(y, time) {
    return this.moveTo(this.px, y, undefined, time);
  }

  /**
   * 把这个角色放到绝对深度 `value`：0 是舞台平面，正数往画面深处（更远、更小）。
   *
   * 这是 `z` 从「绝对」改名后的绝对写法；原来的 `hero.z(200)` 深度脚本请改用
   * `hero.zTo(200)`。x 与 y 保持不变。
   *
   * @param {number} value 深度，负数朝观众。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  zTo(value, time) {
    return this.moveTo(this.px, this.py, value, time);
  }

  /**
   * 沿 H（平轴，即 x）相对移动这个角色：与 `x` 同一个调用。
   *
   * H / V / D 是内部统一的三轴叫法：Horizontal（平）、Vertical（升）、
   * Depth（推）。`h` / `v` / `z` 与 `x` / `y` / `z` 完全等价。
   */
  h(dh, time) {
    return this.move(dh, 0, undefined, time);
  }

  /** 沿 V（升轴，即 y）相对移动这个角色：与 `y` 同一个调用。 */
  v(dv, time) {
    return this.move(0, dv, undefined, time);
  }

  /** 把这个角色的绝对 H（即 x）坐标设成 `h`。 */
  hTo(h, time) {
    return this.moveTo(h, this.py, undefined, time);
  }

  /** 把这个角色的绝对 V（即 y）坐标设成 `v`。 */
  vTo(v, time) {
    return this.moveTo(this.px, v, undefined, time);
  }

  /**
   * Walks the character along the key frames in `file`.
   *
   * The file is named by the call — `ch.key("key-ch.keyframes")` — and the host
   * reads it and hands the stage the path, so a script only ever names a file
   * and never carries its points. A call with no argument falls back to the
   * object's own name, which is how every script written before the argument
   * existed still plays. A file that is missing or unreadable answers `null` at
   * the host, which reports it; the call then does nothing rather than failing
   * the run, so one bad key does not stop the scene.
   *
   * @param {string} [file] The key frame file to walk.
   * @returns {object} The character, so calls may be chained.
   */
  key(file) {
    return playKey(this, "Character", file);
  }

  /**
   * Turns the character to `degrees`, measured clockwise from upright.
   *
   * @param {number} degrees Any angle: it is not wrapped into 0–360, so 720
   *   is two whole turns and a negative angle turns the other way.
   * @param {number} [time] Milliseconds the turn takes; omitted is at once.
   */
  rotateTo(degrees, time) {
    return turnTo(this, "Character", degrees, time);
  }

  /**
   * Turns the character by `degrees` from the angle it already holds.
   *
   * @param {number} degrees Degrees to turn clockwise; negative turns back.
   * @param {number} [time] Milliseconds the turn takes; omitted is at once.
   */
  rotate(degrees, time) {
    return turnBy(this, "Character", degrees, time);
  }

  /**
   * 沿 H 面（水平面）的蓝圈把角色转出画面 `degrees` 度：绕升轴，转向观众的
   * 右边，左侧因此朝观众转过来。0 是正对观众，90 是转到正侧面。
   *
   * @param {number} degrees 度数；不回卷。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  rotateH(degrees, time) {
    return tiltBy(this, "Character", "H", degrees, time);
  }

  /**
   * 沿 V 面（正立面）的绿圈把角色抬落 `degrees` 度：绕平轴，顶边朝观众倒。
   *
   * @param {number} degrees 度数；不回卷。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  rotateV(degrees, time) {
    return tiltBy(this, "Character", "V", degrees, time);
  }

  /** 把 H 面的转角直接设成 `degrees`（不是累加）。 */
  rotateHTo(degrees, time) {
    return tiltTo(this, "Character", "H", degrees, time);
  }

  /** 把 V 面的转角直接设成 `degrees`（不是累加）。 */
  rotateVTo(degrees, time) {
    return tiltTo(this, "Character", "V", degrees, time);
  }

  /**
   * Resizes the character to `value`, where 1 is its own size.
   *
   * @param {number} value A positive multiplier: 0.5 is half, 2 is double.
   * @param {number} [time] Milliseconds the resize takes; omitted is at once.
   */
  scaleTo(value, time) {
    return resizeTo(this, "Character", value, time);
  }

  /**
   * Resizes the character by `value`, relative to the size it already has.
   *
   * @param {number} value A positive multiplier; the sizes compound, so two
   *   calls of `scale(2)` leave the image at four times its own size.
   * @param {number} [time] Milliseconds the resize takes; omitted is at once.
   */
  scale(value, time) {
    return resizeBy(this, "Character", value, time);
  }

  /**
   * Tints the character by a relative offset, over `time` milliseconds.
   *
   * Each channel is added to the offset already there and clamped at 255, so a
   * red of `254` plus an offset of `10` only reaches `255` — the part that would
   * spill past the top is dropped. Returns the character so calls chain.
   */
  rgb(dr, dg, db, time) {
    const next = addTint(
      this.tint,
      tintChannel(this.kind, dr, "红"),
      tintChannel(this.kind, dg, "绿"),
      tintChannel(this.kind, db, "蓝"),
    );
    return this.applyTintValues(next.r, next.g, next.b, time);
  }

  /**
   * Tints the character to an absolute offset, over `time` milliseconds.
   *
   * Unlike `rgb`, each channel is the offset itself rather than added to the
   * current one, so it overrides whatever tint was there. Returns the character.
   */
  rgbTo(r, g, b, time) {
    return this.applyTintValues(
      clampChannel(tintChannel(this.kind, r, "红")),
      clampChannel(tintChannel(this.kind, g, "绿")),
      clampChannel(tintChannel(this.kind, b, "蓝")),
      time,
    );
  }

  /**
   * Tints the character to a hex colour, over `time` milliseconds.
   *
   * The string is read case-insensitively (`FFFFFF` and `ffffff` are the same),
   * so a writer may paste a colour from anywhere. Returns the character.
   */
  hex(hex, time) {
    const { r, g, b } = parseHex(hex);
    return this.applyTintValues(r, g, b, time);
  }

  /**
   * Remembers a tint and asks the stage to paint it, returning the character so
   * calls chain — the shared body of `rgb`, `rgbTo` and `hex`.
   */
  applyTintValues(r, g, b, time) {
    this.tint = { r, g, b };
    this.stage.applyTint(this.filterTarget, r, g, b, duration(this.kind, time));
    return this;
  }

  /**
   * Softens the character with a blur of `value` pixels, over `time`.
   *
   * Zero is sharp, which is where every picture starts. The value is clamped at
   * 100 rather than refused, the way opacity is: a script that overshoots means
   * "as blurred as it goes".
   *
   * @param {number} value Blur radius in stage pixels.
   * @param {number} [time] Milliseconds the change takes; omitted is at once.
   */
  blur(value, time) {
    return this.applyLookValues("blur", value, time);
  }

  /** Brightens (`>1`) or darkens (`<1`) the character, over `time`. */
  brightness(value, time) {
    return this.applyLookValues("brightness", value, time);
  }

  /** Raises (`>1`) or lowers (`<1`) the character's contrast, over `time`. */
  contrast(value, time) {
    return this.applyLookValues("contrast", value, time);
  }

  /** Saturates (`>1`) or greys out (`0`) the character, over `time`. */
  saturate(value, time) {
    return this.applyLookValues("saturate", value, time);
  }

  /**
   * Remembers one look property and asks the stage to paint it, returning the
   * character so calls chain — the shared body of the four filter calls.
   *
   * One property is set and the rest keep their values, so `ch.saturate(0)`
   * after `ch.blur(4)` leaves the blur on: the four are sliders on one picture,
   * not four filters that replace each other.
   */
  applyLookValues(property, value, time) {
    this.look = withLook(this.look, property, value, this.kind);
    this.stage.applyLook(this.filterTarget, this.look, duration(this.kind, time));
    return this;
  }
}

/**
 * Numbers text objects the script never assigned to a name.
 *
 * The count lives on the interpreter's context for the same reason a
 * character's does: one run numbers its own text objects the same way every
 * time, and two runs cannot shift each other's slots.
 */
function nextTextNumber(context) {
  context.textSeq = (context.textSeq ?? 0) + 1;
  return context.textSeq;
}

/** The default size a Text is shown at, in stage units. */
const DEFAULT_TEXT_SIZE = 48;
/** The default colour a Text is shown in. */
const DEFAULT_TEXT_COLOR = "#ffffff";

/** Reads the words a `Text` shows. Anything but text is reported, not guessed at. */
function textContentOf(value) {
  if (typeof value === "string") {
    return value;
  }
  throw new Error("Text 需要文本内容；数字等值请先用 str(值) 变成文本");
}

/** Reads a Text's size, in the stage's own logical pixels. */
function textSizeOf(kind, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${kind} 的字号需要大于 0 的数字`);
  }
  return value;
}

/** Reads a Text's colour: any CSS colour string, usually `#rrggbb`. */
function textColorOf(kind, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${kind} 的颜色需要文本，例如 "#ffffff"`);
  }
  return value.trim();
}

/**
 * Reads a Text's font family.
 *
 * An empty string is meaningful rather than a mistake: it puts the built-in
 * pair back — JetBrains Mono for Western letters, 思源黑体 for Chinese — which
 * is what the font menu's "默认字体" entry writes.
 */
function textFamilyOf(kind, value) {
  if (typeof value !== "string") {
    throw new Error(`${kind} 的字体需要文本，例如 "宋体"`);
  }
  return value.trim();
}

/**
 * Text drawn on the frame.
 *
 * Unlike a picture it reads no asset: the words are the constructor's first
 * argument, and the rest of the frame — place, turn, size, opacity — is the
 * same shape a Character has, so `move`, `scale`, `alpha` and their friends
 * mean the same thing here.
 */
class Text {
  /**
   * @param {string} value The words to show; `\n` starts a new line.
   * @param {object} stage The stage this text draws on.
   * @param {object} [context] The interpreter's context, carrying `assignee`
   *   and the `pending` list the actions below report into.
   */
  constructor(value, stage, context = {}, options = {}) {
    this.text = textContentOf(value);
    this.stage = stage;
    // The slot the text draws in, named after the variable it was assigned to
    // so rebuilding that variable replaces the words in place rather than
    // stacking a second copy.
    this.slot = context.assignee ?? `text-${nextTextNumber(context)}`;
    const inherited = stage.textState?.(this.slot) ?? null;
    this.px = inherited?.x ?? 0;
    this.py = inherited?.y ?? 0;
    // 深度：0 是舞台平面，正数往画面深处（更远、更小），负数朝观众。
    this.depth = inherited?.depth ?? 0;
    this.rotation = inherited?.rotation ?? 0;
    // 另外两个转角：沿 H 面（水平面）与 V 面（正立面）的圈转，0 是贴在 W 面上。
    // 换一张表情不该把角色转回正面，所以它们跟着 `inherited` 走。
    this.angleH = inherited?.angleH ?? 0;
    this.angleV = inherited?.angleV ?? 0;
    this.size = inherited?.size ?? 1;
    this.opacity = inherited?.opacity ?? 1;
    // The size is in stage pixels; `size` above is the scale multiplier the
    // shared `scale` / `scaleTo` methods keep, so the two cannot share a name.
    this.fontSize = inherited?.fontSize ?? DEFAULT_TEXT_SIZE;
    // 颜色存在 `textColor`：`color` 是脚本可调的方法名，同名实例属性会把
    // 原型上的方法整个盖掉，`title.color(…)` 就成了「字符串不是函数」。
    this.textColor = inherited?.color ?? DEFAULT_TEXT_COLOR;
    // One family for both scripts; "" keeps the built-in pair (JetBrains Mono
    // for Latin, 思源黑体 for Chinese).
    this.fontFamily = inherited?.fontFamily ?? "";
    // The CSS weight the family is drawn at; 400 is the regular face.
    this.fontWeight = inherited?.fontWeight ?? TEXT_FONT_WEIGHT;
    this.placed = false;
    this.kind = "Text";
    this.filterTarget = this.slot;
    const report = (started) => {
      if (started) {
        context.pending?.push(started);
      }
    };
    this.place = (x, y, z, time) => report(stage.moveText(this.slot, x, y, z, time));
    this[APPLY_FRAME] = (rotation, scale, time, pose) =>
      report(stage.transformText(this.slot, rotation, scale, time, pose));
    this[APPLY_ALPHA] = (value, time) => report(stage.setTextAlpha(this.slot, value, time));
    this[APPLY_REPORT] = report;
    applyFrameOptions(this, options, "Text");
    const size = givenNumber(options, "size", "Text");
    if (size !== null) {
      this.fontSize = textSizeOf("Text", size);
    }
    if (options.color !== undefined) {
      this.textColor = textColorOf("Text", options.color);
    }
  }

  /** Puts this text on the stage. */
  enable() {
    this.stage.setText(this.slot, this.text, {
      size: this.fontSize,
      color: this.textColor,
      font: this.fontFamily,
      weight: this.fontWeight,
    });
    this.placed = true;
    // 位置与深度一起交出去：`enable()` 之前写下的 z 不会被这里改成舞台平面。
    this.place(this.px, this.py, this.depth);
    // 两个转角要一起交出去：`enable()` 之前写下的姿态（构造参数或重建变量
    // 继承来的）才会落到舞台上，而不是等下一次转身才生效。
    this[APPLY_FRAME](this.rotation, this.size, 0, {
      rotateH: this.angleH,
      rotateV: this.angleV,
    });
    this[APPLY_ALPHA](this.opacity, 0);
    return this;
  }

  /**
   * Sets the colour the text is drawn in.
   *
   * Any CSS colour string is accepted (`"#ffd479"`, `"tomato"`, `rgb(…)`). The
   * constructor's fifth argument is the same colour; this is how it changes
   * after the words are on the stage. A `time` fades from the colour it has to
   * the new one — the other calls take a duration the same way.
   */
  color(value, time = 0) {
    const next = textColorOf("Text", value);
    this.textColor = next;
    // Before `enable()` there is no element to paint: the colour is kept and
    // lands with the rest of the styles when the text is shown.
    if (this.placed) {
      this[APPLY_REPORT](this.stage.setTextColor(this.slot, next, duration("Text", time)));
    }
    return this;
  }

  /**
   * Sets the typeface for the whole text — Chinese and Western at once.
   *
   * The name is any family the machine has, exactly as the browser spells it
   * (`"宋体"`, `"Microsoft YaHei"`). An empty name restores the default pair.
   */
  font(family = "") {
    const name = textFamilyOf("Text", family);
    this.fontFamily = name;
    this.stage.setTextFont(this.slot, name);
    return this;
  }

  /**
   * Sets how heavy the text is drawn: the CSS weight scale, 400 being regular.
   *
   * Use 100–900 in steps of 100 (700 is bold); a face the family does not carry
   * is matched to the nearest one it does. Like `font()`, the change is instant
   * and needs no duration.
   */
  weight(value = TEXT_FONT_WEIGHT) {
    const weight = textFontWeight("Text", value);
    this.fontWeight = weight;
    this.stage.setTextWeight(this.slot, weight);
    return this;
  }

  /** Fades the text to `value` (0–1) over `time` milliseconds. */
  alpha(value, time) {
    return fadeTo(this, "Text", value, time);
  }

  /** Fades the text out; the words stay, at opacity 0. */
  hide(time) {
    return this.alpha(0, time);
  }

  /** Fades the text back in. */
  show(time) {
    return this.alpha(1, time);
  }

  /**
   * Moves the text to `x`, `y`, `z` (stage coordinates) over `time`.
   *
   * `z` is the depth the same way it is on a picture; left out, the text keeps
   * the depth it already had.
   */
  moveTo(x, y, z, time) {
    return placeAt(this, "Text", x, y, z, time);
  }

  /** Moves the text by `dx`, `dy`, `dz` from where it is. */
  move(dx, dy, dz, time) {
    return shiftBy(this, "Text", dx, dy, dz, time);
  }

  /**
   * 沿 x 轴相对移动这段文字：正数向右、负数向左。
   *
   * @param {number} dx 向右的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  x(dx, time) {
    return this.move(dx, 0, undefined, time);
  }

  /**
   * 沿 y 轴相对移动这段文字：正数向上、负数向下。
   *
   * @param {number} dy 向上的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  y(dy, time) {
    return this.move(0, dy, undefined, time);
  }

  /**
   * 沿 z 轴（深度）相对移动这段文字：正数往画面深处（更远、更小），负数朝观众。
   *
   * @param {number} dz 深度增量；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  z(dz, time) {
    return this.move(0, 0, dz, time);
  }

  /**
   * 把这段文字的绝对 x 坐标设成 `x`：原点在舞台中心，正数向右。
   *
   * y 与深度保持不变。
   *
   * @param {number} x 横向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  xTo(x, time) {
    return this.moveTo(x, this.py, undefined, time);
  }

  /**
   * 把这段文字的绝对 y 坐标设成 `y`：原点在舞台中心，正数向上。
   *
   * x 与深度保持不变。
   *
   * @param {number} y 纵向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  yTo(y, time) {
    return this.moveTo(this.px, y, undefined, time);
  }

  /**
   * 把这段文字放到绝对深度 `value`：0 是舞台平面，正数往画面深处（更远、更小）。
   *
   * 这是 `z` 从「绝对」改名后的绝对写法；原来的 `text.z(200)` 深度脚本请改用
   * `text.zTo(200)`。x 与 y 保持不变。
   *
   * @param {number} value 深度，负数朝观众。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  zTo(value, time) {
    return this.moveTo(this.px, this.py, value, time);
  }

  /**
   * 沿 H（平轴，即 x）相对移动这段文字：与 `x` 同一个调用。
   *
   * H / V / D 是内部统一的三轴叫法：Horizontal（平）、Vertical（升）、
   * Depth（推）。`h` / `v` / `z` 与 `x` / `y` / `z` 完全等价。
   */
  h(dh, time) {
    return this.move(dh, 0, undefined, time);
  }

  /** 沿 V（升轴，即 y）相对移动这段文字：与 `y` 同一个调用。 */
  v(dv, time) {
    return this.move(0, dv, undefined, time);
  }

  /** 把这段文字的绝对 H（即 x）坐标设成 `h`。 */
  hTo(h, time) {
    return this.moveTo(h, this.py, undefined, time);
  }

  /** 把这段文字的绝对 V（即 y）坐标设成 `v`。 */
  vTo(v, time) {
    return this.moveTo(this.px, v, undefined, time);
  }

  /** Turns the text to `degrees`. */
  rotateTo(degrees, time) {
    return turnTo(this, "Text", degrees, time);
  }

  /** Turns the text by `degrees`. */
  rotate(degrees, time) {
    return turnBy(this, "Text", degrees, time);
  }

  /** 沿 H 面（水平面）的蓝圈把这段字转出画面 `degrees` 度（绕升轴）。 */
  rotateH(degrees, time) {
    return tiltBy(this, "Text", "H", degrees, time);
  }

  /** 沿 V 面（正立面）的绿圈把这段字抬落 `degrees` 度（绕平轴）。 */
  rotateV(degrees, time) {
    return tiltBy(this, "Text", "V", degrees, time);
  }

  /** 把 H 面的转角直接设成 `degrees`（不是累加）。 */
  rotateHTo(degrees, time) {
    return tiltTo(this, "Text", "H", degrees, time);
  }

  /** 把 V 面的转角直接设成 `degrees`（不是累加）。 */
  rotateVTo(degrees, time) {
    return tiltTo(this, "Text", "V", degrees, time);
  }

  /** Resizes the text to `value` times its authored size. */
  scaleTo(value, time) {
    return resizeTo(this, "Text", value, time);
  }

  /** Resizes the text by `value`, relative to its current size. */
  scale(value, time) {
    return resizeBy(this, "Text", value, time);
  }
}

/** 灯的数值参数在报错里怎么写。 */
const LIGHT_PARAM_NAMES = {
  intensity: "强度",
  spread: "散射角",
  range: "传播距离",
  bloom: "泛光",
  soft: "柔光",
  width: "宽度",
  z: "深度",
  rotateH: "H 面角",
  rotateV: "V 面角",
  rotate: "W 面角",
};

/** 一个数值参数的过渡入口，放在符号上，脚本读不到。 */
const LIGHT_SET = Symbol("lightSet");

/** Reads a light's colour as the hex text the rest of the stage speaks. */
function lightColorText(kind, value) {
  if (typeof value !== "string") {
    throw new Error(`${kind} 的颜色需要十六进制文本，如 "FFD9A0"`);
  }
  try {
    const { r, g, b } = parseHex(value);
    return toHex(r, g, b);
  } catch {
    throw new Error(`${kind} 的颜色需要三或六位十六进制，如 "FFD9A0"`);
  }
}

/** Reads one light number, clamped to the range that parameter accepts. */
function lightNumber(kind, name, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${kind} 的${LIGHT_PARAM_NAMES[name] ?? name}需要数字`);
  }
  return normalizeLight({ [name]: value })[name];
}

/**
 * A light: something that brightens the frame without being part of it.
 *
 * Unlike a picture a light is not an element — it is a set of numbers the
 * stage's light layer draws from (see `ui/light.js`). That is why it owns no
 * bitmap and why `enable()` is what adds it to that layer rather than what puts
 * an image up: a light the script has built but not enabled is nothing at all.
 *
 * The properties a script sets are the *target* values, as they are on a
 * picture: a call with a duration writes the target at once and lets the layer
 * walk to it, so a following relative call counts from where the animation is
 * going rather than from where it is.
 */
class Light {
  /**
   * @param {unknown[]} args The call's arguments, already in `PARAM_SPECS.Light`
   *   order by the interpreter.
   * @param {object} stage The stage this light shines on.
   * @param {object} [context] The interpreter's context, whose `pending` list
   *   a timed call reports into.
   */
  constructor(args, stage, context = {}) {
    const options = ctorOptions("Light", args);
    // 灯的状态就是 `light.js` 的那组默认值。它放在 `params` 而不是对象身上：
    // `intensity` 这些名字同时是方法名，铺平到 `this` 上会把方法盖掉。
    this.params = neutralLight();
    this.kind = "Light";
    this.stage = stage;
    // 与图片同名的占位：`turnTo` 与自由变换都读它。
    this.size = 1;
    this.placed = false;
    /** 正在走的那些值的当前画面值；没有过渡时为 null。 */
    this.live = null;
    /** 这盏灯不照的对象键，由 `stage.exclude` 写入。 */
    this.excluded = new Set();

    const report = (started) => {
      if (started) {
        context.pending?.push(started);
      }
    };
    this[APPLY_REPORT] = report;
    this[APPLY_ALPHA] = (value, time) =>
      report(stage.animateLight(this, { opacity: value }, time));
    this[APPLY_FRAME] = (rotation, scale, time) =>
      report(stage.animateLight(this, { rotate: rotation }, time));

    if (options.color !== undefined) {
      this.params.color = lightColorText("Light", options.color);
    }
    // 参数名就是内部字段名：`rotateH` / `rotateV` 是灯面转出的那两个面。
    const numeric = {
      x: ["x"],
      y: ["y"],
      intensity: ["intensity"],
      spread: ["spread"],
      range: ["range"],
      width: ["width"],
      bloom: ["bloom"],
      soft: ["soft"],
      z: ["z"],
      rotateH: ["rotateH"],
      rotateV: ["rotateV"],
      rotate: ["rotate"],
    };
    for (const [name, spellings] of Object.entries(numeric)) {
      let value = null;
      for (const spelling of spellings) {
        value = givenNumber(options, spelling, "Light");
        if (value !== null) {
          break;
        }
      }
      if (value === null) continue;
      this.params[name] =
        name === "x" || name === "y" ? value : lightNumber("Light", name, value);
    }
    const alpha = givenNumber(options, "alpha", "Light");
    if (alpha !== null) this.params.opacity = opacity("Light", alpha);
  }

  /** 数值参数的一次过渡：目标立刻写回，画面从旧值走过去。 */
  [LIGHT_SET](name, value, time) {
    const ms = duration("Light", time);
    if (!this.placed) {
      this.params[name] = value;
      return this;
    }
    this[APPLY_REPORT](this.stage.animateLight(this, { [name]: value }, ms));
    return this;
  }

  /** Shows the light on the stage. */
  enable() {
    // `placed` 先立起来：`addLight` 会立刻重画灯层，而重画只画「已在场上」的灯。
    this.placed = true;
    this.stage.addLight(this);
    return this;
  }

  /** Takes the light off the stage; its parameters stay as they were. */
  disable() {
    this.stage.removeLight(this);
    this.placed = false;
    return this;
  }

  /** 强度：0 不亮，1 是正常亮度，可以过 1 用来叠出曝光感。 */
  intensity(value, time) {
    return this[LIGHT_SET]("intensity", lightNumber("Light", "intensity", value), time);
  }

  /** 散射角：360 是全向，越小越像一束聚光。 */
  spread(value, time) {
    return this[LIGHT_SET]("spread", lightNumber("Light", "spread", value), time);
  }

  /** 传播距离：光在这段距离上衰减到 0；负数是无限远。 */
  range(value, time) {
    if (Number(value) < 0) {
      return this[LIGHT_SET]("range", -1, time);
    }
    return this[LIGHT_SET]("range", lightNumber("Light", "range", value), time);
  }

  /** 泛光：打到对象轮廓上的辉光强度，0–1。 */
  bloom(value, time) {
    return this[LIGHT_SET]("bloom", lightNumber("Light", "bloom", value), time);
  }

  /** 柔光：整块光斑的模糊程度，0–1。 */
  soft(value, time) {
    return this[LIGHT_SET]("soft", lightNumber("Light", "soft", value), time);
  }

  /**
   * 灯管的长度：0 是点光源，正数让灯本身变成一段有长度的发光体。
   *
   * 光从灯管上的每一点发出：近处只有管长那么宽，远处才按锥角张开——它描述
   * 的是光源，不是投影的形状。灯管沿灯面的平轴躺着，想把它摆斜（连同锥口
   * 一起）就用 `rotate` 沿 W 面的橙圈转。
   */
  width(value, time) {
    return this[LIGHT_SET]("width", lightNumber("Light", "width", value), time);
  }

  /**
   * 灯面沿 H 面（水平面）转到 `value`：0 时光束朝 +x（画面右），正数在 H 面上
   * 俯视顺时针转，90 度正对镜头射过来 —— 这时看到的是锥底的圆形截面，不再是
   * 侧视的楔形；180 度朝 -x，270 度朝画面深处。
   *
   * 它绕世界升轴，是三个角里唯一负责方位的一支；`rotateV` 绕世界平轴抬落，
   * `rotate` 最后在画面里把整盏灯转一下。
   */
  rotateH(value, time) {
    return this[LIGHT_SET]("rotateH", lightNumber("Light", "rotateH", value), time);
  }

  /**
   * 灯面沿 V 面（正立面）转到 `value`：绕世界平轴，把光束上下抬落。
   *
   * 0 是水平，+90 朝画面下方打、-90 朝上方打。绕世界平轴，x 分量不动，所以
   * 光束正好朝 +x（`rotateH = 0`）时它不改变方向；先用 `rotateH` 转开方位，
   * 抬落才看得出来。离 0 越远，光斑沿光束拉得越长、甩得越远。
   */
  rotateV(value, time) {
    return this[LIGHT_SET]("rotateV", lightNumber("Light", "rotateV", value), time);
  }

  /** 两个转角一次写完：`direction(35, 60, 800)` 是 H 面与 V 面的两个角。 */
  direction(rotateH, rotateV, time) {
    if (!Number.isFinite(rotateH) || !Number.isFinite(rotateV)) {
      throw new Error("Light 的方向需要两个数字：H 面角与 V 面角");
    }
    const ms = duration("Light", time);
    const patch = {
      rotateH: normalizeLight({ rotateH }).rotateH,
      rotateV: normalizeLight({ rotateV }).rotateV,
    };
    if (!this.placed) {
      Object.assign(this.params, patch);
      return this;
    }
    this[APPLY_REPORT](this.stage.animateLight(this, patch, ms));
    return this;
  }

  /** 灯的颜色：`hex("FFD9A0")`，也可写 `颜色(...)`。 */
  hex(value, time) {
    return this[LIGHT_SET]("color", lightColorText("Light", value), time);
  }

  /**
   * 三通道直接给色：与图片上的 `rgb` 不同，灯的颜色是绝对的，不是在原色上偏移。
   */
  rgb(r, g, b, time) {
    return this.hex(
      toHex(clampChannel(r), clampChannel(g), clampChannel(b)),
      time,
    );
  }

  /** Fades the light to `value` (0–1) over `time` milliseconds. */
  alpha(value, time) {
    const to = opacity("Light", value);
    if (!this.placed) {
      this.params.opacity = to;
      return this;
    }
    this[APPLY_REPORT](this.stage.animateLight(this, { opacity: to }, duration("Light", time)));
    return this;
  }

  /** Fades the light out; the lamp stays where it is, at nothing. */
  hide(time) {
    return this.alpha(0, time);
  }

  /** Fades the light back in. */
  show(time) {
    return this.alpha(1, time);
  }

  /**
   * Moves the light to `x`, `y`, `z` (stage coordinates) over `time`.
   *
   * `z` is depth: 0 is the stage plane, positive goes away from the viewer.
   * Left out, the light keeps the depth it already had.
   */
  moveTo(x, y, z, time) {
    const to = point("Light", x, y);
    const ms = duration("Light", time);
    const patch = { x: to.x, y: to.y };
    if (z !== undefined && z !== null) {
      patch.z = lightNumber("Light", "z", z);
    }
    if (!this.placed) {
      Object.assign(this.params, patch);
      return this;
    }
    this[APPLY_REPORT](this.stage.animateLight(this, patch, ms));
    return this;
  }

  /** Moves the light by `dx`, `dy`, `dz` from where it is. */
  move(dx, dy, dz, time) {
    const by = point("Light", dx, dy);
    return this.moveTo(
      this.params.x + by.x,
      this.params.y + by.y,
      dz === undefined || dz === null ? null : this.params.z + Number(dz),
      time,
    );
  }

  /**
   * 沿 x 轴相对移动这盏灯：正数向右、负数向左。
   *
   * @param {number} dx 向右的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  x(dx, time) {
    return this.move(dx, 0, undefined, time);
  }

  /**
   * 沿 y 轴相对移动这盏灯：正数向上、负数向下。
   *
   * @param {number} dy 向上的距离；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  y(dy, time) {
    return this.move(0, dy, undefined, time);
  }

  /**
   * 沿 z 轴（深度）相对移动这盏灯：正数更远、站到对象背后，负数朝观众。
   *
   * @param {number} dz 深度增量；省略是 0。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  z(dz, time) {
    return this.move(0, 0, dz, time);
  }

  /**
   * 把这盏灯的绝对 x 坐标设成 `x`：原点在舞台中心，正数向右。
   *
   * y 与深度保持不变。
   *
   * @param {number} x 横向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  xTo(x, time) {
    return this.moveTo(x, this.params.y, undefined, time);
  }

  /**
   * 把这盏灯的绝对 y 坐标设成 `y`：原点在舞台中心，正数向上。
   *
   * x 与深度保持不变。
   *
   * @param {number} y 纵向舞台坐标。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  yTo(y, time) {
    return this.moveTo(this.params.x, y, undefined, time);
  }

  /**
   * 把这盏灯放到绝对深度 `value`：0 是舞台平面，正数在对象背后，负数朝观众。
   *
   * 这是 `z` 从「绝对」改名后的绝对写法；原来的 `lamp.z(-40)` 深度脚本请改用
   * `lamp.zTo(-40)`。x 与 y 保持不变。
   *
   * @param {number} value 深度，负数朝观众。
   * @param {number} [time] 毫秒；省略是立刻。
   */
  zTo(value, time) {
    return this.moveTo(this.params.x, this.params.y, value, time);
  }

  /**
   * 沿 H（平轴，即 x）相对移动这盏灯：与 `x` 同一个调用。
   *
   * H / V / D 是内部统一的三轴叫法：Horizontal（平）、Vertical（升）、
   * Depth（推）。`h` / `v` / `z` 与 `x` / `y` / `z` 完全等价。
   */
  h(dh, time) {
    return this.move(dh, 0, undefined, time);
  }

  /** 沿 V（升轴，即 y）相对移动这盏灯：与 `y` 同一个调用。 */
  v(dv, time) {
    return this.move(0, dv, undefined, time);
  }

  /** 把这盏灯的绝对 H（即 x）坐标设成 `h`。 */
  hTo(h, time) {
    return this.moveTo(h, this.params.y, undefined, time);
  }

  /** 把这盏灯的绝对 V（即 y）坐标设成 `v`。 */
  vTo(v, time) {
    return this.moveTo(this.params.x, v, undefined, time);
  }

  /**
   * 这盏灯在 W 面（画面本身）上转到 `degrees`：绕世界的推轴，画面上顺时针为正。
   *
   * 整盏灯连同光束一起转：刚创建的灯朝 +x（画面右），`rotateTo(90)` 就朝下照、
   * 180 朝左、270 朝上。它与立绘的 `rotate` 同向，但作用在 H / V 摆好之后 ——
   * 先把方位与抬落摆进空间，再在画面里转这一下。
   *
   * 全向光（`spread` 为 360）没有光束方向，光斑本来就是圆，转它看不出变化：
   * 要让光「从上方打下来」，先写一个较窄的 `spread`。
   */
  rotateTo(degrees, time) {
    return this[LIGHT_SET]("rotate", angle("Light", degrees), time);
  }

  /** 这盏灯在画面里再转 `degrees` 度（相对累加）。 */
  rotate(degrees, time) {
    return this.rotateTo(this.params.rotate + angle("Light", degrees), time);
  }
}

/**
 * The factories behind the types the stage builds.
 *
 * The stage installs these as its own methods (see `createStageGlobals`), so a
 * type is properly built by `stage.Character(…)`; the bare `Character(…)` is
 * that same call with the receiver left out. A factory is handed the whole
 * argument list and the run's context, which the stage's method closes over for
 * it. They are exported as well so a host or a test can build an object
 * directly, without a script ever being run.
 *
 * @param {object} stage A stage from `createStage`.
 * @returns {Record<string, (args: unknown[], context: object) => unknown>}
 */
export function createStageObjects(stage) {
  let unnamed = 0;
  /**
   * 给每个构造出来的对象接上两个开关：`crood(显示)` 与 `translucent(透光)`。
   *
   * 键按类型与变量名拼，和灯排除用的 `character:<slot>` 是同一套写法；灯没有
   * slot，所以键也记在它自己身上，舞台才能从灯堆里把它认出来。音频与粒子同样
   * 接上方法（调用不会报错），只是它们没有三维坐标，舞台读不到姿态，因此不会
   * 有轴 —— 没坐标的东西不该凭空长出三根轴。
   *
   * 透光默认由类型决定（见各构造函数）：角色挡光，其余类型都不在灯层里，默认
   * 让光穿过去。写下 `.translucent(true/false)` 之后立即生效，灯层当场重画。
   */
  const withObjectMethods = (object, context) => {
    if (!object || typeof object !== "object") {
      return object;
    }
    const kind = String(object.kind ?? "object");
    const name = object.slot ?? context?.assignee ?? `${kind.toLowerCase()}-${(unnamed += 1)}`;
    const key = kind === "Background" ? "background" : `${kind.toLowerCase()}:${name}`;
    if (kind === "Light") {
      object.axesKey = key;
    }
    object.crood = (value = true) => {
      stage.setCrood?.(key, Boolean(value));
      return object;
    };
    // 透光记在舞台上（与坐标轴同一个键），所以重建变量时它跟着槽位一起留下。
    object.translucent = (value = true) => {
      stage.setTranslucent?.(key, value);
      return object;
    };
    // 轮廓光：灯在它背后时贴着轮廓勾一圈光，强度 0–1。不写就是不勾。
    object.rim = (value = 1) => {
      stage.setRim?.(key, rimAmount(kind, value));
      return object;
    };
    // 抗锯齿：位图缩放时怎么取像素，强度 0–2，默认 0（关，硬边）。两档：
    // `aa` 连内部一起柔化，`eaa` 只柔化轮廓。只有角色有位图要缩放，文字是画
    // 出来的、特效与视频自己画自己，所以这两个名字只挂在角色身上。
    if (kind === "Character") {
      object.aa = (value = 0) => {
        stage.setAntialias?.(key, antialiasAmount("抗锯齿", value));
        return object;
      };
      object.eaa = (value = 0) => {
        stage.setEdgeAntialias?.(key, antialiasAmount("边缘抗锯齿", value));
        return object;
      };
    }
    return object;
  };
  return {
    Background: (args, context) =>
      withObjectMethods(new Background(args[0], stage, context, ctorOptions("Background", args)), context),
    Character: (args, context) =>
      withObjectMethods(new Character(args[0], stage, context, ctorOptions("Character", args)), context),
    // 文字的第一参数是内容而非路径：它不读素材，只把字写到画面上。
    Text: (args, context) =>
      withObjectMethods(new Text(args[0], stage, context, ctorOptions("Text", args)), context),
    // 光源同第一参数是颜色：它不读素材，画在舞台的灯层上。
    Light: (args, context) => withObjectMethods(new Light(args, stage, context), context),
    // A sound is built against the stage the same way, so its slot and its
    // source resolution come from the same place a picture's do.
    Audio: (args, context) => withObjectMethods(stage.audio(args, context), context),
    // An effect draws itself; a video reads through the stage's video reader.
    Effect: (args, context) => withObjectMethods(stage.effect(args, context), context),
    Video: (args, context) => withObjectMethods(stage.video(args, context), context),
  };
}

/**
 * The stage's global objects — the ones a script reaches without building
 * anything first: the `dialog`, and the `stage` itself.
 *
 * This is a function of the interpreter's `context` rather than a plain object
 * because `dialog.say` has to hand its promise to that context's `pending`
 * list: that is what blocks the script until the player clicks, exactly as a
 * character's own `say` does. The context is not known until a run starts, so
 * the objects cannot be built before it.
 *
 * `stage` is the object a call that belongs to nothing else is made on. It is
 * not built by the script and cannot be destroyed by it: it comes into being
 * with the stage and goes away with it, which is why `say` — the narrator's
 * line — is properly `stage.say(…)`, and why a type is properly built by
 * `stage.Character(…)`. Writing a bare `say(…)` or `Character(…)` reaches the
 * same method with the receiver left out; the bare form is a shorthand, not a
 * second function, so there is one place the call lives and one place to look
 * for it. `dialog` stays a name of its own because it is a *thing* — a box
 * with a state — rather than one of the stage's calls.
 *
 * The context is also what lets the stage own the constructors: each is a
 * method here, closing over the same `assignee` / `pending` the rest of the
 * stage's calls use, so the runtime's permission to build a resource lives on
 * the stage alone rather than in a second table the interpreter keeps.
 *
 * @param {object} stage A stage from `createStage`.
 * @param {Record<string, (args: unknown[], context: object) => unknown>} [objects]
 *   The factories installed as the stage's constructor methods; by default the
 *   stage's own (see `createStageObjects`).
 * @returns {(context: object) => Record<string, unknown>}
 */
export function createStageGlobals(stage, objects = createStageObjects(stage)) {
  return (context) => {
    const dialog = {
      // Which object this is, for the parameter names of its methods: `say`
      // takes a name slot here and none on a character (see `paramSpecOf`).
      kind: "Dialog",
      /** Shows the dialogue layer, wherever it was left. */
      enable() {
        stage.setVisible(true);
        return dialog;
      },
      /** Hides the dialogue layer without clearing the line in it. */
      disable() {
        stage.setVisible(false);
        return dialog;
      },
      /**
       * Shows a line and waits for a click.
       *
       * @param {string} text The line to show.
       * @param {string} [name] Who is speaking; left out is the narrator.
       */
      say(text, name, ...rest) {
        if (name !== undefined && name !== null && typeof name !== "string") {
          throw new Error("dialog.say 的姓名需要文本");
        }
        // The name owns the second slot, so `time` / `audio` are read from what
        // follows it rather than from everything after the text.
        context.pending?.push(stage.sayLine(name ?? null, lineText(text), sayTiming(rest)));
        return dialog;
      },
    };
    const stageApi = {
      kind: "Stage",
      /**
       * The types a script can build are methods of the stage: `Character(…)`,
       * `Background(…)` and `Audio(…)` are these three with `stage.` left out.
       * The stage is the only owner of the run's context, so it can hand a fresh
       * resource the variable it is being bound to and the list it reports its
       * actions into — the same permission `dialog.say` has.
       */
      Background(...args) {
        return objects.Background(args, context);
      },
      Character(...args) {
        return objects.Character(args, context);
      },
      Text(...args) {
        return objects.Text(args, context);
      },
      Audio(...args) {
        return objects.Audio(args, context);
      },
      Effect(...args) {
        return objects.Effect?.(args, context);
      },
      Video(...args) {
        return objects.Video?.(args, context);
      },
      Light(...args) {
        return objects.Light?.(args, context);
      },
      /**
       * 环境亮度：整块画面的乘算亮度，0–2，1 为原样。
       *
       * 它只压画面（背景、角色、视频、粒子、文字），不碰对话框与选项——那是一层
       * 界面，不是被照的东西。
       */
      ambient(value) {
        stage.setAmbient?.(value);
        return stageApi;
      },
      /**
       * 空间透视：`stage.perspective(true)` 打开灭点，`false` 回到正交空间。
       *
       * 默认关着：非透视空间里同一个 z 方向上的物体完全重叠，深度只决定谁
       * 盖住谁。打开之后 z 越大越远、越小，近大远小。
       */
      perspective(value = true) {
        stage.setPerspective?.(value);
        return stageApi;
      },
      /**
       * 空间参考线：`stage.guideline(true)` 打开，`interval` 是每多少坐标一条
       * （整数，默认 100，最小 10）。
       *
       * 参考线画在三个方向上；没有透视时沿深度的线在画面上退化成一点，所以
       * 只看得到横纵两组线。
       */
      guideline(value = true, interval) {
        stage.setGuideline?.(value, interval);
        return stageApi;
      },
      /**
       * 排除：冒号前的一组光源不照冒号后的一组对象。
       *
       * 两个列表都必须有内容；撤销用对称的 `unexclude`，而不是把列表留空。
       */
      exclude(lights, targets) {
        stage.exclude?.(lights, targets);
        return stageApi;
      },
      unexclude(lights, targets) {
        stage.unexclude?.(lights, targets);
        return stageApi;
      },
      /**
       * The narrator's line: what a bare `say(…)` reaches.
       *
       * There is no character and therefore no name plate; the trailing
       * arguments are `time` (ms) and `audio` (a voice track's variable name),
       * read by type so neither has to be written in a fixed position.
       */
      say(text, time, audio) {
        context.pending?.push(stage.sayLine(null, lineText(text), sayTiming([time, audio])));
        return stageApi;
      },
      /**
       * 创建一个点击位置并等待：非自动模式等玩家在该处手动点击；自动播放或
       * 导出时，`time` 是必须走完的毫秒数（未给则立即放行）。
       */
      click(time) {
        context.pending?.push(stage.clickWait?.(duration("Stage", time)));
        return stageApi;
      },
      /**
       * 不创建点击位置的计时等待：始终按 `time` 毫秒等待，用于控制自动模式
       * 的等待时长。导出与实时演出走同一语义。
       */
      auto(time) {
        context.pending?.push(stage.autoWait?.(duration("Stage", time)));
        return stageApi;
      },
      /**
       * 开启 / 关闭自动配音，并可设定播放速度：没有显式 `audio` 的 `say` 自动配
       * 一段合成效果音。`autoVoice(speed)` 的 `speed` 为整数播放速度（次/秒，1–10，
       * 默认 10）；`autoVoice()` 用默认速度开启，`autoVoice(false)` 关闭。已有的
       * `audio` 配音优先，不受此开关影响。
       */
      autoVoice(on = true) {
        stage.setAutoVoice?.(on);
        return stageApi;
      },
      /**
       * 播放约 3 秒的 Pamela 开场动画：黑幕淡入、图标淡入并左移、右侧展开
       * 「Made with Pamela」，最后整幅淡出。写在剧本哪一行就在哪一行播放，
       * 不写就没有；回放与预览按 `duration()` 的惯例立即落终态。
       */
      pamela() {
        context.pending?.push(stage.pamelaIntro?.());
        return stageApi;
      },
    };
    return { dialog, stage: stageApi };
  };
}

/**
 * The frame one image sits in: where it is, how far it is turned and how large
 * it is, plus how long each of those took to get there.
 *
 * A frame is remembered rather than read back off the element, because turning
 * and resizing share the element's single `transform` and every animation
 * shares its single `transition`. Keeping the numbers here is what lets a move
 * and a turn be issued separately and each keep its own duration.
 *
 * `w` and `h` are the free transform's box — the picture's own rectangle, in
 * logical pixels — and stay `null` until the bitmap is decoded and its size is
 * known. Until then the stylesheet's frame-sized box stands in, which is the
 * same picture the element already draws. `late` holds free transforms asked
 * for before that moment, to be replayed in the order they were made.
 *
 * @returns {{ image: HTMLElement | null, x: number, y: number, rotation: number,
 *   scale: number, moveMs: number, turnMs: number, w: number | null,
 *   h: number | null, boxMs: number, late: (() => void)[], points: object | null,
 *   mesh: object | null, deformed: boolean,
 *   frameSize: { width: number, height: number } }}
 */
function frame() {
  return {
    image: null,
    // The asset path the picture was enabled with, kept beside the element so
    // the stage can say what it is showing without reading the DOM back. A save
    // records it for its thumbnail, and `null` means nothing is drawn.
    path: null,
    x: 0,
    y: 0,
    // 深度：0 是舞台平面，正数往画面深处（更远、更小），负数朝观众。
    z: 0,
    rotation: 0,
    // 转出 W 面的两个角。0 表示这张纸就躺在舞台上，正对观众。
    rotateH: 0,
    rotateV: 0,
    scale: 1,
    // The two axes a key frame may stretch on its own. They multiply the uniform
    // `scale`, so a script that only calls `scale()` sees no difference at all:
    // 1 × 1 is the identity. A key frame's eight-handle "变形" writes these.
    scaleX: 1,
    scaleY: 1,
    // How opaque the picture is, 0–1. It starts solid, and a picture enabled
    // with an opacity set before `enable()` is painted at that opacity rather
    // than flashing solid first.
    opacity: 1,
    moveMs: 0,
    turnMs: 0,
    // The frame callback of a `rotate` that outlives the key walk it was fired
    // alongside. `cancelPath` stops it so a reset cannot inherit a late turn.
    spinFrame: null,
    w: null,
    h: null,
    boxMs: 0,
    late: [],
    // Resolvers for the `late` calls, used when the picture never arrives.
    lateFailures: [],
    // The eight points, once the bitmap has said how big the picture is. Until
    // then the box above is all there is, and a pull is held back rather than
    // measured against a frame the picture may not share the shape of.
    points: null,
    // The mesh the points can be drawn through, built with the element and
    // kept out of the drawing until one of the points is pulled on: a
    // character no script ever deforms keeps drawing through its own `<img>`.
    mesh: null,
    // Whether a pull has happened yet. This is the switch between the two ways
    // a character is drawn — the plain image and the mesh — and it is one way
    // only: once the points are apart, there is no box to go back to.
    deformed: false,
    // The frame's pixel size, remeasured when the window changes it: the
    // piece matrices are in pixels, so a resize has to be drawn again.
    frameSize: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    // A `step` asked for before there was a GIF to step: kept here until the
    // animation is decoded, or until the stage is cleared with it.
    pendingStep: undefined,
  };
}

/**
 * Resolves once a change that takes `time` milliseconds is over.
 *
 * The stage animates through CSS, which reports nothing back, so the duration
 * the call was given is what the end is measured by. A change with no duration
 * is over at once and has nothing to hand back, which is why this answers
 * `undefined` rather than an already-resolved promise: a script that only sets
 * a position does not make the interpreter wait a turn of the event loop for
 * nothing.
 *
 * @param {number} time
 * @returns {Promise<void> | undefined}
 */
function settled(time) {
  if (time <= 0) {
    return undefined;
  }
  return new Promise((resolve) => setTimeout(resolve, time));
}

/**
 * How far a piece is grown past its own edges, in frame pixels.
 *
 * Two pieces share an edge, and the browser's antialiasing leaves a pale hair
 * between two shapes that only meet on it. Growing both a fraction of a pixel
 * makes them overlap instead, which buries the hair under the other piece. It
 * is a fraction and not a promise: a seam is not worth a pixel-exact claim.
 */
const MESH_BLEED = 0.5;

/**
 * The nine nodes a mesh is drawn through, in the picture's own coordinates.
 *
 * `u` runs right and `v` down, both from 0 to 1 over the picture, so the same
 * table reads as a position in the bitmap and — scaled by the frame — as a
 * position on the stage. Eight of the names are the ones a script writes; the
 * ninth is the middle, which is what the four quarters are stitched together
 * by.
 */
const MESH_NODES = {
  upleft: [0, 0],
  up: [0.5, 0],
  upright: [1, 0],
  right: [1, 0.5],
  downright: [1, 1],
  down: [0.5, 1],
  downleft: [0, 1],
  left: [0, 0.5],
  centre: [0.5, 0.5],
};

/**
 * The four quarters of the picture, each as a ring of four mesh nodes.
 *
 * The eight points divide the picture into four quarters — one per corner,
 * each bounded by the two edge midpoints either side of it and the middle. A
 * ring and not a triangle because a general quadrilateral is not flat, so it
 * is cut along the corner-to-middle diagonal below.
 */
const MESH_QUADS = [
  ["upleft", "up", "centre", "left"],
  ["upright", "right", "centre", "up"],
  ["downright", "down", "centre", "right"],
  ["downleft", "left", "centre", "down"],
];

/**
 * The eight triangles the picture is drawn in.
 *
 * Every quarter is cut along its own diagonal, and all four meet at the same
 * middle node — which is what keeps them stitched together however far the
 * edge midpoints are pulled off their lines.
 */
const MESH_TRIANGLES = MESH_QUADS.flatMap((ring) => [
  [ring[0], ring[1], ring[2]],
  [ring[0], ring[2], ring[3]],
]);

/**
 * The affine map that sends three points onto three others.
 *
 * Three points, and the three images they land on, are exactly what fixes an
 * affine map — which is why the picture is cut into triangles and each one is
 * given its own: on a triangle, the stretch, the turn and the shear that
 * separate the two shapes are one linear map plus a shift.
 *
 * Written with `u` and `v` for the source's two sides and `U` and `V` for the
 * target's, the linear part is `[U V]·[u v]⁻¹`; the shift takes the first
 * source point the rest of the way to its target.
 *
 * @param {{x: number, y: number}[]} source Three points, in order.
 * @param {{x: number, y: number}[]} target Where those three points go.
 * @returns {{a: number, b: number, c: number, d: number, e: number, f: number} | null}
 *   The six numbers a CSS `matrix()` takes, or `null` for a source triangle
 *   with no area — which has no inverse to work from.
 */
function affineFor(source, target) {
  const [s1, s2, s3] = source;
  const [t1, t2, t3] = target;
  const u = { x: s2.x - s1.x, y: s2.y - s1.y };
  const v = { x: s3.x - s1.x, y: s3.y - s1.y };
  const U = { x: t2.x - t1.x, y: t2.y - t1.y };
  const V = { x: t3.x - t1.x, y: t3.y - t1.y };
  const det = u.x * v.y - u.y * v.x;
  if (det === 0) {
    return null;
  }
  // `matrix(a, b, c, d, e, f)` reads as x' = ax + cy + e, y' = bx + dy + f, so
  // `a` and `b` are where the source's own x axis lands and `c` and `d` where
  // its y axis does.
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

/** A stage point in the frame's own pixels, measured from its top-left. */
function asPixels(at, size) {
  return {
    x: (STAGE_WIDTH / 2 + at.x) * (size.width / STAGE_WIDTH),
    y: (STAGE_HEIGHT / 2 - at.y) * (size.height / STAGE_HEIGHT),
  };
}

/** A point in frame pixels, as the percentage a `clip-path` takes. */
function asPercent(at, size) {
  return `${(at.x / size.width) * 100}% ${(at.y / size.height) * 100}%`;
}

/**
 * The `clip-path` of one piece: its triangle, grown a hair off its own middle.
 *
 * The growth is measured in frame pixels rather than percentages, because a
 * percentage of the frame would grow with the window and a seam does not.
 */
function clipOf(triangle, size) {
  const at = triangle.map((point) => asPixels(point, size));
  const middle = {
    x: (at[0].x + at[1].x + at[2].x) / 3,
    y: (at[0].y + at[1].y + at[2].y) / 3,
  };
  const grown = at.map((point) => {
    const dx = point.x - middle.x;
    const dy = point.y - middle.y;
    const length = Math.hypot(dx, dy) || 1;
    return {
      x: point.x + (dx / length) * MESH_BLEED,
      y: point.y + (dy / length) * MESH_BLEED,
    };
  });
  return `polygon(${grown.map((point) => asPercent(point, size)).join(", ")})`;
}

/**
 * Builds the eight pieces of one character's mesh.
 *
 * Each piece is its own clip of the frame with its own copy of the picture
 * inside it, so the picture is warped a triangle at a time. The copies all
 * point at the same bitmap, so there is nothing extra to load.
 */
function buildMesh() {
  const node = document.createElement("div");
  node.className = "stage__mesh";
  const pieces = MESH_TRIANGLES.map(() => {
    const piece = document.createElement("div");
    piece.className = "stage__piece";
    const image = document.createElement("img");
    image.className = "stage__piece__image";
    image.alt = "";
    image.draggable = false;
    piece.append(image);
    node.append(piece);
    return { piece, image };
  });
  return { node, pieces };
}

/**
 * Draws a character through its eight points.
 *
 * The source of each triangle is the picture's own quarter, read from the
 * table above; the target is the same quarter of the shape the points now
 * make. The map between them is what the piece's picture is put through, and
 * the piece's clip is what says which part of the warped picture to show.
 *
 * A shape with no area to it — three points on one line — leaves a piece
 * unasked, rather than handing the browser a matrix of infinities.
 */
function drawMesh(entry, perspective = false) {
  const size = entry.frameSize;
  // 点本身始终是舞台平面上的作者坐标，只有投影改变它们落在画面上哪里：
  // 没转身时是按深度缩放，转过身之后是整块刚体转过去再透视。
  const zoom = (point) => projectStagePoint(entry, point, perspective);
  const nodes = {};
  for (const [name, point] of Object.entries(entry.points)) {
    nodes[name] = zoom(point);
  }
  nodes.centre = zoom(centroidOf(entry.points));
  MESH_TRIANGLES.forEach((triangle, index) => {
    const { piece, image } = entry.mesh.pieces[index];
    const target = triangle.map((name) => nodes[name]);
    piece.style.clipPath = clipOf(target, size);
    const source = triangle.map((name) => {
      const [u, v] = MESH_NODES[name];
      return { x: u * size.width, y: v * size.height };
    });
    const at = affineFor(source, target.map((point) => asPixels(point, size)));
    image.style.transform = at
      ? `matrix(${at.a}, ${at.b}, ${at.c}, ${at.d}, ${at.e}, ${at.f})`
      : "none";
  });
}

/**
 * Builds one layer of the stage.
 *
 * A layer is only a container the stage draws into, plus the frame of the
 * image currently in it. Its `ticket` guards against a slow load overwriting a
 * newer one; it lives on the layer, so a background still loading is not
 * cancelled by a character.
 *
 * @param {"background" | "character" | "dialogue" | "choice" | "video" | "effect" | "text"} name
 */
function createLayer(name) {
  const node = document.createElement("div");
  node.className = `stage__layer stage__layer--${name}`;
  return { node, ticket: 0, ...frame() };
}

/**
 * Wraps the stage markup and renders images into its layers.
 *
 * @param {object} options
 * @param {HTMLElement} options.element The `#stage-view` container.
 * @param {HTMLElement} options.surface The layer container inside it.
 * @param {(path: string) => Promise<string>} options.resolveAsset
 *   Turns a project-relative path into a URL the webview may load.
 * @param {(path: string) => Promise<string>} [options.resolveAudio]
 *   The same for sounds; defaults to `resolveAsset`, which a host that reads
 *   pictures and sounds through one command can leave alone.
 * @param {(message: string) => void} [options.onError]
 *   Reports a failed asset load; the stage itself stays usable.
 * @returns {{ element: HTMLElement, name: string, reset: (name: string) => void,
 *   setBackground: (path: string) => void,
 *   setCharacter: (slot: string, path: string) => void,
 *   moveBackground: (x: number, y: number, time: number) => Promise<void> | undefined,
 *   moveCharacter: (slot: string, x: number, y: number, time: number) => Promise<void> | undefined,
 *   transformBackground: (rotation: number, scale: number, time: number) => Promise<void> | undefined,
 *   transformCharacter: (slot: string, rotation: number, scale: number, time: number) => Promise<void> | undefined,
 *   transformCharacterPoint: (slot: string, handle: string, x: number, y: number, time: number) => Promise<void> | undefined,
 *   moveCharacterPoint: (slot: string, handle: string, dx: number, dy: number, time: number) => Promise<void> | undefined,
 *   choose: (labels: string[]) => Promise<number>,
 *   clear: () => void, isEmpty: () => boolean,
 *   backgroundPath: () => string | null }}
 *
 *   The ones that animate answer a promise that resolves when the change they
 *   were asked for is over, or `undefined` when it takes no time at all — and
 *   the two free transforms also answer `undefined` while the character has no
 *   box yet, having kept the call for when its bitmap arrives.
 */
export function createStage({
  element,
  surface,
  resolveAsset,
  // Sounds are inlined the same way pictures are, but read through a reader
  // that accepts audio kinds; a host that offers one passes it here.
  resolveAudio = resolveAsset,
  // Videos need their own reader too: the image one refuses anything that is
  // not a picture, and a video is far larger than an image's 32 MB allowance.
  resolveVideo = resolveAsset,
  onError = () => {},
  // Fed each line as it is shown (not while replaying a save), so the host can
  // keep a backlog; the stage itself does not read the text it performs.
  onLine = () => {},
  // The project's default typewriter mode (`off` / `fast` / `medium` / `slow`).
  // A style file that names its own `text.typeSpeed` overrides it; this is only
  // what a style saying nothing falls back to.
  typewriter = "off",
  // Turns a path id into the path a `followPath` call walks. The stage does not
  // read files, so the host supplies this; answering `null` means the path is
  // missing, which `onMissingPath` reports without failing the run.
  resolvePath = () => null,
  onMissingPath = () => {},
  // A host that draws the object's outline needs to know when its real
  // rectangle is available. Until the bitmap is decoded, `objectBox()` can only
  // answer the frame it stands in (1920×1080), so an outline drawn before that
  // is the size of the whole stage rather than of the picture. The stage tells
  // the host once `adopt()` has measured the bitmap, so it can measure again.
  onObjectBox = () => {},
}) {
  if (!element || !surface) {
    throw new Error("createStage 需要舞台元素");
  }

  // The layers are built once and never reordered. The dialogue box stays above
  // the pictures and a question above the box; between the backdrop and the
  // characters, order comes from the elements' own z-index (see
  // `applySceneOrder`), so a character can stand behind the backdrop.
  const background = createLayer("background");
  // 背景的默认深度是 1，角色的默认是 0。Pamela 里 z 越大越远，所以背景总比
  // 角色远一层、垫在后面，角色刚建出来就不会被背景挡住。深度仍然可以改。
  background.z = BACKGROUND_DEPTH;
  const character = createLayer("character");
  const dialogue = createLayer("dialogue");
  const choice = createLayer("choice");
  // The two new layers are appended last so the first four keep their place:
  // hosts and tests reach a backdrop or a character by its child index. CSS
  // gives them their real stacking order (under the dialogue and the question).
  const videoLayer = createLayer("video");
  const effectLayer = createLayer("effect");
  // Text is appended after the five drawn layers so a Text object paints over
  // the pictures, videos and particles; CSS gives it a z-index under the
  // dialogue box and the question.
  const textLayer = createLayer("text");
  // The light layer joins last for the same reason the two above did: the seven
  // children before it keep their indices, and CSS puts the light over the
  // pictures, the video, the particles and the text, but under the dialogue box.
  const lightLayer = createLayer("light");

  // --- `stage.pamela()` 的开场动画 --------------------------------------------
  //
  // 一张盖住整个镜头的画布，排在坐标轴之上。它与 MP4 导出共用
  // `ui/pamela-intro.js` 里同一份时间线，所以两边看到的每一帧都一样。
  const introLayer = createLayer("intro");
  const introCanvas = document.createElement("canvas");
  introCanvas.className = "pamela-intro";
  introCanvas.width = STAGE_WIDTH;
  introCanvas.height = STAGE_HEIGHT;
  introLayer.node.append(introCanvas);
  const introCtx = introCanvas.getContext ? introCanvas.getContext("2d") : null;
  /** Incremented whenever an intro is abandoned, so its frames stop painting. */
  let introTicket = 0;
  /** The interpreter is waiting on this promise while the intro plays. */
  let introResolve = null;

  /** Stops an intro in flight and answers the pending wait. */
  const clearIntro = () => {
    introTicket += 1;
    introCtx?.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
    const resolve = introResolve;
    introResolve = null;
    resolve?.();
  };

  /**
   * Plays the opening for about three seconds.
   *
   * A replay or a preview travels rather than performs: `duration()` answers 0
   * there, so the overlay is cleared at once and the run does not wait.
   *
   * @returns {Promise<void> | undefined}
   */
  const pamelaIntro = () => {
    const ms = duration("Stage", PAMELA_INTRO_MS);
    if (ms <= 0) {
      clearIntro();
      return undefined;
    }
    clearIntro();
    const ticket = introTicket;
    const clock =
      typeof performance === "object" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now();
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (run) => setTimeout(run, 16);
    const started = clock();
    return new Promise((resolve) => {
      introResolve = resolve;
      const paint = () => {
        if (ticket !== introTicket) {
          resolve();
          return;
        }
        const state = pamelaIntroState(clock() - started, ms);
        introCtx?.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
        if (introCtx) {
          drawPamelaIntro(introCtx, { width: STAGE_WIDTH, height: STAGE_HEIGHT }, state);
        }
        if (state.done) {
          introTicket += 1;
          introResolve = null;
          introCtx?.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
          resolve();
          return;
        }
        frame(paint);
      };
      frame(paint);
    });
  };

  // --- crood：每个对象自己的三维坐标轴 ------------------------------------
  //
  // 轴不属于任何一个对象的图层：它是一张盖在整幅画面上的透明 canvas，读的是
  // 舞台此刻真正用来画对象的姿态（图片层的 frame、灯的 params、视频的 frame）。
  // `croodOn` 只记「哪些对象开了轴」，默认是空的 —— 也就是默认隐藏。
  const croodOn = new Set();

  // --- 透光：灯的光穿不穿过这个对象 -----------------------------------------
  //
  // 键与坐标轴、灯的排除用同一套（`background` / `character:<slot>` / …）。
  // 默认按类型定：角色是一张挡在灯前面的纸，默认挡光；其余类型此刻都不在灯层
  // 里，光本来就从它们中间穿过去，所以默认透光。作者写了 `translucent(...)`
  // 之后，值就记在这里。
  const lightPass = new Map();

  /**
   * 灯层上此刻有没有东西。
   *
   * 没有灯的场景里，对象每动一帧都排一次「画一张空画布」纯粹是白烧帧 —— 而那
   * 些场景（大多数剧本）压根用不到灯。清场时归假（见 `clear`）。
   */
  let lightPainted = false;

  /** 这个键此刻透不透光：写过的按写下的，没写过的按类型。 */
  const translucentOf = (key) => lightPass.get(key) ?? !String(key ?? "").startsWith("character:");

  // --- 轮廓光：逆光时这个对象勾不勾边 -----------------------------------------
  //
  // 键与透光、坐标轴同一套。强度 0–1，默认 0：不写就不勾边，勾边是对象的打光
  // 决定，不该由「场上有一盏灯」替作者定。真的画不画还要看灯自己的 `bloom`
  // 与前后关系，见 `ui/light.js` 的 `paintRim`。
  const rimOf = new Map();

  /** 这个键此刻的轮廓光强度。 */
  const rimLightOf = (key) => rimOf.get(key) ?? 0;

  // --- 抗锯齿：角色缩放时怎么取像素 ------------------------------------------
  //
  // 键与透光、轮廓光同一套，值是 `{ smooth, edges }` 两档强度（0–2）。**默认
  // 全 0，也就是关**：位图按最近的像素取，边是硬的（像素画就该这样）。`aa`
  // 柔化整张图，`eaa` 只柔化轮廓 —— 记的是强度而不是开关，0 与「没登记」同一个
  // 意思。记键而不是记元素：换表情会换掉元素（见 `setCharacter`），强度得跟着
  // 槽位活下来。
  const antialiasOn = new Map();

  /** 这个键此刻的两档强度；没登记就是都不开。 */
  const antialiasOf = (key) => antialiasOn.get(key) ?? { smooth: 0, edges: 0 };

  /**
   * 处理过的位图，按「哪张图 + 哪一档强度」记着它的 blob 地址。
   *
   * 处理一张 1080p 的位图要拍快照、模糊、编码，几十毫秒起步；而剧本每次重放都
   * 会把角色重新加载一遍。只按元素缓存的话，每一遍都得重算，所以按图路径记在
   * 这里，跨加载、跨角色共用同一张处理结果。
   */
  const antialiasUrls = new Map();

  /** 画在原点旁的名字：`character:hero` 只写 `hero`。 */
  const axesLabel = (key) => {
    const at = String(key).indexOf(":");
    return at < 0 ? String(key) : String(key).slice(at + 1);
  };

  /** 图层 frame 里还放着 DOM 节点与网格，轴只需要这几个数。 */
  const poseOfEntry = (entry) => ({
    x: entry.x,
    y: entry.y,
    z: entry.z,
    rotation: entry.rotation,
    rotateH: entry.rotateH,
    rotateV: entry.rotateV,
    scale: entry.scale,
    opacity: entry.opacity,
    visible: entry.visible,
  });

  /** 按对象键找出它此刻的姿态；没上台或没有三维坐标的对象交回 null。 */
  const objectPose = (key) => {
    if (key === "background") {
      return background.image ? poseOfEntry(background) : null;
    }
    const at = String(key).indexOf(":");
    const kind = at < 0 ? "" : key.slice(0, at);
    const slot = at < 0 ? "" : key.slice(at + 1);
    if (kind === "character") {
      const entry = characters.get(slot);
      return entry?.image ? poseOfEntry(entry) : null;
    }
    if (kind === "text") {
      const entry = texts.get(slot);
      return entry?.image ? poseOfEntry(entry) : null;
    }
    if (kind === "light") {
      for (const light of lights) {
        if (light.axesKey === key && light.placed) {
          // 过渡中的灯有 `live`：轴跟着画面值走，不提前跳到终点。
          const pose = { ...light.params, ...(light.live ?? {}) };
          // 灯的 `rotate` 是画面里的那次转动，不在 `orientationOf` 的三个角里，
          // 所以三根轴自己算好交出去 —— 覆盖层与那束光才同向。
          return { ...pose, orientation: lightOrientation(pose) };
        }
      }
      return null;
    }
    if (kind === "video") {
      return video.axisPose?.(slot) ?? null;
    }
    // 音频与粒子没有三维坐标，写了 `crood(true)` 不会凭空长出轴。
    return null;
  };

  const axesFrames = () => {
    const frames = [];
    for (const key of croodOn) {
      const pose = objectPose(key);
      if (pose && pose.visible !== false && pose.opacity !== 0) {
        frames.push(axesOf(pose, { key, label: axesLabel(key), perspective: perspectiveOn }));
      }
    }
    return frames;
  };

  // 第九层也接在最后：前八层的 child index 一个不动，CSS 把轴放在所有画面
  // 与界面之上。开着轴的对象哪怕还没 enable，逐帧循环也继续等它上台。
  const axesLayer = createAxesLayer({
    size: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    scale: 0.5,
    read: axesFrames,
    active: () => croodOn.size > 0,
    schedule: (run) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => run());
      } else {
        setTimeout(run, 16);
      }
    },
  });

  // --- 空间透视与参考线 ----------------------------------------------------
  //
  // 透视默认关着：正交空间里 z 只决定谁盖住谁，远近不改变大小。打开之后
  // 相机才有灭点，z 越大的对象越远、越小。
  //
  // 参考线是同一套空间的尺子：舞台平面上的横纵线，加上沿深度方向的线。
  // 透视关着时后者在画面上退化成一个点，所以只看得到横纵两组。
  let perspectiveOn = false;
  let guidelineOn = false;
  let guidelineEvery = GUIDELINE_INTERVAL;

  const guidelineLayer = createGuidelineLayer({
    size: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    scale: 0.5,
  });

  /** 参考线此刻的设置；`settle` 之后掉到画布上。 */
  const guidelineState = () => ({
    enabled: guidelineOn,
    interval: guidelineEvery,
    perspective: perspectiveOn,
  });

  /** `object_name.crood(true/false)` 落到这里；没登记就是隐藏。 */
  const setCrood = (key, visible) => {
    if (!key) {
      return false;
    }
    const next = boolArg(visible);
    if (next) {
      croodOn.add(key);
    } else {
      croodOn.delete(key);
    }
    axesLayer.invalidate();
    return next;
  };

  surface.replaceChildren(
    background.node, character.node, dialogue.node, choice.node,
    videoLayer.node, effectLayer.node, textLayer.node, lightLayer.node,
    axesLayer.node, guidelineLayer.node, introLayer.node,
  );

  // Sounds are not a layer: they play on their own and are stopped when the
  // stage is cleared, which is the only part of them the stage owns. They are
  // built before the box because a line may bind its cut to a voice track.
  const audio = createAudioFactory({
    resolveAsset: resolveAudio,
    isReplaying: () => replaying,
    onError,
  });

  // 自动配音效果音合成器：仅在 `autoVoice(true)` 时对无显式配音的台词生效。
  // 单位音效是引擎自带的一段固定音频（随应用打包，任何项目都有），
  // 按字数决定次数、按 `autoVoice(speed)` 决定速度播放。
  const voiceEffect = createVoiceEffect({ onError });
  // `stage.autoVoice` 的开关与播放速度（次/秒），默认关闭 / 默认 10；随演出（舞台重建）重置。
  let autoVoiceOn = false;
  let autoVoiceSpeed = AUTOVOICE_DEFAULT_SPEED;

  // Effects are built into the engine: they draw themselves, so no reader is
  // needed. Videos read `assets/Video/` through the host's video reader.
  const effect = createEffectFactory({
    layer: effectLayer.node,
    size: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    isReplaying: () => replaying,
    isPreviewing: () => previewing,
    onError,
  });
  const video = createVideoFactory({
    layer: videoLayer.node,
    resolveAsset: resolveVideo,
    size: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    isReplaying: () => replaying,
    isPreviewing: () => previewing,
    perspective: () => perspectiveOn,
    onError,
  });

  // The box fills its own layer; the stage owns the layer and asks the box to
  // clear when the stage does.
  const box = createDialogue({
    element,
    node: dialogue.node,
    resolveAsset,
    isReplaying: () => replaying,
    // A preview draws the line but does not wait for it: the frame being
    // travelled to includes the dialogue box, and a click nobody makes would
    // otherwise hang the run before the editor ever opens.
    isPreviewing: () => previewing,
    onError,
    onLine,
    typewriter,
    // A `say(text, time, audio)` naming a track is cut when that track ends.
    onVoice: (name) => audio.voice(name),
    // 手动推进 / 切句时中断显式 audio 配音。
    onVoiceStop: (name) => audio.stopVoice?.(name),
    // 自动配音开关与合成效果音：无显式 audio 的台词自动配效果音。
    getAutoVoice: () => autoVoiceOn,
    synthVoice: (chars) => voiceEffect.play(chars, autoVoiceSpeed),
  });

  // A question owns the choice layer the same way the box owns the dialogue
  // one: the stage asks it to clear, and never looks inside it.
  const chooser = createChoices({ node: choice.node });

  // Each character gets its own entry, keyed by the slot it draws in. Holding
  // the image and its ticket here — rather than on the layer — is what lets
  // several characters load and be replaced independently.
  const characters = new Map();

  /**
   * The text objects on the stage, keyed by the slot they draw in.
   *
   * A Text reads no asset, so its entry needs none of the picture bookkeeping
   * (mesh, ticket, decoded size); it is the frame the shared `move` / `turn` /
   * `fade` write to, plus the words and the two style values that are the
   * element's own.
   */
  const texts = new Map();

  /**
   * The name each slot speaks under, kept beside the slot rather than on the
   * object a script built.
   *
   * A script changes a character's expression by rebuilding the variable —
   * `hero = Character("hero_sad.png")` — and the new object is a new object:
   * its own `displayName` starts at `undefinedName`. The slot, though, is the
   * same one, so the name belongs to the slot and survives the rebuild. A new
   * run clears the map, because a fresh script names its characters again.
   */
  const characterNames = new Map();

  /**
   * The slots on the stage, back to front.
   *
   * Declared here because `clear` puts it back to nothing: a new run's
   * characters are drawn in the order that run enables them, not in whatever
   * order the previous run happened to leave.
   */
  const characterOrder = [];

  /**
   * 每个槽位正在跑的那一组逐帧播放（还有背景的那一个）。
   *
   * 播放器住在对象上，这里只留「谁是当前的那一个」：同一个槽位被重建时，
   * 旧的播放器要停下，否则两个计时器会轮流往同一个槽位里塞图；清空舞台时
   * 也要全部停下，计时器不该在画面之外继续跑。
   */
  const spritePlayers = new Map();

  /** 登记一个播放器，顺带停掉它顶替的那个。 */
  const registerSprite = (kind, name, player) => {
    const key = `${kind}:${name}`;
    const previous = spritePlayers.get(key);
    if (previous && previous !== player) {
      previous.stop();
    }
    spritePlayers.set(key, player);
  };

  /** 停掉所有逐帧播放，清空登记表。 */
  const stopSprites = () => {
    for (const player of spritePlayers.values()) {
      player.stop();
    }
    spritePlayers.clear();
  };

  let empty = true;

  /** The stage is empty until something is drawn on one of its layers. */
  const refreshEmpty = () => {
    empty = !background.node.firstChild
      && characters.size === 0
      && texts.size === 0
      && !videoLayer.node.firstChild
      && !effectLayer.node.firstChild;
    element.classList.toggle("is-empty", empty);
  };

  // The tint bookkeeping is declared here rather than beside the functions that
  // use it, because `clear` has to put it back to nothing: a filter is only
  // meaningful for the picture it was painted on, and that picture is about to
  // go. Leaving them behind would grow `<defs>` by one filter per tinted image
  // per run, for the life of the window.
  let tintDefs = null;
  let tintSeq = 0;
  const tintFilters = new Map();

  /**
   * Clears one subsystem on its own.
   *
   * A stage that has already broken — a removed node, a failed media element —
   * can throw from any of these calls. Stopping at the first failure used to
   * leave the rest of the old run alive (music playing, frames still drawing,
   * a question still waiting) on top of the next run, which is what made a
   * re-launch fail. Every step still gets its turn.
   */
  const clearStep = (step) => {
    try {
      step();
    } catch (error) {
      console.error("[pamela] stage clear step failed", error);
    }
  };

  /** Eases still stepping, so a reset can stop them writing to removed nodes. */
  const runningEases = new Set();
  const cancelFrame =
    typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;

  const clear = () => {
    // 开场动画属于上一场演出：清舞台时连它一起停，并解开解释器还在等的那个
    // Promise，否则下一句台词会被一段已经不存在的动画卡住。
    clearIntro();
    for (const entry of [...runningEases]) {
      entry.cancel();
    }
    runningEases.clear();
    // 逐帧播放属于上一场演出：清空舞台时停下，否则计时器会继续往已经清掉的
    // 槽位里换图，一段 `fps(16, true)` 能把整个窗口拖住。
    stopSprites();
    background.ticket += 1;
    clearStep(() => stopGif(background));
    background.image = null;
    // Nothing is drawn any more, so the stage has no picture to name — a save
    // made after a reset must not record the previous run's backdrop.
    background.path = null;
    // 深度属于脚本这一次的演出：上一场的 z 不能把下一场的背景留在原处。
    // 回到 `BACKGROUND_DEPTH`，也就是「背景在角色后面」的默认层。
    background.z = BACKGROUND_DEPTH;
    clearStep(() => background.node.replaceChildren());
    // The backdrop's tint goes with the backdrop: `setBackground` repaints a
    // remembered one, so a colour left here would be laid over the next run's
    // picture — a night scene's blue over a daylight one. The look goes with it
    // for the same reason: a blur is not the next scene's.
    background.tintColor = null;
    background.look = neutralLook();
    // A `step` still waiting for a picture belongs to the run that asked for it.
    background.pendingStep = undefined;
    for (const entry of characters.values()) {
      entry.ticket += 1;
      clearStep(() => stopGif(entry));
      // A journey still in flight keeps mutating the entry it was told to draw;
      // leaving it running across a reset lets the next run inherit a
      // half-finished move. Stop it before the entry goes.
      clearStep(() => cancelPath(entry));
    }
    characters.clear();
    characterNames.clear();
    // The drawing order belongs to the run that established it: a new run's
    // characters go in the order that run enables them.
    characterOrder.length = 0;
    clearStep(() => character.node.replaceChildren());
    texts.clear();
    clearStep(() => textLayer.node.replaceChildren());
    // A filter is keyed by the entry it paints; with every entry gone, they are
    // all unreachable, and so are the `<feColorMatrix>` nodes holding them.
    tintFilters.clear();
    clearStep(() => tintDefs?.replaceChildren());
    // A line or a question left waiting would otherwise hang the run that asked
    // for it: the interpreter only checks whether a run was dropped between
    // statements, and a run parked on a promise is not between any. Clearing
    // lets it go.
    clearStep(() => box.clear());
    clearStep(() => chooser.clear());
    clearStep(() => audio.clear());
    // A frame loop or a video element left behind would keep drawing or
    // playing over the next run, so both factories retire their own objects.
    clearStep(() => video.clear());
    clearStep(() => effect.clear());
    clearStep(() => videoLayer.node.replaceChildren());
    clearStep(() => effectLayer.node.replaceChildren());
    // Lights belong to the run that switched them on, and so does the ambient
    // brightness: a night scene's 0.35 must not dim the next scene's daylight.
    clearStep(() => lights.clear());
    clearStep(() => setAmbient(1));
    clearStep(() => {
      lightRig.clear();
      lightPainted = false;
    });
    // 坐标轴属于这一场演出：下一场不该继承上一场打开的调试轴。
    clearStep(() => {
      croodOn.clear();
      axesLayer.clear();
    });
    // 透光与轮廓光同理：下一场的角色回到「挡光、不勾边」，
    // 不该继承上一场的布光。
    clearStep(() => lightPass.clear());
    clearStep(() => rimOf.clear());
    // 抗锯齿也是布景的一部分：下一场回到默认的硬边。
    clearStep(() => antialiasOn.clear());
    // 透视与参考线也是这一次演出的设置：下一场回到默认（正交空间、无参考线）。
    clearStep(() => {
      perspectiveOn = false;
      guidelineOn = false;
      guidelineEvery = GUIDELINE_INTERVAL;
      guidelineLayer.clear();
    });
    clearStep(refreshEmpty);
  };

  /** The clock the mesh's own animations are measured against. */
  const now = () => Date.now();

  /**
   * Asks for the next frame of a mesh animation.
   *
   * A browser's frame callback is what an animation should be driven by, but a
   * document with no rendering at all — the one the tests build over — has
   * none, so a plain timer stands in and the animation still runs to its end.
   */
  const nextFrame =
    typeof requestAnimationFrame === "function"
      ? (run) => requestAnimationFrame(() => run())
      : (run) => setTimeout(run, 16);

  /**
   * Runs `apply` from nothing to everything over `time` milliseconds.
   *
   * A mesh has no CSS transition to lean on — its eight points are numbers in
   * this module — so a change that takes time is interpolated here instead.
   * `apply` is handed the share of the way in, ending on exactly 1, and the
   * promise that comes back is the same one the plain path answers with: the
   * change is over when the duration says so, whatever the frame rate did.
   *
   * @param {number} time Milliseconds the change takes; zero is at once.
   * @param {(progress: number) => void} apply Draws the change `progress` of
   *   the way in.
   * @returns {Promise<void> | undefined} `undefined` for a change with no
   *   duration to wait out, as the rest of the stage answers.
   */
  const eased = (time, apply) => {
    if (!(time > 0)) {
      apply(1);
      return undefined;
    }
    const started = now();
    let frame = 0;
    let cancelled = false;
    const entry = {
      cancel: () => {
        cancelled = true;
        cancelFrame(frame);
      },
    };
    const step = () => {
      if (cancelled) {
        return;
      }
      const progress = Math.min(1, (now() - started) / time);
      apply(progress);
      if (progress < 1) {
        frame = nextFrame(step);
      } else {
        runningEases.delete(entry);
      }
    };
    runningEases.add(entry);
    frame = nextFrame(step);
    return settled(time);
  };

  // --- lights ---------------------------------------------------------------
  //
  // 灯不是元素：这一层是整块画面的光，由 `ui/light.js` 画在整帧大小的 canvas
  // 上，再以 `screen` 叠到画面上——所以灯只会提亮，不会压暗。所有灯在同一张
  // 画布上以加色累加，这就是「两盏灯相互干涉」的混合光。
  //
  // The layer is drawn at half the logical size: a light is a soft blob, so half
  // resolution costs nothing to look at and a quarter of the pixels to fill.

  /** 场上的灯，按 `enable` 的先后。 */
  const lights = new Set();
  /** 环境亮度，0–2；1 是原样。 */
  let lightAmbient = 1;

  /**
   * The objects a light can fall on, as silhouettes.
   *
   * Only the backdrop and the characters have a bitmap the layer can draw: the
   * video draws itself into a `<video>` element, a particle layer is a canvas
   * with nothing to outline, and text is a DOM node whose shape the layer would
   * have to re-typeset to know. Those are still lit by the light's own screen
   * blend — what they cannot do is cast a rim glow or be excluded by name.
   */
  const litObjects = () => {
    const list = [];
    /**
     * 一个对象在灯层里的剪影。跟着透视走：远处的对象在画面里更小、更靠中心；
     * 转过身之后交出去的是投影后的四个角，边光才贴着它真正的轮廓。
     */
    const silhouetteOf = (entry, key, bitmap) => {
      const box = boxOf(entry);
      // 透光的对象不按深度挡灯（见 `ui/light.js` 的 `holesOf`）：角色默认挡，
      // 背景、文字这些默认让光穿过去。
      const cast = !translucentOf(key);
      // 逆光的轮廓光强度：0 表示不勾边（`ui/light.js` 的 `paintRim`）。
      const rim = rimLightOf(key);
      // 剪影的取样跟着角色自己的抗锯齿：关着的角色，边光也得是硬边。
      const smooth = key === "background" || antialiasIsOn(antialiasOf(key));
      if (!isFlatPose(entry)) {
        const pose = projectPose(entry, box, { perspective: perspectiveOn });
        return {
          key,
          bitmap,
          x: pose.center.x,
          y: pose.center.y,
          z: entry.z ?? 0,
          w: box.w,
          h: box.h,
          rotation: 0,
          scale: 1,
          scaleX: 1,
          scaleY: 1,
          cast,
          rim,
          smooth,
          corners: CORNERS.map((handle) => pose.corners[handle]),
        };
      }
      const flat = depthScale(entry.z, perspectiveOn);
      return {
        key,
        bitmap,
        x: entry.x * flat,
        y: entry.y * flat,
        z: entry.z ?? 0,
        w: box.w * flat,
        h: box.h * flat,
        rotation: entry.rotation,
        scale: entry.scale,
        scaleX: entry.scaleX ?? 1,
        scaleY: entry.scaleY ?? 1,
        cast,
        rim,
        smooth,
      };
    };
    if (background.image) {
      // 背景同样在表里：它要参与「按自身像素提亮」（灯照到的那块地面真变亮），
      // 而勾不勾边由它自己的 `轮廓光` 决定 —— 整帧的边光只会糊成一片，所以
      // 默认 0，作者不特意写就不勾。
      list.push(silhouetteOf(background, "background", background.image));
    }
    for (const [slot, entry] of characters) {
      if (!entry.image || !(entry.opacity > 0)) {
        continue;
      }
      list.push(silhouetteOf(entry, `character:${slot}`, entry.image));
    }
    return list;
  };

  const lightRig = createLightLayer({
    size: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    scale: 0.5,
    objects: litObjects,
    schedule: (run) => nextFrame(run),
  });
  lightLayer.node.append(lightRig.node);

  /** 一盏灯此刻该画的参数：正在过渡时用画面值，否则用对象上的目标值。 */
  const lightPayloadOf = (light) => {
    const source = light.live ? { ...light.params, ...light.live } : light.params;
    return { ...normalizeLight(source), excluded: light.excluded };
  };

  /**
   * 对象在舞台上的矩形，算逆光暗部用。和灯层读的剪影同一个位置与大小
   * （宽度要乘 `scale`，那是对象自己的缩放；`perspectiveOn` 时还要乘深度）。
   */
  const shadeRectOf = (entry) => {
    const flat = depthScale(entry.z, perspectiveOn);
    const scale = entry.scale ?? 1;
    return {
      x: (entry.x || 0) * flat,
      y: (entry.y || 0) * flat,
      w: (entry.w ?? STAGE_WIDTH) * scale * flat,
      h: (entry.h ?? STAGE_HEIGHT) * scale * flat,
    };
  };

  /**
   * 逆光压暗：灯站在对象背后时，对象正面本来就照不到，只该剩一个暗部剪影。
   *
   * 灯层只能加光（`screen`），暗部加不出来，所以这里算的是一个亮度系数，写进
   * 对象自己的 `filter: brightness()`（与作者写的 `look.brightness` 相乘）。
   * 透光的对象不挡光，也就不吃自己的影子。
   *
   * @param {Array<object>} placed 此刻亮着的灯（已归一化）。
   */
  const paintShades = (placed) => {
    const targets = [["background", background]];
    for (const [slot, entry] of characters) {
      targets.push([`character:${slot}`, entry]);
    }
    for (const [key, entry] of targets) {
      const shade = translucentOf(key)
        ? 1
        : lightShadeOf(placed, shadeRectOf(entry), entry.z ?? 0, key);
      if (shade === entry.shade) {
        continue;
      }
      entry.shade = shade;
      paintFilters(entry);
    }
  };

  /** 重画灯层；同一帧里的多次改动会并成一次。 */
  const touchLights = () => {
    const placed = [...lights].filter((light) => light.placed);
    const payloads = placed.map(lightPayloadOf);
    // 暗部跟着灯走，所以每次灯或对象动了都要重算一遍。
    paintShades(payloads);
    // 场上没有灯、灯层上也没有残留：这一帧不必排。
    if (!placed.length && !lightPainted) {
      return;
    }
    lightPainted = placed.length > 0;
    lightRig.invalidate(payloads);
  };

  /**
   * `object.translucent(true/false)` 落到这里：这个键挡不挡灯。
   *
   * 只改判据不碰画面：灯层读的是同一份对象表，所以重画一次就到位了。
   *
   * @param {string} key `background` / `character:<slot>` / …
   * @param {unknown} value 真值即透光。
   * @returns {boolean} 记下的值。
   */
  const setTranslucent = (key, value) => {
    if (!key) {
      return false;
    }
    lightPass.set(key, boolArg(value));
    touchLights();
    return boolArg(value);
  };

  /**
   * `object.rim(强度)` 落到这里：这个对象勾边的强度，0–1。
   *
   * 超界的数按边界处理（与滤镜、灯的数值同一个脾气）：1.5 就是最亮的一档，
   * 负数就是不勾边。
   *
   * @param {string} key `background` / `character:<slot>` / …
   * @param {unknown} value 强度，0–1。
   * @returns {number} 记下的强度。
   */
  const setRim = (key, value) => {
    if (!key) {
      return 0;
    }
    const amount = Math.min(1, Math.max(0, Number(value) || 0));
    rimOf.set(key, amount);
    touchLights();
    return amount;
  };

  /**
   * 处理过的位图换到元素上：一张同尺寸的画布 → blob → `src`。
   *
   * 为什么要换 `src` 而不是换元素：位图角色是 `<img>`，八点自由变换画在八个
   * 指向同一张图的切片上，动画的 `transition` 也挂在元素自己身上 —— 换元素等于
   * 把在跑的移动和切片一起弄丢（见 `setCharacter` 的注释）。换 `src` 这两样都
   * 留着，网格切片跟着指过去就是同一张处理过的图。
   *
   * 处理是从 `entry.plain` 那张快照读的，不是从元素自己：元素一旦显示的就是
   * 处理过的图，再处理一遍会一层层叠上去。第一次处理时把原图截一份留着，之后
   * 改强度都从它重来。
   *
   * 编码与解码都是异步的，所以带一个票号：连着改两次强度，只有最后那次落到
   * 元素上，中间那次的 blob 会被丢弃。
   */
  const applyAntialias = (entry, slot) => {
    if (!entry) {
      return;
    }
    const modes = antialiasOf(`character:${slot}`);
    const wanted = `${modes.smooth}|${modes.edges}`;
    // 关掉：回到原图。`plainUrl` 就是为这一刻留的。
    if (!antialiasIsOn(modes)) {
      const previous = entry.smoothUrl;
      entry.smoothUrl = null;
      entry.smoothKey = "";
      if (previous && entry.plainUrl) {
        setSource(entry, entry.plainUrl);
      }
      return;
    }
    // 同一个强度已经在这个元素上了就不必重来：`load` 换元素时会清掉这个键。
    if (entry.smoothKey === wanted) {
      return;
    }
    // 这张图在这一档强度上处理过：直接换上那一张，连编码都不必重来。剧本每次
    // 重放都会把角色重新加载一遍，没有这一层，每一遍都要重算整张位图。
    const cacheKey = entry.path ? `${entry.path}|${wanted}` : "";
    const cached = cacheKey ? antialiasUrls.get(cacheKey) : null;
    if (cached) {
      entry.smoothKey = wanted;
      entry.smoothUrl = cached;
      setSource(entry, cached);
      return;
    }
    const plain = plainOf(entry);
    const processed = plain
      ? antialiasBitmap(plain, plain.width, plain.height, modes, makeCanvas)
      : null;
    const canvas = processed?.canvas;
    if (!canvas || typeof canvas.toBlob !== "function") {
      // 处理不了（node 测试、没有画布的宿主）：留在 `image-rendering` 那一档上。
      return;
    }
    entry.smoothKey = wanted;
    const ticket = (entry.smoothTicket = (entry.smoothTicket ?? 0) + 1);
    canvas.toBlob((blob) => {
      if (!blob || typeof URL?.createObjectURL !== "function") {
        return;
      }
      const url = URL.createObjectURL(blob);
      // 地址先进缓存：即使这一次已经被后来的强度取代，下一遍重放也用得上。
      if (cacheKey) {
        antialiasUrls.set(cacheKey, url);
      }
      if (ticket !== entry.smoothTicket) {
        return;
      }
      // 先解码好再换上去：换了 `src` 才开始解码，中间会空一帧。
      const probe = new Image();
      probe.src = url;
      probe.decode().then(
        () => {
          if (ticket !== entry.smoothTicket) {
            return;
          }
          entry.smoothUrl = url;
          setSource(entry, url);
        },
        () => {},
      );
    }, "image/png");
  };

  /** 把元素（以及它那八个切片）一起指到一张位图上。 */
  const setSource = (entry, url) => {
    entry.image.src = url;
    for (const piece of entry.mesh?.pieces ?? []) {
      piece.image.src = url;
    }
  };

  /** 建一张离屏画布。处理用的都是原图尺寸，不跟舞台的缩放走。 */
  const makeCanvas = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };

  /**
   * 原图快照。位图还没解码时交出 `null`，调用方按「先不处理」继续。
   *
   * 快照只在第一次处理时拍：一张 1080p 的位图是几兆的像素数据，拍下来跟着槽位
   * 留到下一次换表情（`load` 会把它清掉）。不拍的话，第二次改强度读到的会是
   * 已经处理过的那张图，模糊一层层叠上去。
   */
  const plainOf = (entry) => {
    const image = entry.image;
    if (!image) {
      return null;
    }
    if (entry.plain) {
      return entry.plain;
    }
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    // GIF 的帧是逐帧画进同一个 canvas 的，处理一次会被下一帧盖掉：跳过。
    if (!w || !h || image.tagName === "CANVAS") {
      return null;
    }
    const snapshot = makeCanvas(w, h);
    const context = snapshot.getContext?.("2d") ?? null;
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, w, h);
    entry.plain = snapshot;
    return snapshot;
  };

  /**
   * 把两档强度写到角色的元素上。
   *
   * 关着（都是 0）时唯一要做的是 `image-rendering: pixelated` —— 缩放交给浏览器
   * 又不想它自作主张地插值，这是唯一能让边保持硬的办法。开着时反而不该再压在
   * 浏览器那一档上：像素已经由 `antialiasBitmap` 处理过，再让浏览器取最近像素会
   * 把处理结果又切碎。
   *
   * 八点自由变换的角色画在八个切片上，`image-rendering` 是继承的，写在网格节点
   * 上一并生效。
   */
  const paintAntialias = (entry, slot) => {
    if (!entry) {
      return;
    }
    const modes = antialiasOf(`character:${slot}`);
    const css = antialiasIsOn(modes) ? "auto" : "pixelated";
    if (entry.image?.style) {
      entry.image.style.imageRendering = css;
    }
    if (entry.mesh?.node?.style) {
      entry.mesh.node.style.imageRendering = css;
    }
    applyAntialias(entry, slot);
  };

  /**
   * `character.aa(强度)` 落到这里：整张图的抗锯齿强度，0–2，0 是关。
   *
   * 默认 0。关着的时候角色缩小、放大都是硬边——像素画就该这样，糊过的轮廓反而
   * 丢了它本来的样子；写 `aa(1)` 连内部一起柔化，`aa(2)` 更软。
   *
   * 灯层的剪影也跟着这两档（见 `silhouetteOf`），边光的边缘才不会和人物自己差
   * 一档。
   *
   * @param {string} key `character:<slot>`。
   * @param {unknown} value 强度 0–2。
   * @returns {number} 记下的强度。
   */
  const setAntialias = (key, value) => {
    if (!key) {
      return 0;
    }
    const amount = antialiasAmount("抗锯齿", value);
    const current = antialiasOf(key);
    antialiasOn.set(key, { smooth: amount, edges: current.edges });
    paintForKey(key);
    return amount;
  };

  /**
   * `character.eaa(强度)` 落到这里：只柔化轮廓的抗锯齿强度，0–2，0 是关。
   *
   * 与 `aa` 分开记：一个是「整张图都软」，一个是「只有边上软」，两件事可以各调
   * 各的。两档同时大于 0 时按整图那档画（半径取大的）：整图本来就把轮廓包含在
   * 内了。
   *
   * @param {string} key `character:<slot>`。
   * @param {unknown} value 强度 0–2。
   * @returns {number} 记下的强度。
   */
  const setEdgeAntialias = (key, value) => {
    if (!key) {
      return 0;
    }
    const amount = antialiasAmount("边缘抗锯齿", value);
    const current = antialiasOf(key);
    antialiasOn.set(key, { smooth: current.smooth, edges: amount });
    paintForKey(key);
    return amount;
  };

  /** 改完强度就重画这个键对应的角色（现在只有角色有这一档）。 */
  const paintForKey = (key) => {
    const prefix = "character:";
    if (key.startsWith(prefix)) {
      paintAntialias(characters.get(key.slice(prefix.length)), key.slice(prefix.length));
    }
    touchLights();
  };

  /**
   * Walks a light's numbers to `patch` over `ms`.
   *
   * A light has no CSS transition to lean on — its values are numbers the layer
   * paints from — so a timed change is interpolated here, the way the mesh's
   * eight points are. The object keeps the target at once (that is what a
   * following relative call counts from) and the drawn values walk to it.
   *
   * @returns {Promise<void> | undefined} `undefined` for a change with no time.
   */
  const animateLight = (light, patch, ms) => {
    const from = {};
    for (const [key, value] of Object.entries(patch)) {
      const current = light.live?.[key] ?? light.params[key];
      from[key] = typeof value === "number" && Number.isFinite(current) ? current : value;
      light.params[key] = value;
    }
    if (!(ms > 0)) {
      light.live = null;
      touchLights();
      return undefined;
    }
    const run = (progress) => {
      const live = { ...(light.live ?? {}) };
      for (const [key, value] of Object.entries(patch)) {
        live[key] =
          typeof value === "number"
            ? from[key] + (value - from[key]) * progress
            : value;
      }
      light.live = live;
      touchLights();
    };
    run(0);
    const started = eased(ms, run);
    const finish = () => {
      light.live = null;
      touchLights();
    };
    started?.then(finish, finish);
    return started;
  };

  /** Puts a light on the stage, refusing more than the layer is built for. */
  const addLight = (light) => {
    if (!lights.has(light) && lights.size >= LIGHT_LIMIT) {
      throw new Error(`光源最多 ${LIGHT_LIMIT} 盏`);
    }
    lights.add(light);
    touchLights();
  };

  /** Takes a light off the stage without forgetting its numbers. */
  const removeLight = (light) => {
    lights.delete(light);
    touchLights();
  };

  /**
   * The layers the ambient brightness acts on.
   *
   * The dialogue box and the choice list are not among them: they are the
   * interface drawn over the scene, not part of what a lamp lights.
   */
  const ambientLayers = () => [
    background.node,
    character.node,
    videoLayer.node,
    effectLayer.node,
    textLayer.node,
  ];

  /** 环境亮度：整块画面的乘算亮度，0–2。 */
  const setAmbient = (value) => {
    const next = Number(value);
    if (!Number.isFinite(next)) {
      throw new Error("环境亮度需要 0–2 的数字");
    }
    lightAmbient = Math.min(2, Math.max(0, next));
    const css = lightAmbient === 1 ? "" : `brightness(${lightAmbient})`;
    for (const node of ambientLayers()) {
      if (node?.style) {
        node.style.filter = css;
      }
    }
    return lightAmbient;
  };

  /** The key a lit object answers to when a light excludes it by name. */
  const litKeyOf = (object) => {
    if (object?.kind === "Background") {
      return "background";
    }
    if (object?.kind === "Character") {
      return `character:${object.slot}`;
    }
    return null;
  };

  /** 排除/不排除：两个列表都必须有内容，且对象得是有轮廓的那种。 */
  const applyExclusion = (sources, targets, add) => {
    if (!Array.isArray(sources) || !sources.length) {
      throw new Error("排除至少需要一盏光源");
    }
    if (!Array.isArray(targets) || !targets.length) {
      throw new Error("排除至少需要一个对象");
    }
    for (const source of sources) {
      if (source?.kind !== "Light") {
        throw new Error("排除的冒号前面只能是光源");
      }
      for (const target of targets) {
        const key = litKeyOf(target);
        if (!key) {
          throw new Error("光照只能排除背景与角色");
        }
        if (add) {
          source.excluded.add(key);
        } else {
          source.excluded.delete(key);
        }
      }
    }
    touchLights();
  };

  const exclude = (sources, targets) => applyExclusion(sources, targets, true);
  const unexclude = (sources, targets) => applyExclusion(sources, targets, false);

  /**
   * 按当前的投影把整幅画面重画一次。
   *
   * 透视开关改变的是「同一个姿态落到画面哪里」，与剧本里的数无关，所以不能
   * 只改一个全局变量：已经摆好的图片、网格、视频与灯的剪影都得按新投影再算
   * 一遍，否则要等下一次移动才会跟上。
   */
  const redrawProjection = () => {
    for (const entry of [background, ...characters.values(), ...texts.values()]) {
      if (entry?.image) {
        draw(entry);
      }
    }
    video.repaint?.();
    // 灯的剪影跟着透视走（远处的对象更小、更靠中心）。
    lightRig.invalidate?.();
    // 坐标轴的端点也是逐点投影出来的。
    axesLayer.invalidate?.();
  };

  /**
   * 空间透视：`stage.perspective(true)` 打开灭点，`false` 回到正交空间。
   *
   * 默认关着。关着时深度只决定谁盖住谁，同一个 z 方向上的物体在画面里完全
   * 重叠；打开之后 z 越大越远、越小，近大远小。
   */
  const setPerspective = (value) => {
    const next = value === undefined || value === null ? true : boolArg(value);
    if (next === perspectiveOn) {
      return perspectiveOn;
    }
    perspectiveOn = next;
    redrawProjection();
    guidelineLayer.update(guidelineState());
    return perspectiveOn;
  };

  /**
   * 空间参考线：`stage.guideline(true, 100)`。
   *
   * `interval` 省略时保持上一次的间隔（初始 100），最小 10。关掉参考线时
   * 间隔仍然记着，下次打开还是同一个密度。
   */
  const setGuideline = (value, interval) => {
    guidelineOn = value === undefined || value === null ? true : boolArg(value);
    if (interval !== undefined && interval !== null) {
      guidelineEvery = guidelineInterval(interval);
    }
    guidelineLayer.update(guidelineState());
    return guidelineOn;
  };

  /**
   * Builds an SVG element, falling back to a plain element when the namespace
   * call is unavailable (the node tests stub `document` without it). The filter
   * is only ever created lazily, once a script asks for a tint, so the stage
   * builds in node without it.
   */
  const createSvg = (name) =>
    typeof document.createElementNS === "function"
      ? document.createElementNS("http://www.w3.org/2000/svg", name)
      : document.createElement(name);

  /** The shared `<defs>` the tint filters live in, built on first use. */
  const ensureTintDefs = () => {
    if (!tintDefs) {
      const svg = createSvg("svg");
      svg.setAttribute?.("aria-hidden", "true");
      Object.assign(svg.style, { position: "absolute", width: "0", height: "0" });
      tintDefs = createSvg("defs");
      svg.append(tintDefs);
      element.append(svg);
    }
    return tintDefs;
  };

  /**
   * Returns the `<feColorMatrix>` for `entry`, creating its filter the first
   * time. The matrix starts as the identity and is filled in by `paintTint`.
   */
  const ensureTintFilter = (entry) => {
    let record = tintFilters.get(entry);
    if (!record) {
      const id = `pamela-tint-${++tintSeq}`;
      const filter = createSvg("filter");
      filter.id = id;
      filter.setAttribute?.("color-interpolation-filters", "sRGB");
      const matrix = createSvg("feColorMatrix");
      matrix.setAttribute?.("type", "matrix");
      matrix.setAttribute?.(
        "values",
        "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0",
      );
      filter.append(matrix);
      (tintDefs ?? ensureTintDefs()).append(filter);
      record = { id, matrix };
      tintFilters.set(entry, record);
    }
    return record;
  };

  /**
   * Paints `entry`'s tint and look onto its picture, as one `filter` value.
   *
   * The two are different mechanisms and one CSS property: a tint is the SVG
   * `feColorMatrix` that offsets the channels, and a look is the set of CSS
   * filter functions (`blur`, `saturate`, …) that reshape them. Both are written
   * here, in one place, because the second assignment would otherwise replace
   * the first — a `saturate(0)` after a `rgbTo` used to take the tint off.
   *
   * The tint goes first and the look after it, so a blurred picture is blurred
   * with its colour already offset rather than offset after the blur: a colour
   * matrix is per pixel, and doing it after a blur is the same picture either
   * way for these two, but the order is fixed so the string is stable.
   *
   * A picture with neither carries no `filter` declaration at all — `none` is
   * written rather than left blank, so a stylesheet rule could not leak in.
   *
   * 逆光压出来的暗部（`entry.shade`，见 `paintShades`）也走这一条：它乘在
   * `brightness` 上，而不是替换作者写的那个值 —— 作者写 0.8、逆光又压到 0.4，
   * 结果应该是 0.32。
   */
  const paintFilters = (entry, mode = "normal", look = entry.look) => {
    const tint = entry.tintColor;
    const shade = Number(entry.shade ?? 1);
    const authored = Number(look?.brightness);
    const lit =
      shade < 1
        ? { ...(look ?? {}), brightness: (Number.isFinite(authored) ? authored : 1) * shade }
        : look;
    const lookCss = mode === "full" ? lookFilterFull(lit) : lookFilter(lit);
    const tintCss = tint ? `url(#${ensureTintFilter(entry).id})` : "";
    const css = [tintCss, lookCss].filter(Boolean).join(" ") || "none";
    if (entry.image) entry.image.style.filter = css;
    if (entry.mesh) entry.mesh.node.style.filter = css;
  };

  /**
   * Paints `entry`'s tint onto its picture.
   *
   * A zero tint clears the offset rather than leaving an identity matrix in
   * place, which would otherwise keep a filter region around the image for no
   * gain. Both the plain image and — once a character has been pulled into a
   * mesh — the mesh node are tinted, so a deformed character keeps its colour.
   */
  const paintTint = (entry, r, g, b) => {
    if (r === 0 && g === 0 && b === 0) {
      entry.tintColor = null;
      paintFilters(entry);
      return;
    }
    entry.tintColor = { r, g, b };
    const record = ensureTintFilter(entry);
    record.matrix.setAttribute?.("values", tintMatrix(r, g, b));
    paintFilters(entry);
  };

  /**
   * Applies a colour offset to one picture, over `time` milliseconds.
   *
   * `target` is `"background"` for the backdrop or a character's slot. The wait
   * the call reports is what lets a script hold the line until the tint is in,
   * even though the filter itself is swapped in at once.
   *
   * @returns {Promise<void> | undefined}
   */
  const applyTint = (target, r, g, b, time) => {
    const entry = target === "background" ? background : characters.get(target);
    if (!entry) {
      return undefined;
    }
    paintTint(entry, r, g, b);
    return settled(time);
  };

  /**
   * Applies a look — blur, brightness, contrast, saturation — to one picture.
   *
   * The look is swapped in at once and the wait is what the duration says, the
   * same deal the tint makes: CSS would need one transition per function to
   * animate a filter change, and a script that asked for 3000ms is holding the
   * line for 3000ms either way. A picture with a neutral look has no filter
   * declaration at all.
   *
   * @param {"background" | string} target
   * @param {{ blur: number, brightness: number, contrast: number, saturate: number }} look
   * @param {number} time
   * @returns {Promise<void> | undefined}
   */
  const applyLook = (target, look, time) => {
    const entry = target === "background" ? background : characters.get(target);
    if (!entry) {
      return undefined;
    }
    // The look before this call, kept so the transition has a matching start.
    const previous = entry.look;
    entry.look = { ...neutralLook(), ...look };
    const nodes = [entry.image, entry.mesh && entry.mesh.node].filter(Boolean);
    if (time > 0) {
      // A `filter` list only animates between two lists of the same length, so
      // paint the previous look as a full four-function list first as the start,
      // arm the transition (the flush reads layout to record that start), then
      // write the new value — which the browser then interpolates over `time`.
      // Without this the filter would be swapped in at once and only the wait
      // the script asked for would elapse.
      paintFilters(entry, "full", previous);
      for (const node of nodes) {
        writeTransition(node, { filter: time }, time);
      }
      paintFilters(entry, "full", entry.look);
    } else {
      // Instant: drop any filter transition left from an earlier timed call so
      // this swap is not animated by a lingering one.
      for (const node of nodes) {
        writeTransition(node, { filter: 0 }, 0);
      }
      paintFilters(entry, "normal", entry.look);
    }
    return settled(time);
  };

  /**
   * Builds the mesh a character is drawn through, beside its plain image.
   *
   * Both are in the markup from the moment the character is, and only one of
   * them is in the drawing: the mesh is built here rather than at the first
   * pull so that a pull never has to touch the document, and it starts out of
   * sight so that a character no script deforms is drawn exactly as before.
   */
  const buildMeshFor = (entry) => {
    const mesh = buildMesh();
    mesh.node.style.display = "none";
    entry.mesh = mesh;
    entry.layer.append(mesh.node);
  };

  /**
   * Switches a character from its plain image to its mesh.
   *
   * This is what a pull on any of the eight points does the first time, and
   * what every later slide, turn and resize keeps to. The frame is measured
   * here too, since the piece matrices are written in its pixels.
   *
   * The plain image has been drawing the object through its pose, whereas the
   * eight points were settled when the bitmap decoded. The mesh therefore has
   * to start from the pose that is on the stage *now* — a `scale`, `rotate` or
   * `move` before the first pull must not be rewound by the switch.
   */
  const activateMesh = (entry) => {
    if (entry.deformed) {
      return;
    }
    entry.points = currentPoints(entry, perspectiveOn);
    entry.frameSize = frameSizeOf(surface);
    // Paint the pieces before showing them. An untransformed mesh is eight
    // full-frame copies of the picture, so a mesh shown before `drawMesh` has
    // run would flash the unposed picture for one frame of a timed pull.
    drawMesh(entry);
    entry.deformed = true;
    entry.image.style.display = "none";
    entry.mesh.node.style.display = "";
  };

  /**
   * Puts an entry's eight points where `target` says, over `time`.
   *
   * A slide, a turn, a resize and a single pulled point are all one change
   * seen from different sides, and all one function here: what differs is only
   * the shape `target` recomputes the points into. The shape it is given is
   * the one from before the change, which is what a turn's angle and a
   * resize's factor are deltas against.
   *
   * @param {object} entry
   * @param {number} time Milliseconds the change takes; zero is at once.
   * @param {(start: object) => object} target The points to end on.
   * @returns {Promise<void> | undefined}
   */
  const reshape = (entry, time, target) => {
    // A `cue` starts several point pulls in the same tick, and each gets its
    // own eased loop. Writing the whole point set from any one of them would
    // erase the points the others moved on every frame, leaving only the last
    // pull visible. Each change therefore owns just the points it moves, and
    // every frame's drawMesh sees the whole set whoever drew last.
    const start = { ...entry.points };
    const end = target(start);
    const handles = Object.keys(end).filter((name) => start[name] !== end[name]);
    return eased(time, (progress) => {
      const mixed = progress >= 1 ? end : betweenPoints(start, end, progress);
      for (const name of handles) {
        entry.points[name] = mixed[name];
      }
      drawMesh(entry);
      // 网格自己画完不会经过 `draw`，灯层的剪影也得跟着走这一帧。
      touchLights();
    });
  };

  /**
   * Draws a frame onto its image.
   *
   * The point is the image's centre, measured from the stage's centre: `x`
   * grows to the right and `y` upwards, so the bottom-left corner is negative
   * on both axes and the top-right positive on both. It is written as a
   * percentage of the frame, so the layout is identical at every window size —
   * only the frame's pixel size changes.
   *
   * The `transition` lists only what has a duration to run. Rewriting it
   * without a property that is still in flight would snap that property to its
   * target, so whichever of the two the current call does not touch keeps the
   * duration it was last given: a turn does not cut short a move still running,
   * nor a move a turn.
   *
   * Between the `transition` and the values it should run from and to, the
   * frame is flushed by reading a layout property. A whole run happens in one
   * tick — `enable()` places the image and the next line moves it — so without
   * the read the browser would meet only the values the call ends on, in a
   * single style pass, and have nothing to animate away from: the image would
   * jump however long the duration says. A call with no duration has nothing
   * to animate and does not pay for the flush.
   */
  const draw = (entry) => {
    // 对象一重画，灯层里的剪影就过期了：挡光的那个洞、逆光边光、被照亮的那
    // 一块，都是按对象此刻的位置与大小画的。灯层只在「灯自己变了」时才重画，
    // 所以这里必须顺手标脏 —— 否则角色走到光里不会把光挖开，灯退到他背后也
    // 不在他身上挖洞，看起来就是「光从人物身上穿过去」。同一帧里的多次改动
    // 由 `lightRig.invalidate` 合并成一次。
    touchLights();
    // A character whose points have been pulled on is drawn from those points
    // alone. Its plain image is out of the drawing, so none of what follows —
    // the two timelines, the box, the turn — has anything left to say.
    if (entry.deformed) {
      drawMesh(entry, perspectiveOn);
      return;
    }

    const { image } = entry;
    if (!image) {
      return;
    }

    // Each of the three timelines writes only its own properties, so a turn
    // does not cut short a move still running, nor a move a turn — and a fade,
    // which has a timeline of its own (see `fadeElement`), is left alone.
    writeTransition(
      image,
      {
        left: entry.moveMs,
        top: entry.moveMs,
        transform: entry.turnMs,
        width: entry.boxMs,
        height: entry.boxMs,
      },
      Math.max(entry.moveMs, entry.turnMs, entry.boxMs),
    );

    // 取景：z 越大越靠画面深处，位置朝中心收敛、尺寸同比缩小（z=0 时是 1）。
    // 转出 W 面（写过 `rotateH` / `rotateV`）之后，同一步换成整次透视投影：
    // 位置是中心的投影，`transform` 是一条 `matrix3d`。两种写法在三个角都
    // 为 0 时给出同一个结果，所以躺着不动的剧本一个像素都不变。
    const at = frameOf(entry, frameUnits(), perspectiveOn);
    image.style.left = `${at.left}%`;
    image.style.top = `${at.top}%`;
    // A box the writer has pulled on is written whole: the element's rectangle
    // has to be the picture's rectangle for the eight points to sit on its
    // corners, so the stylesheet's `contain` gives way to a plain stretch. The
    // two agree while the box still has the bitmap's own shape, which is where
    // it starts, so nothing moves on the change over.
    if (entry.w !== null && entry.h !== null) {
      image.style.width = `${(entry.w / STAGE_WIDTH) * 100}%`;
      image.style.height = `${(entry.h / STAGE_HEIGHT) * 100}%`;
      image.style.objectFit = "fill";
    }
    // `transform` is written whole, so the centring translate the stylesheet
    // starts every image with has to be repeated or it would be dropped the
    // first time a script turned or resized anything.
    image.style.transform = at.transform;
    // A text entry also carries the two styles only it has. The font size is
    // recomputed from the frame so the authored stage-pixel size survives a
    // window resize instead of becoming a fixed CSS length.
    if (entry.text !== undefined) {
      paintText(entry);
    }
  };

  /**
   * Moves an entry along a motion path over the path's own duration.
   *
   * This is `move` with the line bent: the entry is stepped frame by frame
   * through the path's polyline (`pointAt`) rather than handed one CSS
   * transition, because a path is not a straight line and `left`/`top` cannot
   * travel one. Everything else is the same — the frame is remembered, the mesh
   * follows its points, and the caller gets a promise for the whole journey.
   *
   * A path with no segments, or a duration of zero (a replay), lands at once:
   * the entry goes to the path's end and the promise resolves immediately, so
   * a replay still ends up on the saved picture.
   *
   * @param {object} entry The stage entry to move.
   * @param {object} path A normalized path (see `ui/path.js`).
   * @returns {Promise<void> | undefined}
   */
  const followPath = (entry, path) => {
    const segments = path?.segments ?? [];
    if (!segments.length) {
      return undefined;
    }
    const total = pathDuration(path);
    // A path is drawn over the scene as it stood while the animation was edited,
    // so the numbers in the file are relative to the object that was on stage
    // then. It is applied relative to the object's *current* position, not from
    // those absolute numbers: without this, re-running a script after the object
    // has moved would snap it back to where it stood while the path was drawn —
    // an unwanted slide from the old spot to the new one.
    const baseX = path?.start?.x ?? 0;
    const baseY = path?.start?.y ?? 0;
    const shiftX = entry.x - baseX;
    const shiftY = entry.y - baseY;
    const shift = (point) => ({ x: point.x + shiftX, y: point.y + shiftY, done: point.done });
    // A key path can run alongside a `rotate` — a `cue` block fires them together.
    // The rotate's turn is not a CSS transition the path's per-frame `draw` would
    // clobber; it is layered on as a "spin" the path's own step writes, so the two
    // read as one motion. Whatever a previous walk left behind is cleared first.
    entry.pathBaseRotation = entry.rotation;
    entry.spin = 0;
    entry.spinFrom = 0;
    entry.spinTo = 0;
    entry.spinStart = 0;
    entry.spinTime = 0;
    // A replay travels to a node rather than performing, so the journey is
    // skipped and the entry simply arrives — position and key frames alike.
    if (replaying || total <= 0) {
      const end = shift(pointAt(path, total));
      const movedX = end.x - entry.x;
      const movedY = end.y - entry.y;
      entry.x = end.x;
      entry.y = end.y;
      entry.moveMs = 0;
      // The last key frame is where the object is left looking. A property the
      // path never mentions keeps whatever the object already had.
      const frame = frameAt(path, total);
      entry.rotation = frame.rotation ?? entry.rotation;
      entry.scale = frame.scale ?? entry.scale;
      entry.scaleX = frame.scaleX ?? entry.scaleX;
      entry.scaleY = frame.scaleY ?? entry.scaleY;
      entry.turnMs = 0;
      if (entry.deformed) {
        reshape(entry, 0, (start) => shiftedPoints(start, movedX, movedY));
      }
      draw(entry);
      if (frame.alpha != null) {
        fadeElement(entry.image, frame.alpha, 0);
      }
      return undefined;
    }

    // Whatever the entry was doing is dropped: one journey at a time, so a
    // second `followPath` replaces the first rather than racing it.
    cancelPath(entry);

    const startedAt = now();
    entry.moveMs = 0;

    const step = () => {
      const elapsed = now() - startedAt;
      const at = shift(pointAt(path, elapsed));
      const frame = frameAt(path, elapsed);
      const movedX = at.x - entry.x;
      const movedY = at.y - entry.y;
      // `null` 表示路径不指定该属性，因此沿用上层取值。
      // object already had stands — a path that only moves must not reset a
      // turn the script asked for.
      // A `rotate` fired in the same `cue` as the key ramps on its own clock; it
      // is layered here rather than fought over by the path's per-frame `draw`,
      // so the key walk and the spin move as one. A path with no opinion on
      // rotation keeps the angle the walk began at.
      let spin = entry.spinTo ?? 0;
      if (entry.spinTime > 0) {
        const t = Math.min(1, (now() - entry.spinStart) / entry.spinTime);
        spin = entry.spinFrom + (entry.spinTo - entry.spinFrom) * t;
      }
      entry.spin = spin;
      const rotation = (frame.rotation ?? entry.pathBaseRotation) + spin;
      const scale = frame.scale ?? entry.scale;
      const turned = rotation - entry.rotation;
      const factor = entry.scale === 0 ? scale : scale / entry.scale;
      entry.x = at.x;
      entry.y = at.y;
      entry.rotation = rotation;
      entry.scale = scale;
      // The two free-transform axes ride the same clock as the uniform scale.
      // A path that never mentions them answers `null`, so the object keeps
      // whatever stretch it had. A deformed mesh has its own eight points and
      // is drawn from those instead, so these only affect the plain image.
      entry.scaleX = frame.scaleX ?? entry.scaleX;
      entry.scaleY = frame.scaleY ?? entry.scaleY;
      entry.turnMs = 0;
      if (entry.deformed) {
        // A mesh has no `left`/`top` of its own to write, so its points are
        // shifted by however far this frame travelled — and turned and grown
        // about their own centroid, the way `turn` does it.
        reshape(entry, 0, (start) => {
          const about = centroidOf(start);
          const moved = shiftedPoints(start, movedX, movedY);
          return turnedPoints(scaledPoints(moved, about, factor), about, turned);
        });
      } else {
        draw(entry);
      }
      // Opacity rides the same clock as the position, written straight to the
      // element: a CSS transition would lag behind a per-frame value.
      if (frame.alpha != null) {
        fadeElement(entry.image, frame.alpha, 0);
      }
      if (at.done) {
        entry.pathFrame = null;
        const done = entry.pathDone;
        entry.pathDone = null;
        // A `rotate` in the same cue may still have most of its turn left. Its
        // own clock must outlive the walk, or the object is left pointing at
        // whatever fraction of the turn happened to fit inside the path.
        finishSpin(entry);
        done?.();
        return;
      }
      entry.pathFrame = nextFrame(step);
    };

    return new Promise((resolve) => {
      entry.pathDone = resolve;
      step();
    });
  };

  /**
   * Lets a `rotate` fired in the same `cue` as a key walk finish on its own
   * clock.
   *
   * While the walk runs, its per-frame step reads `entry.spin` and layers it on
   * top of the key frames. But the walk stops at its last frame, which can be
   * much earlier than the turn's duration: a 500 ms key beside
   * `rotate(-3600, 2000)` used to stop at -900° — an upside-down character —
   * because nothing advanced the spin once the path's clock ended. This keeps
   * turning until the angle the script asked for is actually reached.
   *
   * @param {object} entry The stage entry still turning.
   * @returns {undefined}
   */
  const finishSpin = (entry) => {
    if (!(entry.spinTime > 0) || entry.spinFrame != null) {
      return;
    }
    const step = () => {
      // A newer walk owns the entry from here on; its step takes the spin back.
      if (entry.pathFrame != null) {
        entry.spinFrame = null;
        return;
      }
      const t = Math.min(1, (now() - entry.spinStart) / entry.spinTime);
      const spin = entry.spinFrom + (entry.spinTo - entry.spinFrom) * t;
      const delta = spin - entry.spin;
      entry.spin = spin;
      if (delta !== 0) {
        // `turn` applies the increment to the plain image or the deformed mesh,
        // whichever this object is drawn through, with no transition to chase.
        turn(entry, entry.rotation + delta, entry.scale, 0);
      }
      if (t < 1) {
        entry.spinFrame = nextFrame(step);
      } else {
        entry.spinFrame = null;
      }
    };
    step();
  };

  /** Stops a journey in progress, leaving the entry where it got to. */
  const cancelPath = (entry) => {
    if (entry.pathFrame != null) {
      clearTimeout(entry.pathFrame);
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(entry.pathFrame);
      }
      entry.pathFrame = null;
    }
    if (entry.spinFrame != null) {
      clearTimeout(entry.spinFrame);
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(entry.spinFrame);
      }
      entry.spinFrame = null;
    }
    if (entry.pathDone) {
      const done = entry.pathDone;
      entry.pathDone = null;
      done();
    }
  };

  /**
   * What a slot already knows about the character drawn in it.
   *
   * A script changes a character's expression by rebuilding the variable —
   * `hero = Character("hero_sad.png")` — and the replacement is a new object
   * with its own defaults. The slot is the same one, though, so what the stage
   * was already drawing with belongs to the slot and is handed to the new
   * object: where the character stands, how it is turned, how large it is, the
   * colour it is filtered to, and the name it speaks under. Without this a
   * change of expression would also send the character back to the centre and
   * rename it `undefinedName`, which makes the ordinary way to change a face
   * unusable.
   *
   * A slot with nothing on the stage yet answers the defaults, so a character
   * built and placed before `enable()` behaves exactly as it always did.
   */
  const characterState = (slot) => {
    const entry = slotOf(slot);
    return {
      name: characterNames.get(slot) ?? DEFAULT_DISPLAY_NAME,
      x: entry?.x ?? 0,
      y: entry?.y ?? 0,
      // 重建变量不该把角色从它站着的深度上拽回舞台平面。
      depth: entry?.z ?? 0,
      rotation: entry?.rotation ?? 0,
      // 转过身的角色换一张表情也不该被转回正面。
      angleH: entry?.rotateH ?? 0,
      angleV: entry?.rotateV ?? 0,
      size: entry?.scale ?? 1,
      tint: entry?.tintColor ? { ...entry.tintColor } : null,
      // A blur or a grey-out survives a rebuild for the same reason the fade
      // does: changing an expression is not a reason to undo the look.
      look: entry?.look ? { ...entry.look } : null,
      // A character faded out stays faded out when its expression is changed:
      // otherwise the swap would bring back a character the scene had hidden.
      opacity: entry?.opacity ?? 1,
    };
  };

  /** Records the name a slot speaks under, so a rebuilt variable keeps it. */
  const rememberCharacterName = (slot, name) => {
    characterNames.set(slot, name);
  };

  /**
   * The box an object occupies on the stage, in stage coordinates.
   *
   * This is what the path editor draws as the object's outline, and what its
   * first key frame is centred on: a key animates that object, so its route
   * has to start where the object actually stands. Answering null for something
   * that is not on the stage is deliberate — a key for an absent object has no
   * true starting point, and inventing one would be a guess.
   *
   * @param {string} name The object's variable name.
   * @returns {{ x: number, y: number, width: number, height: number } | null}
   */
  const objectBox = (name) => {
    const wanted = String(name ?? "");
    if (!wanted) {
      return null;
    }
    const entry =
      wanted === "background"
        ? background
        : characters.get(wanted) ?? slotOf(wanted) ?? null;
    if (!entry || !entry.image) {
      return null;
    }
    // The bitmap's own box when the writer has pulled one out, otherwise the
    // frame: `w`/`h` are null until a free transform gives the picture its own
    // rectangle, and a character with no box is laid out by the frame's rules.
    const width = entry.w ?? STAGE_WIDTH;
    const height = entry.h ?? STAGE_HEIGHT;
    return {
      x: entry.x,
      y: entry.y,
      width: width * (entry.scale ?? 1),
      height: height * (entry.scale ?? 1),
    };
  };

  /**
   * 舞台的一个逻辑像素，在元素自己的像素里有多大。
   *
   * 元素是按百分比摆放的，它自己的一个像素等于 `units` 个逻辑像素；而
   * `matrix3d` 作用在元素自己的像素上，所以三维投影要把这一步换算补上。
   * 没有布局（测试里的那个文档）时按 1:1 算。
   */
  const frameUnits = () => {
    const width = Number(surface?.clientWidth) || 0;
    return width > 0 ? width / STAGE_WIDTH : 1;
  };

  // 场景对象（背景与角色）共用一个 0–999 的 z-index 区间；超出的只报一次，
  // 演出本身不被打断。
  let orderWarned = false;

  /**
   * 把背景与角色放进同一套顺序：z 决定谁在前，z 相同按层（背景在下、角色在上）
   * 与 `characterOrder`（入场序、`front()` / `back()`）决定。
   *
   * 舞台的这两层不创建 stacking context（见 `panels.css`），所以把结果写成每个
   * 元素的 `z-index`，跨层也能比较；序号落在 0–999，视频、粒子等覆盖层从 1000
   * 起，界面照旧压在场景之上。
   */
  const applySceneOrder = () => {
    const entries = [];
    // 背景层只放背景图片：溶解时出、入两张同时在场，它们同属背景。
    const backdrop = [...(background.node.childNodes ?? [])];
    if (backdrop.length) {
      entries.push({ kind: "background", z: background.z ?? 0, nodes: backdrop });
    }
    for (const slot of characterOrder) {
      const entry = characters.get(slot);
      if (!entry?.image) {
        continue;
      }
      // 一张立绘的两个元素（原图与八点网格）同序号，两者只会显示一个。
      entries.push({
        kind: "character",
        z: entry.z ?? 0,
        nodes: entry.mesh ? [entry.image, entry.mesh.node] : [entry.image],
      });
    }
    if (entries.length > ORDER_CEILING + 1 && !orderWarned) {
      orderWarned = true;
      console.warn(`[pamela] 场景对象超过 ${ORDER_CEILING + 1} 个，z-index 按上限封顶`);
    }
    sceneOrder(entries).forEach((item, index) => {
      const level = String(Math.min(index, ORDER_CEILING));
      for (const node of item.nodes) {
        node.style.zIndex = level;
      }
    });
  };

  /**
   * 把一个对象放到深度 `z`（0 是舞台平面），可以带过渡。
   *
   * 深度只改这个对象自己的取景：位置与缩放仍然是那套 left/top/transform，
   * 所以有时长时直接借浏览器的过渡，不需要第二套时钟。
   */
  const setDepth = (entry, value, time) => {
    entry.z = clampDepth(value);
    const span = Math.max(0, Number(time) || 0);
    entry.moveMs = span;
    entry.turnMs = span;
    draw(entry);
    applySceneOrder();
    return settled(span);
  };

  /** 同一层里按深度重排：远的先画，近的后画（后出现的盖在上面）。 */
  const orderLayer = (node, entries) => {
    if (!node?.append) {
      return;
    }
    const list = [...entries].filter((entry) => entry?.image);
    if (list.length < 2) {
      return;
    }
    const sorted = [...list].sort(byDepth);
    if (sorted.every((entry, index) => entry === list[index])) {
      return;
    }
    for (const entry of sorted) {
      node.append(entry.image);
    }
  };

  const setBackgroundDepth = (value, time) => setDepth(background, value, time);

  const setCharacterDepth = (slot, value, time) => {
    const entry = slotOf(slot);
    if (!entry) {
      return undefined;
    }
    const done = setDepth(entry, value, time);
    // 角色层的先后以 `characterOrder` 为准，不能直接改 DOM：否则下一次
    // `front()` / 新角色入场调用 `restackCharacters()` 时，会把 z 排好的顺序冲掉。
    sortCharacterOrder();
    restackCharacters();
    // 重建层之后按新的数组再写一次序号：同 z 的角色以入场序 / front() 兜底。
    applySceneOrder();
    return done;
  };

  const setTextDepth = (slot, value, time) => {
    const entry = texts.get(slot);
    if (!entry) {
      return undefined;
    }
    const done = setDepth(entry, value, time);
    orderLayer(textLayer.node, texts.values());
    return done;
  };

  /**
   * Moves an entry to `x`, `y`, `z`, over `time` milliseconds.
   *
   * The frame is remembered whether or not the image is on the stage yet, so a
   * place set before `enable()` is applied as soon as the image appears. Zero
   * is a jump, which is what a first placement wants.
   *
   * `z` is optional: `null` leaves the depth alone. When it does change, the
   * same draw carries position and scale, so a three-coordinate move is one
   * motion rather than two racing ones.
   *
   * @returns A promise that resolves once the move is over, or `undefined` for
   *   a jump.
   */
  const move = (entry, x, y, z, time) => {
    // A mesh slides by the same distance the plain image would have: the
    // difference is only that its points travel rather than its `left`/`top`.
    const dx = x - entry.x;
    const dy = y - entry.y;
    const depth = z === undefined || z === null ? null : clampDepth(z);
    const sinks = depth !== null && depth !== entry.z;
    entry.x = x;
    entry.y = y;
    if (depth !== null) {
      entry.z = depth;
    }
    entry.moveMs = time;
    if (sinks) {
      // 缩放在 `transform` 上，和位移走同一条时长，才是一次斜着退后的移动。
      entry.turnMs = time;
    }
    if (entry.deformed) {
      if (sinks) {
        drawMesh(entry);
      }
      return reshape(entry, time, (start) => shiftedPoints(start, dx, dy));
    }
    draw(entry);
    if (sinks) {
      applySceneOrder();
    }
    return settled(time);
  };

  /**
   * Turns and resizes a deformed character's mesh over `time` milliseconds.
   *
   * `reshape` walks each point along a straight line, which is the right motion
   * for a pull or a slide but not for a turn: interpolating the points of a
   * rotated box squashes it through the middle of the turn, and a turn of a
   * whole number of turns ends every point where it began, so the shape would
   * not move at all. A turn is instead applied to the points about their own
   * centroid frame by frame — the same way the plain image's CSS
   * `rotate(...) scale(...)` reads — so the mesh spins through the whole angle.
   */
  const turnMesh = (entry, time, degrees, factor) => {
    const start = { ...entry.points };
    const about = centroidOf(start);
    return eased(time, (progress) => {
      const turned = turnedPoints(start, about, degrees * progress);
      const grown = 1 + (factor - 1) * progress;
      const points = scaledPoints(turned, about, grown);
      for (const name of Object.keys(points)) {
        entry.points[name] = points[name];
      }
      drawMesh(entry);
      touchLights();
    });
  };

  /**
   * Turns and resizes an entry over `time` milliseconds.
   *
   * Both are taken as the absolute angle and size to end on — which is what
   * `rotateTo` and `scaleTo` mean, and what the relative calls have already
   * counted out — so a mesh, which has no angle and no size of its own left
   * once its points are apart, works from how far they have moved.
   */
  const turn = (entry, rotation, scale, time, pose = null) => {
    // 另外两个面的转角走同一次重画：它们改变的是同一个 `transform`。
    if (pose) {
      if (pose.rotateH !== undefined) {
        entry.rotateH = pose.rotateH;
      }
      if (pose.rotateV !== undefined) {
        entry.rotateV = pose.rotateV;
      }
    }
    // While the object walks a key path, a `rotate` (or any turn) adds to the
    // spin layered on top of whatever the path turns it to, instead of racing the
    // path's per-frame `draw` for `entry.rotation`. The path's step applies the
    // spin, so a `cue` block's `key` + `rotate` read as one motion. `scale` is
    // left to the path, which owns the object's size while it walks.
    if (entry.pathFrame != null) {
      const delta = rotation - entry.rotation;
      entry.spinFrom = entry.spin ?? 0;
      entry.spinTo = entry.spinFrom + delta;
      entry.spinStart = now();
      entry.spinTime = time ?? 0;
      // The turn keeps its own duration even though the path's step is the one
      // writing its intermediate angles. `finishSpin` carries it on after the
      // walk ends, so a `cue` block still waits for the whole turn.
      return settled(time);
    }
    const turned = rotation - entry.rotation;
    const factor = entry.scale === 0 ? scale : scale / entry.scale;
    entry.rotation = rotation;
    entry.scale = scale;
    entry.turnMs = time;
    if (entry.deformed) {
      return turnMesh(entry, time, turned, factor);
    }
    draw(entry);
    return settled(time);
  };

  /** The entry drawing in `slot`, or `null` when nothing is in it. */
  /**
   * Pushes a complete key-frame state onto a stage object at once, instantly.
   *
   * The key frame editor holds a `live` object it drags around; this applies that
   * exact pose — position, rotation, the two free-transform axes and opacity —
   * onto the preview stage so the real picture tracks the transform box as the
   * author works. Unlike the script's `move` / `turn` / `fade`, which each run on
   * their own clock, this is a single snapshot with no transition: the sort of
   * thing the preview pane wants a dozen times a second.
   *
   * @param {string} target `"background"` or a character slot.
   * @param {{ x?: number, y?: number, rotation?: number, scale?: number, scaleX?: number, scaleY?: number, alpha?: number }} state
   * @returns {undefined}
   */
  const applyPreviewState = (target, state) => {
    const entry = target === "background" ? background : slotOf(target);
    if (!entry || !state) {
      return undefined;
    }
    // A number that is not a number becomes the fallback — a key frame left a
    // field out, or carried something `NaN`, and a picture must not jump to the
    // void. `stage.js` keeps no `numberOr` of its own, so the guard is local.
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    const x = state.x != null ? num(state.x, entry.x) : entry.x;
    const y = state.y != null ? num(state.y, entry.y) : entry.y;
    const rotation = state.rotation != null ? num(state.rotation, entry.rotation) : entry.rotation;
    const scale = state.scale != null ? num(state.scale, 1) : entry.scale;
    const scaleX = state.scaleX != null ? num(state.scaleX, 1) : entry.scaleX;
    const scaleY = state.scaleY != null ? num(state.scaleY, 1) : entry.scaleY;
    const alpha = state.alpha != null ? Math.min(1, Math.max(0, num(state.alpha, 1))) : entry.opacity;

    entry.x = x;
    entry.y = y;
    entry.rotation = rotation;
    entry.scale = scale;
    entry.scaleX = scaleX;
    entry.scaleY = scaleY;
    entry.opacity = alpha;
    // A free-transformed mesh draws from its own points rather than a transform,
    // so `draw` leaves its pose alone — but it still gets the opacity, which is
    // the part a preview cares about most. Position, rotation and the two axes
    // land on the plain image path, so an ordinary picture (the common case) is
    // posed exactly as the box on the canvas says.
    draw(entry);
    if (entry.image) {
      paintAlpha(entry.image, alpha);
    }
    if (entry.mesh) {
      paintAlpha(entry.mesh.node, alpha);
    }
    return undefined;
  };

  const slotOf = (slot) => characters.get(slot) ?? null;

  /**
   * The extra rotation a key walk has layered onto `target`, on top of the
   * angle its own key frames asked for.
   *
   * `playKey` is a module-level helper: it can see the stage object but not the
   * `characters` map or `background` this closure owns. When a walk finishes it
   * asks this method for the one number it needs, instead of reaching for
   * `slotOf` itself. A target the stage does not hold has no spin.
   *
   * @param {"background" | string} target `"background"` or a character slot.
   * @returns {number} Degrees; 0 when there is nothing to add.
   */
  const spinOf = (target) => {
    const entry = target === "background" ? background : slotOf(target);
    // The script-facing object wants the angle the turn will *end* on. The walk
    // can finish well before the spin does, so `entry.spin` would freeze a
    // half-turned angle into the object the next relative call counts from.
    return (entry && (entry.spinTo ?? entry.spin)) || 0;
  };

  /**
   * Freezes or resumes the GIF on `target`.
   *
   * `target` is `"background"` or a character slot. A positive (1-based) frame
   * freezes there and stops playback; `0`, no argument or any non-positive value
   * resumes from wherever the GIF was last showing. A non-GIF image is ignored.
   *
   * @param {"background" | string} target
   * @param {number} [frame]
   */
  const stepGif = (target, frame) => {
    const entry = target === "background" ? background : slotOf(target);
    if (!entry) {
      return;
    }
    // A `step` written next to `enable()` runs long before the bytes have been
    // read — the picture is still an `<img>` with its animation left to the
    // browser. The request is kept on the entry and `setupGif` applies it the
    // moment there are frames to freeze on, instead of being lost. A picture
    // that never becomes an animation simply never consumes it.
    if (!entry.gif) {
      entry.pendingStep = frame;
      return;
    }
    applyStep(entry.gif, frame);
    drawGifFrame(entry);
    if (entry.gif.playing) {
      scheduleGif(entry);
    } else if (entry.gif.timer) {
      clearTimeout(entry.gif.timer);
      entry.gif.timer = 0;
    }
  };

  /**
   * Paints an opacity onto an element, over `time` milliseconds.
   *
   * Opacity is written on the element itself rather than folded into the frame,
   * because it is the one property the frame does not own: a turn and a fade
   * have separate timelines, so a fade can run while the picture is still
   * sliding. The element's transition is *merged* rather than rewritten, for the
   * same reason `draw` merges: a move in flight must not be cut short by a fade.
   *
   * The merge is the key constraint of `writeTransition`. A picture that has never
   * been moved carries `transition: none` from the last `draw`, and appending
   * `opacity 3000ms linear` to that string produced `none, opacity 3000ms
   * linear` — an invalid declaration, which the browser drops whole. The fade
   * then had no transition at all and landed instantly after the script had
   * waited out the duration, which is exactly what it looked like.
   *
   * @param {HTMLElement} element
   * @param {number} value 0–1.
   * @param {number} time Milliseconds the fade takes; zero is at once.
   */
  const fadeElement = (element, value, time) => {
    if (!element) {
      return;
    }
    // Reading layout between writing the transition and the value is what gives
    // the browser somewhere to animate from, exactly as `draw` does.
    writeTransition(element, { opacity: time }, time);
    paintAlpha(element, value);
  };

  /**
   * Sets the opacity of an entry's picture, and of its mesh when it has one.
   *
   * The value is clamped here rather than only in `fadeTo`: the script's call
   * goes through the object layer, but the stage's own method is reachable from
   * a host too, and an opacity outside 0–1 is not something the element can
   * show.
   *
   * @returns {Promise<void> | undefined}
   */
  const fade = (entry, value, time) => {
    const level = Math.min(1, Math.max(0, Number(value) || 0));
    entry.opacity = level;
    fadeElement(entry.image, level, time);
    if (entry.mesh) {
      fadeElement(entry.mesh.node, level, time);
    }
    const done = settled(time);
    // 透明度决定这个对象还在不在灯层的对象表里（0 就不挡光了），所以起手先
    // 画一次；有时间的话，等它真正淡到那个值再画一次。
    touchLights();
    if (done) {
      done.then(touchLights, touchLights);
    }
    return done;
  };

  /** Fades the backdrop to `value`, over `time` milliseconds. */
  const setBackgroundAlpha = (value, time) => fade(background, value, time);

  /** Fades the character in `slot` to `value`, over `time` milliseconds. */
  const setCharacterAlpha = (slot, value, time) => {
    const entry = slotOf(slot);
    return entry ? fade(entry, value, time) : undefined;
  };

  /**
   * Rebuilds the character layer's children in the order `characterOrder` gives.
   *
   * The layer paints its children in document order, so this list is the drawing
   * order. It is kept here rather than read back off the DOM, because the two
   * elements a character owns — its image and its mesh — have to stay together
   * whichever of them is drawing, and because a document with no real layout
   * (the one the tests build over) does not reorder an element that is appended
   * a second time.
   */
  /**
   * 把 `characterOrder` 按深度排一遍：远的在前（先画），近的在后（盖上去）。
   *
   * 稳定排序，所以 z 相同的角色保持入场 / `front()` / `back()` 定下的先后。
   */
  const sortCharacterOrder = () => {
    const depthOf = (name) => characters.get(name)?.z ?? 0;
    characterOrder.sort((left, right) => byDepth({ z: depthOf(left) }, { z: depthOf(right) }));
  };

  const restackCharacters = () => {
    const nodes = [];
    for (const slot of characterOrder) {
      const entry = characters.get(slot);
      if (!entry) {
        continue;
      }
      nodes.push(entry.image);
      if (entry.mesh) {
        nodes.push(entry.mesh.node);
      }
    }
    character.node.replaceChildren(...nodes);
  };

  /**
   * Moves a character's elements to the end of the character layer.
   *
   * The layer paints its children in document order, so the last one is the one
   * in front. Both of a slot's elements move together — the plain image and the
   * mesh — so whichever of the two is drawing stays in the same place in the
   * stack.
   */
  const raiseCharacter = (slot) => {
    if (!slotOf(slot)) {
      return;
    }
    const at = characterOrder.indexOf(slot);
    if (at >= 0) {
      characterOrder.splice(at, 1);
    }
    characterOrder.push(slot);
    restackCharacters();
    applySceneOrder();
  };

  /** Moves a character's elements to the start of the character layer. */
  const lowerCharacter = (slot) => {
    if (!slotOf(slot)) {
      return;
    }
    const at = characterOrder.indexOf(slot);
    if (at >= 0) {
      characterOrder.splice(at, 1);
    }
    characterOrder.unshift(slot);
    restackCharacters();
    applySceneOrder();
  };

  /**
   * Replaces the backdrop with a dissolve: the new picture fades in over the old.
   *
   * Both pictures are on the layer at once, the outgoing one underneath. The
   * incoming picture is the one `moveBackground` and the tint keep working on;
   * the outgoing is dropped when the fade is over rather than left underneath
   * for the life of the window.
   *
   * A fade of zero is a hard cut, which is what `setBackground` does — the old
   * picture is simply replaced.
   */
  const crossFadeBackground = (path, time) => {
    if (!(time > 0)) {
      setBackground(path);
      return undefined;
    }

    const outgoing = background.image;
    const outgoingPath = background.path;
    // A dissolving GIF is drawn through its own canvas, like any other.
    const incoming = pictureFor("stage__background", path);
    paintAlpha(incoming, 0);
    background.node.append(incoming);

    // The incoming picture becomes the one the frame describes, so a move or a
    // tint issued while the dissolve runs lands on the picture being faded in.
    background.image = incoming;
    background.path = path;
    background.opacity = 1;
    refreshEmpty();
    // 出、入两张图同属背景，给同一档序号：谁在上仍由层内 DOM 顺序决定。
    applySceneOrder();

    load(background, incoming, path, () => {
      // The dissolve could not start: the old picture is still what is on the
      // stage, so it is put back rather than left with nothing over it.
      background.image = outgoing;
      background.path = outgoingPath;
      dropFromLayer(background.node, incoming);
      refreshEmpty();
    }, () => {}, "Background");

    fadeElement(incoming, 1, time);
    if (outgoing) {
      fadeElement(outgoing, 0, time);
    }
    return settled(time).then(() => {
      dropFromLayer(background.node, outgoing);
    });
  };

  /** Takes one child out of a layer, without needing the element's own remove. */
  function dropFromLayer(node, child) {
    if (!child) {
      return;
    }
    const kept = [...(node.childNodes ?? [])].filter((existing) => existing !== child);
    node.replaceChildren(...kept);
  }

  /** Moves the backdrop to `x`, `y`, `z`, over `time` milliseconds. */
  const moveBackground = (x, y, z, time) => move(background, x, y, z, time);

  /** Moves the character in `slot` to `x`, `y`, `z`, over `time` milliseconds. */
  const moveCharacter = (slot, x, y, z, time) => {
    const entry = slotOf(slot);
    if (!entry) {
      return undefined;
    }
    const sinks = z !== undefined && z !== null && clampDepth(z) !== entry.z;
    const done = move(entry, x, y, z, time);
    if (sinks) {
      // 深度也进了角色层的先后：重排数组、重建层，再写一遍序号。
      sortCharacterOrder();
      restackCharacters();
      applySceneOrder();
    }
    return done;
  };

  /**
   * Walks the character in `slot` along a motion path.
   *
   * The path is the one the host read from `data/path-<id>.json`; the stage
   * only knows how to travel it. A character not on the stage yet answers
   * `undefined` — there is nothing to move — which is the same answer
   * `moveCharacter` gives for a slot that was never drawn.
   */
  const followCharacterPath = (slot, path) => {
    const entry = slotOf(slot);
    if (entry) {
      return followPath(entry, path);
    }
    return undefined;
  };

  /** Walks the backdrop along a motion path. */
  const followBackgroundPath = (path) => followPath(background, path);

  /** Turns and resizes the backdrop over `time` milliseconds. */
  const transformBackground = (rotation, scale, time, pose) =>
    turn(background, rotation, scale, time, pose);

  /** Turns and resizes the character in `slot` over `time` milliseconds. */
  const transformCharacter = (slot, rotation, scale, time, pose) => {
    const entry = slotOf(slot);
    if (entry) {
      return turn(entry, rotation, scale, time, pose);
    }
    return undefined;
  };

  /** Whether an entry's box is the picture's own rectangle yet. */
  const boxed = (entry) => entry.w !== null && entry.h !== null;

  /**
   * Gives a character the box its bitmap actually occupies.
   *
   * The frame's own way of sizing an image is to scale the whole picture until
   * it fits and centre it, which leaves a letterbox around it; the box is that
   * inner rectangle, so from here the element's rectangle and the picture's are
   * the same, and the eight points sit on the picture's own corners.
   *
   * A transform asked for before this point was held back rather than measured
   * against the frame, and is replayed here in the order it was written.
   */
  const adopt = (entry, image, name = "") => {
    // An `<img>` reports `naturalWidth`; a GIF canvas reports `width`/`height`.
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (boxed(entry) || !w || !h) {
      return;
    }
    const fit = Math.min(STAGE_WIDTH / w, STAGE_HEIGHT / h);
    entry.w = w * fit;
    entry.h = h * fit;
    // The eight points start as the box's own rectangle — the picture's
    // rectangle, turned to however the script has it facing. A character that
    // is never pulled on therefore keeps drawing exactly as it did, and the
    // first pull starts from where the picture already is.
    entry.points = pointsOf(entry, perspectiveOn);
    const held = entry.late;
    entry.late = [];
    entry.lateFailures = [];
    for (const call of held) {
      call();
    }
    draw(entry);
    // `objectBox()` has just stopped answering "the whole frame". Anyone holding
    // an outline drawn from the old answer must measure again now.
    onObjectBox(name);
  };

  /**
   * Runs a free transform on a slot, or holds it until the box is known.
   *
   * A script enables a character and transforms it on the next line, long
   * before the bitmap has been decoded and its size is known — and the box
   * cannot be measured against the frame instead, because a picture that does
   * not share the frame's shape would be measured wrong and then stretched.
   * So the call is kept, and replayed once there is a real box to work on.
   */
  const withBox = (slot, call) => {
    const entry = slotOf(slot);
    if (!entry) {
      return undefined;
    }
    if (!boxed(entry)) {
      // The call is replayed once the bitmap knows its box. The promise keeps
      // the interpreter waiting for the animation, just like a measured
      // transform; `failLate` releases it if the picture never arrives.
      return new Promise((resolve) => {
        entry.late.push(() => resolve(call(entry)));
        entry.lateFailures.push(() => resolve(undefined));
      });
    }
    return call(entry);
  };

  /** Releases transforms that were waiting for a picture that will never load. */
  const failLate = (entry) => {
    const waiting = entry?.lateFailures ?? [];
    if (entry) {
      entry.late = [];
      entry.lateFailures = [];
    }
    for (const finish of waiting) {
      finish();
    }
  };

  /**
   * Puts one of the eight points at `x`, `y` over `time` milliseconds.
   *
   * This is the call that makes a character a mesh: from here its picture is
   * drawn through its points rather than fitted into a box, and the other
   * seven points are handed on exactly as they were. A box could only have
   * grown about its far side, which is what used to make a slanted edge — or
   * an edge midpoint off its line — impossible to ask for.
   */
  const boxSize = (entry, handle, x, y, time) => {
    activateMesh(entry);
    return reshape(entry, time, (start) => pulledPoints(start, handle, x, y));
  };

  /** Puts one point of the character's box at `x`, `y`. */
  const transformCharacterPoint = (slot, handle, x, y, time) =>
    withBox(slot, (entry) => boxSize(entry, handle, x, y, time));

  /** Moves one point of the character's box by `dx`, `dy` from where it is. */
  const moveCharacterPoint = (slot, handle, dx, dy, time) =>
    withBox(slot, (entry) => {
      const at = boxPoint(entry, handle, perspectiveOn);
      return boxSize(entry, handle, at.x + dx, at.y + dy, time);
    });

  /**
   * Stops any GIF playback on `entry`, forgetting its decoded frames.
   *
   * Called before a fresh image is loaded or the stage is cleared, so a timer
   * left running does not keep painting a canvas that is no longer on the stage.
   */
  const stopGif = (entry) => {
    if (entry.gif) {
      if (entry.gif.timer) {
        clearTimeout(entry.gif.timer);
      }
      entry.gif = null;
    }
  };

  /** Paints `entry`'s current GIF frame onto its canvas, if it has one. */
  const drawGifFrame = (entry) => {
    const gif = entry.gif;
    if (!gif || !gif.ctx) {
      return;
    }
    const frame = gif.frames[gif.index];
    if (!frame) {
      return;
    }
    // One reusable ImageData rather than a fresh screen-sized buffer per frame:
    // an animation redraws this dozens of times a second.
    const data = gif.imageData ?? (gif.imageData = gif.ctx.createImageData(gif.width, gif.height));
    data.data.set(frame.rgba);
    gif.ctx.putImageData(data, 0, 0);
  };

  /** Schedules the next GIF frame, looping until playback is turned off. */
  const scheduleGif = (entry) => {
    const gif = entry.gif;
    if (!gif) {
      return;
    }
    if (gif.timer) {
      clearTimeout(gif.timer);
    }
    gif.timer = setTimeout(() => {
      // A slot rebuilt while this timer was in flight must not drive the new
      // picture's clock from the old one's callback.
      if (entry.gif !== gif || !gif.playing) {
        return;
      }
      gif.index = (gif.index + 1) % gif.frames.length;
      drawGifFrame(entry);
      scheduleGif(entry);
    }, gif.frames[gif.index].delay);
  };

  /**
   * Loads a GIF: decodes it once, paints it onto the `<canvas>` the picture has
   * been drawn through all along, and begins playback. A deformed character
   * keeps drawing through its mesh, whose `<img>` pieces play the GIF natively,
   * so only the plain picture is framed here.
   *
   * Every path out of here — a decoded canvas, an undecodable payload, a picture
   * that is not a canvas at all — calls `reveal`, which is what takes the
   * `hidden` that `load` put on the picture back off. Showing the element and
   * measuring it are separate from decoding the bytes, so a GIF that cannot be
   * framed by this decoder still plays through the browser's own `<img>`
   * animation.
   */
  const setupGif = (entry, image, url, ticket, onDecoded, reveal) => {
    stopGif(entry);
    if (entry.mesh) {
      for (const piece of entry.mesh.pieces) {
        piece.image.src = url;
      }
    }

    /**
     * Lets the browser animate the `<img>` when the decoder cannot take over.
     *
     * That means an `<img>`, and the picture on the stage may be the `<canvas>`
     * `pictureFor` chose for a GIF: a canvas shows nothing on its own, so it is
     * swapped for an image here — the one moment of this picture's life where a
     * swap is the right answer.
     */
    const fallback = () => {
      if (ticket !== entry.ticket) {
        return;
      }
      let shown = image;
      if (String(image.tagName).toUpperCase() !== "IMG" && image.parentNode) {
        shown = document.createElement("img");
        shown.className = image.className;
        shown.alt = "";
        shown.draggable = false;
        copyInheritedStyles(image, shown);
        image.parentNode.replaceChild(shown, image);
        entry.image = shown;
      }
      shown.src = url;
      reveal();
      onDecoded(shown);
    };

    let gif;
    let ctx = null;
    try {
      gif = decodeGif(gifBytesFromDataUrl(url));
      if (!gif.frames.length) {
        fallback();
        return;
      }
      // A picture that is not a canvas has nowhere to paint the frames, and a
      // canvas without a `2d` context is the same nothing: both go back to the
      // browser rather than leaving an empty box on the stage.
      if (String(image.tagName).toUpperCase() === "CANVAS") {
        ctx = typeof image.getContext === "function" ? image.getContext("2d") : null;
      }
    } catch {
      fallback();
      return;
    }
    if (!ctx) {
      fallback();
      return;
    }

    // Everything that can fail has happened, and nothing about the element has
    // to change: it has been the canvas since it arrived, so where it sits, how
    // far it is turned, how big it is, its opacity, its filters — and the
    // transitions still running them — are all already on the node that stays.
    image.width = gif.width;
    image.height = gif.height;
    if (entry.tintColor || !lookIsNeutral(entry.look)) {
      paintFilters(entry);
    }
    entry.gif = {
      frames: gif.frames,
      width: gif.width,
      height: gif.height,
      canvas: image,
      ctx,
      index: 0,
      playing: true,
      timer: 0,
    };
    // A `step` written before the picture was decoded freezes the animation on
    // the frame it named, so the script does not have to wait for the load.
    const pending = entry.pendingStep;
    entry.pendingStep = undefined;
    if (pending != null) {
      applyStep(entry.gif, pending);
    }
    reveal();
    onDecoded({ naturalWidth: gif.width, naturalHeight: gif.height });
    drawGifFrame(entry);
    if (entry.gif.playing) {
      scheduleGif(entry);
    }
  };

  /**
   * Loads `path` into `image`.
   *
   * The image is resolved asynchronously, so it appears once the data URL is
   * ready. A newer call for the same entry wins: an outdated response is
   * dropped rather than drawn over the current image. A failed load runs
   * `onFailure`, which drops just that entry.
   *
   * The element is on the stage well before its bitmap is, and an `img` with
   * nothing to draw still paints its box: against the dark frame the top edge
   * of that box reads as a bright line across the picture. So the image is not
   * painted until the bitmap is ready. It stays in the layout throughout,
   * because `draw` needs a real frame to flush and animate against.
   */
  const load = (entry, image, path, onFailure, onDecoded = () => {}, kind = "") => {
    const ticket = (entry.ticket += 1);
    // A slot rebuilt on top of a playing GIF must not leave its timer painting
    // into the element this call is about to replace.
    stopGif(entry);
    // The path is kept beside the element so the stage can say what it shows,
    // and so a `step` written before the picture lands knows there is one
    // coming. A pending step survives the load: `step` and `enable` are often
    // written in one chain, and the answer must not depend on which came first.
    entry.path = path;
    image.style.visibility = "hidden";
    // 新的一张图意味着旧的原图快照与处理结果都过期了：抗锯齿会从新的这张重来。
    // 处理过的位图地址留在 `antialiasUrls` 里给下一次用，这里只是不再指着它。
    entry.plain = null;
    entry.smoothKey = "";
    entry.smoothUrl = null;

    /**
     * Shows the picture, unless a newer load has taken its place meanwhile.
     *
     * A GIF the decoder could not take over is handed to the browser as an
     * `<img>`, so the element that was hidden at the start is not necessarily
     * the one on the stage now: both are cleared, or the image would inherit
     * `hidden` and never appear.
     */
    const reveal = () => {
      if (ticket !== entry.ticket) {
        return;
      }
      image.style.visibility = "";
      if (entry.image && entry.image !== image) {
        entry.image.style.visibility = "";
      }
    };

    Promise.resolve()
      .then(() => (kind ? resolveAsset(path, kind) : resolveAsset(path)))
      .then((url) => {
        if (ticket !== entry.ticket) {
          return;
        }
        if (!url) {
          throw new Error(`无法加载图片：${path}`);
        }
        if (isGifPath(path)) {
          setupGif(entry, image, url, ticket, onDecoded, reveal);
          return;
        }
        image.src = url;
        // 原图的地址留着：抗锯齿会把元素换成处理过的位图，关掉时要能换回来。
        entry.plainUrl = url;
        // A mesh draws the one bitmap eight times over — a piece per triangle
        // of the picture — so every piece is pointed at the copy that was just
        // resolved. They share it, so nothing is fetched eight times.
        if (entry.mesh) {
          for (const piece of entry.mesh.pieces) {
            piece.image.src = url;
          }
        }
        // Decoding, not loading, is what says the bitmap can be painted, so
        // it is the first moment the box can be shown without its own edge.
        // A source that will never decode stays as it is: unpainted.
        return image.decode().then(
          () => {
            if (ticket !== entry.ticket) {
              return;
            }
            reveal();
            onDecoded(image);
          },
          (error) => {
            if (ticket !== entry.ticket) {
              return;
            }
            // A broken or unsupported bitmap stays hidden forever otherwise.
            image.style.visibility = "";
            failLate(entry);
            onFailure();
            onError(
              `无法解码图片：${path}${error?.message ? `（${error.message}）` : ""}`,
            );
          },
        );
      })
      .catch((error) => {
        if (ticket !== entry.ticket) {
          return;
        }
        failLate(entry);
        onFailure();
        onError(error instanceof Error ? error.message : String(error));
      });
  };

  /** Replaces the backdrop. A stage has at most one, so the new one wins. */
  const setBackground = (path) => {
    background.node.replaceChildren();
    stopGif(background);
    background.path = path;
    // 空定义：没有图可读，铺一块空背景等 `group` 给第一张。
    if (!path) {
      background.image = null;
      refreshEmpty();
      touchLights();
      applySceneOrder();
      return;
    }

    // The element a GIF is painted onto is chosen here, before its bytes are
    // read, so the picture never has to change nodes (see `pictureFor`).
    const image = pictureFor("stage__background", path);
    background.node.append(image);
    // Held for `moveBackground`, which has no other way to reach the image.
    background.image = image;
    // 背景也在灯层的对象表里（它要被照亮，只是不挡光）：换一张背景就得重画。
    touchLights();
    // The frame the object asked for, written onto the element as it arrives:
    // a picture enabled with an opacity should not be painted solid first.
    paintAlpha(image, background.opacity);
    refreshEmpty();
    // 背景也要参与整幅画面的 z 排序：它能被推到角色后面，也能拉到前面。
    applySceneOrder();

    // A tint remembered from a previous run is repainted onto the fresh image,
    // and so is the look: a picture enabled after a `blur` call should arrive
    // blurred rather than flash sharp first.
    if (background.tintColor) {
      paintTint(background, background.tintColor.r, background.tintColor.g, background.tintColor.b);
    } else if (!lookIsNeutral(background.look)) {
      paintFilters(background);
    }

    load(background, image, path, () => {
      background.node.replaceChildren();
      background.image = null;
      background.path = null;
      refreshEmpty();
      touchLights();
    }, () => touchLights(), "Background");
  };

  /**
   * Shows a character in `slot`.
   *
   * The first call for a slot adds the character to the stage. A later call for
   * the same slot — the script rebuilding the variable it was assigned to —
   * replaces its image in place, so several characters coexist and each keeps
   * its position.
   */
  const setCharacter = (slot, path) => {
    let entry = characters.get(slot);
    if (!entry) {
      // A GIF is painted onto a canvas, so that is what it arrives as — see
      // `pictureFor`. Swapping one in later would take the animations armed on
      // the first element away with it.
      const image = pictureFor("stage__character", path);
      entry = { ...frame(), image, ticket: 0, layer: character.node };
      characters.set(slot, entry);
      characterOrder.push(slot);
      character.node.append(image);
      buildMeshFor(entry);
      // 带 z 入场的角色直接落到它该在的那一层，而不是一律画在最上面。
      sortCharacterOrder();
      restackCharacters();
    }
    stopGif(entry);

    // The slot keeps one picture, and a rebuilt expression has to keep the same
    // element whenever it can: a running `move` is armed on that node, and only
    // a GIF shown as an `<img>` and a static picture need different ones — a
    // canvas has neither `src` nor `decode()`, and an `<img>` has no frames.
    let image = entry.image;
    const wanted = isGifPath(path) ? "CANVAS" : "IMG";
    if (image.tagName && image.tagName.toUpperCase() !== wanted) {
      const fresh = pictureFor("stage__character", path);
      // A deformed character keeps its plain image out of the drawing.
      fresh.style.display = image.style.display;
      if (image.parentNode) {
        image.parentNode.replaceChild(fresh, image);
      }
      entry.image = fresh;
      image = fresh;
    }
    // A rebuilt expression keeps whatever opacity the slot was at, and a
    // character enabled for the first time is solid.
    paintAlpha(entry.image, entry.opacity);
    if (entry.mesh) {
      paintAlpha(entry.mesh.node, entry.opacity);
    }
    // 抗锯齿是槽位的性质，新元素自己不带：换表情之后要重新写一遍（位图还没解码
    // 时这一步什么也做不了，`load` 解码完会再叫一次）。
    paintAntialias(entry, slot);
    // A rebuilt expression also keeps the tint and the look the slot had: the
    // new element arrives with no `filter` of its own, and without this a
    // character that was greyed out would come back in colour.
    if (entry.tintColor) {
      paintTint(entry, entry.tintColor.r, entry.tintColor.g, entry.tintColor.b);
    } else if (!lookIsNeutral(entry.look)) {
      paintFilters(entry);
    }
    refreshEmpty();
    // 入场与换表情都可能换掉元素，序号要跟着新元素走。
    applySceneOrder();
    // 上场的角色进灯层的对象表（挡光、边光、按像素提亮都看它），先重画一次；
    // 真实尺寸要等位图解码（`adopt` → `draw`）才会再触发一次。
    touchLights();

    // 空定义：槽位先立着，等 `group` 或 `pause` 给第一张图。没有路径可读，
    // 不必走 `load`（它会把一个空路径当成读失败，把刚建好的槽位删掉）；把
    // 现有的图清空，重建同名变量时旧立绘不会留在原处，而透明度、位置与滤镜
    // 这些槽位性质仍然留着，第一张图来了直接套用。
    if (!path) {
      entry.path = "";
      if (entry.image?.tagName !== "CANVAS") {
        entry.image?.removeAttribute?.("src");
      }
      if (entry.mesh) {
        for (const piece of entry.mesh.pieces) {
          piece.image.removeAttribute?.("src");
        }
      }
      refreshEmpty();
      return;
    }

    load(
      entry,
      image,
      path,
      () => {
        // A character that failed to load leaves the stage, like a backdrop
        // does. Only this slot goes: the others stay up.
        characters.delete(slot);
        character.node.replaceChildren(
          ...[...character.node.childNodes].filter((node) => node !== image),
        );
        refreshEmpty();
        touchLights();
      },
      // Only a character is given a box: the backdrop fills the frame and is
      // never stretched to a box of its own.
      (loaded) => {
        adopt(entry, loaded, slot);
        // 位图这一刻才画得出来：抗锯齿（若是作者写过的）从这里才真正生效。
        paintAntialias(entry, slot);
      },
      "Character",
    );
  };

  /**
   * Writes a text entry's own styles onto its element.
   *
   * `font-size` is authored in the stage's logical pixels, so it is scaled by
   * the frame's current width: the same scene reads the same at any window
   * size, exactly like the coordinates.
   */
  const paintText = (entry) => {
    const element = entry.image;
    if (!element?.style) {
      return;
    }
    const frameWidth = surface.clientWidth || STAGE_WIDTH;
    const pixels = Math.max(1, (entry.fontSize * frameWidth) / STAGE_WIDTH);
    element.style.fontSize = `${pixels}px`;
    element.style.color = entry.color ?? DEFAULT_TEXT_COLOR;
    // The one family covers both scripts; the default stack is what fills the
    // glyphs a chosen face does not carry.
    element.style.fontFamily = textFontStack(entry.fontFamily);
    element.style.fontWeight = String(entry.fontWeight ?? TEXT_FONT_WEIGHT);
  };

  /**
   * Shows `value` as the text in `slot`, replacing whatever was there.
   *
   * The element is kept across a rebuild — the script changing its variable —
   * so a move or a fade already armed on it is not thrown away. `style` lets
   * the constructor's `size` / `color` land on the element as it is created.
   */
  const setText = (slot, value, style = {}) => {
    let entry = texts.get(slot);
    if (!entry) {
      const element = document.createElement("div");
      element.className = "stage__text";
      entry = {
        ...frame(),
        image: element,
        ticket: 0,
        layer: textLayer.node,
        text: "",
        fontSize: DEFAULT_TEXT_SIZE,
        color: DEFAULT_TEXT_COLOR,
        fontFamily: "",
        fontWeight: TEXT_FONT_WEIGHT,
      };
      texts.set(slot, entry);
      textLayer.node.append(element);
    }
    entry.text = typeof value === "string" ? value : String(value ?? "");
    entry.image.textContent = entry.text;
    if (style.size !== undefined) {
      entry.fontSize = textSizeOf("Text", style.size);
    }
    if (style.color !== undefined) {
      entry.color = textColorOf("Text", style.color);
    }
    if (style.font !== undefined) {
      entry.fontFamily = textFamilyOf("Text", style.font);
    }
    if (style.weight !== undefined) {
      entry.fontWeight = textFontWeight("Text", style.weight);
    }
    paintText(entry);
    refreshEmpty();
    return entry;
  };

  /** Sets the face of the text in `slot`, Chinese and Western alike. */
  const setTextFont = (slot, family) => {
    const entry = texts.get(slot);
    if (!entry) {
      return undefined;
    }
    entry.fontFamily = textFamilyOf("Text", family);
    paintText(entry);
    return entry;
  };

  /** Sets how heavy the text in `slot` is drawn: the CSS weight scale. */
  const setTextWeight = (slot, weight) => {
    const entry = texts.get(slot);
    if (!entry) {
      return undefined;
    }
    entry.fontWeight = textFontWeight("Text", weight);
    paintText(entry);
    return entry;
  };

  /**
   * Sets the colour of the text in `slot`, fading over `time` when given.
   *
   * The value is a CSS colour, so the browser can interpolate it: the change
   * is armed as a `color` transition (see `TRANSITION_PROPERTIES`) and the
   * duration is what the script asked to wait for.
   */
  const setTextColor = (slot, color, time = 0) => {
    const entry = texts.get(slot);
    if (!entry) {
      return undefined;
    }
    const next = textColorOf("Text", color);
    const ms = Number(time) > 0 ? Number(time) : 0;
    const element = entry.image;
    if (element?.style) {
      if (ms > 0) {
        // 先把旧颜色写回样式，再安排过渡：一次运行里前后两句在同一帧执行，
        // 浏览器没有起点可以插值，读一次布局（flush）才让它有地方开始。
        element.style.color = entry.color ?? DEFAULT_TEXT_COLOR;
        writeTransition(element, { color: ms }, ms);
      } else {
        // 立即换色时要撤掉上一次留下的过渡，否则这次改动会被它拖着渐变。
        writeTransition(element, { color: 0 }, 0);
      }
    }
    entry.color = next;
    paintText(entry);
    return settled(ms);
  };

  /** The frame, words and styles a slot already has, for a rebuilt Text. */
  const textState = (slot) => {
    const entry = texts.get(slot);
    return entry
      ? {
          x: entry.x,
          y: entry.y,
          depth: entry.z ?? 0,
          rotation: entry.rotation,
          size: entry.scale,
          opacity: entry.opacity,
          fontSize: entry.fontSize,
          color: entry.color,
          fontFamily: entry.fontFamily,
          fontWeight: entry.fontWeight,
        }
      : null;
  };

  /** Moves the text in `slot` to `x`, `y`, `z`, over `time` milliseconds. */
  const moveText = (slot, x, y, z, time) => {
    const entry = texts.get(slot);
    if (!entry) {
      return undefined;
    }
    const sinks = z !== undefined && z !== null && clampDepth(z) !== entry.z;
    const done = move(entry, x, y, z, time);
    if (sinks) {
      // 文字层内部也按深度排：字的先后跟着 z 走。
      orderLayer(textLayer.node, texts.values());
    }
    return done;
  };

  /** Turns and resizes the text in `slot` over `time` milliseconds. */
  const transformText = (slot, rotation, scale, time, pose) => {
    const entry = texts.get(slot);
    return entry ? turn(entry, rotation, scale, time, pose) : undefined;
  };

  /** Fades the text in `slot` to `value`, over `time` milliseconds. */
  const setTextAlpha = (slot, value, time) => {
    const entry = texts.get(slot);
    return entry ? fade(entry, value, time) : undefined;
  };

  /** Names the stage page and resets its content, as when a script is run. */
  const reset = (name) => {
    element.dataset.name = name;
    // These modes belong to the run that set them, not to the one that follows:
    // a replay or a preview left switched on would bleed into the next
    // performance and hide lines or snap objects where they should not be.
    previewing = false;
    replaying = false;
    clear();
  };

  /**
   * Lets go of whatever the run is parked on, without wiping the picture.
   *
   * A run parked on a line or a question is not between statements, so the
   * interpreter's `stopped` check never sees a stop: the promise it is waiting
   * on has to be answered. Answering it lets the run reach the next statement,
   * where the check does fire. What is on the stage stays as it was — stopping
   * a scene is not the same as clearing it, and the author may want to look at
   * the frame they stopped on.
   */
  const stop = () => {
    // A run stopped mid-intro is parked on its promise, not between statements;
    // answering it here lets the interpreter reach its next `stopped()` check.
    clearIntro();
    box.settle();
    chooser.clear();
    audio.clear();
    video.pauseAll();
    effect.pauseAll();
  };

  /**
   * Draws every mesh again against the frame's new size.
   *
   * A piece's clip is written in percentages and does not care how big the
   * frame is, but the matrix inside it is written in pixels — so a window that
   * changes the frame's size leaves every mesh describing a frame that is no
   * longer there. Only the characters actually drawn as meshes are touched;
   * the plain images are laid out in percentages and need nothing.
   */
  const refreshMeshes = () => {
    const size = frameSizeOf(surface);
    const redraw = (entry) => {
      if (!entry?.image) {
        return;
      }
      if (entry.deformed) {
        entry.frameSize = size;
        drawMesh(entry);
        return;
      }
      // 转出 W 面的对象写的是一条 `matrix3d`，其中的透视项按元素像素算，
      // 所以窗口一变就得重算一次；躺在 W 面里的那几个全是百分比，不用管。
      if (!isFlatPose(entry)) {
        draw(entry);
      }
    };
    for (const entry of characters.values()) {
      redraw(entry);
    }
    redraw(background);
    for (const entry of texts.values()) {
      redraw(entry);
    }
  };

  // A document with no rendering at all — the one the tests build over — has
  // no `ResizeObserver`; the meshes then keep the frame they were drawn for.
  let meshObserver = null;
  if (typeof ResizeObserver === "function") {
    meshObserver = new ResizeObserver(refreshMeshes);
    meshObserver.observe(surface);
  }

  refreshEmpty();

  // Skip can be a deliberate toggle (the control button or menu item) or a held
  // Ctrl. The two are kept apart so releasing Ctrl does not cancel a toggle the
  // player meant to leave on, and vice versa. `applySkip` is the only writer of
  // the box's skip flag, combining both sources.
  let skipToggle = false;
  let skipHeld = false;
  const applySkip = () => box.setSkip(skipToggle || skipHeld);

  // Space and Enter advance a line, the way every visual novel accepts them. The
  // listener lives as long as the stage and does nothing while no line is up,
  // so there is nothing to add and remove per line — and because it sits on the
  // stage element rather than on the document, a key pressed in the editor or in
  // a modal never advances a scene. It goes through the box's own `settle`, so a
  // click and a key cannot disagree about finishing a reveal versus advancing.
  element.addEventListener?.("keydown", (event) => {
    // A held Ctrl fast-forwards, the way many visual novels do: press and the
    // scene races, release and it stops where it is — the deliberate toggle is
    // untouched, so it keeps racing after the key comes up.
    if (event.key === "Control" && !skipHeld) {
      skipHeld = true;
      applySkip();
      return;
    }
    if (event.key !== " " && event.key !== "Enter") {
      return;
    }
    if (!box.isWaiting()) {
      return;
    }
    event.preventDefault();
    box.settle();
  });
  element.addEventListener?.("keyup", (event) => {
    if (event.key === "Control" && skipHeld) {
      skipHeld = false;
      applySkip();
    }
  });

  return {
    element,
    get name() {
      return element.dataset.name ?? "";
    },
    /** Shows a line, answering the promise a click resolves. */
    sayLine: box.line,
    /** `stage.click(time)` 的演出端：点击位置标记 + 等待点击或自动计时。 */
    clickWait: (time) => box.clickWait(time),
    /** `stage.auto(time)` 的演出端：无标记的纯计时等待。 */
    autoWait: (time) => settled(time),
    /** `stage.pamela()` 的演出端：约 3 秒的开场动画，回放与预览时立即落终态。 */
    pamelaIntro,
    /** Replaces the dialogue style; the default is used until then. */
    setDialogueStyle: box.setStyle,
    /**
     * Changes the project's default typewriter mode for the lines that follow.
     *
     * A style file naming its own `text.typeSpeed` still wins, so this only
     * moves the fallback — which is what the settings dialog changes.
     */
    setTypewriter: (mode) => box.setTypewriter(mode),
    /** Shows or hides the dialogue layer, for `dialog.enable`/`disable`. */
    setVisible: box.setVisible,
    /** Whether a line is still being written out, so a click would finish it. */
    isTyping: box.isTyping,
    /**
     * Turns auto mode on or off: a revealed line then advances on its own after
     * the auto delay, rather than waiting for a click. Choice questions are
     * untouched — only the dialogue box's wait is driven this way.
     */
    setAuto: (on) => box.setAuto(on),
    /** Whether auto mode is on. */
    getAuto: () => box.getAuto(),
    /** Sets the auto-mode delay, in ms, between a line revealing and advancing. */
    setAutoDelay: (ms) => box.setAutoDelay(ms),
    /**
     * Turns skip (fast-forward) on or off, or flips it when called with no
     * argument. A held Ctrl also drives skip (see the stage's key handlers); the
     * toggle and the hold are combined, so either can be on without the other
     * turning it off.
     *
     * @param {boolean} [on] When given, sets the toggle; when omitted, flips it.
     * @returns {boolean} The toggle's new state.
     */
    toggleSkip: (on) => {
      skipToggle = on === undefined ? !skipToggle : Boolean(on);
      applySkip();
      return skipToggle;
    },
    /** Whether skip is on (toggle or hold). */
    getSkip: () => box.getSkip(),
    /** The lines shown this run, oldest first, for the backlog viewer. */
    getHistory: () => box.getHistory(),
    /** Clears the backlog. */
    clearHistory: () => box.clearHistory(),
    /**
     * Marks the run as a replay of a loaded save, or live again.
     *
     * Until it is turned off, lines are not shown, sounds are not played and
     * every animation lands at once — the run is travelling to its saved node,
     * not performing. The interpreter turns it off at the node, through
     * `onLive`.
     */
    setReplay: (on) => {
      replaying = Boolean(on);
    },
    /**
     * Marks the stage as travelling to a moment to be looked at.
     *
     * Changes land at once and no line waits for a click, but the line is drawn
     * — so the frame the author ends up on is the frame the scene will show.
     */
    setPreview: (on) => {
      previewing = Boolean(on);
    },
    /**
     * The `Audio` a script calls: a sound that keeps playing on its own.
     *
     * It is a constructor, not another stage method, so a script builds a
     * sound the way it builds a picture.
     */
    audio,
    /** The built-in effects and the videos a script may build. */
    effect,
    video,
    /**
     * 环境亮度：整块画面的乘算亮度，0–2，1 为原样。
     *
     * 只作用于画面层的背景、角色、视频、粒子、文字，对话框与选项不受影响。
     */
    setAmbient,
    /** 灯的演出端：`enable` 把灯挂上灯层，`disable` 摘下来。 */
    addLight,
    removeLight,
    /** 灯的一次数值过渡；`Light` 自己调用，宿主一般不需要。 */
    animateLight,
    /** 当前的环境亮度。 */
    getAmbient: () => lightAmbient,
    /** `stage.exclude(光源… : 对象…)` 的演出端：两个数组都不为空。 */
    exclude,
    /** `stage.unexclude(光源… : 对象…)`：撤销同一组排除。 */
    unexclude,
    /** `object.translucent(value)` 的演出端：光穿不穿过这个键对应的对象。 */
    setTranslucent,
    /** 这个键此刻是否透光，供宿主与测试读。 */
    translucentIsOn: translucentOf,
    /** `object.rim(强度)` 的演出端：逆光的轮廓光强度，0–1。 */
    setRim,
    /** 这个键此刻的轮廓光强度，供宿主与测试读。 */
    rimOf: rimLightOf,
    /** `character.aa(强度)` 的演出端：整张图的抗锯齿强度 0–2，默认 0（关）。 */
    setAntialias,
    /** `character.eaa(强度)` 的演出端：只柔化轮廓的强度 0–2，默认 0（关）。 */
    setEdgeAntialias,
    /** 这个键此刻的两档抗锯齿强度，供宿主与测试读。 */
    antialiasOf,
    /** 灯层此刻读到的剪影，供宿主与测试核对谁挡光、谁透光。 */
    lightObjects: litObjects,
    /** 场上正在亮的灯，供宿主/编辑器读。 */
    lightsOn: () => [...lights].filter((light) => light.placed),
    /** 打开/收起某个对象自己的三维坐标轴；默认谁都没开。 */
    setCrood,
    /** 某个对象此刻是否开着坐标轴，供宿主与测试读。 */
    croodIsOn: (key) => croodOn.has(key),
    /** 坐标轴覆盖层此刻读到的姿态，供宿主与测试核对透视投影。 */
    axesFrames,
    /** `stage.perspective(value)` 的演出端：默认关，关着时按正交投影画。 */
    setPerspective,
    /** 当前是否开着空间透视。 */
    perspectiveIsOn: () => perspectiveOn,
    /** `stage.guideline(value, interval)` 的演出端：默认关。 */
    setGuideline,
    /** 当前是否画着参考线。 */
    guidelineIsOn: () => guidelineOn,
    /** 参考线此刻的间隔。 */
    guidelineInterval: () => guidelineEvery,
    /**
     * Plays the voice track held in `name` and answers its length in ms.
     *
     * This is what a `say(text, time, audio)` binds its cut to. A name holding
     * no sound answers 0 rather than throwing, so a missing track falls back to
     * the line's normal timer instead of failing the run.
     */
    voice: (name) => audio.voice(name),
    /**
     * 开启 / 关闭自动配音，并可选地设定播放速度：`stage.autoVoice(speed)` 走这里。
     *
     * `speed` 为整数播放速度（次/秒，1–10，默认 10）；每两字播放一次单位音效。
     * 传 `true` 用默认速度开启，传 `false`/`0` 关闭。开启后，没有显式 `audio` 的
     * `say` 会自动配一段合成效果音；已有的 `audio` 配音优先，不受此开关影响。
     * 默认关闭、默认速度 10，随演出（舞台重建）重置。
     */
    setAutoVoice(on) {
      if (typeof on === "number") {
        autoVoiceOn = on > 0;
        autoVoiceSpeed = Math.min(
          AUTOVOICE_MAX_SPEED,
          Math.max(AUTOVOICE_MIN_SPEED, Math.round(on)),
        );
      } else {
        autoVoiceOn = Boolean(on);
        autoVoiceSpeed = AUTOVOICE_DEFAULT_SPEED;
      }
      if (autoVoiceOn) {
        // 提前把单位音效取回来：解码是异步的，不预热的话第一句的声音会比
        // 文字慢半拍才响起来。
        voiceEffect.preload();
      }
    },
    /** 当前是否开启自动配音。 */
    getAutoVoice() {
      return autoVoiceOn;
    },
    /**
     * Shows a question and answers the index the player picked.
     *
     * `-1` says the run was dropped before anyone answered, which is what the
     * interpreter turns into a stop rather than playing a branch nobody chose.
     */
    choose: chooser.ask,
    reset,
    setBackground,
    setCharacter,
    /**
     * 登记一个逐帧播放器，停掉同一槽位上的前一个。
     *
     * 对象自己拥有播放器，舞台只知道「当前的是哪一个」：这样重建变量与清空
     * 舞台都能把它停下，而不用在每次换帧时穿过舞台的其它状态。
     */
    registerSprite,
    /** Draws (or edits) the text in `slot`; the words and styles replace what was there. */
    setText,
    /** Where a rebuilt Text should continue from: the slot's frame and styles. */
    textState,
    setTextFont,
    setTextWeight,
    /** Paints `slot` in a new colour, fading over `time` milliseconds. */
    setTextColor,
    moveText,
    transformText,
    setTextAlpha,
    /** 把文字放到某个深度：0 是舞台平面，正数往画面里。 */
    setTextDepth,
    /** 把背景放到某个深度：0 是舞台平面，正数往画面里。 */
    setBackgroundDepth,
    /** 把角色放到某个深度：0 是舞台平面，正数往画面里。 */
    setCharacterDepth,
    /**
     * 重新按 z 排一遍背景与角色，把顺序写成元素的 `z-index`。
     *
     * 各触发点已经调用它，这里导出是给宿主与测试用的：不传参就重算一次。
     */
    applySceneOrder,
    /** Freezes a GIF on `frame` (1-based) or resumes it when `frame` is 0/empty. */
    stepGif,
    moveBackground,
    moveCharacter,
    /** Walks the character in `slot` along a motion path (`ui/path.js`). */
    followCharacterPath,
    /** Walks the backdrop along a motion path. */
    followBackgroundPath,
    /**
     * The variable name an object was assigned to, which is what its key is
     * filed under. A character answers its slot; the backdrop is always
     * `background`.
     */
    objectNameOf: (object) =>
      object?.kind === "Character" || object?.kind === "Text"
        ? String(object.slot ?? "")
        : object?.kind === "Background"
          ? "background"
          : "",
    /**
     * The spin a finished key walk must add back to the script-facing rotation.
     * `target` is `"background"` or a character slot; a module-level helper
     * cannot reach the entries this closure owns, so it asks through here.
     */
    spinOf,
    /** The box an object occupies, which is what a key's outline is drawn from. */
    objectBox,
    /**
     * Drops a whole key-frame state onto an object at once, for the editor's live
     * preview. `applyPreviewState(target, state)` takes the object name (a slot or
     * `"background"`) and the same `{ x, y, rotation, scale, scaleX, scaleY, alpha }`
     * a key frame holds.
     */
    applyPreviewState,
    /** Turns a path id into a path, through the host's reader. */
    resolvePath,
    /** Reports a `key()` that named a path nothing could read. */
    onMissingPath,
    transformBackground,
    transformCharacter,
    transformCharacterPoint,
    moveCharacterPoint,
    /** Fades the backdrop or a character, 0–1, over the milliseconds given. */
    setBackgroundAlpha,
    setCharacterAlpha,
    /** Brings a character to the front of the character layer, or sends it back. */
    raiseCharacter,
    lowerCharacter,
    /**
     * Replaces the backdrop with a dissolve: the new picture fades in over the
     * old, which is dropped when the fade is over.
     */
    crossFadeBackground,
    /**
     * The colour offset a `Background`/`Character` filter call paints, in the
     * 0–255 range, over the milliseconds the call gave (see `applyTint` above).
     */
    applyTint,
    /**
     * The look — blur, brightness, contrast, saturation — a `Background`/
     * `Character` filter call paints, over the milliseconds the call gave (see
     * `applyLook` above).
     */
    applyLook,
    /**
     * The eight points the character in `slot` is drawn through, as copies —
     * or `null` while it has no picture on the stage yet.
     *
     * Reading them back is the only way to hold the stage to what a free
     * transform promises: that a pull on one point leaves the other seven
     * exactly where they were.
     */
    characterPoints: (slot) => {
      const entry = slotOf(slot);
      if (!entry?.points) {
        return null;
      }
      const points = currentPoints(entry, perspectiveOn);
      return Object.fromEntries(
        Object.entries(points).map(([handle, at]) => [handle, { ...at }]),
      );
    },
    /**
     * What the slot already has on the stage, for a `Character` being built
     * into it: the frame, the tint and the name it speaks under.
     *
     * A script rebuilds a variable to change an expression, and the new object
     * has to continue from what the slot was drawing rather than from nothing.
     */
    characterState,
    /** Preserves the name a slot uses across that rebuild. */
    rememberCharacterName,
    /**
     * Answers whatever the run is parked on, so a stopped run can end.
     *
     * A run waiting for a click or an answer is not between statements, and
     * the interpreter only asks whether it was stopped between statements — so
     * this is what lets a run that the editor has abandoned reach its next
     * check and give up.
     */
    stop,
    clear,
    isEmpty: () => empty,
    /**
     * The asset path of the backdrop on the stage, or `null` when none is.
     *
     * A save records it so its slot can draw the scene it was made on, and the
     * host needs no second copy of "what is the background right now" to do it.
     */
    backgroundPath: () => background.path ?? null,
    /**
     * Releases what a removed element would not free on its own.
     *
     * The observer keeps watching the surface after the stage is gone, and
     * every sound owns a media element holding a `data:` source; both go here.
     * The listeners themselves sit on `element`, which is removed with the DOM.
     */
    destroy() {
      meshObserver?.disconnect();
      meshObserver = null;
      clear();
      audio.clear();
      // The dialogue layer watches its own box for resizing.
      box.dispose?.();
    },
  };
}
