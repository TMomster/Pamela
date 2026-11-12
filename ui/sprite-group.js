// 逐帧图片组：一组图片、每秒张数与组内的增删改。
// Pamela — a sprite group: pictures of one object played at a frame rate.
//
// 舞台与导出录制共用这里的三件事：一张图是不是合法成员、一段播放会在第几张、
// 以及列表本身怎么改。两边各有一份播放实现（舞台用计时器，导出按时间线求值），
// 但「第几张」只有这一个答案，否则成片与预览会在同一份脚本上走出不同的帧。

/** 每秒最少的张数：1 张/秒，最慢的逐帧动画。 */
export const SPRITE_FPS_MIN = 1;

/** 每秒最多的张数：144 张/秒，比 60 帧的画面还密。 */
export const SPRITE_FPS_MAX = 144;

/**
 * One member of a group: a non-empty picture path.
 *
 * A group is a list of pictures, so an empty string is not a member — it is the
 * `Character()` an author wrote and has not filled in yet, and accepting it
 * would put a blank frame in the middle of the animation.
 *
 * @param {string} kind The object type, for the message: "Character".
 * @param {unknown} value
 * @returns {string}
 */
export function spritePath(kind, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${kind} 的图片组需要一个图片路径`);
  }
  return value.trim();
}

/**
 * Reads a playback rate: frames per second, 1–144.
 *
 * 0 is refused rather than read as "paused": a paused group is what `pause()`
 * is for, and an animation that silently never advances would look like a bug.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function spriteFrameRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < SPRITE_FPS_MIN || rate > SPRITE_FPS_MAX) {
    const shown = value === undefined || value === null || value === "" ? "空值" : String(value);
    throw new Error(`fps 需要 ${SPRITE_FPS_MIN}–${SPRITE_FPS_MAX} 的数字（每秒张数），收到${shown}`);
  }
  return rate;
}

/**
 * The 0-based position of one member, named by number or by its picture path.
 *
 * Both spellings are the same list position: `element(1)` and
 * `element("ch2.png")` must answer the same picture.
 *
 * @param {readonly string[]} paths
 * @param {unknown} value
 * @param {string} callable The method to name in an error: "element".
 * @returns {number}
 */
export function spriteIndex(paths, value, callable = "element") {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value >= paths.length) {
      throw new Error(`${callable} 的位置 ${value} 超出范围（组里有 ${paths.length} 张）`);
    }
    return value;
  }
  if (typeof value === "string") {
    const name = value.trim();
    const at = paths.indexOf(name);
    if (at < 0) {
      throw new Error(`${callable} 在组里找不到图片：${name}`);
    }
    return at;
  }
  throw new Error(`${callable} 需要 0 起的序号或图片名`);
}

/**
 * Which member is showing `elapsed` milliseconds into a playback.
 *
 * One-shot playback stops on the last picture instead of wrapping: a walk cycle
 * played once should end on its final pose and stay there. A looping playback
 * wraps, which is what makes `fps(16, true)` an idle animation.
 *
 * @param {number} elapsed Milliseconds since the playback started.
 * @param {number} rate Frames per second.
 * @param {number} count How many pictures the group has.
 * @param {boolean} loop Whether the playback wraps.
 * @returns {number} A 0-based position; -1 when the group is empty.
 */
export function spriteFrameAt(elapsed, rate, count, loop) {
  if (count <= 0) {
    return -1;
  }
  const step = Math.floor((Math.max(0, elapsed) * rate) / 1000);
  if (loop) {
    return step % count;
  }
  return Math.min(step, count - 1);
}

/**
 * A player for one object's group.
 *
 * `show(path)` is what actually puts a picture up; the player only decides
 * which one and when. It is called for the first frame, for every step, and for
 * a `pause` that names a picture — a stage and an export recorder therefore
 * share the timing while each keeps its own way of drawing.
 *
 * @param {object} options
 * @param {string} options.kind The object type, for error messages.
 * @param {(path: string) => void} options.show Puts `path` on screen.
 * @returns {object}
 */
export function createSpritePlayer({ kind, show }) {
  /** @type {string[]} */
  let paths = [];
  let index = 0;
  let shown = "";
  let timer = 0;
  let playing = false;
  let loop = false;
  let rate = 0;
  /** @type {(() => void) | null} */
  let finishWait = null;

  /** Puts `path` up and remembers it as the frame on screen. */
  const paint = (path) => {
    shown = path;
    show(path);
  };

  /** Stops the clock; a script waiting on the playback is let go. */
  const halt = () => {
    playing = false;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    const finish = finishWait;
    finishWait = null;
    finish?.();
  };

  const schedule = () => {
    timer = setTimeout(() => {
      timer = 0;
      if (!playing) {
        return;
      }
      const next = index + 1;
      if (next < paths.length) {
        index = next;
        paint(paths[index]);
        schedule();
        return;
      }
      if (loop) {
        index = 0;
        paint(paths[0]);
        schedule();
        return;
      }
      // One-shot: the last picture has had its interval, so the run is over.
      halt();
    }, 1000 / rate);
  };

  /** The position the group resumes at: the picture on screen if it is one. */
  const resumeAt = () => {
    const at = paths.indexOf(shown);
    return at >= 0 ? at : 0;
  };

  return {
    /** The whole list, for a host that records it. */
    paths: () => [...paths],

    /** The position showing now, or -1 for an empty group. */
    index: () => (paths.length ? index : -1),

    /** Whether the clock is running. */
    isPlaying: () => playing,

    /** Replaces the whole list; playback stops on the first picture. */
    setGroup(values) {
      halt();
      paths = values.map((value) => spritePath(kind, value));
      index = 0;
      shown = "";
      if (paths.length) {
        paint(paths[0]);
      }
      return this;
    },

    /** The path at one member. */
    element(value) {
      return paths[spriteIndex(paths, value, "element")];
    },

    /**
     * Plays the group at `value` frames per second.
     *
     * Resumes from the picture on screen, so a `pause` followed by `fps` carries
     * on rather than starting over. Answers a promise that settles when the
     * playback stops: a one-shot at its end, a loop only when something pauses
     * it (or the stage is cleared).
     */
    play(value, looping = false) {
      const wanted = spriteFrameRate(value);
      if (!paths.length) {
        throw new Error(`${kind} 还没有设置 group，先写 group("…")`);
      }
      halt();
      rate = wanted;
      loop = Boolean(looping);
      index = resumeAt();
      if (shown !== paths[index]) {
        paint(paths[index]);
      }
      playing = true;
      const wait = new Promise((resolve) => {
        finishWait = resolve;
      });
      schedule();
      return wait;
    },

    /**
     * Stops the clock, optionally showing one picture.
     *
     * No argument freezes on the frame on screen. A number or a member name
     * shows that member; any other path is shown as it is — a pause may hold a
     * picture from outside the group, and the group itself does not change.
     */
    pause(value) {
      halt();
      if (value === undefined || value === null || value === "") {
        return this;
      }
      if (typeof value === "number" || (typeof value === "string" && paths.includes(value.trim()))) {
        index = spriteIndex(paths, value, "pause");
        paint(paths[index]);
        return this;
      }
      paint(spritePath(kind, value));
      return this;
    },

    /** Adds `path` directly after the member `value` names. */
    add(value, path) {
      const picture = spritePath(kind, path);
      const at = spriteIndex(paths, value, "add");
      paths.splice(at + 1, 0, picture);
      return this;
    },

    /** Removes the member `value` names; the picture on screen stays up. */
    remove(value) {
      const at = spriteIndex(paths, value, "remove");
      paths.splice(at, 1);
      if (at < index) {
        index -= 1;
      }
      index = Math.min(index, Math.max(0, paths.length - 1));
      return this;
    },

    /** Replaces the member `value` names with `path`, keeping its position. */
    update(value, path) {
      const picture = spritePath(kind, path);
      const at = spriteIndex(paths, value, "update");
      const before = paths[at];
      paths[at] = picture;
      if (shown === before) {
        index = at;
        paint(picture);
      }
      return this;
    },

    /** Stops the clock and lets a waiting script go; used by clear and rebuilds. */
    stop() {
      halt();
      return this;
    },
  };
}
