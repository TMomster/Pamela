// 端到端验证阶段 11 的「关键帧复制 / 重命名」接线层。
// End-to-end check for the stage 11 key frame copy/rename wiring.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = "G:/CBS/Pamela/ui";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
// 端口区间与其它冒烟脚本分离，避免两次运行共享同一端口。
const PORT = 9100 + (process.pid % 90);
const DEBUG_PORT = 9500 + (process.pid % 90);
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

const profile = mkdtempSync(join(tmpdir(), "pamela-stage11-"));
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
  server.close();
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

const DOC = {
  version: 2,
  id: "ch",
  name: "ch",
  start: { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1 },
  segments: [
    {
      type: "line",
      points: [[0, 0], [100, 0]],
      time: 1000,
      end: { rotation: 0, scale: 1, alpha: 1, scaleX: 1, scaleY: 1 },
    },
  ],
};
const MAP = {
  version: 2,
  nodes: [
    { id: "start", type: "Start", x: 40, y: 40, params: {} },
    { id: "obj", type: "Character", x: 240, y: 40, params: { objectName: "ch", image: "ch.png" } },
    { id: "show", type: "beh:enable", x: 350, y: 40, behaviorOf: "obj", params: {} },
    { id: "k", type: "beh:key", x: 460, y: 40, behaviorOf: "obj", params: { file: "key-ch.keyframes" } },
  ],
  edges: [
    { id: "e1", from: { node: "start", port: 0 }, to: { node: "obj", port: 0 } },
    { id: "e2", from: { node: "obj", port: 1 }, to: { node: "show", port: 0 } },
    { id: "e3", from: { node: "show", port: 0 }, to: { node: "k", port: 0 } },
  ],
  dataEdges: [],
};
const FILES = {
  "scripts/main.pe": 'ch = Character("ch.png")\nch.enable()\nch.key("key-ch.keyframes")\n',
  "scripts/second.pe": 'npc = Character("ch.png")\nnpc.key("key-ch.keyframes")\n',
  "maps/level.flowmap": JSON.stringify(MAP, null, 2),
  "data/key-ch.keyframes": JSON.stringify(DOC, null, 2),
  "assets/ch.png": "x",
  "pamela.json": "{}",
};
const PROJECT = {
  root: "C:/fake/stage11",
  name: "stage11",
  entry: "scripts/main.pe",
  style: "",
  typewriter: "off",
  tree: [
    { name: "scripts", path: "scripts", is_dir: true, is_script: false, children: [
      { name: "main.pe", path: "scripts/main.pe", is_dir: false, is_script: true, children: [] },
      { name: "second.pe", path: "scripts/second.pe", is_dir: false, is_script: true, children: [] },
    ] },
    { name: "assets", path: "assets", is_dir: true, is_script: false, children: [
      { name: "ch.png", path: "assets/ch.png", is_dir: false, is_script: false, children: [] },
    ] },
    { name: "templates", path: "templates", is_dir: true, is_script: false, children: [] },
    { name: "data", path: "data", is_dir: true, is_script: false, children: [
      { name: "key-ch.keyframes", path: "data/key-ch.keyframes", is_dir: false, is_script: false, children: [] },
    ] },
    { name: "maps", path: "maps", is_dir: true, is_script: false, children: [
      { name: "level.flowmap", path: "maps/level.flowmap", is_dir: false, is_script: false, children: [] },
    ] },
  ],
};

const BRIDGE = `
  window.__files = ${JSON.stringify(FILES)};
  window.__project = ${JSON.stringify(PROJECT)};
  window.__ipcCalls = [];
  const project = window.__project;
  const findNode = (path) => {
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.path === path) return n;
        const hit = walk(n.children || []);
        if (hit) return hit;
      }
      return null;
    };
    return walk(project.tree);
  };
  const parentOf = (path) => {
    const i = path.lastIndexOf("/");
    return i === -1 ? null : findNode(path.slice(0, i));
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__ipcCalls.push(cmd + ":" + (args && (args.path || args.from) ? (args.path || args.from) : ""));
      if (cmd === "current_project" || cmd === "open_project" || cmd === "reload_project") return project;
      if (cmd === "read_app_state" || cmd === "write_app_state") return null;
      if (cmd === "is_maximized") return false;
      if (cmd === "read_file") return window.__files[args.path] ?? "";
      if (cmd === "write_file") { window.__files[args.path] = args.contents; return null; }
      if (cmd === "read_image" || cmd === "read_asset") return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      if (cmd === "read_audio") return "data:audio/wav;base64,";
      if (cmd === "check_project") return { repairs: [], needs_template: false, style: "", project };
      if (cmd === "rename_entry") {
        const from = args.from, to = args.to;
        const i = from.lastIndexOf("/");
        const dest = (i === -1 ? "" : from.slice(0, i) + "/") + to;
        window.__files[dest] = window.__files[from];
        delete window.__files[from];
        const node = findNode(from);
        if (node) { node.path = dest; node.name = to; }
        return null;
      }
      if (cmd === "copy_entry") {
        window.__files[args.to] = window.__files[args.from];
        const parent = parentOf(args.to);
        const name = args.to.split("/").pop();
        if (parent && !(parent.children || []).some((c) => c.name === name)) {
          parent.children.push({ name, path: args.to, is_dir: false, is_script: false, children: [] });
        }
        return null;
      }
      if (cmd === "delete_entry") {
        delete window.__files[args.path];
        const parent = parentOf(args.path);
        if (parent) parent.children = parent.children.filter((c) => c.path !== args.path);
        return null;
      }
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
  verdicts.push({ name, ok });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* 为指定资源树行打开右键菜单。 */
const rightClick = async (path) => {
  const answer = await ev(`(() => {
    const row = [...document.querySelectorAll('.tree__row')]
      .find((r) => r.dataset.path === ${JSON.stringify(path)});
    if (!row) return 'no row';
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 180, clientY: 240
    }));
    return 'ok';
  })()`);
  await delay(180);
  return answer;
};

/* 点击已打开右键菜单中的指定项。 */
const clickMenu = async (label) => {
  const answer = await ev(`(() => {
    const item = [...document.querySelectorAll('.menu--context .menu__item')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!item) return 'no item';
    if (item.classList.contains('is-disabled')) return 'disabled';
    item.click();
    return 'ok';
  })()`);
  await delay(200);
  return answer;
};

/* 填写并确认重命名对话框。 */
const confirmDialog = async (name) => {
  const answer = await ev(`(() => {
    const input = document.querySelector('.modal-overlay .modal__input');
    if (!input) return 'no input';
    input.value = ${JSON.stringify(name)};
    const button = document.querySelector('.modal-overlay .modal__button--primary');
    if (!button) return 'no button';
    button.click();
    return 'ok';
  })()`);
  await delay(800);
  return answer;
};

/* 资源面板上的快捷入口，文件操作撤销栈位于此处。 */
const shortcut = async (key) => {
  await ev(`(() => {
    document.getElementById('resource-body').dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true
    }));
    return true;
  })()`);
  await delay(700);
};

/* 一次往返读取本检查所需的全部状态。 */
const state = async () =>
  JSON.parse(
    (await ev(`JSON.stringify({
      files: Object.keys(window.__files).filter((k) => k.startsWith('data/')).sort(),
      old: window.__files['data/key-ch.keyframes'] ?? null,
      hero: window.__files['data/key-hero.keyframes'] ?? null,
      copy: window.__files['data/key-hero-copy.keyframes'] ?? null,
      mainDisk: window.__files['scripts/main.pe'],
      mainEditor: document.getElementById('editor-text')?.value ?? null,
      second: window.__files['scripts/second.pe'],
      map: window.__files['maps/level.flowmap'],
      status: document.getElementById('status-message')?.textContent ?? ''
    })`)) ?? "{}",
  );

const idOf = (text) => {
  try {
    return JSON.parse(text).id;
  } catch {
    return null;
  }
};

// --- 0. 初始状态 ---

// 入口脚本被显式打开；打开状态下引用重写需同步到编辑器缓冲。
await ev(`(() => {
  const row = [...document.querySelectorAll('.tree__row')]
    .find((r) => r.dataset.path === 'scripts/main.pe');
  if (row) row.click();
  return Boolean(row);
})()`);
await delay(600);

let s = await state();
check("初始：关键帧文件 id 是 ch", idOf(s.old) === "ch", String(idOf(s.old)));
check("初始：脚本与画布都点名 key-ch.keyframes",
  String(s.mainEditor).includes('key("key-ch.keyframes")') &&
  String(s.second).includes('key("key-ch.keyframes")') &&
  String(s.map).includes('"file": "key-ch.keyframes"'));
check("初始：树里找得到关键帧文件行", (await rightClick("data/key-ch.keyframes")) === "ok");
check("右键菜单里有「重命名…」", (await clickMenu("重命名…")) !== "no item");
check("重命名对话框能填并确认", (await confirmDialog("key-hero.keyframes")) === "ok");

// --- 1. 重命名 ---

s = await state();
check("重命名：旧文件不在了，新文件在", s.old === null && Boolean(s.hero),
  JSON.stringify(s.files));
check("重命名：新文件内部 id / name 跟着变成 hero",
  idOf(s.hero) === "hero" && JSON.parse(s.hero).name === "hero");
check("重命名：打开的脚本经 textarea 改到新名（磁盘仍待作者保存）",
  String(s.mainEditor).includes('key("key-hero.keyframes")') &&
  !String(s.mainDisk).includes('key("key-hero.keyframes")'));
check("重命名：未打开的脚本直接写盘", String(s.second).includes('key("key-hero.keyframes")'));
check("重命名：flowmap 的 params.file 同步", String(s.map).includes('"file": "key-hero.keyframes"'));
check("重命名：没有留下无名副本", s.files.length === 1, JSON.stringify(s.files));

// --- 2. 撤销 / 重做 ---

await shortcut("z");
s = await state();
check("撤销：文件、id 与三处引用全部回到旧名",
  idOf(s.old) === "ch" && s.hero === null &&
  String(s.mainEditor).includes('key("key-ch.keyframes")') &&
  String(s.second).includes('key("key-ch.keyframes")') &&
  String(s.map).includes('"file": "key-ch.keyframes"'),
  JSON.stringify(s.files));

await shortcut("y");
s = await state();
check("重做：再次落到新名，且 id 仍是 hero",
  idOf(s.hero) === "hero" && String(s.second).includes('key("key-hero.keyframes")'));

// --- 3. 复制 / 粘贴 ---

const copyOpen = await rightClick("data/key-hero.keyframes");
const copyPick = await clickMenu("复制");
check("右键新文件能复制", copyOpen === "ok" && copyPick === "ok", `${copyOpen}/${copyPick}`);
const pasteOpen = await rightClick("data");
const pastePick = await clickMenu("粘贴");
check("右键 data 文件夹能粘贴", pasteOpen === "ok" && pastePick === "ok", `${pasteOpen}/${pastePick}`);
s = await state();
check("复制：新文件名是合法 id，且不是源 id",
  Boolean(s.copy) && idOf(s.copy) === "hero-copy", JSON.stringify(s.files));
check("复制：源文件没被改动", idOf(s.hero) === "hero");
check("复制：状态栏提示了新 id 与 key() 写法",
  /key-hero-copy\.keyframes/.test(s.status) && /hero-copy/.test(s.status), s.status);

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
await delay(500);
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* 操作系统会清理自身的临时目录。 */
}
process.exit(failed.length === 0 ? 0 : 1);
