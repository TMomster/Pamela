// 音轨并行：效果音与对话配音各用各的元素，互不抢占。
import assert from "node:assert/strict";
import test from "node:test";

import { createAudioFactory } from "../audio.js";

/** 一个够用的 `<audio>` 替身：记录播放/暂停与取源，能手动触发元数据事件。 */
function fakeAudio() {
  const listeners = new Map();
  const node = {
    src: "",
    duration: 0,
    loop: false,
    preload: "",
    volume: 1,
    playbackRate: 1,
    currentTime: 0,
    paused: true,
    play() {
      node.paused = false;
      return Promise.resolve();
    },
    pause() {
      node.paused = true;
    },
    load() {},
    removeAttribute(name) {
      node[name] = "";
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      listeners.set(type, list.filter((f) => f !== fn));
    },
    fire(type) {
      (listeners.get(type) ?? []).forEach((fn) => fn());
    },
  };
  return node;
}

/** 建一个音频工厂，收集所有 `<audio>` 元素；body 全程运行在最小 DOM 中。 */
async function withAudio(body, options = {}) {
  const created = [];
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, "audio", "音频工厂只应创建 audio 元素");
      const element = fakeAudio();
      created.push(element);
      return element;
    },
  };
  try {
    const audio = createAudioFactory({
      resolveAsset: () => Promise.resolve("data:audio/wav;base64,UklGRg=="),
      ...options,
    });
    return await body(audio, created);
  } finally {
    globalThis.document = previous;
  }
}

/** 让异步的 resolveAsset / play 链跑完。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("配音按同名变量找到源，但用独立元素播放，不中止效果音", async () => {
  await withAudio(async (audio, created) => {
    const sfx = audio(["hit.wav"], { assignee: "hit" });
    sfx.play();
    await tick();

    assert.equal(created.length, 1);
    const effect = created[0];
    assert.equal(effect.paused, false, "效果音正在播放");
    effect.currentTime = 5; // 一个「已经播到一半」的效果音。

    const duration = audio.voice("hit");
    await tick();

    assert.equal(created.length, 2, "配音建了自己的元素，没有复用效果音的元素");
    const voice = created[1];
    assert.notEqual(voice, effect);
    assert.equal(effect.paused, false, "效果音仍在播放");
    assert.equal(effect.currentTime, 5, "效果音没有被配音重置回开头");
    assert.equal(voice.src, effect.src, "配音与效果音取自同一个文件");
    assert.equal(voice.paused, false, "配音也在播放，两条音轨并行");

    voice.duration = 1.2;
    voice.fire("loadedmetadata");
    assert.equal(await duration, 1200, "配音时长取自自己的音轨");
    audio.clear();
  });
});

test("stopVoice 只停配音，不停同名效果音", async () => {
  await withAudio(async (audio, created) => {
    audio(["hit.wav"], { assignee: "hit" }).play();
    audio.voice("hit");
    await tick();

    const [effect, voice] = created;
    audio.stopVoice("hit");

    assert.equal(voice.paused, true, "配音被停下");
    assert.equal(effect.paused, false, "效果音继续播放");
    audio.clear();
  });
});

test("多条不同名字的配音互不干扰，clear 停掉全部音轨", async () => {
  await withAudio(async (audio, created) => {
    audio(["hit.wav"], { assignee: "hit" }).play();
    const first = audio.voice("Audio/first.wav");
    const second = audio.voice("Audio/second.wav");
    await tick();

    assert.equal(created.length, 3, "一条效果音 + 两条配音，各自独立");
    const [effect, a, b] = created;
    assert.equal(effect.paused, false);
    assert.equal(a.paused, false);
    assert.equal(b.paused, false);
    assert.notEqual(a, b);
    // 手动喂元数据，省去 durationOf 的 2 秒兜底超时。
    a.duration = 1;
    a.fire("loadedmetadata");
    b.duration = 1;
    b.fire("loadedmetadata");

    audio.clear();
    for (const element of created) {
      assert.equal(element.paused, true, "clear 后没有残留的播放");
    }
    await Promise.all([first, second]);
  });
});

test("未知且不像文件名的配音名仍静默回退，不建音轨", async () => {
  await withAudio(async (audio, created) => {
    assert.equal(await audio.voice("typoName"), 0);
    assert.equal(created.length, 0);
  });
});

test("audioSpeed 只影响之后的播放，脚本 speed 乘在基础倍率之上", async () => {
  await withAudio(async (audio, created) => {
    const first = audio(["bgm.mp3"], { assignee: "bgm" });
    first.play();
    await tick();
    assert.equal(created[0].playbackRate, 1);

    audio.setAudioSpeed(2);
    first.play();
    await tick();
    assert.equal(created[0].playbackRate, 2, "之后重新播放的声音用新倍率");

    const second = audio(["se.wav"], { assignee: "se" });
    second.speedTo(0.5);
    second.play();
    await tick();
    assert.equal(created[1].playbackRate, 1, "2 × 0.5");

    audio.setAudioSpeed(0.1);
    second.play();
    await tick();
    assert.equal(created[1].playbackRate, 0.05, "0.1 × 0.5");
    audio.clear();
  });
});

test("clear 后基础倍率复位，不带进下一趟演出", async () => {
  await withAudio(async (audio, created) => {
    audio.setAudioSpeed(2);
    audio.setVoiceSpeed(3);
    audio.clear();

    audio.voice("Audio/x.wav");
    audio(["y.wav"], { assignee: "y" }).play();
    await tick();

    assert.equal(created[0].playbackRate, 1, "配音倍率复位");
    assert.equal(created[1].playbackRate, 1, "效果音倍率复位");
    audio.clear();
  });
});

test("voiceSpeed 改新配音的播放与计时，不影响已经响着的那一条", async () => {
  await withAudio(async (audio, created) => {
    const first = audio.voice("Audio/first.wav");
    await tick();
    assert.equal(created[0].playbackRate, 1);

    audio.setVoiceSpeed(2);
    const second = audio.voice("Audio/second.wav");
    await tick();
    assert.equal(created[1].playbackRate, 2);
    assert.equal(created[0].playbackRate, 1, "旧配音保持原速");

    created[0].duration = 1.2;
    created[0].fire("loadedmetadata");
    assert.equal(await first, 1200, "旧配音按原速计时");

    created[1].duration = 1.2;
    created[1].fire("loadedmetadata");
    assert.equal(await second, 600, "新配音的语音计时按倍率缩短");
    audio.clear();
  });
});
