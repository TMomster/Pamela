// `ui/stage.js` 舞台对象颜色滤镜方法测试。
// Tests for the colour-filter methods on the stage objects in `ui/stage.js`.

import assert from "node:assert/strict";
import test from "node:test";

import { createStage, createStageGlobals, createStageObjects } from "../stage.js";
import { run } from "../pamela.js";

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
      node.log.push("layout");
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
      node.log.push(`removeAttribute:${name}`);
      if (name === "src") {
        node.src = "";
      }
    },
    // The auto-play countdown ring is an SVG built with attributes rather than
    // properties. A stand-in records them so a test can read back what was set.
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      node.log.push(`addEventListener:${type}`);
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
    // A synchronous body is done now; an async one keeps the fake DOM until it
    // settles, because the stage's image load reaches for `document` afterwards.
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

/** A stage built over a fake DOM, for the filter tests. */
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
  };
}

test("rgbTo paints an SVG filter onto the backdrop", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.rgbTo(255, 0, 0, 0);
    assert.equal(background.childNodes[0].style.filter, "url(#pamela-tint-1)");
  });
});

test("hex paints the same way a rgbTo does", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.hex("00FF00", 0);
    assert.equal(background.childNodes[0].style.filter, "url(#pamela-tint-1)");
  });
});

test("a tint set before enable is replayed once the picture is on the stage", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    // The image does not exist yet, so the filter cannot land on it here...
    bg.rgbTo(255, 0, 0, 0);
    // ...but `enable` rebuilds the picture and repaints the remembered tint.
    bg.enable();
    assert.equal(background.childNodes[0].style.filter, "url(#pamela-tint-1)");
  });
});

test("rgb adds to the offset already there and clamps each channel at 255", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.rgb(254, 0, 0, 0);
    assert.equal(bg.tint.r, 254);
    // 254 plus 10 clamps to 255, never 264; a further 10 leaves it unchanged.
    bg.rgb(10, 0, 0, 0);
    assert.equal(bg.tint.r, 255);
    bg.rgb(10, 0, 0, 0);
    assert.equal(bg.tint.r, 255);
  });
});

test("rgbTo sets the offset outright, overriding a previous rgb", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.rgb(200, 0, 0, 0);
    bg.rgbTo(50, 100, 150, 0);
    assert.deepEqual(bg.tint, { r: 50, g: 100, b: 150 });
    // An over-range channel is clamped rather than carried through.
    bg.rgbTo(300, -5, 255, 0);
    assert.deepEqual(bg.tint, { r: 255, g: 0, b: 255 });
  });
});

test("a zero tint clears the filter rather than leaving an identity one", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.rgbTo(255, 0, 0, 0);
    assert.equal(background.childNodes[0].style.filter, "url(#pamela-tint-1)");
    bg.rgbTo(0, 0, 0, 0);
    assert.equal(background.childNodes[0].style.filter, "none");
  });
});

test("a character's filter paints onto its own slot", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    const hero = createStageObjects(stage).Character(["hero.png"], {});
    hero.enable();
    hero.rgbTo(0, 0, 255, 0);
    // The character layer holds the plain image first, then its mesh node.
    assert.equal(character.childNodes[0].style.filter, "url(#pamela-tint-1)");
    // A deformed character keeps its colour because the mesh node is tinted too.
    assert.equal(character.childNodes[1].style.filter, "url(#pamela-tint-1)");
  });
});

test("the interpreter can drive the filter methods", () => {
  inFakeDom(async () => {
    const { stage, background } = domStage();
    const result = await run(
      [
        'bg = Background("bg.png")',
        "bg.enable()",
        'bg.hex("FF8000", 0)',
      ].join("\n"),
      {
        constructors: createStageObjects(stage),
        globals: createStageGlobals(stage),
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(background.childNodes[0].style.filter, "url(#pamela-tint-1)");
  });
});

// --- the look ---

test("blur paints a CSS filter onto the backdrop", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    // A fresh picture carries no filter: `none` is written rather than left
    // blank, so no stylesheet rule can leak in.
    assert.equal(background.childNodes[0].style.filter, "none");
    bg.blur(4, 0);
    assert.equal(background.childNodes[0].style.filter, "blur(4px)");
    // Zero is sharp, and a sharp picture carries no declaration.
    bg.blur(0, 0);
    assert.equal(background.childNodes[0].style.filter, "none");
  });
});

test("the four look filters stack rather than replacing each other", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.blur(2, 0);
    bg.saturate(0, 0);
    bg.contrast(1.5, 0);
    // Each call sets one slider; the others keep what they had.
    assert.equal(
      background.childNodes[0].style.filter,
      "blur(2px) contrast(1.5) saturate(0)",
    );
    assert.deepEqual(bg.look, { blur: 2, brightness: 1, contrast: 1.5, saturate: 0 });
  });
});

test("a look and a tint are written as one filter, so neither erases the other", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.rgbTo(255, 0, 0, 0);
    bg.blur(3, 0);
    // Both live in the same CSS property, and the later call must not take the
    // earlier one off — that was the bug a single `style.filter =` write caused.
    assert.equal(
      background.childNodes[0].style.filter,
      "url(#pamela-tint-1) blur(3px)",
    );
    // Clearing the tint keeps the look.
    bg.rgbTo(0, 0, 0, 0);
    assert.equal(background.childNodes[0].style.filter, "blur(3px)");
  });
});

test("a look set before enable is replayed once the picture is on the stage", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    // There is no picture to paint yet...
    bg.blur(5, 0);
    // ...but `enable` repaints the remembered look onto the fresh image.
    bg.enable();
    assert.equal(background.childNodes[0].style.filter, "blur(5px)");
  });
});

test("a look clamps rather than refusing, and rejects a non-number", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    bg.blur(-2, 0);
    assert.equal(bg.look.blur, 0);
    bg.saturate(9, 0);
    assert.equal(bg.look.saturate, 4);
    assert.throws(() => bg.blur("soft"), /模糊|滤镜|blur/);
  });
});

test("a look fades over time instead of snapping in", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const bg = createStageObjects(stage).Background(["bg.png"], {});
    bg.enable();
    // A timed blur writes the full four-function list (so it can interpolate)
    // and arms a `filter` transition for the duration the call asked for.
    bg.blur(8, 2000);
    assert.equal(
      background.childNodes[0].style.filter,
      "blur(8px) brightness(1) contrast(1) saturate(1)",
    );
    assert.match(background.childNodes[0].style.transition, /filter 2000ms linear/);
    // An instant change afterwards is not dragged out by the earlier transition.
    bg.blur(0, 0);
    assert.equal(background.childNodes[0].style.filter, "none");
    assert.ok(!/filter \d+ms/.test(background.childNodes[0].style.transition));
  });
});

test("the interpreter can drive the look methods", () => {
  inFakeDom(async () => {
    const { stage, character } = domStage();
    const result = await run(
      [
        'hero = Character("hero.png")',
        "hero.enable()",
        "hero.blur(2, 0)",
        "hero.saturate(0.2, 0)",
      ].join("\n"),
      {
        constructors: createStageObjects(stage),
        globals: createStageGlobals(stage),
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(character.childNodes[0].style.filter, "blur(2px) saturate(0.2)");
  });
});
