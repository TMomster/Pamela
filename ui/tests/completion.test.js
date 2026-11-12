// 编辑器候选补全测试。
// Tests for the editor's candidate suggestions.

import assert from "node:assert/strict";
import test from "node:test";

import { applyCompletion, createCompletion, suggest } from "../completion.js";

/** A stand-in element with just enough of the DOM for the suggestion list. */
function fakeElement(tag = "div") {
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    className: "",
    style: {},
    hidden: false,
    textContent: "",
    children: [],
    attributes: {},
    classes,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return on;
      },
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    append(...children) {
      node.children.push(...children);
    },
    replaceChildren(...children) {
      node.children = children;
    },
    // Laid out at nothing by default: a test that reasons about scrolling
    // gives the row and the list the sizes it wants to compare.
    offsetTop: 0,
    offsetHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 80 }),
    setSelectionRange(start, end) {
      node.selectionStart = start;
      node.selectionEnd = end;
    },
  };
  return node;
}

/** A stand-in event target, so a test can fire what a browser would fire. */
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(handler);
    },
    dispatch(type) {
      for (const handler of listeners.get(type) ?? []) {
        handler({ type });
      }
    },
  };
}

/** A stand-in textarea holding `value`, with the caret at its end by default. */
function fakeTextarea(value) {
  const node = Object.assign(fakeElement("textarea"), eventTarget());
  node.value = value;
  node.selectionStart = value.length;
  node.selectionEnd = value.length;
  node.scrollLeft = 0;
  node.scrollTop = 0;
  return node;
}

/** A stand-in keyboard event, just enough for `handleKey`. */
function keyEvent(key, extra = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
}

/** Runs `body` with the DOM pieces `createCompletion` reaches for. */
function inFakeDom(body) {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
  };

  // Elements mounted on the body are collected rather than dropped, which is
  // how a test gets hold of the popup `createCompletion` builds for itself.
  const mounted = [];
  globalThis.document = {
    ...eventTarget(),
    body: { append: (node) => mounted.push(node) },
    mounted,
    createElement: (tag) => fakeElement(tag),
  };
  globalThis.window = { innerWidth: 1200, innerHeight: 800 };
  globalThis.getComputedStyle = () => ({
    fontSize: "13px",
    lineHeight: "20.8px",
    paddingLeft: "14px",
    paddingTop: "12px",
    fontFamily: "monospace",
    fontWeight: "400",
    fontStyle: "normal",
    letterSpacing: "normal",
    tabSize: "4",
  });

  try {
    body(globalThis.document);
  } finally {
    Object.assign(globalThis, previous);
  }
}

/** Labels of the candidates offered at the end of `source`. */
function labels(source) {
  return suggest(source, source.length)?.items.map((item) => item.label) ?? [];
}

/** Labels offered at the end of a `.mpe` source. */
function shorthandLabels(source) {
  return suggest(source, source.length, { shorthand: true })?.items.map((item) => item.label) ?? [];
}

test("a bare name offers the objects a script can build", () => {
  const found = suggest("b", 1);
  // `b` starts keywords, a type and several of the calls the stage makes for a
  // list of objects, and the list is alphabetical — case does not count, so
  // `back` leads and `brightness` closes.
  assert.deepEqual(
    found.items.map((item) => item.label),
    ["back", "Background", "blur", "break", "brightness"],
  );
  // `back` is `stage.back(…)` with the receiver left out.
  assert.equal(found.items[0].kind, "method");
  assert.match(found.items[0].detail, /省略 stage/);
  assert.equal(found.items.find((item) => item.label === "Background").kind, "object");
  assert.deepEqual({ start: found.start, end: found.end }, { start: 0, end: 1 });
});

test("filtering ignores case", () => {
  assert.deepEqual(labels("char"), ["Character"]);
});

test("文字 is offered as a type a script builds", () => {
  const found = suggest("Tex", 3);
  assert.deepEqual(found.items.map((item) => item.label), ["Text"]);
  assert.equal(found.items[0].kind, "object");
});

test("a sound is offered beside the objects a script builds", () => {
  const found = suggest("Au", 2);
  // `auto` is the stage's own timer and `autoVoice` its auto-voicing switch,
  // both offered without their receiver.
  assert.deepEqual(found.items.map((item) => item.label), ["Audio", "auto", "autoVoice"]);
  assert.equal(found.items[0].kind, "object");
});

test("a sound answers a dot with its own calls", () => {
  const source = 'music = Audio("bgm.mp3")\nmusic.';
  const found = suggest(source, source.length);
  assert.deepEqual(
    found.items.map((item) => item.label),
    ["duration", "loop", "once", "play", "stop", "volume"],
  );
});

test("the words the language reserves are offered beside the objects", () => {
  const found = suggest("cu", 2);
  assert.deepEqual(found.items.map((item) => item.label), ["cue"]);
  assert.equal(found.items[0].kind, "keyword");
});

test("an empty name offers nothing, so typing alone opens no list", () => {
  assert.equal(suggest("", 0), null);
  assert.equal(suggest("bg = ", 5), null);
});

test("a dot lists the methods of the object the variable was built from", () => {
  const found = suggest('hero = Character("hero.png")\nhero.', 34);
  assert.deepEqual(found.items.map((item) => item.label), [
    // 抗锯齿的两档是角色自己的，排在最前面（默认关）。
    "aa",
    "add",
    "alpha",
    "back",
    "blur",
    "brightness",
    "contrast",
    "crood",
    "eaa",
    "element",
    "enable",
    "fps",
    "front",
    "group",
    "h",
    "hex",
    "hide",
    "hTo",
    "key",
    "move",
    "moveTo",
    "name",
    "pause",
    "remove",
    "rgb",
    "rgbTo",
    "rim",
    "rotate",
    "rotateH",
    "rotateHTo",
    "rotateTo",
    "rotateV",
    "rotateVTo",
    "saturate",
    "say",
    "scale",
    "scaleTo",
    "show",
    "step",
    "transform",
    "translucent",
    "update",
    "v",
    "vTo",
    "x",
    "xTo",
    "y",
    "yTo",
    "z",
    "zTo",
  ]);
  assert.ok(found.items.every((item) => item.kind === "method"));
});

test("a shorter name is offered above a longer one that starts the same way", () => {
  // `move` and `moveTo` share a prefix; the shorter one is the more common
  // reach, so it comes first.
  assert.deepEqual(labels('hero = Character("x")\nhero.mo'), ["move", "moveTo"]);
  // Names of equal length keep the order they are declared in, so the list does
  // not reshuffle every time a name is added.
  assert.deepEqual(labels('Character("x").sca'), ["scale", "scaleTo"]);
});

test("a dot whose receiver cannot be worked out lists every method once", () => {
  // Every member once, alphabetically: the stage calls, the dialogue calls, the
  // free transform and the sound's six, plus the background's dissolve, which
  // no character answers to.
  assert.deepEqual(labels('Character("x").'), [
    "aa",
    "add",
    "alpha",
    "back",
    "bloom",
    "blur",
    "brightness",
    "color",
    "contrast",
    "crood",
    "crossFade",
    "density",
    "densityTo",
    "direction",
    "disable",
    "duration",
    "eaa",
    "element",
    "enable",
    "font",
    "fps",
    "front",
    "group",
    "h",
    "hex",
    "hide",
    "hTo",
    "intensity",
    "key",
    "loop",
    "move",
    "moveTo",
    "mute",
    "name",
    "once",
    "pause",
    "play",
    "range",
    "remove",
    "rgb",
    "rgbTo",
    "rim",
    "rotate",
    "rotateH",
    "rotateHTo",
    "rotateTo",
    "rotateV",
    "rotateVTo",
    "saturate",
    "say",
    "scale",
    "scaleTo",
    "show",
    "size",
    "sizeTo",
    "soft",
    "speed",
    "speedTo",
    "spread",
    "step",
    "stop",
    "transform",
    "translucent",
    "update",
    "v",
    "volume",
    "vTo",
    "weight",
    "width",
    "x",
    "xTo",
    "y",
    "yTo",
    "z",
    "zTo",
  ]);
});

test("a background offers the dissolve, and a character does not", () => {
  assert.deepEqual(labels('bg = Background("x")\nbg.cross'), ["crossFade"]);
  // A character is swapped by rebuilding its variable, not dissolved.
  assert.deepEqual(labels('hero = Character("x")\nhero.cross'), []);
});

test("only a character offers the layer order", () => {
  assert.deepEqual(labels('hero = Character("x")\nhero.front'), ["front"]);
  assert.deepEqual(labels('bg = Background("x")\nbg.front'), []);
});

test("a text offers the frame calls but not the bitmap-only ones", () => {
  const found = labels('title = Text("字")\ntitle.');
  assert.ok(found.includes("moveTo"));
  assert.ok(found.includes("alpha"));
  // 文字改色是 `color`；图片的 `hex` / `rgb` 染色滤镜不属于它。
  assert.ok(found.includes("color"));
  assert.equal(found.includes("hex"), false);
  assert.equal(found.includes("rgb"), false);
  assert.equal(found.includes("key"), false);
  assert.equal(found.includes("front"), false);
  assert.equal(found.includes("say"), false);
});

test("a group is built like the other objects, and answers its membership calls", () => {
  assert.deepEqual(labels("Ar"), ["Array"]);
  // The membership calls are the group's own; everything else it does is a
  // stage-wide call made on its members, so nothing is repeated here.
  assert.deepEqual(labels("ay1 = Array(ch1)\nay1."), ["add", "del", "remove", "update"]);
  assert.deepEqual(labels("ay1 = Array(ch1)\nay1.ad"), ["add"]);
});

test("a character offers the two calls it speaks through", () => {
  // `name` and `say` belong to the dialogue stage rather than the stage calls,
  // and they are listed with everything else the object answers to.
  assert.deepEqual(labels('hero = Character("x")\nhero.na'), ["name"]);
  assert.deepEqual(labels('hero = Character("x")\nhero.say'), ["say"]);
});

test("the dialogue global lists the calls it answers to", () => {
  // `dialog` is not a variable, so it is resolved by its own name.
  assert.deepEqual(labels("dialog."), ["disable", "enable", "say"]);
});

test("the stage lists both its own calls and the ones it makes for objects", () => {
  // `say` belongs to the stage itself, and so do the type constructors — a
  // bare `Character(…)` is `stage.Character(…)`. The rest are the calls it
  // makes on behalf of a list of objects. The Chinese receiver reaches the
  // same members.
  const stageCalls = [
    "alpha",
    "ambient",
    "Array",
    "Audio",
    "auto",
    "autoVoice",
    "back",
    "Background",
    "blur",
    "brightness",
    "Character",
    "click",
    "contrast",
    "density",
    "densityTo",
    "Effect",
    "enable",
    "exclude",
    "front",
    "guideline",
    "hide",
    "Light",
    "loop",
    "move",
    "moveTo",
    "mute",
    "once",
    "pamela",
    "pause",
    "perspective",
    "play",
    "rgb",
    "rgbTo",
    "rotate",
    "rotateTo",
    "saturate",
    "say",
    "scale",
    "scaleTo",
    "show",
    "size",
    "sizeTo",
    "speed",
    "speedTo",
    "stop",
    "Text",
    "unexclude",
    "Video",
  ];
  assert.deepEqual(labels("stage."), stageCalls);
  assert.deepEqual(labels("舞台."), stageCalls);
});

test("the stage offers the constructors it owns", () => {
  assert.deepEqual(labels("stage.Ch"), ["Character"]);
  assert.deepEqual(labels("舞台.Ch"), ["Character"]);
  // A shorthand line writes the bare name instead: `stage Character …` is not
  // a shorthand call, so constructors stay out of that list.
  assert.equal(shorthandLabels("stage ").includes("Character"), false);
});

test("the narrator's bare say is offered beside the objects", () => {
  const found = suggest("sa", 2);
  // The stage's batch `saturate` shares the prefix now that every bulk call is
  // offered without its receiver; `say` itself is the narrator's line.
  assert.deepEqual(found.items.map((item) => item.label), ["saturate", "say"]);
  const say = found.items.find((item) => item.label === "say");
  assert.equal(say.kind, "function");
  assert.match(say.detail, /旁白/);
});

test("a function the script declared is offered back to it", () => {
  const source = "func title() {\n}\ntit";
  const found = suggest(source, source.length);
  assert.deepEqual(found.items.map((item) => item.label), ["title"]);
  assert.equal(found.items[0].kind, "function");
  assert.equal(found.items[0].detail, "() 脚本函数");
});

test("a declared function is shown with the parameters it was written with", () => {
  const source = "func fadeIn(picture, ms) {\n}\nfa";
  const found = suggest(source, source.length);
  // `false` shares the prefix, and the two are in alphabetical order whatever
  // kind they are.
  assert.deepEqual(found.items.map((item) => item.label), ["fadeIn", "false"]);
  assert.equal(found.items[0].detail, "(picture, ms) 脚本函数");
});

test("a declaration below the caret is not offered yet", () => {
  // Nothing is hoisted in the language, so the list says the same: the name
  // only counts from the line its declaration is written on, and a call above
  // it is a name the script has not bound yet.
  assert.equal(suggest("title\nfunc title() {", 5), null);
});

test("a namespace lists its own names after a second dot", () => {
  // The free transform is reached through the character rather than answered by
  // it, so `hero.transform.` lists the eight points and not the object's calls.
  assert.deepEqual(labels('hero = Character("x")\nhero.transform.r'), ["right", "rightTo"]);
  assert.deepEqual(labels('hero = Character("x")\nhero.transform.downleft'), [
    "downleft",
    "downleftTo",
  ]);
});

test("every point of the transform is offered, relative and absolute", () => {
  const offered = labels('hero = Character("x")\nhero.transform.');
  assert.equal(offered.length, 16);
  assert.deepEqual([...offered].sort(), [
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
  ]);
});

test("the namespace is reached through a receiver that cannot be worked out too", () => {
  assert.deepEqual(labels('Character("x").transform.upleft'), ["upleft", "upleftTo"]);
});

test("the background offers no transform, which it does not have", () => {
  assert.deepEqual(labels('bg = Background("x")\nbg.transform'), []);
});

test("a decimal point is a number, not a member access", () => {
  assert.equal(suggest("hero.moveTo(1.", 14), null);
});

test("a name ending in a digit is a name, not a number", () => {
  // `ch1.` used to be read as the decimal point of `1`, so the names a scene
  // numbers — ch1, ch2, ay1 — offered nothing after the dot.
  assert.deepEqual(labels('ch1 = Character("x")\nch1.mo'), ["move", "moveTo"]);
  assert.deepEqual(labels("ay1 = Array(ch1)\nay1.ad"), ["add"]);
});

test("the function keyword is offered beside the other reserved words", () => {
  const found = suggest("fu", 2);
  assert.deepEqual(found.items.map((item) => item.label), ["func"]);
  assert.equal(found.items[0].kind, "keyword");
});

test("nothing is offered inside a comment or a string", () => {
  assert.equal(suggest("# bg", 4), null);
  assert.equal(suggest('x = "he', 7), null);
});

test("a note written with slashes hides its own line, and no more", () => {
  assert.equal(suggest("x = 1 // bg", 10), null);
  // The line after it is code again, so the walk carries on past the newline
  // rather than stopping at the first pair of slashes it meets.
  assert.deepEqual(labels("x = 1 // note\nBack"), ["back", "Background"]);
});

test("nothing is offered inside a block comment, however far it reaches", () => {
  assert.equal(suggest("/* bg", 5), null);
  assert.equal(suggest("/* bg\n   ba", 11), null);
  // Once it is closed, what follows is code again.
  assert.deepEqual(labels("/* bg */ Backg"), ["Background"]);
});

test("a pair of slashes inside a string does not open a comment", () => {
  assert.deepEqual(labels('x = "/*"\nBackg'), ["Background"]);
});

test("the suggested span covers the name already typed", () => {
  const found = suggest("bg = Backg", 10);
  assert.deepEqual({ start: found.start, end: found.end }, { start: 5, end: 10 });
  assert.deepEqual(found.items.map((item) => item.label), ["Background"]);
});

test("variables bound earlier in the script are offered too", () => {
  const found = suggest('hero = Character("hero.png")\nhe', 31);
  assert.deepEqual(found.items.map((item) => item.label), ["hero"]);
  assert.equal(found.items[0].kind, "variable");
  assert.match(found.items[0].detail, /Character/);
});

test("a name bound to a value of its own is offered as well", () => {
  // 数字、文本、列表都有自己的值，但名字一样能被后面的行引用。
  const number = suggest("hp = 87\nhp", 10);
  assert.deepEqual(number.items.map((item) => item.label), ["hp"]);
  assert.equal(number.items[0].kind, "variable");
  // 没有构造器可写在说明里，就只说它是变量。
  assert.equal(number.items[0].detail, "变量");
  assert.deepEqual(labels('title = "小帕"\ntit'), ["title"]);
  assert.deepEqual(labels("list = [1, 2]\nlist"), ["list"]);
  // 调用的结果同样绑出一个名字，即便没人知道它是什么种类。
  assert.deepEqual(labels("dice = roll(6)\ndic"), ["dice"]);
});

test("a name is only offered once the caret is past its binding", () => {
  assert.deepEqual(labels("hp"), []);
  assert.deepEqual(labels("hp\nhp = 87"), []);
});

test("a name bound from another name keeps that name's calls", () => {
  // `alias = hero` 拿到的是角色本身，所以点后面列的还是角色的方法。
  assert.deepEqual(labels('hero = Character("x")\nalias = hero\nalias.sca'), ["scale", "scaleTo"]);
  assert.deepEqual(labels('hero = Character("x")\nalias = hero\nalias.cross'), []);
  // 写全舞台的构造器也是一次构造，种类一样。
  assert.deepEqual(labels('bg = stage.Background("x")\nbg.cross'), ["crossFade"]);
});

test("a name written as an argument is not a variable", () => {
  // 括号里的 `=` 是具名实参：`mute` 没有被绑定，所以列出的只有同名的舞台方法。
  const source = 'v = Video("x.mp4", mute = false)\nmut';
  const items = suggest(source, source.length).items;
  assert.deepEqual(items.map((item) => item.label), ["mute"]);
  assert.equal(items[0].kind, "method");
  // 调用跨行写法也一样：括号里的换行只是排版，不断句。
  assert.deepEqual(labels('v = Video("x.mp4",\n  mute = false)\nmut'), ["mute"]);
});

test("a comparison is not a binding", () => {
  const source = "if a == 1 {\n}\na";
  const found = suggest(source, source.length);
  assert.ok(found.items.every((item) => item.kind !== "variable"), "a 没有被绑定");
});

test("a loop variable is offered inside the loop and after it", () => {
  assert.deepEqual(labels("for item in list {\n  ite"), ["item"]);
  // 循环变量绑在循环所跑的那层，所以循环之后仍能读到。
  const found = suggest("for item in list {\n}\nite", 25);
  assert.deepEqual(found.items.map((item) => item.label), ["item"]);
  assert.equal(found.items[0].kind, "variable");
});

test("accepting a name replaces the typed prefix and reports the caret", () => {
  const applied = applyCompletion("bg = Back\n", { start: 5, end: 9 }, "Background");
  assert.equal(applied.text, "bg = Background\n");
  assert.equal(applied.caret, 15);
});

test("a suggestion is spliced into the editor and the caller is told", () => {
  inFakeDom(() => {
    const textarea = fakeTextarea("bg = Backg");
    const edits = [];
    const editor = createCompletion({ textarea, onChange: () => edits.push(textarea.value) });

    editor.refresh();
    assert.equal(editor.handleKey(keyEvent("Enter")), true);
    assert.equal(textarea.value, "bg = Background");
    assert.equal(textarea.selectionStart, 15);
    assert.deepEqual(edits, ["bg = Background"]);
  });
});

test("Escape closes the list and leaves the script alone", () => {
  inFakeDom(() => {
    const textarea = fakeTextarea("bg = Back");
    const editor = createCompletion({ textarea });

    editor.refresh();
    assert.equal(editor.handleKey(keyEvent("Escape")), true);
    // With nothing open there is nothing left to consume.
    assert.equal(editor.handleKey(keyEvent("Escape")), false);
    assert.equal(textarea.value, "bg = Back");
  });
});

test("a shortcut is left to the application while the list is up", () => {
  inFakeDom(() => {
    const textarea = fakeTextarea("bg = Back");
    const editor = createCompletion({ textarea });

    editor.refresh();
    // Ctrl+Enter runs the script; it must not be swallowed as an acceptance.
    assert.equal(editor.handleKey(keyEvent("Enter", { ctrlKey: true })), false);
    assert.equal(textarea.value, "bg = Back");
  });
});

test("the arrow keys move the highlight without editing the script", () => {
  inFakeDom(() => {
    const textarea = fakeTextarea("Char");
    const editor = createCompletion({ textarea });

    editor.refresh();
    const down = keyEvent("ArrowDown");
    assert.equal(editor.handleKey(down), true);
    assert.equal(down.defaultPrevented, true);

    // Only one candidate for `Char`, so the highlight wraps back onto it.
    assert.equal(editor.handleKey(keyEvent("Tab")), true);
    assert.equal(textarea.value, "Character");
  });
});

test("a scroll re-anchors an open list and leaves a closed one closed", () => {
  inFakeDom(() => {
    const textarea = fakeTextarea("bg = Backg");
    const editor = createCompletion({ textarea });

    // Nothing is open, so a scroll must not summon a list to consume keys.
    editor.reposition();
    assert.equal(editor.handleKey(keyEvent("Enter")), false);

    editor.refresh();
    editor.reposition();
    assert.equal(editor.handleKey(keyEvent("Enter")), true);
    assert.equal(textarea.value, "bg = Background");
  });
});

/** The list element `createCompletion` mounted on the document. */
function popupOf(doc) {
  return doc.mounted.find((node) => node.className === "completion");
}

test("an arrow key moves the caret away and dismisses the list", () => {
  inFakeDom((doc) => {
    const textarea = fakeTextarea("bg = Back");
    const editor = createCompletion({ textarea });
    editor.refresh();
    const popup = popupOf(doc);
    assert.equal(popup.hidden, false);

    // An arrow key fires no `input` event, so without a caret check the list
    // would stay up and its `range` would splice into the wrong place later.
    assert.equal(editor.handleKey(keyEvent("ArrowLeft")), false);
    assert.equal(popup.hidden, true, "the list leaves with the caret");
    assert.equal(editor.handleKey(keyEvent("Enter")), false, "and cannot be accepted");
    assert.equal(textarea.value, "bg = Back");
  });
});

test("a click or a selection away from the word dismisses the list", () => {
  inFakeDom((doc) => {
    const textarea = fakeTextarea("bg = Back");
    const editor = createCompletion({ textarea });
    editor.refresh();
    const popup = popupOf(doc);

    textarea.setSelectionRange(0, 0);
    textarea.dispatch("click");
    assert.equal(popup.hidden, true, "a click closes it");

    // A fresh edit opens a new list, and dragging a selection over the script
    // closes that one too.
    textarea.value = "bg = Bac";
    textarea.setSelectionRange(8, 8);
    textarea.dispatch("input");
    editor.refresh();
    assert.equal(popup.hidden, false);

    textarea.setSelectionRange(2, 5);
    textarea.dispatch("select");
    assert.equal(popup.hidden, true, "dragging a selection closes it too");
  });
});

test("a selection change reported on the document dismisses the list", () => {
  inFakeDom((doc) => {
    const textarea = fakeTextarea("bg = Back");
    const editor = createCompletion({ textarea });
    editor.refresh();

    textarea.setSelectionRange(3, 3);
    doc.dispatch("selectionchange");

    assert.equal(popupOf(doc).hidden, true);
  });
});

test("typing continues the list instead of being read as a caret move", () => {
  inFakeDom((doc) => {
    const textarea = fakeTextarea("bg = Bac");
    const editor = createCompletion({ textarea });
    editor.refresh();
    const popup = popupOf(doc);

    // A keystroke fires `input` (which moves the caret) and then `keyup`,
    // before the repaint that rebuilds the list runs.
    textarea.value = "bg = Backg";
    textarea.setSelectionRange(10, 10);
    textarea.dispatch("input");
    textarea.dispatch("keyup");
    editor.refresh();

    assert.equal(popup.hidden, false, "the edit kept the list alive");
    assert.equal(editor.handleKey(keyEvent("Enter")), true);
    assert.equal(textarea.value, "bg = Background");
  });
});

test("a repaint queued before the caret moved cannot reopen the list", () => {
  inFakeDom((doc) => {
    const textarea = fakeTextarea("bg = Back");
    const editor = createCompletion({ textarea });
    editor.refresh();
    const popup = popupOf(doc);

    textarea.setSelectionRange(0, 0);
    textarea.dispatch("keyup");
    assert.equal(popup.hidden, true);

    // The frame the earlier keystroke scheduled lands afterwards. Without a
    // dismissal flag it would re-anchor the list at the new caret.
    editor.refresh();
    assert.equal(popup.hidden, true, "only an edit may open it again");

    textarea.value = "bg = Bac";
    textarea.setSelectionRange(8, 8);
    textarea.dispatch("input");
    editor.refresh();
    assert.equal(popup.hidden, false, "and a new edit does");
  });
});

test("Escape keeps the list closed until the next edit", () => {
  inFakeDom((doc) => {
    const textarea = fakeTextarea("bg = Back");
    const editor = createCompletion({ textarea });
    editor.refresh();
    const popup = popupOf(doc);

    assert.equal(editor.handleKey(keyEvent("Escape")), true);
    editor.refresh();
    assert.equal(popup.hidden, true);

    textarea.value = "bg = Backg";
    textarea.setSelectionRange(10, 10);
    textarea.dispatch("input");
    editor.refresh();
    assert.equal(popup.hidden, false);
  });
});

test("the highlight is scrolled into the list's own view", () => {
  inFakeDom((doc) => {
    const textarea = fakeTextarea('hero = Character("x")\nhero.');
    const editor = createCompletion({ textarea });
    editor.refresh();

    const popup = doc.mounted.find((node) => node.className === "completion");
    const rows = popup.children[0].children;
    rows.forEach((row, index) => {
      row.offsetTop = index * 20;
      row.offsetHeight = 20;
    });
    // Three rows fit; walking past the third has to bring the next one up.
    popup.clientHeight = 60;

    for (let step = 0; step < 3; step += 1) {
      assert.equal(editor.handleKey(keyEvent("ArrowDown")), true);
    }
    assert.equal(rows[3].classList.contains("is-active"), true);
    assert.equal(popup.scrollTop, 20);
  });
});

// --- 简写脚本候选 ---

test("a stage-wide method with the stage left out is offered at a line's start", () => {
  const found = suggest("ena", 3, { shorthand: true });
  assert.deepEqual(found.items.map((item) => item.label), ["enable"]);
  assert.equal(found.items[0].kind, "method");
  assert.match(found.items[0].detail, /省略 stage/);
  // The Chinese spelling is the same call, and a `.pe` file keeps its own list.
  assert.deepEqual(shorthandLabels("启"), ["启用"]);
  // The full syntax offers it too: the stage is what a line leaves out, not
  // what makes the call legal.
  assert.deepEqual(labels("ena"), ["enable"]);
  assert.match(suggest("ena", 3).items[0].detail, /省略 stage/);
});

test("the objects a stage-wide call names are offered, including shorthand bindings", () => {
  const source = "bg = Background st.png\nch = Character mu.png\nenable ";
  assert.deepEqual(shorthandLabels(source), ["bg", "ch"]);
  assert.deepEqual(shorthandLabels(`${source}c`), ["ch"]);
  // `stage enable …` names objects too, even with the receiver written out.
  assert.deepEqual(shorthandLabels("bg = Background st.png\nstage enable b"), ["bg"]);
  const items = suggest(source, source.length, { shorthand: true }).items;
  assert.ok(items.every((item) => item.kind === "variable"));
});

test("a shorthand binding is a variable, and a plain value is not an object", () => {
  // `hp = 87` 在简写里也绑出一个能引用的名字。
  assert.deepEqual(shorthandLabels("hp = 87\nhp"), ["hp"]);
  // 但省略 stage 的批量调用只列对象：数字没有能一起调的方法。
  assert.deepEqual(shorthandLabels("hp = 87\nenable h"), []);
  // 中文构造器写出来的绑定，种类照样认得出来。
  const source = "小帕 = 角色 帕.png\nenable 小";
  const items = suggest(source, source.length, { shorthand: true }).items;
  assert.deepEqual(items.map((item) => item.label), ["小帕"]);
  assert.match(items[0].detail, /Character/);
});

test("a space takes the place of a dot in a shorthand line", () => {
  assert.deepEqual(shorthandLabels("stage ena"), ["enable"]);
  const stage = shorthandLabels("stage ");
  assert.ok(stage.includes("enable"));
  assert.ok(stage.includes("启用"));
  assert.deepEqual(shorthandLabels("ch = Character mu.png\nch sca"), ["scale", "scaleTo"]);
  // Full syntax on the line keeps the `.pe` rules.
  assert.deepEqual(shorthandLabels('hero = Character("x")\nhero.sca'), ["scale", "scaleTo"]);
});

test("a chained call offers methods again after its dot", () => {
  const bound = "ch = Character mu.png\n";
  // `ch hide . ` is asking for another method of the same receiver.
  assert.deepEqual(shorthandLabels(`${bound}ch hide . bl`), ["blur"]);
  assert.ok(shorthandLabels(`${bound}ch hide . `).includes("move"));
  // A stage-wide call chains on the stage, so it offers the stage's methods.
  const bulk = shorthandLabels(`${bound}enable ch . ena`);
  assert.ok(bulk.includes("enable"), JSON.stringify(bulk));
  // A group chains on itself.
  assert.deepEqual(shorthandLabels("ay1 = Array ch1\nay1 add ch1 . a"), ["add"]);
});

test("the popup asks whether the open file is a shorthand script", () => {
  inFakeDom(() => {
    const shorthand = fakeTextarea("ena");
    const editor = createCompletion({ textarea: shorthand, isShorthand: () => true });
    editor.refresh();
    assert.equal(editor.handleKey(keyEvent("Enter")), true);
    assert.equal(shorthand.value, "enable");
  });
  inFakeDom(() => {
    // 简写里 `enable ` 后面是对象；全量语法里那还是同一行代码，没有候选。
    const full = fakeTextarea("bg = Background st.png\nenable ");
    const editor = createCompletion({ textarea: full, isShorthand: () => false });
    editor.refresh();
    assert.equal(editor.handleKey(keyEvent("Enter")), false);
    assert.equal(full.value, "bg = Background st.png\nenable ");
  });
});
