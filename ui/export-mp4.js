// 离屏逐帧导出的输出侧：帧循环 → WebCodecs 编码 → 流式写盘。
// Pamela — the output half of the offline exporter: frames, encoder, IPC.
//
// 帧源是 `(state, t) => canvas`；渲染后端与表演驱动都是注入项，本模块只负责
// 按虚拟时钟逐帧取值、编码、把每一帧按顺序 append 给 Rust 会话。
//
// M0 探针结论：1080p 必须用 avc1.640028（High L4.0），Baseline 3.x 被拒。
// `avc: { format: "avc" }` 让编码器产出 MP4 需要的 AVCC 长度前缀 NAL。

import { flushMicrotasks } from "./export-clock.js";

/** 1080p/30fps 的实测可用 codec；见 `tools/probe-export.mjs`。 */
export const EXPORT_CODEC = "avc1.640028";

/** 后端命令名，集中在这里以便和 `project-actions.js` 的接线对照。 */
export const EXPORT_COMMANDS = Object.freeze({
  begin: "export_begin",
  append: "export_append",
  finish: "export_finish",
  abort: "export_abort",
});

export const DEFAULT_EXPORT = Object.freeze({
  path: "exports/export.mp4",
  width: 1920,
  height: 1080,
  fps: 30,
  timescale: 30000,
  bitrate: 8_000_000,
  keyFrameEvery: 60,
  maxFrames: 108_000, // 30fps 下一小时的保护上限
  /** 每渲染多少帧回报一次进度；界面再从这些回调里挑节流。 */
  progressEvery: 30,
});

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 纯函数 base64：不依赖 btoa / Buffer，浏览器与 Node 都能跑。 */
export function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? BASE64[c & 63] : "=";
  }
  return out;
}

/** `decoderConfig.description` 可能是 ArrayBuffer 或 TypedArray。 */
export function descriptionBytes(description) {
  if (!description) {
    return null;
  }
  if (description instanceof Uint8Array) {
    return new Uint8Array(description);
  }
  if (description instanceof ArrayBuffer) {
    return new Uint8Array(description);
  }
  if (description.buffer) {
    return new Uint8Array(
      description.buffer,
      description.byteOffset ?? 0,
      description.byteLength,
    );
  }
  return null;
}

/** 编码器的配置对象，单独导出以便探针与导出共用。 */
export function encoderConfig(config) {
  return {
    codec: EXPORT_CODEC,
    width: config.width,
    height: config.height,
    bitrate: config.bitrate,
    framerate: config.fps,
    avc: { format: "avc" },
  };
}

/**
 * 建立一个 WebCodecs 编码器；`output` 与 `error` 由调用方给。
 * 注入 `VideoEncoderClass` 是为了让纯逻辑测试不必依赖真浏览器。
 */
export async function createVideoEncoder({ config, output, error, VideoEncoderClass }) {
  const Impl = VideoEncoderClass ?? globalThis.VideoEncoder;
  if (typeof Impl !== "function") {
    throw new Error("当前环境不支持 WebCodecs VideoEncoder");
  }
  const wanted = encoderConfig(config);
  const support = await Impl.isConfigSupported(wanted);
  if (!support?.supported) {
    throw new Error(`当前环境不支持 ${EXPORT_CODEC} 编码`);
  }
  const encoder = new Impl({ output, error });
  encoder.configure(wanted);
  return encoder;
}

/**
 * 逐帧循环。先画当前 t，再 `clock.tick()` 让解释器推进到下一个 await 点。
 *
 * @param {object} options
 * @param {object} options.clock 虚拟时钟
 * @param {object} [options.cursor] 时间线游标，可为 null
 * @param {(state: object|null, t: number) => unknown} options.frameSource
 *   可以返回 Promise（视频帧要等 seek），循环会等它交出画面
 * @param {(source: unknown, t: number, index: number) => Promise<void>|void} options.onFrame
 * @param {() => boolean} options.shouldStop
 * @param {() => Promise<void>} [options.flush]
 * @param {number} [options.maxFrames]
 * @returns {Promise<number>} 渲染帧数
 */
export function createFrameLoop({
  clock,
  cursor = null,
  frameSource,
  onFrame,
  shouldStop,
  flush = flushMicrotasks,
  maxFrames = DEFAULT_EXPORT.maxFrames,
}) {
  return async function loop() {
    let frames = 0;
    for (;;) {
      if (frames >= maxFrames) {
        throw new Error(`导出帧数超过上限 ${maxFrames}`);
      }
      const t = clock.now();
      const state = cursor ? cursor.at(t) : null;
      // 渲染后端在有视频时是异步的：先等它交出画面，再编码这一帧。
      const source = await frameSource(state, t);
      await onFrame(source, t, frames);
      frames += 1;
      if (shouldStop({ frames, t })) {
        return frames;
      }
      clock.tick();
      await flush();
    }
  };
}

/**
 * 编排一次导出。`performance()` 返回一个 Promise（脚本演出），它与帧循环
 * 并发：解释器被 `clock.wait` 停住，只有 `clock.tick()` 才继续。
 *
 * @param {object} options
 * @param {(command: string, args: object) => Promise<unknown>} options.invoke
 * @param {object} options.clock
 * @param {(state: object|null, t: number) => unknown} options.frameSource
 * @param {() => Promise<unknown>} [options.performance]
 * @param {object} [options.cursor]
 * @param {object} [options.encoder] 注入的编码器（测试用）
 * @param {Function} [options.VideoFrameClass]
 * @param {Function} [options.VideoEncoderClass]
 * @param {() => Promise<void>} [options.flush]
 * @param {() => boolean} [options.shouldStopOverride]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {(text: string) => void} [options.onStatus] 阶段提示（混音、收尾）
 * @param {(info: {frames: number, durationMs: number}) => Promise<object>} [options.audioTrack]
 *   帧循环结束后构建音轨；缺省表示成片不带声音
 */
export function createExporter({
  invoke,
  clock,
  frameSource,
  performance = () => Promise.resolve(),
  cursor = null,
  config: overrides = {},
  commands = EXPORT_COMMANDS,
  encoder = null,
  VideoFrameClass,
  VideoEncoderClass,
  flush = flushMicrotasks,
  shouldStopOverride = null,
  /** 时间线末端（毫秒）；帧循环至少画到这里，避免裸 cue 的动画被裁掉。 */
  duration = () => 0,
  onProgress = () => {},
  onStatus = () => {},
  audioTrack = null,
  /** 分项计时（encode / append）；null 表示不计时。 */
  metrics = null,
}) {
  const config = { ...DEFAULT_EXPORT, ...overrides };
  const Frame = VideoFrameClass ?? globalThis.VideoFrame;
  const sampleDelta = Math.round(config.timescale / config.fps);
  const frameDurationUs = Math.round(1_000_000 / config.fps);
  const progressEvery = Math.max(1, Math.round(Number(config.progressEvery) || 30));

  let cancelled = false;
  let done = false;
  let sessionId = null;
  let description = null;
  let encoderError = null;
  let appendChain = Promise.resolve();
  let appendCount = 0;
  let byteCount = 0;

  /** 串行 append，保证 mdat 里的样本顺序等于编码顺序。 */
  function enqueueAppend(bytes, keyframe) {
    appendChain = appendChain.then(async () => {
      // base64 编码也算进「写盘」这一段：它是每帧固定开销的一部分。
      const send = () =>
        invoke(commands.append, {
          id: sessionId,
          data: bytesToBase64(bytes),
          keyframe,
        });
      if (metrics) {
        await metrics.call("append", send);
      } else {
        await send();
      }
      appendCount += 1;
      byteCount += bytes.length;
    });
  }

  function onChunk(chunk, meta) {
    if (!description && meta?.decoderConfig?.description) {
      description = descriptionBytes(meta.decoderConfig.description);
    }
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    enqueueAppend(bytes, chunk.type === "key");
  }

  return {
    cancel() {
      cancelled = true;
    },
    isCancelled: () => cancelled,

    async start() {
      const wallStart = metrics ? metrics.now() : 0;
      let performanceError = null;
      if (typeof Frame !== "function") {
        throw new Error("当前环境不支持 VideoFrame");
      }
      const running = performance();
      Promise.resolve(running).then(
        () => {
          done = true;
        },
        (error) => {
          done = true;
          performanceError = error instanceof Error ? error : new Error(String(error));
        },
      );

      const active =
        encoder ??
        (await createVideoEncoder({
          config,
          output: onChunk,
          error: (error) => {
            encoderError = error instanceof Error ? error : new Error(String(error));
          },
          VideoEncoderClass,
        }));
      // 测试注入的编码器需要事后接上 output 回调。
      if (encoder && typeof active.setOutput === "function") {
        active.setOutput(onChunk);
      }

      // Tauri v2 默认把 Rust 参数 `sample_delta` 暴露成 camelCase 的 `sampleDelta`；
      // 传 snake_case 会被后端判定为缺少必填参数。
      sessionId = await invoke(commands.begin, {
        path: config.path,
        width: config.width,
        height: config.height,
        timescale: config.timescale,
        sampleDelta,
      });

      const shouldStop = shouldStopOverride
        ? (info) => shouldStopOverride(info) || cancelled
        : ({ t }) =>
            cancelled || (done && clock.pending() === 0 && t >= (Number(duration()) || 0));

      const loop = createFrameLoop({
        clock,
        cursor,
        frameSource,
        flush,
        maxFrames: config.maxFrames,
        shouldStop,
        onFrame: (source, t, index) => {
          const encodeFrame = async () => {
            const frame = new Frame(source, {
              timestamp: Math.round(t * 1000), // ms → µs
              duration: frameDurationUs,
            });
            active.encode(frame, { keyFrame: index % config.keyFrameEvery === 0 });
            frame.close();
            await flush();
            // 编码队列不能无限堆积；output 是同步回调，flush 微任务即可让出。
            while (active.encodeQueueSize > 3) {
              await flush();
            }
            if (index % progressEvery === 0) {
              onProgress({ frames: index + 1, t, bytes: byteCount });
            }
          };
          return metrics ? metrics.call("encode", encodeFrame) : encodeFrame();
        },
      });

      let frames = 0;
      try {
        frames = await loop();
        if (performanceError) {
          throw performanceError;
        }
        await active.flush();
        await flush();
        await appendChain;
        if (cancelled) {
          await invoke(commands.abort, { id: sessionId });
          return { frames, path: null, cancelled: true };
        }
        if (encoderError) {
          throw encoderError;
        }
        if (!description) {
          throw new Error("编码器没有给出 avcC（decoderConfig.description）");
        }

        // 音频要等演出走完才知道有哪些声音，所以放在收尾前一次建好；长度取
        // 已渲染的帧数，与画面严格同长。混音失败不影响静音成片。
        let audio = null;
        let warning = null;
        if (audioTrack) {
          onStatus("正在混音音频…");
          const built = await audioTrack({
            frames,
            durationMs: (frames * 1000) / config.fps,
          });
          audio = built?.track ?? null;
          warning = built?.warning ?? null;
          if (cancelled) {
            await invoke(commands.abort, { id: sessionId });
            return { frames, path: null, cancelled: true };
          }
        }

        onStatus("正在写入文件…");
        const path = await invoke(commands.finish, {
          id: sessionId,
          avcc: bytesToBase64(description),
          audio: audio
            ? {
                data: bytesToBase64(audio.data),
                samples: audio.samples,
                sampleRate: audio.sampleRate,
                channels: audio.channels,
                bitrate: audio.bitrate,
                asc: bytesToBase64(audio.description),
              }
            : null,
        });
        return {
          frames,
          path,
          bytes: byteCount,
          appended: appendCount,
          audioBytes: audio ? audio.data.length : 0,
          warning,
          metrics: metrics
            ? metrics.snapshot({ frames, elapsedMs: metrics.now() - wallStart })
            : null,
        };
      } catch (error) {
        await invoke(commands.abort, { id: sessionId }).catch(() => {});
        throw error;
      } finally {
        active.close?.();
      }
    },
  };
}
