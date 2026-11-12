// 用无头 Edge 与 CDP 启动真实页面，验证 `main.js` 可正常执行。
// Launch a real page with headless Edge and CDP to verify that `main.js` executes.

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
const PORT = Number(process.env.PAMELA_PORT ?? 8971);

function findEdge() {
  const candidates = [
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? "msedge";
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  // 窗口字体来自 `ui/fonts/` 下的文件；浏览器仅在显式加载后使用。
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
    const file = join(ROOT, rel === "" ? "index.html" : rel);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

// 每次运行使用系统临时目录下的全新配置，避免沿用上次运行的状态。
const profile = mkdtempSync(join(tmpdir(), "pamela-edge-"));

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-port=9333",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `http://127.0.0.1:${PORT}/index.html`,
  ],
  { stdio: "ignore" },
);

// 浏览器未启动时必须判定检查失败，不得无限等待。
const watchdog = setTimeout(() => {
  console.error("smoke: 浏览器在 60 秒内没有起来");
  edge.kill();
  process.exit(1);
}, 60_000);
watchdog.unref();

/* 统一释放本次运行创建的全部资源。 */
function cleanup() {
  clearTimeout(watchdog);
  try {
    ws?.close();
  } catch {
    /* 资源已释放。 */
  }
  edge.kill();
  server.close();
  // 尽力清理：浏览器退出时可能仍在写入配置目录。
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 由系统临时目录清理机制处理。 */
  }
}

/** CDP 的最小封装：连上页面的 WebSocket，发命令、收事件。 */
async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", reject, { once: true });
        });
        return ws;
      }
    } catch {
      // not up yet
    }
    await delay(250);
  }
  throw new Error("连不上 CDP");
}

let ws = null;
try {
  ws = await connect();
} catch (error) {
  console.error(`smoke: ${error.message}`);
  cleanup();
  process.exit(1);
}
let nextId = 0;
const pending = new Map();
const consoleErrors = [];

ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  if (message.method === "Runtime.exceptionThrown") {
    const d = message.params.exceptionDetails;
    consoleErrors.push(d.exception?.description ?? d.text);
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
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await delay(2500);

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) {
    return { error: result.result.exceptionDetails.text };
  }
  return result.result?.result?.value;
};

const report = await evaluate(`(() => {
  const menubar = document.getElementById("menubar");
  const maximize = document.getElementById("titlebar-maximize");
  return {
    hasMenubar: Boolean(menubar),
    menubarChildren: menubar ? menubar.children.length : 0,
    menubarText: menubar ? menubar.textContent.trim().slice(0, 60) : "",
    // 按钮存在于标记中；其处理函数仅在 IPC 就绪后绑定。
    hasWindowButtons: Boolean(
      document.getElementById("titlebar-minimize") &&
      maximize &&
      document.getElementById("titlebar-close"),
    ),
    statusProject: document.getElementById("status-project")?.textContent ?? "",
  };
})()`);

console.log("=== 页面状态 ===");
console.log(JSON.stringify(report, null, 2));

// 帮助 / 关于：工具栏上的两个直接动作，打开内置只读阅读器。不依赖项目——
// 首次启动、还没建项目时也应该读得到。
const opened = await evaluate(`(() => {
  const action = document.querySelector('.menubar__title--action[data-command="app.help"]');
  if (!action) return false;
  action.click();
  return true;
})()`);
await delay(150);
const help = await evaluate(`(() => {
  const view = document.getElementById("reader-view");
  const item = (selector) => document.querySelector(selector)?.textContent ?? "";
  return {
    opened: view ? !view.hidden : false,
    title: item("#reader-view .reader__title"),
    headings: document.querySelectorAll("#reader-view .reader__heading").length,
    toc: [...document.querySelectorAll(".reader-toc__title")].map((node) => node.textContent),
    active: item(".reader-toc__item.is-active .reader-toc__title"),
    panelTitle: item("#resource-title"),
    status: item("#status-file"),
    editable: Boolean(view?.querySelector("textarea, input")),
  };
})()`);

// 正文上方的宽度控件：拖动改栏宽、控件与正文等宽、双击复位。
const width = await evaluate(`(() => {
  const view = document.getElementById("reader-view");
  const bar = view?.querySelector(".reader__measure");
  if (!bar) return { found: false };
  const article = view.querySelector(".reader__article");
  const read = () => ({
    measure: Number.parseFloat(getComputedStyle(view).getPropertyValue("--reader-measure")) || 0,
    column: Math.round(article.getBoundingClientRect().width),
    grip: Math.round(bar.getBoundingClientRect().width),
    now: Number.parseInt(bar.getAttribute("aria-valuenow") ?? "", 10) || 0,
  });
  const start = read();
  const rect = bar.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  bar.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, button: 0, bubbles: true }));
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + 40, clientY: y, bubbles: true }));
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: x + 40, clientY: y, bubbles: true }));
  const dragged = read();
  bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const reset = read();
  return { found: true, start, dragged, reset };
})()`);

// 切换到目录中的第二篇文章，右侧正文与目录高亮同步更新。
const swapped = await evaluate(`(() => {
  const items = [...document.querySelectorAll(".reader-toc__item")];
  items[1]?.click();
  return document.querySelector("#reader-view .reader__title")?.textContent ?? "";
})()`);

const about = await evaluate(`(() => {
  document.querySelector('.menubar__title--action[data-command="app.about"]')?.click();
  return {
    title: document.querySelector("#reader-view .reader__title")?.textContent ?? "",
    toc: [...document.querySelectorAll(".reader-toc__title")].map((node) => node.textContent),
  };
})()`);

// 关掉阅读器的标签页：回到资源树，而不是留在一个没有内容的面板里。
const closed = await evaluate(`(() => {
  document.querySelector(".tab--reader .tab__close")?.click();
  return {
    hidden: document.getElementById("reader-view")?.hidden ?? false,
    panelTitle: document.getElementById("resource-title")?.textContent ?? "",
  };
})()`);

console.log("=== 内置阅读器 ===");
console.log(JSON.stringify({ opened, help, width, swapped, about, closed }, null, 2));
console.log("=== 控制台错误 ===");
// 无 Tauri 宿主时应用会自行给出提示，该提示在本检查中属预期结果。
const unexpected = consoleErrors.filter((line) => !line.includes("no IPC bridge"));
console.log(consoleErrors.length ? consoleErrors.join("\n---\n") : "(无)");

const readerOk =
  opened === true &&
  help.opened === true &&
  help.title === "基础使用" &&
  help.headings > 0 &&
  // 目录随帮助文档增删条目而变，这里只要求它确实建起来了。
  help.toc.length >= 7 &&
  help.active === "基础使用" &&
  help.panelTitle === "目录" &&
  help.status.includes("基础使用") &&
  help.editable === false &&
  // 宽度控件：拖动变宽、控件与正文等宽、双击回到默认值。
  width.found === true &&
  width.dragged.measure > width.start.measure &&
  Math.abs(width.dragged.grip - width.dragged.column) <= 1 &&
  Math.abs(width.dragged.now - width.dragged.measure) < 0.5 &&
  width.reset.measure === width.start.measure &&
  swapped === "代码" &&
  about.title === "声明" &&
  about.toc.length === 5 &&
  closed.hidden === true &&
  closed.panelTitle === "资源";

cleanup();
process.exit(
  report.hasMenubar &&
    report.menubarChildren > 0 &&
    unexpected.length === 0 &&
    readerOk
    ? 0
    : 1,
);
