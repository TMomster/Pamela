// 把虚拟时钟、时间线、Canvas2D 后端与编码写盘串成一次完整导出。
// Pamela — assembles the four export modules into one session.
//
// `performance(session)` 是唯一的输入侧注入点：它启动解释器（或任何能往
// `session.timeline` 登记事件、用 `session.clock.wait` 计时的驱动），与帧循环
// 并发运行。这样输出侧可以先独立验证，下一步接真舞台时只需换掉 performance。

import { createAudioRecorder, buildAudioTrack } from "./export-audio.js";
import { createVirtualClock, flushTasks } from "./export-clock.js";
import { createExportMetrics } from "./export-metrics.js";
import { createExporter, DEFAULT_EXPORT } from "./export-mp4.js";
import { createCanvasRenderer } from "./export-render.js";
import { createStateCursor, createTimeline, timelineDuration } from "./export-timeline.js";
import { createVideoFrames } from "./export-video-frames.js";
import { createVideoRecorder } from "./export-video.js";

/**
 * @param {object} options
 * @param {(command: string, args: object) => Promise<unknown>} options.invoke
 * @param {object} options.canvas 离屏画布（1920×1080）
 * @param {Map<string, unknown>} [options.assets] 已解码位图
 * @param {object} [options.plate] 对话框样式文档；缺省时渲染器用内置的简化对白框
 * @param {(session: object) => Promise<unknown>} options.performance
 * @param {object} [options.config]
 * @param {object} [options.commands]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {(text: string) => void} [options.onStatus]
 * @param {boolean} [options.audio] 是否把脚本里的声音混进成片
 * @param {(path: string) => Promise<ArrayBuffer>} [options.loadAudio] 读音频字节
 * @param {(path: string) => Promise<ArrayBuffer>} [options.loadVideo] 读视频字节（取素材声轨）
 * @param {(path: string) => Promise<string>} [options.resolveVideo] 视频名 → data: URL（取画面）
 * @param {object} [options.audioOptions] 传给混音/编码的注入项（测试用）
 * @param {object} [options.metrics] 分项计时器；缺省内置一个，可注入假时钟或空实现
 */
export function createExportSession({
  invoke,
  canvas,
  assets = new Map(),
  plate = null,
  performance,
  config: overrides = {},
  onProgress,
  onStatus,
  audio = false,
  loadAudio = null,
  loadVideo = null,
  resolveVideo = null,
  audioOptions = {},
  metrics: injectedMetrics = null,
  ...exporterOptions
}) {
  const config = { ...DEFAULT_EXPORT, ...overrides };
  const metrics = injectedMetrics ?? createExportMetrics();
  const clock = createVirtualClock({ fps: config.fps, timescale: config.timescale });
  const timeline = createTimeline();
  const cursor = createStateCursor(timeline);

  // 只有真能读文件时才录音：没有读文件的通道就没有混音，脚本里的声音被忽略。
  // 视频声轨要另读 assets/Video/，所以两种读法有一个就够建录制器。
  const wantsSound = audio && Boolean(loadAudio || loadVideo);
  const audioRecorder = wantsSound && loadAudio ? createAudioRecorder({ clock }) : null;
  // 播放头也是画面取帧的依据：只要导出能读视频，就要记。
  const videoFrames = resolveVideo ? createVideoFrames({ resolveVideo }) : null;
  const videoRecorder = wantsSound || videoFrames ? createVideoRecorder({ clock }) : null;
  const audioTrack = wantsSound
    ? ({ durationMs }) =>
        buildAudioTrack({
          recorder: audioRecorder,
          video: videoRecorder,
          durationMs,
          loadAudio,
          loadVideo,
          ...audioOptions,
        })
    : null;

  const renderer = createCanvasRenderer({
    canvas,
    assets,
    plate,
    size: { width: config.width, height: config.height },
    video: videoFrames && videoRecorder ? { frames: videoFrames, playheads: videoRecorder } : null,
    metrics,
  });

  const session = {
    config,
    clock,
    timeline,
    cursor,
    renderer,
    assets,
    audioRecorder,
    videoRecorder,
    videoFrames,
    metrics,
  };
  const exporter = createExporter({
    invoke,
    clock,
    cursor,
    frameSource: (state, t) => renderer.render(state, t),
    performance: () => performance(session),
    config,
    flush: flushTasks,
    onProgress,
    onStatus,
    audioTrack,
    // 裸 cue 不会等待组内动作：帧循环必须画到时间线最后一个 tween 结束。
    duration: () => timelineDuration(timeline),
    metrics,
    ...exporterOptions,
  });

  return {
    ...session,
    exporter,
    start: async () => {
      try {
        return await exporter.start();
      } finally {
        // 暂停的视频元素不会自己释放；导出结束（成功或失败）都把源放掉。
        videoFrames?.clear();
      }
    },
    cancel: () => exporter.cancel(),
  };
}
