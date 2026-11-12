// 探测目标 WebView2/Edge 是否具备离屏逐帧导出 MP4 所需的浏览器能力。
// Probe the browser features the offscreen frame-by-frame MP4 export needs.
//
// 这是 M0 的 go/no-go 关卡：只有 H.264 `VideoEncoder` 能真的编出一帧，
// "零新增依赖 + Rust 手写 MP4 muxer" 这条路线才成立。
// 与 `smoke-*.mjs` 一样使用真 Edge + CDP；探针页不设 CSP，与 app 不同。
//
//   node tools/probe-export.mjs
//   PAMELA_EDGE=... PAMELA_PROBE_PORT=8977 PAMELA_PROBE_CDP=9341 node tools/probe-export.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const EDGE = process.env.PAMELA_EDGE ?? findEdge();
const PORT = Number(process.env.PAMELA_PROBE_PORT ?? 8977);
const CDP_PORT = Number(process.env.PAMELA_PROBE_CDP ?? 9341);
// 软件 H.264 编码器可能被 --disable-gpu 挡住；置 PAMELA_PROBE_GPU=1 再跑一次对照。
const GPU_FLAGS = process.env.PAMELA_PROBE_GPU === "1" ? [] : ["--disable-gpu"];

function findEdge() {
  const candidates = [
    process.env["ProgramFiles(x86)"] &&
      join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    process.env.ProgramFiles &&
      join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? "msedge";
}

// 一个只有空白文档的页面：本地回环地址是 secure context，WebCodecs 可用。
const PAGE =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>probe</title></head>" +
  "<body style=\"margin:0;background:#101010\"></body></html>";

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const profile = mkdtempSync(join(tmpdir(), "pamela-probe-"));
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    ...GPU_FLAGS,
    "--remote-debugging-port=" + CDP_PORT,
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--no-default-browser-check",
    "http://127.0.0.1:" + PORT + "/",
  ],
  { stdio: "ignore" },
);

let ws = null;
function cleanup() {
  clearTimeout(watchdog);
  try {
    ws?.close();
  } catch {
    /* 已释放。 */
  }
  edge.kill();
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 浏览器退出时可能仍在写配置，交给系统临时目录清理。 */
  }
}

const watchdog = setTimeout(() => {
  console.error("probe: 浏览器在 60 秒内没有起来，或探针超时");
  cleanup();
  process.exit(1);
}, 60_000);
watchdog.unref();

async function connect() {
  const url = "http://127.0.0.1:" + CDP_PORT + "/json/list";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch(url).then((r) => r.json());
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        return socket;
      }
    } catch {
      // 浏览器还没监听端口。
    }
    await delay(250);
  }
  throw new Error("连不上 CDP");
}

// 探针表达式里刻意不用模板字符串，避免被外层 JS 插值。
const PROBE = `(async () => {
  const report = {
    ua: navigator.userAgent,
    secureContext: window.isSecureContext,
    apis: {},
    recorder: {},
    encoders: {},
    canvas: {},
    domRaster: {},
  };

  for (const name of ["VideoEncoder", "VideoDecoder", "AudioEncoder", "VideoFrame",
                      "EncodedVideoChunk", "MediaRecorder", "OffscreenCanvas",
                      "createImageBitmap", "ImageDecoder"]) {
    report.apis[name] = typeof globalThis[name];
  }

  for (const mime of ["video/mp4", "video/mp4;codecs=avc1.42E01E",
                      "video/mp4;codecs=avc1.640028", "video/webm;codecs=vp9",
                      "video/webm;codecs=vp8", "video/webm"]) {
    try {
      report.recorder[mime] = typeof MediaRecorder !== "undefined"
        ? MediaRecorder.isTypeSupported(mime) : null;
    } catch (error) {
      report.recorder[mime] = "error: " + String(error);
    }
  }

  const cc = document.createElement("canvas").getContext("2d");
  const wanted = "brightness(1.2) contrast(0.9) saturate(0.5) blur(2px)";
  try {
    cc.filter = wanted;
    report.canvas.filterRoundTrip = cc.filter;
    report.canvas.filterSupported = cc.filter === wanted;
  } catch (error) {
    report.canvas.filterSupported = false;
    report.canvas.filterError = String(error);
  }
  report.canvas.captureStream = typeof document.createElement("canvas").captureStream;
  report.canvas.fonts = typeof document.fonts;

  // 是否真的能编出 H.264 帧，并拿到 avcC（decoderConfig.description）。
  async function encodeOne(codec) {
    const out = { codec, ok: false };
    if (typeof VideoEncoder === "undefined") {
      out.reason = "VideoEncoder 不存在";
      return out;
    }
    const config = {
      codec, width: 1920, height: 1080,
      bitrate: 8000000, framerate: 30,
      avc: { format: "avc" },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      out.isConfigSupported = Boolean(support?.supported);
      if (!support?.supported) {
        out.reason = "isConfigSupported 返回 false";
        return out;
      }
    } catch (error) {
      out.reason = "isConfigSupported 抛错: " + String(error);
      return out;
    }

    const chunks = [];
    let descriptionBytes = 0;
    let failure = null;
    let encoder;
    try {
      encoder = new VideoEncoder({
        output(chunk, meta) {
          chunks.push({ size: chunk.byteLength, type: chunk.type, timestamp: chunk.timestamp });
          const d = meta?.decoderConfig?.description;
          if (d) descriptionBytes = d.byteLength ?? d.buffer?.byteLength ?? 0;
        },
        error(error) { failure = String(error); },
      });
      encoder.configure(config);
      const canvas = document.createElement("canvas");
      canvas.width = 1920;
      canvas.height = 1080;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#336699";
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(100, 100, 400, 200);
      const frame = new VideoFrame(canvas, { timestamp: 0, duration: 33333 });
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      await encoder.flush();
      out.chunks = chunks;
      out.descriptionBytes = descriptionBytes;
      out.ok = chunks.length > 0 && !failure;
      if (failure) out.reason = failure;
      if (chunks.length && !descriptionBytes) {
        out.warning = "没有拿到 avcC description，muxer 需要另找来源";
      }
    } catch (error) {
      out.reason = String(error);
    } finally {
      try { encoder?.close(); } catch { /* 已关闭。 */ }
    }
    return out;
  }

  // isConfigSupported 对某个具体配置返回 false 不代表 H.264 整体不可用：
  // 扫一遍 codec x 配置矩阵，找出真正能用的组合。
  report.encoderMatrix = [];
  const codecs = ["avc1.42E01E", "avc1.42E01F", "avc1.4D401F", "avc1.640028",
                  "vp8", "vp09.00.10.08"];
  const variants = [
    { label: "plain", patch: {} },
    { label: "avc-format", patch: { avc: { format: "avc" } } },
    { label: "small", patch: { width: 640, height: 360, bitrate: 1000000 } },
    { label: "no-bitrate", patch: { bitrate: undefined } },
    { label: "software", patch: { hardwareAcceleration: "prefer-software" } },
    { label: "realtime", patch: { latencyMode: "realtime" } },
  ];
  for (const codec of codecs) {
    for (const variant of variants) {
      const config = {
        codec, width: 1920, height: 1080, bitrate: 8000000, framerate: 30,
        ...variant.patch,
      };
      if (config.bitrate === undefined) delete config.bitrate;
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        report.encoderMatrix.push({
          codec, variant: variant.label, supported: Boolean(support?.supported),
        });
      } catch (error) {
        report.encoderMatrix.push({ codec, variant: variant.label, error: String(error) });
      }
    }
  }

  // 1080p 需要 Level 4.0：Baseline 3.0/3.1 在 1920x1080 被拒（见矩阵）。
  report.encoders.h264 = await encodeOne("avc1.640028");
  report.encoders.h264Baseline = await encodeOne("avc1.42E01F");

  // MediaRecorder 声称支持 MP4，要确认它真的写出 ISO BMFF（而不是悄悄回退 WebM）。
  async function recordSample(mime) {
    const out = { mime, ok: false };
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, {
        mimeType: mime, videoBitsPerSecond: 2000000,
      });
      const parts = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) parts.push(event.data);
      };
      const done = new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.onerror = (event) => {
          out.error = String(event.error ?? event);
          resolve();
        };
      });
      recorder.start();
      for (let i = 0; i < 8; i += 1) {
        ctx.fillStyle = i % 2 ? "#882222" : "#228844";
        ctx.fillRect(20, 20, 100 + i * 10, 60);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      recorder.stop();
      await done;
      const blob = new Blob(parts, { type: mime });
      out.blobType = blob.type;
      out.bytes = blob.size;
      if (blob.size >= 12) {
        const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        out.magic = String.fromCharCode(...head);
        out.isMp4 = head[4] === 102 && head[5] === 116 && head[6] === 121 && head[7] === 112;
      }
      out.ok = blob.size > 0;
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      out.error = String(error);
    }
    return out;
  }
  report.mediaRecorder = {};
  for (const mime of ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9"]) {
    report.mediaRecorder[mime] = await recordSample(mime);
  }

  // requestFrame() 是"逐帧喂给 MediaRecorder"的前提。
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    track.requestFrame();
    report.canvas.manualFrame = {
      ok: true, readyState: track.readyState, requestFrame: typeof track.requestFrame,
    };
    track.stop();
  } catch (error) {
    report.canvas.manualFrame = { ok: false, error: String(error) };
  }

  if (typeof AudioEncoder !== "undefined") {
    try {
      const audio = await AudioEncoder.isConfigSupported({
        codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000,
      });
      report.encoders.aac = Boolean(audio?.supported);
    } catch (error) {
      report.encoders.aac = "error: " + String(error);
    }
  }

  // foreignObject 栅格化只作参考：CSS filter 是否保留，决定它能否当帧源。
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<foreignObject width="64" height="64">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:64px;height:64px;' +
      'background:#808080;filter:brightness(0.5)">x</div></foreignObject></svg>';
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("SVG 载入失败"));
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const pixel = ctx.getImageData(32, 48, 1, 1).data;
    report.domRaster = { ok: true, pixel: [pixel[0], pixel[1], pixel[2], pixel[3]] };
  } catch (error) {
    report.domRaster = { ok: false, error: String(error) };
  }

  return report;
})()`;

let nextId = 0;
const pending = new Map();
let code = 1;

try {
  ws = await connect();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/" });
  await delay(400);

  const result = await send("Runtime.evaluate", {
    expression: PROBE,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails) {
    console.error("probe: 页面里抛错：", result.result.exceptionDetails.text);
  } else {
    const report = result.result?.result?.value;
    console.log("=== M0 编解码器探针 ===");
    console.log(JSON.stringify(report, null, 2));
    const h264 = report?.encoders?.h264;
    const mp4Recorder = report?.mediaRecorder?.["video/mp4;codecs=avc1.42E01E"];
    console.log("");
    console.log("=== 结论 ===");
    if (h264?.ok && h264.chunks?.length) {
      console.log("GO：WebCodecs H.264 可用，零新增依赖 + Rust 手写 MP4 muxer 路线成立。");
      console.log("     推荐 codec: avc1.640028 (High L4.0)；Baseline 3.x 在 1080p 会被拒。");
      console.log("     avcC bytes: " + h264.descriptionBytes +
        "（为 0 则 muxer 需从码流 SPS/PPS 自行构造）");
      console.log("     MediaRecorder 也能直接产出 MP4（" + (mp4Recorder?.isMp4 ? "已验证" : "未验证") +
        "），可作为编码器失败时的回退。");
      code = 0;
    } else if (mp4Recorder?.isMp4) {
      console.log("GO（回退）：VideoEncoder 不可用，但 MediaRecorder 已验证产出 ISO BMFF MP4。");
      console.log("     改用 canvas.captureStream(0) + requestFrame() 逐帧喂帧；");
      console.log("     帧内容确定，但时长/帧率由墙钟决定，需在 docs/ 记录这一取舍。");
      code = 0;
    } else {
      console.log("NO-GO：H.264 编码不可用。回退：PNG 帧序列 + 外部合成，");
      console.log("       或破例引入 ffmpeg（需在 docs/ 记录）。");
      code = 2;
    }
  }
} catch (error) {
  console.error("probe: " + (error?.message ?? String(error)));
} finally {
  cleanup();
}

process.exit(code);
