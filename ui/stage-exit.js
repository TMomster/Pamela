// 覆盖在舞台上的「退出演出」确认。
// Pamela — the "leave the stage?" card drawn over the scene.
//
// 为什么它是一层舞台而不是一个窗口级对话框：舞台全屏时 `.tabs` 与 `#menubar`
// 都被藏起来，屏幕上没有「关闭标签」可点，Esc 是唯一的出口。因此它要和存档格
// 子、设置面板一样住在 `.stage__frame` 里，盖住画面本身，而不是飘在窗口中央。

/** 卡片上的三行字。导出成常量，测试与文档都断言同一份文案。 */
export const STAGE_EXIT_TITLE = "退出演出";
export const STAGE_EXIT_BODY = "离开舞台、回到编辑器？正在进行的演出会停在这里。";
export const STAGE_EXIT_CONFIRM = "退出";
export const STAGE_EXIT_CANCEL = "返回";

/**
 * 在 `host` 里画一张确认卡，并接管开着时的 Esc / Enter。
 *
 * 键位就是需求里的那两句：**Enter 确认、Esc 返回**。两者都在 `document` 的
 * 捕获阶段拦下来 —— 舞台自己的 Space / Enter 推进台词的监听器挂在
 * `#stage-view` 上，而这个卡片正是它的后代，不拦住的话一次 Enter 会既确认
 * 退出又推一句台词。
 *
 * @param {object} options
 * @param {HTMLElement} options.host `#stage-exit`，在 `.stage__frame` 里。
 * @param {() => void} [options.onConfirm] 按 Enter 或点「退出」时调用。
 * @param {() => void} [options.onCancel] 按 Esc、点「返回」或点背景时调用。
 * @returns {{ element: HTMLElement, open: () => void, close: () => void,
 *   isOpen: () => boolean, confirm: () => void, cancel: () => void }}
 */
export function createStageExitConfirm({ host, onConfirm = () => {}, onCancel = () => {} }) {
  if (!host) {
    throw new Error("createStageExitConfirm 需要一个容器");
  }

  let open = false;
  /** 打开之前焦点在哪，收起时还回去。 */
  let previous = null;

  /**
   * 收起卡片，并回答这次是确认还是返回。
   *
   * 先摘监听器再回调：`onConfirm` 会一路走到 `closeStage()`，而关舞台的最后一步
   * 又会回过头来把这个面板关掉，那时候它必须已经是「关着」的状态。
   */
  const settle = (confirmed) => {
    if (!open) {
      return;
    }
    open = false;
    document.removeEventListener("keydown", onKeyDown, true);
    host.hidden = true;
    host.replaceChildren();
    // 焦点还给打开之前的位置：舞台的 Space / Enter 监听挂在舞台元素上，焦点
    // 掉到 body 之后，取消的人会发现按键推不动台词了。
    previous?.focus?.();
    previous = null;
    if (confirmed) {
      onConfirm();
    } else {
      onCancel();
    }
  };

  /** 键盘：Enter 确认、Esc 返回，其余键一律不往下传。 */
  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settle(false);
      return;
    }
    if (event.key === "Enter" || event.key === "NumpadEnter") {
      event.preventDefault();
      event.stopPropagation();
      settle(true);
      return;
    }
    // 空格也是舞台的「推进」键。卡片开着的时候它什么都不该做，但也不能漏到
    // 舞台上去把台词推下去。
    if (event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const button = (action, label, key, primary) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = primary
      ? "stage-exit__button stage-exit__button--primary"
      : "stage-exit__button";
    node.dataset.action = action;
    node.textContent = label;

    // 键位提示跟在字后面，而不是写在括号里：一眼能看出这个卡片怎么用键盘走。
    const hint = document.createElement("span");
    hint.className = "stage-exit__key";
    hint.textContent = key;
    node.append(hint);

    node.addEventListener("click", () => settle(action === "confirm"));
    return node;
  };

  const draw = () => {
    const panel = document.createElement("div");
    panel.className = "stage-exit__panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", STAGE_EXIT_TITLE);

    const title = document.createElement("h2");
    title.className = "stage-exit__title";
    title.textContent = STAGE_EXIT_TITLE;

    const body = document.createElement("p");
    body.className = "stage-exit__body";
    body.textContent = STAGE_EXIT_BODY;

    const actions = document.createElement("div");
    actions.className = "stage-exit__actions";
    const confirm = button("confirm", STAGE_EXIT_CONFIRM, "Enter", true);
    actions.append(confirm, button("cancel", STAGE_EXIT_CANCEL, "Esc", false));

    panel.append(title, body, actions);
    host.replaceChildren(panel);
    host.hidden = false;
    // 焦点落在「退出」上，这样键盘和鼠标都指着同一个默认动作。
    confirm.focus?.();
  };

  // 点背景当作返回：这张卡是为了挡住一次误触，背景不该成为「退出」的快捷键。
  // 监听器只挂一次，卡片每次重画时不会被越挂越多。
  host.addEventListener("click", (event) => {
    if (event.target === host) {
      settle(false);
    }
  });

  return {
    element: host,
    open: () => {
      if (open) {
        return;
      }
      open = true;
      previous = document.activeElement ?? null;
      draw();
      document.addEventListener("keydown", onKeyDown, true);
    },
    close: () => {
      if (!open) {
        return;
      }
      open = false;
      document.removeEventListener("keydown", onKeyDown, true);
      host.hidden = true;
      host.replaceChildren();
    },
    isOpen: () => open,
    confirm: () => settle(true),
    cancel: () => settle(false),
  };
}
