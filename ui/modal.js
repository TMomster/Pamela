// 窗口内模态对话框。
// Pamela — in-window modal dialogs.
/**
 * Opens a text prompt.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.label]
 * @param {string} [options.value] Initial value.
 * @param {string} [options.confirmLabel]
 * @param {string} [options.placeholder]
 * @param {(value: string) => string | null} [options.validate]
 *   Returns an error message to keep the dialog open, or `null` when valid.
 * @returns {Promise<string | null>}
 */

export function promptText({
  title,
  label = "",
  value = "",
  confirmLabel = "确定",
  placeholder = "",
  validate = () => null,
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "modal__title";
    heading.textContent = title;

    const field = document.createElement("label");
    field.className = "modal__field";

    if (label) {
      const caption = document.createElement("span");
      caption.className = "modal__label";
      caption.textContent = label;
      field.append(caption);
    }

    const input = document.createElement("input");
    input.className = "modal__input";
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    field.append(input);

    const error = document.createElement("p");
    error.className = "modal__error";
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "modal__actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal__button";
    cancel.textContent = "取消";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "modal__button modal__button--primary";
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    dialog.append(heading, field, error, actions);
    overlay.append(dialog);

    let settled = false;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const submit = () => {
      const message = validate(input.value);
      if (message) {
        error.textContent = message;
        error.hidden = false;
        input.focus();
        input.select();
        return;
      }
      settle(input.value);
    };

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(null);
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    }

    cancel.addEventListener("click", () => settle(null));
    confirm.addEventListener("click", submit);
    // Clicking the backdrop cancels, but clicks inside the dialog must not.
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) {
        settle(null);
      }
    });
    document.addEventListener("keydown", onKeyDown, true);

    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

/**
 * Opens a confirmation with a confirm and a cancel button.
 *
 * This is used instead of the dialog plugin's `confirm`, which is deprecated in
 * v2 in favour of `message` (a single-button dialog that cannot express
 * cancellation).
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @param {string} [options.confirmLabel]
 * @param {string} [options.cancelLabel]
 * @returns {Promise<boolean>} `true` when confirmed, `false` when cancelled.
 */
export function confirmDialog({
  title,
  body,
  confirmLabel = "确定",
  cancelLabel = "取消",
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "modal__title";
    heading.textContent = title;

    const text = document.createElement("p");
    text.className = "modal__body";
    text.textContent = body;

    const actions = document.createElement("div");
    actions.className = "modal__actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal__button";
    cancel.textContent = cancelLabel;

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "modal__button modal__button--primary";
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    dialog.append(heading, text, actions);
    overlay.append(dialog);

    let settled = false;
    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        settle(true);
      }
    }

    cancel.addEventListener("click", () => settle(false));
    confirm.addEventListener("click", () => settle(true));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) {
        settle(false);
      }
    });
    document.addEventListener("keydown", onKeyDown, true);

    document.body.append(overlay);
    confirm.focus();
  });
}

/**
 * Opens a busy box that pins the window until the caller closes it.
 *
 * There is deliberately no way to dismiss it from the UI: it stands for work
 * that must not be interrupted, so the pointer is covered, focus is held on the
 * box, and the keys that would otherwise reach the editor are swallowed. Only
 * the returned handle ends it, which is why the caller gets one back.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.body]
 * @returns {{ element: HTMLElement, close: () => void }}
 */
export function showBusy({ title, body = "正在处理…" }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay modal-overlay--busy";

  const dialog = document.createElement("div");
  dialog.className = "modal modal--busy";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-busy", "true");
  // Focusable so focus can be parked on the box itself while it is up.
  dialog.tabIndex = -1;

  const spinner = document.createElement("span");
  spinner.className = "modal__spinner";
  spinner.setAttribute("aria-hidden", "true");

  const heading = document.createElement("h2");
  heading.className = "modal__title";
  heading.textContent = title;

  const row = document.createElement("div");
  row.className = "modal__busy";
  row.append(spinner, heading);

  const text = document.createElement("p");
  text.className = "modal__body";
  text.textContent = body;

  dialog.append(row, text);
  overlay.append(dialog);

  let closed = false;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    overlay.remove();
  };

  function onKeyDown(event) {
    // Tab would move focus behind the box; Escape and Enter would cancel or
    // submit something underneath. None of them reach the editor.
    event.preventDefault();
    event.stopPropagation();
    dialog.focus();
  }

  // The other way focus could leave: a click or a script moving it elsewhere.
  function onFocusIn(event) {
    if (!overlay.contains(event.target)) {
      dialog.focus();
    }
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn, true);

  document.body.append(overlay);
  dialog.focus();

  return { element: dialog, close };
}

/**
 * Opens a message with a single dismiss button.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @returns {Promise<void>}
 */
export function showMessage({ title, body }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "modal__title";
    heading.textContent = title;

    const text = document.createElement("p");
    text.className = "modal__body";
    text.textContent = body;

    const actions = document.createElement("div");
    actions.className = "modal__actions";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "modal__button modal__button--primary";
    confirm.textContent = "确定";
    actions.append(confirm);

    dialog.append(heading, text, actions);
    overlay.append(dialog);

    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve();
    };

    function onKeyDown(event) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        settle();
      }
    }

    confirm.addEventListener("click", settle);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) {
        settle();
      }
    });
    document.addEventListener("keydown", onKeyDown, true);

    document.body.append(overlay);
    confirm.focus();
  });
}

