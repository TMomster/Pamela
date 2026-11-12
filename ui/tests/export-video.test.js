// 导出时的视频声轨：播放头 → 可听段 → 混音（全部注入假实现）。
// A video's sound in the exported movie: playhead, audible spans, mix.

import assert from "node:assert/strict";
import test from "node:test";

import { buildAudioTrack, renderAudio } from "../export-audio.js";
import { createVirtualClock } from "../export-clock.js";
import { createRecordGlobals } from "../export-stage.js";
import { createTimeline, stateAt } from "../export-timeline.js";
import { createVideoRecorder } from "../export-video.js";

function harness() {
  const clock = createVirtualClock();
  const recorder = createVideoRecorder({ clock });
  return { clock, recorder };
}

// --- 播放头 ---

test("Video is silent until the script unmutes it, like the stage", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4"], {});
  clip.play();
  clock.tickMs(2000);
  assert.deepEqual(recorder.voices(), [], "默认静音，没有可听的段");

  clip.mute(false);
  clock.tickMs(1000);
  const voices = recorder.voices();
  assert.equal(voices.length, 1);
  assert.equal(voices[0].startMs, 2000, "解除静音处开口");
  assert.equal(voices[0].offsetMs, 2000, "素材已经从 2 秒处走过");
});

test("mute = false in the constructor is the same as calling mute(false)", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4", 0.6, false, false], {});
  clip.play();
  clock.tickMs(500);

  const [voice] = recorder.voices();
  assert.equal(voice.kind, "Video");
  assert.equal(voice.path, "opening.mp4");
  assert.equal(voice.startMs, 0);
  assert.equal(voice.offsetMs, 0);
  assert.equal(voice.rate, 1);
  assert.equal(voice.loop, false);
  assert.deepEqual(voice.gain, [{ at: 0, value: 0.6 }]);
  assert.equal(voice.stopMs, Number.POSITIVE_INFINITY);
});

test("pause keeps the playhead, play resumes from there", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4", 1, false, false], {});

  clip.play();
  clock.tickMs(2000);
  clip.pause();
  clock.tickMs(1000);
  clip.play();
  clock.tickMs(1000);

  const [first, second] = recorder.voices();
  assert.equal(first.startMs, 0);
  assert.equal(first.stopMs, 2000);
  assert.equal(second.startMs, 3000, "暂停的一秒不推进素材");
  assert.equal(second.offsetMs, 2000, "从暂停处接着放");
});

test("enable restarts from the beginning instead of resuming", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4", 1, false, false], {});

  clip.play();
  clock.tickMs(2000);
  clip.enable();
  clock.tickMs(1000);

  const [first, second] = recorder.voices();
  assert.equal(first.stopMs, 2000);
  assert.equal(second.startMs, 2000);
  assert.equal(second.offsetMs, 0, "enable 从头播放");
});

test("disabling the audio track silences it without stopping the picture", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4", 1, false, false], {});

  clip.play();
  clock.tickMs(1000);
  clip.audio.disable();
  clock.tickMs(1000);
  clip.audio.enable();
  clock.tickMs(1000);

  const [first, second] = recorder.voices();
  assert.equal(first.stopMs, 1000);
  assert.equal(second.startMs, 2000);
  assert.equal(second.offsetMs, 2000, "静音期间素材照常走");
});

test("speed scales how far the media moves and cuts the span at the change", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4", 1, false, false], {});

  clip.play();
  clock.tickMs(1000);
  clip.speedTo(2);
  clock.tickMs(1000);
  clip.pause();

  const [slow, fast] = recorder.voices();
  assert.equal(slow.rate, 1);
  assert.equal(slow.stopMs, 1000);
  assert.equal(fast.rate, 2);
  assert.equal(fast.offsetMs, 1000, "换速处接着当前素材位置");
  assert.equal(fast.stopMs, 2000);

  // 恢复播放：2 倍速下走 1 秒等于素材 2 秒。
  clip.play();
  clock.tickMs(1000);
  clip.pause();
  const resumed = recorder.voices()[2];
  assert.equal(resumed.offsetMs, 3000);
  assert.equal(resumed.rate, 2);
});

test("volume writes a fade into the span's gain curve and waits like the stage", () => {
  const { clock, recorder } = harness();
  const context = { pending: [] };
  const clip = recorder.video(["opening.mp4", 0.8, false, false], context);

  clip.play();
  clock.tickMs(1000);
  clip.volume(0.2, 500);
  assert.equal(context.pending.length, 1, "带时间的音量变化占住这段时间");
  clock.tickMs(1000);

  const [voice] = recorder.voices();
  assert.deepEqual(voice.gain, [
    { at: 0, value: 0.8 },
    { at: 1000, value: 0.8 },
    { at: 1500, value: 0.2 },
  ]);
});

test("loop is carried to the span so the source can repeat", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4", 1, false, false], {});
  clip.play();
  clip.loop();
  clock.tickMs(500);
  assert.equal(recorder.voices()[0].loop, true);
});

test("a Video with no file name is refused like on the stage", () => {
  const { recorder } = harness();
  assert.throws(() => recorder.video([""], {}), /视频文件名/);
  assert.throws(() => recorder.video(["opening.mp4", 1, false, false], {}).speedTo(0), /速度/);
});

test("mediaTimeAt follows the playhead through play, pause and rate", () => {
  const { clock, recorder } = harness();
  const clip = recorder.video(["opening.mp4", 1, false, true], { assignee: "clip" });

  assert.equal(recorder.mediaTimeAt("video:clip", 500), 0, "还没开始播放");

  clip.play();
  clock.tickMs(1000);
  assert.equal(recorder.mediaTimeAt("video:clip", 500), 500);

  clip.pause();
  clock.tickMs(1000);
  assert.equal(recorder.mediaTimeAt("video:clip", 2500), 1000, "暂停后停在收尾处");

  clip.play();
  clip.speedTo(2);
  clock.tickMs(1000);
  assert.equal(recorder.mediaTimeAt("video:clip", 3000), 3000, "2 倍速外推");
});

test("loopsAt reports whether the playhead repeats the file", () => {
  const { recorder } = harness();
  const clip = recorder.video(["opening.mp4", 1, false, true], { assignee: "clip" });
  clip.play();
  clip.loop();
  assert.equal(recorder.loopsAt("video:clip", 100), true);
  clip.once();
  assert.equal(recorder.loopsAt("video:clip", 100), false);
  assert.equal(recorder.loopsAt("video:other", 100), false, "没建过的对象当作不循环");
});

// --- 录制舞台 ---

test("Video objects go to the video recorder and stay chainable", () => {
  const clock = createVirtualClock();
  const timeline = createTimeline();
  const recorder = createVideoRecorder({ clock });
  const globals = createRecordGlobals({ clock, timeline }, { videoRecorder: recorder });
  const { stage } = globals({ pending: [], assignee: "clip" });

  const clip = stage.Video("opening.mp4", 1, false, false);
  clip.play().move(10, 20).scale(2).show();
  clip.audio.volume(0.5);
  clock.tickMs(500);

  const [voice] = recorder.voices();
  assert.equal(voice.path, "opening.mp4");
  assert.equal(voice.gain.at(-1).value, 0.5);

  // 画面也进了时间线：渲染后端按 video:clip 这一层取帧。
  const picture = stateAt(timeline, 500)["video:clip"];
  assert.equal(picture.path, "opening.mp4");
  assert.equal(picture.visible, true);
  assert.equal(picture.x, 10);
  assert.equal(picture.scale, 2);
  assert.equal(recorder.mediaTimeAt("video:clip", 500), 500);

  // 画面轨上的滤镜与调色落在同一层记录上。
  clip.media.blur(3).hex("#204060");
  const tuned = stateAt(timeline, 500)["video:clip"];
  assert.equal(tuned.look.blur, 3);
  assert.deepEqual(tuned.tint, { r: 32, g: 64, b: 96 });
});

// --- 混音 ---

class FakeSource {
  constructor() {
    this.buffer = null;
    this.loop = false;
    this.playbackRate = { value: 1 };
    this.started = null;
    this.offset = null;
    this.stopped = null;
  }

  connect(node) {
    return node;
  }

  start(at, offset) {
    this.started = at;
    this.offset = offset ?? 0;
  }

  stop(at) {
    this.stopped = at;
  }
}

class FakeGain {
  constructor() {
    this.gain = { events: [], setValueAtTime(value, at) { this.events.push(["set", value, Math.round(at * 1000)]); }, linearRampToValueAtTime(value, at) { this.events.push(["ramp", value, Math.round(at * 1000)]); } };
  }

  connect(node) {
    return node;
  }
}

class FakeContext {
  static last = null;

  constructor(channels, frames, sampleRate) {
    this.frames = frames;
    this.sources = [];
    FakeContext.last = this;
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createGain() {
    return new FakeGain();
  }

  async decodeAudioData() {
    return {
      duration: 10,
      numberOfChannels: 2,
      length: 10,
      getChannelData: () => new Float32Array(10),
    };
  }

  async startRendering() {
    return {
      length: this.frames,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(this.frames),
    };
  }
}

test("renderAudio starts a video segment at its media offset and rate", async () => {
  const loaded = [];
  await renderAudio({
    voices: [
      {
        kind: "Video",
        id: "video-1",
        path: "opening.mp4",
        startMs: 3000,
        stopMs: 5000,
        offsetMs: 2000,
        rate: 2,
        loop: false,
        gain: [{ at: 3000, value: 1 }],
      },
    ],
    durationMs: 6000,
    loadAudio: async () => {
      throw new Error("视频不该走音频读取");
    },
    loadVideo: async (path) => {
      loaded.push(path);
      return new ArrayBuffer(8);
    },
    AudioContextClass: FakeContext,
  });

  const context = FakeContext.last;
  assert.deepEqual(loaded, ["opening.mp4"]);
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].started, 3);
  assert.equal(context.sources[0].offset, 2, "从素材第 2 秒开始");
  assert.equal(context.sources[0].playbackRate.value, 2);
  assert.equal(context.sources[0].stopped, 5);
});

test("a looping video segment wraps its offset into the decoded file", async () => {
  await renderAudio({
    voices: [
      {
        kind: "Video",
        id: "video-1",
        path: "short.mp4",
        startMs: 0,
        stopMs: Number.POSITIVE_INFINITY,
        offsetMs: 25_000,
        rate: 1,
        loop: true,
        gain: [{ at: 0, value: 1 }],
      },
    ],
    durationMs: 2000,
    loadAudio: null,
    loadVideo: async () => new ArrayBuffer(8),
    AudioContextClass: FakeContext,
  });
  assert.equal(FakeContext.last.sources[0].offset, 5, "25 秒对 10 秒的素材取余");
});

class FakeAudioData {
  constructor(options) {
    this.options = options;
  }

  close() {}
}

class FakeAudioEncoder {
  constructor({ output }) {
    this.output = output;
  }

  configure() {}

  encode(data) {
    this.output(
      { byteLength: 4, copyTo: (bytes) => bytes.fill(0) },
      { decoderConfig: { description: new Uint8Array([0x12, 0x10]) } },
    );
    this.last = data;
  }

  async flush() {}

  close() {}
}

test("buildAudioTrack mixes a video's sound even with no Audio objects", async () => {
  const clock = createVirtualClock();
  const video = createVideoRecorder({ clock });
  const clip = video.video(["opening.mp4", 1, false, false], {});
  clip.play();
  clock.tickMs(1000);

  const built = await buildAudioTrack({
    recorder: null,
    video,
    durationMs: 1000,
    loadAudio: null,
    loadVideo: async () => new ArrayBuffer(8),
    AudioContextClass: FakeContext,
    AudioEncoderClass: FakeAudioEncoder,
    AudioDataClass: FakeAudioData,
  });

  assert.equal(built.warning, null);
  assert.ok(built.track, "视频声轨编出了一条音轨");
  assert.equal(built.track.sampleRate, 48_000);
  assert.equal(built.track.channels, 2);
});
