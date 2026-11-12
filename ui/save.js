// 存档文件。
// Pamela — save files.
/** The folder saves live in, relative to the project root. */

export const SAVES_DIR = "saves";

/** The suffix a save file carries. */
export const SAVE_SUFFIX = ".json";

/** The shape this module writes and understands. */
export const SAVE_VERSION = 1;

/**
 * A fingerprint of one script's text.
 *
 * A node is a path of statement indices, so a script whose text changed can
 * make the same path point at a different line. A save therefore also says
 * what the scripts it walked through looked like, and a load refuses to resume
 * when one of them has changed since — a wrong position is worse than a
 * refused load.
 *
 * FNV-1a, 32 bits, over the text's UTF-16 code units: short, stable, and enough
 * to notice an edit (this guards against accidents, not against forgery).
 *
 * @param {string} text
 * @returns {string} Eight lowercase hex digits.
 */
export function hashText(text) {
  let hash = 0x811c9dc5;
  const source = String(text ?? "");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Whether a project-relative path names a save file. */
export function isSavePath(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith(`${SAVES_DIR}/`) && normalized.endsWith(SAVE_SUFFIX);
}

/**
 * The file name a save slot is written as.
 *
 * A name is what the author types in the prompt, so it may hold anything; a
 * file name may not. Characters a Windows path reserves become dashes, runs of
 * spaces become one, and a name that is empty afterwards is refused rather
 * than written as a file nobody can find again.
 */
export function saveFileName(name) {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim();
  if (!cleaned) {
    throw new Error("存档名不能为空");
  }
  if (/^\.+$/.test(cleaned)) {
    throw new Error("存档名不能只有点");
  }
  return cleaned;
}

/** The project-relative path a save slot is written to. */
export function savePathFor(name) {
  return `${SAVES_DIR}/${saveFileName(name)}${SAVE_SUFFIX}`;
}

/** The slot name a project-relative save path stands for. */
export function saveNameFrom(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(SAVE_SUFFIX)
    ? name.slice(0, -SAVE_SUFFIX.length)
    : name;
}

/**
 * A name for a new save that says when it was made.
 *
 * Local time, with the characters a file name allows: a slot list sorted by
 * name is then also sorted by when it was written.
 */
export function defaultSaveName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}`;
  return `存档 ${day} ${time}`;
}

/**
 * Every save slot in a project tree, by name.
 *
 * Read off the project the editor already has, so listing saves costs no extra
 * command: `saves/` is a folder like any other in the tree.
 */
export function saveNamesIn(tree) {
  return saveFilesIn(tree).map((file) => file.name);
}

/**
 * Every save file in a project tree, with the path it lives at.
 *
 * The order is the file name's, which `defaultSaveName` makes sort by when the
 * save was written — so the slot grid fills in the order the saves were made.
 * Only the project's own `saves/` is read: a `.json` elsewhere in the tree is
 * not a save, however it is named.
 *
 * @param {Array<object>} tree The project tree, as the backend answers it.
 * @returns {Array<{ name: string, path: string }>}
 */
export function saveFilesIn(tree) {
  const files = [];
  const visit = (nodes) => {
    for (const node of nodes ?? []) {
      if (!node?.is_dir) {
        continue;
      }
      if (node.path === SAVES_DIR) {
        for (const child of node.children ?? []) {
          if (child?.is_dir || !String(child?.name ?? "").toLowerCase().endsWith(SAVE_SUFFIX)) {
            continue;
          }
          files.push({ name: saveNameFrom(child.name), path: child.path });
        }
        continue;
      }
      visit(node.children);
    }
  };
  visit(tree);
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/**
 * Refuses a save whose scripts have changed since it was written.
 *
 * Reads each script the save walked through and compares its fingerprint. The
 * read is injected for the same reason every other file read is: this module
 * never touches the disk.
 *
 * @param {Record<string, string>} scripts Project-relative path to fingerprint.
 * @param {(path: string) => Promise<string>} read
 * @returns {Promise<void>}
 */
export async function verifyScripts(scripts, read) {
  for (const [scriptPath, expected] of Object.entries(scripts ?? {})) {
    let text;
    try {
      text = await read(scriptPath);
    } catch {
      throw new Error(`存档里的脚本已经不在了：${scriptPath}`);
    }
    if (hashText(text) !== expected) {
      throw new Error(`存档与当前剧本不一致：${scriptPath} 改过了`);
    }
  }
}

/**
 * Turns what a live run knows into the document a save file holds.
 *
 * @param {{ name: string, root: string, file: string,
 *   path: Array<number | string>, choices?: Array<{ key: string, picked: number }>,
 *   scripts?: Record<string, string>, savedAt?: Date, title?: string,
 *   thumbnail?: string | null }} options
 */
export function buildSave({
  name,
  root,
  file,
  path,
  choices = [],
  scripts = {},
  savedAt = new Date(),
  title = "",
  thumbnail = null,
}) {
  if (!root) {
    throw new Error("没有正在运行的脚本");
  }
  if (!file) {
    throw new Error("当前位置不属于任何脚本");
  }
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error("当前位置不能存档");
  }
  return {
    version: SAVE_VERSION,
    name: String(name ?? ""),
    // The label the slot panel shows. Kept apart from `name`, which is also the
    // file name and so has to survive a trip through the filesystem.
    title: String(title ?? ""),
    savedAt: savedAt instanceof Date ? savedAt.toISOString() : String(savedAt),
    root,
    file,
    path,
    choices: (choices ?? []).map((choice) => ({ key: choice.key, picked: choice.picked })),
    // What the scripts looked like, so a changed one is refused rather than
    // silently resumed at whatever now sits at the same index.
    scripts: { ...scripts },
    // A small copy of the backdrop the position stands on, for its slot. It is
    // optional in every direction: a save written without one, or by an older
    // build, resumes exactly as before — the slot simply draws a blank.
    thumbnail: typeof thumbnail === "string" && thumbnail ? thumbnail : null,
  };
}

/**
 * Reads a save file back, refusing anything this build cannot resume from.
 *
 * The messages are the ones the author sees, so each says what is wrong with
 * the file rather than what the parser wanted.
 */
export function parseSave(text) {
  let document;
  try {
    document = JSON.parse(String(text ?? ""));
  } catch {
    throw new Error("存档文件不是有效的 JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("存档文件内容不是一个对象");
  }
  if (document.version !== SAVE_VERSION) {
    throw new Error(`不认识的存档版本：${document.version}`);
  }
  if (typeof document.root !== "string" || !document.root) {
    throw new Error("存档没有记录从哪个脚本开始");
  }
  if (typeof document.file !== "string" || !document.file) {
    throw new Error("存档没有记录节点在哪个脚本里");
  }
  const path = document.path;
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error("存档没有记录节点位置");
  }
  for (const step of path) {
    if (typeof step !== "number" && typeof step !== "string") {
      throw new Error("存档的节点位置格式不对");
    }
  }
  const choices = document.choices ?? [];
  if (!Array.isArray(choices)) {
    throw new Error("存档的选择记录格式不对");
  }
  const scripts = document.scripts ?? {};
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error("存档的剧本指纹格式不对");
  }
  for (const [scriptPath, hash] of Object.entries(scripts)) {
    if (typeof hash !== "string" || !/^[0-9a-f]{8}$/.test(hash)) {
      throw new Error("存档的剧本指纹格式不对");
    }
  }
  for (const choice of choices) {
    if (!choice || typeof choice.key !== "string" || !Number.isInteger(choice.picked)) {
      throw new Error("存档的选择记录格式不对");
    }
  }
  return {
    version: SAVE_VERSION,
    name: typeof document.name === "string" ? document.name : "",
    // A save written before the slot panel existed has no title and no
    // thumbnail; both are read as empty, and the panel falls back to `name`.
    title: typeof document.title === "string" ? document.title : "",
    savedAt: typeof document.savedAt === "string" ? document.savedAt : "",
    root: document.root,
    file: document.file,
    path,
    choices: choices.map((choice) => ({ key: choice.key, picked: choice.picked })),
    // A save written before fingerprints existed carries none, and is resumed
    // as it always was: nothing to compare, so nothing to refuse.
    scripts: { ...scripts },
    thumbnail: typeof document.thumbnail === "string" && document.thumbnail ? document.thumbnail : null,
  };
}
