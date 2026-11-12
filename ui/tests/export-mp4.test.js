// 输出侧纯逻辑：base64、帧循环、编码与 IPC 编排（全部注入假实现）。
// Output pipeline with fake encoder / invoke / clock.

import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualClock, flushMicrotasks } from "../export-clock.js";
import { createExportMetrics } from "../export-metrics.js";
import {
  bytesToBase64,
  createExporter,
  createFrameLoop,
  createVideoEncoder,
  descriptionBytes,
  encoderConfig,
  EXPORT_CODEC,
  DEFAULT_EXPORT,
} from "../export-mp4.js";

const AVC_C = [1, 0x64, 0, 0x28, 0xff];
const FRAME_BYTES = [1, 2, 3, 4];

test("bytesToBase64 matches Buffer for every padding case", () => {
  for (const bytes of [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [0, 255, 128, 7, 9]]) {
    const input = Uint8Array.from(bytes);
    assert.equal(bytesToBase64(input), Buffer.from(input).toString("base64"));
  }
});

test("descriptionBytes accepts ArrayBuffer and TypedArray", () => {
  const buffer = Uint8Array.from(AVC_C).buffer;
  assert.deepEqual([...descriptionBytes(buffer)], AVC_C);
  assert.deepEqual([...descriptionBytes(new Uint8Array(buffer))], AVC_C);
  assert.equal(descriptionBytes(null), null);
});

test("encoderConfig uses the codec the M0 probe proved works at 1080p", () => {
  const config = encoderConfig(DEFAULT_EXPORT);
  assert.equal(config.codec, EXPORT_CODEC);
  assert.equal(config.width, 1920);
  assert.equal(config.height, 1080);
  assert.equal(config.framerate, 30);
  assert.deepEqual(config.avc, { format: "avc" });
});

test("createVideoEncoder rejects an unsupported configuration", async () => {
  class Unsupported {
    static async isConfigSupported() {
      return { supported: false };
    }
  }
  await assert.rejects(
    () =>
      createVideoEncoder({
        config: DEFAULT_EXPORT,
        output: () => {},
        error: () => {},
        VideoEncoderClass: Unsupported,
      }),
    /不支持/,
  );
});

test("the frame loop paints t=0 first and stops on the injected condition", async () => {
  const clock = createVirtualClock();
  const ticks = [];
  const loop = createFrameLoop({
    clock,
    frameSource: (_state, t) => ({ t }),
    flush: flushMicrotasks,
    shouldStop: ({ frames }) => frames >= 4,
    onFrame: async (source, t) => {
      ticks.push(Math.round(t * 30));
      assert.ok(Math.abs(source.t - t) < 1e-9);
    },
  });
  assert.equal(await loop(), 4);
  assert.deepEqual(ticks, [0, 1000, 2000, 3000]);
});

test("the frame loop refuses to run away", async () => {
  const loop = createFrameLoop({
    clock: createVirtualClock(),
    frameSource: () => ({}),
    flush: flushMicrotasks,
    shouldStop: () => false,
    maxFrames: 3,
    onFrame: () => {},
  });
  await assert.rejects(loop, /帧数超过上限/);
});

class FakeFrame {
  constructor(source, options) {
    this.source = source;
    this.options = options;
    this.timestamp = options.timestamp;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

/** 每帧同步产出一个 chunk，第一帧带 avcC。 */
function fakeEncoder() {
  return {
    encodeQueueSize: 0,
    output: null,
    closed: false,
    frames: [],
    setOutput(fn) {
      this.output = fn;
    },
    encode(frame, options) {
      this.frames.push({ timestamp: frame.timestamp, keyFrame: Boolean(options.keyFrame) });
      this.output?.(
        {
          byteLength: FRAME_BYTES.length,
          type: options.keyFrame ? "key" : "delta",
          timestamp: frame.timestamp,
          copyTo(target) {
            target.set(FRAME_BYTES);
          },
        },
        this.frames.length === 1
          ? { decoderConfig: { description: Uint8Array.from(AVC_C).buffer } }
          : undefined,
      );
    },
    async flush() {},
    close() {
      this.closed = true;
    },
  };
}

function recorder() {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "export_begin") return "job-1";
    if (command === "export_finish") return "exports/export.mp4";
    return undefined;
  };
  return { calls, invoke };
}

test("an export runs begin → append per frame → finish with avcC", async () => {
  const { calls, invoke } = recorder();
  const encoder = fakeEncoder();
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder,
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    shouldStopOverride: ({ frames }) => frames >= 3,
    performance: () => Promise.resolve(),
  });

  const result = await exporter.start();
  assert.equal(result.frames, 3);
  assert.equal(result.appended, 3);
  assert.equal(result.bytes, 12);
  assert.equal(result.path, "exports/export.mp4");
  assert.equal(encoder.closed, true);

  assert.deepEqual(
    calls.map((call) => call.command),
    ["export_begin", "export_append", "export_append", "export_append", "export_finish"],
  );
  assert.equal(calls[0].args.path, "exports/export.mp4");
  assert.equal(calls[0].args.sampleDelta, 1000);
  assert.equal(calls[0].args.timescale, 30000);
  assert.ok(!("sample_delta" in calls[0].args), "Tauri 期望 camelCase 参数名");

  for (const call of calls.slice(1, 4)) {
    assert.equal(call.args.id, "job-1");
    assert.deepEqual([...Buffer.from(call.args.data, "base64")], FRAME_BYTES);
  }
  assert.deepEqual(
    calls.slice(1, 4).map((call) => call.args.keyframe),
    [true, false, false],
  );
  assert.deepEqual([...Buffer.from(calls[4].args.avcc, "base64")], AVC_C);

  // WebCodecs 的时间戳是微秒：33.333ms 一帧。
  assert.deepEqual(
    encoder.frames.map((frame) => frame.timestamp),
    [0, 33333, 66667],
  );
});

test("分项计时记录编码与写盘，并随导出结果一起返回", async () => {
  const { calls, invoke } = recorder();
  let now = 0;
  const metrics = createExportMetrics({ clock: () => (now += 1) });
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder: fakeEncoder(),
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    shouldStopOverride: ({ frames }) => frames >= 3,
    performance: () => Promise.resolve(),
    metrics,
  });

  const result = await exporter.start();
  assert.equal(result.frames, 3);
  assert.equal(calls.length, 5, "埋点不改变 begin / append / finish 的次数");
  assert.equal(result.metrics.stages.encode.calls, 3);
  assert.ok(result.metrics.stages.encode.ms > 0, "编码耗时有累计");
  assert.equal(result.metrics.stages.append.calls, 3);
  assert.ok(result.metrics.stages.append.ms > 0, "写盘耗时有累计");
  assert.ok(result.metrics.elapsedMs > 0);
  assert.equal(result.metrics.avgFrameMs, result.metrics.elapsedMs / 3);
});

test("cancelling an export aborts instead of finishing", async () => {
  const { calls, invoke } = recorder();
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder: fakeEncoder(),
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    shouldStopOverride: ({ frames }) => frames >= 5,
  });
  exporter.cancel();
  const result = await exporter.start();
  assert.equal(result.cancelled, true);
  assert.equal(result.path, null);
  assert.deepEqual(
    calls.map((call) => call.command),
    ["export_begin", "export_append", "export_abort"],
  );
});

test("an append failure aborts and surfaces the error", async () => {
  let count = 0;
  const calls = [];
  const invoke = async (command, args) => {
    calls.push(command);
    if (command === "export_append" && ++count === 2) {
      throw new Error("写盘失败");
    }
    if (command === "export_begin") return "job-1";
    return undefined;
  };
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder: fakeEncoder(),
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    shouldStopOverride: ({ frames }) => frames >= 3,
  });
  await assert.rejects(exporter.start, /写盘失败/);
  assert.equal(calls.at(-1), "export_abort");
});

test("the frame loop paints until the timeline end even after the script is done", async () => {
  const { calls, invoke } = recorder();
  const encoder = fakeEncoder();
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder,
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    duration: () => 2000,
  });

  const result = await exporter.start();
  assert.equal(result.frames, 61);
  assert.equal(encoder.frames.at(-1).timestamp, 2_000_000);
  assert.equal(calls.at(-1).command, "export_finish");
});

test("a failed performance aborts instead of silently finishing the movie", async () => {
  const { calls, invoke } = recorder();
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder: fakeEncoder(),
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    performance: () => Promise.reject(new Error("脚本第 3 行出错")),
    shouldStopOverride: ({ frames }) => frames >= 2,
  });

  await assert.rejects(exporter.start, /脚本第 3 行出错/);
  assert.equal(calls.at(-1).command, "export_abort");
});

test("an export sends the mixed audio track with the finish call", async () => {
  const { calls, invoke } = recorder();
  const asked = [];
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder: fakeEncoder(),
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    shouldStopOverride: ({ frames }) => frames >= 3,
    audioTrack: async (info) => {
      asked.push(info);
      return {
        track: {
          data: Uint8Array.from([1, 2, 3]),
          samples: [1, 2],
          sampleRate: 48_000,
          channels: 2,
          bitrate: 128_000,
          description: Uint8Array.from([0x11, 0x90]),
        },
        warning: null,
      };
    },
  });

  const result = await exporter.start();
  // 3 帧 @30fps = 100 ms；音频长度取画面长度，不是估算值。
  assert.deepEqual(asked, [{ frames: 3, durationMs: 100 }]);

  const finish = calls.at(-1);
  assert.equal(finish.command, "export_finish");
  assert.equal(finish.args.audio.sampleRate, 48_000);
  assert.equal(finish.args.audio.channels, 2);
  assert.equal(finish.args.audio.bitrate, 128_000);
  assert.deepEqual(finish.args.audio.samples, [1, 2]);
  assert.deepEqual([...Buffer.from(finish.args.audio.data, "base64")], [1, 2, 3]);
  assert.deepEqual([...Buffer.from(finish.args.audio.asc, "base64")], [0x11, 0x90]);
  assert.equal(result.audioBytes, 3);
  assert.equal(result.warning, null);
});

test("a silent export passes no audio, and a warning rides along with the result", async () => {
  const { calls, invoke } = recorder();
  const exporter = createExporter({
    invoke,
    clock: createVirtualClock(),
    frameSource: () => ({}),
    encoder: fakeEncoder(),
    VideoFrameClass: FakeFrame,
    flush: flushMicrotasks,
    shouldStopOverride: ({ frames }) => frames >= 2,
    audioTrack: async () => ({ track: null, warning: "音频没有进成片：坏了" }),
  });

  const result = await exporter.start();
  assert.equal(calls.at(-1).args.audio, null);
  assert.equal(result.audioBytes, 0);
  assert.match(result.warning, /音频没有进成片/);
});
