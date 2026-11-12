// 舞台音频播放与配音时长管理。
// Pamela — sound on the stage.
// 元数据不可用时设置超时，避免无限等待。
/**
 * Builds the `Audio` a script calls.
 *
 * @param {object} options
 * @param {(path: string) => Promise<string>} options.resolveAsset
 *   Turns an asset name into a URL the webview may play.
 * @param {(message: string) => void} [options.onError]
 *   Reports a sound that could not be loaded or started; the stage stays usable.
 * @returns {((args: unknown[], context: object) => object) & { clear: () => void }}
 */

export function createAudioFactory({
  resolveAsset,
  isReplaying = () => false,
  onError = () => {},
}) {
  /**
   * What each slot is playing through, plus the way to retire it.
   *
   * Slots are what make rebuilding a variable replace its sound instead of
   * stacking a second copy on top — the same rule a character's slot follows
   * for its picture.
   */
  const slots = new Map();

  /** Names sounds that were never assigned, one run at a time. */
  let counter = 0;

  /** Stops whatever is playing in `slot`, if anything. */
  const silence = (slot) => {
    const entry = slots.get(slot);
    if (!entry) {
      return;
    }
    entry.retire();
    slots.delete(slot);
  };

  /**
   * Moves a volume to `target` over `time` milliseconds.
   *
   * No promise is returned on purpose: a fade is a property of the sound, not a
   * beat in the script. It answers a cancel function instead, so a sound that is
   * stopped or rebuilt cannot keep writing to an element nobody owns any more.
   */
  const glide = (element, from, target, time, done) => {
    const span = Number(time) || 0;
    if (!(span > 0)) {
      element.volume = target;
      done?.();
      return () => {};
    }
    const started = Date.now();
    let timer = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) {
        return;
      }
      const progress = Math.min(1, (Date.now() - started) / span);
      element.volume = from + (target - from) * progress;
      if (progress < 1) {
        timer = setTimeout(step, 16);
      } else {
        done?.();
      }
    };
    step();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  };

  /** Reports a failure the way the rest of the stage does: one message. */
  const fail = (error) => onError(error instanceof Error ? error.message : String(error));

  /** Builds one sound; this is the function the interpreter calls as `Audio`. */
  const factory = (args, context) => {
    const path = typeof args[0] === "string" ? args[0].trim() : "";
    if (!path) {
      throw new Error("Audio 需要音频文件名");
    }
    const slot = context.assignee ?? `audio-${(counter += 1)}`;
    silence(slot);

    const element = document.createElement("audio");
    element.preload = "auto";
    element.loop = false;
    const entry = {
      element,
      // The sound object itself, filled in below once it is built. A voice
      // track needs it to read the length off the same element the script uses.
      sound: null,
      /** Cancels the fade currently writing this element's volume. */
      cancelFade: null,
      /** Counts fade-outs so a cancelled one cannot pause a newer play. */
      fadeToken: 0,
      // A sound that is being replaced or cleared must not start late: a load
      // that lands after the script moved on would otherwise play the sound
      // nobody asked for any more.
      retire: () => {
        generation += 1;
        entry.cancelFade?.();
        entry.cancelFade = null;
        element.pause();
        element.currentTime = 0;
        // The source is a `data:` URL that can be tens of megabytes; dropping
        // it lets the decoded buffer go with the element. The guards keep a
        // minimal media element (the tests use one) from throwing here.
        element.removeAttribute?.("src");
        if (typeof element.load === "function") {
          element.load();
        }
      },
    };
    slots.set(slot, entry);

    /** The volume the script asked for, kept across fades. */
    let level = 1;

    /**
     * Counts the starts and stops asked for, so a load that finishes late can
     * tell whether the script still wants it.
     */
    let generation = 0;

    /** The resolved source, fetched the first time it is needed. */
    let source = null;
    const load = () => {
      if (!source) {
        source = Promise.resolve()
          .then(() => resolveAsset(path))
          .then((url) => {
            if (!url) {
              throw new Error(`无法加载音频：${path}`);
            }
            element.src = url;
          })
          .catch((error) => {
            // A missing file is retryable: do not cache the rejection for the
            // rest of the run.
            source = null;
            throw error;
          });
      }
      return source;
    };

    // What the constructor was given besides the file, in the order
    // `PARAM_SPECS.Audio` declares: `Audio("bgm.mp3", volume = 0.4, loop = true)`.
    const givenVolume = args[1] === undefined ? null : Number(args[1]);
    if (givenVolume !== null) {
      if (!Number.isFinite(givenVolume)) {
        throw new Error("Audio 的音量需要数字");
      }
      level = Math.min(1, Math.max(0, givenVolume));
    }
    if (args[2] !== undefined && args[2] !== null) {
      element.loop = Boolean(args[2]);
    }
    element.volume = level;

    const sound = {
      // Which object this is, so a named argument can be matched to this
      // object's own method rather than to a same-named one elsewhere.
      kind: "Audio",
      /**
       * Plays from the beginning, fading in over `time` milliseconds.
       *
       * A sound already on is restarted, which is what an effect wanted twice
       * in a row needs. A `stop` or a rebuilt variable afterwards wins: the
       * start is dropped rather than played late.
       */
      play(time = 0) {
        // A fade-out from an earlier stop must not pause what this starts.
        entry.cancelFade?.();
        entry.cancelFade = null;
        // A replay restores what was still on, not what was heard once: a
        // looping track is part of the scene and is started again, while a
        // one-shot effect belongs to the moment it played and is skipped.
        const restore = isReplaying();
        if (restore && !element.loop) {
          return sound;
        }
        const fadeIn = restore ? 0 : Number(time) || 0;
        const wanted = (generation += 1);
        load()
          .then(() => {
            if (wanted !== generation) {
              return;
            }
            element.currentTime = 0;
            element.volume = fadeIn > 0 ? 0 : level;
            const started = element.play();
            if (started && typeof started.catch === "function") {
              started.catch(fail);
            }
            if (fadeIn > 0) {
              entry.cancelFade = glide(element, 0, level, fadeIn);
            }
          })
          .catch(fail);
        return sound;
      },

      /** Stops, fading out over `time` milliseconds. */
      stop(time = 0) {
        // Stopping is silent either way, so a replay stops at once rather
        // than fading: there is nobody to hear the fade.
        const fadeOut = isReplaying() ? 0 : Number(time) || 0;
        // Bumped even when nothing is on yet: a `play` still loading is a
        // start this stop was written after.
        generation += 1;
        if (!element.src) {
          return sound;
        }
        if (fadeOut > 0) {
          const token = (entry.fadeToken += 1);
          entry.cancelFade = glide(element, element.volume, 0, fadeOut, () => {
            if (token !== entry.fadeToken) {
              return;
            }
            element.pause();
            element.currentTime = 0;
            element.volume = level;
          });
        } else {
          element.pause();
          element.currentTime = 0;
          element.volume = level;
        }
        return sound;
      },

      /** Repeats until stopped: a background track. */
      loop() {
        element.loop = true;
        return sound;
      },

      /** Plays once and stops at the end: a sound effect. */
      once() {
        element.loop = false;
        return sound;
      },

      /**
       * Sets the volume, 0 to 1, fading over `time` milliseconds.
       *
       * A value outside the range is clamped rather than refused: a script that
       * asks for 2 wants the loudest it can have.
       */
      volume(value, time = 0) {
        const wanted = Number(value);
        if (!Number.isFinite(wanted)) {
          throw new Error("Audio.volume 需要数字");
        }
        level = Math.min(1, Math.max(0, wanted));
        entry.cancelFade?.();
        entry.cancelFade = null;
        entry.cancelFade = glide(
          element,
          element.volume,
          level,
          isReplaying() ? 0 : Number(time) || 0,
        );
        return sound;
      },

      /**
       * 返回该音频的时长（毫秒）；元数据就绪后立即返回，无法获取时返回 0。
       * 用于 say 的 audio 参数计时切换语句。
       */
      duration() {
        return new Promise((resolve) => {
          if (element.duration && Number.isFinite(element.duration) && element.duration > 0) {
            resolve(Math.round(element.duration * 1000));
            return;
          }
          let done = false;
          let guard = 0;
          // Both listeners and the timeout outlive the answer unless they are
          // taken down here: `once` only removes the event that fired, and a
          // voice line asks for the duration of a sound already loaded.
          const cleanup = () => {
            element.removeEventListener("loadedmetadata", onMeta);
            element.removeEventListener("durationchange", onMeta);
            clearTimeout(guard);
          };
          const finish = (ms) => {
            if (done) {
              return;
            }
            done = true;
            cleanup();
            resolve(ms);
          };
          const onMeta = () => finish(Math.round((element.duration || 0) * 1000));
          element.addEventListener("loadedmetadata", onMeta);
          element.addEventListener("durationchange", onMeta);
          // 资源缺失时元数据可能始终不可用，需设置超时以避免无限等待。
          guard = setTimeout(() => finish(0), 2000);
        });
      },
    };

    slots.get(slot).sound = sound;
    return sound;
  };

  /** Stops everything, for a stage being cleared or reset. */
  factory.clear = () => {
    for (const entry of slots.values()) {
      entry.retire();
    }
    slots.clear();
  };

  /**
   * Plays the sound held in `name` and answers how long it runs, in ms.
   *
   * This is what a `say(text, time, audio)` binds to: the line is cut when the
   * voice track ends rather than after a fixed pause. A name that holds no
   * sound — a typo, or a variable not built yet — answers 0 rather than
   * throwing, so a missing voice track leaves the line on its normal timer.
   *
   * @param {string} name The variable the script built the sound in.
   * @returns {Promise<number>} The track's length in ms, or 0.
   */
  factory.voice = (name) => {
    const entry = slots.get(String(name ?? ""));
    if (!entry) {
      return Promise.resolve(0);
    }
    // Replaying a save travels past lines instead of performing them, so a
    // voice track must not start for a line with no active listener.
    if (!isReplaying()) {
      entry.element.currentTime = 0;
      const started = entry.element.play();
      if (started && typeof started.catch === "function") {
        started.catch(() => {});
      }
    }
    return entry.sound.duration();
  };

  /**
   * 立即停止由 `voice` 播放的配音轨，用于切句或手动推进时中断语音。
   *
   * 与 `voice` 对称：名字无对应声音时静默忽略，不抛错，让缺轨的台词按其
   * 正常计时继续，而不是中断演出。
   *
   * @param {string} name 变量名（与 `voice` 同参）。
   */
  factory.stopVoice = (name) => {
    const entry = slots.get(String(name ?? ""));
    if (!entry) {
      return;
    }
    entry.sound?.stop(0);
  };

  return factory;
}
