// 应用内错误气泡：右下角红色圆角常驻通知。
// 与模态框不同，它不阻断操作，需手动关闭，可堆叠多条。
// Pamela — in-app error bubble: a persistent, manually-dismissed corner notice.

/**
 * 从任意形态的错误里抽出 { message, line, file }。
 *
 * 解释器的运行时错误是结构化对象（带 `line`/`file`）；导出与某些路径抛出的可能
 * 是 `Error` 或纯字符串，行号有时嵌在「第 N 行」这种文案里。统一归一成这三个
 * 字段，供跳转标签与高亮行使用。
 *
 * @param {unknown} error
 * @returns {{ message: string, line: number | null, file: string | null }}
 */
export function classifyError(error) {
  let message = "脚本执行出错";
  let line = null;
  let file = null;
  if (error && typeof error === "object") {
    if (typeof error.message === "string" && error.message) {
      message = error.message;
    }
    if (Number.isFinite(Number(error.line))) {
      line = Number(error.line);
    }
    if (typeof error.file === "string" && error.file) {
      file = error.file;
    }
  } else if (error instanceof Error) {
    message = error.message;
  } else if (error != null) {
    message = String(error);
  }
  if (line == null) {
    const match = /第\s*(\d+)\s*行/.exec(message);
    if (match) {
      line = Number(match[1]);
    }
  }
  return { message, line, file };
}

/** 气泡堆叠上限；超出时移除最早的一条。 */
const STACK_LIMIT = 5;

/** 气泡滑走的时长（毫秒），与样式表里的动画一致。 */
const EXIT_MS = 180;

/** 正在滑走的气泡：同一个气泡只走一次，也不再算进堆叠上限。 */
const closing = new WeakSet();

/**
 * 让气泡向右划走，然后摘掉它。
 *
 * 直接 `remove()` 就没有「划走」这一下，通知会啪地不见。这里先挂上收尾的类，
 * 等动画走完再摘掉节点；动画被跳过时（窗口在后台、标签页不可见）由兜底的计时器
 * 收尾，通知不会留在屏幕上。
 *
 * @param {HTMLElement} bubble 要收起来的气泡。
 */
export function dismissBubble(bubble) {
  if (!bubble || closing.has(bubble)) {
    return;
  }
  closing.add(bubble);
  bubble.className = `${bubble.className} is-closing`;
  const finish = () => bubble.remove();
  bubble.addEventListener?.("animationend", finish, { once: true });
  setTimeout(finish, EXIT_MS + 60);
}

/** 容器里还在的（没在滑走的）气泡。 */
function liveBubbles(container) {
  return [...container.children].filter((child) => !closing.has(child));
}

/**
 * 在右下角弹出一个红色圆角常驻气泡，写入简要错误报告。
 *
 * @param {object} options
 * @param {string} options.heading 标题，如「运行出错」。
 * @param {string} options.detail 简要错误报告（通常含行号）。
 * @param {{ label: string, onClick: () => void }[]} [options.actions] 可选操作按钮。
 * @returns {HTMLElement | null} 气泡元素；容器缺失时为 null。
 */
export function pushErrorBubble({ heading, detail, actions = [] }) {
  const container = document.getElementById("error-bubbles");
  if (!container) {
    return null;
  }
  const bubble = document.createElement("div");
  bubble.className = "error-bubble";
  bubble.setAttribute("role", "alert");

  const title = document.createElement("p");
  title.className = "error-bubble__title";
  title.textContent = heading;

  const body = document.createElement("p");
  body.className = "error-bubble__body";
  body.textContent = detail;

  bubble.append(title, body);
  if (actions.length) {
    const foot = document.createElement("div");
    foot.className = "error-bubble__actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "error-bubble__button";
      button.textContent = action.label;
      button.addEventListener("click", () => action.onClick());
      foot.append(button);
    }
    bubble.append(foot);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "error-bubble__close";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  close.addEventListener("click", () => dismissBubble(bubble));

  bubble.append(close);
  container.append(bubble);
  while (liveBubbles(container).length > STACK_LIMIT) {
    liveBubbles(container)[0]?.remove();
  }
  return bubble;
}

/**
 * 在右下角弹出一个绿色气泡，短暂显示后自行消失。
 *
 * 与错误气泡共用一个容器和外形，但性质相反：错误要等人看见并手动关掉，
 * 提示只说明「现在可以按什么键」，不打断操作，也不堆叠成待办。
 *
 * @param {object} options
 * @param {string} options.text 提示文字。
 * @param {number} [options.duration] 显示时长（毫秒），默认 5000。
 * @returns {HTMLElement | null} 气泡元素；容器缺失时为 null。
 */
export function pushToast({ text, duration = 5000 }) {
  const container = document.getElementById("error-bubbles");
  if (!container) {
    return null;
  }
  const bubble = document.createElement("div");
  bubble.className = "error-bubble error-bubble--success";
  bubble.setAttribute("role", "status");

  const body = document.createElement("p");
  body.className = "error-bubble__body";
  body.textContent = text;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "error-bubble__close";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  close.addEventListener("click", () => dismissBubble(bubble));

  bubble.append(body, close);
  container.append(bubble);
  while (liveBubbles(container).length > STACK_LIMIT) {
    liveBubbles(container)[0]?.remove();
  }
  // 到点了就收起来：先向右划走，划完才摘掉节点。
  setTimeout(() => dismissBubble(bubble), Math.max(0, duration));
  return bubble;
}
