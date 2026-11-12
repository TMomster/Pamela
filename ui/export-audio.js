// 导出音频：记录脚本对声音做的事 → 离线混音 → AAC 编码 → 交给 MP4 封装。
// Pamela — sound for the exported movie: record, mix offline, encode once.
//
// 导出时没有任何声音被真正播放：录制舞台上的 `Audio` 只把 play / stop / volume
// 与时间点记下来。演出走完后，这些事件按虚拟时钟的时间重放到一个
// `OfflineAudioContext` 里，得到整段 PCM；再用 WebCodecs 编成 AAC，最后作为
// 音轨交给 Rust 侧（`export_finish` 的 `audio` 参数）。
//
// 为什么整段一次编完：音频要等到演出结束才知道有哪些声音、有多长，而视频
// 那时已经写完，长度已知；整段编码后一次性 append，`stsz` 的帧长表也就一次
// 给全，不需要在流式写盘里分辨两条轨。
//
// 静音的视频仍然是合法结果：没有任何声音事件时返回 `null`，后端照旧只写
// 视频轨。混音或编码失败也按「没有音轨」处理，并把原因报给界面——为了一段
// BGM 把整部成片作废不合适。

import { descriptionBytes } from "./export-mp4.js";
import { flushMicrotasks } from "./export-clock.js";
import {
  renderVoiceBuffer,
  loadAutoVoiceClip,
  AUTOVOICE_DEFAULT_SPEED,
} from "./voice-effect.js";

/** 输出音频参数：48 kHz 立体声、128 kbps AAC-LC。 */
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 128_000;

/** AAC-LC 的 codec 串；AAC 一帧固定 1024 个采样点。 */
export const AUDIO_CODEC = "mp4a.40.2";
export const AAC_FRAME_SAMPLES = 1024;

/** 编码时每次喂给 AudioEncoder 的采样点数（100 ms @48 kHz）。 */
const FEED_BLOCK = 4_800;

function asMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 舞台 `Audio` 的录制版本：与 `audio.js` 的属性同名、同顺序，但不碰 DOM。
 *
 * `args` 与真的一样是 `(文件名, 音量 = 1, 循环 = false)`；`context.assignee` 是
 * 这个对象被赋给的变量名，`say(text, time, "变量名")` 靠它找到配音。
 *
 * @param {object} options
 * @param {{now: () => number}} options.clock 虚拟时钟
 * @param {(message: string) => void} [options.onError]
 */
export function createAudioRecorder({ clock, onError = () => {} } = {}) {
  const events = [];
  const sounds = new Map();
  /** 变量名 → 声音 id，供 `say` 的配音参数使用。 */
  const names = new Map();
  let counter = 0;

  const factory = (args, context) => {
    const path = typeof args[0] === "string" ? args[0].trim() : "";
    if (!path) {
      throw new Error("Audio 需要音频文件名");
    }
    const given = args[1] === undefined ? 1 : Number(args[1]);
    if (!Number.isFinite(given)) {
      throw new Error("Audio 的音量需要数字");
    }
    const id = `sound-${(counter += 1)}`;
    sounds.set(id, {
      id,
      path,
      volume: Math.min(1, Math.max(0, given)),
      loop: Boolean(args[2]),
    });
    if (context?.assignee) {
      names.set(String(context.assignee), id);
    }

    const record = {
      kind: "Audio",
      play(time = 0) {
        events.push({ kind: "play", id, at: clock.now(), fadeMs: asMs(time) });
        return record;
      },
      stop(time = 0) {
        events.push({ kind: "stop", id, at: clock.now(), fadeMs: asMs(time) });
        return record;
      },
      loop() {
        events.push({ kind: "loop", id, at: clock.now(), value: true });
        return record;
      },
      once() {
        events.push({ kind: "once", id, at: clock.now(), value: false });
        return record;
      },
      volume(value, time = 0) {
        const wanted = Number(value);
        if (!Number.isFinite(wanted)) {
          throw new Error("Audio.volume 需要数字");
        }
        events.push({
          kind: "volume",
          id,
          at: clock.now(),
          value: Math.min(1, Math.max(0, wanted)),
          fadeMs: asMs(time),
        });
        return record;
      },
      /**
       * 导出没有元数据可读：答案固定是 0。
       *
       * 真舞台上这个值用来把一句台词卡在配音结束；导出时台词时长按字数给
       * （`export-stage.js` 的 `holdFor`），所以这个 0 只影响脚本自己拿它算
       * 出来的时间，不影响配音能不能进成片。
       */
      duration() {
        return Promise.resolve(0);
      },
    };
    return record;
  };

  /**
   * `say(text, time, audio)` 的配音：声音对象先登记，真正播放由事件驱动。
   *
   * 真舞台返回音轨长度作为这一句的时长；导出返回 0（见 `duration()` 的理由）。
   */
  factory.voice = (name) => {
    const id = names.get(String(name ?? ""));
    if (id) {
      events.push({ kind: "play", id, at: clock.now(), fadeMs: 0 });
    }
    return Promise.resolve(0);
  };

  /**
   * `stage.autoVoice` 开时，没有显式配音的 `say` 自动配一段合成效果音。
   *
   * 没有音频文件：只记一条 `synth` 事件，时长由字数决定，混音阶段再离屏渲染
   * 成波形（见 `planAudio` / `renderAudio`）。返回 0，与 `voice` 一致——
   * 导出里台词时长按字数给，不影响这条信息。
   */
  factory.autoVoice = (chars, speed = AUTOVOICE_DEFAULT_SPEED) => {
    events.push({
      kind: "synth",
      at: clock.now(),
      chars: Number(chars) || 0,
      speed: Number(speed) || AUTOVOICE_DEFAULT_SPEED,
    });
    return Promise.resolve(0);
  };

  return {
    audio: factory,
    events,
    sounds,
    /** 演出里出现过声音事件吗：没有就完全不必建混音上下文。 */
    hasSound() {
      return events.some(
        (event) => event.kind === "play" || event.kind === "synth",
      );
    },
    /** 报告中转：录制阶段不报错，混音阶段再统一处理缺文件。 */
    fail(error) {
      onError(error instanceof Error ? error.message : String(error));
    },
  };
}

/**
 * 把事件流变成可渲染的「声音段」：每段从某个时刻响到某个时刻，带音量折线。
 *
 * 纯函数，不碰 WebAudio。规则与真舞台一致：`play` 会打断同一对象正在响的那段
 * （重新从头播放）；`stop` 淡出到 0 后真正静音；`volume` 在响着的段上升降音量，
 * 没在响时只改下次 `play` 的起始音量。
 *
 * @param {{events: Array<object>, sounds: Map<string, object>}} recorder
 * @returns {{voices: Array<object>}}
 */
export function planAudio({ events = [], sounds = new Map() } = {}) {
  /** 每个声音的事件按发生顺序分组；跨声音的时间先后在最后排序。 */
  const grouped = new Map();
  for (const event of events) {
    if (!grouped.has(event.id)) {
      grouped.set(event.id, []);
    }
    grouped.get(event.id).push(event);
  }

  const voices = [];
  for (const [id, list] of grouped) {
    const sound = sounds.get(id);
    if (!sound) {
      continue;
    }
    let level = sound.volume;
    let open = null;
    let loop = Boolean(sound.loop);

    const close = (at) => {
      if (open && open.stopMs === null) {
        open.stopMs = at;
        voices.push(open);
      }
      open = null;
    };

    for (const event of list) {
      if (event.kind === "play") {
        close(event.at);
        const fadeEnd = event.at + event.fadeMs;
        const points = [];
        if (event.fadeMs > 0) {
          points.push({ at: event.at, value: 0 });
          points.push({ at: fadeEnd, value: level });
        } else {
          points.push({ at: event.at, value: level });
        }
        open = {
          id,
          path: sound.path,
          startMs: event.at,
          stopMs: null,
          loop,
          gain: points,
        };
      } else if (event.kind === "stop") {
        if (!open) {
          // 没在响时 stop 什么都不做（与元素上的 pause 一致）。
          level = sound.volume;
          continue;
        }
        const fadeEnd = event.at + event.fadeMs;
        // 先保持当前音量，再（有淡出时）降到 0；没有淡出就直接停在这里，
        // 由 `source.stop()` 切断，不需要一段假的斜坡。
        open.gain.push({ at: event.at, value: level });
        if (event.fadeMs > 0) {
          open.gain.push({ at: fadeEnd, value: 0 });
        }
        close(fadeEnd);
        // 淡出结束后元素音量复位：下一次 play 从脚本要的音量开始。
        level = sound.volume;
      } else if (event.kind === "volume") {
        if (open) {
          const fadeEnd = event.at + event.fadeMs;
          if (event.fadeMs > 0) {
            open.gain.push({ at: event.at, value: level });
            open.gain.push({ at: fadeEnd, value: event.value });
          } else {
            open.gain.push({ at: event.at, value: event.value });
          }
        }
        level = event.value;
      } else if (event.kind === "loop" || event.kind === "once") {
        loop = Boolean(event.value);
        if (open) {
          open.loop = loop;
        }
      }
    }
    // 画面结束时仍在响的声音：留到影片末尾，由渲染长度截断。
    close(Number.POSITIVE_INFINITY);
  }

  // 自动配音效果音：没有文件，按字数给一段合成段，混音阶段再离屏渲染成波形。
  // 每两字播放一次（次数 = ceil(字数 / 2)），两次间隔 = 1 / 速度 秒（即每秒 speed 次）。
  for (const event of events) {
    if (event.kind !== "synth") {
      continue;
    }
    const count = Math.max(1, Math.ceil((Number(event.chars) || 0) / 2));
    const speed = Number(event.speed) || AUTOVOICE_DEFAULT_SPEED;
    const gapMs = 1000 / speed;
    const durationMs = count * gapMs;
    voices.push({
      kind: "Synth",
      id: "synth",
      chars: event.chars,
      speed,
      startMs: event.at,
      stopMs: event.at + durationMs,
      loop: false,
      gain: [{ at: event.at, value: 1 }],
    });
  }

  voices.sort((left, right) => left.startMs - right.startMs);
  return { voices };
}

/**
 * 音量折线 → `AudioParam` 自动化。
 *
 * 相邻两个时间点之间是线性斜坡；同一个时间点出现两次（先 stop 再 play）时
 * 后一个覆盖前一个，避免零点重复调度。
 */
export function applyGain(param, points) {
  const sorted = [...points].sort((left, right) => left.at - right.at);
  let last = 0;
  let started = false;
  for (const point of sorted) {
    const at = Math.max(0, point.at / 1000);
    if (!started) {
      param.setValueAtTime(point.value, at);
      started = true;
      last = at;
      continue;
    }
    if (at <= last) {
      // 同一时刻的后写覆盖前写（`stop` 与紧随其后的 `play` 会撞在一起）。
      param.setValueAtTime(point.value, last);
      continue;
    }
    param.linearRampToValueAtTime(point.value, at);
    last = at;
  }
}

/**
 * 渲染整段音频：解码每个用到的文件，按计划排进离线上下文，一次渲染完。
 *
 * @param {object} options
 * @param {Array<object>} options.voices `planAudio` 与 `createVideoRecorder` 的结果
 * @param {number} options.durationMs 影片长度
 * @param {(path: string) => Promise<ArrayBuffer>} options.loadAudio 读音频文件字节
 * @param {(path: string) => Promise<ArrayBuffer>} [options.loadVideo] 读视频文件字节
 * @param {() => Promise<ArrayBuffer|null>} [options.loadClip]
 *   读自动配音的单位音效字节；缺省取引擎自带的那一段（测试用假实现替掉）。
 * @param {number} [options.sampleRate]
 * @param {number} [options.channels]
 * @param {Function} [options.AudioContextClass]
 * @param {(voice: object, error: Error) => void} [options.onMissing]
 *   某一段读不到或解不出音频时调用；跳过该段但不再把原因吞掉。
 * @returns {Promise<AudioBuffer>}
 */
export async function renderAudio({
  voices,
  durationMs,
  loadAudio,
  loadVideo = null,
  loadClip = loadAutoVoiceClip,
  sampleRate = AUDIO_SAMPLE_RATE,
  channels = AUDIO_CHANNELS,
  AudioContextClass,
  onMissing = () => {},
}) {
  const Impl = AudioContextClass ?? globalThis.OfflineAudioContext;
  if (typeof Impl !== "function") {
    throw new Error("当前环境不支持 OfflineAudioContext");
  }
  const frames = Math.max(1, Math.ceil((Math.max(0, durationMs) / 1000) * sampleRate));
  // One Float32 per frame per channel: past an hour the offline buffer alone is
  // over a gigabyte, which freezes before it can report a clean failure.
  const maxFrames = Math.max(1, Math.trunc(sampleRate * 3600));
  if (frames > maxFrames) {
    throw new Error(
      `音频时长超过 1 小时，无法一次渲染（${Math.round(durationMs / 1000)} 秒）`,
    );
  }
  const context = new Impl(channels, frames, sampleRate);
  const decoded = new Map();
  /** 视频与音频各读各的文件，缓存按「来源 + 路径」分开。 */
  const bufferFor = async (voice) => {
    const video = voice.kind === "Video";
    const loader = video ? loadVideo : loadAudio;
    if (typeof loader !== "function") {
      throw new Error(video ? "没有接入视频素材读取（loadVideo）" : "没有接入音频素材读取（loadAudio）");
    }
    const key = `${video ? "video" : "audio"}:${voice.path}`;
    if (!decoded.has(key)) {
      decoded.set(
        key,
        Promise.resolve()
          .then(() => loader(voice.path))
          .then((bytes) => {
            if (!bytes || bytes.byteLength === 0) {
              throw new Error("素材字节为空");
            }
            return context.decodeAudioData(bytes.slice(0));
          }),
      );
    }
    return decoded.get(key);
  };

  const endSeconds = frames / sampleRate;
  for (const voice of voices) {
    if (voice.startMs / 1000 >= endSeconds) {
      continue;
    }
    // 缺文件 / 解码失败只跳过这一段，别的声音照旧；但原因要报出去，否则
    // 一次 CSP 拒绝或解不了的容器会让整部成片静音而界面毫无提示。
    let buffer;
    try {
      if (voice.kind === "Synth") {
        // 自动配音：加载单位音效（引擎自带）后按次数 / 速度离屏渲染。
        const clipBytes = loadClip ? await loadClip() : null;
        if (!clipBytes || (clipBytes.byteLength ?? 0) === 0) {
          throw new Error("自动配音音效缺失");
        }
        const count = Math.max(1, Math.ceil((Number(voice.chars) || 0) / 2));
        buffer = await renderVoiceBuffer(clipBytes, {
          count,
          speed: Number(voice.speed) || AUTOVOICE_DEFAULT_SPEED,
          sampleRate,
          channels,
          AudioContextClass,
        });
      } else {
        buffer = await bufferFor(voice);
      }
    } catch (error) {
      onMissing(voice, error instanceof Error ? error : new Error(String(error)));
      continue;
    }
    if (!buffer) {
      onMissing(voice, new Error("解码没有返回音频数据"));
      continue;
    }
    const startAt = Math.max(0, voice.startMs / 1000);
    if (voice.kind === "Synth") {
      // 整段已由 renderVoiceBuffer 排好（含最后一个 clip），按实际时长放完，不截断。
      voice.stopMs = (startAt + (buffer.duration || 0)) * 1000;
    }
    // 视频段从素材的某个位置开始：循环时取余，不循环时夹到末尾（超出即静音）。
    const offsetMs = Math.max(0, Number(voice.offsetMs) || 0);
    const mediaSeconds = buffer.duration || 0;
    let offsetSeconds = offsetMs / 1000;
    if (voice.kind === "Video") {
      if (voice.loop && mediaSeconds > 0) {
        offsetSeconds %= mediaSeconds;
      } else if (mediaSeconds > 0) {
        offsetSeconds = Math.min(offsetSeconds, mediaSeconds);
      }
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = Boolean(voice.loop);
    if (voice.kind === "Video" && source.playbackRate) {
      const rate = Number(voice.rate);
      source.playbackRate.value = Number.isFinite(rate) && rate > 0 ? rate : 1;
    }
    const gain = context.createGain();
    applyGain(gain.gain, voice.gain);
    source.connect(gain);
    gain.connect(context.destination);
    if (voice.kind === "Video" && offsetSeconds > 0) {
      source.start(startAt, offsetSeconds);
    } else {
      source.start(startAt);
    }
    const stopAt = Number.isFinite(voice.stopMs) ? voice.stopMs / 1000 : endSeconds;
    if (stopAt > startAt) {
      source.stop(Math.min(stopAt, endSeconds));
    }
  }
  return context.startRendering();
}

/**
 * 把渲染好的 PCM 编成 AAC，返回帧长表与 AudioSpecificConfig。
 *
 * 注入 `AudioEncoderClass` / `AudioDataClass` 是为了在 Node 里测协议而不碰
 * 真编码器；`output` 是同步回调，所以要等 `flush()` 之后再读结果。
 *
 * @param {object} options
 * @param {AudioBuffer} options.buffer
 * @param {number} [options.sampleRate]
 * @param {number} [options.channels]
 * @param {number} [options.bitrate]
 * @param {Function} [options.AudioEncoderClass]
 * @param {Function} [options.AudioDataClass]
 * @param {() => Promise<void>} [options.flush]
 * @returns {Promise<{data: Uint8Array, samples: number[], description: Uint8Array|null,
 *   sampleRate: number, channels: number, bitrate: number}>}
 */
export async function encodeAudio({
  buffer,
  sampleRate = AUDIO_SAMPLE_RATE,
  channels = AUDIO_CHANNELS,
  bitrate = AUDIO_BITRATE,
  AudioEncoderClass,
  AudioDataClass,
  flush = flushMicrotasks,
}) {
  const Encoder = AudioEncoderClass ?? globalThis.AudioEncoder;
  const Data = AudioDataClass ?? globalThis.AudioData;
  if (typeof Encoder !== "function" || typeof Data !== "function") {
    throw new Error("当前环境不支持 WebCodecs AudioEncoder");
  }

  const chunks = [];
  let description = null;
  let encoderError = null;
  const encoder = new Encoder({
    output: (chunk, meta) => {
      if (!description && meta?.decoderConfig?.description) {
        description = descriptionBytes(meta.decoderConfig.description);
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      chunks.push(bytes);
    },
    error: (error) => {
      encoderError = error instanceof Error ? error : new Error(String(error));
    },
  });
  encoder.configure({ codec: AUDIO_CODEC, sampleRate, numberOfChannels: channels, bitrate });

  const total = buffer.length;
  const planes = [];
  for (let channel = 0; channel < channels; channel += 1) {
    planes.push(buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)));
  }

  for (let offset = 0; offset < total; offset += FEED_BLOCK) {
    const frames = Math.min(FEED_BLOCK, total - offset);
    const planar = new Float32Array(frames * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      planar.set(planes[channel].subarray(offset, offset + frames), channel * frames);
    }
    const data = new Data({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encode(data);
    data.close?.();
    await flush();
  }
  await encoder.flush();
  await flush();
  encoder.close?.();
  if (encoderError) {
    throw encoderError;
  }
  if (chunks.length === 0) {
    throw new Error("音频编码器没有输出任何帧");
  }

  const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const data = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return {
    data,
    samples: chunks.map((chunk) => chunk.length),
    description,
    sampleRate,
    channels,
    bitrate,
  };
}

/**
 * 一次导出音频的完整流程：计划 → 渲染 → 编码。
 *
 * 没有任何声音、渲染失败或编码失败时返回 `{ track: null, warning }`，让调用方
 * 继续导出静音视频；`warning` 是一句人话，由界面显示。
 *
 * @param {object} options
 * @param {object} [options.recorder] `createAudioRecorder` 的返回值
 * @param {object} [options.video] `createVideoRecorder` 的返回值：视频素材的声轨
 * @param {number} options.durationMs
 * @param {(path: string) => Promise<ArrayBuffer>} [options.loadAudio]
 * @param {(path: string) => Promise<ArrayBuffer>} [options.loadVideo]
 * @param {() => Promise<ArrayBuffer|null>} [options.loadClip] 读自动配音的单位音效
 * @param {number} [options.sampleRate]
 * @param {number} [options.channels]
 * @param {number} [options.bitrate]
 * @param {Function} [options.AudioContextClass]
 * @param {Function} [options.AudioEncoderClass]
 * @param {Function} [options.AudioDataClass]
 * @returns {Promise<{track: object|null, warning: string|null}>}
 */
export async function buildAudioTrack({
  recorder = null,
  video = null,
  durationMs,
  loadAudio = null,
  loadVideo = null,
  loadClip = null,
  sampleRate = AUDIO_SAMPLE_RATE,
  channels = AUDIO_CHANNELS,
  bitrate = AUDIO_BITRATE,
  AudioContextClass,
  AudioEncoderClass,
  AudioDataClass,
}) {
  const videoVoices = video?.voices?.() ?? [];
  if (!recorder?.hasSound?.() && videoVoices.length === 0) {
    return { track: null, warning: null };
  }
  try {
    // 声音对象与视频声轨走同一条混音：谁先响谁先排，音量折线各自独立。
    const voices = [
      ...(recorder?.hasSound?.() ? planAudio(recorder).voices : []),
      ...videoVoices,
    ];
    if (voices.length === 0) {
      return { track: null, warning: null };
    }
    const reasons = new Set();
    let failed = 0;
    const buffer = await renderAudio({
      voices,
      durationMs,
      loadAudio,
      loadVideo,
      loadClip,
      sampleRate,
      channels,
      AudioContextClass,
      onMissing: (voice, error) => {
        failed += 1;
        const kind = voice.kind === "Video" ? "视频" : "音频";
        reasons.add(`${kind} ${voice.path}：${error.message}`);
      },
    });
    const detail = [...reasons].join("；");
    // 一段都没排上就别写一条假的全静音 AAC 轨：后端会把它当成有效音轨，
    // 播放器看见「有声音」却什么都听不到，界面也不会有任何提示。
    if (failed >= voices.length) {
      return { track: null, warning: `音频没有进成片：${detail}` };
    }
    const encoded = await encodeAudio({
      buffer,
      sampleRate,
      channels,
      bitrate,
      AudioEncoderClass,
      AudioDataClass,
    });
    if (!encoded.description) {
      return { track: null, warning: "音频编码器没有给出 AudioSpecificConfig，成片按静音导出。" };
    }
    return {
      track: encoded,
      warning: reasons.size ? `部分声音没有进成片：${detail}` : null,
    };
  } catch (error) {
    return {
      track: null,
      warning: `音频没有进成片：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
