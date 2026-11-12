// 自动配音用的单位音效：由一句台词按字数决定播放次数（约两字一次），
// 每次播放一段固定的音效文件（DialogAutoVoice.mp3），播放速度可调节。
//
// Pamela — unit sound cue for `stage.autoVoice`.
//
// 实时演出（`createVoiceEffect`）与导出混音（`renderVoiceBuffer`）共用同一段
// 音效文件与同一套「次数 / 速度」规则，确保成片里听到的效果音与预览一致。

/** 自动配音使用的单位音效文件名。 */
export const AUTOVOICE_CLIP = "DialogAutoVoice.mp3";

/**
 * 单位音效在前端里的位置：随应用一起打包（`ui/` 就是前端产物目录），所以
 * **任何项目**都能取到它——自动配音是引擎自带的声音，不是项目资源。
 */
export const AUTOVOICE_CLIP_URL = new URL(
  `./sounds/${AUTOVOICE_CLIP}`,
  import.meta.url,
).href;

/** 已读到的单位音效字节；`null` 表示读失败（不再重试）。 */
let clipBytes = null;
/** 正在进行的读取，避免同一时刻重复取。 */
let clipPending = null;
/** 第一次失败的原因，只报一次，不给每句台词都刷一条错误。 */
let clipFailure = null;

/**
 * 读取单位音效的字节（同一个文件只读一次）。
 *
 * 用的是同源 `fetch`：资源随前端打包，和应用同一个源，CSP 的 `default-src
 * 'self'` 放行；不像项目资源那样是 `data:` URL（那个只能就地解 base64）。
 *
 * @param {{ onError?: (message: string) => void }} [options]
 * @returns {Promise<ArrayBuffer|null>} 取不到时返回 null。
 */
export function loadAutoVoiceClip({ onError = null } = {}) {
  if (clipBytes) {
    return Promise.resolve(clipBytes);
  }
  // 读失败过就不再重试：文件是随应用打包的，读不到就是真的没有，
  // 每句台词都去试一遍只会白白拖慢演出。
  if (clipFailure) {
    return Promise.resolve(null);
  }
  if (clipPending) {
    return clipPending;
  }
  clipPending = fetch(AUTOVOICE_CLIP_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    })
    .then((bytes) => {
      clipBytes = bytes;
      clipPending = null;
      return bytes;
    })
    .catch((error) => {
      clipPending = null;
      clipFailure = error instanceof Error ? error : new Error(String(error));
      onError?.(`自动配音音效加载失败：${clipFailure.message}`);
      return null;
    });
  return clipPending;
}

/** 默认播放速度：每秒钟播放次数（次/秒）。 */
export const AUTOVOICE_DEFAULT_SPEED = 10;

/** 播放速度可调范围。 */
export const AUTOVOICE_MIN_SPEED = 1;
export const AUTOVOICE_MAX_SPEED = 10;

/**
 * 把一段单位音效（原始字节）按次数 / 速度离屏渲染成整段效果音，供导出混音使用。
 *
 * @param {ArrayBuffer} clipBytes 单位音效的原始字节（MP3 等）。
 * @param {object} options
 * @param {number} options.count 播放次数（约 ceil(字数 / 2)）。
 * @param {number} [options.speed] 播放速度（次/秒），默认 10。
 * @param {number} [options.sampleRate]
 * @param {number} [options.channels]
 * @param {Function} [options.AudioContextClass] 注入 OfflineAudioContext 实现（测试用）。
 * @returns {Promise<AudioBuffer>}
 */
export async function renderVoiceBuffer(
  clipBytes,
  { count, speed = AUTOVOICE_DEFAULT_SPEED, sampleRate = 48_000, channels = 2, AudioContextClass } = {},
) {
  const Impl = AudioContextClass ?? globalThis.OfflineAudioContext;
  if (typeof Impl !== "function") {
    throw new Error("当前环境不支持 OfflineAudioContext");
  }
  // 先在一个临时上下文里解码，得到的 buffer 才能被同实现的其他上下文复用。
  const probe = new Impl(channels, 1, sampleRate);
  const decoded = await probe.decodeAudioData(
    clipBytes.slice ? clipBytes.slice(0) : clipBytes,
  );
  const clipSeconds = decoded.duration || 0;
  // 两次播放之间的间隔 = 1 / 速度（秒）：即「每秒 speed 次」。
  const gapSeconds = 1 / (speed || AUTOVOICE_DEFAULT_SPEED);
  const totalSeconds = (count - 1) * gapSeconds + clipSeconds + 0.05;
  const frames = Math.ceil(totalSeconds * sampleRate);
  const context = new Impl(channels, Math.max(1, frames), sampleRate);
  for (let i = 0; i < count; i += 1) {
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start(i * gapSeconds);
  }
  return context.startRendering();
}

/**
 * 创建一个自动配音效果音合成器（实时演出用）。
 *
 * 单位音效默认取引擎自带的那一段（`loadAutoVoiceClip`）；没有 Web Audio 或
 * 取不到音效时，`play` 退化为一个静默时长，让语句计时仍可正常进行。
 *
 * @param {object} [options]
 * @param {(options?: { onError?: (message: string) => void }) => Promise<ArrayBuffer|null>} [options.loadClip]
 *   加载单位音效字节，返回 ArrayBuffer；取不到时返回 null。
 * @param {(message: string) => void} [options.onError] 取音效失败时的报错通道。
 * @returns {{ play: (chars: number, speed?: number) => { duration: number, stop: () => void } }}
 */
export function createVoiceEffect({ loadClip = loadAutoVoiceClip, onError = null } = {}) {
  /** @type {AudioContext | null} */
  let context = null;
  /** 解码后的单位音效缓存，避免每句都重新解码。 */
  let cachedClip = null;
  let clipPending = null;

  const ensureContext = () => {
    if (context) {
      if (context.state === "suspended") {
        context.resume();
      }
      return context;
    }
    const Ctor =
      typeof window !== "undefined" &&
      (window.AudioContext || window.webkitAudioContext);
    if (typeof Ctor !== "function") {
      return null;
    }
    context = new Ctor();
    if (context.state === "suspended") {
      context.resume();
    }
    return context;
  };

  const clip = () => {
    if (cachedClip) {
      return Promise.resolve(cachedClip);
    }
    if (clipPending) {
      return clipPending;
    }
    clipPending = Promise.resolve()
      .then(() => (loadClip ? loadClip({ onError }) : null))
      .then((bytes) => {
        clipPending = null;
        if (!bytes) {
          cachedClip = null;
          return null;
        }
        const ctx = ensureContext();
        if (!ctx) {
          return null;
        }
        return ctx
          .decodeAudioData(bytes.slice ? bytes.slice(0) : bytes)
          .then((buffer) => {
            cachedClip = buffer;
            return cachedClip;
          });
      })
      .catch(() => {
        clipPending = null;
        return null;
      });
    return clipPending;
  };

  /**
   * 播放一段按字数决定的效果音。
   *
   * @param {number} chars 本句字数；次数约 ceil(chars / 2)，至少 1 次（每两字一次）。
   * @param {number} [speed] 播放速度（次/秒），默认 10，范围 1–10。
   * @returns {{ duration: number, stop: () => void }}
   *   duration 为整段效果音跨度（毫秒），stop 用于切句 / 手动推进时中断。
   */
  const play = (chars, speed = AUTOVOICE_DEFAULT_SPEED) => {
    const count = Math.max(1, Math.ceil((Number(chars) || 0) / 2));
    // 两次播放间隔 = 1 / 速度 秒；整段时长 = 次数 × 间隔。
    const rate = Number(speed) || AUTOVOICE_DEFAULT_SPEED;
    const gapSeconds = 1 / rate;
    const durationMs = count * (1000 / rate);
    const ctx = ensureContext();
    let stopped = false;
    const sources = [];
    const stop = () => {
      stopped = true;
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          /* 已自然结束 */
        }
      }
    };
    if (ctx && loadClip) {
      clip()
        .then((buffer) => {
          if (stopped || !buffer) {
            return;
          }
          const schedule = () => {
            for (let i = 0; i < count; i += 1) {
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(ctx.currentTime + i * gapSeconds);
              sources.push(source);
            }
          };
          // 上下文被浏览器挂起时（自动播放策略），先恢复再排片：挂起时
          // `currentTime` 不走，排进去的时间点永远到不了，声音就出不来。
          if (ctx.state === "suspended") {
            Promise.resolve(ctx.resume()).then(schedule, () => {});
          } else {
            schedule();
          }
        })
        .catch(() => {});
    }
    return { duration: durationMs, stop };
  };

  return { play, preload: () => clip() };
}
