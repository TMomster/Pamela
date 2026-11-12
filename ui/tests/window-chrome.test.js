// Pamela 窗口标题栏逻辑测试。
// Tests for the Pamela window-chrome logic.

import assert from "node:assert/strict";
import test from "node:test";

import { createInvoke, createWindowChrome, WINDOW_COMMANDS } from "../window-chrome.js";

test("createInvoke prefers the injected internals bridge", async () => {
  const calls = [];

  const invoke = await createInvoke({
    internals: {
      invoke: (command, args) => {
        calls.push([command, args]);
        return Promise.resolve("from-internals");
      },
    },
    importModule: async () => assert.fail("the module should not be loaded"),
  });

  assert.equal(await invoke("minimize"), "from-internals");
  assert.deepEqual(calls, [["minimize", undefined]]);
});

test("createInvoke falls back to the packaged module when internals is absent", async () => {
  const calls = [];

  const invoke = await createInvoke({
    internals: undefined,
    importModule: async () => ({
      invoke: (command, args) => {
        calls.push([command, args]);
        return Promise.resolve("from-module");
      },
    }),
  });

  assert.equal(await invoke("close"), "from-module");
  assert.deepEqual(calls, [["close", undefined]]);
});

test("createInvoke reports a failed module load and answers null", async () => {
  const warnings = [];

  const invoke = await createInvoke({
    internals: undefined,
    importModule: async () => {
      throw new Error("module unavailable");
    },
    onWarning: (error) => warnings.push(error),
  });

  assert.equal(invoke, null);
  assert.equal(warnings.length, 1, "a missing module is reported once");
});

test("createInvoke answers no bridge when the module exports no invoke", async () => {
  const invoke = await createInvoke({
    internals: undefined,
    importModule: async () => ({}),
  });

  assert.equal(invoke, null);
});

test("caption buttons issue the matching window commands", async () => {
  const seen = [];
  let maximizedCalls = 0;

  const chrome = createWindowChrome({
    invoke: (command) => {
      seen.push(command);
      if (command === WINDOW_COMMANDS.isMaximized) {
        maximizedCalls += 1;
        return Promise.resolve(false);
      }
      return Promise.resolve(null);
    },
  });

  await chrome.minimize();
  await chrome.close();
  await chrome.toggleMaximize();

  assert.deepEqual(seen, [
    WINDOW_COMMANDS.minimize,
    WINDOW_COMMANDS.close,
    WINDOW_COMMANDS.toggleMaximize,
    WINDOW_COMMANDS.isMaximized,
  ]);
  assert.equal(maximizedCalls, 1, "the toggle should re-read the state once");
});

test("maximise state is tracked and published", async () => {
  const states = [];
  let maximized = false;

  const chrome = createWindowChrome({
    invoke: (command) => {
      if (command === WINDOW_COMMANDS.isMaximized) {
        return Promise.resolve(maximized);
      }
      maximized = !maximized;
      return Promise.resolve(null);
    },
    onMaximizedChange: (value) => states.push(value),
  });

  assert.equal(await chrome.syncMaximized(), false);
  assert.equal(await chrome.toggleMaximize(), true);
  assert.equal(await chrome.toggleMaximize(), false);

  assert.deepEqual(states, [false, true, false]);
  assert.equal(chrome.isMaximized(), false);
});

test("a failing command is reported and does not reject", async () => {
  const errors = [];

  const chrome = createWindowChrome({
    invoke: (command) => {
      if (command === WINDOW_COMMANDS.isMaximized) {
        return Promise.reject(new Error("not allowed"));
      }
      return Promise.reject(new Error("denied"));
    },
    onError: (message, error) => errors.push([message, error.message]),
  });

  await chrome.minimize();
  await chrome.syncMaximized();
  await chrome.toggleMaximize();

  assert.deepEqual(errors, [
    ["minimize failed", "denied"],
    ["could not read the maximised state", "not allowed"],
    ["toggle_maximize failed", "denied"],
    ["could not read the maximised state", "not allowed"],
  ]);
});

test("a bridge that throws synchronously is contained", async () => {
  const errors = [];

  const chrome = createWindowChrome({
    invoke: () => {
      throw new Error("ipc gone");
    },
    onError: (message) => errors.push(message),
  });

  await chrome.minimize();
  assert.deepEqual(errors, ["minimize failed"]);
});

test("fullscreen goes through the host, not the webview", async () => {
  // Key constraint: the host command: `requestFullscreen()` only fills the
  // webview and leaves the taskbar painting over the stage. So the toggle must
  // send `set_fullscreen` with the state it wants.
  const seen = [];
  let actual = false;

  const chrome = createWindowChrome({
    invoke: (command, args) => {
      seen.push([command, args]);
      if (command === WINDOW_COMMANDS.setFullscreen) {
        actual = args.fullscreen;
        return Promise.resolve(actual);
      }
      return Promise.resolve(actual);
    },
  });

  assert.equal(await chrome.setFullscreen(true), true);
  assert.equal(await chrome.setFullscreen(false), false);

  assert.deepEqual(seen, [
    [WINDOW_COMMANDS.setFullscreen, { fullscreen: true }],
    [WINDOW_COMMANDS.setFullscreen, { fullscreen: false }],
  ]);
});

test("a refused fullscreen request answers the real state", async () => {
  // A window manager can decline; the menu has to follow the window, not the
  // request, or it would claim a mode the player is not in.
  const chrome = createWindowChrome({
    invoke: () => Promise.resolve(false),
  });

  assert.equal(await chrome.setFullscreen(true), false);
});

test("fullscreen state can be read back, and a failure reads as off", async () => {
  const ok = createWindowChrome({
    invoke: (command) =>
      Promise.resolve(command === WINDOW_COMMANDS.isFullscreen ? true : null),
  });
  assert.equal(await ok.syncFullscreen(), true);

  const errors = [];
  const broken = createWindowChrome({
    invoke: () => Promise.reject(new Error("denied")),
    onError: (message) => errors.push(message),
  });
  assert.equal(await broken.syncFullscreen(), false);
  assert.deepEqual(errors, ["could not read the fullscreen state"]);
});
