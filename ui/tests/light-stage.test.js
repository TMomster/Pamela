// `ui/stage.js` 的光源：灯层、环境亮度、排除与不排除。
// Tests for the light: its own layer, the ambient brightness, and exclusion.

import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../pamela.js";
import { createStage, createStageGlobals, createStageObjects } from "../stage.js";

/** A stand-in element, with just enough of the DOM for `createStage`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    log: [],
    style: new Proxy(
      {},
      {
        set(target, key, value) {
          target[key] = value;
          node.log.push(`style.${key}`);
          return true;
        },
      },
    ),
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
    append(child) {
      node.childNodes.push(child);
    },
    decode() {
      return Promise.resolve();
    },
    hidden: false,
    alt: "",
    draggable: false,
    src: "",
    textContent: "",
    removeAttribute(name) {
      if (name === "src") {
        node.src = "";
      }
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
  return node;
}

/** Runs `body` with a minimal `document`, so the stage can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  let result;
  try {
    result = body();
  } finally {
    if (!(result && typeof result.then === "function")) {
      globalThis.document = previous;
    }
  }
  if (result && typeof result.then === "function") {
    return result.finally(() => {
      globalThis.document = previous;
    });
  }
  return result;
}

/** A stage built over a fake DOM, with the light layer picked out. */
function domStage() {
  const surface = fakeElement();
  const stage = createStage({
    element: fakeElement(),
    surface,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
  });
  return {
    stage,
    surface,
    background: surface.childNodes[0],
    character: surface.childNodes[1],
    dialogue: surface.childNodes[2],
    light: surface.childNodes[7],
  };
}

test("a Light puts its canvas on the light layer, and only when enabled", () => {
  inFakeDom(() => {
    const { stage, light } = domStage();
    const lamp = createStageObjects(stage).Light(["FFD9A0", 1.2, 100, 200], {
      assignee: "lamp",
    });

    assert.equal(light.childNodes.length, 1, "the layer has its canvas from the start");
    assert.equal(light.childNodes[0].className, "stage__light");
    assert.equal(stage.lightsOn().length, 0, "a light that is not enabled is nothing");

    lamp.enable();
    assert.equal(stage.lightsOn().length, 1);
    assert.equal(stage.lightsOn()[0].params.color, "FFD9A0");
    assert.equal(stage.lightsOn()[0].params.x, 100);
    assert.equal(stage.lightsOn()[0].params.y, 200);

    lamp.disable();
    assert.equal(stage.lightsOn().length, 0, "disabling takes it off the stage");
    assert.equal(lamp.params.x, 100, "and keeps its numbers");
  });
});

test("a light keeps the numbers to the range its parameter accepts", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const lamp = createStageObjects(stage).Light([], {});

    lamp.intensity(99).spread(900).range(-5).zTo(-40);
    assert.equal(lamp.params.intensity, 8);
    assert.equal(lamp.params.spread, 360);
    assert.equal(lamp.params.range, -1, "a negative range means no written limit");
    // zTo 是绝对深度：负数把灯放到观众这一侧，是合法的，只有离谱的数才夹取。
    assert.equal(lamp.params.z, -40);
    lamp.zTo(-99999);
    assert.equal(lamp.params.z, -1500);

    // 三个转角都不回卷：动画要能一路数过 360，而不是在那一格跳回来。
    lamp.rotateH(370).rotateV(-190).rotate(725);
    assert.equal(lamp.params.rotateH, 370);
    assert.equal(lamp.params.rotateV, -190);
    assert.equal(lamp.params.rotate, 725);
  });
});

test("a light's x, y, z are relative and zTo is absolute", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const lamp = createStageObjects(stage).Light([], {});
    lamp.zTo(-40);
    assert.equal(lamp.params.z, -40, "zTo sets the absolute height");
    lamp.z(50);
    assert.equal(lamp.params.z, 10, "z(50) is relative on top of -40");
    lamp.z(-99999);
    assert.equal(lamp.params.z, -1500, "clamping still applies to relative z");

    lamp.x(100).y(200);
    assert.equal(lamp.params.x, 100, "x(100) shifts the lamp right");
    assert.equal(lamp.params.y, 200, "y(200) shifts the lamp up");
    lamp.xTo(0);
    assert.equal(lamp.params.x, 0, "xTo(0) snaps x, y untouched");
    assert.equal(lamp.params.y, 200, "y stays after xTo");
  });
});

test("width goes from a point light to a bar, and stops at the frame", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const lamp = createStageObjects(stage).Light([], {});

    assert.equal(lamp.params.width, 0, "a light starts as a point");
    lamp.width(760);
    assert.equal(lamp.params.width, 760);
    lamp.width(-40);
    assert.equal(lamp.params.width, 0, "a negative width is a point light, not an error");
    lamp.width(9999);
    assert.equal(lamp.params.width, 4000);
    assert.throws(() => lamp.width("宽一点"), /宽度需要数字/);
  });
});

test("direction writes both angles at once", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const lamp = createStageObjects(stage).Light([], {});
    lamp.direction(35, 60);
    assert.equal(lamp.params.rotateH, 35);
    assert.equal(lamp.params.rotateV, 60);
    assert.throws(() => lamp.direction(35), /两个数字/);
  });
});

test("a colour that is not hex is reported, not painted white", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const lamp = createStageObjects(stage).Light([], {});
    assert.throws(() => lamp.hex("蓝色"), /十六进制/);
    lamp.hex("#ffd9a0");
    assert.equal(lamp.params.color, "FFD9A0");
    lamp.rgb(0, 128, 255);
    assert.equal(lamp.params.color, "0080FF");
  });
});

test("the ambient brightness dims the pictures and never the dialogue box", () => {
  inFakeDom(() => {
    const { stage, background, character, dialogue } = domStage();

    stage.setAmbient(0.4);
    assert.equal(background.style.filter, "brightness(0.4)");
    assert.equal(character.style.filter, "brightness(0.4)");
    assert.ok(!dialogue.style.filter, "the dialogue box is interface, not scene");
    assert.equal(stage.getAmbient(), 0.4);

    stage.setAmbient(1);
    assert.equal(background.style.filter, "", "1 is the untouched frame, not a filter");
    assert.equal(stage.getAmbient(), 1);

    stage.setAmbient(9);
    assert.equal(stage.getAmbient(), 2);
    assert.throws(() => stage.setAmbient("亮一点"), /0–2/);
  });
});

test("exclude names both lists, and unexclude takes it back", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const lamp = objects.Light([], { assignee: "lamp" });
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    lamp.enable();

    stage.exclude([lamp], [hero]);
    assert.deepEqual([...lamp.excluded], ["character:hero"]);

    stage.unexclude([lamp], [hero]);
    assert.deepEqual([...lamp.excluded], []);
  });
});

test("透光：角色默认挡光，背景、文字这些默认让光穿过去", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    objects.Background(["bg.png"], { assignee: "bg" });
    objects.Character(["hero.png"], { assignee: "hero" });
    objects.Text(["字"], { assignee: "word" });

    assert.equal(stage.translucentIsOn("character:hero"), false, "角色是一张挡在灯前面的纸");
    assert.equal(stage.translucentIsOn("background"), true, "背景画的是整个世界，挡光会把整盏灯挖没");
    assert.equal(stage.translucentIsOn("text:word"), true, "文字还不在灯层里，光本来就从它中间穿过去");
  });
});

test("translucent 让光穿过一个对象，灯层读到的剪影跟着变", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const lamp = objects.Light([], { assignee: "lamp" });
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    lamp.enable();
    hero.enable();

    const heroSilhouette = () => stage.lightObjects().find((item) => item.key === "character:hero");
    assert.equal(heroSilhouette().cast, true, "默认挡光");

    assert.equal(hero.translucent(), hero, "返回对象自身，可以接着写下一句");
    assert.equal(stage.translucentIsOn("character:hero"), true);
    assert.equal(heroSilhouette().cast, false, "透光之后不再按深度挡灯");

    hero.translucent(false);
    assert.equal(heroSilhouette().cast, true, "写回 false 就恢复挡光");
  });
});

test("轮廓光：默认 0，写多少记多少，超界按边界", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const lamp = objects.Light([], { assignee: "lamp" });
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    lamp.enable();
    hero.enable();

    const silhouette = () => stage.lightObjects().find((item) => item.key === "character:hero");
    assert.equal(stage.rimOf("character:hero"), 0, "默认不勾边");
    assert.equal(silhouette().rim, 0);

    assert.equal(hero.rim(0.8), hero, "返回对象自身，可以接着写下一句");
    assert.equal(stage.rimOf("character:hero"), 0.8);
    assert.equal(silhouette().rim, 0.8, "灯层读到的就是这个强度");

    hero.rim(3);
    assert.equal(stage.rimOf("character:hero"), 1, "超界夹到 1");
    hero.rim(-1);
    assert.equal(stage.rimOf("character:hero"), 0, "负数就是不勾边");
    assert.throws(() => hero.rim("亮一点"), /轮廓光强度需要 0–1 的数字/);
  });
});

test("抗锯齿：默认 0（关），aa 记整图强度，eaa 记边缘强度", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    const image = character.childNodes[0];
    const silhouette = () => stage.lightObjects().find((item) => item.key === "character:hero");

    assert.deepEqual(stage.antialiasOf("character:hero"), { smooth: 0, edges: 0 }, "默认都关");
    assert.equal(image.style.imageRendering, "pixelated", "关着就是硬边");
    assert.equal(silhouette().smooth, false, "灯层的剪影也是硬边");

    assert.equal(hero.aa(1), hero, "返回对象自身，可以接着写下一句");
    assert.deepEqual(stage.antialiasOf("character:hero"), { smooth: 1, edges: 0 });
    assert.equal(image.style.imageRendering, "auto", "开着就不再让浏览器取整");
    assert.equal(silhouette().smooth, true);

    hero.aa(9);
    assert.equal(stage.antialiasOf("character:hero").smooth, 2, "超界夹到 2");
    hero.aa(-1);
    assert.equal(stage.antialiasOf("character:hero").smooth, 0, "负数就是关");
    hero.aa();
    assert.equal(stage.antialiasOf("character:hero").smooth, 0, "省略按 0");

    hero.eaa(0.5);
    assert.deepEqual(stage.antialiasOf("character:hero"), { smooth: 0, edges: 0.5 });
    assert.equal(silhouette().smooth, true, "只有边缘开着也算开着");
    hero.aa(1);
    assert.deepEqual(
      stage.antialiasOf("character:hero"),
      { smooth: 1, edges: 0.5 },
      "两档各记各的",
    );
    assert.throws(() => hero.eaa("软一点"), /边缘抗锯齿强度需要 0–2 的数字/);
  });
});

test("抗锯齿只挂在角色上，并且换表情之后还留着", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    hero.eaa(1);

    // 换一张立绘：同一个人，强度还在 —— 新元素自己不带这个开关。
    objects.Character(["hero2.png"], { assignee: "hero" }).enable();
    assert.equal(character.childNodes[0].style.imageRendering, "auto", "重建之后重新写上");

    // 背景、文字没有这两档：抗锯齿是位图角色的取像素方式。
    assert.equal(objects.Background(["bg.png"], { assignee: "bg" }).aa, undefined);
    assert.equal(objects.Text(["hi"], { assignee: "title" }).eaa, undefined);
  });
});

test("抗锯齿的中文写法走同一个开关，记在槽位键上", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);
    const opened = await run(
      '小帕 = Character("hero.png")\n小帕.启用()\n小帕.抗锯齿(0.8)\n小帕.边缘抗锯齿(1.4)',
      { globals },
    );
    assert.equal(opened.error, undefined, opened.error?.message);
    assert.deepEqual(stage.antialiasOf("character:小帕"), { smooth: 0.8, edges: 1.4 });

    // 换一张表情还是同一个人，强度跟着槽位留着。
    const rebuilt = await run('小帕 = Character("hero2.png")\n小帕.启用()', { globals });
    assert.equal(rebuilt.error, undefined, rebuilt.error?.message);
    assert.deepEqual(stage.antialiasOf("character:小帕"), { smooth: 0.8, edges: 1.4 });
  });
});

test("布尔参数可以写 1 和 0，与 true 和 false 等价", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);

    const opened = await run("guideline(1)\nperspective(0)", { globals });
    assert.equal(opened.error, undefined, opened.error?.message);
    assert.equal(stage.guidelineIsOn(), true, "1 就是 true");
    assert.equal(stage.perspectiveIsOn(), false, "0 就是 false");

    await run("guideline(0)\nperspective(1)", { globals });
    assert.equal(stage.guidelineIsOn(), false);
    assert.equal(stage.perspectiveIsOn(), true);
  });
});

test("轮廓光记在槽位键上，中文写法与换表情都留得住", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);
    const opened = await run('小帕 = Character("hero.png")\n小帕.启用()\n小帕.轮廓光(0.6)', {
      globals,
    });
    assert.equal(opened.error, undefined, opened.error?.message);
    assert.equal(stage.rimOf("character:小帕"), 0.6, "中文写法走的是同一个开关");

    const rebuilt = await run('小帕 = Character("hero2.png")\n小帕.启用()', { globals });
    assert.equal(rebuilt.error, undefined, rebuilt.error?.message);
    assert.equal(stage.rimOf("character:小帕"), 0.6, "换一张表情还是同一个人");
  });
});

test("透光记在槽位键上，重建对象不会把它弄丢", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);
    const opened = await run('小帕 = Character("hero.png")\n小帕.启用()\n小帕.透光(true)', { globals });
    assert.equal(opened.error, undefined, opened.error?.message);
    assert.equal(stage.translucentIsOn("character:小帕"), true, "中文写法走的是同一个开关");

    // 换一张表情：同一个人，还是透光。
    const rebuilt = await run('小帕 = Character("hero2.png")\n小帕.启用()', { globals });
    assert.equal(rebuilt.error, undefined, rebuilt.error?.message);
    assert.equal(stage.translucentIsOn("character:小帕"), true);
  });
});

test("exclusion refuses a light that lights nothing, or no lights at all", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const lamp = objects.Light([], {});
    const hero = objects.Character(["hero.png"], { assignee: "hero" });

    assert.throws(() => stage.exclude([], [hero]), /至少需要一盏光源/);
    assert.throws(() => stage.exclude([lamp], []), /至少需要一个对象/);
    assert.throws(() => stage.exclude([hero], [hero]), /只能是光源/);
  });
});

test("the colon is read as the seam between lights and objects", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);
    const result = await run(
      [
        '灯 = Light("FFD9A0", 1.5, 200, 100)',
        '小帕 = Character("hero.png")',
        "灯.启用()",
        "舞台.排除(灯 : 小帕)",
      ].join("\n"),
      { globals },
    );

    assert.equal(result.error, undefined, result.error?.message);
    // 对象键跟着对象的舞台名走：没被赋给变量的角色用变量名（这里是「小帕」）。
    assert.deepEqual([...stage.lightsOn()[0].excluded], ["character:小帕"]);
  });
});

test("a two-list call without both lists is reported", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);

    const missing = await run('灯 = Light()\n小帕 = Character("hero.png")\n舞台.排除(灯, 小帕)', {
      globals,
    });
    assert.ok(missing.error);
    assert.match(missing.error.message, /冒号/);

    const backwards = await run('灯 = Light()\n小帕 = Character("hero.png")\n舞台.排除(小帕 : 灯)', {
      globals,
    });
    assert.ok(backwards.error);
    assert.match(backwards.error.message, /只能是光源/);
  });
});

test("the stage's own ambient call takes a number in 0–2", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);
    const result = await run("舞台.环境亮度(0.35)", { globals });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(stage.getAmbient(), 0.35);
  });
});

test("the old axis names are rejected rather than aliased", async () => {
  await inFakeDom(async () => {
    const { stage } = domStage();
    const globals = createStageGlobals(stage);

    const taken = await run("灯 = Light()\n灯.rotateH(120).rotateV(45)", { globals });
    assert.equal(taken.error, undefined, taken.error?.message);

    // 旧名字是彻底删掉的：既不认作方法，也不认作构造参数，也不做中文别名。
    for (const name of ["azimuth", "elevation", "rotateZV", "rotateZH", "垂直轴", "水平轴"]) {
      const called = await run(`灯 = Light()\n灯.${name}(30)`, { globals });
      assert.ok(called.error, `${name} must not be a method any more`);
      assert.match(called.error.message, new RegExp(name));

      const built = await run(`灯 = Light(${name} = 30)`, { globals });
      assert.ok(built.error, `${name} must not be a constructor parameter`);
      assert.match(built.error.message, new RegExp(name));
    }
  });
});

test("a lamp behind a character darkens the character itself", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    const objects = createStageObjects(stage);
    const lamp = objects.Light(["FFD9A0", 1], { assignee: "lamp" });
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.scale(0.5).move(-80, -100);

    // 灯在角色前面：正面照得到，不该压暗。
    lamp.spread(360).rotateH(90).zTo(-300).enable();
    hero.enable();
    assert.equal(
      character.childNodes[0].style.filter,
      "none",
      "照得到的角色不该有自己的影子",
    );

    // 灯退到身后：正面照不到了，角色自己的像素沉下去。
    lamp.zTo(500);
    const filter = character.childNodes[0].style.filter;
    assert.match(filter, /^brightness\(0?\.\d+\)$/, `背后有灯时角色该变暗，实际 ${filter}`);
  });
});

test("a lamp behind leaves a broken-down brightness that still respects the look", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    const objects = createStageObjects(stage);
    const lamp = objects.Light(["FFD9A0", 1], { assignee: "lamp" });
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    // 作者自己压过亮度：逆光的暗部要乘上去，而不是顶掉它。
    hero.scale(0.5).brightness(0.8);

    lamp.spread(360).rotateH(90).zTo(500).enable();
    hero.enable();
    const filter = character.childNodes[0].style.filter;
    const brightness = Number(/brightness\(([\d.]+)\)/.exec(filter)?.[1]);
    assert.ok(brightness > 0 && brightness < 0.8, `应当是 0.8 与逆光系数的乘积，实际 ${filter}`);
  });
});


