// 舞台音频播放与配音时长管理。
// Pamela — sound on the stage.
import { OBJECT_DESTROY } from "./pamela.js";
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

  /**
   * 配音轨专用槽位，与 `slots`（`Audio` 变量的效果音）完全分开。
   *
   * `say(text, time, audio)` 的 `audio` 可以正好指向一个正在播放效果音的
   * `Audio` 变量。配音若复用那个变量的元素，就会把效果音重置、抢占为配音。
   * 给配音单独建元素后，效果音与配音、以及各条配音之间都能并行播放。
   * 键就是 `say` 给的名字，使 `stopVoice` / `clear` 仍能像以前一样停掉配音。
   */
  const voiceSlots = new Map();

  /** Names sounds that were never assigned, one run at a time. */
  let counter = 0;

  /**
   * 调试指令给的基础速度倍率：默认 1，走到指令时才改，且只影响之后的播放。
   * 效果音与配音各一路；脚本自己写的 speed / speedTo 在这两个数之上相乘。
   */
  let baseAudioRate = 1;
  let baseVoiceRate = 1;

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

  /** 播放速率上下限：1 为原速，0.1–10.0 可调（与 Video 一致）。 */
  const clipRate = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 1;
    }
    return Math.min(10, Math.max(0.1, parsed));
  };

  /**
   * 判断 `say` 的尾部字符串是「直接文件名 / 路径」还是「Audio 变量名」。
   *
   * 含分隔符或带扩展名的按文件处理；纯单词（如 `v1`、`旁白`）视为变量名——
   * 查不到时静默回退到普通计时，不会误把拼写错误当成缺文件去读盘。两个文件里的
   * 判定必须保持一致：播放舞台与导出录制都靠它区分二者。
   */
  const AUDIO_PATH_RE = /[\\/]|[.][A-Za-z0-9]{1,8}$/;
  const looksLikePath = (name) =>
    typeof name === "string" && AUDIO_PATH_RE.test(name);

  /** 取一个 `<audio>` 元素的时长（毫秒），元数据就绪即答，超时 2s 答 0。 */
  const durationOf = (element) =>
    new Promise((resolve) => {
      if (
        element.duration &&
        Number.isFinite(element.duration) &&
        element.duration > 0
      ) {
        resolve(Math.round(element.duration * 1000));
        return;
      }
      let done = false;
      let guard = 0;
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

  /** 停下一个 `<audio>` 元素并丢弃其 `data:` 源，释放解码缓冲。 */
  const retireElement = (element) => {
    element.pause();
    element.currentTime = 0;
    element.removeAttribute?.("src");
    if (typeof element.load === "function") {
      element.load();
    }
  };

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
      // 配音要按变量名找到同一个音频文件，但用自己独立的元素播放；这里记住
      // 文件路径，配音轨据此取源，而不是抢占这个变量正在播的效果音元素。
      path,
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

    /** 播放速率：1 为原速，脚本可用 speed / speedTo 改。 */
    let speed = 1;

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

    /** 设置播放速率：`absolute` 为 true 时直接设成 `value`，否则在原速上相乘。 */
    const setSpeed = (value, absolute) => {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Audio 的速度需要大于 0 的数字");
      }
      speed = clipRate(absolute ? amount : speed * amount);
      element.playbackRate = baseAudioRate * speed;
    };

    const sound = {
      // Which object this is, so a named argument can be matched to this
      // object's own method rather than to a same-named one elsewhere.
      kind: "Audio",
      /** 统一开关：声音的 enable/disable 就是带淡变的 play/stop。 */
      enable(time = 0) {
        return sound.play(time);
      },
      disable(time = 0) {
        return sound.stop(time);
      },
      /** `del bgm`：停下并丢掉 audio 元素持有的数据。 */
      [OBJECT_DESTROY]() {
        slots.delete(slot);
        entry.retire();
      },
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
            element.playbackRate = baseAudioRate * speed;
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
       * 相对改变播放速率：`speed(2)` 在「当前速率 × 2」，1 为原速。
       * 范围 0.1–10.0，超出部分夹取；支持实时变速（正在响的声音立即变调变速）。
       */
      speed(value, time = 0) {
        setSpeed(value, false);
        return sound;
      },

      /** 把播放速率设成 `value`：1 为原速，范围 0.1–10.0。 */
      speedTo(value, time = 0) {
        setSpeed(value, true);
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
        return durationOf(element);
      },
    };

    slots.get(slot).sound = sound;
    return sound;
  };

  /**
   * `# debug::com.audio.*Speed` 走到这里时改基础倍率。
   *
   * 只改变量，不遍历已建的元素：已经响着的声音保持原速，之后才 play 的
   * 效果音 / 才 say 的配音按新倍率启动。舞台重建会新建工厂，倍率随之复位。
   */
  factory.setAudioSpeed = (value) => {
    baseAudioRate = clipRate(value);
  };
  factory.setVoiceSpeed = (value) => {
    baseVoiceRate = clipRate(value);
  };

  /** Stops everything, for a stage being cleared or reset. */
  factory.clear = () => {
    // 舞台只建一次，倍率不能带进下一趟演出；清台和停止都是一次的边界。
    baseAudioRate = 1;
    baseVoiceRate = 1;
    for (const entry of slots.values()) {
      entry.retire();
    }
    slots.clear();
    // 配音轨也要停：清台后不该有一段台词的声音留在空舞台上。
    for (const entry of [...voiceSlots.values()]) {
      entry.retire();
    }
    voiceSlots.clear();
  };

  /**
   * 把 `say` 的 `audio` 名字解析成要加载的音频文件路径。
   *
   * 脚本建过的 `Audio` 变量优先（即使它正在播放效果音），取它构造时的路径；
   * 没有该变量但字符串形如文件时按路径处理；其余情况（拼写错误的变量名等）
   * 返回 null，让台词回落到普通计时而不是误读盘。
   *
   * @param {string} name 变量名或文件路径。
   * @returns {string | null} 音频文件路径，或 null。
   */
  const voicePath = (name) => {
    const entry = slots.get(name);
    if (entry?.path) {
      return entry.path;
    }
    return looksLikePath(name) ? name : null;
  };

  /**
   * 为配音建一条独立声轨：懒加载、自动播放，登记到 `voiceSlots`（键即名字）。
   *
   * 关键点是它永远不碰 `slots` 里 `Audio` 变量的元素：那个变量可能正在播效果音，
   * 配音只在自己新建的元素上从头播放，两者因此并行。同名配音再次触发时复用本轨
   * 并从头播放；`stopVoice` / `clear` 则按名字停掉本轨，不碰效果音。
   *
   * @param {string} name 配音名，作 `voiceSlots` 的键。
   * @param {string} path 项目相对的音频路径。
   * @returns {object} 含 `element` / `sound` / `retire` 的槽位项。
   */
  const ensureVoiceEntry = (name, path, rate) => {
    const existing = voiceSlots.get(name);
    if (existing) {
      // 同一名字再配一次：从头播放本轨，与之前一样不影响任何变量的效果音。
      if (!isReplaying()) {
        existing.element.currentTime = 0;
        existing.element.playbackRate = rate;
        const started = existing.element.play();
        if (started && typeof started.catch === "function") {
          started.catch(() => {});
        }
      }
      return existing;
    }
    const element = document.createElement("audio");
    element.preload = "auto";
    element.loop = false;
    const entry = {
      element,
      retired: false,
      // 配音轨只需时长与停止；停止即丢弃源，不残留到下一句。
      sound: {
        duration: () => durationOf(element),
      },
      retire: () => {
        entry.retired = true;
        retireElement(element);
        // 只删自己：异步加载失败时若同名配音已重建，不能误删新轨。
        if (voiceSlots.get(name) === entry) {
          voiceSlots.delete(name);
        }
      },
    };
    voiceSlots.set(name, entry);
    // 先把槽位交出去，再异步取源；源未到之前 `duration` 已挂好元数据监听，
    // 不会错过 `loadedmetadata`。读不到或解码不了时移除槽位，整段静默回退。
    Promise.resolve()
      .then(() => resolveAsset(path))
      .then((url) => {
        if (!url) {
          throw new Error(`无法加载音频：${path}`);
        }
        if (entry.retired) {
          return;
        }
        element.src = url;
        if (!isReplaying()) {
          element.playbackRate = rate;
          const started = element.play();
          if (started && typeof started.catch === "function") {
            started.catch(fail);
          }
        }
      })
      .catch((error) => {
        if (entry.retired) {
          return;
        }
        fail(error);
        entry.retire();
      });
    return entry;
  };

  /**
   * Plays a voice track for `name` and answers how long it runs, in ms.
   *
   * This is what a `say(text, time, audio)` binds to: the line is cut when the
   * voice track ends rather than after a fixed pause. The voice always plays on
   * its own element, so it never interrupts an `Audio` variable's effect that
   * happens to share the same name; several tracks may play together. `name`
   * resolves in two ways — a variable the script built an `Audio` in (priority),
   * or, when no such variable exists and the string looks like a file, the audio
   * file itself. A name that matches neither answers 0, leaving the line on its
   * normal timer.
   *
   * @param {string} name The variable the script built the sound in, or a file path.
   * @returns {Promise<number>} 按启动时基础倍率折算后的时长（毫秒），或 0。
   */
  factory.voice = (name) => {
    const key = String(name ?? "");
    const path = voicePath(key);
    if (path === null) {
      return Promise.resolve(0);
    }
    // 这一句认下启动时的基础倍率：之后即便再走到速度指令，本句仍按这个倍率计时。
    const rate = baseVoiceRate;
    return ensureVoiceEntry(key, path, rate)
      .sound.duration()
      .then((ms) => ms / rate);
  };

  /**
   * 立即停止由 `voice` 播放的配音轨，用于切句或手动推进时中断语音。
   *
   * 与 `voice` 对称：名字无对应配音轨时静默忽略，不抛错，让缺轨的台词按其
   * 正常计时继续。只停配音轨，绝不停同名 `Audio` 变量正在播放的效果音。
   *
   * @param {string} name 变量名或文件路径（与 `voice` 同参）。
   */
  factory.stopVoice = (name) => {
    voiceSlots.get(String(name ?? ""))?.retire();
  };

  return factory;
}
