// 菜单栏定义与行为。
// Pamela — menu bar definition and behaviour.
// 按钮仅在项目已打开时启用；禁用态不附加解释文字。

import { AUTO_SAVE_OPTIONS } from "./auto-save.js";
/**
 * The menu tree.
 *
 * `command` names are dispatched by the front-end. An entry with no command is
 * a label or a separator drawn for structure only.
 *
 * @typedef {object} MenuItem
 * @property {string} [label]
 * @property {string} [command]
 * @property {string} [accelerator] Display-only hint; the key handler owns the
 *   actual binding, since the OS never sees these keys in a frameless window.
 * @property {boolean} [separator]
 * @property {boolean} [checkable] Draws the current choice as a check mark.
 * @property {string} [group] Key of the context value that owns the choice.
 * @property {unknown} [value] The value this item stands for in its group.
 * @property {MenuItem[]} [submenu] A nested menu, drawn on hover or click.
 *
 * @typedef {object} Menu
 * @property {string} id
 * @property {string} label
 * @property {MenuItem[]} items
 */
/** @type {Menu[]} */

/** 「自动保存」的五档，都落到同一个组内，菜单按上下文打勾。 */
const AUTO_SAVE_ITEMS = AUTO_SAVE_OPTIONS.map(({ value, label }) => ({
  label,
  command: `autosave.${value}`,
  checkable: true,
  group: "autoSave",
  value,
}));

export const MENUS = [
  {
    id: "file",
    label: "文件",
    items: [
      { label: "新建项目…", command: "project.new", accelerator: "Ctrl+N" },
      { label: "打开项目…", command: "project.open", accelerator: "Ctrl+O" },
      { separator: true },
      { label: "新建 pe 剧本…", command: "file.newPe" },
      { label: "新建 mpe 剧本…", command: "file.newMpe" },
      { label: "保存", command: "file.save", accelerator: "Ctrl+S" },
      { separator: true },
      { label: "自动保存", submenu: AUTO_SAVE_ITEMS },
      { separator: true },
      { label: "重新扫描项目", command: "project.reload", accelerator: "F5" },
      { label: "检查资源完整性", command: "project.check" },
      { label: "关闭项目", command: "project.close" },
      { separator: true },
      { label: "退出", command: "app.quit" },
    ],
  },
  {
    id: "stage",
    label: "演出",
    items: [
      { label: "运行", command: "run.play", accelerator: "Ctrl+Enter" },
      { label: "从入口播放", command: "run.entry" },
      { label: "停止运行", command: "run.stop" },
      { separator: true },
      { label: "自动播放", command: "play.auto" },
      { label: "快进", command: "play.skip" },
      { label: "回看", command: "play.backlog" },
      { separator: true },
      { label: "存档（当前节点）…", command: "save.node" },
      { label: "读档…", command: "load.node" },
      { separator: true },
      { label: "导出 MP4…", command: "export.mp4" },
    ],
  },
  {
    id: "view",
    label: "视图",
    items: [
      { label: "进入播放器模式", command: "app.player" },
    ],
  },
];

/**
 * Toolbar entries that open a surface directly instead of dropping a menu.
 *
 * 界面文案「帮助」与「关于」均打开内置只读阅读器，二者都不带文章列表参数。
 * 界面文案「帮助」与「关于」均打开内置只读阅读器，二者都不带文章列表参数。
 * 「帮助」与「关于」 both open the built-in read-only reader; neither has a list
 * of its own, so drawing them as menus would add a click for nothing. They sit
 * after the menus and before the right-aligned launch controls, which is where a
 * desktop application puts its help and version entries.
 *
 * @type {ReadonlyArray<{id: string, label: string, command: string, title: string}>}
 */
export const TOOLBAR_ACTIONS = Object.freeze([
  { id: "help", label: "帮助", command: "app.help", title: "内置帮助" },
  { id: "about", label: "关于", command: "app.about", title: "关于本软件" },
]);

/**
 * Keyboard shortcuts, expressed against `KeyboardEvent`.
 *
 * Kept separate from the menu model so the displayed accelerator and the real
 * binding cannot drift apart silently, and so both are testable.
 *
 * @type {ReadonlyArray<{command: string, key: string, ctrl?: boolean, shift?: boolean, alt?: boolean}>}
 */
export const SHORTCUTS = Object.freeze([
  { command: "project.new", key: "n", ctrl: true },
  { command: "project.open", key: "o", ctrl: true },
  { command: "file.save", key: "s", ctrl: true },
  { command: "run.play", key: "Enter", ctrl: true },
  { command: "project.reload", key: "F5" },
  { command: "project.close", key: "w", ctrl: true, shift: true },
]);

/**
 * Flattens every command the menu bar offers, in order: the menus first, then
 * the toolbar entries, which are commands without a popup.
 */
export function allCommands(menus = MENUS, actions = TOOLBAR_ACTIONS) {
  const commandsOf = (items) =>
    items.flatMap((item) =>
      item.submenu ? commandsOf(item.submenu) : item.command ? [item.command] : [],
    );
  return [
    ...menus.flatMap((menu) => commandsOf(menu.items)),
    ...actions.map((action) => action.command),
  ];
}

/** Looks a menu up by id. */
export function findMenu(id, menus = MENUS) {
  return menus.find((menu) => menu.id === id) ?? null;
}

/**
 * Resolves a keyboard event to a command.
 *
 * Comparison is case-insensitive for letter keys, and modifiers must match
 * exactly: Ctrl+S must not fire for Ctrl+Shift+S.
 */
export function commandForEvent(event, shortcuts = SHORTCUTS) {
  const key = String(event.key ?? "");
  const normalized = key.length === 1 ? key.toLowerCase() : key;

  const match = shortcuts.find(
    (shortcut) =>
      shortcut.key.toLowerCase() === normalized.toLowerCase() &&
      Boolean(shortcut.ctrl) === Boolean(event.ctrlKey) &&
      Boolean(shortcut.shift) === Boolean(event.shiftKey) &&
      Boolean(shortcut.alt) === Boolean(event.altKey),
  );

  return match ? match.command : null;
}

/**
 * Whether an item is available.
 *
 * Commands that only make sense with a project open are disabled without one,
 * rather than failing when invoked.
 */
export function isEnabled(
  command,
  { hasProject = false, hasOpenFile = false, running = false } = {},
) {
  if (!command) {
    return false;
  }
  // Both prefixes operate on the open project: `project.*` manages it, `file.*`
  // reads and writes inside it. The one exception is creating a project.
  if (command === "project.new" || command === "project.open") {
    return true;
  }
  if (command.startsWith("project.")) {
    return hasProject;
  }
  if (command.startsWith("file.")) {
    return command === "file.save" ? hasProject && hasOpenFile : hasProject;
  }
  // Running respects the toolbar strategy: from the entry it needs a project,
  // from the current file it needs one open.
  if (command === "run.play") {
    return hasOpenFile || hasProject;
  }
  // Playing from the entry, saving and loading all work on the open project
  // rather than on the file in the editor: the entry names itself in
  // `pamela.json`, and a save lives in the project's own `saves/` folder.
  if (command === "run.entry" || command === "save.node" || command === "load.node" ||
    command === "export.mp4") {
    return hasProject;
  }
  // Stopping, and the playback conveniences, are only meaningful while a run is
  // on the stage.
  if (command === "run.stop" || command === "play.auto" || command === "play.skip" || command === "play.backlog") {
    return Boolean(running);
  }
  return true;
}
