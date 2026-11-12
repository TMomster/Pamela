import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import test from "node:test";

import {
  createVoiceEffect,
  renderVoiceBuffer,
  AUTOVOICE_CLIP,
  AUTOVOICE_CLIP_URL,
  AUTOVOICE_DEFAULT_SPEED,
  AUTOVOICE_MIN_SPEED,
  AUTOVOICE_MAX_SPEED,
} from "../voice-effect.js";

class FakeSource {
  constructor() {
    this.buffer = null;
    this.started = null;
    this.stopped = null;
  }

  connect(node) {
    return node;
  }

  start(at) {
    this.started = at;
  }

  stop(at) {
    this.stopped = at;
  }
}

class FakeContext {
  constructor(channels, frames, sampleRate) {
    this.channels = channels;
    this.frames = frames;
    this.sampleRate = sampleRate;
    this.destination = { kind: "destination" };
    this.sources = [];
    this.decodes = 0;
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  async decodeAudioData() {
    this.decodes += 1;
    return {
      duration: 0.5,
      numberOfChannels: 2,
      length: 24_000,
      getChannelData: () => new Float32Array(24_000),
    };
  }

  async startRendering() {
    return {
      length: this.frames,
      duration: this.frames / this.sampleRate,
      numberOfChannels: this.channels,
      getChannelData: () => new Float32Array(this.frames),
    };
  }
}

test("自动配音的单位音效是引擎自带的那一段", () => {
  assert.equal(AUTOVOICE_CLIP, "DialogAutoVoice.mp3");
  assert.equal(AUTOVOICE_DEFAULT_SPEED, 10);
  assert.equal(AUTOVOICE_MIN_SPEED, 1);
  assert.equal(AUTOVOICE_MAX_SPEED, 10);
  // 音效随前端打包，所以位置是模块自己的相对路径，而不是项目里的资源名。
  assert.match(AUTOVOICE_CLIP_URL, /sounds\/DialogAutoVoice\.mp3$/);
});

test("单位音效文件真的在前端产物目录里", () => {
  const url = new URL("../sounds/DialogAutoVoice.mp3", import.meta.url);
  assert.ok(existsSync(url), "ui/sounds/DialogAutoVoice.mp3 缺失");
  assert.ok(statSync(url).size > 0, "单位音效是空文件");
});

test("默认速度 10 次/秒，每两字一次", () => {
  const effect = createVoiceEffect();
  // 6 字 → 3 次；3 次 / 10 次每秒 → 整段 300ms。
  assert.equal(effect.play(6).duration, 3 * (1000 / 10));
  // 1 字也至少响一次。
  assert.equal(effect.play(1).duration, 1 * (1000 / 10));
  // 5 字 → 3 次。
  assert.equal(effect.play(5).duration, 3 * (1000 / 10));
});

test("播放速度可调：1 次/秒最慢，10 次/秒最快", () => {
  const effect = createVoiceEffect();
  assert.equal(effect.play(6, 1).duration, 3 * 1000);
  assert.equal(effect.play(6, 10).duration, 3 * 100);
  assert.equal(effect.play(6, 5).duration, 3 * 200);
});

test("取不到音效时退化为静默时长，语句计时仍可进行", () => {
  const effect = createVoiceEffect({ loadClip: async () => null });
  const voice = effect.play(6, 3);
  assert.equal(voice.duration, 1000);
  assert.doesNotThrow(() => voice.stop());
});

test("实时演出真的会发出声音：解码后按次数排播", async () => {
  const contexts = [];
  class LiveContext extends FakeContext {
    constructor() {
      super(2, 1024, 48_000);
      this.currentTime = 0;
      this.destination = { kind: "destination" };
      contexts.push(this);
    }
  }
  // 演出端用 `window.AudioContext`；Node 里没有窗口，替一个进去。
  const previous = globalThis.window;
  globalThis.window = { AudioContext: LiveContext };
  try {
    const effect = createVoiceEffect({
      loadClip: async () => new ArrayBuffer(8),
    });
    const voice = effect.play(6);
    assert.equal(voice.duration, 300, "6 字、默认 10 次/秒 → 300 毫秒");
    // 解码是异步的，等它落地。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const live = contexts[0];
    assert.ok(live, "没有建出音频上下文");
    assert.equal(live.sources.length, 3, "6 字 → 3 次播放");
    assert.deepEqual(
      live.sources.map((source) => Math.round(source.started * 1000)),
      [0, 100, 200],
      "默认每 1000/10 ms 一次",
    );
  } finally {
    if (previous === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previous;
    }
  }
});

test("renderVoiceBuffer 按次数与速度排片：间隔 = 1 / 速度 秒", async () => {
  const contexts = [];
  const AudioContextClass = class extends FakeContext {
    constructor(channels, frames, sampleRate) {
      super(channels, frames, sampleRate);
      contexts.push(this);
    }
  };
  await renderVoiceBuffer(new ArrayBuffer(8), {
    count: 3,
    speed: 3,
    sampleRate: 48_000,
    channels: 2,
    AudioContextClass,
  });
  // 第一个上下文用于解码，第二个用于排片。
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].decodes, 1);
  const out = contexts[1];
  assert.equal(out.sources.length, 3, "3 次播放");
  assert.deepEqual(
    out.sources.map((source) => Math.round(source.started * 1000)),
    [0, 333, 667],
    "每 1000/3 ms 一次",
  );
});

test("renderVoiceBuffer 速度越快，整段越短", async () => {
  const lengths = {};
  for (const speed of [1, 8]) {
    const AudioContextClass = class extends FakeContext {};
    const buffer = await renderVoiceBuffer(new ArrayBuffer(8), {
      count: 3,
      speed,
      sampleRate: 48_000,
      channels: 2,
      AudioContextClass,
    });
    lengths[speed] = buffer.duration;
  }
  assert.ok(lengths[8] < lengths[1], "8 次/秒比 1 次/秒短");
});
