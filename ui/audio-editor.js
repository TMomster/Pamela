// 音频剪辑编辑器。
// Pamela — audio editor.
// 仅本模块依赖 `AudioContext` 与 `canvas`；重采样会同时改变音高。

import { arrayBufferFromDataUrl } from "./data-url.js";

/** 把字符串按小端写入 DataView。 */

function writeStr(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** 把字节缓冲编码为 base64（浏览器用 btoa，node 用 Buffer）。 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * 把单/多声道 Float32 采样编码为 16-bit PCM WAV ArrayBuffer。
 *
 * @param {Float32Array[]} channels 每声道采样，范围 [-1, 1]
 * @param {number} sampleRate
 * @param {number} [numChannels]
 */
export function encodeWav(channels, sampleRate, numChannels) {
  const chans = Array.isArray(channels) ? channels : [channels];
  const count = numChannels ?? chans.length;
  const data = chans.slice(0, count);
  const length = data[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = count * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < count; c += 1) {
      const sample = Math.max(-1, Math.min(1, data[c][i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

/** WAV 缓冲 → `data:audio/wav;base64,...`。 */
export function wavToDataUrl(buffer) {
  return `data:audio/wav;base64,${arrayBufferToBase64(buffer)}`;
}

/** 乘以固定增益。 */
export function applyGain(samples, gain) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain;
  return out;
}

/**
 * 应用淡入 / 淡出包络。
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} fadeInSec 起始线性渐入时长
 * @param {number} fadeOutSec 结尾线性渐出时长
 */
export function applyFade(samples, sampleRate, fadeInSec, fadeOutSec) {
  const out = new Float32Array(samples.length);
  const n = samples.length;
  const inN = Math.max(0, Math.floor(fadeInSec * sampleRate));
  const outN = Math.max(0, Math.floor(fadeOutSec * sampleRate));
  for (let i = 0; i < n; i += 1) {
    let g = 1;
    if (inN > 0 && i < inN) g = i / inN;
    if (outN > 0 && i > n - outN) g = (n - i) / outN;
    out[i] = samples[i] * g;
  }
  return out;
}

/**
 * 重采样（变速）。ratio > 1 拉长（减速），< 1 缩短（加速），线性插值。
 * 简单重采样会同时改变音高；当前阶段仅提供基础剪辑能力，暂不引入保持音高的算法。
 */
export function resample(samples, ratio) {
  const n = samples.length;
  const m = Math.max(1, Math.round(n / ratio));
  const out = new Float32Array(m);
  for (let i = 0; i < m; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(n - 1, i0 + 1);
    const f = pos - i0;
    out[i] = samples[i0] * (1 - f) + samples[i1] * f;
  }
  return out;
}

/** 按秒裁剪出子区间。 */
export function sliceSamples(samples, startSec, endSec, sampleRate) {
  const s = Math.max(0, Math.floor(startSec * sampleRate));
  const e = Math.min(samples.length, Math.ceil(endSec * sampleRate));
  return samples.slice(s, e);
}

/**
 * 把采样段 b 追加到采样段 a 之后；两段需具有相同采样率与声道数。
 */
export function concatSamples(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * 构建音频编辑器。
 *
 * @param {object} options
 * @param {HTMLElement} options.element 容器
 * @param {(path: string) => Promise<string>} options.readAudio 项目内音频 → data URL
 * @param {(path: string, dataUrl: string) => Promise<void>} options.writeAsset 写回 assets
 * @param {(message: string) => void} [options.onError]
 * @param {(message: string) => void} [options.onStatus]
 * @param {() => void} [options.onChange]
 */
export function createAudioEditor({
  element,
  readAudio,
  writeAsset,
  onError = () => {},
  onStatus = () => {},
  onChange = () => {},
}) {
  let path = null;
  let buffer = null; // AudioBuffer
  /** The one AudioContext this editor decodes and builds buffers with. */
  let audioContext = null;
  // 选区为 `{ start: sec, end: sec }`，`null` 表示未选择。
  // A selection is `{ start: sec, end: sec }`; `null` means no selection.
  let selection = null;
  let pending = { gain: 1, fadeIn: 0, fadeOut: 0, speed: 1 };
  let dirty = false;

  const node = document.createElement("div");
  node.className = "audio-editor";

  const toolbar = document.createElement("div");
  toolbar.className = "audio-editor__toolbar";

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "audio-editor__canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "audio-editor__canvas";
  canvasWrap.append(canvas);
  const ctx = canvas.getContext("2d");

  const controls = document.createElement("div");
  controls.className = "audio-editor__controls";

  node.append(toolbar, canvasWrap, controls);
  element.append(node);

  const buttons = [
    { label: "添加片段", run: addSegment },
    { label: "裁剪选区", run: cropSelection },
    { label: "撤销", run: undo },
    { label: "重做", run: redo },
    { label: "保存", run: saveOverwrite },
    { label: "导出为…", run: exportAs },
  ];
  for (const { label, run } of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "audio-editor__btn";
    btn.textContent = label;
    btn.addEventListener("click", run);
    toolbar.append(btn);
  }

  // 音量 / 淡入 / 淡出 / 变速 滑块。
  const addSlider = (key, labelText, min, max, step) => {
    const wrap = document.createElement("label");
    wrap.className = "audio-editor__field";
    wrap.textContent = labelText;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(pending[key]);
    input.addEventListener("input", () => {
      pending[key] = Number(input.value);
      render();
    });
    wrap.append(input);
    controls.append(wrap);
  };
  addSlider("gain", "音量", 0, 2, 0.05);
  addSlider("fadeIn", "淡入(秒)", 0, 5, 0.1);
  addSlider("fadeOut", "淡出(秒)", 0, 5, 0.1);
  addSlider("speed", "变速(1=原速)", 0.25, 4, 0.05);

  // --- 撤销重做 ---
  const history = [];
  const future = [];
  function snapshot() {
    history.push(serialize());
    if (history.length > 100) history.shift();
    future.length = 0;
  }
  function serialize() {
    if (!buffer) return null;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      channels.push(Array.from(buffer.getChannelData(c)));
    }
    return { channels, sampleRate: buffer.sampleRate };
  }
  function restore(state) {
    if (!state) return;
    buffer = makeBuffer(state.channels, state.sampleRate);
  }
  function undo() {
    if (!history.length) return;
    future.push(serialize());
    restore(history.pop());
    markDirty();
    render();
  }
  function redo() {
    if (!future.length) return;
    history.push(serialize());
    restore(future.pop());
    markDirty();
    render();
  }

  function markDirty() {
    dirty = true;
    onChange();
  }

  /**
   * The context this editor works through, created on first use.
   *
   * A context used to be made per operation and never closed, which leaks an
   * audio thread each time — and browsers refuse to create more than a handful
   * of live contexts, so opening a few tabs made decoding fail outright.
   */
  function audioContextFor() {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    return audioContext;
  }

  function makeBuffer(channels, sampleRate) {
    const length = channels[0].length;
    const b = audioContextFor().createBuffer(channels.length, length, sampleRate);
    for (let c = 0; c < channels.length; c += 1) {
      b.copyToChannel(Float32Array.from(channels[c]), c);
    }
    return b;
  }

  function decode(src) {
    // `readAudio` 交回 `data:` URL；CSP 不允许 connect-src 的 `data:`，所以
    // 直接解 base64，不走会被拒绝的 fetch(url)。
    return Promise.resolve()
      .then(() => readAudio(src))
      .then((url) => arrayBufferFromDataUrl(url))
      .then((ab) => audioContextFor().decodeAudioData(ab));
  }

  /** 加载音频文件。 */
  async function load(projectPath) {
    path = projectPath;
    try {
      buffer = await decode(projectPath);
      selection = null;
      history.length = 0;
      future.length = 0;
      dirty = false;
      render();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  // --- 选区 ---
  let dragging = null;

  function secondsFromX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, ratio)) * duration();
  }

  canvas.addEventListener("pointerdown", (event) => {
    const sec = secondsFromX(event.clientX);
    dragging = { start: sec, end: sec };
    selection = { start: sec, end: sec };
    render();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    dragging.end = secondsFromX(event.clientX);
    selection = { start: Math.min(dragging.start, dragging.end), end: Math.max(dragging.start, dragging.end) };
    render();
  });
  canvas.addEventListener("pointerup", () => {
    dragging = null;
  });
  canvas.addEventListener("pointerleave", () => {
    dragging = null;
  });

  function duration() {
    return buffer ? buffer.duration : 0;
  }

  // --- 操作 ---
  function applyPending(source) {
    let data = Float32Array.from(source);
    if (pending.gain !== 1) data = applyGain(data, pending.gain);
    if (pending.fadeIn > 0 || pending.fadeOut > 0) {
      data = applyFade(data, buffer.sampleRate, pending.fadeIn, pending.fadeOut);
    }
    if (pending.speed !== 1) data = resample(data, 1 / pending.speed);
    return data;
  }

  function cropSelection() {
    if (!buffer || !selection) return;
    snapshot();
    const channel = buffer.getChannelData(0);
    let data = sliceSamples(channel, selection.start, selection.end, buffer.sampleRate);
    data = applyPending(data);
    buffer = makeBuffer([data], buffer.sampleRate);
    selection = null;
    markDirty();
    render();
  }

  async function addSegment() {
    const choice = window.prompt("要拼接的音频路径（项目相对，如 assets/sfx.wav）：", "assets/");
    if (!choice) return;
    try {
      snapshot();
      const other = await decode(choice.trim());
      const a = Float32Array.from(buffer.getChannelData(0));
      const b = Float32Array.from(other.getChannelData(0));
      const merged = concatSamples(a, b);
      buffer = makeBuffer([merged], buffer.sampleRate);
      markDirty();
      render();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  // --- 渲染波形 ---
  function render() {
    if (!buffer) {
      canvas.width = 600;
      canvas.height = 160;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = Math.max(300, Math.min(1600, Math.floor(duration() * 200)));
    canvas.height = 160;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const channel = buffer.getChannelData(0);
    const n = channel.length;
    const mid = canvas.height / 2;
    ctx.strokeStyle = "#3399ff";
    ctx.beginPath();
    for (let x = 0; x < canvas.width; x += 1) {
      const i0 = Math.floor((x / canvas.width) * n);
      const i1 = Math.floor(((x + 1) / canvas.width) * n);
      let peak = 0;
      for (let i = i0; i < i1; i += 1) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
      ctx.moveTo(x, mid - peak * mid);
      ctx.lineTo(x, mid + peak * mid);
    }
    ctx.stroke();

    // 选区阴影。
    if (selection) {
      const x0 = (selection.start / duration()) * canvas.width;
      const x1 = (selection.end / duration()) * canvas.width;
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x0, 0, x1 - x0, canvas.height);
    }
  }

  // --- 导出 ---
  function exportBuffer() {
    const channel = buffer.getChannelData(0);
    let data = Float32Array.from(channel);
    if (pending.gain !== 1) data = applyGain(data, pending.gain);
    if (pending.fadeIn > 0 || pending.fadeOut > 0) {
      data = applyFade(data, buffer.sampleRate, pending.fadeIn, pending.fadeOut);
    }
    if (pending.speed !== 1) data = resample(data, 1 / pending.speed);
    const wav = encodeWav([data], buffer.sampleRate, 1);
    return wavToDataUrl(wav);
  }

  async function saveOverwrite() {
    if (!path || !buffer) return;
    try {
      await writeAsset(path, exportBuffer());
      dirty = false;
      onChange();
      onStatus(`已保存 ${path}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportAs() {
    const target = window.prompt("导出路径（项目相对，如 assets/out.wav）：", "assets/out.wav");
    if (!target) return;
    try {
      await writeAsset(target.trim(), exportBuffer());
      onStatus(`已导出 ${target.trim()}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  function close() {
    // A decoded track can be tens of megabytes, and the context owns an audio
    // thread of its own; neither is reachable once the tab is gone.
    buffer = null;
    selection = null;
    if (audioContext) {
      const closing = audioContext.close();
      if (closing && typeof closing.catch === "function") {
        closing.catch(() => {});
      }
      audioContext = null;
    }
    node.remove();
  }

  return {
    node,
    load,
    render,
    cropSelection,
    addSegment,
    undo,
    redo,
    exportBuffer,
    save: saveOverwrite,
    get dirty() {
      return dirty;
    },
    close,
  };
}
