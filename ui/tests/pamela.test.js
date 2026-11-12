// Pamela 剧本语言与舞台对象测试。
// Tests for the Pamela script language and the stage objects.

import assert from "node:assert/strict";
import test from "node:test";

import { createChoices } from "../choice.js";
import { createDialogue } from "../dialog.js";
import { interpret, nodeKey, parse, run, stageNameFor, tokenize } from "../pamela.js";
import {
  createStage,
  createStageGlobals,
  createStageObjects,
  STAGE_HEIGHT,
  STAGE_WIDTH,
} from "../stage.js";

/** Types of a token list, which is what most tokeniser assertions care about. */
function types(source) {
  const scanned = tokenize(source);
  assert.equal(scanned.error, undefined, "expected a clean scan");
  return scanned.tokens.map((token) => token.type);
}

/** A dialogue box over the fake DOM, with a frame the test can click. */
function dialogueBox() {
  const element = fakeElement();
  const node = fakeElement();
  const errors = [];
  const box = createDialogue({
    element,
    node,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    onError: (message) => errors.push(message),
  });
  // `node.childNodes` is the stand-in bar, the old stamped PNG, the name plate,
  // the line and the live plate canvas, in that order.
  const [fallback, stamp, speaker, text] = node.childNodes;
  return { box, element, node, errors, fallback, stamp, speaker, text };
}

/** A stage stand-in that records what each of its layers was asked to show. */
function fakeStage() {
  const shown = [];
  const characters = [];
  const moves = [];
  const turns = [];
  const boxes = [];
  const lines = [];
  const styles = [];
  const fades = [];
  const order = [];
  const crossFades = [];
  const clicks = [];
  const waits = [];
  /**
   * What each slot already has on the stage.
   *
   * The real stage keeps this beside its entries — the frame the picture is
   * drawn in, and the name it is attributed to — so that a rebuilt variable carries
   * on from there instead of starting over. The stand-in keeps the same facts
   * in a map of its own, and the two calls below are the whole contract.
   */
  const slotState = new Map();
  const stateOf = (slot) =>
    slotState.get(slot) ?? {
      name: "undefinedName",
      x: 0,
      y: 0,
      rotation: 0,
      size: 1,
      tint: null,
      opacity: 1,
    };
  return {
    shown,
    characters,
    moves,
    turns,
    boxes,
    lines,
    styles,
    fades,
    order,
    crossFades,
    clicks,
    waits,
    setBackground: (path) => shown.push(path),
    setCharacter: (slot, path) => characters.push({ slot, path }),
    moveBackground: (x, y, z, time) => moves.push({ target: "background", x, y, time }),
    moveCharacter: (slot, x, y, z, time) => {
      moves.push({ target: slot, x, y, time });
      slotState.set(slot, { ...stateOf(slot), x, y });
    },
    transformBackground: (rotation, scale, time) =>
      turns.push({ target: "background", rotation, scale, time }),
    transformCharacter: (slot, rotation, scale, time) => {
      turns.push({ target: slot, rotation, scale, time });
      slotState.set(slot, { ...stateOf(slot), rotation, size: scale });
    },
    /** A point of the box sent to a place, rather than moved from one. */
    transformCharacterPoint: (slot, handle, x, y, time) =>
      boxes.push({ slot, mode: "to", handle, x, y, time }),
    /** A point of the box moved by a distance. */
    moveCharacterPoint: (slot, handle, dx, dy, time) =>
      boxes.push({ slot, mode: "by", handle, dx, dy, time }),
    /**
     * Records a line and leaves it up until the test clicks, which is what the
     * real box does: the promise is the wait, so it has to be opened by hand
     * rather than resolved on its own.
     */
    sayLine: (name, text) => {
      const record = { name, text, spoken: false };
      lines.push(record);
      return new Promise((resolve) => {
        record.settle = () => {
          record.spoken = true;
          resolve();
        };
      });
    },
    /** `stage.click` / `stage.auto` 的等待，同样由测试手动放行。 */
    clickWait: (time) => {
      const record = { time, done: false };
      clicks.push(record);
      return new Promise((resolve) => {
        record.settle = () => {
          record.done = true;
          resolve();
        };
      });
    },
    autoWait: (time) => {
      const record = { time, done: false };
      waits.push(record);
      return new Promise((resolve) => {
        record.settle = () => {
          record.done = true;
          resolve();
        };
      });
    },
    setDialogueStyle: (config) => styles.push(config),
    /** Records nothing; a filter is painted by the real stage, not here. */
    applyTint: () => undefined,
    /** The look is painted by the real stage too; only the call matters here. */
    applyLook: () => undefined,
    /** Fades are recorded so a script's call can be held to having happened. */
    setBackgroundAlpha: (value, time) => fades.push({ target: "background", value, time }),
    setCharacterAlpha: (slot, value, time) => {
      fades.push({ target: slot, value, time });
      // The slot remembers it, the way the real stage does: a rebuilt variable
      // inherits the opacity along with the frame.
      slotState.set(slot, { ...stateOf(slot), opacity: value });
    },
    raiseCharacter: (slot) => order.push(`front ${slot}`),
    lowerCharacter: (slot) => order.push(`back ${slot}`),
    crossFadeBackground: (path, time) => crossFades.push({ path, time }),
    /** What a slot already has on the stage, for a rebuilt variable to inherit. */
    characterState: stateOf,
    /** Preserves the name a slot uses across that rebuild. */
    rememberCharacterName: (slot, name) => {
      slotState.set(slot, { ...stateOf(slot), name });
    },
  };
}

/**
 * A stand-in for an object whose calls take time, with the end of each call
 * left to the test to open.
 *
 * `begin("name")` records the start and reports a promise to the interpreter —
 * which is how a statement that takes time becomes something a script can wait
 * for — then stays pending until `gates.get("name")()` is called. Nothing here
 * is timed, so what has started and what has not is never decided by how fast
 * the machine running the tests happens to be.
 */
function fakeActor() {
  const events = [];
  const gates = new Map();
  const constructors = {
    Actor: (args, context) => {
      // Every call answers the actor, as the stage objects do, so a test can
      // write a chain: `a.begin("one").begin("two")`.
      const actor = {
        begin: (name) => {
          events.push(`start ${name}`);
          let open;
          const running = new Promise((resolve) => {
            open = () => {
              events.push(`end ${name}`);
              resolve();
            };
          });
          gates.set(name, open);
          context.pending?.push(running);
          return actor;
        },
        /** Records something that is over at once, to order against. */
        note: (label) => {
          events.push(label);
          return actor;
        },
      };
      return actor;
    },
  };
  return { events, gates, constructors };
}

/** Lets the interpreter get as far as its next wait before the test looks. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A stage built over a fake DOM, for the layer tests. */
function domStage() {
  const surface = fakeElement();
  const element = fakeElement();
  const stage = createStage({
    element,
    surface,
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
  });
  return {
    stage,
    // The element is the frame a click (or Space / Enter) is heard on.
    element,
    surface,
    background: surface.childNodes[0],
    character: surface.childNodes[1],
    dialogue: surface.childNodes[2],
  };
}

/**
 * A stand-in element, with just enough of the DOM for `createStage`.
 *
 * The styles written to it and the layout read of it are recorded in `log`, in
 * the order they happen. A node cannot animate, so the order is the only thing
 * a test can hold the stage to: a timed change has to read layout between
 * writing the transition and writing the value it runs to, or the browser is
 * handed both in one style pass and jumps.
 */
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
    /** The stage waits for a bitmap; a stand-in has one as soon as it is asked. */
    decode() {
      return Promise.resolve();
    },
    // The properties the dialogue box writes to. Plain fields, so a test can
    // read back what a line left on them.
    hidden: false,
    alt: "",
    draggable: false,
    src: "",
    textContent: "",
    // Sound fields and calls: the audio layer builds an <audio> element, so
    // the stand-in answers the same way a real one does.
    volume: 1,
    loop: false,
    currentTime: 0,
    paused: true,
    play() {
      node.paused = false;
      node.log.push("play");
      return Promise.resolve();
    },
    pause() {
      node.paused = true;
      node.log.push("pause");
    },
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
    /** Fires what was registered for `type`, as a click on the frame would. */
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    // A stand-in has no layout, so text always fits and the box never shrinks
    // it. `undefined > undefined` would be false too; being explicit here is
    // what keeps `fitText`'s guard from being read as a no-op by accident.
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
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

/**
 * Runs an async `body` with the fake document kept in place until it settles.
 *
 * `inFakeDom` puts the real document back as soon as the body returns, which is
 * right for work done in one tick and wrong for a fade: the picture that is
 * dropped when a dissolve ends is created after an await.
 */
async function inFakeDomAsync(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return await body();
  } finally {
    globalThis.document = previous;
  }
}

/**
 * Runs an async `body` with a fake document, collecting what it creates.
 *
 * `inFakeDom` restores the document as soon as the body returns, which is
 * enough for work done in one tick. The audio layer builds its element while a
 * script is running, after an await, so the stub has to outlive that.
 */
async function inFakeDomCollecting(body) {
  const created = [];
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag = "div") => {
      const node = fakeElement();
      node.tagName = tag;
      created.push(node);
      return node;
    },
  };
  try {
    const value = await body();
    return { value, created };
  } finally {
    globalThis.document = previous;
  }
}


test("the tokeniser separates statements on significant newlines", () => {
  assert.deepEqual(types("a = 1\nb = 2\n"), [
    "ident",
    "punct",
    "number",
    "newline",
    "ident",
    "punct",
    "number",
    "newline",
    "eof",
  ]);
  assert.deepEqual(types("a = 1; b = 2"), [
    "ident",
    "punct",
    "number",
    "punct",
    "ident",
    "punct",
    "number",
    "eof",
  ]);
});

test("the tokeniser skips whitespace and comments to end of line", () => {
  assert.deepEqual(types("  # note\n\t a"), ["newline", "ident", "eof"]);
  // `//` is the other way a note is written, and it ends the same way.
  assert.deepEqual(types("  // note\n\t a"), ["newline", "ident", "eof"]);
});

test("a block comment covers what it spans, lines inside it included", () => {
  assert.deepEqual(types("/* one\ntwo */\na"), ["newline", "ident", "eof"]);

  const scanned = tokenize("a = 1\n/* covers\nthis */\nb = 2");
  assert.equal(scanned.error, undefined);
  // The second statement is on line 4, which is the line it is really on: the
  // lines the comment covers are lines the source has.
  assert.equal(parse(scanned.tokens).program.statements[1].line, 4);
});

test("a block comment that is never closed is reported where it opened", () => {
  const scanned = tokenize("a = 1\n/* nothing closes this");
  assert.ok(scanned.error, "expected an error");
  assert.match(scanned.error.message, /块注释/);
  assert.equal(scanned.error.line, 2);
  assert.equal(scanned.error.column, 1);
});


test("string escapes are resolved, unknown ones left as written", () => {
  const scanned = tokenize('"a\\nb\\q\\\\c"');
  assert.equal(scanned.tokens[0].value, "a\nbq\\c");
});

test("an unterminated string is reported with its position", () => {
  const scanned = tokenize('  "abc');
  assert.ok(scanned.error, "expected an error");
  assert.equal(scanned.error.line, 1);
  assert.equal(scanned.error.column, 3);
});

test("a minus is an operator, so a negative number is unary minus", async () => {
  const scanned = tokenize("x = -120.5");
  assert.equal(scanned.error, undefined);
  // ident, `=`, `-`, the number, eof — the sign is not part of the literal.
  assert.equal(scanned.tokens[2].type, "punct");
  assert.equal(scanned.tokens[2].value, "-");
  assert.equal(scanned.tokens[3].type, "number");
  assert.equal(scanned.tokens[3].value, 120.5);

  const result = await run("x = -120.5");
  assert.equal(result.error, undefined);
  assert.equal(result.value, -120.5);
});

test("an operator of two characters is one token, not two", () => {
  const scanned = tokenize("a == b != c <= d && e || f");
  assert.equal(scanned.error, undefined);
  const operators = scanned.tokens
    .filter((token) => token.type === "punct")
    .map((token) => token.value);
  assert.deepEqual(operators, ["==", "!=", "<=", "&&", "||"]);
});

test("equality is never read as an assignment", async () => {
  const parsed = parse(tokenize("x = 1 == 1").tokens);
  assert.equal(parsed.error, undefined);
  const assignment = parsed.program.statements[0];
  assert.equal(assignment.type, "assign");
  assert.equal(assignment.value.type, "binary");
  assert.equal(assignment.value.op, "==");

  assert.equal((await run("x = 1 == 1")).value, true);
});

test("an unrecognised character is reported rather than ignored", () => {
  const scanned = tokenize("a @ b");
  assert.ok(scanned.error, "expected an error");
  assert.match(scanned.error.message, /@/);
});

test("an assignment parses into an AST with the value on the right", () => {
  const parsed = parse(tokenize("x = 1").tokens);
  assert.deepEqual(parsed.program.statements, [
    { type: "assign", name: "x", value: { type: "literal", value: 1, line: 1 }, line: 1 },
  ]);
});

test("postfix chains nest member and call nodes", () => {
  const parsed = parse(tokenize("bg.enable()").tokens);
  assert.deepEqual(parsed.program.statements[0].value, {
    type: "call",
    callee: {
      type: "member",
      object: { type: "identifier", name: "bg", line: 1 },
      name: "enable",
      line: 1,
    },
    args: [],
    line: 1,
  });
});

test("statements without a separator are rejected", () => {
  const parsed = parse(tokenize("a = 1 b = 2").tokens);
  assert.ok(parsed.error, "expected an error");
  assert.match(parsed.error.message, /换行|分号/);
});

test("a cue block parses into a statement of its own", () => {
  const parsed = parse(tokenize("cue {\n  a.b(1)\n}").tokens);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.program.statements, [
    {
      type: "cue",
      wait: false,
      waitMs: null,
      time: null,
      line: 1,
      statements: [
        {
          type: "expression",
          line: 2,
          value: {
            type: "call",
            line: 2,
            args: [{ type: "literal", value: 1, line: 2 }],
            callee: {
              type: "member",
              line: 2,
              object: { type: "identifier", name: "a", line: 2 },
              name: "b",
            },
          },
        },
      ],
    },
  ]);
});

test("a trailing wait is recorded on the block", () => {
  const parsed = parse(tokenize("cue {\n  a.b()\n} wait").tokens);
  assert.equal(parsed.error, undefined);
  // One statement, not two: `wait` belongs to the block rather than standing
  // on its own.
  assert.equal(parsed.program.statements.length, 1);
  assert.equal(parsed.program.statements[0].wait, true);
});

test("a positive time argument is parsed as an expression", () => {
  const parsed = parse(tokenize("cue(3000) {\n  a.b()\n}").tokens);
  assert.equal(parsed.error, undefined);
  const cue = parsed.program.statements[0];
  assert.equal(cue.type, "cue");
  assert.equal(cue.time?.type, "literal");
  assert.equal(cue.time?.value, 3000);
  assert.equal(cue.wait, false);
});

test("a negative time argument (auto-wait) parses", () => {
  const parsed = parse(tokenize("cue(-1) {\n  a.b()\n}").tokens);
  assert.equal(parsed.error, undefined);
  const time = parsed.program.statements[0].time;
  // The tokenizer keeps `-` as its own token, so a negative literal is a unary
  // minus over a positive one; the interpreter folds it back to -1 at run time.
  assert.equal(time.type, "unary");
  assert.equal(time.op, "-");
  assert.equal(time.operand.value, 1);
});

test("cue without a time argument has no time node", () => {
  const parsed = parse(tokenize("cue {\n  a.b()\n}").tokens);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.program.statements[0].time, null);
});

test("a cue may take one statement instead of a block", () => {
  const parsed = parse(tokenize("cue(3000) ch.scale(0.5).move(0, -300)").tokens);
  assert.equal(parsed.error, undefined);
  // One statement, not two, and it is what the cue starts.
  assert.equal(parsed.program.statements.length, 1);
  const cue = parsed.program.statements[0];
  assert.equal(cue.type, "cue");
  assert.equal(cue.statements.length, 1);
  assert.equal(cue.statements[0].type, "expression");
  assert.equal(cue.time.value, 3000);
  assert.equal(cue.wait, false);
});

test("a cue time may be written without its parentheses", () => {
  const parsed = parse(tokenize("cue 3000 a.b()\ncue -1 a.b()").tokens);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.program.statements[0].time.value, 3000);
  const negative = parsed.program.statements[1].time;
  assert.equal(negative.type, "unary");
  assert.equal(negative.operand.value, 1);
});

test("a one-statement cue may still end on wait", () => {
  const parsed = parse(tokenize("cue a.b() wait").tokens);
  assert.equal(parsed.error, undefined);
  // `wait` belongs to the cue, so it is one statement rather than two.
  assert.equal(parsed.program.statements.length, 1);
  assert.equal(parsed.program.statements[0].wait, true);
});

test("a cue's wait may name its own time, with or without brackets", () => {
  for (const closing of ["} wait 5000", "} wait(5000)"]) {
    const parsed = parse(tokenize(`cue {\n  a.b()\n${closing}`).tokens);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.program.statements.length, 1, "wait belongs to the block");
    const cue = parsed.program.statements[0];
    assert.equal(cue.wait, true);
    assert.equal(cue.waitMs?.value, 5000);
  }
  // The one-statement form carries it the same way.
  const single = parse(tokenize("cue a.b() wait 800").tokens).program.statements[0];
  assert.equal(single.wait, true);
  assert.equal(single.waitMs.value, 800);
});

test("wait may be written with its time in brackets", () => {
  const parsed = parse(tokenize("wait(500)").tokens);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.program.statements[0], { type: "wait", ms: 500, line: 1 });
  // 括号里只能有数字：暂停是一段长度，不是算出来的值。
  const bad = parse(tokenize("wait(x)").tokens);
  assert.ok(bad.error, "expected an error");
  assert.match(bad.error.message, /毫秒数/);
});

test("a malformed wait on a cue is reported rather than half-parsed", () => {
  for (const source of ["cue {\n  a.b()\n} wait(x)", "cue a.b() wait(500"]) {
    const parsed = parse(tokenize(source).tokens);
    assert.ok(parsed.error, `expected an error for ${source}`);
    assert.equal(parsed.program, undefined);
  }
});




test("cue(N) proceeds after N ms even if the group is still running", async () => {
  // Drive the cue's timer by hand. A real 50/70 ms race is flaky under a loaded
  // machine (the full suite runs many files at once), so `runtime.sleep` hands
  // the timeout to the test instead of the clock.
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue(50) {\n  a.begin("long")\n}\na.begin("after")', {
    constructors,
    sleep,
  });
  await tick();
  assert.deepEqual(events, ["start long"], "the group has started, the rest has not");
  assert.equal(gates.has("after"), false);

  // Release the 50 ms timeout: the script moves on though "long" is unfinished.
  const cueTimer = timers.find((timer) => timer.ms === 50);
  assert.ok(cueTimer, "the cue armed its 50 ms timeout");
  cueTimer.resolve();
  for (let i = 0; i < 50 && !events.includes("start after"); i++) {
    await tick();
  }
  assert.deepEqual(events, ["start long", "start after"], "the timeout let the script proceed");
  assert.equal(gates.has("after"), true);

  // The unfinished action keeps running and finishes on its own, in parallel.
  gates.get("long")();
  gates.get("after")();
  await running;
  assert.equal(running.error, undefined);
  assert.deepEqual(events, ["start long", "start after", "end long", "end after"]);
});

test("cue(-1) waits for every action in the group, like wait", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run(
    'a = Actor()\ncue(-1) {\n  a.begin("one")\n  a.begin("two")\n}\na.begin("three")',
    { constructors },
  );
  await tick();
  assert.deepEqual(events, ["start one", "start two"]);
  gates.get("one")();
  await tick();
  assert.deepEqual(events, ["start one", "start two", "end one"]);
  assert.equal(gates.has("three"), false, "not waited out yet");

  gates.get("two")();
  await tick();
  assert.deepEqual(events, ["start one", "start two", "end one", "end two", "start three"]);

  gates.get("three")();
  await running;
  assert.equal(running.error, undefined);
});

test("cue(0) starts the group and moves on without waiting", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue(0) {\n  a.begin("one")\n}\na.begin("two")', {
    constructors,
  });
  await tick();
  assert.deepEqual(events, ["start one", "start two"], "0 means no wait, like no argument");
  gates.get("two")();
  await running;
  assert.equal(running.error, undefined);
  assert.deepEqual(events, ["start one", "start two", "end two"]);
});

test("a one-statement cue still hands its time to the following lines", async () => {
  // The same timer handling as a block: `cue(50) a.begin(…)` starts the call and
  // the script moves on once the 50 ms are up, even though the call has not
  // finished.
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue(50) a.begin("long")\na.note("after")', {
    constructors,
    sleep,
  });
  await tick();
  assert.deepEqual(events, ["start long"]);

  timers.find((timer) => timer.ms === 50).resolve();
  for (let i = 0; i < 50 && !events.includes("after"); i++) {
    await tick();
  }
  assert.deepEqual(events, ["start long", "after"]);

  gates.get("long")();
  await running;
  assert.equal(running.error, undefined);
});

test("the links of a chain wait for each other", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\na.begin("one").begin("two")', { constructors });

  await tick();
  assert.deepEqual(events, ["start one"], "the second link waits for the first");

  gates.get("one")();
  await tick();
  assert.deepEqual(events, ["start one", "end one", "start two"]);

  gates.get("two")();
  const result = await running;
  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["start one", "end one", "start two", "end two"]);
});

test("a cue makes the links of one chain start together", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue a.begin("one").begin("two")', { constructors });

  await tick();
  // 关键约束：cue 让整条链同时开始，所以两次调用都在进行中。
  assert.deepEqual(events, ["start one", "start two"], "both links begin at once");

  gates.get("one")();
  gates.get("two")();
  const result = await running;
  assert.equal(result.error, undefined);
});

test("a cue's time is a length: the group is released when it is up", async () => {
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue(50) {\n  a.begin("long")\n}\na.begin("after")', {
    constructors,
    sleep,
  });

  await tick();
  assert.deepEqual(events, ["start long"]);
  assert.deepEqual(timers.map((timer) => timer.ms), [50], "the cue armed its own time");

  timers[0].resolve();
  for (let i = 0; i < 50 && !events.includes("start after"); i++) {
    await tick();
  }
  assert.deepEqual(events, ["start long", "start after"], "the time let the script go on");

  gates.get("long")();
  gates.get("after")();
  await running;
  assert.equal(running.error, undefined);
});

test("a cue waits its time even after the group has finished", async () => {
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue(50) {\n  a.begin("short")\n}\na.begin("after")', {
    constructors,
    sleep,
  });

  await tick();
  gates.get("short")();
  await tick();
  assert.deepEqual(events, ["start short", "end short"]);
  // The block is over, but the time it was given is not: the cue is a length,
  // not a limit on how long the group may take.
  assert.equal(gates.has("after"), false, "still holding for the cue's time");

  timers[0].resolve();
  for (let i = 0; i < 50 && !events.includes("start after"); i++) {
    await tick();
  }
  assert.deepEqual(events, ["start short", "end short", "start after"]);

  gates.get("after")();
  await running;
  assert.equal(running.error, undefined);
});

test("a trailing wait's time outranks the time on the keyword", async () => {
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue(50) {\n  a.begin("one")\n} wait 70\na.begin("after")', {
    constructors,
    sleep,
  });

  await tick();
  assert.deepEqual(events, ["start one"]);
  assert.deepEqual(timers.map((timer) => timer.ms), [70], "the wait wins");

  timers[0].resolve();
  for (let i = 0; i < 50 && !events.includes("start after"); i++) {
    await tick();
  }
  assert.deepEqual(events, ["start one", "start after"]);

  gates.get("one")();
  gates.get("after")();
  await running;
  assert.equal(running.error, undefined);
});

test("a bare wait still holds for the whole block, whatever time the keyword names", async () => {
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue(50) {\n  a.begin("one")\n} wait\na.begin("after")', {
    constructors,
    sleep,
  });

  await tick();
  assert.deepEqual(events, ["start one"]);
  assert.deepEqual(timers, [], "a bare wait arms no timer");

  gates.get("one")();
  await tick();
  assert.deepEqual(events, ["start one", "end one", "start after"]);

  gates.get("after")();
  await running;
  assert.equal(running.error, undefined);
});

test("a preview does not pay a cue's time", async () => {
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ ms, resolve }));
  const { constructors } = fakeActor();
  const result = await run('a = Actor()\ncue(50) {\n  a.begin("one")\n}\na.note("after")', {
    constructors,
    sleep,
    preview: true,
  });

  assert.equal(result.error, undefined);
  // A preview travels to a frame rather than performing to an audience.
  assert.deepEqual(timers, []);
});

test("cue without a block, or a block never closed, is rejected", () => {
  const bare = parse(tokenize("cue\n").tokens);
  assert.ok(bare.error, "expected an error");
  assert.match(bare.error.message, /语句块/);

  const open = parse(tokenize("cue {\n  a.b()\n").tokens);
  assert.ok(open.error, "expected an error");
  assert.match(open.error.message, /\}/);
});

test("a function declaration parses into a statement of its own", () => {
  const parsed = parse(tokenize("func title(hero, speed) {\n  hero.move(speed, 0)\n}").tokens);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.program.statements.length, 1);

  const [declaration] = parsed.program.statements;
  assert.equal(declaration.type, "func");
  assert.equal(declaration.name, "title");
  assert.equal(declaration.line, 1);
  assert.deepEqual(declaration.params, ["hero", "speed"]);
  assert.deepEqual(
    declaration.statements.map((statement) => statement.type),
    ["expression"],
  );
});

test("a function that takes nothing is declared with empty brackets", () => {
  const parsed = parse(tokenize("func title() {\n  bg.enable()\n}").tokens);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.program.statements[0].params, []);
});

test("what a function declaration can get wrong is reported", () => {
  const cases = [
    ["func\n", /函数名/],
    ["func () {\n}", /函数名/],
    // A keyword here would bind a name no line could ever call, since the
    // statement parser reads the keyword first.
    ["func cue() {\n}", /关键字/],
    ["func title(1) {\n}", /参数/],
    ["func title(a, a) {\n}", /重复/],
    ["func title(a {\n}", /逗号/],
    ["func title() hero.move()", /语句块/],
    ["func title() {\n  hero.move()\n", /\}/],
  ];

  for (const [source, expected] of cases) {
    const parsed = parse(tokenize(source).tokens);
    assert.ok(parsed.error, `expected ${JSON.stringify(source)} to fail`);
    assert.match(parsed.error.message, expected, source);
  }
});

// --- operators ---

test("multiplication binds tighter than addition", async () => {
  assert.equal((await run("x = 2 + 3 * 4")).value, 14);
  assert.equal((await run("x = 2 * 3 + 4")).value, 10);
});

test("operators of the same level run left to right", async () => {
  assert.equal((await run("x = 10 - 2 - 3")).value, 5);
  assert.equal((await run("x = 100 / 10 / 2")).value, 5);
});

test("parentheses override precedence", async () => {
  assert.equal((await run("x = (2 + 3) * 4")).value, 20);
});

test("a minus needs no space on either side", async () => {
  assert.equal((await run("x = 5-2")).value, 3);
  assert.equal((await run("x = 5 -2")).value, 3);
  assert.equal((await run("x = -1-1")).value, -2);
});

test("a unary minus binds to a whole call", async () => {
  assert.equal((await run("x = -3 + 1")).value, -2);
  assert.equal((await run("x = 2 * -3")).value, -6);
  assert.equal((await run('func two() {\n  return 2\n}\nx = -two()')).value, -2);
});

test("text joins with plus", async () => {
  assert.equal((await run('x = "a" + "b"')).value, "ab");
});

test("comparisons answer a boolean", async () => {
  assert.equal((await run("x = 2 > 1")).value, true);
  assert.equal((await run("x = 2 == 2")).value, true);
  assert.equal((await run('x = "a" == "b"')).value, false);
  assert.equal((await run("x = null == null")).value, true);
  assert.equal((await run("x = 3 >= 3 && 1 < 2")).value, true);
});

test("a logical operator leaves out the side that cannot change the answer", async () => {
  assert.equal((await run("x = false && 1 / 0 > 1")).value, false);
  assert.equal((await run("x = true || 1 / 0 > 1")).value, true);
  assert.equal((await run("x = !false")).value, true);
});

test("an operator on the wrong kind of value says what it got", async () => {
  const cases = [
    ['x = "a" + 1', /\+ 只能加两个数字或连接两段文本，收到文本和数字/],
    ['x = 1 - "a"', /- 需要两个数字，收到数字和文本/],
    ["x = 1 / 0", /不能除以 0/],
    ["x = 5 % 0", /不能除以 0/],
    ['x = 1 == "1"', /数字和文本不能比较/],
    ["x = 1 && true", /运算符 && 需要布尔值，左边是数字/],
    ["x = !1", /! 需要布尔值，收到数字/],
    ['x = -"a"', /负号需要数字，收到文本/],
    ["x = true < false", /比较 < 需要两个数字或两段文本，收到布尔和布尔/],
  ];
  for (const [source, expected] of cases) {
    const result = await run(source);
    assert.ok(result.error, "expected " + JSON.stringify(source) + " to fail");
    assert.match(result.error.message, expected, source);
  }
});

test("two objects are not compared", async () => {
  const stage = fakeStage();
  const result = await run('a = Background("one.png")\nb = Background("two.png")\nx = a == b', {
    constructors: createStageObjects(stage),
  });
  assert.ok(result.error);
  assert.match(result.error.message, /不能比较对象/);
});

test("a keyword is not a name", async () => {
  const cases = [
    ["if = 1", /不能把关键字 if 用作变量名/],
    ["true = 1", /不能把关键字 true 用作变量名/],
    ["x = if", /if 不能当作值使用/],
    ["func else() {\n}", /不能把关键字 else 用作函数名/],
    ["func f(return) {\n}", /不能把关键字 return 用作参数名/],
  ];
  for (const [source, expected] of cases) {
    const result = await run(source);
    assert.ok(result.error, "expected " + JSON.stringify(source) + " to fail");
    assert.match(result.error.message, expected, source);
  }
});

// --- control flow ---

test("if takes its branch on a boolean", async () => {
  assert.equal((await run("x = 0\nif true {\n  x = 1\n}\nx")).value, 1);
  assert.equal((await run("x = 0\nif false {\n  x = 1\n}\nx")).value, 0);
});

test("else can start on the line after the closing brace", async () => {
  const result = await run("x = 0\nif false {\n  x = 1\n}\nelse {\n  x = 2\n}\nx");
  assert.equal(result.error, undefined);
  assert.equal(result.value, 2);
});

test("a block with no else leaves the next statement where it sits", async () => {
  const result = await run("x = 0\nif false {\n  x = 1\n}\ny = 5\nx");
  assert.equal(result.error, undefined, "the statement after the block has to parse");
  assert.equal(result.value, 0);
});

test("else if chains are tried in order", async () => {
  const head = "if n == 1 {\n  grade = \"一\"\n}\nelse if n == 2 {\n  grade = \"二\"\n}\nelse {\n  grade = \"其他\"\n}\ngrade";
  assert.equal((await run("n = 2\n" + head)).value, "二");
  assert.equal((await run("n = 1\n" + head)).value, "一");
  assert.equal((await run("n = 9\n" + head)).value, "其他");
});

test("a condition that is not a boolean is an error", async () => {
  const cases = [
    ["if 1 {\n}", /if 的条件需要布尔值，得到数字/],
    ['if "x" {\n}', /if 的条件需要布尔值，得到文本/],
    ["if null {\n}", /if 的条件需要布尔值，得到空值/],
  ];
  for (const [source, expected] of cases) {
    const result = await run(source);
    assert.ok(result.error, "expected " + JSON.stringify(source) + " to fail");
    assert.match(result.error.message, expected, source);
  }
});

test("a branch assigns the same variable the rest of the script reads", async () => {
  assert.equal((await run("x = 0\nif true {\n  x = 5\n}\nx + 1")).value, 6);
});

test("for walks a list, a dictionary's keys, and a string", async () => {
  assert.equal(
    (await run("total = 0\nfor n in [1, 2, 3] {\n  total = total + n\n}\ntotal")).value,
    6,
  );
  assert.equal(
    (await run('out = ""\nfor c in "abc" {\n  out = out + c + "-"}\nout')).value,
    "a-b-c-",
  );
  assert.equal(
    (await run('seen = ""\nfor k in {"x": 1, "y": 2} {\n  seen = seen + k\n}\nseen')).value,
    "xy",
  );
});

test("for binds the loop variable per turn and allows break/continue", async () => {
  assert.equal(
    (await run("seen = 0\nfor n in [1, 2, 3, 4] {\n  if n == 3 { continue }\n  seen = seen + 1\n}\nseen")).value,
    3,
  );
  assert.equal(
    (await run("sum = 0\nfor n in [1, 2, 3, 4, 5] {\n  if n == 4 { break }\n  sum = sum + n\n}\nsum")).value,
    6,
  );
});

test("for over something that is not a collection is an error", async () => {
  const result = await run("for n in 5 {\n}");
  assert.ok(result.error, "expected a non-collection to fail");
  assert.match(result.error.message, /for 需要/);
});

test("switch picks the first matching case, then default", async () => {
  const body =
    "switch n {\n  case 1 {\n    r = \"一\"\n  }\n  case 2 {\n    r = \"二\"\n  }\n  default {\n    r = \"其他\"\n  }\n}\nr";
  assert.equal((await run("n = 1\n" + body)).value, "一");
  assert.equal((await run("n = 2\n" + body)).value, "二");
  assert.equal((await run("n = 9\n" + body)).value, "其他");
});

test("switch without a matching case and no default does nothing", async () => {
  const result = await run('switch 5 {\n  case 1 {\n    r = "x"\n  }\n}\nnull');
  assert.equal(result.error, undefined);
  assert.equal(result.value, null);
});

test("nullish coalescing falls back only on null", async () => {
  assert.equal((await run("x = null\ny = x ?? 7\ny")).value, 7);
  assert.equal((await run("x = 0\ny = x ?? 7\ny")).value, 0, "0 is not null");
  assert.equal((await run('x = "a"\ny = x ?? "b"\ny')).value, "a");
});

test("and / or / not word forms behave like && / || / !", async () => {
  assert.equal((await run("x = true and false\nx")).value, false);
  assert.equal((await run("x = true or false\nx")).value, true);
  assert.equal((await run("x = not true\nx")).value, false);
  assert.equal((await run("x = (1 < 2) and (3 > 4)\nx")).value, false);
  assert.notEqual((await run("x = 1 and 2")).error, undefined, "and needs booleans");
});

test("a function answers the value it returns", async () => {
  assert.equal((await run("func double(n) {\n  return n * 2\n}\ndouble(21)")).value, 42);
});

test("a function without return answers the empty value", async () => {
  assert.equal((await run("func quiet() {\n  x = 1\n}\nquiet()")).value, null);
});

test("return stops the body where it stands", async () => {
  const result = await run("func f() {\n  x = 1\n  return\n  x = 2\n}\nf()\nx");
  assert.equal(result.error, undefined);
  assert.equal(result.value, 1);
});

test("return outside a function is reported", async () => {
  const result = await run("return 1");
  assert.ok(result.error);
  assert.match(result.error.message, /return 只能写在函数里/);
});

test("a function waits for what it starts, then answers the returned value", async () => {
  const { events, gates, constructors } = fakeActor();
  let settled = false;
  const running = run('a = Actor()\nfunc f() {\n  a.begin("picture")\n  return 1\n}\ny = f()', {
    constructors,
  }).then((result) => {
    settled = true;
    return result;
  });

  await tick();
  assert.deepEqual(events, ["start picture"]);
  assert.equal(settled, false, "the function is still waiting on the picture");

  gates.get("picture")();
  const result = await running;
  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["start picture", "end picture"]);
  assert.equal(result.value, 1, "the caller reads the returned value");
});

test("a branch that starts something waits for it like any other statement", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\nif true {\n  a.begin("move")\n}\na.note("after")', {
    constructors,
  });

  await tick();
  assert.deepEqual(events, ["start move"], "the statement after the if has not begun");
  gates.get("move")();
  await running;
  assert.deepEqual(events, ["start move", "end move", "after"]);
});

test("an if inside a cue still belongs to the block's wait", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run(
    'a = Actor()\ncue {\n  if true {\n    a.begin("fade")\n  }\n} wait\na.note("after")',
    { constructors },
  );

  await tick();
  assert.deepEqual(events, ["start fade"]);
  gates.get("fade")();
  const result = await running;
  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["start fade", "end fade", "after"]);
});

// --- choice ---

test("a question lists one button per answer, numbered", async () => {
  const box = inFakeDom(() => {
    const node = fakeElement();
    const layer = createChoices({ node });
    const answer = layer.ask(["去学校", "回家"]);
    return { node, layer, list: node.childNodes[0], answer };
  });

  assert.equal(box.node.hidden, false);
  assert.deepEqual(
    box.list.childNodes.map((button) => button.textContent),
    ["1. 去学校", "2. 回家"],
  );
  assert.equal(box.layer.isWaiting(), true);

  box.list.childNodes[0].dispatch("click");
  assert.equal(await box.answer, 0);
});

test("clicking an answer answers with its index and takes the question down", async () => {
  const box = inFakeDom(() => {
    const node = fakeElement();
    const layer = createChoices({ node });
    const answer = layer.ask(["甲", "乙", "丙"]);
    return { node, layer, list: node.childNodes[0], answer };
  });

  box.list.childNodes[1].dispatch("click");
  assert.equal(await box.answer, 1);
  assert.equal(box.node.hidden, true);
  assert.deepEqual(box.list.childNodes, []);
  assert.equal(box.layer.isWaiting(), false);
});

test("clearing the layer answers -1, so a dropped run can stop", async () => {
  const box = inFakeDom(() => {
    const node = fakeElement();
    const layer = createChoices({ node });
    const answer = layer.ask(["甲"]);
    return { node, layer, answer };
  });

  box.layer.clear();
  assert.equal(await box.answer, -1);
  assert.equal(box.node.hidden, true);
  assert.equal(box.layer.isWaiting(), false);
});

test("a second question while one is up is refused", () => {
  const layer = inFakeDom(() => {
    const node = fakeElement();
    const one = createChoices({ node });
    one.ask(["甲"]);
    assert.throws(() => one.ask(["乙"]), /不能同时出现两个选择支/);
    return one;
  });

  layer.clear();
});

test("a choice parses into one block per label", () => {
  const parsed = parse(tokenize('choice {\n  "甲" {\n    a.note("x")\n  }\n  "乙" {\n  }\n}').tokens);
  assert.equal(parsed.error, undefined);
  const node = parsed.program.statements[0];
  assert.equal(node.type, "choice");
  // A label is an expression now, so a literal is one of them: the text is what
  // it evaluates to rather than what the parser read.
  assert.deepEqual(
    node.options.map((option) => option.label.type),
    ["literal", "literal"],
  );
  assert.deepEqual(
    node.options.map((option) => option.label.value),
    ["甲", "乙"],
  );
  assert.equal(node.options[0].statements.length, 1);
  assert.equal(node.options[1].statements.length, 0, "an empty block is allowed");
});

test("what a choice can get wrong is reported", () => {
  const cases = [
    ["choice\n", /选项块/],
    ['choice {\n  "甲"\n}', /语句块/],
    ["choice {\n}", /至少需要一个选项/],
    ['choice {\n  "甲" {\n', /\}/],
  ];

  for (const [source, expected] of cases) {
    const parsed = parse(tokenize(source).tokens);
    assert.ok(parsed.error, "expected " + JSON.stringify(source) + " to fail");
    assert.match(parsed.error.message, expected, source);
  }
});

test("a label that is not text is refused where the question is put up", async () => {
  // The parser takes any expression; the interpreter is what knows a label has
  // to be something a player can read.
  const result = await run("choice {\n  1 + 1 {\n  }\n}", { choose: () => Promise.resolve(0) });
  assert.ok(result.error);
  assert.match(result.error.message, /选择支的标签需要文本，得到数字/);
});

test("a label may be computed, so a choice can say what it costs", async () => {
  const asked = [];
  const { events, constructors } = fakeActor();
  const result = await run(
    [
      "a = Actor()",
      "gold = 250",
      'choice {',
      '  "付 100 元（剩 " + str(gold - 100) + "）" {',
      '    a.note("paid")',
      "  }",
      '  "算了" {',
      '    a.note("no")',
      "  }",
      "}",
    ].join("\n"),
    {
      constructors,
      choose: (labels) => {
        asked.push(labels);
        return Promise.resolve(0);
      },
    },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(asked, [["付 100 元（剩 150）", "算了"]]);
  assert.deepEqual(events, ["paid"]);
});

test("a choice plays the block of the answer that was picked", async () => {
  const { events, constructors } = fakeActor();
  const asked = [];
  const result = await run(
    'a = Actor()\nchoice {\n  "左" {\n    a.note("left")\n  }\n  "右" {\n    a.note("right")\n  }\n}',
    {
      constructors,
      choose: (labels) => {
        asked.push(labels);
        return Promise.resolve(1);
      },
    },
  );

  assert.deepEqual(asked, [["左", "右"]], "the labels reach the stage as written");
  assert.deepEqual(events, ["right"], "only the picked block runs");
  assert.equal(result.error, undefined);
});

test("a choice holds the script until one answer is picked", async () => {
  const { events, constructors } = fakeActor();
  let answer;
  const running = run(
    'a = Actor()\na.note("before")\nchoice {\n  "走" {\n    a.note("picked")\n  }\n}\na.note("after")',
    {
      constructors,
      choose: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    },
  );

  await tick();
  assert.deepEqual(events, ["before"], "nothing after the question has run");

  answer(0);
  const result = await running;
  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["before", "picked", "after"]);
});

test("a picked block that starts something is waited for like an if branch", async () => {
  const { events, gates, constructors } = fakeActor();
  let answer;
  const running = run('a = Actor()\nchoice {\n  "动" {\n    a.begin("move")\n  }\n}\na.note("after")', {
    constructors,
    choose: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });

  await tick();
  answer(0);
  await tick();
  assert.deepEqual(events, ["start move"], "the branch is still playing");

  gates.get("move")();
  await running;
  assert.deepEqual(events, ["start move", "end move", "after"]);
});

test("the run ends when the question is answered with -1", async () => {
  const { events, constructors } = fakeActor();
  const result = await run('a = Actor()\nchoice {\n  "甲" {\n    a.note("picked")\n  }\n}\na.note("after")', {
    constructors,
    choose: () => Promise.resolve(-1),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.stopped, true);
  assert.deepEqual(events, [], "nothing in the question and nothing after it");
});

test("a choice with no stage to show it is reported", async () => {
  const result = await run('choice {\n  "甲" {\n  }\n}');
  assert.ok(result.error);
  assert.match(result.error.message, /不支持选择支/);
});

// --- string interpolation ---

// `RB` builds a `}` without putting the literal brace in the test source, so the
// interpolation markers below read clearly.
test("a string may interpolate an expression with {…}", async () => {
  const RB = String.fromCharCode(125); // '}'
  const result = await run('name = "帕梅拉"\n"你好 {name' + RB + '"');
  assert.equal(result.error, undefined);
  assert.equal(result.value, "你好 帕梅拉");
});

test("interpolation converts the value with str, not implicitly", async () => {
  const RB = String.fromCharCode(125); // '}'
  const result = await run('score = 7\n"得分 {score' + RB + '"');
  assert.equal(result.error, undefined);
  assert.equal(result.value, "得分 7");
});

test("several interpolations concatenate in order", async () => {
  const RB = String.fromCharCode(125); // '}'
  const result = await run('a = 1\nb = 2\n"{a' + RB + '{b' + RB + '"');
  assert.equal(result.error, undefined);
  assert.equal(result.value, "12");
});

test("a backslash before a brace keeps it literal", async () => {
  const result = await run('"a \\{ b"');
  assert.equal(result.error, undefined);
  assert.equal(result.value, "a { b");
});

test("interpolation is lexed as its own token", () => {
  const RB = String.fromCharCode(125); // '}'
  const scanned = tokenize('"hi {name' + RB + '"');
  assert.equal(scanned.error, undefined);
  assert.deepEqual(
    scanned.tokens.map((token) => token.type),
    ["string", "interp", "eof"],
  );
});

test("a string with no braces is still a plain literal", async () => {
  const result = await run('"plain"');
  assert.equal(result.error, undefined);
  assert.equal(result.value, "plain");
});

// --- lists, dictionaries, indexing, slicing ---

test("a list literal indexes by position", async () => {
  const result = await run("x = [10, 20, 30]\nx[1]");
  assert.equal(result.error, undefined);
  assert.equal(result.value, 20);
});

test("a negative index counts from the end", async () => {
  const result = await run("x = [10, 20, 30]\nx[-1]");
  assert.equal(result.error, undefined);
  assert.equal(result.value, 30);
});

test("a list slices with a colon, bounds optional", async () => {
  const result = await run("x = [1, 2, 3, 4]\nlen(x[1:3])");
  assert.equal(result.error, undefined);
  assert.equal(result.value, 2);
});

test("a dictionary stores and reads by key", async () => {
  const result = await run('d = {"hp": 3, "mp": 7}\nd["hp"]');
  assert.equal(result.error, undefined);
  assert.equal(result.value, 3);
});

test("a chained index walks into nested lists", async () => {
  const result = await run("x = [[1, 2], [3, 4]]\nx[1][0]");
  assert.equal(result.error, undefined);
  assert.equal(result.value, 3);
});

test("out-of-range indexing is reported", async () => {
  const result = await run("x = [1, 2, 3]\nx[9]");
  assert.ok(result.error);
  assert.match(result.error.message, /越界|下标/);
});

test("len works on lists, dicts and strings", async () => {
  assert.equal((await run("len([1, 2, 3])")).value, 3);
  assert.equal((await run('len({"a": 1, "b": 2})')).value, 2);
  assert.equal((await run('len("abc")')).value, 3);
});

test("lists compare by content with ==", async () => {
  const result = await run("a = [1, 2]\nb = [1, 2]\na == b");
  assert.equal(result.error, undefined);
  assert.equal(result.value, true);
});

test("an interpolation can read a list length", async () => {
  const result = await run("xs = [1, 2, 3]\n\"数量 {len(xs)}\"");
  assert.equal(result.error, undefined);
  assert.equal(result.value, "数量 3");
});

test("the answer has to be an index the question has", async () => {
  const result = await run('choice {\n  "甲" {\n  }\n}', { choose: () => Promise.resolve(3) });
  assert.ok(result.error);
  assert.match(result.error.message, /不存在的序号：3/);
});

// --- values turned into text ---

test("str turns a number into the text a line can show", async () => {
  const said = [];
  const constructors = { say: (args) => said.push(args[0]) };
  const result = await run('say("得分：" + str(7))', { constructors });

  assert.equal(result.error, undefined);
  assert.deepEqual(said, ["得分：7"]);
});

test("str reads every kind the language has", async () => {
  const said = [];
  const constructors = { say: (args) => said.push(args[0]) };
  await run(
    [
      'say(str(7))',
      'say(str(7.5))',
      'say(str("already text"))',
      'say(str(true))',
      'say(str(false))',
      'say(str(null))',
    ].join("\n"),
    { constructors },
  );

  assert.deepEqual(said, ["7", "7.5", "already text", "true", "false", "null"]);
});

test("str keeps as many decimals as it is asked for", async () => {
  const said = [];
  const constructors = { say: (args) => said.push(args[0]) };
  await run("say(str(7 / 3, 2))\nsay(str(2, 3))", { constructors });

  assert.deepEqual(said, ["2.33", "2.000"]);
});

test("str refuses what it cannot show, and says what it got", async () => {
  const cases = [
    ["x = str()", /str 需要一个值/],
    ['x = str("a", 2)', /str 的小数位数只能用在数字上，收到文本/],
    ["x = str(1, 1.5)", /小数位数需要 0–10 的整数/],
    ["x = str(1, 11)", /小数位数需要 0–10 的整数/],
  ];
  for (const [source, expected] of cases) {
    const result = await run(source);
    assert.ok(result.error, "expected " + source + " to fail");
    assert.match(result.error.message, expected, source);
  }
});

test("an object has no text form, so str says so rather than printing [object Object]", async () => {
  const result = await run('x = str(Background("bg.png"))', {
    constructors: createStageObjects(fakeStage()),
  });
  assert.ok(result.error);
  assert.match(result.error.message, /str 需要数字、文本、布尔或空值，收到对象/);
});

test("the error that wanted a conversion points at str", async () => {
  const result = await run('x = "得分：" + 7');
  assert.ok(result.error);
  assert.match(result.error.message, /用 str\(数字\)/);
});

// --- compound assignment ---

test("a compound assignment reads as the operator applied to the old value", async () => {
  assert.equal((await run("n = 10\nn += 5")).value, 15);
  assert.equal((await run("n = 10\nn -= 5")).value, 5);
  assert.equal((await run("n = 10\nn *= 5")).value, 50);
  assert.equal((await run("n = 10\nn /= 5")).value, 2);
  assert.equal((await run("n = 10\nn %= 3")).value, 1);
  // Text joins the same way `+` does.
  assert.equal((await run('s = "ab"\ns += "cd"')).value, "abcd");
});

test("a compound assignment follows the operator's own type rules", async () => {
  const result = await run('n = 1\nn += "a"');
  assert.ok(result.error);
  assert.match(result.error.message, /\+ 只能加两个数字或连接两段文本，收到数字和文本/);
});

test("a compound assignment needs the name to be bound already", async () => {
  const result = await run("n += 1");
  assert.ok(result.error);
  assert.match(result.error.message, /未定义的变量：n/);
});

test("+= is one token, so it is not read as an assignment of +1", () => {
  const scanned = tokenize("n += 1");
  assert.equal(scanned.error, undefined);
  assert.deepEqual(
    scanned.tokens.filter((token) => token.type === "punct").map((token) => token.value),
    ["+="],
  );

  const parsed = parse(scanned.tokens);
  const statement = parsed.program.statements[0];
  assert.equal(statement.type, "assign");
  assert.equal(statement.name, "n");
  assert.equal(statement.op, "+");
});

// --- loops ---

test("a while runs its body until the condition turns false", async () => {
  const result = await run("i = 0\nwhile i < 3 {\n  i += 1\n}");
  assert.equal(result.error, undefined);
  assert.equal((await run("i = 0\nwhile i < 3 {\n  i += 1\n}\nx = i")).value, 3);
});

test("a while condition has to be a boolean, like an if", async () => {
  const result = await run("while 1 {\n}");
  assert.ok(result.error);
  assert.match(result.error.message, /while 的条件需要布尔值，得到数字/);
});

test("break leaves the loop it sits in, and continue starts the next turn", async () => {
  const result = await run(
    [
      "i = 0",
      "s = 0",
      "while i < 10 {",
      "  i += 1",
      "  if i == 2 { continue }",
      "  if i == 5 { break }",
      "  s += i",
      "}",
      "x = s",
    ].join("\n"),
  );
  assert.equal(result.error, undefined);
  // 1 + 3 + 4: 2 was skipped, 5 broke the loop before adding.
  assert.equal(result.value, 8);
});

test("break inside a branch still leaves the loop around the branch", async () => {
  const result = await run(
    "i = 0\nwhile true {\n  i += 1\n  if i == 2 {\n    break\n  }\n}\nx = i",
  );
  assert.equal(result.error, undefined);
  assert.equal(result.value, 2);
});

test("a break in a function body belongs to that body's loops, not the caller's", async () => {
  // The function is called from inside a loop, but its own `break` has no loop
  // of its own to leave — so it is reported rather than breaking the caller's.
  const result = await run("func f() {\n  break\n}\ni = 0\nwhile i < 1 {\n  i += 1\n  f()\n}");
  assert.ok(result.error);
  assert.match(result.error.message, /break 只能写在循环里/);
});

test("break and continue outside a loop are reported", async () => {
  for (const source of ["break", "continue", "if true {\n  break\n}"]) {
    const result = await run(source);
    assert.ok(result.error, "expected " + JSON.stringify(source) + " to fail");
    assert.match(result.error.message, /只能写在循环里/, source);
  }
});

test("a loop that never ends is reported instead of hanging", async () => {
  // The body is empty, so no statement inside it is ever performed: the count
  // has to happen per turn round the loop, or this never returns.
  const result = await run("while true {\n}");
  assert.ok(result.error);
  assert.match(result.error.message, /执行的语句太多（超过 100000 条），可能是死循环/);
});

test("return from inside a loop leaves the function, not the loop", async () => {
  const result = await run(
    [
      "func find() {",
      "  i = 0",
      "  while true {",
      "    i += 1",
      "    if i == 3 { return i }",
      "  }",
      "}",
      "x = find()",
    ].join("\n"),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.value, 3);
});

// --- a pause on its own ---

test("wait on its own pauses for the milliseconds it was given", async () => {
  const started = Date.now();
  const result = await run("wait 30\nx = 1");
  const elapsed = Date.now() - started;

  assert.equal(result.error, undefined);
  assert.ok(elapsed >= 25, `expected a pause, took ${elapsed}ms`);
});

test("wait 0 does not pause at all", async () => {
  const result = await run("wait 0\nx = 1");
  assert.equal(result.error, undefined);
  assert.equal(result.value, 1);
});

test("a wait inside a cue is one of the things the block waits for", async () => {
  const { events, gates, constructors } = fakeActor();
  const started = Date.now();
  const running = run(
    'a = Actor()\ncue {\n  wait 30\n  a.begin("after pause")\n} wait\na.note("done")',
    { constructors },
  );

  // `begin` reports a promise the test opens by hand, as it does everywhere
  // else; the block's `wait` is waiting on both that and the pause.
  const opening = (async () => {
    while (!gates.has("after pause")) {
      await tick();
    }
    gates.get("after pause")();
  })();
  const result = await running;
  await opening;

  assert.equal(result.error, undefined);
  // Inside a `cue` the statements start together, so the line after the pause
  // begins at once — the pause is what the block's `wait` waits out.
  assert.deepEqual(events, ["start after pause", "end after pause", "done"]);
  assert.ok(Date.now() - started >= 25, "the block waited for the pause");
});

test("a wait with nothing after it says how it is written", async () => {
  const result = await run("wait\nx = 1");
  assert.ok(result.error);
  assert.match(result.error.message, /要么跟在语句块的 \} 后面，要么写成 wait 毫秒数/);
});

// --- text comparison ---

test("text compares by code point, so a dictionary order works", async () => {
  assert.equal((await run('x = "abc" < "abd"')).value, true);
  assert.equal((await run('x = "abd" < "abc"')).value, false);
  assert.equal((await run('x = "abc" <= "abc"')).value, true);
  assert.equal((await run('x = "b" > "a"')).value, true);
  // The shorter prefix comes first, which is what makes a name sort readable.
  assert.equal((await run('x = "ab" < "abc"')).value, true);
});

test("comparing a number with text is reported rather than guessed at", async () => {
  const result = await run('x = 1 < "2"');
  assert.ok(result.error);
  assert.match(result.error.message, /比较 < 需要两个数字或两段文本，收到数字和文本/);
});

// --- include ---

/** A project of scripts, as the host would answer a readScene call. */
function sceneFiles(files) {
  const asked = [];
  return {
    asked,
    readScene: (path) => {
      asked.push(path);
      return path in files ? Promise.resolve(files[path]) : Promise.reject(new Error("文件不在"));
    },
  };
}

test("include plays another file where the statement stands, sharing names", async () => {
  const { events, constructors } = fakeActor();
  const { asked, readScene } = sceneFiles({
    "second.pamela": 'a.note("from second")\nx = 2',
  });

  const result = await run(
    'a = Actor()\na.note("before")\ninclude "second.pamela"\na.note("after")\nx',
    { constructors, readScene, source: "scripts/main.pamela" },
  );

  assert.equal(result.error, undefined);
  // The path arrives exactly as written: deciding what it means is the host's
  // job, not the language's.
  assert.deepEqual(asked, ["second.pamela"]);
  assert.deepEqual(events, ["before", "from second", "after"]);
  assert.equal(result.value, 2, "a name set in the included file stays set");
});

test("a function declared in an included file can be called after it", async () => {
  const { readScene } = sceneFiles({ "lib.pamela": "func helper() {\n  return 7\n}" });
  const result = await run('include "lib.pamela"\nhelper()', { readScene });
  assert.equal(result.error, undefined);
  assert.equal(result.value, 7);
});

test("a scene included twice in one run is read and parsed once", async () => {
  const { events, constructors } = fakeActor();
  const { asked, readScene } = sceneFiles({ "beat.pamela": 'a.note("beat")' });

  const result = await run(
    'a = Actor()\ni = 0\nwhile i < 3 {\n  i += 1\n  include "beat.pamela"\n}',
    { constructors, readScene },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["beat", "beat", "beat"], "the scene still plays on every pass");
  assert.deepEqual(asked, ["beat.pamela"], "but the file is only read once");
});

test("the number-key listener is attached only while a question is up", async () => {
  const previous = globalThis.document;
  const listeners = new Set();
  globalThis.document = {
    createElement: () => fakeElement(),
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler),
  };
  try {
    const node = fakeElement();
    const layer = createChoices({ node });
    assert.equal(listeners.size, 0, "no listener before anything is asked");

    const answer = layer.ask(["甲", "乙"]);
    assert.equal(listeners.size, 1, "one listener while the question is up");

    const [handler] = [...listeners];
    handler({ key: "2", preventDefault() {} });
    assert.equal(await answer, 1, "a digit picks the row it names");
    assert.equal(listeners.size, 0, "the listener goes away with the question");
  } finally {
    globalThis.document = previous;
  }
});

test("an include inside a branch plays only when the branch is taken", async () => {
  const { events, constructors } = fakeActor();
  const { asked, readScene } = sceneFiles({ "school.pamela": 'a.note("school")' });

  const source =
    'a = Actor()\nchoice {\n  "去学校" {\n    include "school.pamela"\n  }\n  "回家" {\n    a.note("home")\n  }\n}';
  const result = await run(source, {
    constructors,
    readScene,
    choose: () => Promise.resolve(1),
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["home"]);
  assert.deepEqual(asked, [], "the other file is never read");
});

test("an error inside an included file names that file", async () => {
  const { readScene } = sceneFiles({ "bad.pamela": "y = nope" });
  const result = await run('include "bad.pamela"', { readScene, source: "scripts/main.pamela" });

  assert.ok(result.error);
  assert.equal(result.error.file, "bad.pamela");
  assert.equal(result.error.line, 1);
  assert.match(result.error.message, /nope/);
});

test("a syntax error in an included file names that file too", async () => {
  const { readScene } = sceneFiles({ "broken.pamela": "func" });
  const result = await run('include "broken.pamela"', { readScene });
  assert.ok(result.error);
  assert.equal(result.error.file, "broken.pamela");
});

test("an included file that cannot be read is reported with its path", async () => {
  const { readScene } = sceneFiles({});
  const result = await run('include "missing.pamela"', { readScene });
  assert.ok(result.error);
  assert.match(result.error.message, /读不到脚本 missing\.pamela/);
});

test("two files that include each other are reported as a cycle", async () => {
  const { readScene } = sceneFiles({
    "a.pamela": 'include "b.pamela"',
    "b.pamela": 'include "a.pamela"',
  });
  const result = await run('include "a.pamela"', { readScene });
  assert.ok(result.error);
  assert.match(result.error.message, /互相包含：a\.pamela → b\.pamela → a\.pamela/);
});

test("a return in an included file is not a return from the caller", async () => {
  const { readScene } = sceneFiles({ "ret.pamela": "return 1" });
  const result = await run('func f() {\n  include "ret.pamela"\n}\nf()', { readScene });
  assert.ok(result.error);
  assert.match(result.error.message, /return 只能写在函数里/);
});

test("include without a project to read is reported, not skipped", async () => {
  const result = await run('include "second.pamela"');
  assert.ok(result.error);
  assert.match(result.error.message, /不能读取其他脚本/);
});

test("what include can get wrong in the script itself is reported", () => {
  const cases = [
    ["include\n", /文本路径/],
    ["include 3\n", /文本路径/],
    ['include ""\n', /不能是空的/],
  ];
  for (const [source, expected] of cases) {
    const parsed = parse(tokenize(source).tokens);
    assert.ok(parsed.error, "expected " + JSON.stringify(source) + " to fail");
    assert.match(parsed.error.message, expected, source);
  }
});

// --- audio ---

/** Runs a script against a sound stage inside a fake document, collecting nodes. */
async function playOnStage(source, options = {}) {
  const asked = [];
  const errors = [];
  const { value, created } = await inFakeDomCollecting(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolveAudio: (path) => {
        asked.push(path);
        return options.fail
          ? Promise.reject(new Error("打不开"))
          : Promise.resolve("data:audio/mpeg;base64,YWJj");
      },
      onError: (message) => errors.push(message),
    });
    // `stageGlobals` runs the script the way the app does: the stage owns the
    // constructors, so no separate factory table is handed to the interpreter.
    const runtime = options.stageGlobals
      ? { globals: createStageGlobals(stage) }
      : { constructors: createStageObjects(stage) };
    const result = await run(source, runtime);
    await tick();
    return { stage, result };
  });
  return {
    stage: value.stage,
    asked,
    errors,
    result: value.result,
    sounds: created.filter((node) => node.tagName === "audio"),
  };
}

test("a sound is built by a method of the stage too", async () => {
  const { asked, sounds, result } = await playOnStage(
    'music = stage.Audio("bgm.mp3")\nmusic.play()',
    { stageGlobals: true },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(asked, ["bgm.mp3"]);
  assert.equal(sounds.length, 1);
});

test("a sound plays through an audio element resolved from its name", async () => {
  const { asked, sounds, result } = await playOnStage(
    'music = Audio("bgm.mp3")\nmusic.loop()\nmusic.play()',
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(asked, ["bgm.mp3"], "the name reaches the host as written");
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0].src, "data:audio/mpeg;base64,YWJj");
  assert.equal(sounds[0].loop, true, "loop makes it a background track");
  assert.equal(sounds[0].paused, false, "play started it");
});

test("rebuilding the same variable stops the sound it was playing", async () => {
  const { sounds } = await playOnStage(
    'music = Audio("a.mp3")\nmusic.play()\nmusic = Audio("b.mp3")',
  );

  assert.equal(sounds.length, 2, "the second sound got an element of its own");
  assert.equal(sounds[0].paused, true, "the replaced sound was stopped");
});

test("a sound never holds the script back", async () => {
  let release;

  const { value } = await inFakeDomCollecting(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      // A source that is still loading when the script has moved on.
      resolveAudio: () => new Promise((resolve) => { release = resolve; }),
    });
    const result = await run('music = Audio("a.mp3")\nmusic.play()\nx = 2', {
      constructors: createStageObjects(stage),
    });
    return result;
  });

  assert.equal(value.value, 2, "the line after play() ran while the sound loaded");
  release("data:audio/mpeg;base64,YWJj");
});

test("volume clamps to the 0–1 range", async () => {
  const { sounds } = await playOnStage('music = Audio("a.mp3")\nmusic.volume(2)');
  assert.equal(sounds[0].volume, 1);

  const { sounds: quieter } = await playOnStage('music = Audio("a.mp3")\nmusic.volume(-3)');
  assert.equal(quieter[0].volume, 0);
});

test("stop pauses and rewinds the sound", async () => {
  const { sounds } = await playOnStage('music = Audio("a.mp3")\nmusic.play()\nmusic.stop()');
  assert.equal(sounds[0].paused, true);
  assert.equal(sounds[0].currentTime, 0);
});

test("clearing the stage stops every sound", async () => {
  const { stage, sounds } = await playOnStage('music = Audio("a.mp3")\nmusic.play()');
  assert.equal(sounds[0].paused, false);

  stage.clear();
  assert.equal(sounds[0].paused, true, "a cleared stage leaves nothing playing");
});

test("a sound that cannot be loaded is reported in the status bar", async () => {
  const { errors } = await playOnStage('music = Audio("nope.mp3")\nmusic.play()', { fail: true });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /打不开/);
});

test("what a sound can get wrong is reported", async () => {
  await inFakeDomCollecting(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    });
    for (const source of ["Audio()", 'Audio("")', "Audio(1)"]) {
      const result = await run(source, { constructors: createStageObjects(stage) });
      assert.ok(result.error, "expected " + JSON.stringify(source) + " to fail");
      assert.match(result.error.message, /Audio 需要音频文件名/);
    }
  });
});

// --- node positions and replays ---

test("the run reports each node with the path that leads to it", async () => {
  const nodes = [];
  const { constructors } = fakeActor();
  await run('a = Actor()\na.note("one")\nif true {\n  a.note("two")\n}', {
    constructors,
    source: "scripts/main.pamela",
    onNode: (node) => nodes.push({ file: node.file, path: node.path, canSave: node.canSave }),
  });

  assert.deepEqual(
    nodes.map((node) => node.path),
    [[0], [1], [2], [2, "then", 0]],
  );
  assert.equal(nodes[0].file, "scripts/main.pamela");
  assert.equal(nodes[3].canSave, true);
});

test("a node inside a call or a cue block is not a place to save", async () => {
  const nodes = [];
  const { constructors } = fakeActor();
  await run(
    'a = Actor()\nfunc f() {\n  a.note("in f")\n}\nf()\ncue {\n  a.note("in cue")\n}',
    {
      constructors,
      onNode: (node) => nodes.push({ path: node.path, canSave: node.canSave }),
    },
  );

  const body = nodes.find((node) => node.path[0] === "call");
  assert.ok(body, "a function body reports its own nodes");
  assert.equal(body.canSave, false, "a call is not a position the script stands at");

  const inCue = nodes.find((node) => node.path.includes("cue"));
  assert.ok(inCue, "a cue block reports its own nodes");
  assert.equal(inCue.canSave, false, "a block that starts together is not a position");
});

test("a replay travels silently and turns live at the saved node", async () => {
  const { events, constructors } = fakeActor();
  const nodes = [];
  let liveAt = null;

  const result = await run('a = Actor()\na.note("one")\na.note("two")\na.note("three")', {
    constructors,
    source: "scripts/main.pamela",
    replay: { target: nodeKey("scripts/main.pamela", [2]), choices: [] },
    onNode: (node) => nodes.push(node.path),
    onLive: (node) => {
      liveAt = node.path;
    },
  });

  // The statements before the node are performed again — that is how variables
  // and the picture is restored — but only the live ones are reported.
  assert.deepEqual(events, ["one", "two", "three"]);
  assert.deepEqual(nodes, [[2], [3]]);
  assert.deepEqual(liveAt, [2]);
  assert.equal(result.replayMissed, false);
});

test("a run that never reaches its saved node says so", async () => {
  const result = await run("a = 1", {
    source: "scripts/main.pamela",
    replay: { target: nodeKey("scripts/main.pamela", [9]), choices: [] },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.replayMissed, true);
});

test("a replay follows the answers the save recorded", async () => {
  const asked = [];
  const source = 'choice {\n  "甲" {\n    x = 1\n  }\n  "乙" {\n    x = 2\n  }\n}\nx';

  const result = await run(source, {
    source: "scripts/main.pamela",
    replay: {
      target: nodeKey("scripts/main.pamela", [1]),
      choices: [{ key: nodeKey("scripts/main.pamela", [0]), picked: 1 }],
    },
    choose: () => {
      asked.push("asked");
      return Promise.resolve(0);
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value, 2, "the recorded branch ran");
  assert.deepEqual(asked, [], "no question was put up during the replay");
});

test("a replay whose recorded answer does not fit is refused", async () => {
  const result = await run('choice {\n  "甲" {\n  }\n}', {
    source: "scripts/main.pamela",
    replay: { target: nodeKey("scripts/main.pamela", [1]), choices: [] },
  });

  assert.ok(result.error);
  assert.match(result.error.message, /存档与当前剧本对不上/);
});

test("the answers a live run takes are reported for a save", async () => {
  const answers = [];
  await run('choice {\n  "甲" {\n  }\n}', {
    source: "scripts/main.pamela",
    choose: () => Promise.resolve(0),
    onChoice: (answer) =>
      answers.push({ key: nodeKey(answer.file, answer.path), picked: answer.picked }),
  });

  assert.deepEqual(answers, [{ key: nodeKey("scripts/main.pamela", [0]), picked: 0 }]);
});

test("a replay makes the stage silent and instant, then hands it back", async () => {
  const stage = inFakeDom(() => domStage().stage);

  try {
    stage.setReplay(true);

    // A line answers at once instead of waiting for a click...
    assert.equal(await stage.sayLine("hero", "台词"), undefined);
    // ...and a move that says it takes 400 ms does not: a move in a replay is
    // over at once, so the run is back long before that could have passed.
    const started = Date.now();
    await run('bg = Background("bg.png")\nbg.moveTo(10, 0, 0, 400)', {
      constructors: createStageObjects(stage),
    });
    assert.ok(Date.now() - started < 300, "the replay move did not take its duration");

    stage.setReplay(false);
    let settled = false;
    const line = stage.sayLine("hero", "台词").then(() => {
      settled = true;
    });
    await tick();
    assert.equal(settled, false, "a live line waits for its click");
    stage.element.dispatch("click");
    await line;
  } finally {
    stage.setReplay(false);
  }
});

test("a replay restores the looping track that was on", async () => {
  const { value, created } = await inFakeDomCollecting(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolveAudio: () => Promise.resolve("data:audio/mpeg;base64,YWJj"),
    });
    stage.setReplay(true);
    try {
      const result = await run('a = Audio("bgm.mp3")\na.loop()\na.play()', {
        constructors: createStageObjects(stage),
      });
      await tick();
      return result;
    } finally {
      stage.setReplay(false);
    }
  });

  assert.equal(value.error, undefined);
  const sounds = created.filter((node) => node.tagName === "audio");
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0].paused, false, "the track that was on is back on");
});

test("a replay does not play the effects that were heard once", async () => {
  const { value, created } = await inFakeDomCollecting(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolveAudio: () => Promise.resolve("data:audio/mpeg;base64,YWJj"),
    });
    stage.setReplay(true);
    try {
      const result = await run('a = Audio("hit.wav")\na.once()\na.play()', {
        constructors: createStageObjects(stage),
      });
      await tick();
      return result;
    } finally {
      stage.setReplay(false);
    }
  });

  assert.equal(value.error, undefined);
  const sounds = created.filter((node) => node.tagName === "audio");
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0].paused, true, "an effect is not replayed");
});

test("a script can build a Background and enable it", async () => {
  const stage = fakeStage();
  const result = await run('bg = Background("assets/bg.png")\nbg.enable()', {
    constructors: createStageObjects(stage),
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.shown, ["assets/bg.png"]);
});

test("an empty script runs without drawing anything", async () => {
  const stage = fakeStage();
  const result = await run("# nothing here\n", { constructors: createStageObjects(stage) });
  assert.equal(result.error, undefined);
  assert.deepEqual(stage.shown, []);
});

test("an undefined name is an error, not a throw", async () => {
  const result = await run("a = missing");
  assert.ok(result.error);
  assert.equal(result.error.line, 1);
});

test("errors carry the line they occurred on", async () => {
  const result = await run("a = 1\nb = 2\nc = nope\n");
  assert.ok(result.error);
  assert.equal(result.error.line, 3);
});

test("prototype properties are unreachable from a script", async () => {
  for (const source of ["a = 1\na.constructor", "a = 1\na.__proto__", "a = 1\nprototype"]) {
    const result = await run(source);
    assert.ok(result.error, `expected ${JSON.stringify(source)} to fail`);
  }
});

test("calling a method on a plain value is an error", async () => {
  const result = await run("a = 1\na.enable()");
  assert.ok(result.error);
  assert.match(result.error.message, /enable/);
});

test("an error thrown by host code becomes a script error", async () => {
  const stage = fakeStage();
  const result = await run("Background(5)", { constructors: createStageObjects(stage) });
  assert.ok(result.error);
  assert.match(result.error.message, /Background/);
});

test("interpret accepts a pre-parsed program", async () => {
  const parsed = parse(tokenize("x = 2").tokens);
  const result = await interpret(parsed.program);
  assert.equal(result.error, undefined);
  assert.equal(result.value, 2);
});

test("a statement that takes time is over before the next begins", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\na.begin("one")\na.begin("two")', { constructors });

  await tick();
  assert.deepEqual(events, ["start one"], "the second statement has not begun");

  gates.get("one")();
  await tick();
  assert.deepEqual(events, ["start one", "end one", "start two"]);

  gates.get("two")();
  const result = await running;
  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["start one", "end one", "start two", "end two"]);
});

test("statements in a cue block start at the same moment", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue {\n  a.begin("one")\n  a.begin("two")\n}', {
    constructors,
  });

  await tick();
  // 关键约束：块内语句互不等待。
  // it, so both are under way before either has finished.
  assert.deepEqual(events, ["start one", "start two"]);

  gates.get("one")();
  await tick();
  assert.deepEqual(events, ["start one", "start two", "end one"]);

  const result = await running;
  assert.equal(result.error, undefined);
});

test("without wait, a block does not hold back what follows it", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run('a = Actor()\ncue {\n  a.begin("one")\n}\na.begin("two")', {
    constructors,
  });

  await tick();
  assert.deepEqual(events, ["start one", "start two"], "the block overlaps what follows");

  gates.get("two")();
  const result = await running;
  assert.equal(result.error, undefined);
  // The run is over while the block is still going: nothing waited for it.
  assert.deepEqual(events, ["start one", "start two", "end two"]);

  gates.get("one")();
  assert.deepEqual(events, ["start one", "start two", "end two", "end one"]);
});

test("wait holds what follows a block back until the block is over", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run(
    'a = Actor()\ncue {\n  a.begin("one")\n  a.begin("two")\n} wait\na.begin("three")',
    { constructors },
  );

  await tick();
  assert.deepEqual(events, ["start one", "start two"]);

  gates.get("one")();
  await tick();
  // Half the block is still running, so the statement after it has not begun:
  // `wait` is on the block as a whole, not on each action in it.
  assert.deepEqual(events, ["start one", "start two", "end one"]);
  assert.equal(gates.has("three"), false);

  gates.get("two")();
  await tick();
  assert.deepEqual(events, ["start one", "start two", "end one", "end two", "start three"]);

  gates.get("three")();
  const result = await running;
  assert.equal(result.error, undefined);
  assert.deepEqual(events, [
    "start one",
    "start two",
    "end one",
    "end two",
    "start three",
    "end three",
  ]);
});

test("wait has to sit on the closing line to belong to a block", async () => {
  const attached = await run("cue {\n  a = 1\n} wait");
  assert.equal(attached.error, undefined);

  // A newline separates statements everywhere else in the language, so a
  // `wait` on a line of its own is read as a statement of its own — where it
  // names nothing at all.
  const apart = await run("cue {\n  a = 1\n}\nwait");
  assert.ok(apart.error, "expected an error");
  assert.match(apart.error.message, /wait/);
  assert.equal(apart.error.line, 4);
});

// --- functions ---

test("a declared function performs its body where it is called", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run(
    [
      "a = Actor()",
      "func pair() {",
      '  a.begin("one")',
      '  a.begin("two")',
      "}",
      "pair()",
    ].join("\n"),
    { constructors },
  );

  await tick();
  // The body is a list of statements like any other: the second waits for the
  // first, and nothing after the call begins before the call is over.
  assert.deepEqual(events, ["start one"]);

  gates.get("one")();
  await tick();
  assert.deepEqual(events, ["start one", "end one", "start two"]);

  gates.get("two")();
  assert.equal((await running).error, undefined);
  assert.deepEqual(events, ["start one", "end one", "start two", "end two"]);
});

test("a call binds its arguments to the parameters the declaration named", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      "func place(target, x, y) {",
      "  target.moveTo(x, y, 0)",
      "}",
      'hero = Character("hero.png")',
      "hero.enable()",
      "place(hero, 100, 50)",
      "place(hero, -20, 0)",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  // The name the parameter stands for is whatever the argument was at the
  // moment of the call, so the same body places the character twice. The first
  // entry is where `enable` put it.
  assert.deepEqual(
    stage.moves.map(({ x, y }) => [x, y]),
    [
      [0, 0],
      [100, 50],
      [-20, 0],
    ],
  );
});

test("a call's parameters are its own, so an outer one survives a nested call", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      "func outer(target, x) {",
      "  inner(target, x)",
      "  target.moveTo(x, x, 0)",
      "}",
      "func inner(target, x) {",
      "  target.moveTo(x, 0, 0)",
      "}",
      'hero = Character("hero.png")',
      "hero.enable()",
      "outer(hero, 40)",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  // Past the entry `enable` left: the last move is back at 40 on both axes,
  // because the inner call bound an `x` of its own rather than eating the one
  // the outer call is still using.
  assert.deepEqual(
    stage.moves.slice(1).map(({ x, y }) => [x, y]),
    [
      [40, 0],
      [40, 40],
    ],
  );
});

test("a function bound to another name is called through it", async () => {
  const { events, constructors } = fakeActor();
  const result = await run(
    ['a = Actor()', "func note() {", '  a.note("hi")', "}", "alias = note", "alias()"].join(
      "\n",
    ),
    { constructors },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(events, ["hi"]);
});

test("a function called in a block belongs to the block's wait", async () => {
  const { events, gates, constructors } = fakeActor();
  const running = run(
    [
      "a = Actor()",
      "func pair() {",
      '  a.begin("one")',
      '  a.begin("two")',
      "}",
      "cue {",
      "  pair()",
      "} wait",
      'a.begin("three")',
    ].join("\n"),
    { constructors },
  );

  await tick();
  // The body is part of the moment the block asked for, and the statement
  // after the block is held back: `wait` covers the call as a whole.
  assert.deepEqual(events, ["start one", "start two"]);

  gates.get("one")();
  gates.get("two")();
  await tick();
  assert.deepEqual(events, ["start one", "start two", "end one", "end two", "start three"]);

  gates.get("three")();
  assert.equal((await running).error, undefined);
});

test("a declaration binds where it is written, so nothing above it can call it", async () => {
  const result = await run("f()\nfunc f() {\n  a = 1\n}");
  assert.ok(result.error, "expected an error");
  assert.equal(result.error.line, 1);
  assert.match(result.error.message, /未定义/);
});

test("a call with the wrong number of arguments is reported", async () => {
  const result = await run("func f(a, b) {\n  a.note(1)\n}\nf(1)");
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /2 个参数/);
  // Reported at the call, which is the line that has to change.
  assert.equal(result.error.line, 4);
});

test("a call that never stops is reported rather than left to hang", async () => {
  const result = await run("func loop() {\n  loop()\n}\nloop()");
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /层数/);
});

test("a run that is no longer the current one gives up at the next statement", async () => {
  const { events, constructors } = fakeActor();
  let checks = 0;
  const result = await run('a = Actor()\na.note("one")\na.note("two")', {
    constructors,
    // Asked before each statement; from the third on it answers that this run
    // has been superseded — which is what a second run of the script does.
    stopped: () => (checks += 1) > 2,
  });

  assert.equal(result.stopped, true);
  assert.deepEqual(events, ["one"], "the statement after the stop never ran");
});

test("a Background may be built empty, and still refuses a non-text path", () => {
  const objects = createStageObjects(fakeStage());
  // 空定义是图片组的第一半：先有对象，图片由 group(…) 给。
  assert.equal(objects.Background([""]).path, "");
  assert.equal(objects.Background([undefined]).path, "");
  assert.throws(() => objects.Background([5]), /路径/);
});

test("a script can build a Character and enable it", async () => {
  const stage = fakeStage();
  const result = await run('hero = Character("hero.png")\nhero.enable()', {
    constructors: createStageObjects(stage),
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.characters, [{ slot: "hero", path: "hero.png" }]);
  assert.deepEqual(stage.shown, [], "a character does not touch the background");
});

test("characters are independent: two variables draw two of them", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nrival = Character("rival.png")\nrival.enable()',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.characters, [
    { slot: "hero", path: "hero.png" },
    { slot: "rival", path: "rival.png" },
  ]);
});

test("rebuilding a variable reuses that character's slot", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("happy.png")\nhero.enable()\nhero = Character("angry.png")\nhero.enable()',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  // The same slot twice: the stage replaces the image rather than adding a
  // second character.
  assert.deepEqual(stage.characters, [
    { slot: "hero", path: "happy.png" },
    { slot: "hero", path: "angry.png" },
  ]);
});

test("a Character may be built empty, and still refuses a non-text path", () => {
  const objects = createStageObjects(fakeStage());
  assert.equal(objects.Character([""]).path, "");
  assert.equal(objects.Character([undefined]).path, "");
  assert.throws(() => objects.Character([5]), /Character 需要一个图片路径/);
});

test("空角色收下一组图，fps 按顺序换图并等它播完", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      "cg = Character()",
      'cg.group("ch1.png", "ch2.png", "ch3.png")',
      "cg.enable()",
      "cg.fps(144)",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.characters.map((entry) => entry.path), [
    "ch1.png", // enable 显示组里的第一张
    "ch2.png",
    "ch3.png",
  ]);
});

test("element 取出的路径可以直接交给构造函数", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      "cg = Character()",
      'cg.group("ch1.png", "ch2.png")',
      "nch = Character(cg.element(1))",
      "nch.enable()",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.characters, [{ slot: "nch", path: "ch2.png" }]);
});

test("pause 可以停在组外的一张图上，组本身不变", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      "cg = Character()",
      'cg.group("ch1.png", "ch2.png")',
      "cg.enable()",
      'cg.pause("extra.png")',
      "cg.pause(1)",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.characters.map((entry) => entry.path), [
    "ch1.png",
    "extra.png",
    "ch2.png",
  ]);
});

test("背景同样可以收下一组图并逐帧播放", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      "bg = Background()",
      'bg.group("day.png", "night.png")',
      "bg.enable()",
      "bg.fps(144)",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.shown, ["day.png", "night.png"]);
});

test("fps 写 0 会报错，组里的图片必须是路径", async () => {
  const stage = fakeStage();
  const badRate = await run('cg = Character()\ncg.group("a.png")\ncg.fps(0)', {
    constructors: createStageObjects(stage),
  });
  assert.ok(badRate.error);
  assert.match(badRate.error.message, /1–144/);

  const badMember = await run('cg = Character()\ncg.group("a.png", 5)', {
    constructors: createStageObjects(stage),
  });
  assert.ok(badMember.error);
  assert.match(badMember.error.message, /图片路径/);
});

test("add、remove、update 组内成员", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      "cg = Character()",
      'cg.group("a.png", "c.png")',
      'cg.add("a.png", "b.png")',
      'cg.pause("b.png")',
      'cg.update("b.png", "b2.png")',
      "cg.remove(0)",
      "cg.enable()",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  // 组里剩 b2.png 与 c.png；中间那张被换过、第一张被移走，画面停在 b2.png。
  assert.deepEqual(stage.characters, [{ slot: "cg", path: "b2.png" }]);
});

test("a line waits for a click and carries the name the script gave it", async () => {
  const stage = fakeStage();
  const running = run(
    'hero = Character("hero.png")\nhero.name("艾拉")\nhero.say("你来了。")\nhero.say("第二句")',
    { constructors: createStageObjects(stage) },
  );

  await tick();
  // Parked on the first line: the statement after it has not begun, so a line
  // is never read past.
  assert.deepEqual(
    stage.lines.map(({ name, text }) => [name, text]),
    [["艾拉", "你来了。"]],
  );

  stage.lines[0].settle();
  await tick();
  assert.deepEqual(
    stage.lines.map(({ name, text }) => [name, text]),
    [
      ["艾拉", "你来了。"],
      ["艾拉", "第二句"],
    ],
  );

  stage.lines[1].settle();
  assert.equal((await running).error, undefined);
});

test("a character speaks as undefinedName until a script names it", async () => {
  const stage = fakeStage();
  const running = run('hero = Character("hero.png")\nhero.say("哦。")', {
    constructors: createStageObjects(stage),
  });

  await tick();
  assert.equal(stage.lines[0].name, "undefinedName");
  stage.lines[0].settle();
  assert.equal((await running).error, undefined);
});

test("a bare say is the narrator: no name to show", async () => {
  const stage = fakeStage();
  // A bare `say` reaches `stage.say`, so the run needs the stage's globals.
  const running = run('say("夜深了。")', {
    constructors: createStageObjects(stage),
    globals: createStageGlobals(stage),
  });

  await tick();
  assert.deepEqual(
    stage.lines.map(({ name, text }) => [name, text]),
    [[null, "夜深了。"]],
  );
  stage.lines[0].settle();
  assert.equal((await running).error, undefined);
});

test("stage.click 与 stage.auto 挡住脚本，且把时间参数交给舞台", async () => {
  const stage = fakeStage();
  const running = run(
    'stage.click(2000)\nstage.auto(1500)\nstage.click()',
    { globals: createStageGlobals(stage) },
  );

  await tick();
  // 第一句 click 还在等待，后面的 auto 与第二个 click 都还没走到。
  assert.equal(stage.clicks.length, 1, "脚本停在第一个 click 上");
  assert.equal(stage.waits.length, 0, "auto 还没执行");
  assert.equal(stage.clicks[0].time, 2000);
  assert.equal(stage.clicks[0].done, false);

  stage.clicks[0].settle();
  await tick();
  assert.equal(stage.waits.length, 1, "click 放行后走到 auto");
  assert.equal(stage.waits[0].time, 1500);
  assert.equal(stage.waits[0].done, false);

  stage.waits[0].settle();
  await tick();
  assert.equal(stage.clicks.length, 2, "auto 放行后走到第二个 click");
  // 没有给时间参数的 click 传 0。
  assert.equal(stage.clicks[1].time, 0);
  assert.equal(stage.clicks[1].done, false);

  stage.clicks[1].settle();
  assert.equal((await running).error, undefined);
});

// --- stage 的批量调用 ---

/** An object with `kind` and the methods a bulk call reaches, recording calls. */
function bulkActor(kind, name, log) {
  return {
    kind,
    name,
    enable() {
      log.push([name, "enable"]);
      return this;
    },
    show(time) {
      log.push([name, "show", time]);
      return this;
    },
    hide(time) {
      log.push([name, "hide", time]);
      return this;
    },
    scale(value, time) {
      log.push([name, "scale", value, time]);
      return this;
    },
  };
}

test("stage calls the method on every object it names", async () => {
  const log = [];
  const made = [];
  const constructors = {
    Character: () => {
      const actor = bulkActor("Character", `ch${made.length + 1}`, log);
      made.push(actor);
      return actor;
    },
    Background: () => {
      const actor = bulkActor("Background", `bg${made.length + 1}`, log);
      made.push(actor);
      return actor;
    },
  };

  const result = await run(
    [
      'a = Character("a.png")',
      'b = Character("b.png")',
      'c = Background("c.png")',
      "stage.enable(a, b, c)",
    ].join("\n"),
    { constructors, globals: { stage: { kind: "Stage" } } },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [
    ["ch1", "enable"],
    ["ch2", "enable"],
    ["bg3", "enable"],
  ]);
});

test("a colon ends the fixed arguments, so a middle parameter can be skipped", async () => {
  const log = [];
  let count = 0;
  const constructors = {
    Character: () => {
      count += 1;
      return bulkActor("Character", `ch${count}`, log);
    },
  };
  const globals = { stage: { kind: "Stage" } };

  const result = await run(
    [
      'a = Character("a.png")',
      'b = Character("b.png")',
      "stage.scale(2.0 : a, b)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  // `time` is never filled: the call is `scale(2.0)`, not `scale(2.0, a)`.
  assert.deepEqual(log, [
    ["ch1", "scale", 2, undefined],
    ["ch2", "scale", 2, undefined],
  ]);
});

test("without a colon the objects are the trailing values, so time can be skipped", async () => {
  const log = [];
  let count = 0;
  const constructors = {
    Character: () => {
      count += 1;
      return bulkActor("Character", `ch${count}`, log);
    },
  };
  const globals = { stage: { kind: "Stage" } };

  const result = await run(
    [
      'a = Character("a.png")',
      'b = Character("b.png")',
      "stage.scale(2.0, a)",
      "stage.hide(a, b)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [
    ["ch1", "scale", 2, undefined],
    ["ch1", "hide", undefined],
    ["ch2", "hide", undefined],
  ]);
});

test("a bare bulk call is the stage's, exactly as a bare say is", async () => {
  const log = [];
  const constructors = {
    Character: () => bulkActor("Character", "ch1", log),
  };

  const result = await run(['a = Character("a.png")', "enable(a)"].join("\n"), {
    constructors,
    globals: { stage: { kind: "Stage" } },
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [["ch1", "enable"]]);
});

test("a bulk call with nothing to act on is an error, not a no-op", async () => {
  const result = await run("stage.enable()", {
    constructors: {},
    globals: { stage: { kind: "Stage" } },
  });

  assert.ok(result.error);
  assert.match(result.error.message, /至少一个对象/);
});

test("a colon keeps the fixed arguments and the objects apart in the tree", () => {
  const statements = parse(tokenize("stage.scale(2.0 : ch, bg)").tokens).program.statements;
  const call = statements[0].value;

  assert.equal(call.type, "call");
  assert.equal(call.args.length, 1);
  assert.equal(call.args[0].value, 2);
  assert.deepEqual(
    call.objects.map((node) => node.name),
    ["ch", "bg"],
  );
  // A call without a colon keeps the shape it always had.
  const plain = parse(tokenize("bg.enable()").tokens).program.statements[0].value;
  assert.equal("objects" in plain, false);
});

test("the narrator's line is the stage's call, and a bare say is the same call", async () => {
  // `stage` comes into being with the stage: a script neither builds it nor
  // destroys it. `say` is that same method with the receiver left out — not a
  // second function — so every spelling must produce the same line.
  for (const source of ['stage.say("夜深了。")', 'say("夜深了。")', '舞台.说("夜深了。")']) {
    const stage = fakeStage();
    const running = run(source, {
      constructors: createStageObjects(stage),
      globals: createStageGlobals(stage),
    });

    await tick();
    assert.deepEqual(
      stage.lines.map(({ name, text }) => [name, text]),
      [[null, "夜深了。"]],
      source,
    );
    stage.lines[0].settle();
    assert.equal((await running).error, undefined, source);
  }
});

// --- 舞台：类型构造方法的归属 ---

test("a type is built by a method of the stage; the bare call is the same call", async () => {
  // `stage.Character(…)` and `Character(…)` reach one constructor, so the two
  // names a script binds draw in their own slots exactly as they always did.
  // Chinese receiver, Chinese constructor and mixed spellings all resolve to it.
  for (const source of [
    'ch1 = stage.Character("ch1.png")\nch2 = Character("ch2.png")',
    'ch1 = 舞台.角色("ch1.png")\nch2 = 角色("ch2.png")',
    'ch1 = 舞台.Character("ch1.png")\nch2 = 角色("ch2.png")',
  ]) {
    const stage = fakeStage();
    const result = await run(`${source}\nch1.enable()\nch2.enable()`, {
      globals: createStageGlobals(stage),
    });

    assert.equal(result.error, undefined, source);
    assert.deepEqual(
      stage.characters,
      [
        { slot: "ch1", path: "ch1.png" },
        { slot: "ch2", path: "ch2.png" },
      ],
      source,
    );
  }
});

test("a stage constructor takes arguments by name and answers to a chain", async () => {
  const stage = fakeStage();
  const named = await run(
    'hero = stage.Character("hero.png", y = -500, x = 300, scaleTo = 2)\nhero.enable()',
    { globals: createStageGlobals(stage) },
  );

  assert.equal(named.error, undefined);
  assert.deepEqual(
    stage.moves.map(({ x, y }) => [x, y]),
    [[300, -500]],
    "named arguments reach the constructor's own slots",
  );
  assert.equal(stage.turns[0].scale, 2);

  const chainedStage = fakeStage();
  const chained = await run('stage.Background("room.png").enable()', {
    globals: createStageGlobals(chainedStage),
  });
  assert.equal(chained.error, undefined);
  assert.deepEqual(chainedStage.shown, ["room.png"]);
});

test("a host's injected factories are adopted as the stage's methods", async () => {
  // A host that offers no stage of its own (or a test that builds a run by
  // hand) still works: the factories become methods of the stage for that run,
  // so the dotted spelling reaches the same ones the bare spelling always did.
  const built = [];
  const constructors = {
    Character: (args) => {
      built.push(args[0]);
      return { kind: "Character" };
    },
  };
  const result = await run('ch1 = Character("a.png")\nch2 = stage.Character("b.png")', {
    constructors,
    globals: { stage: { kind: "Stage" } },
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(built, ["a.png", "b.png"]);
});

test("the language's own calls are answered through the stage as well", async () => {
  const result = await run("x = stage.str(7 / 2, 2)", {
    globals: { stage: { kind: "Stage" } },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value, "3.50");
});

test("a name or a line that is not text is a script error", async () => {
  const stage = fakeStage();
  const nameless = await run('hero = Character("hero.png")\nhero.name(1)', {
    constructors: createStageObjects(stage),
  });
  assert.ok(nameless.error, "expected a bad name to fail");
  assert.match(nameless.error.message, /名字/);

  for (const source of ['say(1)', 'hero = Character("hero.png")\nhero.say()']) {
    const result = await run(source, {
      constructors: createStageObjects(stage),
      globals: createStageGlobals(stage),
    });
    assert.ok(result.error, `expected ${source} to fail`);
    assert.match(result.error.message, /台词/);
  }
});

// --- 参数名 ---

test("a named argument fills the slot its name has, and skips the rest", async () => {
  const stage = fakeStage();
  // The first parameter is still the resource, so the old call and this one are
  // the same call: `y` is the third slot and `scaleTo` the fifth, given by name,
  // which leaves the `scale` in between empty rather than filling it.
  const result = await run(
    'hero = Character("hero.png", y = -500, x = 300, scaleTo = 2)\nhero.enable()',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  // The frame is painted by `enable()`, so the stage is where it shows up.
  assert.deepEqual(
    stage.moves.map(({ x, y }) => [x, y]),
    [[300, -500]],
    "x and y are the stage coordinates",
  );
  assert.equal(stage.turns[0].scale, 2, "scaleTo replaces the size");
});

test("named arguments may come in any order", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png", alpha = 0.5, scale = 2, x = -100)\nhero.enable()',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.equal(stage.moves[0].x, -100, "x places outright");
  assert.equal(stage.turns[0].scale, 2);
  assert.equal(stage.fades.at(-1).value, 0.5);
});

test("a method takes its arguments by name too", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nhero.moveTo(y = 200, x = 640, time = 0)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(
    stage.moves.at(-1),
    { target: "hero", x: 640, y: 200, time: 0 },
    "the names filled the slots their positions have",
  );
});

test("a character can be given its name when it is built", async () => {
  const stage = fakeStage();
  const running = run('hero = Character("hero.png", name = "帕梅拉")\nhero.say("你好。")', {
    constructors: createStageObjects(stage),
  });

  await tick();
  // `name` is the same call as `.name("…")` right after the constructor, so the
  // very first line is already attributed to it.
  assert.equal(stage.lines[0].name, "帕梅拉");
  stage.lines[0].settle();
  assert.equal((await running).error, undefined);
});

test("a name the call does not have is reported, not ignored", async () => {
  const stage = fakeStage();
  const result = await run('hero = Character("hero.png", xTooo = 1)', {
    constructors: createStageObjects(stage),
  });
  assert.ok(result.error, "a misspelled name must fail");
  assert.match(result.error.message, /xTooo/);
  // The message lists what could have been written, so a typo is fixable
  // without opening the help.
  assert.match(result.error.message, /scaleTo/);
});

test("a constructor has no offset coordinates: x and y are the only place", async () => {
  // A new object is already at the origin, so `xTo` would say the same thing as
  // `x` — it is gone, and saying it is an error rather than a silent no-op.
  const stage = fakeStage();
  for (const name of ["xTo", "yTo"]) {
    const result = await run(`hero = Character("hero.png", ${name} = 300)`, {
      constructors: createStageObjects(stage),
    });
    assert.ok(result.error, `expected ${name} to be rejected`);
    assert.match(result.error.message, new RegExp(name));
  }
});

test("giving one parameter twice is reported", async () => {
  const stage = fakeStage();
  // `time` is the fourth argument, and the call already gave four positions.
  const result = await run('hero = Character("hero.png")\nhero.moveTo(1, 2, 0, 5, time = 5)', {
    constructors: createStageObjects(stage),
  });
  assert.ok(result.error, "the third slot is already positional");
  assert.match(result.error.message, /参数/);
});

test("which receiver a method is called on decides its parameter names", async () => {
  // `say` takes a name slot on the dialogue box and none on a character: the
  // same word, two calls, so the name is resolved against the receiver.
  const stage = fakeStage();
  const running = run('dialog.say(text = "台词", name = "帕梅拉")', {
    constructors: createStageObjects(stage),
    globals: createStageGlobals(stage),
  });

  await tick();
  assert.deepEqual(
    stage.lines.map(({ name, text }) => [name, text]),
    [["帕梅拉", "台词"]],
  );
  stage.lines[0].settle();
  assert.equal((await running).error, undefined);
});

test("moveTo puts a character at absolute stage coordinates", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nhero.moveTo(300, -120, 0, 500)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.moves, [
    // Enabling places the character at the centre first.
    { target: "hero", x: 0, y: 0, time: undefined },
    { target: "hero", x: 300, y: -120, time: 500 },
  ]);
});

test("move is relative to where the character already is", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nhero.moveTo(100, 50)\nhero.move(20, -30, 0, 200)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.moves.at(-1), { target: "hero", x: 120, y: 20, time: 200 });
});

test("the backdrop moves like a character does", async () => {
  const stage = fakeStage();
  const result = await run('bg = Background("bg.png")\nbg.enable()\nbg.moveTo(0, -40, 0, 800)', {
    constructors: createStageObjects(stage),
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.moves.at(-1), { target: "background", x: 0, y: -40, time: 800 });
});

test("a place set before enable is applied when the character appears", async () => {
  const stage = fakeStage();
  const result = await run('hero = Character("hero.png")\nhero.moveTo(200, 100)\nhero.enable()', {
    constructors: createStageObjects(stage),
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.moves, [{ target: "hero", x: 200, y: 100, time: undefined }]);
});

test("a coordinate that is not a number is a script error", async () => {
  const stage = fakeStage();
  const result = await run('hero = Character("hero.png")\nhero.moveTo("left", 0)', {
    constructors: createStageObjects(stage),
  });

  assert.ok(result.error);
  assert.match(result.error.message, /坐标/);
});

test("a negative move time is a script error", async () => {
  const stage = fakeStage();
  const result = await run('hero = Character("hero.png")\nhero.move(0, 0, 0, -1)', {
    constructors: createStageObjects(stage),
  });

  assert.ok(result.error);
  assert.match(result.error.message, /毫秒/);
});

test("rotateTo sets the angle and rotate turns from it", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nhero.rotateTo(90)\nhero.rotate(-45, 300)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.turns, [
    // Enabling turns the character to upright first.
    { target: "hero", rotation: 0, scale: 1, time: 0 },
    { target: "hero", rotation: 90, scale: 1, time: 0 },
    // Relative to the 90 just set, and negative turns back.
    { target: "hero", rotation: 45, scale: 1, time: 300 },
  ]);
});

test("an angle is taken as written, past a full turn and below zero", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nhero.rotateTo(720)\nhero.rotate(-900)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  // 720 is two whole turns rather than being wrapped to nothing.
  assert.equal(stage.turns.at(-2).rotation, 720);
  assert.equal(stage.turns.at(-1).rotation, -180);
});

test("scaleTo sets the size and scale multiplies it", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nhero.scaleTo(1.5)\nhero.scale(2, 250)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.turns, [
    { target: "hero", rotation: 0, scale: 1, time: 0 },
    { target: "hero", rotation: 0, scale: 1.5, time: 0 },
    // Sizes compound, so this is 1.5 × 2 rather than 2.
    { target: "hero", rotation: 0, scale: 3, time: 250 },
  ]);
});

test("a turn and a size set before enable are applied when the character appears", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.rotateTo(30)\nhero.scale(0.5)\nhero.enable()',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.turns, [{ target: "hero", rotation: 30, scale: 0.5, time: 0 }]);
});

test("the backdrop turns and resizes like a character does", async () => {
  const stage = fakeStage();
  const result = await run(
    'bg = Background("bg.png")\nbg.enable()\nbg.rotateTo(15, 200)\nbg.scaleTo(1.2, 600)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.turns.at(-1), {
    target: "background",
    rotation: 15,
    scale: 1.2,
    time: 600,
  });
});

test("a turn angle that is not a number is a script error", async () => {
  const stage = fakeStage();
  const result = await run('hero = Character("hero.png")\nhero.rotateTo("right")', {
    constructors: createStageObjects(stage),
  });

  assert.ok(result.error);
  assert.match(result.error.message, /角度/);
});

test("a size multiplier of zero or less is a script error", async () => {
  const stage = fakeStage();
  for (const call of ["hero.scaleTo(0)", "hero.scale(-1)"]) {
    const result = await run(`hero = Character("hero.png")\n${call}`, {
      constructors: createStageObjects(stage),
    });
    assert.ok(result.error, `expected ${call} to fail`);
    assert.match(result.error.message, /倍率/);
  }
});

test("stageNameFor labels a stage after its script", () => {
  assert.equal(stageNameFor("scripts/new.pamela"), "new.stage");
  assert.equal(stageNameFor("scripts\\a\\scene.pamela"), "scene.stage");
  assert.equal(stageNameFor("prologue"), "prologue.stage");
  assert.equal(stageNameFor(""), null);
  assert.equal(stageNameFor(".pamela"), null);
});

test("the stage builds its layers in the order they are drawn", () => {
  inFakeDom(() => {
    const { surface } = domStage();

    // The layers exist from the start and are never reordered. The video,
    // effect, text, light, axes and guideline layers are appended last so the
    // first four keep their child indices; CSS z-index puts them back where they
    // belong — the light over the pictures but under the dialogue and the
    // question, and the guideline under the axes, both over everything.
    assert.deepEqual(
      surface.childNodes.map((node) => node.className),
      [
        "stage__layer stage__layer--background",
        "stage__layer stage__layer--character",
        "stage__layer stage__layer--dialogue",
        "stage__layer stage__layer--choice",
        "stage__layer stage__layer--video",
        "stage__layer stage__layer--effect",
        "stage__layer stage__layer--text",
        "stage__layer stage__layer--light",
        "stage__axes",
        "stage__guideline",
        "stage__layer stage__layer--intro",
      ],
    );
  });
});

test("crood(true) shows only that object's own axes, and the default is hidden", async () => {
  await inFakeDomAsync(async () => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const result = await run(
      'hero = Character("hero.png")\nbg = Background("bg.png")\nhero.crood(true)\nhero.enable()\nbg.enable()',
      { constructors: objects },
    );

    assert.equal(result.error, undefined);
    assert.equal(stage.croodIsOn("character:hero"), true);
    assert.equal(stage.croodIsOn("background"), false, "谁的轴都没写就是隐藏");
    const frames = stage.axesFrames();
    assert.equal(frames.length, 1, "只有开了 crood 的那个对象有轴");
    assert.equal(frames[0].key, "character:hero");
    assert.equal(frames[0].label, "hero");
    assert.equal(frames[0].axes.length, 3, "每个对象一套完整的三根轴");

    // 轴读的是舞台真正用来画图的姿态，转身后立刻跟着转。
    const rebuilt = objects.Character(["hero.png"], { assignee: "hero" });
    rebuilt.enable();
    rebuilt.rotateTo(90);
    const rolled = stage.axesFrames()[0];
    assert.ok(rolled.axes[2].to.y < rolled.origin.y, "W 面转 90 度后 x 平轴朝下");
  });
});

test("crood(false) folds the axes away, and clearing the stage drops every switch", async () => {
  await inFakeDomAsync(async () => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    hero.crood(true);
    assert.equal(stage.croodIsOn("character:hero"), true);

    hero.crood(false);
    assert.equal(stage.croodIsOn("character:hero"), false);
    assert.deepEqual(stage.axesFrames(), []);

    // 中文写法走内置别名表，落到同一个开关上。
    const result = await run('hero = Character("hero.png")\nhero.坐标轴(true)', {
      constructors: objects,
    });
    assert.equal(result.error, undefined);
    assert.equal(stage.croodIsOn("character:hero"), true);

    stage.clear();
    assert.equal(stage.croodIsOn("character:hero"), false, "下一场不继承调试轴");
    assert.deepEqual(stage.axesFrames(), []);
  });
});

test("lights and videos answer crood through the same switch", async () => {
  await inFakeDomAsync(async () => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const lamp = objects.Light([], { assignee: "lamp" });
    lamp.enable();
    lamp.crood(true);
    assert.equal(stage.croodIsOn("light:lamp"), true);
    assert.equal(stage.axesFrames()[0].key, "light:lamp");

    const clip = objects.Video(["clip.mp4"], { assignee: "clip" });
    clip.crood(true);
    assert.equal(stage.croodIsOn("video:clip"), true);
    assert.equal(typeof stage.video.axisPose("clip"), "object", "视频的姿态由 video.js 交出");
  });
});

test("stage.perspective is off until the script turns it on, and clearing resets it", async () => {
  await inFakeDomAsync(async () => {
    const { stage, character } = domStage();
    const objects = createStageObjects(stage);
    assert.equal(stage.perspectiveIsOn(), false, "默认是非透视空间");

    // 正交空间里深度不改变位置：z 推得再远，画面上的横向位置还是 300。
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();
    hero.moveTo(300, 0, 2000);
    const ortho = parseFloat(character.childNodes[0].style.left);

    const result = await run("stage.perspective(true)", {
      constructors: objects,
      globals: createStageGlobals(stage),
    });
    assert.equal(result.error, undefined);
    assert.equal(stage.perspectiveIsOn(), true);

    // 透视改变的是整幅画面的投影，不是某个对象的数：已经摆好的图片按新投影
    // 重画一次，推远的角色朝中心收。
    const wide = parseFloat(character.childNodes[0].style.left);
    assert.ok(wide < ortho, "打开透视后远景朝中心收");

    stage.clear();
    assert.equal(stage.perspectiveIsOn(), false, "下一场回到正交空间");
  });
});

test("stage.guideline takes a switch and an interval, and clamps it", async () => {
  await inFakeDomAsync(async () => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    assert.equal(stage.guidelineIsOn(), false, "默认不画参考线");
    assert.equal(stage.guidelineInterval(), 100);

    const runtime = { constructors: objects, globals: createStageGlobals(stage) };
    const opened = await run("stage.guideline(true)", runtime);
    assert.equal(opened.error, undefined);
    assert.equal(stage.guidelineIsOn(), true);
    assert.equal(stage.guidelineInterval(), 100, "省略间隔时保持默认");

    await run("stage.guideline(true, 200)", runtime);
    assert.equal(stage.guidelineInterval(), 200);

    await run("stage.guideline(true, 1)", runtime);
    assert.equal(stage.guidelineInterval(), 10, "间隔最小为 10");

    await run("stage.guideline(false)", runtime);
    assert.equal(stage.guidelineIsOn(), false);
    assert.equal(stage.guidelineInterval(), 10, "关掉时记着上一次的间隔");
  });
});

test("h and v are the same calls as x and y, and hTo / vTo as xTo / yTo", async () => {
  await inFakeDomAsync(async () => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);
    const hero = objects.Character(["hero.png"], { assignee: "hero" });
    hero.enable();

    hero.h(40);
    assert.equal(hero.px, 40, "h 沿 H 平轴相对移动，与 x 同一个数");
    hero.v(-30);
    assert.equal(hero.py, -30, "v 沿 V 升轴相对移动，与 y 同一个数");
    hero.hTo(10);
    assert.equal(hero.px, 10);
    assert.equal(hero.py, -30, "hTo 不动 V");
    hero.vTo(0);
    assert.equal(hero.py, 0);

    // 脚本里的写法走同一张参数表：位置参数、HVD 参数名与中文参数名都认。
    const result = await run(
      'hero = Character("hero.png")\nhero.enable()\nhero.hTo(10)\nhero.h(h = 60)\nhero.h(横 = 5)\nhero.vTo(-100)',
      { constructors: objects },
    );
    assert.equal(result.error, undefined);
    const state = stage.characterState("hero");
    assert.equal(state.x, 75, "h 是相对移动：10 + 60 + 5");
    assert.equal(state.y, -100, "vTo 与 yTo 落在同一个位置");

    // move 的三个参数也能按 HVD 命名：horizontal / vertical / depth。
    const moved = await run(
      'hero = Character("hero.png")\nhero.enable()\nhero.moveTo(0, 0, 0)\nhero.move(horizontal = 100, vertical = -50, depth = 200)',
      { constructors: objects },
    );
    assert.equal(moved.error, undefined);
    const after = stage.characterState("hero");
    assert.equal(after.x, 100);
    assert.equal(after.y, -50);
    assert.equal(after.depth, 200);
  });
});

test("a character draws on its own layer, leaving the background alone", () => {
  inFakeDom(() => {
    const { stage, surface, background, character } = domStage();

    stage.setBackground("bg.png");
    const backdrop = background.childNodes[0];
    assert.equal(backdrop.className, "stage__background");
    assert.equal(stage.isEmpty(), false);

    stage.setCharacter("hero", "hero.png");
    assert.equal(background.childNodes[0], backdrop, "the background is untouched");
    assert.equal(character.childNodes[0].className, "stage__character");

    // Clearing empties the drawing layers but keeps the stack itself.
    stage.clear();
    assert.equal(surface.childNodes.length, 11, "eleven layers, none of them dropped");
    assert.equal(stage.isEmpty(), true);
  });
});

test("a new background replaces the old one", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();

    stage.setBackground("first.png");
    const first = background.childNodes[0];
    stage.setBackground("second.png");

    assert.equal(background.childNodes.length, 1, "a stage has one backdrop");
    assert.notEqual(background.childNodes[0], first);
  });
});

test("characters are kept side by side, one slot each", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();

    stage.setCharacter("hero", "hero.png");
    stage.setCharacter("rival", "rival.png");

    // Each character is two nodes: the plain image it draws as, and the mesh a
    // pull on any of its eight points would draw it through instead.
    assert.equal(character.childNodes.length, 4);
    assert.deepEqual(
      character.childNodes.map((node) => node.className),
      ["stage__character", "stage__mesh", "stage__character", "stage__mesh"],
    );
    assert.equal(stage.isEmpty(), false);
  });
});

test("rebuilding a character replaces only that slot, in place", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();

    stage.setCharacter("hero", "happy.png");
    stage.setCharacter("rival", "rival.png");
    const [hero, heroMesh, rival] = character.childNodes;

    stage.setCharacter("hero", "angry.png");

    assert.equal(character.childNodes.length, 4, "no character is added");
    assert.equal(character.childNodes[0], hero, "the rebuilt slot keeps its place");
    assert.equal(character.childNodes[1], heroMesh, "and its mesh with it");
    assert.equal(character.childNodes[2], rival, "the other character is untouched");
  });
});

test("coordinates are written as a percentage of the frame, from its centre", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    const place = (x, y) => {
      stage.moveBackground(x, y, undefined, 0);
      const { style } = background.childNodes[0];
      return [style.left, style.top];
    };

    stage.setBackground("bg.png");
    // The origin is the stage centre, which is also where a fresh image sits.
    assert.deepEqual(place(0, 0), ["50%", "50%"]);
    // Right and up are positive... a quarter of the way each.
    assert.deepEqual(place(STAGE_WIDTH / 4, STAGE_HEIGHT / 4), ["75%", "25%"]);
    // ...and left and down are negative, all the way to the corner.
    assert.deepEqual(place(-STAGE_WIDTH / 2, -STAGE_HEIGHT / 2), ["0%", "100%"]);
  });
});

test("a move over time animates; one without it jumps", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();

    stage.setCharacter("hero", "hero.png");
    stage.moveCharacter("hero", 0, 0, 0);
    const image = character.childNodes[0];
    assert.equal(image.style.transition, "none");
    // A jump has nothing to animate, so it does not make the browser lay the
    // stage out either.
    assert.deepEqual(image.log.filter((entry) => entry === "layout"), []);

    image.log.length = 0;
    stage.moveCharacter("hero", 100, 0, undefined, 400);
    assert.equal(image.style.transition, "left 400ms linear, top 400ms linear");
    // The frame is read back before the point it is asked to reach, which is
    // what gives the browser somewhere to animate from.
    assert.deepEqual(image.log.slice(0, 2), ["style.transition", "layout"]);
  });
});

test("a turn and a resize are written onto the image's transform", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();

    stage.setCharacter("hero", "hero.png");
    stage.moveCharacter("hero", 0, 0, 0);
    stage.transformCharacter("hero", 90, 2, 0);

    const { style } = character.childNodes[0];
    // The centring translate is repeated, since `transform` replaces the
    // stylesheet's declaration whole.
    assert.equal(style.transform, "translate(-50%, -50%) rotate(90deg) scale(2)");
    // The point the script named is still the image's centre.
    assert.equal(style.left, "50%");
    assert.equal(style.top, "50%");
  });
});

test("a move leaves the turn and size on the image alone", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();

    stage.setCharacter("hero", "hero.png");
    stage.transformCharacter("hero", 30, 1.5, 0);
    stage.moveCharacter("hero", -100, 0, 0);

    const { style } = character.childNodes[0];
    assert.equal(style.transform, "translate(-50%, -50%) rotate(30deg) scale(1.5)");
    assert.equal(style.left, `${50 - (100 / STAGE_WIDTH) * 100}%`);
  });
});

test("a turn animates on its own timeline without cutting a move short", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();

    stage.setCharacter("hero", "hero.png");
    stage.moveCharacter("hero", 200, 0, undefined, 400);
    stage.transformCharacter("hero", 45, 1, 800);

    const { style } = character.childNodes[0];
    assert.equal(
      style.transition,
      "left 400ms linear, top 400ms linear, transform 800ms linear",
    );

    // A jump cancels its own animation, and only its own.
    stage.transformCharacter("hero", 0, 1, 0);
    assert.equal(style.transition, "left 400ms linear, top 400ms linear");
    assert.equal(style.transform, "translate(-50%, -50%) rotate(0deg) scale(1)");
  });
});

test("moving a slot that is not on the stage is ignored", () => {
  inFakeDom(() => {
    const { stage } = domStage();

    // No throw: a script may place a character that a failed load has dropped.
    stage.moveCharacter("ghost", 10, 10, undefined, 100);
    stage.moveBackground(10, 10, undefined, 100);
  });
});

test("the box is a stand-in bar, a stamp, a name plate, the line and the live plate", () => {
  const { box, node } = inFakeDom(() => dialogueBox());

  assert.deepEqual(
    node.childNodes.map((child) => child.className),
    [
      "dialogue__fallback",
      "dialogue__stamp",
      "dialogue__speaker",
      "dialogue__text",
      "dialogue__plate",
    ],
  );
  // Nothing is up before the first line, so there is nothing for a click to end.
  assert.equal(box.isWaiting(), false);
});

test("a narrator's line leaves the name plate out", () => {
  const { box, speaker, text } = inFakeDom(() => dialogueBox());

  box.line(null, "夜深了。");
  assert.equal(speaker.hidden, true);
  assert.equal(speaker.textContent, "");
  assert.equal(text.textContent, "夜深了。");
});

test("a sample lays text out the same way without waiting on a click", () => {
  const { box, speaker, text } = inFakeDom(() => dialogueBox());

  box.sample("示例姓名", "示例文本：这一行用来预览字体样式。");

  assert.equal(speaker.hidden, false);
  assert.equal(speaker.textContent, "示例姓名");
  assert.equal(text.textContent, "示例文本：这一行用来预览字体样式。");
  // Nothing is being read: a sample is the designer drawing a style, so there
  // is no wait to end and a click has nothing to settle.
  assert.equal(box.isWaiting(), false);
  assert.equal(box.settle(), false);

  // A narrator's sample still hides the plate, and a real line follows either.
  box.sample(null, "换一句");
  assert.equal(speaker.hidden, true);
  assert.equal(text.textContent, "换一句");
});

test("a click ends the wait, and a line already up refuses a second", async () => {
  const { box, element, speaker, text } = inFakeDom(() => dialogueBox());

  const spoken = box.line("艾拉", "你来了。");
  assert.equal(speaker.hidden, false);
  assert.equal(speaker.textContent, "艾拉");
  assert.equal(text.textContent, "你来了。");
  assert.equal(box.isWaiting(), true);

  // Two lines at once is a `cue` block speaking twice: refused rather than
  // resolved to one of them, since neither reading is what a writer meant.
  assert.throws(() => box.line("艾拉", "又一句"), /并发台词/);

  element.dispatch("click");
  assert.equal(box.isWaiting(), false);
  await spoken;
  // A click with nothing up is a no-op, not a second settling.
  assert.equal(box.settle(), false);
});

test("clearing the stage ends a line that is still up", async () => {
  const { box, speaker, text } = inFakeDom(() => dialogueBox());

  const spoken = box.line("艾拉", "你来了。");
  box.clear();
  await spoken;

  assert.equal(box.isWaiting(), false);
  assert.equal(speaker.hidden, true);
  assert.equal(speaker.textContent, "");
  assert.equal(text.textContent, "");
});

// --- the line being written out ---

/** A box whose style reveals the line a character at a time. */
function typingBox(speed = 5) {
  const made = dialogueBox();
  made.box.setStyle({ text: { typeSpeed: speed } });
  return made;
}

test("a style with no speed shows the whole line at once", () => {
  const { box, text } = inFakeDom(() => dialogueBox());
  box.line("艾拉", "你来了。");
  // The default is zero, which is what every project written before the field
  // existed reads as.
  assert.equal(text.textContent, "你来了。");
  assert.equal(box.isTyping(), false);
});

test("a line with a speed is written out a character at a time", async () => {
  const { box, text } = inFakeDom(() => typingBox(4));

  const spoken = box.line("艾拉", "你好。");
  assert.equal(box.isTyping(), true, "the reveal is running");
  // Nothing is on screen yet: the first character arrives after one tick.
  assert.equal(text.textContent, "");

  await new Promise((resolve) => setTimeout(resolve, 6));
  assert.ok(text.textContent.length > 0, "the line is arriving");
  assert.ok(text.textContent.length < 3, "but not all at once");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(text.textContent, "你好。");
  assert.equal(box.isTyping(), false, "the reveal is over");
  // The line still waits for a click once it is fully written.
  assert.equal(box.isWaiting(), true);

  box.settle();
  await spoken;
});

test("a click while the line is being written finishes it, and the next advances", async () => {
  const { box, element, text } = inFakeDom(() => typingBox(30));

  const spoken = box.line("艾拉", "这句话很长，需要写一会儿。");
  assert.equal(box.isTyping(), true);

  // The first click is a request to see the line, not to skip it.
  element.dispatch("click");
  assert.equal(text.textContent, "这句话很长，需要写一会儿。");
  assert.equal(box.isTyping(), false);
  assert.equal(box.isWaiting(), true, "the line is still up");

  // The second click is what advances.
  element.dispatch("click");
  await spoken;
  assert.equal(box.isWaiting(), false);
});

test("clearing the stage drops a reveal rather than finishing it", async () => {
  const { box, text } = inFakeDom(() => typingBox(30));

  box.line("艾拉", "这句话很长，需要写一会儿。");
  assert.equal(box.isTyping(), true);

  box.clear();
  assert.equal(box.isTyping(), false);
  assert.equal(text.textContent, "", "the box was emptied, not filled in");
});

test("a style file places the plate and the line as percentages of the frame", () => {
  const { box, speaker, stamp, text } = inFakeDom(() => dialogueBox());

  box.setStyle({
    speaker: { x: 0, y: 0, width: 960, height: 108, font: { size: 54, color: "#ff0000" } },
    text: { x: 0, y: 540, width: 960, height: 540 },
  });

  assert.deepEqual([speaker.style.left, speaker.style.top], ["0%", "0%"]);
  assert.deepEqual([speaker.style.width, speaker.style.height], ["50%", "10%"]);
  assert.equal(speaker.style.fontSize, "54px");
  assert.equal(speaker.style.color, "#ff0000");
  assert.deepEqual([text.style.left, text.style.top], ["0%", "50%"]);
  assert.deepEqual([text.style.width, text.style.height], ["50%", "50%"]);
  // What the file does not name keeps the default it merged over.
  assert.equal(text.style.color, "#f2f2f2");
  // A style with no stamp to show leaves the bitmap off the layer entirely.
  assert.equal(stamp.hidden, true);
});

test("a line is drawn on the dialogue layer, and clearing the stage takes it down", async () => {
  const { stage, dialogue, spoken } = inFakeDom(() => {
    const { stage, dialogue } = domStage();
    return { stage, dialogue, spoken: stage.sayLine(null, "夜深了。") };
  });

  // The plate and the line are the layer's own children, so a line lands over
  // both images without the script ever naming the layer. The first child is
  // the stand-in bar, then the baked plate, the name plate and the line.
  assert.equal(dialogue.childNodes[3].textContent, "夜深了。");

  // Clearing lets go of a run parked on the line, rather than leaving it
  // hanging with nothing left to click.
  stage.clear();
  await spoken;
  assert.equal(dialogue.childNodes[1].hidden, true);
  assert.equal(dialogue.childNodes[2].textContent, "");
});

test("Space and Enter advance a line, the way a click does", async () => {
  const { stage, element, spoken } = inFakeDom(() => {
    const made = domStage();
    return { ...made, spoken: made.stage.sayLine(null, "夜深了。") };
  });

  // The stage hears the two keys a visual novel accepts; they go through the
  // same settle a click does, so the two cannot disagree.
  element.dispatch("keydown", { key: " ", preventDefault() {} });
  await spoken;

  // A key with no line up is a no-op rather than an error.
  element.dispatch("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(stage.isTyping(), false);
});

test("a key that is not Space or Enter leaves the line alone", async () => {
  const { stage, element } = inFakeDom(() => {
    const made = domStage();
    made.stage.sayLine(null, "夜深了。");
    return made;
  });

  element.dispatch("keydown", { key: "a", preventDefault() {} });
  assert.equal(stage.isTyping(), false);
  stage.clear();
});

// --- use: switch dialogue style at runtime ---

test("use hands the evaluated style path to the host", async () => {
  const calls = [];
  const result = await run('use "templates/voice.dialog.json"', {
    useStyle: (path) => {
      calls.push(path);
      return Promise.resolve();
    },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, ["templates/voice.dialog.json"]);
});

test("use evaluates its path like any expression", async () => {
  const calls = [];
  const result = await run('name = "voice"\nuse "templates/" + name + ".dialog.json"', {
    useStyle: (path) => calls.push(path),
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, ["templates/voice.dialog.json"]);
});

test("use with no host support is reported", async () => {
  const result = await run('use "templates/voice.dialog.json"');
  assert.match(result.error.message, /不支持切换对话样式/);
});

test("use with a non-string target is a runtime error", async () => {
  const result = await run("use 3", { useStyle: () => {} });
  assert.match(result.error.message, /非空的样式文件路径/);
});

test("use with an empty path is rejected", async () => {
  const result = await run('use ""', { useStyle: () => {} });
  assert.match(result.error.message, /非空的样式文件路径/);
});

test("use with no path expression is a syntax error", async () => {
  const result = await run("use\n", { useStyle: () => {} });
  assert.ok(result.error, "expected a parse error: use with no expression");
});

// --- the free transform ---

test("a Character's transform is a namespace of points, not the old writer", () => {
  const objects = createStageObjects(fakeStage());
  const character = objects.Character(["hero.png"]);
  const background = objects.Background(["bg.png"]);

  // `transform` used to be the closure that wrote the image's turn and size.
  // A member chain can only reach a string-named field, so putting that writer
  // on a symbol is what frees the name for the script API.
  assert.equal(typeof character.transform, "object");
  assert.deepEqual(
    Object.keys(character.transform).sort(),
    [
      "down",
      "downTo",
      "downleft",
      "downleftTo",
      "downright",
      "downrightTo",
      "left",
      "leftTo",
      "right",
      "rightTo",
      "up",
      "upTo",
      "upleft",
      "upleftTo",
      "upright",
      "uprightTo",
    ],
  );
  // The backdrop fills the frame and is never pulled about; it has no box.
  assert.equal(background.transform, undefined);
});

test("a point of the box is sent to a place, or moved from where it is", async () => {
  const stage = fakeStage();
  const result = await run(
    'hero = Character("hero.png")\nhero.enable()\nhero.transform.upleftTo(-300, 200, 500)',
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(stage.boxes, [
    { slot: "hero", mode: "to", handle: "upleft", x: -300, y: 200, time: 500 },
  ]);

  const moved = fakeStage();
  await run('hero = Character("hero.png")\nhero.enable()\nhero.transform.down(0, -80)', {
    constructors: createStageObjects(moved),
  });
  assert.deepEqual(moved.boxes, [
    { slot: "hero", mode: "by", handle: "down", dx: 0, dy: -80, time: 0 },
  ]);
});

test("a free transform answers the character, so the calls chain", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      'hero = Character("hero.png")',
      "hero.enable()",
      "hero.transform.upleft(1, 2).transform.upTo(3, 4).transform.right(5, 6)",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(
    stage.boxes.map(({ mode, handle }) => [mode, handle]),
    [
      ["by", "upleft"],
      ["to", "up"],
      ["by", "right"],
    ],
  );
});

test("a free transform with a bad coordinate or time is a script error", async () => {
  const objects = createStageObjects(fakeStage());
  const bad = await run('hero = Character("hero.png")\nhero.transform.upleftTo("left", 0)', {
    constructors: objects,
  });
  const slow = await run(
    'hero = Character("hero.png")\nhero.transform.upleftTo(0, 0, -1)',
    { constructors: objects },
  );

  assert.match(bad.error.message, /坐标需要数字/);
  assert.match(slow.error.message, /时间需要非负/);
});

/** A character on the fake stage, its eight points settled from a `w`×`h` bitmap. */
async function characterWithBox(w, h) {
  const { stage, character } = inFakeDom(() => {
    const made = domStage();
    made.stage.setCharacter("hero", "hero.png");
    return made;
  });

  // The bitmap's size is only known once it has decoded, which the fake DOM
  // does on the next turn — so the size is set before the load gets there.
  const [image, mesh] = character.childNodes;
  image.naturalWidth = w;
  image.naturalHeight = h;
  await tick();
  return { stage, image, mesh };
}

/** Which of the eight points differ between two readings of them. */
function movedPoints(before, after) {
  return Object.keys(before).filter(
    (handle) => before[handle].x !== after[handle].x || before[handle].y !== after[handle].y,
  );
}

/** A stage point, compared loosely enough for a turn's trigonometry. */
function nearPoint(at, x, y) {
  assert.ok(Math.abs(at.x - x) < 1e-6, `x: ${at.x} ≈ ${x}`);
  assert.ok(Math.abs(at.y - y) < 1e-6, `y: ${at.y} ≈ ${y}`);
}

test("a character's eight points start as the rectangle of its own bitmap", async () => {
  const { stage } = await characterWithBox(1000, 1000);

  // A square picture is scaled to the frame's height and centred: the shape is
  // the picture, not the frame it was fitted into.
  const points = stage.characterPoints("hero");
  assert.deepEqual(points.upleft, { x: -540, y: 540 });
  assert.deepEqual(points.upright, { x: 540, y: 540 });
  assert.deepEqual(points.downright, { x: 540, y: -540 });
  assert.deepEqual(points.downleft, { x: -540, y: -540 });
  // The edge midpoints sit on the sides, halfway along them.
  assert.deepEqual(points.up, { x: 0, y: 540 });
  assert.deepEqual(points.right, { x: 540, y: 0 });
});

test("a corner sent to a point leaves the other seven where they were", async () => {
  const { stage, image, mesh } = await characterWithBox(960, 540);
  // A picture the frame's own shape fills it: the shape starts as the frame.
  const before = stage.characterPoints("hero");
  assert.deepEqual(before.upleft, { x: -960, y: 540 });
  assert.equal(mesh.style.display, "none", "nothing has been pulled on yet");

  stage.transformCharacterPoint("hero", "upleft", 0, 540, 0);

  const after = stage.characterPoints("hero");
  assert.deepEqual(after.upleft, { x: 0, y: 540 }, "the corner went where it was sent");
  assert.deepEqual(movedPoints(before, after), ["upleft"], "and nothing else moved");

  // Pulling on a point is a different way of drawing, so the plain image
  // leaves the drawing and the mesh takes its place.
  assert.equal(image.style.display, "none");
  assert.equal(mesh.style.display, "");
});

test("an edge midpoint is free to leave the line between its corners", async () => {
  const { stage } = await characterWithBox(960, 540);
  const before = stage.characterPoints("hero");

  // Both coordinates count now: an edge midpoint is a point in its own right
  // rather than a side of a box, so a pull may take it anywhere — which is
  // what makes a slanted edge, or a curve, something a script can ask for.
  stage.moveCharacterPoint("hero", "left", 960, 9999, 0);

  const after = stage.characterPoints("hero");
  assert.deepEqual(after.left, { x: 0, y: 9999 });
  assert.deepEqual(movedPoints(before, after), ["left"]);
});

test("a pulled character is drawn as eight triangles of its own picture", async () => {
  const { stage, image, mesh } = await characterWithBox(960, 540);
  assert.equal(mesh.style.display, "none", "the plain image is what draws it so far");

  stage.transformCharacterPoint("hero", "upleft", 0, 540, 0);

  // Four quarters of the picture, each cut along its own diagonal: eight
  // pieces, every one of them clipped to a triangle and every one of them
  // showing the same bitmap through its own map.
  assert.equal(mesh.childNodes.length, 8);
  for (const piece of mesh.childNodes) {
    assert.match(piece.style.clipPath, /^polygon\(/);
    assert.match(piece.childNodes[0].style.transform, /^matrix\(/);
    assert.equal(piece.childNodes[0].src, image.src);
  }
});

test("a timed pull walks the eight points, and waits the time out", async () => {
  const { stage } = await characterWithBox(960, 540);

  const running = stage.transformCharacterPoint("hero", "upleft", 0, 540, 60);

  // A mesh has no CSS transition to run the change, so the next frame is what
  // draws it — nothing has moved yet.
  assert.ok(running instanceof Promise);
  assert.deepEqual(stage.characterPoints("hero").upleft, { x: -960, y: 540 });

  await running;
  // The promise is the duration; the last frame is the one after it.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(stage.characterPoints("hero").upleft, { x: 0, y: 540 });
});

test("a transform asked for before the bitmap lands waits for the box", async () => {
  const { stage, character } = inFakeDom(() => {
    const made = domStage();
    made.stage.setCharacter("hero", "hero.png");
    return made;
  });
  const image = character.childNodes[0];

  // Nothing is known about the picture yet, so there is no shape to pull on —
  // and measuring against the frame would be wrong, since the picture is a
  // different shape. The call still answers a promise, so the interpreter
  // waits for the replay instead of moving on.
  const waiting = stage.transformCharacterPoint("hero", "upleft", 0, 540, 0);
  assert.ok(waiting instanceof Promise, "the held transform is awaitable");
  assert.equal(stage.characterPoints("hero"), null);

  image.naturalWidth = 960;
  image.naturalHeight = 540;
  await tick();
  await waiting;

  // The call is replayed against the eight points the decode has just settled.
  assert.deepEqual(stage.characterPoints("hero").upleft, { x: 0, y: 540 });
});

test("a scale before the first pull is inherited, not rewound", async () => {
  const { stage, image } = await characterWithBox(960, 540);
  stage.transformCharacter("hero", 0, 2, 0);
  assert.equal(image.style.transform, "translate(-50%, -50%) rotate(0deg) scale(2)");

  // The mesh has to start from the rectangle the scaled picture is drawing,
  // not from the eight points settled when the bitmap decoded.
  const before = stage.characterPoints("hero");
  assert.deepEqual(before.upleft, { x: -1920, y: 1080 });

  stage.transformCharacterPoint("hero", "upleft", 0, 1080, 0);

  const after = stage.characterPoints("hero");
  assert.deepEqual(after.upleft, { x: 0, y: 1080 }, "the corner went where it was sent");
  assert.deepEqual(after.downright, { x: 1920, y: -1080 }, "the far corner kept the scale");
  assert.deepEqual(movedPoints(before, after), ["upleft"], "and nothing else moved");
});

test("a mesh turns clockwise for a positive angle and back for a negative one", async () => {
  // Deforming pulls the picture into a mesh, after which a turn runs through
  // `turnedPoints` rather than the plain image's CSS transform — the two must
  // agree on which way is clockwise.
  const clockwise = await characterWithBox(960, 540);
  clockwise.stage.transformCharacterPoint("hero", "upleft", 0, 540, 0);
  clockwise.stage.transformCharacter("hero", 90, 1, 0);
  // The right edge swings down: (960, 0) turned +90° clockwise about the
  // centroid of the four corners (240, 0) lands at (240, -720).
  nearPoint(clockwise.stage.characterPoints("hero").right, 240, -720);

  const back = await characterWithBox(960, 540);
  back.stage.transformCharacterPoint("hero", "upleft", 0, 540, 0);
  back.stage.transformCharacter("hero", -90, 1, 0);
  // The same edge swings up instead — the negative turn goes the other way.
  nearPoint(back.stage.characterPoints("hero").right, 240, 720);
});

test("a relative pull after a scale counts from the scaled point", async () => {
  const { stage } = await characterWithBox(960, 540);
  stage.transformCharacter("hero", 0, 2, 0);

  stage.moveCharacterPoint("hero", "upleft", 100, -80, 0);

  // -1920 + 100 and 1080 - 80, not the unscaled -960 + 100 and 540 - 80.
  assert.deepEqual(stage.characterPoints("hero").upleft, { x: -1820, y: 1000 });
});

test("a cue starts every point pull, not only the last one", async () => {
  const stage = fakeStage();
  const result = await run(
    [
      'ch = Character("hero.png")',
      "cue {",
      "  ch.transform.upright(300, 300, 1000)",
      "  ch.transform.upleft(-300, 300, 1000)",
      "  ch.transform.up(0, 300, 1000)",
      "  ch.transform.downleft(100, 0, 1000)",
      "  ch.transform.downright(-100, 0, 1000)",
      "}",
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.deepEqual(
    stage.boxes.map(({ handle }) => handle),
    ["upright", "upleft", "up", "downleft", "downright"],
  );
  assert.ok(
    stage.boxes.every(({ mode, time }) => mode === "by" && time === 1000),
  );
  assert.equal(new Set(stage.boxes.map(({ slot }) => slot)).size, 1, "all five pull one character");
});

test("point pulls started together each reach their own target", async () => {
  const { stage } = await characterWithBox(960, 540);
  const before = stage.characterPoints("hero");
  // These are the five calls a `cue` makes in one tick. Each used to replace
  // the whole point set on every frame, so only the last one survived.
  const pulls = [
    ["upright", 300, 300],
    ["upleft", -300, 300],
    ["up", 0, 300],
    ["downleft", 100, 0],
    ["downright", -100, 0],
  ];
  const running = pulls.map(([handle, dx, dy]) =>
    stage.moveCharacterPoint("hero", handle, dx, dy, 40),
  );
  await Promise.all(running);
  // The last frame is drawn just after the duration's promise (see the timed
  // pull test above).
  await new Promise((resolve) => setTimeout(resolve, 40));

  const after = stage.characterPoints("hero");
  for (const [handle, dx, dy] of pulls) {
    nearPoint(after[handle], before[handle].x + dx, before[handle].y + dy);
  }
  assert.equal(movedPoints(before, after).length, 5, "five pulls landed, not just the last one");
});

test("a move and a turn before the first pull are inherited too", async () => {
  const { stage } = await characterWithBox(960, 540);
  stage.moveCharacter("hero", 100, 50, undefined, 0);
  stage.transformCharacter("hero", 90, 1, 0);

  const before = stage.characterPoints("hero");
  nearPoint(before.upleft, 640, 1010);
  nearPoint(before.downright, -440, -910);

  stage.transformCharacterPoint("hero", "upleft", 640, 500, 0);

  const after = stage.characterPoints("hero");
  assert.deepEqual(after.upleft, { x: 640, y: 500 });
  nearPoint(after.downright, -440, -910);
});

test("the mesh is painted from the current pose before a timed pull starts", async () => {
  const { stage, mesh } = await characterWithBox(960, 540);
  stage.transformCharacter("hero", 0, 2, 0);

  const running = stage.transformCharacterPoint("hero", "upleft", 0, 1080, 60);
  assert.ok(running instanceof Promise);

  // The first animation frame has not run yet. An unpainted mesh would show
  // eight full-frame copies of the unscaled picture until it does.
  for (const piece of mesh.childNodes) {
    assert.match(piece.style.clipPath, /^polygon\(/);
    assert.match(piece.childNodes[0].style.transform, /^matrix\(/);
  }

  await running;
  await new Promise((resolve) => setTimeout(resolve, 40));
});

test("a scale and a pull written before the bitmap lands keep the scale", async () => {
  const { stage, character } = inFakeDom(() => {
    const made = domStage();
    made.stage.setCharacter("hero", "hero.png");
    return made;
  });
  const image = character.childNodes[0];

  // A script writes these on consecutive lines, long before the decode that
  // settles the box; the pull is held until then and replayed in order.
  stage.transformCharacter("hero", 0, 2, 0);
  const waiting = stage.transformCharacterPoint("hero", "upleft", 0, 1080, 0);
  assert.ok(waiting instanceof Promise, "the held transform is awaitable");

  image.naturalWidth = 960;
  image.naturalHeight = 540;
  await tick();
  await waiting;

  const points = stage.characterPoints("hero");
  assert.deepEqual(points.upleft, { x: 0, y: 1080 });
  assert.deepEqual(points.downright, { x: 1920, y: -1080 }, "the box started out scaled");
});

test("a key frame's stretch of one axis is inherited by the first pull", async () => {
  const { stage } = await characterWithBox(960, 540);
  stage.applyPreviewState("hero", { scale: 1, scaleX: 1.5, scaleY: 1 });

  stage.transformCharacterPoint("hero", "upleft", 0, 540, 0);

  assert.deepEqual(stage.characterPoints("hero").downright, { x: 1440, y: -540 });
});

// --- state carried across a rebuild, and reset between runs ---

test("rebuilding a variable keeps where the character was standing", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    const objects = createStageObjects(stage);

    const hero = objects.Character(["happy.png"], { pending: [], assignee: "hero" });
    hero.moveTo(300, -100);
    hero.rotateTo(15);
    hero.scaleTo(1.2);
    hero.enable();
    // The image is created by `enable()`, so it is read after it.
    const image = character.childNodes[0];
    const placed = [image.style.left, image.style.top, image.style.transform];

    // The ordinary way a script changes an expression: rebuild the variable.
    const rebuilt = objects.Character(["angry.png"], { pending: [], assignee: "hero" });
    rebuilt.enable();

    assert.equal(character.childNodes.length, 2, "one image and its mesh, no second character");
    assert.deepEqual(
      [image.style.left, image.style.top, image.style.transform],
      placed,
      "the rebuilt character carries on from where the slot was",
    );
  });
});

test("a slot nothing has been drawn in starts a character at the origin", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    const objects = createStageObjects(stage);

    const hero = objects.Character(["hero.png"], { pending: [], assignee: "fresh" });
    assert.equal(hero.px, 0);
    assert.equal(hero.py, 0);
    assert.equal(hero.rotation, 0);
    assert.equal(hero.size, 1);
  });
});

test("rebuilding a variable keeps the name the character speaks under", async () => {
  const stage = fakeStage();
  // The rebuilt character is a new object, so the name has to survive on the
  // slot rather than in the object's closure. This is the path a script takes.
  const running = run(
    [
      'hero = Character("happy.png")',
      'hero.name("小明")',
      'hero.say("第一句")',
      'hero = Character("sad.png")',
      'hero.say("第二句")',
    ].join("\n"),
    { constructors: createStageObjects(stage) },
  );

  await tick();
  stage.lines[0].settle();
  await tick();

  assert.deepEqual(
    stage.lines.map(({ name, text }) => [name, text]),
    [
      ["小明", "第一句"],
      ["小明", "第二句"],
    ],
  );
  stage.lines[1].settle();
  assert.equal((await running).error, undefined);
});

test("a new run starts the dialogue box visible again", () => {
  inFakeDom(() => {
    const { stage, dialogue } = domStage();

    // A script hides the box with `dialog.disable()` and the run is abandoned.
    stage.setVisible(false);
    assert.equal(dialogue.hidden, true);

    // Clearing is what a new run begins with. Leaving the layer hidden would
    // draw every line of the next script outside the visible stage.
    stage.reset("next scene");
    assert.equal(dialogue.hidden, false);
  });
});

test("stopping a run answers the line it is parked on", async () => {
  const stage = fakeStage();
  // The stage's own stop, wired to the fake's `settle` calls.
  stage.stop = () => {
    for (const line of stage.lines) {
      line.settle?.();
    }
  };

  let runCount = 0;
  const token = (runCount += 1);
  const running = run('say("一")\nsay("二")\nsay("三")', {
    constructors: createStageObjects(stage),
    globals: createStageGlobals(stage),
    stopped: () => token !== runCount,
  });

  await tick();
  assert.deepEqual(
    stage.lines.map((line) => line.text),
    ["一"],
    "the run is parked on the first line",
  );

  // What `stopRun()` does: the run is no longer the current one, and the stage
  // answers whatever it was waiting on.
  runCount += 1;
  stage.stop();

  const result = await running;
  assert.equal(result.stopped, true, "the run gives up rather than hanging");
  assert.deepEqual(
    stage.lines.map((line) => line.text),
    ["一"],
    "no further line was read",
  );
});

test("clearing the stage drops the tint filters it painted", () => {
  inFakeDom(() => {
    const root = fakeElement();
    const stage = createStage({
      element: root,
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    });

    // The `<svg>` holding the filters is built lazily, on the first tint. It is
    // told apart from the countdown ring — the other `<svg>` the box may put on
    // the stage — by the `aria-hidden` marker only the filter holder carries.
    const tintSvg = () => root.childNodes.find((child) => child["aria-hidden"] === "true");
    assert.equal(tintSvg(), undefined, "no filter is built before one is asked for");

    for (let round = 0; round < 3; round += 1) {
      stage.setCharacter("hero", `h${round}.png`);
      stage.applyTint("hero", 10, 10, 10, 0);
      stage.clear();
    }

    const defs = tintSvg().childNodes[0];
    assert.equal(defs.childNodes.length, 0, "every filter went with the picture it painted");
  });
});

test("clearing the stage forgets the backdrop's tint", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();

    stage.setBackground("night.png");
    stage.applyTint("background", 51, 51, 102, 0);
    stage.clear();

    // The next run's picture is not the one the colour was chosen for, so a
    // remembered tint would be laid over it.
    stage.setBackground("day.png");
    assert.equal(background.childNodes[0].style.filter, undefined);
  });
});

// --- fading, dissolving and layer order ---

test("alpha fades a picture, and hide and show are the two ends of it", () => {
  inFakeDom(() => {
    const { stage, character, background } = domStage();

    stage.setCharacter("hero", "hero.png");
    const image = character.childNodes[0];
    // A fresh picture is solid: no inline style at all, so the stylesheet owns it.
    assert.equal(image.style.opacity, "");

    stage.setCharacterAlpha("hero", 0.4, 0);
    assert.equal(image.style.opacity, "0.4");

    stage.setCharacterAlpha("hero", 0, 0);
    assert.equal(image.style.opacity, "0", "hidden is opacity 0, not removal");

    stage.setCharacterAlpha("hero", 1, 0);
    assert.equal(image.style.opacity, "", "solid again is no inline style");

    stage.setBackground("bg.png");
    stage.setBackgroundAlpha(0.25, 0);
    assert.equal(background.childNodes[0].style.opacity, "0.25");
  });
});

test("a fade is clamped rather than refused, like a volume", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    stage.setCharacter("hero", "hero.png");
    const image = character.childNodes[0];

    stage.setCharacterAlpha("hero", 1.4, 0);
    assert.equal(image.style.opacity, "");
    stage.setCharacterAlpha("hero", -0.2, 0);
    assert.equal(image.style.opacity, "0");
  });
});

test("a fade over time gets its own transition, and does not cut a move short", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    stage.setCharacter("hero", "hero.png");
    stage.moveCharacter("hero", 100, 0, undefined, 400);

    const image = character.childNodes[0];
    stage.setCharacterAlpha("hero", 0.5, 200);

    // The move's timeline is kept, and the fade is added beside it.
    assert.equal(
      image.style.transition,
      "left 400ms linear, top 400ms linear, opacity 200ms linear",
    );
    // Reading layout between the transition and the value is what gives the
    // browser somewhere to animate from.
    assert.deepEqual(image.log.slice(-3), ["style.transition", "layout", "style.opacity"]);
  });
});

test("a fade on a picture that was never moved still gets a transition", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    stage.setCharacter("hero", "hero.png");
    // `enable()` draws the picture, which leaves `transition: none` behind. The
    // fade used to append to that string and produce `none, opacity 3000ms
    // linear` — an invalid declaration the browser drops whole, so the picture
    // waited out the duration and then jumped. The element's transition has to
    // be replaced, not extended.
    stage.moveCharacter("hero", 0, 0, 0);
    const image = character.childNodes[0];
    assert.equal(image.style.transition, "none");

    stage.setCharacterAlpha("hero", 0, 3000);
    assert.equal(image.style.transition, "opacity 3000ms linear");
    assert.equal(image.style.opacity, "0");
  });
});

test("a fade keeps a move that is still running, and a move keeps a fade", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    stage.setCharacter("hero", "hero.png");
    const image = character.childNodes[0];

    stage.setCharacterAlpha("hero", 0.5, 2000);
    assert.equal(image.style.transition, "opacity 2000ms linear");

    // A move after the fade must not cut the fade short...
    stage.moveCharacter("hero", 100, 0, undefined, 400);
    assert.equal(
      image.style.transition,
      "left 400ms linear, top 400ms linear, opacity 2000ms linear",
    );

    // ...and a fade after the move must not cut the move short.
    stage.setCharacterAlpha("hero", 0.2, 100);
    assert.equal(
      image.style.transition,
      "left 400ms linear, top 400ms linear, opacity 100ms linear",
    );
  });
});

test("a jump clears only its own transition and leaves a fade alone", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    stage.setCharacter("hero", "hero.png");
    const image = character.childNodes[0];

    stage.setCharacterAlpha("hero", 0, 1500);
    stage.moveCharacter("hero", 100, 0, undefined, 400);
    // The move lands at once, but the fade is still running.
    stage.moveCharacter("hero", 0, 0, 0);
    assert.equal(image.style.transition, "opacity 1500ms linear");
  });
});

test("a second fade replaces the first rather than listing opacity twice", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();
    stage.setCharacter("hero", "hero.png");
    const image = character.childNodes[0];

    stage.setCharacterAlpha("hero", 0.5, 200);
    stage.setCharacterAlpha("hero", 0.2, 100);

    assert.equal(image.style.transition, "opacity 100ms linear");
  });
});

test("the script's alpha calls reach the stage, and survive a rebuild", async () => {
  const stage = fakeStage();
  const objects = createStageObjects(stage);
  const context = { pending: [], assignee: "hero" };

  const hero = objects.Character(["happy.png"], context);
  hero.enable();
  hero.alpha(0.3, 250);
  hero.hide(100);
  hero.show(100);

  assert.deepEqual(stage.fades, [
    { target: "hero", value: 1, time: 0 },
    { target: "hero", value: 0.3, time: 250 },
    { target: "hero", value: 0, time: 100 },
    { target: "hero", value: 1, time: 100 },
  ]);

  // A character faded out stays faded out when its expression is changed: the
  // swap must not bring back a character the scene had hidden.
  hero.alpha(0);
  const rebuilt = objects.Character(["sad.png"], context);
  rebuilt.enable();
  assert.equal(stage.fades.at(-1).value, 0, "the rebuilt character keeps the opacity");
});

test("an alpha that is not a number is reported", () => {
  const objects = createStageObjects(fakeStage());
  const hero = objects.Character(["hero.png"], { pending: [] });
  assert.throws(() => hero.alpha("half"), /透明度需要 0–1 的数字/);
});

test("a character can be brought forward and sent back", () => {
  inFakeDom(() => {
    const { stage, character } = domStage();

    stage.setCharacter("hero", "hero.png");
    const hero = character.childNodes[0];
    stage.setCharacter("rival", "rival.png");
    const rival = character.childNodes[2];

    const where = (node) => character.childNodes.indexOf(node);
    assert.ok(where(hero) < where(rival), "enabled order is drawing order");

    stage.raiseCharacter("hero");
    assert.ok(where(hero) > where(rival), "the raised character is drawn last");

    stage.lowerCharacter("hero");
    assert.ok(where(hero) < where(rival), "and sent back to the bottom");
  });
});

test("raising a slot that is not on the stage is ignored", () => {
  inFakeDom(() => {
    const { stage } = domStage();
    stage.raiseCharacter("ghost");
    stage.lowerCharacter("ghost");
  });
});

test("a backdrop dissolves into the next, and the old picture is dropped", async () => {
  // The stage is built inside the fake document, and every call that creates a
  // picture has to be made while it is still in place — a dissolve creates one
  // after an await.
  await inFakeDomAsync(async () => {
    const { stage, background } = domStage();

    stage.setBackground("day.png");
    await tick();
    const outgoing = background.childNodes[0];
    assert.equal(background.childNodes.length, 1);

    const fading = stage.crossFadeBackground("night.png", 30);
    assert.equal(background.childNodes.length, 2, "both pictures are up during the fade");
    // The incoming picture fades up while the outgoing fades down. A fully
    // opaque element carries no inline style at all, which is how `paintAlpha`
    // leaves it; the outgoing one is written down to 0.
    const incoming = background.childNodes[1];
    const outgoingPicture = background.childNodes[0];
    assert.equal(incoming.style.opacity, "", "the new picture ends solid");
    assert.equal(outgoingPicture.style.opacity, "0", "the old one ends transparent");
    assert.match(incoming.style.transition, /opacity 30ms/);
    assert.match(outgoingPicture.style.transition, /opacity 30ms/);

    await fading;
    assert.equal(background.childNodes.length, 1, "the old one is dropped afterwards");
    assert.notEqual(background.childNodes[0], outgoing);
  });
});

test("a dissolve with no duration is a plain cut", () => {
  inFakeDom(() => {
    const { stage, background } = domStage();
    stage.setBackground("day.png");
    assert.equal(stage.crossFadeBackground("night.png", 0), undefined);
    assert.equal(background.childNodes.length, 1);
  });
});

test("the script's crossFade moves the background object onto the new picture", () => {
  const stage = fakeStage();
  const objects = createStageObjects(stage);
  const bg = objects.Background(["day.png"], { pending: [] });

  bg.crossFade("night.png", 800);

  assert.deepEqual(stage.crossFades, [{ path: "night.png", time: 800 }]);
  assert.equal(bg.path, "night.png", "a later enable() re-shows the picture on screen");
});

test("a style with no plate gets a stand-in bar, so the line is not bare", () => {
  const { box, fallback, speaker, text } = inFakeDom(() => dialogueBox());

  // The built-in defaults name no plate, which is the state every new project
  // starts in: without the bar a `say` is text floating over the scene.
  box.sample(null, "夜深了。");
  assert.equal(fallback.hidden, false);
  // The bar covers the line's box, written as percentages of the frame.
  assert.ok(fallback.style.width, "the bar is laid out over the text block");
  assert.ok(fallback.style.height, "the bar is laid out over the text block");
  // A narrator's line has no name plate, so the bar covers the line alone.
  assert.equal(speaker.hidden, true);
  assert.equal(text.textContent, "夜深了。");
});

test("a style that names a plate hides the stand-in bar", () => {
  const { box, fallback } = inFakeDom(() => dialogueBox());

  // A plate is what the style asked for, and the bar is only for a style that
  // named none: showing both would draw two boxes on top of each other.
  box.setStyle({
    stamp: { path: "assets/templates/default.png" },
    speaker: { x: 0, y: 0, width: 100, height: 50 },
    text: { x: 0, y: 60, width: 100, height: 50 },
  });
  assert.equal(fallback.hidden, true);
});

test("the designer's preview never adds a stand-in bar over its own plate", () => {
  const { box, fallback } = inFakeDom(() => {
    const element = fakeElement();
    const node = fakeElement();
    const box = createDialogue({
      element,
      node,
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      suppressFallback: true,
    });
    return { box, fallback: node.childNodes[0] };
  });

  box.sample("示例姓名", "示例文本：这一行用来预览字体样式。");
  assert.equal(fallback.hidden, true, "the designer paints its own plate underneath");
});

test("a style with layers draws its own plate, without any baked PNG", () => {
  const { box, node } = inFakeDom(() => dialogueBox());
  const [fallback, stamp, , , plateCanvas] = node.childNodes;

  box.setStyle({
    styles: {
      dialog: {
        layers: [
          {
            id: "l1", type: "rect", visible: true, opacity: 0.55,
            x: 140, y: 800, width: 1640, height: 240, fill: "#101018", radius: 24,
          },
        ],
        speaker: { x: 196, y: 756, width: 360, height: 64 },
        text: { x: 196, y: 872, width: 1520, height: 144 },
      },
    },
  });

  assert.equal(plateCanvas.hidden, false, "the runtime paints the layers itself");
  assert.equal(stamp.hidden, true, "no baked PNG is pasted over the live plate");
  assert.equal(fallback.hidden, true, "and the stand-in bar is not needed");
});

test("a slot with no visible layers still uses its stamped PNG", () => {
  const { box, node } = inFakeDom(() => dialogueBox());
  const [, , , , plateCanvas] = node.childNodes;

  box.setStyle({
    stamp: { path: "assets/templates/default.png" },
    layers: [{ id: "l1", type: "rect", visible: false }],
    speaker: { x: 0, y: 0, width: 100, height: 50 },
    text: { x: 0, y: 60, width: 100, height: 50 },
  });

  assert.equal(plateCanvas.hidden, true, "an older style keeps the PNG path");
});

test("a plate that will not load falls back to the stand-in bar", () => {
  const { box, fallback } = inFakeDom(() => {
    const element = fakeElement();
    const node = fakeElement();
    const errors = [];
    const box = createDialogue({
      element,
      node,
      // Every plate read fails, the way a deleted PNG does.
      resolveAsset: () => Promise.reject(new Error("找不到图片")),
      onError: (message) => errors.push(message),
    });
    return { box, fallback: node.childNodes[0], errors };
  });

  box.setStyle({
    stamp: { path: "assets/templates/gone.png" },
    speaker: { x: 0, y: 0, width: 100, height: 50 },
    text: { x: 0, y: 60, width: 100, height: 50 },
  });
  // The read is asynchronous — resolve, then reject, then the catch — so the
  // test waits a turn rather than a microtask.
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    // By the time it has failed the line is still on the stage and still needs
    // something behind it.
    assert.equal(fallback.hidden, false);
  });
});

// --- 对象组 Array ---

/** A stage whose pictures record the batch calls made on them. */
function groupStage() {
  const log = [];
  const constructors = {
    Character: (args) => bulkActor("Character", args[0], log),
    Background: (args) => bulkActor("Background", args[0], log),
  };
  return { log, constructors, globals: { stage: { kind: "Stage" } } };
}

test("Array 把多个对象合成一组，舞台批量调用只需指向组", async () => {
  const { log, constructors, globals } = groupStage();

  const result = await run(
    [
      'ch1 = Character("ch1")',
      'ch2 = Character("ch2")',
      'bg1 = Background("bg1")',
      "ay1 = Array(ch1, ch2, bg1)",
      "stage.scale(2.0 : ay1)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  // The group is opened in the order its members were added, which is the order
  // the three names written out by hand would have run in.
  assert.deepEqual(log, [
    ["ch1", "scale", 2, undefined],
    ["ch2", "scale", 2, undefined],
    ["bg1", "scale", 2, undefined],
  ]);
});

test("组站在对象的位置上：组当接收者与不带冒号都分给每个成员", async () => {
  const { log, constructors, globals } = groupStage();

  const result = await run(
    [
      'ch1 = Character("ch1")',
      'ch2 = Character("ch2")',
      "ay1 = Array(ch1, ch2)",
      "ay1.hide(300)",
      "stage.show(ay1)",
      "stage.enable(ch1, ay1)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [
    ["ch1", "hide", 300],
    ["ch2", "hide", 300],
    ["ch1", "show", undefined],
    ["ch2", "show", undefined],
    // A loose object and a group in one call: the members follow the object as
    // if both had been written out.
    ["ch1", "enable"],
    ["ch1", "enable"],
    ["ch2", "enable"],
  ]);
});

test("add 与 del 改的是成员，重复加入不会执行两次", async () => {
  const { log, constructors, globals } = groupStage();

  const result = await run(
    [
      'ch1 = Character("ch1")',
      'ch2 = Character("ch2")',
      "ay1 = Array(ch1)",
      "ay1.add(ch2, ch1)",
      "ay1.del(ch1)",
      "stage.enable(ay1)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [["ch2", "enable"]]);
});

test("remove 按序号或成员移出，update 在原位置换人", async () => {
  const { log, constructors, globals } = groupStage();

  const result = await run(
    [
      'ch1 = Character("ch1")',
      'ch2 = Character("ch2")',
      'ch3 = Character("ch3")',
      'ch4 = Character("ch4")',
      "ay1 = Array(ch1, ch2, ch3)",
      "ay1.remove(0)", // 按 0 起的序号移出 ch1
      "ay1.remove(ch3)", // 按成员移出 ch3
      "ay1.update(0, ch4)", // ch2 的位置换成 ch4
      "stage.enable(ay1)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [["ch4", "enable"]]);
});

test("remove 的序号超出范围会报错", async () => {
  const { constructors, globals } = groupStage();

  const result = await run('ch1 = Character("ch1")\nay1 = Array(ch1)\nay1.remove(2)', {
    constructors,
    globals,
  });

  assert.ok(result.error);
  assert.match(result.error.message, /超出范围/);
});

test("update 的新成员必须是对象", async () => {
  const { constructors, globals } = groupStage();

  const result = await run('ch1 = Character("ch1")\nay1 = Array(ch1)\nay1.update(0, 5)', {
    constructors,
    globals,
  });

  assert.ok(result.error);
  assert.match(result.error.message, /新成员必须是对象/);
});

test("组可以被遍历，len 是成员个数", async () => {
  const { log, constructors } = groupStage();
  const said = [];

  const result = await run(
    [
      'ch1 = Character("ch1")',
      'ch2 = Character("ch2")',
      'ch3 = Character("ch3")',
      "ay1 = Array(ch1, ch2, ch3)",
      "stage.say(str(len(ay1)))",
      "for ch in ay1 { ch.enable() }",
    ].join("\n"),
    { constructors, globals: { stage: { kind: "Stage", say: (text) => said.push(text) } } },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(said, ["3"]);
  assert.deepEqual(log, [
    ["ch1", "enable"],
    ["ch2", "enable"],
    ["ch3", "enable"],
  ]);
});

test("另一个组交给组，得到的是它的成员而不是一层嵌套", async () => {
  const { log, constructors, globals } = groupStage();

  const result = await run(
    [
      'ch1 = Character("ch1")',
      'ch2 = Character("ch2")',
      'ch3 = Character("ch3")',
      "g1 = Array(ch1, ch2)",
      "g2 = Array(g1, ch3)",
      "g2.add(g1)",
      "stage.enable(g2)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [
    ["ch1", "enable"],
    ["ch2", "enable"],
    ["ch3", "enable"],
  ]);
});

test("空组批量调用会报错，而不是悄悄什么都不做", async () => {
  const result = await run("ay1 = Array()\nstage.enable(ay1)", groupStage());

  assert.ok(result.error);
  assert.match(result.error.message, /至少一个对象/);
});

test("组里的对象不认这个方法时，报错的是那个对象", async () => {
  const { log, constructors, globals } = groupStage();
  const silent = { kind: "Background" };

  const result = await run(
    ['ch1 = Character("ch1")', "ay1 = Array(ch1, silent)", "stage.enable(ay1)"].join("\n"),
    { constructors, globals: { ...globals, silent } },
  );

  assert.ok(result.error);
  assert.match(result.error.message, /没有方法 enable/);
  // The member before it was already acted on: a batch call is the calls
  // written out by hand, and the first failure stops it where it stands.
  assert.deepEqual(log, [["ch1", "enable"]]);
});

test("组的成员必须是对象", async () => {
  const result = await run("ay1 = Array(1)");

  assert.ok(result.error);
  assert.match(result.error.message, /成员必须是对象，收到数字/);
});

test("组自己的调用不再收冒号后的对象", async () => {
  const { constructors, globals } = groupStage();

  const result = await run('ch1 = Character("ch1")\nay1 = Array(ch1)\nay1.scale(2.0 : ch1)', {
    constructors,
    globals,
  });

  assert.ok(result.error);
  assert.match(result.error.message, /冒号后面不用再写对象/);
});

test("中文写法：对象组、添加、删除", async () => {
  const { log, constructors, globals } = groupStage();

  const result = await run(
    [
      'ch1 = Character("ch1")',
      'ch2 = Character("ch2")',
      'ch3 = Character("ch3")',
      "ay1 = 对象组(ch1, ch2)",
      "ay1.添加(ch3)",
      "ay1.删除(ch1)",
      "stage.启用(ay1)",
    ].join("\n"),
    { constructors, globals },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(log, [
    ["ch2", "enable"],
    ["ch3", "enable"],
  ]);
});
