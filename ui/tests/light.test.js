import assert from "node:assert/strict";
import test from "node:test";

import {
  LIGHT_BACK_FADE,
  LIGHT_DEFAULTS,
  LIGHT_FAR_REACH,
  falloffAt,
  lightColor,
  lightFaceAt,
  lightGeometry,
  lightRectWeight,
  lightShadeAt,
  lightShadeOf,
  lightWeightAt,
  neutralLight,
  normalizeLight,
  paintLights,
  wrapAngle,
} from "../light.js";

/** A normalised light with `patch` applied, for the geometry cases. */
const lamp = (patch = {}) => normalizeLight({ ...LIGHT_DEFAULTS, ...patch });

/**
 * A canvas 2D stand-in that only records the conic (wedge) masks a lamp asks
 * for. Enough of the API for `paintLights` to walk its whole drawing path.
 */
function coneMasksOf(light) {
  const masks = [];
  const gradient = { addColorStop() {} };
  const noop = () => {};
  const context = () => ({
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "",
    filter: "none",
    save: noop,
    restore: noop,
    setTransform: noop,
    clearRect: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    clip: noop,
    fill: noop,
    fillRect: noop,
    arc: noop,
    drawImage: noop,
    createRadialGradient: () => gradient,
    createConicGradient: (start) => {
      masks.push(start);
      return gradient;
    },
  });
  const halo = { getContext: context };
  paintLights(context(), [normalizeLight(light)], {
    size: { width: 1920, height: 1080 },
    scale: 1,
    scratch: { light: halo, bloom: null, lit: null },
  });
  return masks;
}

/**
 * The rim-light passes a lamp makes, as the alpha each one was composited with.
 *
 * 轮廓光在灯层上是「把那张轮廓画布用 `lighter` 加一次，并带上 blur」。所以灯层
 * 上下文里带着 filter 的那几次 `drawImage` 就是它 —— 软光也会带 filter，但软光
 * 的 filter 来自 `soft`，这里给的灯都不写 soft。
 */
function rimPassesOf(light, objects) {
  const passes = [];
  const gradient = { addColorStop() {} };
  const noop = () => {};
  const context = (onDraw) => {
    const ctx = {
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillStyle: "",
      filter: "none",
      save: noop,
      restore: noop,
      setTransform: noop,
      clearRect: noop,
      translate: noop,
      rotate: noop,
      scale: noop,
      beginPath: noop,
      moveTo: noop,
      lineTo: noop,
      closePath: noop,
      clip: noop,
      fill: noop,
      fillRect: noop,
      arc: noop,
      drawImage: () => onDraw?.(ctx),
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
    };
    return ctx;
  };
  const layer = context((ctx) => {
    if (ctx.globalCompositeOperation === "lighter" && String(ctx.filter).startsWith("blur(")) {
      passes.push({ alpha: ctx.globalAlpha, filter: ctx.filter });
    }
  });
  paintLights(
    layer,
    [{ ...normalizeLight(light), excluded: new Set(light.excluded ?? []) }],
    {
      size: { width: 1920, height: 1080 },
      scale: 1,
      objects,
      scratch: { light: { getContext: () => context() }, rim: { getContext: () => context() }, lit: null },
    },
  );
  return passes;
}

/**
 * The silhouettes a lamp cuts out of its own halo, named by their bitmaps.
 *
 * Only the `destination-out` pass is recorded, which is exactly the `holesOf`
 * step: named exclusions and objects standing in front of the lamp.
 */
function haloHolesOf(light, objects) {
  const holes = [];
  const gradient = { addColorStop() {} };
  const noop = () => {};
  const context = () => {
    const ctx = {
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillStyle: "",
      filter: "none",
      save: noop,
      restore: noop,
      setTransform: noop,
      clearRect: noop,
      translate: noop,
      rotate: noop,
      scale: noop,
      beginPath: noop,
      moveTo: noop,
      lineTo: noop,
      closePath: noop,
      clip: noop,
      fill: noop,
      fillRect: noop,
      arc: noop,
      drawImage: (image) => {
        if (ctx.globalCompositeOperation === "destination-out" && image?.name) {
          holes.push(image.name);
        }
      },
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
    };
    return ctx;
  };
  const halo = { getContext: context };
  paintLights(
    context(),
    [{ ...normalizeLight(light), excluded: new Set(light.excluded ?? []) }],
    {
      size: { width: 1920, height: 1080 },
      scale: 1,
      objects,
      scratch: { light: halo, rim: null, lit: null },
    },
  );
  return holes;
}

test("a fresh light is white, full strength, a whole circle", () => {
  const light = neutralLight();
  assert.equal(light.color, "FFFFFF");
  assert.equal(light.intensity, 1);
  assert.equal(light.opacity, 1);
  assert.equal(light.spread, 360);
  assert.equal(light.range, -1);
  // 三个转角都是 0：筒口朝 +x（画面右），看到的是光锥的侧视图。
  assert.equal(light.rotateH, 0);
  assert.equal(light.rotateV, 0);
  assert.equal(light.rotate, 0);
});

test("out-of-range numbers are clamped rather than refused", () => {
  const light = normalizeLight({
    intensity: 40,
    opacity: -3,
    spread: 900,
    range: 999999,
    bloom: 5,
    soft: -1,
    z: -20,
    rotateH: 200,
    rotateV: -90,
  });
  assert.equal(light.intensity, 8);
  assert.equal(light.opacity, 0);
  assert.equal(light.spread, 360);
  assert.equal(light.range, 20000);
  assert.equal(light.bloom, 1);
  assert.equal(light.soft, 0);
  // z 是深度：负数在观众这一侧，是合法的；只有离谱的数才夹取。
  assert.equal(light.z, -20);
  assert.equal(normalizeLight({ z: -99999 }).z, -1500);
  assert.equal(normalizeLight({ z: 99999 }).z, 8000);
  // 转角不回卷：动画要能连续数过 360，这一格跳回去就毁了。
  assert.equal(light.rotateH, 200);
  assert.equal(light.rotateV, -90);
});

test("a negative range means no written limit", () => {
  assert.equal(normalizeLight({ range: -1 }).range, -1);
  assert.equal(normalizeLight({ range: -500 }).range, -1);
});

test("angles wrap into one turn", () => {
  assert.equal(wrapAngle(0), 0);
  assert.equal(wrapAngle(360), 0);
  assert.equal(wrapAngle(-90), 270);
  assert.equal(wrapAngle(450), 90);
  assert.equal(wrapAngle(Number.NaN), 0);
});

test("a hex colour is read in both spellings, and a broken one is white", () => {
  assert.deepEqual(lightColor("FFD9A0"), { r: 255, g: 217, b: 160 });
  assert.deepEqual(lightColor("#abc"), { r: 170, g: 187, b: 204 });
  assert.deepEqual(lightColor("nope"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(lightColor({ r: 300, g: -4, b: 12 }), { r: 255, g: 0, b: 12 });
});

test("a lamp aimed at the camera lands where it stands, as a circle", () => {
  const geometry = lightGeometry(lamp({ x: 100, y: -40, range: 800, rotateH: 90 }), 1, {
    width: 1920,
    height: 1080,
  });
  assert.equal(geometry.sx, 1060);
  assert.equal(geometry.sy, 580);
  assert.equal(geometry.rx, 800);
  assert.equal(geometry.ry, 800);
});

test("an infinite range still draws a finite footprint", () => {
  const geometry = lightGeometry(lamp(), 1, { width: 1920, height: 1080 });
  assert.equal(geometry.ry, LIGHT_FAR_REACH);
});

const SIZE = { width: 1920, height: 1080 };

test("a fresh lamp points +x; rotateH(90) aims it at the camera", () => {
  const side = lightGeometry(lamp({ spread: 60, z: 600, range: 2000 }), 1, SIZE);
  const front = lightGeometry(lamp({ spread: 60, z: 600, range: 2000, rotateH: 90 }), 1, SIZE);
  assert.ok(side.rx > side.ry, "a beam along the stage plane is a long wedge");
  assert.equal(side.heading, 0, "+x is right on the canvas");
  assert.equal(front.rx, front.ry, "aimed at the camera the cone is seen end on");
  assert.equal(front.fan, 360, "no angular slice is cut out of a round spot");
  assert.equal(front.sx, SIZE.width / 2, "a beam straight at the camera does not drift");
  const halfway = lightGeometry(lamp({ spread: 60, z: 600, range: 2000, rotateH: 45 }), 1, SIZE);
  assert.ok(halfway.sx > front.sx, "a slanted beam still throws its footprint to the right");
  const omni = lightGeometry(lamp({ z: 600, range: 2000 }), 1, SIZE);
  assert.equal(omni.rx, omni.ry, "全向光没有光束方向，方位不该把光斑拉成长条");
});

test("a lamp turned along V presses its beam down", () => {
  const down = lightGeometry(lamp({ spread: 60, rotateH: 90, rotateV: 60, z: 600, range: 2000 }), 1, SIZE);
  const front = lightGeometry(lamp({ spread: 60, rotateH: 90, rotateV: 0, z: 600, range: 2000 }), 1, SIZE);
  assert.ok(down.rx > front.rx, "along the beam the footprint is stretched");
  assert.ok(down.sy > front.sy, "y runs down the canvas, so the footprint drops");
  assert.equal(down.sx, front.sx, "a downward beam does not lean sideways");
});

test("rotateV stays in yOz: it never shows left or right", () => {
  // 先把方位转到 H = 90，再沿 V 面抬落。V 绕世界平轴，x 分量一动不动，
  // 所以摄影机看过去只有上下与深浅。`rotate` 是在 H / V 都摆好之后才在画面里
  // 转整盏灯（见下一条），所以这里不掺它。
  const base = { spread: 60, range: 1000, rotateH: 90 };
  for (const tilt of [45, 60, 90]) {
    const light = lamp({ ...base, rotateV: tilt });
    assert.equal(
      wrapAngle(lightGeometry(light, 1, SIZE).heading),
      90,
      `rotateV(${tilt}) 仍然朝画面下方`,
    );
    assert.ok(lightWeightAt(light, 0, -300) > 0, "下方亮");
    assert.equal(lightWeightAt(light, 300, 0), 0, "右边全暗");
    assert.equal(lightWeightAt(light, -300, 0), 0, "左边全暗");
  }
  // 完全正对镜头时锥体收成圆，不该再切出扇形。
  const straight = lamp({ ...base, rotateV: 0 });
  assert.equal(lightGeometry(straight, 1, SIZE).fan, 360);
  // 抬头是 V 的另一半，也一样只在竖直里走。
  const lifted = lamp({ ...base, rotateV: -45 });
  assert.equal(wrapAngle(lightGeometry(lifted, 1, SIZE).heading), 270);
  assert.ok(lightWeightAt(lifted, 0, 300) > 0, "上方亮");
  assert.equal(lightWeightAt(lifted, -300, 0), 0, "左边仍然全暗");

  // 左右那一支是 H 面，别混到 V 上。
  const horizontal = lamp({ ...base, rotateH: 0, rotateV: 0 });
  assert.ok(lightWeightAt(horizontal, 300, 0) > 0);
});

test("rotate turns the whole lamp in the page: a beam to the right goes down", () => {
  // `rotate` 是画面里的转动，与立绘的 `rotate`、CSS 的 `rotate()` 同向（顺时针）。
  // 刚创建的灯朝 +x，于是 rotate(90) 朝下照、180 朝左、270 朝上。
  const aimed = (turn) =>
    lightGeometry(lamp({ spread: 60, range: 1000, rotate: turn }), 1, SIZE);
  assert.equal(wrapAngle(aimed(0).heading), 0, "0 度朝右");
  assert.equal(wrapAngle(aimed(90).heading), 90, "90 度朝下");
  assert.equal(wrapAngle(aimed(180).heading), 180, "180 度朝左");
  assert.equal(wrapAngle(aimed(270).heading), 270, "270 度朝上");
  // 沿光束那一侧被拉长：椭圆的长轴指向光束甩出去的方向。
  const down = aimed(90);
  assert.ok(down.rx > down.ry, "光斑沿光束拉长");
  assert.equal(down.sx, SIZE.width / 2, "光还在灯脚下：朝下照不往旁边甩");
  assert.equal(down.sy, SIZE.height / 2);

  // 受光区跟着转：亮的是灯下面那一块，右边不再是亮区。
  const beam = lamp({ spread: 90, range: 600, rotate: 90 });
  assert.ok(lightWeightAt(beam, 0, -300) > 0, "下方亮");
  assert.equal(lightWeightAt(beam, 300, 0), 0, "右边全暗");
  assert.equal(lightWeightAt(beam, -300, 0), 0, "左边全暗");
});

test("a lamp aimed at the camera keeps its round footprint when the page turns", () => {
  // 正对镜头时推轴就是视线：在画面里转它不会挪动光斑，只会把锥口的 0 度方向
  // （以及灯管）一起转过去。
  const straight = lightGeometry(lamp({ z: 500, range: 1000, rotateH: 90 }), 1, SIZE);
  const rolled = lightGeometry(lamp({ z: 500, range: 1000, rotateH: 90, rotate: 35 }), 1, SIZE);
  assert.equal(rolled.sx, straight.sx);
  assert.equal(rolled.sy, straight.sy);
  assert.equal(rolled.rx, straight.rx);
  assert.equal(rolled.ry, straight.ry);
  assert.equal(wrapAngle(rolled.heading - straight.heading), 35, "锥口跟着灯面转");
});

test("range is a distance in space: the lamp's own depth eats into it", () => {
  // 灯离平面 900，射程只有 500：光在走到镜头这一层之前就已经衰减到零，
  // 平面上不该有任何光斑，也不该有任何一点受光。
  const sunk = lamp({ z: 900, range: 500, rotateH: 90 });
  const geometry = lightGeometry(sunk, 1, SIZE);
  assert.equal(geometry.rx, 0, "射程够不到这一层，没有光斑");
  assert.equal(geometry.ry, 0);
  assert.equal(geometry.fade, 0);
  assert.equal(lightWeightAt(sunk, 0, 0), 0, "平面上再近的点也照不到");

  // 用户报的那一帧：range 1000、z 5000、筒口正对镜头。光最多走到 z = 4000，
  // 到不了 z = 0 的舞台，画面应该整片是黑的。
  assert.equal(lightGeometry(lamp({ z: 5000, range: 1000, rotateH: 90 }), 1, SIZE).ry, 0);

  // 够得着的时候，平面上的光斑是 sqrt(range² − depth²)：深度越大越小，
  // 而且到不了「灯就在平面上」时的那个 range。
  const near = lightGeometry(lamp({ z: 0, range: 500 }), 1, SIZE);
  const far = lightGeometry(lamp({ z: 300, range: 500 }), 1, SIZE);
  assert.equal(near.ry, 500, "灯就在平面上时，光斑半径就是射程");
  assert.ok(far.ry < near.ry, "深度先花掉一段射程，平面上的光斑只会更小");
  assert.ok(Math.abs(far.ry - Math.sqrt(500 * 500 - 300 * 300)) < 1e-9);

  // 正好卡在射程上就没了。
  assert.equal(lightGeometry(lamp({ z: 500, range: 500 }), 1, SIZE).ry, 0);

  // 无限远的灯没有射程可花，照旧按画面上那个有限半径画。
  assert.equal(lightGeometry(lamp({ z: 5000 }), 1, SIZE).ry, LIGHT_FAR_REACH);
});

test("the strength peaks at the lamp and reaches zero at the edge", () => {
  const light = lamp({ x: 0, y: 0, range: 600, spread: 360, rotateH: 90 });
  assert.ok(lightWeightAt(light, 0, 0) > 0.99);
  assert.ok(lightWeightAt(light, 300, 0) > 0);
  assert.equal(lightWeightAt(light, 700, 0), 0);
});

test("both a written and an unwritten range fall away with distance", () => {
  assert.equal(falloffAt(0, false), 1);
  assert.equal(falloffAt(1, false), 0);
  assert.equal(falloffAt(0, true), 1);
  assert.equal(falloffAt(1, true), 0);
  // 无限远不是「整屏一样亮」：它只是没有写死的截止，中心亮、边缘暗。
  assert.ok(falloffAt(0.5, true) < 1, "an unwritten range is not a flat sheet");
  assert.ok(falloffAt(0.5, true) > falloffAt(0.5, false), "it still reaches further than a written one");
  assert.ok(falloffAt(0.95, true) < 0.5);
  assert.ok(falloffAt(0.2, true) > falloffAt(0.8, true), "nearer the lamp is brighter");
});

test("a cone lights its own side and nothing behind it", () => {
  // 刚创建的灯朝 +x 打出 90° 的画角，只盖住右边那一块。
  const light = lamp({ spread: 90, range: 600 });
  assert.ok(lightWeightAt(light, 300, 0) > 0);
  assert.equal(lightWeightAt(light, -300, 0), 0);
  assert.equal(lightWeightAt(light, 0, 300), 0);
});

test("a lamp pressed flat along V points straight down the plane", () => {
  // H = 90 先把筒口转到 -z，V = 90 再把光束压到 W 面里、笔直朝 -y。
  const light = lamp({ spread: 90, rotateH: 90, rotateV: 90, range: 600 });
  assert.ok(lightWeightAt(light, 0, -300) > 0);
  assert.equal(lightWeightAt(light, 0, 300), 0);
});

test("a beam rolled past the frame does not wrap around and light its opposite", () => {
  // H 转过 180° 之后光束朝 -x，190° 时锥角落在 -x 那一侧，绝不回头照亮 +x。
  const light = lamp({ spread: 60, rotateH: 190, range: 600 });
  assert.ok(lightWeightAt(light, -300, -40) > 0, "inside the cone, just below -x");
  assert.equal(lightWeightAt(light, 300, 40), 0, "the opposite side stays dark");
});

test("a flashlight aimed at the camera is a round spot, not a side-view wedge", () => {
  // 手电筒在 H 面顺时针转 90 度，筒口正对镜头：锥体的圆形横截面把四个方向
  // 都照亮，绕自己的轴打滚也不会把光斑切回扇形。
  const front = lamp({ spread: 60, range: 1000, rotateH: 90 });
  const geometry = lightGeometry(front, 1, SIZE);
  assert.equal(geometry.fan, 360, "投影成一整圈");
  assert.equal(geometry.rx, geometry.ry, "光斑是正圆");
  assert.ok(geometry.rx < 1000, "窄光束的锥底比整片光斑小");
  for (const [x, y] of [[300, 0], [0, -300], [-300, 0], [0, 300]]) {
    assert.ok(lightWeightAt(front, x, y) > 0, `(${x}, ${y}) 都在圆光斑里`);
  }
  const turned = lightGeometry(lamp({ spread: 60, range: 1000, rotateH: 90, rotate: 90 }), 1, SIZE);
  assert.equal(turned.sx, geometry.sx);
  assert.equal(turned.sy, geometry.sy);
  assert.equal(turned.rx, geometry.rx);
  assert.equal(turned.ry, geometry.ry);
  assert.equal(wrapAngle(turned.heading - geometry.heading), 90, "打滚只改灯面朝向");
  assert.deepEqual(turned.bar, geometry.bar, "圆锥轴对称，横截面里的灯管方向不变");

  // 侧着的灯仍是楔形：只有 +x 那一侧亮。
  const side = lamp({ spread: 60, range: 1000 });
  assert.ok(lightWeightAt(side, 300, 0) > 0);
  assert.equal(lightWeightAt(side, -300, 0), 0);
});

test("a tilted lamp sweeps with the page: rotate is a turn, not a roll", () => {
  // 先摆进空间（H 面方位 + V 面低头的 60 度），整盏灯再在画面里转 90 度：
  // 朝下的光因此变成朝左，光斑大小不变，方向跟着画面一起转。
  const tipped = { spread: 60, range: 1000, rotateH: 90, rotateV: 60 };
  const straight = lightGeometry(lamp(tipped), 1, SIZE);
  const turned = lightGeometry(lamp({ ...tipped, rotate: 90 }), 1, SIZE);
  assert.equal(wrapAngle(straight.heading), 90, "不转时朝画面下方");
  assert.equal(wrapAngle(turned.heading), 180, "画面里转 90 度之后朝左");
  assert.equal(turned.rx, straight.rx, "光斑大小不变，只是换了方向");
  assert.equal(turned.ry, straight.ry);
  assert.ok(lightWeightAt(lamp({ ...tipped, rotate: 90 }), -300, 0) > 0, "左边亮起来");
  assert.equal(lightWeightAt(lamp({ ...tipped, rotate: 90 }), 0, -300), 0, "正下方不再是亮区");
  assert.ok(lightWeightAt(lamp(tipped), 0, -300) > 0, "低头 60° 朝画面下方打");
});

test("a lamp behind a character is blocked by it, a lamp in front is not", () => {
  const objects = [
    // 背景铺满整帧、深度与角色相同，但它画的是整个世界，永远不按深度挡光。
    { key: "background", bitmap: { name: "background" }, z: 0, cast: false, x: 0, y: 0, w: 1920, h: 1080 },
    { key: "character:hero", bitmap: { name: "hero" }, z: 0, x: -80, y: -100, w: 600, h: 900 },
  ];
  // 用户报的那一帧：灯 z = 5、角色 z = 0，只差 5 像素，角色也该挡在灯前面。
  assert.deepEqual(haloHolesOf({ z: 5 }, objects), ["hero"]);
  // 灯在角色前面：光斑照常盖过它。
  assert.deepEqual(haloHolesOf({ z: -5 }, objects), []);
  // 同深度不挡：老剧本里灯与角色都没写过 z，观感一点不变。
  assert.deepEqual(haloHolesOf({ z: 0 }, objects), []);
  // 点名排除照旧生效，背景也能被点名；深度挡光只加不减。
  assert.deepEqual(haloHolesOf({ z: 400, excluded: ["background"] }, objects), ["background", "hero"]);
});

test("a rim light is the object's own switch, and only when the lamp is behind it", () => {
  const hero = { key: "character:hero", bitmap: { name: "hero" }, z: 0, x: 0, y: 0, w: 600, h: 900, cast: true };
  // 正对镜头（rotateH 90）才照得到舞台平面；灯在背后靠 z 拉开距离。
  const behind = lamp({ bloom: 0.6, z: 400, rotateH: 90 });

  // 默认不勾边：对象没写强度，灯再怎么泛光也没有那圈边。
  assert.deepEqual(rimPassesOf(behind, [hero]), [], "对象 rim 为 0 就没有轮廓光");

  const faint = rimPassesOf(behind, [{ ...hero, rim: 0.25 }]);
  const full = rimPassesOf(behind, [{ ...hero, rim: 1 }]);
  assert.equal(faint.length, 1, "写了强度就勾一次");
  assert.ok(faint[0].filter.startsWith("blur("), "勾边要模糊：硬边是描边，不是光");
  assert.ok(full[0].alpha > faint[0].alpha * 3, "强度是乘上去的，不是开关");

  // 灯在正面：那是补光，不是轮廓光。
  assert.deepEqual(rimPassesOf(lamp({ bloom: 0.6, z: -400, rotateH: 90 }), [{ ...hero, rim: 1 }]), []);
  // 灯自己没开泛光：半径与柔度都无从谈起。
  assert.deepEqual(rimPassesOf(lamp({ bloom: 0, z: 400, rotateH: 90 }), [{ ...hero, rim: 1 }]), []);
});

test("an object that lets light through is never cut out of the halo", () => {
  // 透光就是 `cast: false`：灯站在它背后，光也从它的轮廓中间穿过去。
  const objects = [
    { key: "character:hero", bitmap: { name: "hero" }, z: 0, cast: false, x: 0, y: 0, w: 600, h: 900 },
  ];
  assert.deepEqual(haloHolesOf({ z: 400 }, objects), [], "光穿过去，不挖剪影");
  // 但「这盏灯不照它」仍然是剪影：透光与点名排除是两件事。
  assert.deepEqual(
    haloHolesOf({ z: 400, excluded: ["character:hero"] }, objects),
    ["hero"],
    "点名排除压过透光",
  );
});

test("a lamp behind the object lights its rim, not its face", () => {
  const plane = normalizeLight({ z: 0 });
  assert.equal(lightFaceAt(plane, 0), 1, "on the stage plane the face is lit as before");
  assert.equal(lightFaceAt(normalizeLight({ z: -300 }), 0), 1, "a lamp in front lights the face");
  // 对象自己朝观众挪 300，等于灯相对后退了 300。
  assert.equal(lightFaceAt(plane, -300), 1 - 300 / LIGHT_BACK_FADE);

  const behind = normalizeLight({ z: LIGHT_BACK_FADE });
  assert.equal(lightFaceAt(behind, 0), 0, "a lamp this far back only leaves the rim");

  const halfway = normalizeLight({ z: LIGHT_BACK_FADE / 2 });
  assert.equal(lightFaceAt(halfway, 0), 0.5, "the face dims as the lamp goes behind");

  // 对象自己朝观众挪 700，等于灯相对退到了它背后。
  assert.equal(lightFaceAt(plane, -LIGHT_BACK_FADE), 0);
  // 反过来，对象退到深处而灯留在观众这一侧，正面照旧是满的。
  assert.equal(lightFaceAt(plane, LIGHT_BACK_FADE), 1);
});

test("a light at zero opacity or strength lights nothing", () => {
  assert.equal(lightWeightAt(lamp({ opacity: 0 }), 0, 0), 0);
  assert.equal(lightWeightAt(lamp({ intensity: 0 }), 0, 0), 0);
  assert.equal(lightWeightAt(null, 0, 0), 0);
});

test("a rectangle is weighed by its brightest corner", () => {
  const light = lamp({ range: 400, rotateH: 90 });
  // The middle is past the edge; the rectangle's near side still reaches in.
  const rect = { x: 500, y: 0, w: 400, h: 400 };
  assert.equal(lightWeightAt(light, 500, 0), 0);
  assert.ok(lightRectWeight(light, rect) > 0);
});

test("a width is clamped instead of refused", () => {
  assert.equal(neutralLight().width, 0, "a light starts as a point");
  assert.equal(normalizeLight({ width: -20 }).width, 0);
  assert.equal(normalizeLight({ width: 99999 }).width, 4000);
});

test("a bar is the source: it lights its own length, then fades past the ends", () => {
  // 正对镜头时灯面贴在 W 面上，灯管就沿平轴横着躺。
  const point = lamp({ range: 1000, spread: 360, rotateH: 90 });
  const bar = lamp({ range: 1000, spread: 360, width: 600, rotateH: 90 });

  // 管身以内就是灯本身：整段满亮，不是「只有中间亮」的一条带。
  assert.equal(lightWeightAt(bar, 290, 0), 1);
  assert.ok(lightWeightAt(point, 290, 0) < 0.75);

  // 出了管端才按距离暗下去，而且是软的——灯管的边不该是一刀切。
  const past = lightWeightAt(bar, 480, 0);
  assert.ok(past > 0 && past < 1, "管外应该慢慢暗下去");
  assert.ok(past > lightWeightAt(point, 480, 0), "灯管照亮它自己那么宽的一条");
});

test("the beam leaves the bar and fans out with distance", () => {
  // 先正对镜头、再低头 70°：光束朝画面下方扫出去，灯管还是横着。
  const beam = lamp({ range: 3000, spread: 60, rotateH: 90, rotateV: 70, width: 600 });

  // 近处：管端外侧一点点，仍在 30° 的锥里。
  assert.ok(lightWeightAt(beam, 320, -600) > 0);
  // 近处：贴着灯管却偏出锥角——旧版「等宽带」会把光画到这里。
  assert.equal(lightWeightAt(beam, 400, -100), 0);
  // 远处：同样的偏出量已经在张开的锥里，亮。
  assert.ok(lightWeightAt(beam, 800, -1000) > 0);
  // 同一个横向偏移放在近处是暗的：这就是「光从灯管张开」。
  assert.equal(lightWeightAt(beam, 800, -100), 0);
});

test("the bar's width travels in canvas pixels", () => {
  const geometry = lightGeometry(lamp({ width: 600 }), 0.5, { width: 960, height: 540 });
  assert.equal(geometry.w, 300, "600 logical pixels at half scale");
  assert.equal(geometry.half, 150, "the emitter bar is half the width on each side");

  const point = lightGeometry(lamp({ width: 0 }), 2, { width: 1920, height: 1080 });
  assert.equal(point.w, 0, "no width is still a point light");
});

test("the cone's projected wedge widens as the beam turns toward the camera", () => {
  const fanAt = (rotateH) => lightGeometry(lamp({ spread: 60, range: 1000, rotateH }), 1, SIZE).fan;
  assert.ok(Math.abs(fanAt(0) - 60) < 1e-9, "edge on: the 2D wedge keeps the written spread");
  assert.ok(fanAt(60) > 90, "turned toward the camera: the wedge opens up");
  assert.equal(fanAt(90), 360, "end on: the whole circular cross-section");
});

test("a beam just short of facing the camera is a glow, not a notch through its own middle", () => {
  // 用户报的那一帧：`rotateH = 70`、`spread = 60` 时镜头已经钻进锥里，扇形涨到
  // 240°，光斑于是被挖掉一块从灯心张开的楔子，像一个被啃掉一角的饼。那时缺
  // 的其实只是灯自己挡住的背面，画面上根本看不见，不该切出来。
  const offAxis = lamp({ spread: 60, range: 1000, rotateH: 70 });
  const geometry = lightGeometry(offAxis, 1, SIZE);
  assert.ok(Math.abs(geometry.fan - 240) < 1e-9, "扇形仍然是 240 度");
  assert.equal(geometry.cut, 0, "但缺口不再切掉");
  // 四个方位一样亮：转成光晕，没有方向性折痕。
  const ring = [0, 90, 180, 270].map((at) => {
    const angle = (at * Math.PI) / 180;
    return lightWeightAt(offAxis, 300 * Math.cos(angle), 300 * Math.sin(angle));
  });
  for (const weight of ring) {
    assert.ok(weight > 0, "整圈都受光");
    assert.ok(Math.abs(weight - ring[0]) < 0.05, "各方位几乎一样亮");
  }

  // 侧视时锥外还是要全黑：这一改不能把锥边一起放掉。
  const side = lamp({ spread: 60, range: 1000 });
  assert.equal(lightGeometry(side, 1, SIZE).cut, 1);
  assert.equal(lightWeightAt(side, -300, 0), 0);

  // 60…70 之间是渐变，不是一跳：缺口先淡，锥边同时变软。
  const tilted = lamp({ spread: 60, range: 1000, rotateH: 65 });
  const mid = lightGeometry(tilted, 1, SIZE);
  assert.ok(mid.cut > 0 && mid.cut < 1, "还没进到锥心，缺口只淡掉一半");
  const behind = lightWeightAt(tilted, -300, 0);
  assert.ok(behind > 0 && behind < lightWeightAt(tilted, 300, 0), "背面比正面暗，但不是全黑");
});

test("the cone's edge softens as the projection stretches it", () => {
  // 只有扇形正好等于书写的 spread（侧视）时，那条边才是真的锥边。
  const softness = (rotateH) => lightGeometry(lamp({ spread: 60, rotateH }), 1, SIZE).penumbra;
  assert.ok(softness(0) < 8, "侧视是一盏聚光灯，边缘要利");
  assert.ok(softness(45) < 20);
  assert.ok(softness(60) > 40, "张成半平面时边缘已经是一段渐变");
  assert.ok(softness(55) < softness(65), "越朝镜头越软");

  // 同一条边上，权重是连续的：从锥里到锥外没有悬崖，只有一段斜坡。
  const edge = lamp({ spread: 60, range: 3000, rotateH: 60 });
  const at = (degrees) => {
    const angle = (degrees * Math.PI) / 180;
    return lightWeightAt(edge, 600 * Math.cos(angle), 600 * Math.sin(angle));
  };
  for (let degrees = 60; degrees <= 140; degrees += 10) {
    assert.ok(at(degrees) >= at(degrees + 10) - 1e-9, `在 ${degrees}° 处单调变暗`);
    assert.ok(at(degrees) - at(degrees + 10) < 0.4, `在 ${degrees}° 处没有悬崖`);
  }
});

test("the H quadrants follow the coordinate diagram", () => {
  assert.equal(wrapAngle(lightGeometry(lamp(), 1, SIZE).heading), 0, "0 is +x");
  assert.equal(wrapAngle(lightGeometry(lamp({ rotateH: 180 }), 1, SIZE).heading), 180, "180 is -x");
  assert.equal(lightGeometry(lamp({ rotateH: 90 }), 1, SIZE).fan, 360, "90 faces the camera");
  assert.ok(lightGeometry(lamp({ rotateH: 270 }), 1, SIZE).rx > 0, "270 points into the scene");
});

test("the painted cone mask follows the view: a wedge side on, nothing end on", () => {
  // 用户报的那一帧：手电筒转 90 度朝向镜头，不该再切出侧视的扇形。
  assert.equal(coneMasksOf({ spread: 60, rotateH: 0 }).length, 1, "侧视是要切扇形的");
  assert.equal(coneMasksOf({ spread: 60, rotateH: 90 }).length, 0, "正对镜头画的是整片圆");
  assert.equal(coneMasksOf({ spread: 360, rotateH: 0 }).length, 0, "全向光本来就没有锥边");
});

test("a narrow flashlight facing the camera keeps a round, small aperture", () => {
  const narrow = lightGeometry(lamp({ spread: 30, range: 1000, rotateH: 90 }), 1, SIZE);
  const wide = lightGeometry(lamp({ spread: 120, range: 1000, rotateH: 90 }), 1, SIZE);
  assert.equal(narrow.rx, narrow.ry);
  assert.ok(narrow.rx < wide.rx, "the smaller cone angle draws the smaller circle");
  assert.ok(lightWeightAt(lamp({ spread: 30, range: 1000, rotateH: 90 }), 0, 200) > 0);
});

test("the rim is a ring: the silhouette is blurred before it is cut away", () => {
  // 轮廓光 = 剪影往外糊开的那一圈。模糊必须在扣掉剪影之前发生：先画实心剪影、
  // 最后才靠合成时的 `filter` 去糊，画布上已经自己减自己减空了，边光不出现。
  const drawn = [];
  const gradient = { addColorStop() {} };
  const noop = () => {};
  const contexts = new Map();
  const canvasOf = (name) => ({
    getContext() {
      if (!contexts.has(name)) {
        const ctx = {
          globalAlpha: 1,
          globalCompositeOperation: "source-over",
          fillStyle: "",
          filter: "none",
          save: noop,
          restore: noop,
          setTransform: noop,
          clearRect: noop,
          translate: noop,
          rotate: noop,
          scale: noop,
          beginPath: noop,
          moveTo: noop,
          lineTo: noop,
          closePath: noop,
          clip: noop,
          fill: noop,
          fillRect: noop,
          arc: noop,
          createRadialGradient: () => gradient,
          createConicGradient: () => gradient,
          drawImage: () => {
            drawn.push({ name, op: ctx.globalCompositeOperation, filter: String(ctx.filter) });
          },
        };
        contexts.set(name, ctx);
      }
      return contexts.get(name);
    },
  });
  const hero = {
    key: "character:hero",
    bitmap: { name: "hero" },
    z: 0,
    x: 0,
    y: 0,
    w: 600,
    h: 900,
    cast: true,
    rim: 1,
  };
  paintLights(canvasOf("layer").getContext("2d"), [{ ...normalizeLight({ bloom: 0.6, z: 400, rotateH: 90 }), excluded: new Set() }], {
    size: { width: 1920, height: 1080 },
    scale: 1,
    objects: [hero],
    scratch: { light: canvasOf("halo"), rim: canvasOf("rim"), lit: null },
  });

  const rimOps = drawn.filter((item) => item.name === "rim");
  assert.ok(
    rimOps.some((item) => item.op === "source-over" && item.filter.startsWith("blur(")),
    "剪影要先糊开再上色",
  );
  assert.equal(rimOps.at(-1).op, "destination-out", "最后才把剪影本身扣掉");
});

test("a lamp in front of a character does not darken it", () => {
  const rect = { x: 0, y: 0, w: 600, h: 900 };
  // 灯在观众这一侧：正面照满了，没有暗部。
  assert.equal(lightShadeAt(lamp({ z: -300, rotateH: 90 }), rect, 0), 1);
  // 与角色同深度也一样，灯还没退到它后面。
  assert.equal(lightShadeAt(lamp({ z: 0, rotateH: 90 }), rect, 0), 1);
});

test("the deeper a lamp stands behind a character, the darker its face", () => {
  const rect = { x: 0, y: 0, w: 600, h: 900 };
  const near = lightShadeAt(lamp({ z: 200, rotateH: 90 }), rect, 0);
  const far = lightShadeAt(lamp({ z: 600, rotateH: 90 }), rect, 0);
  assert.ok(near < 1 && far < 1, "背后有灯就该压暗");
  assert.ok(far < near, "灯退得越深，正面照到的越少，越黑");
  assert.ok(far < 0.35, `z=600 时已经很黑，实际 ${far}`);
});

test("a lamp that does not reach the object casts no shadow on it", () => {
  const farAway = { x: 4000, y: 0, w: 600, h: 900 };
  assert.equal(lightShadeAt(lamp({ z: 500, x: 4000, rotateH: 90, range: 200 }), farAway, 0), 1);
  assert.equal(
    lightShadeAt(lamp({ z: 500, rotateH: 90 }), farAway, 0),
    1,
    "光场边界之外也不该有影子",
  );
});

test("a dim lamp blocks less light than a full one, and exclusion spares the object", () => {
  const rect = { x: 0, y: 0, w: 600, h: 900 };
  const dim = lightShadeAt(lamp({ z: 500, rotateH: 90, intensity: 0.3 }), rect, 0);
  const full = lightShadeAt(lamp({ z: 500, rotateH: 90, intensity: 1 }), rect, 0);
  assert.ok(dim > full, "0.3 的补光挡不住多少光");

  const lights = [{ ...lamp({ z: 500, rotateH: 90 }), excluded: new Set(["character:hero"]) }];
  assert.equal(lightShadeOf(lights, rect, 0, "character:hero"), 1, "被排除的对象不吃这盏灯的影子");
  assert.ok(lightShadeOf(lights, rect, 0, "character:rival") < 1, "没被排除的照吃");
});

test("two lamps behind add up to a darker shadow than either alone", () => {
  const rect = { x: 0, y: 0, w: 600, h: 900 };
  const one = [{ ...lamp({ z: 400, rotateH: 90 }), excluded: new Set() }];
  const two = [one[0], { ...lamp({ z: 400, x: 300, rotateH: 90 }), excluded: new Set() }];
  assert.ok(lightShadeOf(two, rect, 0) < lightShadeOf(one, rect, 0));
  assert.equal(lightShadeOf([], rect, 0), 1, "没灯就是原样");
});
