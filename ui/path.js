// 运动路径与关键帧数据结构。
// Pamela — motion paths and their key frames.
// `null` 表示路径不指定该属性，沿用上层取值。
/** The folder path files live in, relative to the project root. */

export const PATHS_DIR = "data";

/**
 * The suffix a key frame file carries.
 *
 * The file is JSON inside — the extension only says what the file is *for*, so
 * the tree opens it in the key frame editor instead of the code editor. A
 * script names it in full: `ch.key("key-ch.keyframes")`.
 */
export const KEYFRAMES_SUFFIX = ".keyframes";

/**
 * The suffixes a key frame file may have on disk.
 *
 * `.keyframes` is what is written now; `.json` is what every file written
 * before the rename has. Both are read, so an old project opens unchanged and
 * is only rewritten under the new name when it is saved.
 */
export const KEYFRAMES_SUFFIXES = [KEYFRAMES_SUFFIX, ".json"];

/** The shape this module writes and understands. */
export const PATH_VERSION = 2;

/** Longest a single segment may take, in ms. */
export const MAX_SEGMENT_TIME = 600_000;

/**
 * How many samples a curve is walked in when measuring or drawing it.
 *
 * A cubic is sampled rather than solved because the sampling is what both the
 * runtime and the editor want: the runtime steps through it frame by frame and
 * the editor draws it as a polyline. A higher count is a smoother curve and a
 * more expensive frame; this is the count a 1080p stage cannot tell apart.
 */
export const CURVE_STEPS = 48;

/** Whether a value is a usable point: two finite numbers. */
function isPoint(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Whether a value is a usable segment type. */
function isType(value) {
  return value === "line" || value === "curve";
}

/** The properties a key frame carries besides position. */
export const FRAME_PROPS = ["rotation", "scale", "alpha"];

/** What a key frame holds when the author has not said otherwise. */
export const DEFAULT_FRAME = Object.freeze({ rotation: 0, scale: 1, alpha: 1 });

/**
 * The two axes the eight-handle free transform stretches independently.
 *
 * `scale` is the uniform size the script's `scale()` has always written; these
 * two are the extra "变形" a side handle pulls out of the outline. They are kept
 * apart from `FRAME_PROPS` so a file that never mentions them reads exactly
 * as it did before — `animatedProps`, `frameAt` and `buildPathFile` keep their
 * old three-property shape unless these are actually declared.
 */
export const SIZE_PROPS = ["scaleX", "scaleY"];

/** A frame that was never stretched is one times its own width and height. */
export const DEFAULT_SIZE = Object.freeze({ scaleX: 1, scaleY: 1 });

/** A number, or the fallback when it is not one. */
function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Reads a key frame, filling in whatever it leaves out.
 *
 * Position is deliberately not part of a key frame: where the object is at
 * the end of a segment is where the segment's points put it, and having two
 * sources for one fact would let them disagree. A key frame is the *other*
 * animated properties.
 *
 * A property the author did not write is left out rather than filled with
 * the defaults. Filling it here would reset a segment that only says
 * `{ alpha: 0 }` — its rotation would snap back to 0 instead of carrying on
 * from the frame before it, which is the opposite of what "only this changed"
 * means. The carry-over happens in `keyFrames`, where the previous frame is
 * known.
 *
 * @param {unknown} raw
 * @returns {{ rotation?: number, scale?: number, alpha?: number }}
 */
export function normalizeFrame(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const frame = {};
  if (source.rotation != null) {
    frame.rotation = numberOr(source.rotation, 0);
  }
  if (source.scale != null) {
    const scale = numberOr(source.scale, 1);
    // A scale of zero would make the picture vanish and never come back, so a
    // zero is dropped rather than trusted — the frame before it carries.
    if (scale !== 0) {
      frame.scale = scale;
    }
  }
  if (source.alpha != null) {
    frame.alpha = Math.min(1, Math.max(0, numberOr(source.alpha, 1)));
  }
  // The two free-transform axes follow the same rule as the other properties:
  // absent means "carry the previous frame", and a zero would vanish the picture
  // for good, so it is dropped. Negative values are kept — a flipped image is a
  // legitimate transform.
  for (const axis of SIZE_PROPS) {
    if (source[axis] != null) {
      const value = numberOr(source[axis], 1);
      if (value !== 0) {
        frame[axis] = value;
      }
    }
  }
  return frame;
}

/**
 * A key frame with every property present, taking what it lacks from `base`.
 *
 * @param {{ rotation?: number, scale?: number, alpha?: number }} frame
 * @param {{ rotation: number, scale: number, alpha: number }} base
 * @returns {{ rotation: number, scale: number, alpha: number }}
 */
export function resolveFrame(frame, base = DEFAULT_FRAME) {
  return {
    rotation: frame.rotation ?? base.rotation,
    scale: frame.scale ?? base.scale,
    alpha: frame.alpha ?? base.alpha,
  };
}

/**
 * The two stretch axes of a frame, carrying the previous frame on any axis it
 * left out. Kept separate from `resolveFrame` so a frame's three classic
 * properties keep exactly the shape the rest of the runtime already expects.
 *
 * @param {{ scaleX?: number, scaleY?: number }} frame
 * @param {{ scaleX: number, scaleY: number }} [base]
 * @returns {{ scaleX: number, scaleY: number }}
 */
export function resolveSize(frame, base = DEFAULT_SIZE) {
  return {
    scaleX: frame?.scaleX ?? base.scaleX,
    scaleY: frame?.scaleY ?? base.scaleY,
  };
}

/**
 * Makes an id safe to use as a file name.
 *
 * Path files are named after their id, so an id with a slash, a dot-dot or a
 * drive letter in it would escape `data/`. Only the characters an id actually
 * needs are kept, which also makes the same id written two ways name one file.
 *
 * @param {unknown} value
 * @returns {string} The cleaned id, possibly empty.
 */
export function cleanId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 64);
}

/**
 * The project-relative file a key frame id lives in.
 *
 * A key frame belongs to an object, and the file is named after that
 * object: `ch` is `data/key-ch.keyframes`. The suffix says what the file is for
 * — it is still JSON inside, but the extension is what tells the editor to open
 * it in the key frame editor rather than as a script, and what makes the file
 * name readable in a script: `ch.key("key-ch.keyframes")`.
 *
 * @param {string} id The object's variable name.
 * @returns {string} For example `data/key-ch.keyframes`.
 */
export function pathFileFor(id) {
  return `${PATHS_DIR}/key-${cleanId(id)}${KEYFRAMES_SUFFIX}`;
}

/**
 * The project-relative file a generated key frame id lives in.
 *
 * A generated file sits directly in `data/` and is named after what it
 * animates: `ch` keyed in `main.pe` gives `data/ch-main-pe-1.keyframes`. The
 * older `key-` prefix is kept for files that already carry it, so both
 * spellings are read by `idFromPathFile`.
 *
 * @param {string} id A name from `keyFrameStemFor` plus its index.
 * @returns {string} For example `data/ch-main-pe-1.keyframes`.
 */
export function orderedPathFileFor(id) {
  return `${PATHS_DIR}/${cleanId(id)}${KEYFRAMES_SUFFIX}`;
}

/**
 * The stem a generated key frame file is named with.
 *
 * One object may key several times in one script, so the name has to say which
 * object, which script and what the script's suffix is: `ch` in `main.pe`
 * gives `ch-main-pe`, and the file appends its own index (`ch-main-pe-1`).
 *
 * @param {string} objectName The object's variable name.
 * @param {string} scriptPath The script the `key()` call sits in.
 * @returns {string} The stem, or "" when the object has no usable name.
 */
export function keyFrameStemFor(objectName, scriptPath) {
  const object = cleanId(objectName);
  if (!object) {
    return "";
  }
  const file = String(scriptPath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  const name = dot > 0 ? file.slice(0, dot) : file;
  const suffix = dot > 0 ? file.slice(dot + 1) : "";
  return [object, cleanId(name), cleanId(suffix)].filter(Boolean).join("-");
}

/**
 * The lowest index no key frame file for `stem` occupies.
 *
 * Numbers are filled from the bottom: with `…-1` and `…-3` on disk the next
 * file is `…-2`, and the one after it `…-4`. A gap never invalidates the files
 * around it, because a file is named by the number it carries, not by its
 * position in a list.
 *
 * @param {string} stem A name from `keyFrameStemFor`.
 * @param {Iterable<string>} ids The key frame ids already on disk.
 * @returns {number} The first free positive index.
 */
export function freeKeyFrameIndex(stem, ids) {
  const prefix = `${cleanId(stem)}-`;
  const used = new Set();
  for (const id of ids ?? []) {
    const text = String(id ?? "");
    if (!text.startsWith(prefix)) {
      continue;
    }
    const rest = text.slice(prefix.length);
    if (/^\d+$/.test(rest)) {
      used.add(Number(rest));
    }
  }
  let index = 1;
  while (used.has(index)) {
    index += 1;
  }
  return index;
}

/**
 * The id a key frame file name carries.
 *
 * Generated files are `data/<object>-<script>-<suffix>-<index>.keyframes`.
 * Older files are `data/key-<id>.keyframes`, `data/key-<id>.json` and
 * `data/path-<id>.json`; all spellings are read, so a project made before
 * either rename still opens. A bare `key-` / `path-` prefix with no id behind
 * it (`data/key-.keyframes`) is not a key frame file.
 *
 * @param {string} path
 * @returns {string} The id, or "" when the path is not a key frame file.
 */
export function idFromPathFile(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  // `data/key-<id>.json` and `data/path-<id>.json` are the oldest spelling.
  const legacyJson = /(?:^|\/)data\/(?:key|path)-([A-Za-z0-9_-]+)\.json$/i.exec(normalized);
  if (legacyJson) {
    return legacyJson[1];
  }
  // `data/key-<id>.keyframes` is the one before generated names; it is the only
  // prefix that ever applied to the newer suffix.
  const legacyKey = /(?:^|\/)data\/key-([A-Za-z0-9_-]+)\.keyframes$/i.exec(normalized);
  if (legacyKey) {
    return legacyKey[1];
  }
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  // A bare `key-` prefix with nothing behind it is not a key frame file. A
  // generated name may itself begin with `path-` (an object called `path`), and
  // that is a whole id, not a prefix to strip.
  if (/^key-/i.test(name)) {
    return "";
  }
  const ordered = /(?:^|\/)data\/([A-Za-z0-9_-]+)\.keyframes$/i.exec(normalized);
  return ordered ? ordered[1] : "";
}

/** Whether a project-relative path names a motion path file. */
export function isPathFile(path) {
  return idFromPathFile(path) !== "";
}

/**
 * The project-relative file a `key()` argument names.
 *
 * A script writes the file's own name — `ch.key("key-ch.keyframes")` — because
 * that is what the author sees in the tree, and the `data/` folder is the
 * default the same way `assets/` is for a picture. A path that already names a
 * folder (`data/key-ch.keyframes`) is taken as written.
 *
 * @param {string} asked The argument, as the script wrote it.
 * @returns {string} A project-relative path, or "" when nothing was given.
 */
export function pathFileFromArgument(asked) {
  const normalized = String(asked ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!normalized) {
    return "";
  }
  return normalized.includes("/") ? normalized : `${PATHS_DIR}/${normalized}`;
}

/**
 * The id a `key()` argument names, whether it is a bare file name or a path.
 *
 * @param {string} asked The argument, as the script wrote it.
 * @returns {string} The id, or "" when the argument names no key frame file.
 */
export function idFromKeyArgument(asked) {
  return idFromPathFile(pathFileFromArgument(asked));
}

/**
 * An id for a new path.
 *
 * Random rather than sequential on purpose: a path is created from the editor
 * and named by the script, so two paths made in the same session must not
 * collide, and a deleted path's id should not be handed out again to a file
 * some older script still names.
 *
 * @param {() => number} [random] Injectable, so a test can be deterministic.
 * @returns {string} Eight lowercase hex digits.
 */
export function newPathId(random = Math.random) {
  let id = "";
  while (id.length < 8) {
    id += Math.floor(random() * 16).toString(16);
  }
  return id;
}

/**
 * A free file name for a copy of a key frame file.
 *
 * The generic `uniqueName` would make `key-ch 副本.keyframes`: a space and a
 * Chinese word in the id position, which `idFromPathFile` refuses — so the copy
 * would stop being a key frame file the moment it was pasted. Copies get a plain
 * `-copy` instead, then `-copy2`, `-copy3` …; every one of them is a usable id.
 *
 * @param {string} name A bare file name.
 * @param {string[]} [existing] Names already in the destination folder.
 * @returns {string}
 */
export function copyNameFor(name, existing = []) {
  const raw = String(name ?? "").trim();
  const dot = raw.lastIndexOf(".");
  const base = dot > 0 ? raw.slice(0, dot) : raw;
  const suffix = dot > 0 ? raw.slice(dot) : "";
  const taken = new Set(existing ?? []);
  let candidate = `${base}-copy${suffix}`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-copy${index}${suffix}`;
    index += 1;
  }
  return candidate;
}

/**
 * Reads one segment out of a file, or answers null when it is not usable.
 *
 * A segment needs a type, at least two points and a non-negative time. A curve
 * is stored with the same `points` as a line and the control points follow from
 * them (`segmentControls`), so a file stays readable and an author can convert a
 * line to a curve without losing where it went. A segment may still carry its
 * own `control` — that is what the editor writes when a handle is dragged, and
 * it is what makes a curve keep a shape the points alone do not describe.
 *
 * @param {unknown} raw
 * @returns {{ type: string, points: [number, number][], time: number, control: [number, number][][] | null } | null}
 */
export function normalizeSegment(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const type = isType(raw.type) ? raw.type : "line";
  const points = Array.isArray(raw.points) ? raw.points.filter(isPoint).map((p) => [p[0], p[1]]) : [];
  if (points.length < 2) {
    return null;
  }
  const time = Number(raw.time);
  return {
    type,
    points,
    time: Number.isFinite(time) && time > 0 ? Math.min(time, MAX_SEGMENT_TIME) : 0,
    // One pair of control points per cubic. A malformed entry is dropped rather
    // than trusted: a bad control point would bend the curve into an invalid shape.
    control: normalizeControl(raw.control, points),
    // The key frame this segment ends on. Absent means "hold whatever the
    // previous one set", which is what a file written before key frames plays.
    end: raw.end == null ? null : normalizeFrame(raw.end),
  };
}

/** The control pairs a segment carries, keeping only well-formed ones. */
function normalizeControl(raw, points) {
  if (!Array.isArray(raw)) {
    return null;
  }
  const runs = Math.max(0, Math.floor((points.length - 1) / 2));
  const pairs = [];
  for (let index = 0; index < runs; index += 1) {
    const pair = raw[index];
    if (Array.isArray(pair) && isPoint(pair[0]) && isPoint(pair[1])) {
      pairs.push([
        [pair[0][0], pair[0][1]],
        [pair[1][0], pair[1][1]],
      ]);
    } else {
      pairs.push(null);
    }
  }
  return pairs.some(Boolean) ? pairs : null;
}

/**
 * Reads a whole path file, filling in what it may leave out.
 *
 * A file that cannot be understood at all answers `null` rather than a guess:
 * the runtime falls back to a plain `move` and says so, and the editor refuses
 * to open it — inventing a path would draw something no script declared.
 *
 * @param {unknown} document The parsed JSON.
 * @returns {{ version: number, id: string, start: { x: number, y: number }, segments: object[] } | null}
 */
/**
 * A human name for a key frame, derived from its object when none was given.
 *
 * The file is named after the object, so the object's name is the obvious
 * default: an author who never renames anything still sees `ch` rather than a
 * random id in the tree and in the editor's title.
 *
 * @param {string} id The object's variable name.
 * @param {unknown} name What the file asked for, if anything.
 * @returns {string}
 */
export function displayNameFor(id, name) {
  const wanted = String(name ?? "").trim();
  return wanted || cleanId(id) || "key";
}

export function normalizePath(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return null;
  }
  const id = cleanId(document.id);
  if (!id) {
    return null;
  }
  const startRaw = document.start;
  const start = isPoint([startRaw?.x, startRaw?.y])
    ? { x: startRaw.x, y: startRaw.y }
    : { x: 0, y: 0 };
  // The start is the path's first key frame: where the object begins and how it
  // looks there. A file that predates key frames answers the defaults, which is
  // what "the object as it already is" means.
  const frame = resolveFrame(normalizeFrame(startRaw), DEFAULT_FRAME);
  const segments = Array.isArray(document.segments)
    ? document.segments.map(normalizeSegment).filter(Boolean)
    : [];
  const path = {
    version: PATH_VERSION,
    id,
    name: displayNameFor(id, document.name),
    start: { ...start, ...frame },
    segments,
  };
  // What the file actually declared, kept beside the filled-in values. Without
  // it, a file that says nothing about rotation would look like a file that
  // says rotation is 0 — and the runtime would reset a turn nobody touched.
  Object.defineProperty(path, "declared", {
    value: declaredProps(document),
    enumerable: false,
  });
  Object.defineProperty(path, "declaredSizes", {
    value: declaredSizeProps(document),
    enumerable: false,
  });
  // The stretch axes are resolved here too, so `frameAt` can hand the stage a
  // value for each frame without a second pass over the file.
  Object.defineProperty(path, "sizes", {
    value: sizeFrames(path),
    enumerable: false,
  });
  return path;
}

/** Which animated properties a raw file actually names. */
function declaredProps(document) {
  const start = document?.start ?? {};
  const declared = { rotation: start.rotation != null, scale: start.scale != null, alpha: start.alpha != null };
  for (const segment of Array.isArray(document?.segments) ? document.segments : []) {
    const end = segment?.end ?? {};
    for (const prop of FRAME_PROPS) {
      if (end[prop] != null) {
        declared[prop] = true;
      }
    }
  }
  return declared;
}

/** Which of the two stretch axes a raw file actually names. */
function declaredSizeProps(document) {
  const start = document?.start ?? {};
  const declared = { scaleX: start.scaleX != null, scaleY: start.scaleY != null };
  for (const segment of Array.isArray(document?.segments) ? document.segments : []) {
    const end = segment?.end ?? {};
    for (const axis of SIZE_PROPS) {
      if (end[axis] != null) {
        declared[axis] = true;
      }
    }
  }
  return declared;
}

/**
 * Builds the file to write for a path.
 *
 * Kept separate from `normalizePath` so what is written is always the current
 * shape, whatever the editor happened to hold.
 *
 * @param {{ id: string, start?: object, segments?: object[] }} path
 * @returns {object}
 */
export function buildPathFile(path) {
  const id = cleanId(path?.id);
  const startRaw = path?.start;
  const driven = animatedProps(path);
  const sizes = animatedSizes(path);
  const start = {
    ...(isPoint([startRaw?.x, startRaw?.y]) ? { x: startRaw.x, y: startRaw.y } : { x: 0, y: 0 }),
  };
  // Only the properties this path actually drives are written down. Writing the
  // defaults would turn "this path only moves the object" into "this path sets
  // rotation to 0", which is a different instruction — and reading it back
  // would then reset a turn the script had asked for.
  const frame = resolveFrame(normalizeFrame(startRaw), DEFAULT_FRAME);
  for (const prop of FRAME_PROPS) {
    if (driven[prop]) {
      start[prop] = frame[prop];
    }
  }
  const size = resolveSize(normalizeFrame(startRaw), DEFAULT_SIZE);
  for (const axis of SIZE_PROPS) {
    if (sizes[axis]) {
      start[axis] = size[axis];
    }
  }
  const segments = Array.isArray(path?.segments)
    ? path.segments
        .map(normalizeSegment)
        .filter(Boolean)
        .map(withoutEmptyControl)
        // A segment's `end` keeps exactly what was written: a property it never
        // named is one it wants carried over from the frame before it.
        .map((segment) => {
          if (!segment.end) {
            return segment;
          }
          const end = resolveFrame(segment.end, frame);
          const endSize = resolveSize(segment.end, size);
          for (const axis of SIZE_PROPS) {
            if (sizes[axis]) {
              end[axis] = endSize[axis];
            }
          }
          return { ...segment, end };
        })
    : [];
  return { version: PATH_VERSION, id, name: displayNameFor(id, path?.name), start, segments };
}

/**
 * Rebuilds a key frame document for the file it is being moved to.
 *
 * A key frame file's id is its name: `data/key-ch.keyframes` holds id `ch`,
 * and a script names it as `ch.key("key-ch.keyframes")`. Copying or renaming the
 * file without rebuilding the document leaves a second file claiming to be `ch`
 * — the two collide in the path cache, and `referencedIds` cannot tell them
 * apart. This answers a fresh document whose id and default name follow `path`,
 * with the animation itself untouched.
 *
 * A name the author chose by hand is carried over; a name that was merely
 * derived from the old id is dropped so the new one derives again. The document
 * is normalized on the way through, so the file written is always the current
 * shape even when the source was an old `.json` one.
 *
 * @param {unknown} document The parsed file.
 * @param {string} path The project-relative destination, e.g. `data/key-hero.keyframes`.
 * @returns {object} A document ready for `JSON.stringify`, or `document` itself
 *   when it cannot be understood or the destination names no key frame file.
 */
export function rehomePathDocument(document, path) {
  const id = idFromPathFile(path);
  if (!id || !document || typeof document !== "object" || Array.isArray(document)) {
    return document;
  }
  const fromId = cleanId(document.id);
  const normalized = normalizePath({ ...document, id: fromId || id });
  if (!normalized) {
    return document;
  }
  // `normalized` carries non-enumerable `declared` / `sizes`; spreading it would
  // drop those and make `buildPathFile` claim the file drives values it never
  // wrote. Mutating the two enumerable fields keeps them.
  normalized.id = id;
  const asked = String(document.name ?? "").trim();
  normalized.name = asked && (!fromId || asked !== fromId) ? asked : "";
  return buildPathFile(normalized);
}

/**
 * A segment as it goes into the file: only the keys it actually uses.
 *
 * `control` and `end` are dropped when absent rather than written as `null`.
 * Both mean "nothing was said here" — a derived control point follows from the
 * points, and a missing key frame carries the one before it — and a `null` in
 * the file is visual clutter that reads as a deliberate blank.
 */
function withoutEmptyControl(segment) {
  const { control, end, ...rest } = segment;
  const out = { ...rest };
  if (control) {
    out.control = control;
  }
  if (end) {
    out.end = end;
  }
  return out;
}

/**
 * The control points a curve segment bends through, one pair per cubic.
 *
 * A curve is drawn from the same points a line is: each run of three — start,
 * waypoint, end — is one cubic, and the waypoint is used as the control point
 * at both ends. The curve is therefore pulled toward its waypoint rather
 * than passing through it: at the halfway parameter it stands three quarters of
 * the way there (a cubic only touches its control points at its own ends). That
 * is the behaviour the editor draws and the runtime walks, so the shape on
 * screen is the motion in the scene.
 *
 * When the author has dragged a control handle (`segment.control`), that pair is
 * used instead — the handle is the explicit answer, and the derived one only
 * stands in until there is one.
 *
 * @param {{ points: [number, number][], control?: [number, number][][] | null }} segment
 * @returns {[[number, number], [number, number]][]} One pair per run.
 */
export function segmentControls(segment) {
  const points = segment?.points ?? [];
  const explicit = segment?.control ?? null;
  const pairs = [];
  let run = 0;
  for (let index = 0; index + 2 < points.length; index += 2) {
    const custom = explicit?.[run];
    if (Array.isArray(custom) && custom.length === 2) {
      pairs.push([
        [custom[0][0], custom[0][1]],
        [custom[1][0], custom[1][1]],
      ]);
    } else {
      const via = points[index + 1];
      pairs.push([
        [via[0], via[1]],
        [via[0], via[1]],
      ]);
    }
    run += 1;
  }
  return pairs;
}

/**
 * A segment's polyline, in stage coordinates.
 *
 * A line answers its own points. A curve answers `CURVE_STEPS` samples per run
 * of three points, which is what both the runtime walks and the editor draws —
 * one function so the picture in the editor is the motion in the game.
 *
 * @param {{ type: string, points: [number, number][], control?: [number, number][][] | null }} segment
 * @returns {[number, number][]} At least two points.
 */
export function sampleSegment(segment) {
  const points = segment?.points ?? [];
  if (points.length < 2) {
    return points.map((p) => [p[0], p[1]]);
  }
  if (segment.type !== "curve") {
    return points.map((p) => [p[0], p[1]]);
  }

  // Three points make one cubic: the run's start, its end, and the middle point
  // the curve is pulled toward. Runs share their end point, so a five-point
  // curve is two cubics joined.
  const controls = segmentControls(segment);
  const out = [[points[0][0], points[0][1]]];
  let index = 0;
  let run = 0;
  for (; index + 2 < points.length; index += 2) {
    const from = points[index];
    const to = points[index + 2];
    const [c1, c2] = controls[run] ?? [
      [from[0], from[1]],
      [to[0], to[1]],
    ];
    for (let step = 1; step <= CURVE_STEPS; step += 1) {
      out.push(cubicAt(from, c1, c2, to, step / CURVE_STEPS));
    }
    run += 1;
  }
  // Points left over (an even count leaves one) are joined straight rather than
  // dropped, so no point the author placed disappears from the motion.
  for (; index < points.length; index += 1) {
    const point = points[index];
    const last = out[out.length - 1];
    if (last[0] !== point[0] || last[1] !== point[1]) {
      out.push([point[0], point[1]]);
    }
  }
  return out;
}

/** One point on a cubic Bezier at `t`, 0 to 1. */
function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
}

/**
 * The whole path as one polyline, segments joined end to end.
 *
 * The start point is prepended when it is not already where the first segment
 * begins, so a path always begins where the object was when the move was
 * called — which is what makes a path a way of travelling rather than a
 * teleport followed by a walk.
 *
 * @param {{ start: { x: number, y: number }, segments: object[] }} path
 * @returns {[number, number][]}
 */
export function samplePath(path) {
  const start = path?.start ?? { x: 0, y: 0 };
  const out = [[start.x, start.y]];
  for (const segment of path?.segments ?? []) {
    const walked = sampleSegment(segment);
    if (walked.length < 2) {
      continue;
    }
    for (const point of walked) {
      const last = out[out.length - 1];
      // Joining segments repeat the point they meet at; dropping the repeat
      // keeps the polyline's length (and so its timing) honest.
      if (last[0] !== point[0] || last[1] !== point[1]) {
        out.push(point);
      }
    }
  }
  return out;
}

/** How long one segment takes, in ms. Zero means it is skipped over. */
export function segmentTime(segment) {
  const time = Number(segment?.time);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/**
 * Every key frame in a path, in order, with the time each one lands at.
 *
 * Frame 0 is the start (t = 0) and each segment contributes one more, at the
 * cumulative time of its own duration. A segment with no `end` frame still
 * contributes one — it holds the previous frame's values — so the list is
 * always `segments.length + 1` long and the times line up with `pointAt`'s own
 * segment clock.
 *
 * @param {{ start: object, segments: object[] }} path
 * @returns {{ time: number, rotation: number, scale: number, alpha: number }[]}
 */
export function keyFrames(path) {
  const frames = [{ time: 0, ...resolveFrame(normalizeFrame(path?.start), DEFAULT_FRAME) }];
  let elapsed = 0;
  for (const segment of path?.segments ?? []) {
    elapsed += segmentTime(segment) || defaultTime(segment);
    // A segment that does not say where it ends — or says only part of it —
    // holds the frame before it for everything it left out.
    const previous = frames[frames.length - 1];
    frames.push({ time: elapsed, ...resolveFrame(normalizeFrame(segment.end), previous) });
  }
  return frames;
}

/**
 * Which properties a path actually animates.
 *
 * A path only drives what it says it drives. A file written before key frames
 * says nothing, so it moves the object and leaves its rotation, size and
 * opacity exactly as the script set them — an old path must not quietly reset a
 * turn the author asked for. The same rule covers a new path whose author left
 * every frame alone.
 *
 * @param {{ start: object, segments: object[] }} path
 * @returns {{ rotation: boolean, scale: boolean, alpha: boolean }}
 */
export function animatedProps(path) {
  // A normalized path carries what its file declared, which is the only honest
  // answer: the filled-in `start` always has every property, so reading it
  // would claim a path drives values its author never wrote.
  if (path?.declared) {
    return { ...path.declared };
  }
  const start = path?.start ?? {};
  const declared = (prop) => start[prop] != null;
  const any = { rotation: declared("rotation"), scale: declared("scale"), alpha: declared("alpha") };
  for (const segment of path?.segments ?? []) {
    const end = segment?.end ?? {};
    for (const prop of FRAME_PROPS) {
      if (end[prop] != null) {
        any[prop] = true;
      }
    }
  }
  return any;
}

/**
 * Which of the two stretch axes the path actually animates.
 *
 * Like `animatedProps`, this is about what the file declares, not what the
 * resolved frames happen to contain — otherwise every old file would claim to
 * drive a stretch it never asked for and the stage would start resizing things.
 *
 * @param {{ start?: object, segments?: object[] }} path
 * @returns {{ scaleX: boolean, scaleY: boolean }}
 */
export function animatedSizes(path) {
  if (path?.declaredSizes) {
    return { ...path.declaredSizes };
  }
  const start = path?.start ?? {};
  const out = { scaleX: start.scaleX != null, scaleY: start.scaleY != null };
  for (const segment of path?.segments ?? []) {
    const end = segment?.end ?? {};
    for (const axis of SIZE_PROPS) {
      if (end[axis] != null) {
        out[axis] = true;
      }
    }
  }
  return out;
}

/**
 * The resolved stretch at every key frame, with the time each one lands at.
 *
 * A frame that says nothing about an axis carries the one before it, exactly as
 * `keyFrames` does for the three classic properties. The list is therefore
 * `segments.length + 1` long and shares its clock with `keyFrames`.
 *
 * @param {{ start?: object, segments?: object[] }} path
 * @returns {{ time: number, scaleX: number, scaleY: number }[]}
 */
function sizeFrames(path) {
  const times = keyFrames(path).map((frame) => frame.time);
  const segments = path?.segments ?? [];
  const frames = [];
  let previous = resolveSize(normalizeFrame(path?.start), DEFAULT_SIZE);
  frames.push({ time: times[0] ?? 0, ...previous });
  for (let index = 0; index < segments.length; index += 1) {
    previous = resolveSize(normalizeFrame(segments[index].end), previous);
    frames.push({ time: times[index + 1] ?? frames[frames.length - 1].time, ...previous });
  }
  return frames;
}

/** The stretch at `elapsed` ms, linearly between the two frames that bracket it. */
function sizeAt(path, elapsed) {
  const frames = path?.sizes ?? sizeFrames(path);
  const at = Math.max(0, Number(elapsed) || 0);
  for (let index = 1; index < frames.length; index += 1) {
    const to = frames[index];
    if (at <= to.time) {
      const from = frames[index - 1];
      const span = to.time - from.time;
      const t = span > 0 ? (at - from.time) / span : 1;
      return {
        scaleX: from.scaleX + (to.scaleX - from.scaleX) * t,
        scaleY: from.scaleY + (to.scaleY - from.scaleY) * t,
      };
    }
  }
  const last = frames[frames.length - 1] ?? DEFAULT_SIZE;
  return { scaleX: last.scaleX, scaleY: last.scaleY };
}

/**
 * The animated properties at `elapsed` ms.
 *
 * Linear between neighbouring key frames, which is what "key frame" means here:
 * the author sets the values at the ends of a segment and the runtime walks
 * between them. Rotation is not wrapped, so 0 → 720 is two whole turns rather
 * than a snap back.
 *
 * A property the path never mentions answers `null`, which is how the caller
 * tells "the path says 0" from "the path does not specify" — the difference
 * between turning an object to face front and leaving the turn it already had.
 *
 * @param {{ start: object, segments: object[] }} path
 * @param {number} elapsed
 * @returns {{ rotation: number | null, scale: number | null, alpha: number | null }}
 */
export function frameAt(path, elapsed) {
  const frames = keyFrames(path);
  const driven = animatedProps(path);
  const at = Math.max(0, Number(elapsed) || 0);
  const walk = interpolate(frames, at);
  const out = {
    rotation: driven.rotation ? walk.rotation : null,
    scale: driven.scale ? walk.scale : null,
    alpha: driven.alpha ? walk.alpha : null,
  };
  // Only a path the author actually stretched gets the extra keys. A legacy
  // file keeps the exact three-property answer, so neither the stage nor an old
  // test sees a value the file never named.
  const sizes = animatedSizes(path);
  if (sizes.scaleX || sizes.scaleY) {
    const size = sizeAt(path, at);
    if (sizes.scaleX) {
      out.scaleX = size.scaleX;
    }
    if (sizes.scaleY) {
      out.scaleY = size.scaleY;
    }
  }
  return out;
}

/** The frame the clock lands on, between the two that bracket it. */
function interpolate(frames, at) {
  if (frames.length < 2) {
    const only = frames[0];
    return { rotation: only.rotation, scale: only.scale, alpha: only.alpha };
  }

  for (let index = 1; index < frames.length; index += 1) {
    const to = frames[index];
    if (at <= to.time) {
      const from = frames[index - 1];
      const span = to.time - from.time;
      // A zero-length segment lands on its own frame rather than dividing by 0.
      const t = span > 0 ? (at - from.time) / span : 1;
      return {
        rotation: from.rotation + (to.rotation - from.rotation) * t,
        scale: from.scale + (to.scale - from.scale) * t,
        alpha: from.alpha + (to.alpha - from.alpha) * t,
      };
    }
  }

  const last = frames[frames.length - 1];
  return { rotation: last.rotation, scale: last.scale, alpha: last.alpha };
}

/** How long the whole path takes, in ms.
 *
 * Segments with no time are not instant: a segment that was never given a
 * duration would otherwise make the object jump, which is not what a path is
 * for. They are walked at `DEFAULT_SPEED` instead, so a half-timed path still
 * plays.
 *
 * @param {{ segments: object[] }} path
 * @returns {number}
 */
export function pathDuration(path) {
  return (path?.segments ?? []).reduce(
    (total, segment) => total + (segmentTime(segment) || defaultTime(segment)),
    0,
  );
}

/**
 * A per-call memo of `sampleSegment`.
 *
 * Only the segment actually being walked has to be sampled for its polyline;
 * the others need a duration, and a segment that carries a `time` needs nothing
 * at all. The memo keeps the one case that samples twice — an un-timed segment
 * that is also the one being walked — down to a single pass. It lives for a
 * single call on purpose: paths are rebuilt from the document every frame, so a
 * cache keyed on segment identity would never hit.
 */
function segmentSamples() {
  const seen = new Map();
  return (segment) => {
    let points = seen.get(segment);
    if (!points) {
      points = sampleSegment(segment);
      seen.set(segment, points);
    }
    return points;
  };
}

/** Stage units per millisecond a segment with no time of its own travels at. */
export const DEFAULT_SPEED = 0.6;

/** The time a segment with none falls back to, from how far it travels. */
function defaultTime(segment, points = sampleSegment(segment)) {
  return Math.round(segmentLength(segment, points) / DEFAULT_SPEED);
}

/** How far a segment travels, in stage units. */
export function segmentLength(segment, points = sampleSegment(segment)) {
  return segmentWalkLength(points);
}

/**
 * The point the path has reached at `elapsed` ms.
 *
 * Each segment owns a slice of the clock; within its slice the object walks its
 * polyline at a constant speed, measured by arc length rather than by point
 * index — otherwise a curve's short steps would crawl and its long ones would
 * race.
 *
 * @param {{ start: object, segments: object[] }} path
 * @param {number} elapsed Milliseconds since the path started.
 * @returns {{ x: number, y: number, done: boolean }}
 */
export function pointAt(path, elapsed) {
  const start = path?.start ?? { x: 0, y: 0 };
  const segments = path?.segments ?? [];
  if (!segments.length) {
    return { x: start.x, y: start.y, done: true };
  }

  const sample = segmentSamples();
  let remaining = Math.max(0, Number(elapsed) || 0);
  let from = [start.x, start.y];

  for (const segment of segments) {
    const points = segment?.points ?? [];
    if (points.length < 2) {
      continue;
    }
    // A segment that says how long it takes needs no geometry to place the
    // clock, and its end is the last point it was written with — the curve
    // sampling only fills in the steps between. Both facts let a frame skip
    // every segment it is not standing on.
    const span = segmentTime(segment) || defaultTime(segment, sample(segment));
    if (remaining < span) {
      // The segment is travelled from wherever the last one ended, not from the
      // file's own copy of that point, so a path with a gap does not jump. The
      // copy is made only for the segment actually walked, so the samples the
      // memo may share are never rewritten in place.
      const walked = sample(segment).slice(1);
      walked.unshift([from[0], from[1]]);
      const travelled = segmentTravel(walked, (remaining / span) * segmentWalkLength(walked));
      return { x: travelled[0], y: travelled[1], done: false };
    }
    remaining -= span;
    from = [points[points.length - 1][0], points[points.length - 1][1]];
  }

  return { x: from[0], y: from[1], done: true };
}

/** The polyline's total length, from already-sampled points. */
function segmentWalkLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  }
  return total;
}

/** The point `distance` along a polyline, by arc length. */
function segmentTravel(points, distance) {
  let left = Math.max(0, distance);
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const step = Math.hypot(bx - ax, by - ay);
    if (left <= step) {
      const t = step === 0 ? 0 : left / step;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
    left -= step;
  }
  const last = points[points.length - 1];
  return [last[0], last[1]];
}

/**
 * Where a path finishes, in stage coordinates.
 *
 * Used by the runtime to remember a character's place after a walk, so a
 * following relative `move` counts from the end rather than the start.
 *
 * @param {{ start: { x: number, y: number }, segments: object[] }} path
 * @returns {{ x: number, y: number }}
 */
export function pathEnd(path) {
  const at = pointAt(path, pathDuration(path));
  return { x: at.x, y: at.y };
}

/**
 * Every key frame file a script names, as ids.
 *
 * A key is a call that names its file: `ch.key("key-ch.keyframes")`. The
 * argument is a project-relative path under `data/`, so what the scan collects
 * is the id the file carries, whichever of the three spellings it has on disk.
 * A bare file name (`"key-ch.keyframes"`) is read too, since that is what the
 * editor writes when the file sits in `data/` — the folder is the default, the
 * same way `assets/` is for a picture.
 *
 * The older spellings are still read: `ch.key()` with no argument bound the key
 * to the variable, and `ch.followPath("id")` named a path directly. A project
 * made before either rename therefore does not lose its files on the next
 * integrity check.
 *
 * The scan is deliberately generous: it looks anywhere in the text, including
 * comments and strings, because keeping one unused file costs nothing while
 * deleting a file a script still uses breaks a scene.
 *
 * @param {string} text A Pamela script.
 * @returns {Set<string>} The ids it names.
 */
export function referencedIds(text) {
  const found = new Set();
  const source = String(text ?? "");
  // `ch.key("key-ch.keyframes")` — the argument is the file the key plays. A
  // bare name is the default (`data/` is implied), so both spellings are read.
  const keyed = /\.\s*key\s*\(\s*["']([^"']*)["']\s*\)/g;
  let match = keyed.exec(source);
  while (match) {
    const id = idFromKeyArgument(match[1]);
    if (id) {
      found.add(id);
    }
    match = keyed.exec(source);
  }
  // The older spelling with no argument: the variable before the dot was the
  // object the key belonged to.
  const bound = /([A-Za-z_]\w*)\s*\.\s*key\s*\(\s*\)/g;
  match = bound.exec(source);
  while (match) {
    const id = cleanId(match[1]);
    if (id) {
      found.add(id);
    }
    match = bound.exec(source);
  }
  // The older still: `ch.followPath("id")`.
  const named = /followPath\s*\(\s*["']([^"']*)["']/g;
  match = named.exec(source);
  while (match) {
    const id = cleanId(match[1]);
    if (id) {
      found.add(id);
    }
    match = named.exec(source);
  }
  return found;
}

/**
 * The path files nothing names any more, as project-relative paths.
 *
 * Called when the project is saved or checked, so the `data/` folder holds
 * exactly the paths the scripts still use — which is what the author expects
 * from a folder that mirrors their script.
 *
 * @param {string[]} existing Project-relative paths of the files on disk.
 * @param {string} scriptsText Every script's text, concatenated.
 * @returns {string[]} The files to delete.
 */
export function unreferencedPaths(existing, scriptsText) {
  const used = referencedIds(scriptsText);
  return (existing ?? []).filter((path) => {
    const id = idFromPathFile(path);
    return id !== "" && !used.has(id);
  });
}

// --- editing a segment's points ---
//
// A segment is a flat list of points, and a curve bends through every other
// point of it (`segmentControls`): the runs are start → waypoint → end, so the
// list is [a, b, c, d, e] for two cubics — `a` and `c` are on the line, `b` and
// `d` pull it. That shape is what makes "delete a point" more than a splice:
// removing `b` leaves `[a, c, …]`, which is a straight run between `a` and `c`,
// exactly the reconnection the author asked for.

/**
 * Removes the point at `index` and re-joins what is left in order.
 *
 * Points can be deleted down to a single one (the segment's start), so only the
 * last point is protected: removing it would leave nothing to draw. Deleting one
 * of a pair is allowed, which is how an author deletes every waypoint and keeps
 * just the start.
 *
 * Deleting a point also drops the curve handles that were pulling through it:
 * a handle whose pair no longer lines up with the remaining points would bend
 * the line into a shape no author placed, so `control` is trimmed to the runs the
 * new point list actually has.
 *
 * @param {{ type: string, points: [number, number][], control?: [number, number][][] | null }} segment
 * @param {number} index
 * @returns {{ points: [number, number][], control: [number, number][][] | null }}
 *   The new points and the trimmed handles, or the originals when nothing was
 *   removed.
 */
export function removePointAt(segment, index) {
  const points = (segment?.points ?? []).map((p) => [p[0], p[1]]);
  if (points.length <= 1 || index < 0 || index >= points.length) {
    return { points, control: segment?.control ?? null };
  }
  points.splice(index, 1);
  return { points, control: trimControl(segment?.control, points) };
}

/**
 * Cuts a curve's handles down to the runs the points now make.
 *
 * A pair belongs to one run of three points. Removing a point removes a run,
 * and a handle from a run that no longer exists would be applied to a different
 * stretch of the line — so the pairs are re-cut against the new point count and
 * the ones that fall off the end are dropped.
 *
 * @param {[number, number][][] | null} control
 * @param {[number, number][]} points
 * @returns {[number, number][][] | null}
 */
export function trimControl(control, points) {
  if (!Array.isArray(control)) {
    return null;
  }
  const runs = Math.max(0, Math.floor((points.length - 1) / 2));
  const kept = control.slice(0, runs).map((pair) =>
    Array.isArray(pair) && pair.length === 2
      ? [
          [pair[0][0], pair[0][1]],
          [pair[1][0], pair[1][1]],
        ]
      : null,
  );
  return kept.some(Boolean) ? kept : null;
}

/**
 * Inserts a point on the path between two existing ones.
 *
 * This is the "add a point to the line" edit, as opposed to the free click that
 * appends to the end: the author points at a stretch of the drawn line and gets
 * a new point sitting on it, so the shape does not move — only its resolution
 * goes up.
 *
 * A straight segment keeps one point per position, so the new point is simply
 * spliced in. A curve is different: its points are start → waypoint → end
 * per run, so a run of three becomes two runs of three and the list grows by
 * two — the new on-line point and the waypoint the second half needs. The
 * handles are split with de Casteljau at the parameter the new point sits at,
 * which is what keeps the drawn curve exactly where it was.
 *
 * @param {{ type: string, points: [number, number][], control?: [number, number][][] | null }} segment
 * @param {number} index Where the new point goes, as the index it will have.
 * @param {number} x
 * @param {number} y
 * @returns {{ points: [number, number][], control: [number, number][][] | null }}
 */
export function insertPointOnPath(segment, index, x, y) {
  const points = (segment?.points ?? []).map((p) => [p[0], p[1]]);
  const at = Number.isInteger(index) && index >= 0 && index <= points.length ? index : points.length;
  if (segment?.type !== "curve" || points.length < 3) {
    points.splice(at, 0, [x, y]);
    return { points, control: trimControl(segment?.control, points) };
  }

  // Which run the insert lands inside, and how far along it the new point is.
  const runs = Math.max(0, Math.floor((points.length - 1) / 2));
  const run = Math.min(runs - 1, Math.max(0, Math.floor((at - 1) / 2)));
  const from = points[run * 2];
  const via = points[run * 2 + 1];
  const to = points[run * 2 + 2];
  const controls = segmentControls(segment);
  const [c1, c2] = controls[run] ?? [via, via];
  // The parameter the new point is at, measured along the run's own chord: the
  // author clicked a spot on the line, so where it falls between the two ends
  // is what says where to cut the cubic.
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const t =
    span > 0
      ? Math.min(
          1,
          Math.max(
            0,
            ((x - from[0]) * (to[0] - from[0]) + (y - from[1]) * (to[1] - from[1])) /
              (span * span),
          ),
        )
      : 0.5;
  const half = splitCubic(from, c1, c2, to, t);

  const next = points.slice();
  // The new on-line point, then the waypoint the second half bends through.
  next.splice(run * 2 + 2, 0, [x, y], [
    (half.second[0] + to[0]) / 2,
    (half.second[1] + to[1]) / 2,
  ]);
  const control = [];
  for (let index2 = 0; index2 < runs + 1; index2 += 1) {
    if (index2 === run) {
      control.push(half.first);
    } else if (index2 === run + 1) {
      control.push(half.second);
    } else {
      const pair = segment.control?.[index2] ?? null;
      control.push(Array.isArray(pair) && pair.length === 2 ? pair : null);
    }
  }
  return { points: next, control: control.some(Boolean) ? control : null };
}

/**
 * Cuts a cubic at `t` into the two cubics that together draw the same curve.
 *
 * This is de Casteljau's construction: the point at `t`, then the two halves'
 * own control points. The two halves drawn one after the other are exactly the
 * original curve, which is what makes inserting a point on a curve leave the
 * picture untouched.
 *
 * @param {[number, number]} p0
 * @param {[number, number]} c1
 * @param {[number, number]} c2
 * @param {[number, number]} p3
 * @param {number} t
 * @returns {{ first: [[number, number], [number, number]], second: [[number, number], [number, number]] }}
 */
function splitCubic(p0, c1, c2, p3, t) {
  const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(p0, c1);
  const b = lerp(c1, c2);
  const c = lerp(c2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const mid = lerp(d, e);
  return {
    first: [a, d],
    second: [e, c],
  };
}

/**
 * Sets how much a curve bends through a point.
 *
 * `amount` is a multiplier on the pull: 0 makes the run straight, 1 is the
 * derived bend (`segmentControls`), and anything above 1 pulls harder. The
 * value is written as an explicit `control` pair, which is what the editor
 * already writes when a handle is dragged — so the file keeps a shape the
 * points alone do not describe, and the curve is the one the author asked for.
 *
 * @param {{ type: string, points: [number, number][], control?: [number, number][][] | null }} segment
 * @param {number} run Which cubic of the segment.
 * @param {number} amount The pull, where 1 is the derived bend.
 * @returns {boolean} Whether the segment was changed.
 */
export function setCurvature(segment, run, amount) {
  const points = segment?.points ?? [];
  const runs = Math.max(0, Math.floor((points.length - 1) / 2));
  if (!Number.isInteger(run) || run < 0 || run >= runs) {
    return false;
  }
  const pull = Number.isFinite(amount) ? Math.max(0, amount) : 1;
  const from = points[run * 2];
  const to = points[run * 2 + 2];
  const via = points[run * 2 + 1];
  const control = Array.isArray(segment.control)
    ? segment.control.map((pair) => (Array.isArray(pair) && pair.length === 2 ? pair : null))
    : [];
  while (control.length < runs) {
    control.push(null);
  }
  // The derived pair pulls through the waypoint; scaling it about the run's own
  // ends gives the same shape at 1 and a straight line at 0.
  control[run] = [
    [from[0] + (via[0] - from[0]) * pull, from[1] + (via[1] - from[1]) * pull],
    [to[0] + (via[0] - to[0]) * pull, to[1] + (via[1] - to[1]) * pull],
  ];
  segment.control = control.some(Boolean) ? control : null;
  segment.type = "curve";
  return true;
}

// --- object-state key frames ---
//
// The *editor* works in this shape, which is what "a key frame is the object's
// complete state at one moment" means:
//
//   keyframe = {
//     x, y,                        position in stage space
//     rotation, scale, alpha,     the classic look
//     scaleX, scaleY,             the eight-handle free transform
//     time, duration,             cumulative clock and the leg into this frame
//     link: { time, bends[] }     the connection from the frame before it
//   }
//
// `link.bends` are points that sit on the drawn line, not control handles
// floating off it: an empty list is a straight line, one bend is one cubic, two
// bends are two cubics joined end to end. Dragging one re-solves the cubic's own
// control point, so what the author grabs is exactly what moves.
//
// Nothing here is a second file format. `keyframesOf` reads the file the runtime
// already plays and `pathFromKeyframes` writes that same shape back, so the
// stage, the interpreter and every existing project keep working unchanged.

/**
 * The stage position of every key frame, in order.
 *
 * Frame 0 is the start; every segment contributes its own end. A segment is
 * walked from where the previous one finished (the same rule `pointAt` uses), so
 * a file whose segments do not quite meet still reads as one continuous route.
 *
 * @param {{ start?: object, segments?: object[] }} path
 * @returns {{ x: number, y: number }[]}
 */
export function framePositions(path) {
  const start = path?.start ?? { x: 0, y: 0 };
  const out = [{ x: numberOr(start.x, 0), y: numberOr(start.y, 0) }];
  let from = [out[0].x, out[0].y];
  for (const segment of path?.segments ?? []) {
    const walked = sampleSegment(segment);
    if (walked.length < 2) {
      continue;
    }
    walked[0] = [from[0], from[1]];
    from = walked[walked.length - 1];
    out.push({ x: from[0], y: from[1] });
  }
  return out;
}

/** The point a cubic `p0 → (c1,c2) → p1` draws halfway along itself. */
function bendOf(p0, pair, p1) {
  const [c1, c2] = pair;
  return {
    x: 0.125 * p0[0] + 0.375 * c1[0] + 0.375 * c2[0] + 0.125 * p1[0],
    y: 0.125 * p0[1] + 0.375 * c1[1] + 0.375 * c2[1] + 0.125 * p1[1],
  };
}

/**
 * The control point that puts a cubic's midpoint at `bend`.
 *
 * At `t = 0.5` a cubic with both control points on `via` is
 * `0.125·from + 0.75·via + 0.125·to`; solving that for `via` is what lets a
 * point on the line be the handle instead of one beside it.
 */
function viaFor(from, to, bend) {
  return [
    (bend.x - 0.125 * (from[0] + to[0])) / 0.75,
    (bend.y - 0.125 * (from[1] + to[1])) / 0.75,
  ];
}

/**
 * Reads the connection into a key frame out of a file segment.
 *
 * A line has no bends. A curve answers one bend per cubic, taken from the drawn
 * midpoint of that cubic, so a file written by the older point-dragging editor
 * opens with the same shape and with handles the author can immediately grab.
 *
 * @param {{ type: string, points: [number, number][], time?: number }} segment
 * @returns {{ time: number, bends: { x: number, y: number }[] }}
 */
export function linkFromSegment(segment) {
  const time = segmentTime(segment) || defaultTime(segment);
  if (segment?.type !== "curve") {
    return { time, bends: [] };
  }
  const points = segment.points ?? [];
  const controls = segmentControls(segment);
  const bends = [];
  for (let run = 0; run < controls.length; run += 1) {
    const from = points[run * 2];
    const to = points[run * 2 + 2];
    if (!from || !to) {
      continue;
    }
    bends.push(bendOf(from, controls[run], to));
  }
  return { time, bends };
}

/**
 * Writes a connection as the segment the runtime walks.
 *
 * The two frames are joined by `bends.length` cubics. Their meeting points are
 * spaced evenly along the straight chord, and each cubic's control point is
 * solved from its bend — so `linkFromSegment(segmentFromLink(...))` gives the
 * bends back, and the drawn line passes exactly through the handles the author
 * placed.
 *
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {{ time?: number, bends?: { x: number, y: number }[] }} link
 * @returns {{ type: string, points: [number, number][], time: number }}
 */
export function segmentFromLink(from, to, link) {
  const time = Number(link?.time) > 0 ? Number(link.time) : 0;
  const bends = Array.isArray(link?.bends)
    ? link.bends.filter((bend) => Number.isFinite(Number(bend?.x)) && Number.isFinite(Number(bend?.y)))
    : [];
  const a = [numberOr(from?.x, 0), numberOr(from?.y, 0)];
  const b = [numberOr(to?.x, 0), numberOr(to?.y, 0)];
  if (!bends.length) {
    return { type: "line", points: [a, b], time };
  }

  const count = bends.length;
  const points = [a];
  let previous = a;
  for (let run = 1; run <= count; run += 1) {
    const end = [a[0] + ((b[0] - a[0]) * run) / count, a[1] + ((b[1] - a[1]) * run) / count];
    const bend = { x: Number(bends[run - 1].x), y: Number(bends[run - 1].y) };
    points.push(viaFor(previous, end, bend), end);
    previous = end;
  }
  return { type: "curve", points, time };
}

/**
 * The whole path as a list of object-state key frames.
 *
 * Position comes from `framePositions`, the classic look from `keyFrames`, the
 * stretch from `sizeFrames`, and the leg between two frames from
 * `linkFromSegment`. Together they are one snapshot per moment, which is the
 * shape the editor drags, turns and commits.
 *
 * @param {{ start?: object, segments?: object[] }} path A normalized path.
 * @returns {object[]} At least one frame (the start).
 */
export function keyframesOf(path) {
  const frames = keyFrames(path);
  const sizes = path?.sizes ?? sizeFrames(path);
  const positions = framePositions(path);
  const segments = path?.segments ?? [];
  return frames.map((frame, index) => {
    const position = positions[index] ?? { x: 0, y: 0 };
    const size = sizes[index] ?? DEFAULT_SIZE;
    return {
      x: position.x,
      y: position.y,
      rotation: frame.rotation,
      scale: frame.scale,
      alpha: frame.alpha,
      scaleX: size.scaleX,
      scaleY: size.scaleY,
      time: frame.time,
      duration: index === 0 ? 0 : frame.time - frames[index - 1].time,
      link: index === 0 ? null : linkFromSegment(segments[index - 1]),
    };
  });
}

/** The frame properties as they go into a file, with safe fallbacks. */
function frameState(raw) {
  const scale = numberOr(raw?.scale, 1);
  const scaleX = numberOr(raw?.scaleX, 1);
  const scaleY = numberOr(raw?.scaleY, 1);
  return {
    rotation: numberOr(raw?.rotation, 0),
    scale: scale === 0 ? 1 : scale,
    alpha: Math.min(1, Math.max(0, numberOr(raw?.alpha, 1))),
    scaleX: scaleX === 0 ? 1 : scaleX,
    scaleY: scaleY === 0 ? 1 : scaleY,
  };
}

/**
 * Builds the path a list of key frames stands for, ready for `buildPathFile`.
 *
 * Every frame writes its whole state, so a path made here drives rotation, size,
 * opacity and the free transform from its first frame — which is what "the frame
 * is a snapshot of the object" means. A legacy file that only moves the object
 * still reads through `normalizePath` and keeps its old, quieter behaviour.
 *
 * @param {string} id
 * @param {string} [name]
 * @param {object[]} frames
 * @returns {{ id: string, name: string, start: object, segments: object[] }}
 */
export function pathFromKeyframes(id, name, frames) {
  const list = Array.isArray(frames) ? frames.filter((frame) => frame && typeof frame === "object") : [];
  const first = list[0] ?? {};
  const start = { x: numberOr(first.x, 0), y: numberOr(first.y, 0), ...frameState(first) };
  const segments = [];
  for (let index = 1; index < list.length; index += 1) {
    const from = list[index - 1];
    const to = list[index];
    const link = to.link ?? {};
    const segment = segmentFromLink(
      { x: numberOr(from.x, 0), y: numberOr(from.y, 0) },
      { x: numberOr(to.x, 0), y: numberOr(to.y, 0) },
      link,
    );
    segment.end = frameState(to);
    segments.push(segment);
  }
  return { id: cleanId(id), name: displayNameFor(id, name), start, segments };
}
