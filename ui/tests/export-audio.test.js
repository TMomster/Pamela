// 导出音频：事件录制 → 音量折线 → 离线渲染 → AAC 编码（全部注入假实现）。
// Sound for the exported movie, with fake WebAudio and fake WebCodecs.

import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualClock } from "../export-clock.js";
import {
  applyGain,
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_CODEC,
  AUDIO_SAMPLE_RATE,
  buildAudioTrack,
  createAudioRecorder,
  encodeAudio,
  planAudio,
  renderAudio,
} from "../export-audio.js";

// --- 录制 ---

test("the recorded Audio object takes the same constructor arguments as the stage", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  const quiet = recorder.audio(["bgm.mp3", 2, true], { assignee: "bgm" });
  assert.equal(quiet.kind, "Audio");
  const sound = recorder.sounds.get("sound-1");
  assert.equal(sound.path, "bgm.mp3");
  assert.equal(sound.volume, 1, "音量上限是 1");
  assert.equal(sound.loop, true);

  assert.throws(() => recorder.audio([], {}), /音频文件名/);
  assert.throws(() => recorder.audio(["x.mp3", "loud"], {}), /音量需要数字/);
});

test("play, stop and volume are recorded at the virtual clock's time", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  const bgm = recorder.audio(["bgm.mp3", 0.4, true], { assignee: "bgm" });

  bgm.play(500);
  clock.tickMs(2000);
  bgm.volume(0.8, 1000);
  clock.tickMs(3000);
  bgm.stop();

  assert.deepEqual(
    recorder.events.map((event) => [event.kind, Math.round(event.at), event.fadeMs ?? null]),
    [
      ["play", 0, 500],
      ["volume", 2000, 1000],
      ["stop", 5000, 0],
    ],
  );
  assert.equal(recorder.hasSound(), true);
});

test("a resumed sound plays from the start instead of stacking a second copy", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  const effect = recorder.audio(["hit.mp3"], { assignee: "hit" });
  effect.play();
  clock.tickMs(700);
  effect.play();
  clock.tickMs(300);

  const { voices } = planAudio(recorder);
  assert.equal(voices.length, 2);
  assert.equal(voices[0].stopMs, 700, "第一段在第二次 play 处收尾");
  assert.equal(voices[1].startMs, 700);
});

test("say(text, time, 变量名) records the voice track once", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  recorder.audio(["vo.mp3"], { assignee: "配音" });
  clock.tickMs(1500);

  const waiting = recorder.audio.voice("配音");
  assert.equal(typeof waiting.then, "function");
  assert.deepEqual(
    recorder.events.map((event) => [event.kind, event.at]),
    [["play", 1500]],
  );

  // 没建过的名字不报错，也不产生事件。
  recorder.audio.voice("没这个声音");
  assert.equal(recorder.events.length, 1);
});

// --- 计划 ---

test("planAudio turns play / volume / stop into one segment with a gain curve", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  const bgm = recorder.audio(["bgm.mp3", 0.4, true], { assignee: "bgm" });
  bgm.play(500);
  clock.tickMs(2000);
  bgm.volume(0.8, 1000);
  clock.tickMs(3000);
  bgm.stop();

  const { voices } = planAudio(recorder);
  assert.equal(voices.length, 1);
  assert.deepEqual(voices[0], {
    id: "sound-1",
    path: "bgm.mp3",
    startMs: 0,
    stopMs: 5000,
    loop: true,
    gain: [
      { at: 0, value: 0 },
      { at: 500, value: 0.4 },
      { at: 2000, value: 0.4 },
      { at: 3000, value: 0.8 },
      { at: 5000, value: 0.8 },
    ],
  });
});

test("a stop with a fade ramps down before the sound ends", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  const bgm = recorder.audio(["bgm.mp3", 1], {});
  bgm.play();
  clock.tickMs(1000);
  bgm.stop(800);

  const { voices } = planAudio(recorder);
  assert.equal(voices[0].stopMs, 1800);
  assert.deepEqual(voices[0].gain, [
    { at: 0, value: 1 },
    { at: 1000, value: 1 },
    { at: 1800, value: 0 },
  ]);
});

test("loop() and once() switch the segment while it is playing", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  const bgm = recorder.audio(["bgm.mp3"], {});
  bgm.play();
  clock.tickMs(500);
  bgm.loop();
  clock.tickMs(500);
  bgm.once();

  const { voices } = planAudio(recorder);
  // 每个 loop/once 事件都会改写当前段的循环标记，最后一个是 once。
  assert.equal(voices.length, 1);
  assert.equal(voices[0].loop, false);
});

test("a sound that never plays contributes no segment", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  recorder.audio(["bgm.mp3"], {});
  assert.deepEqual(planAudio(recorder).voices, []);
  assert.equal(recorder.hasSound(), false);
});

// --- 音量自动化 ---

function fakeParam() {
  return {
    events: [],
    setValueAtTime(value, at) {
      this.events.push(["set", value, Math.round(at * 1000)]);
    },
    linearRampToValueAtTime(value, at) {
      this.events.push(["ramp", value, Math.round(at * 1000)]);
    },
    exponentialRampToValueAtTime(value, at) {
      this.events.push(["exp", value, Math.round(at * 1000)]);
    },
  };
}

test("applyGain sorts the curve into seconds and ramps between points", () => {
  const param = fakeParam();
  applyGain(param, [
    { at: 500, value: 0.4 },
    { at: 0, value: 0 },
    { at: 2000, value: 0.8 },
  ]);
  assert.deepEqual(param.events, [
    ["set", 0, 0],
    ["ramp", 0.4, 500],
    ["ramp", 0.8, 2000],
  ]);
});

test("applyGain lets the later of two points at the same time win", () => {
  const param = fakeParam();
  applyGain(param, [
    { at: 1000, value: 0.5 },
    { at: 1000, value: 0 },
  ]);
  assert.deepEqual(param.events, [
    ["set", 0.5, 1000],
    ["set", 0, 1000],
  ]);
});

// --- 离线渲染 ---

class FakeSource {
  constructor() {
    this.buffer = null;
    this.loop = false;
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

class FakeGain {
  constructor() {
    this.gain = fakeParam();
  }

  connect(node) {
    return node;
  }
}

class FakeOscillator {
  constructor() {
    this.type = "sine";
    this.frequency = fakeParam();
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
  static last = null;

  constructor(channels, frames, sampleRate) {
    this.channels = channels;
    this.frames = frames;
    this.sampleRate = sampleRate;
    this.destination = { kind: "destination" };
    this.sources = [];
    this.gains = [];
    this.oscs = [];
    this.decodes = 0;
    FakeContext.last = this;
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator() {
    const osc = new FakeOscillator();
    this.oscs.push(osc);
    return osc;
  }

  async decodeAudioData() {
    this.decodes += 1;
    return {
      duration: 30,
      numberOfChannels: 2,
      length: 10,
      getChannelData: () => new Float32Array(10),
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

test("renderAudio decodes each file once and schedules every segment", async () => {
  const loaded = [];
  const buffer = await renderAudio({
    voices: [
      { id: "a", path: "bgm.mp3", startMs: 0, stopMs: 5000, loop: true, gain: [{ at: 0, value: 0.4 }] },
      { id: "b", path: "bgm.mp3", startMs: 1000, stopMs: null, loop: false, gain: [{ at: 1000, value: 0.2 }] },
    ],
    durationMs: 2000,
    loadAudio: async (path) => {
      loaded.push(path);
      return new ArrayBuffer(4);
    },
    AudioContextClass: FakeContext,
  });

  const context = FakeContext.last;
  assert.equal(context.channels, AUDIO_CHANNELS);
  assert.equal(context.frames, Math.ceil(2 * AUDIO_SAMPLE_RATE));
  assert.deepEqual(loaded, ["bgm.mp3"], "同一个文件只读一次");
  assert.equal(context.decodes, 1);

  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].loop, true);
  assert.equal(context.sources[0].started, 0);
  assert.equal(context.sources[0].stopped, 2, "5 秒的段被影片长度截断");
  assert.equal(context.sources[1].started, 1);
  assert.equal(context.sources[1].stopped, 2);
  assert.deepEqual(context.gains[1].gain.events, [["set", 0.2, 1000]]);

  assert.equal(buffer.length, context.frames);
});

test("renderAudio skips a segment whose file cannot be read", async () => {
  const buffer = await renderAudio({
    voices: [
      { id: "a", path: "missing.mp3", startMs: 0, stopMs: null, loop: false, gain: [] },
      { id: "b", path: "ok.mp3", startMs: 100, stopMs: null, loop: false, gain: [] },
    ],
    durationMs: 1000,
    loadAudio: async (path) => {
      if (path === "missing.mp3") {
        throw new Error("读不到");
      }
      return new ArrayBuffer(4);
    },
    AudioContextClass: FakeContext,
  });
  const context = FakeContext.last;
  assert.equal(context.sources.length, 1, "坏文件只丢自己那一段");
  assert.equal(buffer.length, context.frames);
});

test("renderAudio refuses an environment without OfflineAudioContext", async () => {
  await assert.rejects(
    () =>
      renderAudio({
        voices: [],
        durationMs: 100,
        loadAudio: async () => new ArrayBuffer(0),
        AudioContextClass: null,
      }),
    /OfflineAudioContext/,
  );
});

// --- 编码 ---

class FakeAudioData {
  constructor(options) {
    this.options = options;
    FakeAudioData.last = this;
  }

  close() {
    this.closed = true;
  }
}

class FakeAudioEncoder {
  static last = null;

  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.fed = [];
    this.closed = false;
    FakeAudioEncoder.last = this;
  }

  configure(config) {
    this.config = config;
  }

  encode(data) {
    this.fed.push(data);
  }

  async flush() {
    const sizes = [5, 7];
    sizes.forEach((size, index) => {
      const bytes = new Uint8Array(size).fill(index + 1);
      this.output(
        {
          byteLength: size,
          type: "key",
          copyTo(target) {
            target.set(bytes);
          },
        },
        index === 0
          ? { decoderConfig: { description: Uint8Array.from([0x11, 0x90]).buffer } }
          : undefined,
      );
    });
  }

  close() {
    this.closed = true;
  }
}

function fakeBuffer(frames = 6000) {
  const channels = [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)];
  return {
    length: frames,
    numberOfChannels: 2,
    getChannelData: (index) => channels[index],
  };
}

test("encodeAudio configures AAC and concatenates the encoder's chunks", async () => {
  const encoded = await encodeAudio({
    buffer: fakeBuffer(6000),
    AudioEncoderClass: FakeAudioEncoder,
    AudioDataClass: FakeAudioData,
  });

  const encoder = FakeAudioEncoder.last;
  assert.deepEqual(encoder.config, {
    codec: AUDIO_CODEC,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  });
  // 6000 帧按 4800 一块喂：两块，第二块 1200 帧。
  assert.deepEqual(
    encoder.fed.map((data) => data.options.numberOfFrames),
    [4800, 1200],
  );
  assert.equal(encoder.fed[0].options.format, "f32-planar");
  assert.equal(encoder.fed[0].options.data.length, 4800 * 2);
  assert.equal(encoder.closed, true);

  assert.deepEqual(encoded.samples, [5, 7]);
  assert.equal(encoded.data.length, 12);
  assert.deepEqual([...encoded.data], [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual([...encoded.description], [0x11, 0x90]);
  assert.equal(encoded.sampleRate, AUDIO_SAMPLE_RATE);
  assert.equal(encoded.channels, AUDIO_CHANNELS);
  assert.equal(encoded.bitrate, AUDIO_BITRATE);
});

test("encodeAudio surfaces an encoder error instead of silently writing nothing", async () => {
  class BrokenEncoder {
    constructor() {
      throw new Error("编码器初始化失败");
    }
  }
  await assert.rejects(
    () =>
      encodeAudio({
        buffer: fakeBuffer(1024),
        AudioEncoderClass: BrokenEncoder,
        AudioDataClass: FakeAudioData,
      }),
    /编码器初始化失败/,
  );
});

// --- 一次构建 ---

test("buildAudioTrack returns nothing when the script never plays a sound", async () => {
  const recorder = createAudioRecorder({ clock: createVirtualClock() });
  recorder.audio(["bgm.mp3"], {});
  const built = await buildAudioTrack({
    recorder,
    durationMs: 1000,
    loadAudio: async () => new ArrayBuffer(4),
  });
  assert.deepEqual(built, { track: null, warning: null });
});

test("buildAudioTrack mixes and encodes one track for the movie", async () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  const bgm = recorder.audio(["bgm.mp3", 0.5, true], { assignee: "bgm" });
  bgm.play();
  clock.tickMs(3000);

  const built = await buildAudioTrack({
    recorder,
    durationMs: 3000,
    loadAudio: async () => new ArrayBuffer(8),
    AudioContextClass: FakeContext,
    AudioEncoderClass: FakeAudioEncoder,
    AudioDataClass: FakeAudioData,
  });
  assert.equal(built.warning, null);
  assert.equal(built.track.sampleRate, AUDIO_SAMPLE_RATE);
  assert.deepEqual(built.track.samples, [5, 7]);
  assert.deepEqual([...built.track.description], [0x11, 0x90]);
});

test("buildAudioTrack degrades to a silent movie and explains why", async () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  recorder.audio(["bgm.mp3"], {}).play();

  const built = await buildAudioTrack({
    recorder,
    durationMs: 1000,
    loadAudio: async () => new ArrayBuffer(4),
    AudioContextClass: null,
  });
  assert.equal(built.track, null);
  assert.match(built.warning, /音频没有进成片/);
});

// --- 素材读不到时必须看得见 ---

const videoVoice = () => [
  {
    kind: "Video",
    path: "opening.mp4",
    startMs: 0,
    stopMs: null,
    loop: false,
    gain: [{ at: 0, value: 1 }],
    offsetMs: 0,
    rate: 1,
  },
];

test("renderAudio reports a video segment whose bytes cannot be read", async () => {
  const missing = [];
  await renderAudio({
    voices: videoVoice(),
    durationMs: 1000,
    loadAudio: null,
    loadVideo: async () => {
      throw new Error("CSP 拒绝了 data: URL");
    },
    AudioContextClass: FakeContext,
    onMissing: (voice, error) => missing.push([voice.path, error.message]),
  });
  assert.deepEqual(missing, [["opening.mp4", "CSP 拒绝了 data: URL"]]);
});

test("renderAudio reports a video segment when loadVideo is not wired at all", async () => {
  const missing = [];
  await renderAudio({
    voices: videoVoice(),
    durationMs: 1000,
    loadAudio: null,
    AudioContextClass: FakeContext,
    onMissing: (voice, error) => missing.push(error.message),
  });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /loadVideo/);
});

test("buildAudioTrack refuses to write a fake silent track when every segment fails", async () => {
  const built = await buildAudioTrack({
    recorder: null,
    video: { voices: videoVoice },
    durationMs: 1000,
    loadVideo: async () => {
      throw new Error("CSP 拒绝了 data: URL");
    },
    AudioContextClass: FakeContext,
    AudioEncoderClass: FakeAudioEncoder,
    AudioDataClass: FakeAudioData,
  });
  assert.equal(built.track, null, "全静音 PCM 不该当成一条有效音轨写进成片");
  assert.match(built.warning, /opening\.mp4/);
  assert.match(built.warning, /CSP/);
});

test("buildAudioTrack keeps what decoded and warns about the rest", async () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  recorder.audio(["bgm.mp3"], {}).play();

  const built = await buildAudioTrack({
    recorder,
    video: { voices: videoVoice },
    durationMs: 1000,
    loadAudio: async () => new ArrayBuffer(8),
    loadVideo: async () => {
      throw new Error("解不了这个容器");
    },
    AudioContextClass: FakeContext,
    AudioEncoderClass: FakeAudioEncoder,
    AudioDataClass: FakeAudioData,
  });
  assert.ok(built.track, "能解的声音仍要进成片");
  assert.match(built.warning, /部分声音没有进成片/);
  assert.match(built.warning, /opening\.mp4/);
});

// --- 自动配音（stage.autoVoice）---

test("录音器把 stage.autoVoice 记成 synth 事件（含速度），hasSound 认得", () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  recorder.audio.autoVoice(6);
  assert.deepEqual(recorder.events, [{ kind: "synth", at: 0, chars: 6, speed: 10 }]);
  assert.equal(recorder.hasSound(), true, "只有合成效果音也应产出音轨");
});

test("planAudio 把 synth 事件转成合成声段，时长按次数与速度", () => {
  const { voices } = planAudio({
    events: [{ kind: "synth", at: 100, chars: 6 }],
    sounds: new Map(),
  });
  assert.equal(voices.length, 1);
  const voice = voices[0];
  assert.equal(voice.kind, "Synth");
  assert.equal(voice.startMs, 100);
  assert.equal(voice.speed, 10, "默认速度 10 次/秒");
  // 6 字 → 3 次，间隔 1000/10 ms：3 * (1000/10) = 300ms。
  assert.equal(voice.stopMs, 100 + 3 * (1000 / 10));
  assert.deepEqual(voice.gain, [{ at: 100, value: 1 }]);
});

test("renderAudio 渲染合成声段：按次数加载单位音效并播放", async () => {
  const buffer = await renderAudio({
    voices: [
      { kind: "Synth", id: "synth", chars: 6, speed: 3, startMs: 0, stopMs: 1000, loop: false, gain: [{ at: 0, value: 1 }] },
    ],
    durationMs: 1000,
    AudioContextClass: FakeContext,
    loadClip: async () => new ArrayBuffer(8),
  });
  // 主混音上下文的时长由 durationMs 决定，与合成声段无关。
  assert.equal(buffer.length, Math.ceil((1000 / 1000) * AUDIO_SAMPLE_RATE));
  // 最后一个（合成）上下文上按字数生成了多个单位音效片段。
  const synthContext = FakeContext.last;
  assert.ok(synthContext.sources.length >= 3, "6 字约 3 次效果音");
});

test("buildAudioTrack 仅凭自动配音也能混出一条音轨", async () => {
  const clock = createVirtualClock();
  const recorder = createAudioRecorder({ clock });
  recorder.audio.autoVoice(6);
  const built = await buildAudioTrack({
    recorder,
    durationMs: 1000,
    AudioContextClass: FakeContext,
    AudioEncoderClass: FakeAudioEncoder,
    AudioDataClass: FakeAudioData,
    loadClip: async () => new ArrayBuffer(8),
  });
  assert.ok(built.track, "只有合成效果音也应产出音轨");
  assert.equal(built.warning, null);
});
