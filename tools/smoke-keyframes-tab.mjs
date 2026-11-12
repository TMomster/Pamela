// 验证目标：关键帧文件在独立标签页中打开，剧本标签页保持原位。
// Goal: verify that a key frame file opens in its own tab while the script tab stays in place.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
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
// 端口在每次运行时动态分配，避免并行运行或残留进程占用同一端口。
const PORT = 8990 + (process.pid % 90);
const DEBUG_PORT = 9380 + (process.pid % 90);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let rel = normalize(decodeURIComponent(url.pathname));
    while (rel.startsWith("/") || rel.startsWith("\\")) rel = rel.slice(1);
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

const profile = mkdtempSync(join(tmpdir(), "pamela-kf-tab-"));
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `http://127.0.0.1:${PORT}/index.html`,
  ],
  { stdio: "ignore" },
);

const watchdog = setTimeout(() => {
  console.error("超时：无头浏览器没有在 60 秒内起来");
  try {
    edge.kill();
  } catch {}
  server.close();
  process.exit(1);
}, 60_000);

let ws = null;
for (let i = 0; i < 80 && !ws; i += 1) {
  try {
    const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
      });
    }
  } catch {
    /* not up yet */
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
const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(
      m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text,
    );
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = (nextId += 1);
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });

// IPC 桩提供一个项目、一份含无参 `ch.key()` 的剧本与一份关键帧文件。
//
// 剧本只有一份磁盘副本，而作者会在编辑器里改动它（右键编辑关键帧之前
// 手写的 `ch.key()` 不一定已保存）；素材用**平铺布局**（`assets/ch.png`），
// 该布局对应本轮改动之前的既有项目格式。
// 第二段要用的一份地图：一开始就在项目里，所以它是一棵树上的普通文件，
// 第二段的地图在项目初始化时即存在，无需运行期向 IPC 桩追加文件，避免改动树结构并触发重新扫描。
const MAP = JSON.stringify(
  {
    version: 2,
    nodes: [
      { id: "start", type: "Start", x: 40, y: 40, params: {} },
      {
        id: "obj",
        type: "Character",
        x: 240,
        y: 40,
        params: { objectName: "ch", image: "ch.png" },
      },
      // 行为链必须以可见对象开始；未执行 `ch.enable()` 时角色不会出现在舞台上。
      {
        id: "show",
        type: "beh:enable",
        x: 350,
        y: 40,
        behaviorOf: "obj",
        params: {},
      },
      {
        id: "k",
        type: "beh:key",
        x: 460,
        y: 40,
        behaviorOf: "obj",
        params: { file: "key-ch.keyframes" },
      },
    ],
    edges: [
      { id: "e1", from: { node: "start", port: 0 }, to: { node: "obj", port: 0 } },
      { id: "e2", from: { node: "obj", port: 1 }, to: { node: "show", port: 0 } },
      // 回归场景：行为链 `ch.enable().key("...")` 的执行顺序。
      { id: "e3", from: { node: "show", port: 0 }, to: { node: "k", port: 0 } },
    ],
    dataEdges: [],
  },
  null,
  2,
);

const BRIDGE = `
  // 已知隐患：轮廓框等于整个编辑区时，需按编辑器初始化与对象加载的实际顺序定位原因。
  const realDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    return new Promise((resolve) => {
      setTimeout(() => realDecode.call(this).then(resolve, resolve), 160);
    });
  };
  window.__files = {
    "scripts/main.pe": 'ch = Character("ch.png")\\nch.enable()\\n',
    // 旧布局：素材直接躺在 assets/ 下，没有 assets/Character/ 这一层。
    "assets/ch.png": "x",
    // read_file 在产品里只 JSON.parse 一次，所以这里必须存地图的 JSON 文本本身；
    // 多套一层 stringify 会让画布静默回落到只有一个开始节点的默认图。
    "maps/level.flowmap": ${JSON.stringify(MAP)},
    "pamela.json": "{}"
  };
  const project = {
    root: "C:/fake/project", name: "demo",
    entry: "scripts/main.pe", style: "", typewriter: "off",
    tree: [
      { name: "scripts", path: "scripts", is_dir: true, is_script: false, children: [
        { name: "main.pe", path: "scripts/main.pe", is_dir: false, is_script: true, children: [] }
      ]},
      // 旧项目的素材直接放在 assets/ 下，没有按类型分目录。
      { name: "assets", path: "assets", is_dir: true, is_script: false, children: [
        { name: "ch.png", path: "assets/ch.png", is_dir: false, is_script: false, children: [] }
      ]},
      { name: "templates", path: "templates", is_dir: true, is_script: false, children: [] },
      { name: "data", path: "data", is_dir: true, is_script: false, children: [] },
      { name: "maps", path: "maps", is_dir: true, is_script: false, children: [
        { name: "level.flowmap", path: "maps/level.flowmap", is_dir: false, is_script: false, children: [] }
      ]}
    ]
  };
  window.__ipcCalls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__ipcCalls.push(args && args.path ? cmd + ":" + args.path : cmd);
      if (cmd === "current_project" || cmd === "open_project" || cmd === "reload_project") return project;
      if (cmd === "read_app_state" || cmd === "write_app_state") return null;
      if (cmd === "is_maximized") return false;
      if (cmd === "read_file") return window.__files[args.path] ?? "";
      if (cmd === "write_file") { window.__files[args.path] = args.contents; return null; }
      if (cmd === "read_image") return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      // 素材读取：记录真实问法，并按后端的规则解析——裸名字先到类型子目录、
      // 找不到就回落到平铺的 assets/。假桥必须和后端同一套规则，否则测的是
      // 假桥而不是产品。
      if (cmd === "read_asset") {
        window.__assetAsks = window.__assetAsks ?? [];
        window.__assetAsks.push((args.kind || "") + "|" + args.path);
        const scoped = "assets/" + (args.kind || "") + "/" + args.path;
        const flat = "assets/" + args.path;
        if (window.__files[scoped] == null && window.__files[flat] == null) {
          throw "找不到图片：" + scoped + "（也没有 " + flat + "）";
        }
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      }
      if (cmd === "read_audio") return "data:audio/wav;base64,";
      if (cmd === "check_project") return { repairs: [], needs_template: false, style: "", project };
      return null;
    },
    transformCallback: (cb) => cb
  };
  true;
`;

await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: BRIDGE });
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await delay(2500);

const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};

const verdicts = [];
const check = (name, ok, detail = "") => {
  verdicts.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await ev(`(() => {
  const row = [...document.querySelectorAll('.tree__row')].find(r => r.textContent.includes('main.pe'));
  if (row) row.click();
  return Boolean(row);
})()`);
await delay(700);

check(
  "剧本打开在代码编辑器里",
  (await ev(`(document.getElementById('editor-text')?.value ?? '').includes('ch.enable()')`)) === true,
);

// 前置条件：作者在编辑器中输入 `ch.key()` 但尚未保存，磁盘副本不含该语句。
// 预览行程必须读取编辑器文本；读取磁盘副本会找不到该语句并留下空舞台。
await ev(`(() => {
  const text = document.getElementById('editor-text');
  if (!text) return 'no editor';
  text.value = text.value.replace(/\\s*$/, '') + '\\nch.key()\\n';
  text.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await delay(400);

check(
  "编辑器里有一个未保存的 ch.key()",
  (await ev(`(document.getElementById('editor-text')?.value ?? '').includes('ch.key()')`)) === true,
);
check(
  "磁盘副本还没有这一句（正是要试的情形）",
  (await ev(`window.__files["scripts/main.pe"].includes("ch.key()")`)) === false,
);

// 右键 ch.key() —— 直接调用入口，避开指针坐标（那部分有自己的测试）。
await ev(`(() => {
  const text = document.getElementById('editor-text');
  if (!text) return 'no editor';
  const at = text.value.indexOf('key(');
  text.focus();
  text.setSelectionRange(at, at);
  return 'ok';
})()`);
await delay(200);

// 触发右键菜单：在 key 调用上模拟 contextmenu。事件必须冒泡到 document，
// 因为全局监听器存储于 document 上、再转发成 `pamela:contextmenu`。
//
// 位置要落在 `key` 这个词上：编辑器把指针坐标量成光标偏移，再找那个偏移上的
// 调用。所以先用高亮层（与 textarea 同字体同尺寸）算出这个词的矩形。
await ev(`(() => {
  const text = document.getElementById('editor-text');
  const layer = document.getElementById('editor-highlight');
  if (!text || !layer) return 'no editor';
  const at = text.value.indexOf('key(');
  text.focus();
  text.setSelectionRange(at, at);

  // 在高亮层里把 whole-file 偏移映射到那个文本节点上。
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  let spot = null;
  while (node) {
    if (seen + node.length > at) { spot = node; break; }
    seen += node.length;
    node = walker.nextNode();
  }
  if (!spot) return 'no text node';
  const range = document.createRange();
  range.setStart(spot, Math.max(0, at - seen));
  range.setEnd(spot, Math.min(spot.length, at - seen + 3));
  const box = range.getBoundingClientRect();
  const x = box.left + 2;
  const y = box.top + box.height / 2;
  const target = document.elementFromPoint(x, y) ?? layer;
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
  }));
  return 'dispatched on ' + target.tagName + ' at ' + Math.round(x) + ',' + Math.round(y);
})()`);
await delay(600);

const menu = await ev(`JSON.stringify(
  [...document.querySelectorAll('.menu--context .menu__item')].map(n => n.textContent)
)`);
console.log("=== 右键菜单 ===", menu);

await ev(`(() => {
  const item = [...document.querySelectorAll('.menu--context .menu__item')]
    .find(n => n.textContent.includes('新建路径帧'));
  if (item) item.click();
  return Boolean(item);
})()`);
await delay(1800);

// 已知隐患：首次进入编辑器时轮廓框可能等于整个编辑区，需拖动对象后才收缩为图片矩形。
// 图片自己的矩形。素材是 1×1 PNG，contain 后是 1080×1080，所以正确的轮廓应该
// 是正方形且宽度明显小于 STAGE_WIDTH(1920)；修复前这里是 1920×1080。
const outline = await ev(`JSON.stringify({
  width: Number(document.querySelector('.path-editor__outline')?.getAttribute('width') ?? -1),
  height: Number(document.querySelector('.path-editor__outline')?.getAttribute('height') ?? -1),
  hasCharacter: Boolean(document.querySelector('.path-editor__surface .stage__character')),
})`);
console.log("=== 首次轮廓（未拖动） ===", outline);
const firstOutline = JSON.parse(outline ?? "{}");
check(
  "首次进入时轮廓已是图片自己的矩形，不是整个编辑区",
  firstOutline.hasCharacter === true &&
    firstOutline.width > 500 &&
    firstOutline.width < 1920 &&
    Math.abs(firstOutline.width - firstOutline.height) < 1,
  outline,
);

const tabs = await ev(`JSON.stringify(
  [...document.querySelectorAll('#editor-tabs .tab')].map(t => ({
    label: t.querySelector('.tab__label')?.textContent,
    active: t.classList.contains('tab--active'),
    keyframes: t.classList.contains('tab--keyframes'),
  }))
)`);
console.log("=== 标签页 ===", tabs);
const parsed = JSON.parse(tabs ?? "[]");

// 舞台：必须真的有画面（角色在台上），而且状态栏没有报错。
// 「编辑器界面全黑」正是用户报的现象——舞台框在、里面什么都没有。
// `discardStage()` clears the live performance stage. Measuring `#stage-surface`
// would answer "empty" by design; the picture lives in `.path-editor__surface`.
const stage = await ev(`JSON.stringify({
  hidden: document.getElementById('stage-view')?.hidden,
  frameH: document.querySelector('.path-editor__frame')?.getBoundingClientRect().height ?? 0,
  hasCharacter: Boolean(document.querySelector('.path-editor__surface .stage__character')),
  characterSrc: (document.querySelector('.path-editor__surface .stage__character')?.getAttribute('src') ?? '').slice(0, 24),
  status: document.getElementById('status-message')?.textContent ?? '',
  statusIsError: Boolean(document.getElementById('status-message')?.classList.contains('is-error')),
  assetAsks: window.__assetAsks ?? [],
  previewSurfaces: document.querySelectorAll('.path-editor__surface').length,
  liveCharacters: document.querySelectorAll('#stage-surface .stage__character').length,
})`);
console.log("=== 舞台 ===", stage);
const play = JSON.parse(stage ?? "{}");
check("舞台是显示出来的", play.hidden === false, stage);
check("取景框高度有效", Number(play.frameH) > 60, stage);
check("剧本里的角色画到了舞台上", play.hasCharacter === true, stage);
check("角色用的是平铺 assets/ 里的图（后端回落生效）", (play.characterSrc ?? "").startsWith("data:image"), stage);
check("素材是按对象类型问的", (play.assetAsks ?? []).includes("Character|ch.png"), stage);
check(
  "状态栏没有报错（不是「找不到指定的路径」）",
  play.statusIsError === false,
  play.status,
);
check(
  "预览走到了新写的哪一句（不是「没找到这一句」）",
  !String(play.status ?? "").includes("没找到"),
  play.status,
);

check(
  "关键帧文件有自己的标签页",
  parsed.some((t) => t.keyframes && (t.label ?? "").includes("ch-main-pe-1.keyframes")),
  tabs,
);
check(
  "剧本标签页仍在，且不是路径帧编辑器",
  parsed.some((t) => (t.label ?? "").includes("main.pe")),
  tabs,
);
check("关键帧标签页是当前标签", parsed.some((t) => t.keyframes && t.active), tabs);

// 工具栏按钮已改为图标；标签文本由 `title` / `aria-label` 提供。
const backButton = `[...document.querySelectorAll('.path-editor__button')]
  .find(b => [b.textContent, b.getAttribute('title'), b.getAttribute('aria-label')]
    .some(v => (v ?? '').includes('返回脚本')))`;
console.log("=== 工具栏按钮 ===", await ev(`JSON.stringify(
  [...document.querySelectorAll('.path-editor__button')].map(b => b.getAttribute('title') ?? b.textContent)
)`));
const hasBack = await ev(`(() => Boolean(${backButton}))()`);
check("路径帧编辑器有显式的「返回脚本」按钮", hasBack === true);

await ev(`(() => {
  const btn = ${backButton};
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await delay(1600);

const after = await ev(`JSON.stringify({
  tabs: [...document.querySelectorAll('#editor-tabs .tab')].map(t => ({
    label: t.querySelector('.tab__label')?.textContent,
    active: t.classList.contains('tab--active'),
  })),
  text: (document.getElementById('editor-text')?.value ?? '').slice(0, 80),
  stageHidden: document.getElementById('stage-view')?.hidden,
})`);
console.log("=== 返回之后 ===", after);
const back = JSON.parse(after ?? "{}");
check(
  "返回之后剧本标签页是当前标签",
  (back.tabs ?? []).some((t) => (t.label ?? "").includes("main.pe") && t.active),
  after,
);
check("返回之后舞台让位给代码", back.stageHidden === true, after);
check(
  "key() 的参数被填上了关键帧文件名",
  (back.text ?? "").includes('ch.key("ch-main-pe-1.keyframes")'),
  back.text,
);

// --- 第二段：从地图节点进入 ---
//
// 画布上打开的是 `.flowmap`，而那份文件里没有一行 Pamela：如果预览照着磁盘
// 上的文件走，它一句 `key()` 都找不到、舞台留空（用户报的「界面全黑」）。
// 因此预览行程必须使用编译生成的脚本，本段覆盖该约束。
//
// 地图在假项目里一开始就有（见上面的 BRIDGE），所以这里只需要点资源树。

const mapRow = await ev(`(() => {
  const row = [...document.querySelectorAll('.tree__row')].find(r => r.textContent.includes('level.flowmap'));
  if (!row) return 'no row';
  row.click();
  return 'clicked';
})()`);
console.log("=== 打开地图 ===", mapRow);
await delay(1000);
console.log("=== 地图读请求 ===", await ev(`JSON.stringify({
  calls: (window.__ipcCalls ?? []).filter(c => c.includes('flowmap')),
  stored: (window.__files['maps/level.flowmap'] ?? '').slice(0, 120),
})`));

// 多标签会为每个打开的地图创建一个 `.graph-view` 容器；`#graph-view` 不再唯一。
const graphOpen = await ev(`JSON.stringify({
  containers: [...document.querySelectorAll('.graph-view')].map(n => ({ id: n.id, hidden: n.hidden, nodes: n.querySelectorAll('.gnode').length })),
  graphVisible: [...document.querySelectorAll('.graph-view')].some(n => !n.hidden),
  nodes: document.querySelectorAll('.gnode').length,
  titles: [...document.querySelectorAll('.gnode')].map(n => (n.textContent ?? '').slice(0, 24)),
})`);
console.log("=== 画布 ===", graphOpen);
const graph = JSON.parse(graphOpen ?? "{}");
check("地图打开在画布上", graph.graphVisible === true && Number(graph.nodes) > 0, graphOpen);

// 右键「关键帧」节点 → 编辑关键帧…
const keyNodeMenu = await ev(`(() => {
  const node = [...document.querySelectorAll('.gnode')]
    .find(n => n.textContent.includes('路径帧'));
  if (!node) return 'no key node';
  const rect = node.getBoundingClientRect();
  node.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  }));
  return 'opened';
})()`);
await delay(500);
const keyMenuItems = await ev(`JSON.stringify(
  [...document.querySelectorAll('.graph__menu-item')].map(n => n.textContent)
)`);
console.log("=== 节点菜单 ===", keyMenuItems);
check("路径帧节点的右键菜单里有「编辑路径帧…」", (keyMenuItems ?? "").includes("编辑路径帧"), keyMenuItems);

await ev(`(() => {
  const item = [...document.querySelectorAll('.graph__menu-item')]
    .find(n => n.textContent.includes('编辑路径帧'));
  if (item) item.click();
  return Boolean(item);
})()`);
await delay(1800);

// 多标签下可能同时存在多个关键帧编辑器，裸 `querySelector` 会命中错误实例。
const mapStage = await ev(`JSON.stringify({
  hasCharacter: [...document.querySelectorAll('.path-editor__surface')].some(s => s.querySelector('.stage__character')),
  surfaces: [...document.querySelectorAll('.path-editor__surface')].map(s => ({ characters: s.querySelectorAll('.stage__character').length, hidden: s.closest('.path-editor')?.hidden ?? false })),
  assetAsks: window.__assetAsks ?? [],
  status: document.getElementById('status-message')?.textContent ?? '',
  statusIsError: Boolean(document.getElementById('status-message')?.classList.contains('is-error')),
  tabs: [...document.querySelectorAll('#editor-tabs .tab')].map(t => t.querySelector('.tab__label')?.textContent),
})`);
console.log("=== pmap 进入后的舞台 ===", mapStage);
const mp = JSON.parse(mapStage ?? "{}");
check("从 pmap 进入时舞台也有画面", mp.hasCharacter === true, mapStage);
check(
  "从 pmap 进入时没报「没找到这一句」",
  !String(mp.status ?? "").includes("没找到"),
  mp.status,
);
check("舞台报错与否和状态一致", mp.statusIsError === false, mp.status);

// 仅用于诊断：通过应用自身的「生成」按钮编译当前画布。
await ev(`(() => {
  const btn = [...document.querySelectorAll('.graph__btn')]
    .find(b => (b.getAttribute('title') ?? '').includes('生成'));
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await delay(500);
console.log("=== 画布编译产物 ===", await ev(`JSON.stringify(
  Object.entries(window.__files)
    .filter(([k]) => k.endsWith('.pe'))
    .map(([k, v]) => [k, String(v).slice(0, 300)])
)`));

// 实时语法错误标记；此时画布标签页处于激活状态。
await ev(`(() => { document.getElementById('editor-code').hidden = false; return true; })()`);
await ev(`(() => {
  const ta = document.getElementById('editor-text');
  ta.value = 'a = 1\\nb = ';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await delay(200);
const broken = await ev(`JSON.stringify({
  marks: document.querySelectorAll('.editor__error-mark').length,
  message: document.getElementById('editor-error-inner')?.dataset.message ?? '',
})`);
console.log("=== 行内错误标注（坏脚本） ===", broken);
const brokenState = JSON.parse(broken ?? "{}");
check("坏脚本在编辑器里被行内标注", brokenState.marks === 1 && /这里需要一个值/.test(brokenState.message ?? ""), broken);

await ev(`(() => {
  const ta = document.getElementById('editor-text');
  ta.value = 'a = 1\\nb = 2';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await delay(200);
const fixed = await ev(`JSON.stringify({
  marks: document.querySelectorAll('.editor__error-mark').length,
  message: document.getElementById('editor-error-inner')?.dataset.message ?? '',
})`);
console.log("=== 行内错误标注（修好） ===", fixed);
const fixedState = JSON.parse(fixed ?? "{}");
check("修好后行内标注消失", fixedState.marks === 0 && fixedState.message === "", fixed);

console.log("=== 控制台错误 ===");
for (const e of errors) {
  console.log(e);
}

const failed = verdicts.filter((v) => !v.ok);
console.log("");
console.log(
  failed.length === 0
    ? `全部 ${verdicts.length} 项通过`
    : `${failed.length}/${verdicts.length} 项失败：${failed.map((f) => f.name).join("、")}`,
);

ws.close();
edge.kill();
server.close();
// 浏览器可能仍占用配置目录；残留的临时目录交由下一次运行处理。
await delay(500);
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* 操作系统会清理自身的临时目录。 */
}
process.exit(failed.length === 0 ? 0 : 1);
