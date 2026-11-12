// 选项层：问题、候选答案与单选点击。
// Pamela — the choice layer: a question, a few answers, one click.
// 未选择时返回 `-1`；数字键与选项文本一一对应。
/**
 * Builds the choice layer over one stage layer node.
 *
 * @param {object} options
 * @param {HTMLElement} options.node The layer's node.
 * @returns {{ node: HTMLElement, ask: (labels: string[]) => Promise<number>,
 *   clear: () => void, isWaiting: () => boolean }}
 */

export function createChoices({ node }) {
  /**
   * Resolves the question on screen, or `null` when none is up.
   *
   * One at a time is the whole rule, for the same reason a `cue` block cannot
   * show two lines at once: a script can only be reading one answer.
   */
  let waiting = null;

  // The buttons live in one box that is refilled per question, so the layer's
  // own children stay put and only its contents change.
  const list = document.createElement("div");
  list.className = "stage__choice";
  node.append(list);
  node.hidden = true;

  /** Whether the number-key listener is on. It is on only while a question is up. */
  let listening = false;

  /** Hides the question and records the choice; `-1` when no option was selected. */
  const settle = (picked = -1) => {
    const resolve = waiting;
    waiting = null;
    node.hidden = true;
    list.replaceChildren();
    stopListening();
    resolve?.(picked);
  };

  /**
   * Shows a question and answers the index the player picked.
   *
   * Refused while another question is up — thrown synchronously, so the
   * interpreter reports it in the status bar like any other script error.
   */
  const ask = (labels) => {
    if (waiting) {
      throw new Error("cue 中不能同时出现两个选择支，Pamela 不允许并发选择");
    }

    const buttons = labels.map((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stage__choice__button";
      // The number appears in the text, so the shortcut is documented in the interface.
      button.textContent = `${index + 1}. ${label}`;
      button.addEventListener("click", () => {
        if (waiting) {
          settle(index);
        }
      });
      return button;
    });

    list.replaceChildren(...buttons);
    node.hidden = false;
    startListening();
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };

  // A number key picks the row it names while a question is up. The listener is
  // attached for the question and removed when it settles, so a stage that
  // comes and goes does not leave one behind per visit.
  const onKeyDown = (event) => {
    if (!waiting) {
      return;
    }
    const picked = Number(event?.key);
    if (!Number.isInteger(picked) || picked < 1 || picked > list.childNodes.length) {
      return;
    }
    event.preventDefault();
    settle(picked - 1);
  };

  function startListening() {
    if (listening || typeof document === "undefined") {
      return;
    }
    if (typeof document.addEventListener !== "function") {
      return;
    }
    document.addEventListener("keydown", onKeyDown);
    listening = true;
  }

  function stopListening() {
    if (!listening) {
      return;
    }
    listening = false;
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("keydown", onKeyDown);
    }
  }

  /** Drops the question on screen, if there is one. */
  const clear = () => settle(-1);

  return { node, ask, clear, isWaiting: () => Boolean(waiting) };
}
