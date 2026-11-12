// Pamela 菜单模型测试。
// Tests for the Pamela menu model.

import assert from "node:assert/strict";
import test from "node:test";

import { allCommands, commandForEvent, findMenu, isEnabled, MENUS, SHORTCUTS } from "../menus.js";

test("every menu declares an id, a label and items", () => {
  for (const menu of MENUS) {
    assert.ok(menu.id, "menu id");
    assert.ok(menu.label, `label for ${menu.id}`);
    assert.ok(Array.isArray(menu.items) && menu.items.length > 0, `items for ${menu.id}`);
  }
});

test("menu ids and command names are unique", () => {
  const ids = MENUS.map((menu) => menu.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate menu id");

  const commands = allCommands();
  assert.equal(new Set(commands).size, commands.length, "duplicate command");
});

test("every item is either a separator or carries a label", () => {
  const walk = (menu, items) => {
    for (const item of items) {
      if (item.separator) {
        assert.equal(item.label, undefined, "a separator must not have a label");
      } else {
        assert.ok(item.label, `label missing in ${menu.id}`);
        // A submenu parent opens a nested menu instead of dispatching a command.
        if (item.submenu) {
          assert.ok(item.submenu.length > 0, `empty submenu for ${item.label}`);
          walk(menu, item.submenu);
        } else {
          assert.ok(item.command, `command missing for ${item.label}`);
        }
      }
    }
  };
  for (const menu of MENUS) {
    walk(menu, menu.items);
  }
});

test("findMenu looks up by id", () => {
  assert.equal(findMenu("file")?.label, "文件");
  assert.equal(findMenu("nope"), null);
});

test("every shortcut targets a real command", () => {
  const commands = new Set(allCommands());
  for (const shortcut of SHORTCUTS) {
    assert.ok(commands.has(shortcut.command), `${shortcut.command} is not in the menu`);
  }
});

test("displayed accelerators match the real bindings", () => {
  // A mismatch here means the menu lies about how to trigger something.
  const byCommand = new Map(SHORTCUTS.map((s) => [s.command, s]));

  for (const menu of MENUS) {
    for (const item of menu.items) {
      if (!item.accelerator) {
        continue;
      }
      const shortcut = byCommand.get(item.command);
      assert.ok(shortcut, `${item.command} shows "${item.accelerator}" but has no binding`);

      const parts = item.accelerator.split("+");
      const key = parts.pop();
      assert.equal(key.toLowerCase(), shortcut.key.toLowerCase(), `key for ${item.command}`);
      assert.equal(parts.includes("Ctrl"), Boolean(shortcut.ctrl), `ctrl for ${item.command}`);
      assert.equal(parts.includes("Shift"), Boolean(shortcut.shift), `shift for ${item.command}`);
    }
  }
});

test("commandForEvent resolves ctrl shortcuts case-insensitively", () => {
  assert.equal(commandForEvent({ key: "s", ctrlKey: true }), "file.save");
  assert.equal(commandForEvent({ key: "S", ctrlKey: true }), "file.save");
  assert.equal(commandForEvent({ key: "o", ctrlKey: true }), "project.open");
  assert.equal(commandForEvent({ key: "F5" }), "project.reload");
});

test("commandForEvent requires modifiers to match exactly", () => {
  // Ctrl+Shift+S must not be mistaken for Ctrl+S.
  assert.equal(commandForEvent({ key: "s", ctrlKey: true, shiftKey: true }), null);
  assert.equal(commandForEvent({ key: "s" }), null);
  assert.equal(
    commandForEvent({ key: "w", ctrlKey: true, shiftKey: true }),
    "project.close",
  );
  assert.equal(commandForEvent({ key: "w", ctrlKey: true }), null);
});

test("commandForEvent ignores unrelated keys", () => {
  assert.equal(commandForEvent({ key: "a" }), null);
  assert.equal(commandForEvent({ key: "Escape" }), null);
});

test("ctrl+enter triggers a run, but plain enter does not", () => {
  assert.equal(commandForEvent({ key: "Enter", ctrlKey: true }), "run.play");
  assert.equal(commandForEvent({ key: "Enter" }), null);
  assert.equal(commandForEvent({ key: "Enter", ctrlKey: true, shiftKey: true }), null);
});

test("project commands need an open project", () => {
  const none = { hasProject: false, hasOpenFile: false };

  assert.equal(isEnabled("project.reload", none), false);
  assert.equal(isEnabled("project.close", none), false);
  assert.equal(isEnabled("file.new", none), false);

  const open = { hasProject: true, hasOpenFile: false };
  assert.equal(isEnabled("project.reload", open), true);
  assert.equal(isEnabled("file.new", open), true);
});

test("creating or opening a project is always available", () => {
  const none = { hasProject: false, hasOpenFile: false };
  assert.equal(isEnabled("project.new", none), true);
  assert.equal(isEnabled("project.open", none), true);
});

test("saving needs both a project and an open file", () => {
  assert.equal(isEnabled("file.save", { hasProject: true, hasOpenFile: false }), false);
  assert.equal(isEnabled("file.save", { hasProject: true, hasOpenFile: true }), true);
  assert.equal(isEnabled("file.save", { hasProject: false, hasOpenFile: true }), false);
});

test("running respects the toolbar strategy", () => {
  // From the entry it only needs the project; from the current file it needs
  // one open. Either way an open project or file enables it.
  assert.equal(isEnabled("run.play", { hasProject: true, hasOpenFile: true }), true);
  assert.equal(isEnabled("run.play", { hasProject: true, hasOpenFile: false }), true);
  assert.equal(isEnabled("run.play", { hasProject: false, hasOpenFile: false }), false);
});

test("playing from the entry needs the project only", () => {
  // The entry script names itself in the manifest, so nothing has to be open.
  assert.equal(isEnabled("run.entry", { hasProject: true, hasOpenFile: false }), true);
  assert.equal(isEnabled("run.entry", { hasProject: true, hasOpenFile: true }), true);
  assert.equal(isEnabled("run.entry", { hasProject: false, hasOpenFile: true }), false);
});

test("saving and loading work on the project", () => {
  // A save lives in the project's own folder, so no file has to be open.
  assert.equal(isEnabled("save.node", { hasProject: true, hasOpenFile: false }), true);
  assert.equal(isEnabled("load.node", { hasProject: true, hasOpenFile: false }), true);
  assert.equal(isEnabled("save.node", { hasProject: false }), false);
  assert.equal(isEnabled("load.node", { hasProject: false }), false);
});

test("help is always available", () => {
  const none = { hasProject: false, hasOpenFile: false };
  assert.equal(isEnabled("app.about", none), true);
  assert.equal(isEnabled("app.quit", none), true);
});

test("stopping a run is offered only while one is on", () => {
  // A greyed-out entry is how the menu says there is nothing to stop, rather
  // than offering a command that would silently do nothing.
  assert.equal(isEnabled("run.stop", { running: true }), true);
  assert.equal(isEnabled("run.stop", { running: false }), false);
  assert.equal(isEnabled("run.stop", { hasProject: true, hasOpenFile: true }), false);
});

test("a missing command is never enabled", () => {
  assert.equal(isEnabled(undefined, { hasProject: true }), false);
  assert.equal(isEnabled("", { hasProject: true }), false);
});

test("the player-mode switch is wired into the menu", () => {
  // The player hides the menu bar, so the only way into it is a menu entry that
  // the editor keeps visible; the way back out is the title-bar button, which is
  // bound directly in main.js rather than modelled here.
  const commands = allCommands();
  assert.ok(commands.includes("app.player"), "app.player command exists");
  assert.equal(findMenu("view")?.label, "视图", "a 视图 menu carries the switch");
});
