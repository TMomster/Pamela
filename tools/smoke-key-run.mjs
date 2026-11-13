// 端到端复现：验证含 `ch.key()` 的剧本与关键帧文件的预览行程。
// End-to-end reproduction: preview travel for a script containing `ch.key()` and its key frame file.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = "G:/CBS/Pamela/ui";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 8983;
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

const profile = mkdtempSync(join(tmpdir(), "pamela-key-"));
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--window-size=1400,1000",
    "--remote-debugging-port=9345",
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
}, 90_000);

let ws = null;
for (let i = 0; i < 80 && !ws; i += 1) {
  try {
    const list = await fetch("http://127.0.0.1:9345/json/list").then((r) => r.json());
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
const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
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

// 假桥必须在模块跑起来之前就位，否则 main() 启动时看不到项目。
const BRIDGE = `
  window.__files = {
    "scripts/main.pamela": 'ch = Character("hero.png")\\nch.enable()\\nch.key()\\n',
    "data/key-ch.json": JSON.stringify({
      version: 2, id: "ch", name: "ch",
      start: { x: -600, y: 200 },
      segments: [{ type: "line", points: [[-600, 200], [600, -300]], time: 1200 }]
    }, null, 2)
  };
  const project = {
    root: "C:/fake/project", name: "demo",
    entry: "scripts/main.pamela", style: "", typewriter: "off",
    tree: [
      { name: "scripts", path: "scripts", is_dir: true, is_script: false, children: [
        { name: "main.pamela", path: "scripts/main.pamela", is_dir: false, is_script: true, children: [] }
      ]},
      { name: "assets", path: "assets", is_dir: true, is_script: false, children: [] },
      { name: "templates", path: "templates", is_dir: true, is_script: false, children: [] },
      { name: "data", path: "data", is_dir: true, is_script: false, children: [
        { name: "key-ch.json", path: "data/key-ch.json", is_dir: false, is_script: false, children: [] }
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
      // 必须使用有效的 1×1 透明 PNG；缺少位图时不会创建角色元素。
      if (cmd === "read_image" || cmd === "read_asset") return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
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

console.log("=== 桥是否接上 ===");
console.log(await ev(`JSON.stringify({
  hasProject: Boolean(document.getElementById('resource-body')?.textContent.includes('main.pamela')),
  calls: (window.__ipcCalls ?? []).slice(0, 6),
})`));

await ev(`(() => {
  const rows = [...document.querySelectorAll('.tree__row')];
  const row = rows.find(r => r.textContent.includes('main.pamela'));
  if (!row) return 'no row';
  row.click();
  return 'clicked';
})()`);
await delay(900);

console.log("=== 资源树里有 data/key-ch.json 吗 ===");
console.log(await ev(`JSON.stringify({
  treeText: (document.getElementById('resource-body')?.textContent ?? '').replace(/\s+/g,' ').slice(0, 120),
  hasKeyFile: (document.getElementById('resource-body')?.textContent ?? '').includes('key-ch.json'),
})`));
console.log("=== 编辑器里是剧本吗 ===");
console.log(await ev(`JSON.stringify({ text: (document.getElementById('editor-text')?.value ?? '').slice(0, 60) })`));

await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('运行') && !b.classList.contains('is-disabled'));
  if (btn) { btn.click(); return 'clicked ' + btn.textContent.trim(); }
  return 'no run button';
})()`);

const samples = [];
for (let i = 0; i < 14; i += 1) {
  const at = await ev(`(() => {
    const img = document.querySelector('.stage__character');
    return JSON.stringify({ left: img?.style.left ?? null, top: img?.style.top ?? null, status: document.getElementById('status-message')?.textContent ?? '' });
  })()`);
  samples.push(`${i * 150}ms ${at}`);
  await delay(150);
}

console.log("=== 角色位置随时间 ===");
for (const line of samples) console.log(line);
console.log("=== 运行期间读过的文件 ===");
console.log(await ev(`JSON.stringify((window.__ipcCalls ?? []).filter(c => c.startsWith('read_file') || c.startsWith('write_file')))`));
console.log("=== 状态栏 ===");
console.log(await ev(`document.getElementById('status-message')?.textContent ?? ''`));
console.log("=== 控制台错误 ===");
console.log(errors.length ? errors.slice(0, 5).join("\n---\n") : "(无)");

ws.close();
edge.kill();
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(0);
