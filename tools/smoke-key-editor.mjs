// 手动验收编辑关键帧时的布局几何：工具栏与面板必须位于取景框之外。
// Manual acceptance of the key frame editor layout: the toolbar and panels must sit outside the view frame.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// 路径与浏览器都从脚本位置推导，可在 CI 或另一台机器上直接运行。
// Root and browser are derived from this script, so it runs on CI and other machines.
const ROOT = fileURLToPath(new URL("../ui", import.meta.url));
const EDGE = process.env.PAMELA_EDGE ?? findEdge();

function findEdge() {
  const candidates = [
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? "msedge";
}
const PORT = 8981;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let rel = normalize(decodeURIComponent(url.pathname));
    while (rel.startsWith("/") || rel.startsWith(sep)) rel = rel.slice(1);
    const file = join(ROOT, rel === "" ? "index.html" : rel);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = mkdtempSync(join(tmpdir(), "pamela-layout-"));
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--window-size=1280,900",
    "--remote-debugging-port=9343",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    `http://127.0.0.1:${PORT}/index.html`,
  ],
  { stdio: "ignore" },
);

const watchdog = setTimeout(() => {
  console.error("浏览器没起来");
  edge.kill();
  process.exit(1);
}, 60_000);

let ws = null;
for (let i = 0; i < 60 && !ws; i += 1) {
  try {
    const list = await fetch("http://127.0.0.1:9343/json/list").then((r) => r.json());
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
      });
    }
  } catch {
    /* not up */
  }
  if (!ws) await delay(250);
}
clearTimeout(watchdog);
if (!ws) {
  console.error("连不上 CDP");
  edge.kill();
  process.exit(1);
}

let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = (nextId += 1);
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await delay(2000);

const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};

// 让舞台可见，并模拟「进入关键帧编辑」的状态：加类、插入两根控制条。
await ev(`(() => {
  const stage = document.getElementById('stage-view');
  if (stage) stage.hidden = false;
  return true;
})()`);
await delay(200);

const report = await ev(`(() => {
  const stage = document.getElementById('stage-view');
  if (!stage) return 'no stage';
  stage.classList.add('is-path-editing');

  const frame = stage.querySelector('.stage__frame');
  if (!frame) return 'no frame';

  // 按路径编辑器真实的建法，把两根控制条插入舞台。
  const toolbar = document.createElement('div');
  toolbar.className = 'path-editor__toolbar';
  toolbar.innerHTML = '<button class="path-editor__button">保存</button><button class="path-editor__button">试走</button><span class="path-editor__label">第 1 / 2 段</span>';
  const dock = document.createElement('div');
  dock.className = 'path-editor__dock';
  dock.innerHTML = '<div class="path-editor__timeline"><button class="path-editor__clip">1</button><button class="path-editor__clip">2</button></div><div class="path-editor__frames"><label class="path-editor__field"><span>旋转</span><input class="path-editor__time" type="number"></label></div>';
  stage.append(toolbar, dock);

  // 绘制层须按产品的三级结构构造（layer > canvas > svg）；省略 canvas 会使高度折叠为零，从而掩盖待测缺陷。
  const host = document.getElementById('path-editor-host');
  const layer = document.createElement('div');
  layer.className = 'path-editor';
  const canvas = document.createElement('div');
  canvas.className = 'path-editor__canvas';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'path-editor__lines');
  svg.setAttribute('viewBox', '-960 -540 1920 1080');
  svg.setAttribute('preserveAspectRatio', 'none');
  canvas.append(svg);
  layer.append(canvas);
  host.append(layer);

  const r = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };
  const frameBox = r(frame);
  const toolbarBox = r(toolbar);
  const dockBox = r(dock);
  const layerBox = r(layer);
  const canvasBox = r(layer.querySelector('.path-editor__canvas'));
  const svgBox = r(svg);

  const overlaps = (a, b) => !(a.b <= b.t || b.b <= a.t || a.r <= b.l || b.r <= a.l);

  return JSON.stringify({
    frame: frameBox,
    toolbar: toolbarBox,
    dock: dockBox,
    layer: layerBox,
    canvas: canvasBox,
    svg: svgBox,
    toolbarOutsideFrame: !overlaps(toolbarBox, frameBox),
    dockOutsideFrame: !overlaps(dockBox, frameBox),
    layerMatchesFrame: Math.abs(layerBox.l - frameBox.l) <= 1 && Math.abs(layerBox.t - frameBox.t) <= 1
      && Math.abs(layerBox.w - frameBox.w) <= 1 && Math.abs(layerBox.h - frameBox.h) <= 1,
    // 必须实测绘制区尺寸：flex 布局失效时线与点仍存在于 DOM，但容器高度为零，元素不可见且不可点击。
    canvasHasSize: canvasBox.w > 0 && canvasBox.h > 0,
    canvasMatchesFrame: Math.abs(canvasBox.w - frameBox.w) <= 1 && Math.abs(canvasBox.h - frameBox.h) <= 1,
    svgHasSize: svgBox.w > 0 && svgBox.h > 0,
    editorBlur: getComputedStyle(layer).backdropFilter,
    editorBackground: getComputedStyle(layer).backgroundColor,
    frameRatio: (frameBox.w / frameBox.h).toFixed(3),
  });
})()`);

console.log(report);

// 直接把舞台中心的点画出来，量它落在哪里。
const centre = await ev(`(() => {
  const svg = document.querySelector('.path-editor__lines');
  if (!svg) return 'no svg';
  const layer = svg.closest('.path-editor');
  // 舞台 (0,0)：viewBox 里就是 (0,0)，y 取反后仍是 0。
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', '0');
  dot.setAttribute('cy', '0');
  dot.setAttribute('r', '12');
  dot.setAttribute('fill', 'red');
  svg.append(dot);
  const layerBox = layer.getBoundingClientRect();
  const dotBox = dot.getBoundingClientRect();
  return JSON.stringify({
    layerCentreX: Math.round(layerBox.left + layerBox.width / 2),
    layerCentreY: Math.round(layerBox.top + layerBox.height / 2),
    dotCentreX: Math.round(dotBox.left + dotBox.width / 2),
    dotCentreY: Math.round(dotBox.top + dotBox.height / 2),
  });
})()`);
console.log('舞台中心的点：', centre);

// 再把舞台的右上角画出来，验证象限没有翻转。
const corner = await ev(`(() => {
  const svg = document.querySelector('.path-editor__lines');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  // 舞台 (960, 540) 是画面的右上角；y 取反后是 -540。
  dot.setAttribute('cx', '960');
  dot.setAttribute('cy', '-540');
  dot.setAttribute('r', '6');
  dot.setAttribute('fill', 'blue');
  svg.append(dot);
  const layerBox = svg.closest('.path-editor').getBoundingClientRect();
  const dotBox = dot.getBoundingClientRect();
  return JSON.stringify({
    layerRight: Math.round(layerBox.right),
    layerTop: Math.round(layerBox.top),
    dotCentreX: Math.round(dotBox.left + dotBox.width / 2),
    dotCentreY: Math.round(dotBox.top + dotBox.height / 2),
  });
})()`);
console.log('舞台右上角的点：', corner);

// 模糊：整个文档里不应再有 .path-editor 相关的 backdrop-filter
const blurCheck = await ev(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll('.path-editor, .path-editor *')) {
    const s = getComputedStyle(el);
    if (s.backdropFilter && s.backdropFilter !== 'none') bad.push(el.className + ':' + s.backdropFilter);
  }
  return JSON.stringify(bad);
})()`);
console.log('path-editor 上的模糊：', blurCheck);

ws.close();
edge.kill();
server.close();
process.exit(0);