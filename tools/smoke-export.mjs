// 真 Edge 端到端验证：虚拟时钟 + 时间线 + Canvas2D + WebCodecs + 假 IPC 桥。
// End-to-end smoke for the offscreen export pipeline in a real browser.
//
// 输出侧不依赖 Tauri：假 invoke 收集 append 的编码帧，检查 AVCC 长度前缀、
// 关键帧标记与调用顺序。Rust 侧的文件写入由 `src/export.rs` 的 cargo 测试
// 覆盖，两者通过同一份数据契约（append 的字节 == mdat 的内容）衔接。
//
//   node tools/smoke-export.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const UI_ROOT = fileURLToPath(new URL("../ui/", import.meta.url));
const EDGE = process.env.PAMELA_EDGE ?? findEdge();
const PORT = Number(process.env.PAMELA_SMOKE_EXPORT_PORT ?? 8979);
const CDP_PORT = Number(process.env.PAMELA_SMOKE_EXPORT_CDP ?? 9343);

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

// 一帧最小 GIF：在真浏览器里验证 preloadAssets 的解码 + 离屏画布路径。
const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x02, 0x00, 0x81, 0x00, 0x00,
  0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
  0x02, 0x03, 0x44, 0x34, 0x05, 0x00, 0x3b,
]);
const GIF_URL = "data:image/gif;base64," + Buffer.from(GIF_BYTES).toString("base64");

// 1 秒 160x90 的 H.264 + AAC：真浏览器里验证逐帧 seek 与视频声轨解码能力。
// 素材由 ffmpeg 生成（tools/fixtures/clip.mp4，约 7 KB），不依赖运行时外部工具。
const VIDEO_URL = "data:video/mp4;base64," +
  readFileSync(fileURLToPath(new URL("./fixtures/clip.mp4", import.meta.url))).toString("base64");

/** 一秒 440 Hz 的 16 位单声道 WAV：验证离线混音与 AAC 编码走的是真 WebAudio。 */
function wavDataUrl(seconds = 1, rate = 48_000, freq = 440) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    const sample = Math.sin((2 * Math.PI * freq * index) / rate) * 0.5;
    data.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return "data:audio/wav;base64," + Buffer.concat([header, data]).toString("base64");
}

const AUDIO_URL = wavDataUrl();

// 探针页里刻意不用模板字符串，避免被外层 JS 插值。
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>export smoke</title></head>
<body style="margin:0;background:#101010">
<canvas id="frame" width="1920" height="1080" style="display:block;width:192px;height:108px"></canvas>
<script type="module">
import { createExportSession } from "/export-session.js";
import { createExportPerformance, preloadAssets } from "/export-performance.js";
import { createVideoFrames } from "/export-video-frames.js";

const GIF_URL = "${GIF_URL}";
const AUDIO_URL = "${AUDIO_URL}";
const VIDEO_URL = "${VIDEO_URL}";
const calls = [];
const chunks = [];
let finishArgs = null;
const invoke = async (command, args) => {
  calls.push(command);
  if (command === "export_begin") return "job-1";
  if (command === "export_append") {
    chunks.push({ data: args.data, keyframe: args.keyframe });
    return;
  }
  if (command === "export_finish") {
    finishArgs = args;
    return "exports/export.mp4";
  }
  if (command === "export_abort") return;
};

function decode(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const background = document.createElement("canvas");
background.width = 1920;
background.height = 1080;
const bctx = background.getContext("2d");
bctx.fillStyle = "#224466";
bctx.fillRect(0, 0, 1920, 1080);
bctx.fillStyle = "#88aacc";
bctx.fillRect(100, 100, 600, 300);

const hero = document.createElement("canvas");
hero.width = 600;
hero.height = 900;
const hctx = hero.getContext("2d");
hctx.fillStyle = "#aa6644";
hctx.fillRect(0, 0, 600, 900);

const canvas = document.getElementById("frame");
// 两帧 GIF 帧集：验证渲染器按虚拟时间换帧，而不是只画第一帧。
const heroAlt = document.createElement("canvas");
heroAlt.width = hero.width;
heroAlt.height = hero.height;
heroAlt.getContext("2d").drawImage(hero, 0, 0);
heroAlt.getContext("2d").fillStyle = "#ffcc00";
heroAlt.getContext("2d").fillRect(0, 0, 240, 240);

const assets = new Map([
  ["bg.png", background],
  ["hero.png", hero],
  ["hero.gif", {
    kind: "gif",
    width: hero.width,
    height: hero.height,
    frames: [hero, heroAlt],
    delays: [100, 100],
    total: 200,
  }],
]);

// 真正跑一段 .pe 脚本：录制代理把舞台动作写进时间线，帧循环再逐帧取值。
const SCRIPT = [
  'bgm = Audio("bgm.wav", 0.4, true)',
  "bgm.play(300)",
  'bg = Background("bg.png")',
  "bg.enable()",
  'ch = Character("hero.gif")',
  'ch.name("小明")',
  "ch.enable()",
  'say("开场第一句台词")',
  "wait 200",
  "ch.moveTo(120, 0, 300)",
  'dialog.say("第二句台词", "旁白")',
  // 裸 cue 里的自由变形：既验证时间线登记，也验证真 Canvas 的三角剖分绘制。
  "ch.scale(0.5, 300)",
  "cue {",
  "    ch.transform.upright(300, 300, 600)",
  "    ch.transform.upleft(-300, 300, 600)",
  "    ch.transform.up(0, 300, 600)",
  "}",
  "wait 200",
  // 解除静音的 Video：画面走逐帧 seek，声轨进同一次离线混音。
  'clip = Video("clip.mp4", mute = false)',
  "clip.enable()",
  "wait 500",
  "bgm.stop(300)",
].join("\\n");

// 计数用于证明画面与声轨两条链路都被真的调用过，而不是只做了能力探测。
let videoAsks = 0;
let videoLoads = 0;
const resolveVideo = async () => {
  videoAsks += 1;
  return VIDEO_URL;
};
const loadVideo = async () => {
  videoLoads += 1;
  return (await fetch(VIDEO_URL)).arrayBuffer();
};

const session = createExportSession({
  invoke,
  canvas,
  assets,
  audio: true,
  loadAudio: async () => (await fetch(AUDIO_URL)).arrayBuffer(),
  loadVideo,
  resolveVideo,
  config: { fps: 30, maxFrames: 150, keyFrameEvery: 10 },
  performance: createExportPerformance({
    source: SCRIPT,
    path: "scripts/main.pe",
    read: async () => "",
  }),
});

window.__done = (async () => {
  try {
    // 视频能力：真浏览器能否逐帧 seek、decodeAudioData 能否解 mp4/AAC。
    // 这两条是导出声画链路的地基，单测里的假元素证明不了。
    let videoProbe = null;
    try {
      const bytes = await (await fetch(VIDEO_URL)).arrayBuffer();
      let audioDecode = null;
      try {
        const decoded = await new OfflineAudioContext(2, 48000, 48000)
          .decodeAudioData(bytes.slice(0));
        audioDecode = { frames: decoded.length, rate: decoded.sampleRate };
      } catch (error) {
        audioDecode = { unsupported: String(error && error.message || error) };
      }
      const frames = createVideoFrames({ resolveVideo: async () => VIDEO_URL });
      const entry = await frames.seek("clip.mp4", 0.5);
      const probe = document.createElement("canvas");
      probe.width = entry.width;
      probe.height = entry.height;
      const pctx = probe.getContext("2d");
      pctx.drawImage(entry.element, 0, 0);
      const pixels = pctx.getImageData(0, 0, entry.width, entry.height).data;
      let lit = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] || pixels[i + 1] || pixels[i + 2]) lit += 1;
      }
      videoProbe = {
        audioDecode,
        width: entry.width,
        height: entry.height,
        duration: entry.duration,
        seekTime: Number(entry.element.currentTime),
        litPixels: lit,
      };
      frames.clear();
    } catch (error) {
      videoProbe = { error: String(error && error.message || error) };
    }

    let gifProbe = "未运行";
    try {
      const probeAssets = new Map();
      await preloadAssets('p = Character("probe.gif")', async () => GIF_URL, probeAssets);
      const probe = probeAssets.get("probe.gif");
      gifProbe = probe?.kind === "gif" && probe.frames.length === 1;
      if (!gifProbe) gifProbe = JSON.stringify({ kind: probe?.kind, frames: probe?.frames?.length });
    } catch (error) {
      gifProbe = String(error?.message ?? error);
    }
    const result = await session.start();
    // 原始编码字节走 POST 回本地服务，不塞进 CDP 的返回值（那会拖死大对象）。
    if (finishArgs) {
      const dump = { avcc: finishArgs.avcc, chunks, audio: finishArgs.audio ?? null };
      await fetch("/dump", { method: "POST", body: JSON.stringify(dump) });
    }
    return {
      ok: true,
      result,
      gifProbe,
      videoProbe,
      videoAsks,
      videoLoads,
      calls,
      avccBytes: finishArgs ? decode(finishArgs.avcc).length : 0,
      chunks: chunks.map((chunk) => {
        const bytes = decode(chunk.data);
        const nal0 = bytes.length >= 4
          ? bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]
          : -1;
        return { size: bytes.length, keyframe: chunk.keyframe, nal0 };
      }),
      audio: finishArgs?.audio
        ? (() => {
            const bytes = decode(finishArgs.audio.data);
            const sizes = finishArgs.audio.samples ?? [];
            return {
              ascBytes: decode(finishArgs.audio.asc).length,
              sampleRate: finishArgs.audio.sampleRate,
              channels: finishArgs.audio.channels,
              bitrate: finishArgs.audio.bitrate,
              bytes: bytes.length,
              frames: sizes.length,
              sum: sizes.reduce((sum, size) => sum + size, 0),
            };
          })()
        : null,
    };
  } catch (error) {
    return { ok: false, error: String(error && error.stack || error), calls };
  }
})();
</script></body></html>`;

const server = createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  // 页面把原始编码字节 POST 回来；只有显式给了路径才落盘。
  if (req.method === "POST" && pathname === "/dump") {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", () => {
      const target = process.env.PAMELA_SMOKE_EXPORT_DUMP;
      if (target) {
        writeFileSync(target, Buffer.concat(parts));
      }
      res.writeHead(204).end();
    });
    return;
  }
  if (pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (!pathname.endsWith(".js")) {
    res.writeHead(404).end();
    return;
  }
  const file = normalize(join(UI_ROOT, pathname.slice(1)));
  if (!file.startsWith(UI_ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const profile = mkdtempSync(join(tmpdir(), "pamela-smoke-export-"));
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
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
    /* 交给系统临时目录清理。 */
  }
}

const watchdog = setTimeout(() => {
  console.error("smoke-export: 120 秒内没有完成导出");
  cleanup();
  process.exit(1);
}, 120_000);
watchdog.unref();

async function connect() {
  const url = "http://127.0.0.1:" + CDP_PORT + "/json/list";
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

let code = 1;
try {
  ws = await connect();
  const pending = new Map();
  let nextId = 0;
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

  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
    await delay(250);
    const probe = await send("Runtime.evaluate", {
      expression: "typeof window.__done",
      returnByValue: true,
    });
    ready = probe.result?.result?.value === "object";
  }
  if (!ready) {
    throw new Error("页面模块没有加载（检查控制台里的 import 错误）");
  }

  const answer = await send("Runtime.evaluate", {
    expression: "window.__done",
    returnByValue: true,
    awaitPromise: true,
  });
  if (answer.result?.exceptionDetails) {
    throw new Error(answer.result.exceptionDetails.text);
  }
  const report = answer.result?.result?.value;

  console.log("=== 离屏导出端到端 ===");
  if (!report?.ok) {
    console.error("页面里导出失败：", report?.error);
    console.error("调用序列：", JSON.stringify(report?.calls));
  } else {
    const frames = report.result.frames;
    const appendCalls = report.calls.filter((name) => name === "export_append").length;
    console.log("帧数: " + frames + ", append: " + appendCalls +
      ", 首帧字节: " + report.chunks[0]?.size +
      ", avcC: " + report.avccBytes + " bytes");
    console.log("调用序列头尾: " + report.calls[0] + " … " + report.calls.at(-1));

    const failures = [];
    if (frames < 10) failures.push("帧数太少");
    if (report.calls[0] !== "export_begin") failures.push("没有先 begin");
    if (report.calls.at(-1) !== "export_finish") failures.push("没有以 finish 收尾");
    if (appendCalls !== report.chunks.length || appendCalls !== report.result.appended) {
      failures.push("append 次数与编码帧数不一致");
    }
    if (!report.chunks.every((chunk) => chunk.size > 0)) failures.push("出现空编码帧");
    if (!report.chunks[0]?.keyframe) failures.push("首帧不是关键帧");
    if (!(report.chunks[0]?.nal0 > 0 && report.chunks[0]?.nal0 < report.chunks[0]?.size)) {
      failures.push("首帧不是 AVCC 长度前缀格式");
    }
    if (!(report.avccBytes > 0)) failures.push("finish 没有带 avcC");
    if (report.gifProbe !== true) failures.push("真浏览器里 GIF 解码失败：" + report.gifProbe);

    // 视频：逐帧 seek 是硬断言（画面必须取得到）；decodeAudioData 只报结论，
    // 因为「解不了 mp4/AAC」是既有设计的降级路径，不是导出链路的回归。
    const video = report.videoProbe;
    console.log("视频能力: " + JSON.stringify(video));
    console.log("视频声轨 decodeAudioData: " +
      (video?.audioDecode?.frames
        ? "可用（" + video.audioDecode.frames + " 帧）"
        : "不可用，视频自带声音会被跳过（见 docs/2026-11-08.md §2.3 P0-1 风险）"));
    if (!video || video.error) {
      failures.push("视频取帧探针失败：" + (video?.error ?? "无结果"));
    } else {
      if (!(video.width === 160 && video.height === 90)) {
        failures.push("视频取帧尺寸不符：" + video.width + "x" + video.height);
      }
      if (!(video.litPixels > 0)) failures.push("逐帧 seek 得到的画面是空的");
      if (!(video.seekTime > 0.1)) failures.push("seek 没有生效：" + video.seekTime);
    }
    console.log("视频链路: 取帧 " + report.videoAsks + " 次 / 声轨读取 " +
      report.videoLoads + " 次");
    if (!(report.videoAsks > 0)) failures.push("渲染后端没有取视频画面");
    if (!(report.videoLoads > 0)) failures.push("混音没有读视频声轨");

    if (process.env.PAMELA_SMOKE_EXPORT_DUMP) {
      console.log("编码字节已写出: " + process.env.PAMELA_SMOKE_EXPORT_DUMP);
    }

    // 声音：真 OfflineAudioContext 混音 + 真 AAC 编码，尺寸表必须与字节数一致。
    const audio = report.audio;
    if (!audio) {
      failures.push("finish 没有带音轨（" + (report.result?.warning ?? "无警告") + "）");
    } else {
      console.log(
        "音频: " + audio.sampleRate + "Hz " + audio.channels + "ch, " +
        audio.frames + " 帧 / " + audio.bytes + " 字节, ASC " + audio.ascBytes + " 字节",
      );
      if (audio.sampleRate !== 48_000) failures.push("音频采样率不是 48 kHz");
      if (audio.channels !== 2) failures.push("音频不是立体声");
      if (!(audio.ascBytes > 0)) failures.push("音频缺少 AudioSpecificConfig");
      if (!(audio.frames > 10)) failures.push("音频帧太少：" + audio.frames);
      if (audio.sum !== audio.bytes) failures.push("音频帧长表与字节数不一致");
      if (report.result.warning) failures.push("音频被降级：" + report.result.warning);
    }

    if (failures.length) {
      console.error("失败：", failures.join("；"));
    } else {
      console.log("PASS：真 Edge 中逐帧编码与流式写盘调用链路完整。");
      code = 0;
    }
  }
} catch (error) {
  console.error("smoke-export: " + (error?.message ?? String(error)));
} finally {
  cleanup();
}

process.exit(code);
