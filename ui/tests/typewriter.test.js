// 项目级打字机档位与 `say` 计时选项测试。
// Tests for the project-level typewriter mode and the `say` timing options that

import assert from "node:assert/strict";
import test from "node:test";

import { createDialogue } from "../dialog.js";
import { createStage } from "../stage.js";

/** A stand-in element, with just enough of the DOM for `createStage`/`createDialogue`. */
function fakeElement() {
  const listeners = new Map();
  const node = {
    className: "",
    dataset: {},
    style: {},
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
    append(...children) {
      node.childNodes.push(...children);
    },
    hidden: false,
    alt: "",
    draggable: false,
    src: "",
    textContent: "",
    volume: 1,
    loop: false,
    currentTime: 0,
    paused: true,
    play() {
      node.paused = false;
      return Promise.resolve();
    },
    pause() {
      node.paused = true;
    },
    decode() {
      return Promise.resolve();
    },
    removeAttribute(name) {
      node[name] = "";
    },
    setAttribute(name, value) {
      node[name] = value;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
  };
  return node;
}

/** Runs `body` with a minimal `document`, so a box can be built in node. */
function inFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

/** A box over the fake DOM, with the options the case cares about. */
function box(options = {}) {
  return createDialogue({
    element: fakeElement(),
    node: fakeElement(),
    resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    ...options,
  });
}

/** Resolves after `ms` milliseconds, so a timer the box armed can fire. */
function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- the project's mode ---

test("打字机：关档位不逐字，整行一次出现", () => {
  inFakeDom(() => {
    const b = box({ typewriter: "off" });
    b.line(null, "整行直接出现").catch(() => {});
    // A speed of zero means there is nothing to write out, so the box is not
    // typing: a click would advance rather than finish the line.
    assert.equal(b.isTyping(), false);
    b.settle();
  });
});

test("打字机：快档逐字写出，且首字之后仍在打字", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "fast" });
    b.line(null, "逐字显示的一句话").catch(() => {});
    assert.equal(b.isTyping(), true, "开启档位后进入逐字");
    b.settle();
  });
});

test("打字机：档位越慢，同一句写得越久", async () => {
  // Ten characters at 20ms each is 200ms; at 70ms each it is 700ms. A 500ms
  // wait lands between them: the fast mode has finished, the slow one has not.
  // The wait is well clear of both figures rather than tight against them, so
  // the test is about the mode reaching the reveal and not about timer jitter.
  const stillTypingAfter = async (mode, ms) => {
    let typing = false;
    await inFakeDom(async () => {
      const b = box({ typewriter: mode });
      b.line(null, "一句用来比较速度的话").catch(() => {});
      await wait(ms);
      typing = b.isTyping();
      b.settle();
    });
    return typing;
  };

  const fast = await stillTypingAfter("fast", 500);
  const slow = await stillTypingAfter("slow", 500);
  assert.equal(fast, false, "快档 200ms 的逐字早已写完");
  assert.equal(slow, true, "慢档 700ms 的逐字还在进行");
});

test("打字机：setTypewriter 改变后续语句的回落速度", () => {
  inFakeDom(() => {
    const b = box({ typewriter: "off" });
    b.line(null, "改档位之前").catch(() => {});
    assert.equal(b.isTyping(), false, "关档位不逐字");
    b.settle();

    b.setTypewriter("slow");
    b.line(null, "改档位之后").catch(() => {});
    assert.equal(b.isTyping(), true, "改成慢档后开始逐字");
    b.settle();
  });
});

test("打字机：样式文件写了 typeSpeed 时以样式为准", () => {
  inFakeDom(() => {
    // A project on `off`, but the style names its own speed: the style wins,
    // which is the rule the settings dialog's body text documents. A style file
    // carries both slots, so the speed is named in each.
    const b = box({ typewriter: "off" });
    const style = { text: { typeSpeed: 20 } };
    b.setStyle({ styles: { dialog: style, narration: style } });
    b.line(null, "样式说了算").catch(() => {});
    assert.equal(b.isTyping(), true);
    b.settle();
  });
});

// --- say 的时间与音频参数 ---

test("say 计时：只给 time 时，文本必须在 time 内写完", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    // Ten characters in 100ms is 10ms each — forced, even though the project
    // is on `off`.
    b.line(null, "十个字的一句话啊", { time: 100, audio: null }).catch(() => {});
    assert.equal(b.isTyping(), true, "time 强制开启逐字");
    b.settle();
  });
});

test("say 计时：只给 audio 时不改打字速度", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    let asked = null;
    const withVoice = box({
      typewriter: "off",
      onVoice: (name) => {
        asked = name;
        return Promise.resolve(1200);
      },
    });
    withVoice.line(null, "配音这句", { time: 0, audio: "voice1" }).catch(() => {});
    // The project is on `off` and no `time` was given, so the line is not
    // typed out: only the cut is bound to the audio.
    assert.equal(withVoice.isTyping(), false, "audio 不影响打字速度");
    withVoice.settle();
    assert.equal(asked, null, "onVoice 由自动播放的计时路径触发，不在显示时");
    b.settle();
  });
});

test("say 计时：舞台把 audio 名字交给音频工厂", async () => {
  await inFakeDom(async () => {
    const stage = createStage({
      element: fakeElement(),
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
      resolveAudio: () => Promise.resolve("data:audio/wav;base64,"),
    });
    // A name holding no sound — a typo, or a variable not built yet — answers
    // 0 rather than throwing, so a missing voice track leaves the line on its
    // normal timer instead of failing the run.
    assert.equal(await stage.voice("nope"), 0);
    stage.clear();
  });
});

// --- 自动配音（stage.autoVoice）---

test("自动配音：开启后无 audio 的台词按字数配效果音并等待", async () => {
  await inFakeDom(async () => {
    let synthCalls = 0;
    const b = box({
      typewriter: "off",
      getAutoVoice: () => true,
      synthVoice: (chars) => {
        synthCalls += 1;
        return { duration: 1000, stop() {} };
      },
    });
    b.setAuto(true);
    let resolved = false;
    b.line(null, "六个字的一句").then(() => { resolved = true; }).catch(() => {});
    await wait(40);
    assert.equal(resolved, false, "效果音时长内不应切句");
    assert.equal(synthCalls, 1, "自动配音触发一次");
    await wait(1100);
    assert.equal(resolved, true, "效果音结束后切句");
  });
});

test("自动配音：手动模式下显示时也触发效果音，且推进会中断", async () => {
  await inFakeDom(async () => {
    let synthCalls = 0;
    let stopped = false;
    const b = box({
      typewriter: "off",
      getAutoVoice: () => true,
      synthVoice: () => {
        synthCalls += 1;
        return { duration: 1000, stop() { stopped = true; } };
      },
    });
    b.line(null, "六个字的一句", { time: 0, audio: null }).catch(() => {});
    await wait(40);
    assert.equal(synthCalls, 1, "手动模式也触发自动配音效果音");
    assert.equal(stopped, false, "未推进时效果音仍在播放");
    b.settle();
    assert.equal(stopped, true, "手动推进中断效果音，不残留到下一句");
  });
});

test("自动配音：手动模式且 autoVoice 关闭时不触发效果音", async () => {
  await inFakeDom(async () => {
    let synthCalls = 0;
    const b = box({
      typewriter: "off",
      getAutoVoice: () => false,
      synthVoice: () => {
        synthCalls += 1;
        return { duration: 1000, stop() {} };
      },
    });
    b.line(null, "手动这句", { time: 0, audio: null }).catch(() => {});
    await wait(40);
    assert.equal(synthCalls, 0, "autoVoice 关闭时手动模式不发声");
    b.settle();
  });
});

test("自动配音：显式 audio 优先于 autoVoice", async () => {
  await inFakeDom(async () => {
    let voiceName = null;
    let synthCalls = 0;
    const b = box({
      typewriter: "off",
      getAutoVoice: () => true,
      onVoice: (name) => {
        voiceName = name;
        return Promise.resolve(800);
      },
      synthVoice: () => {
        synthCalls += 1;
        return { duration: 1000, stop() {} };
      },
    });
    b.setAuto(true);
    b.line(null, "有配音的一句", { time: 0, audio: "vo" }).catch(() => {});
    await wait(20);
    assert.equal(voiceName, "vo", "显式 audio 被采用");
    assert.equal(synthCalls, 0, "autoVoice 不覆盖显式配音");
    b.settle();
  });
});

test("自动配音：手动推进会中断进行中的效果音", async () => {
  await inFakeDom(async () => {
    let stopped = false;
    const b = box({
      typewriter: "off",
      getAutoVoice: () => true,
      synthVoice: () => ({ duration: 5000, stop: () => { stopped = true; } }),
    });
    b.setAuto(true);
    b.line(null, "很长的一句").catch(() => {});
    await wait(20);
    assert.equal(stopped, false, "尚未中断");
    b.settle();
    assert.equal(stopped, true, "手动推进中断效果音");
  });
});

// --- 自动播放计时 ---

test("自动计时：关档位按每 3 字一组、每组 0.8s", async () => {
  // Nine characters is three groups, so 2.4s. The test watches the cut happen
  // rather than the number: a delay that lands is the only thing observable.
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.setAuto(true);
    let resolved = false;
    // Nine characters: 3 groups → 2400ms, far past the wait below.
    b.line(null, "一二三四五六七八九")
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    await wait(60);
    assert.equal(resolved, false, "按字数算出的时长还没到");
    b.settle();
  });
});

test("自动计时：手动覆盖值优先于按字数公式", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    // The formula would say 2400ms; the override says 5ms.
    b.setAutoDelay(5);
    b.setAuto(true);
    let resolved = false;
    b.line(null, "一二三四五六七八九")
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    await wait(40);
    assert.equal(resolved, true, "覆盖值生效");
  });
});

// --- 点击位置 ---

test("点击位置：非自动模式等手动点击才放行", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    let resolved = false;
    b.clickWait(0)
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    await wait(30);
    assert.equal(resolved, false, "没有点击就不放行");
    b.settle();
    await wait(0);
    assert.equal(resolved, true, "点击后放行");
  });
});

test("点击位置：自动模式走完时间参数自动放行", async () => {
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.setAuto(true);
    let resolved = false;
    b.clickWait(5)
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    await wait(40);
    assert.equal(resolved, true, "时间参数走完自动放行");
  });
});

// --- 圆环 ---

test("圆环：没有 frame 时钟时不渲染、也不阻止切换语句", async () => {
  // Node has no `requestAnimationFrame`, which is the case this guards: the
  // ring is decoration, so its absence must not keep a line from advancing.
  assert.equal(typeof globalThis.requestAnimationFrame, "undefined");
  await inFakeDom(async () => {
    const b = box({ typewriter: "off" });
    b.setAutoDelay(5);
    b.setAuto(true);
    let resolved = false;
    b.line(null, "圆环缺席也能切句")
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    await wait(40);
    assert.equal(resolved, true);
  });
});

test("圆环：建在舞台元素上，默认隐藏", () => {
  inFakeDom(() => {
    const root = fakeElement();
    const stage = createStage({
      element: root,
      surface: fakeElement(),
      resolveAsset: () => Promise.resolve("data:image/png;base64,"),
    });
    const ring = root.childNodes.find((child) => child.class === "dialogue__countdown");
    assert.ok(ring, "圆环存储于舞台元素下");
    assert.equal(ring.hidden, true, "默认隐藏");
    assert.equal(ring.viewBox, "0 0 40 40");
    // The two circles: the track and the draining part.
    assert.equal(ring.childNodes.length, 2);
    assert.equal(ring.childNodes[1].class, "dialogue__countdown-fg");
    stage.clear();
  });
});
