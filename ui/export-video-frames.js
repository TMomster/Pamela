// 导出时的视频画面：一个不播放的 <video> 元素，靠 seek 停在某一刻。
// Pamela — video frames for the exported movie: pause the element, seek, draw.
//
// 逐帧导出没有实时播放可言：每帧要的是「素材第 N 秒」的那张图，而不是
// 「元素此刻恰好在哪」。所以这里让元素一直暂停，把 `currentTime` 设到目标
// 位置、等 `seeked`，再把元素交给 Canvas 的 drawImage。代价是每帧一次 seek，
// 视频段落会比纯图片慢；换来的是同一个时刻永远得到同一帧。
//
// 元素只读一次文件（`resolveVideo` 给 data: URL），之后按路径缓存。

/** seek 与加载的上限：超时就不再等，画当前帧继续导出，不把整部成片卡死。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * @param {object} options
 * @param {(path: string) => Promise<string>} options.resolveVideo 视频名 → data: URL
 * @param {() => HTMLVideoElement} [options.createElement] 测试注入
 * @param {number} [options.timeoutMs]
 */
export function createVideoFrames({
  resolveVideo,
  createElement = () => document.createElement("video"),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  /** 路径 → { element, width, height, duration } 的加载 Promise。 */
  const entries = new Map();

  /** 等一个媒体事件；超时或没有事件接口时按「可以继续」处理。 */
  function waitFor(element, name) {
    return new Promise((resolve, reject) => {
      if (typeof element.addEventListener !== "function") {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("视频无法解码"));
      };
      function cleanup() {
        clearTimeout(timer);
        element.removeEventListener?.(name, finish);
        element.removeEventListener?.("error", fail);
      }
      element.addEventListener(name, finish, { once: true });
      element.addEventListener("error", fail, { once: true });
    });
  }

  function load(path) {
    if (!entries.has(path)) {
      const promise = (async () => {
        const element = createElement();
        element.muted = true;
        element.playsInline = true;
        element.preload = "auto";
        const url = await resolveVideo(path);
        if (!url) {
          throw new Error(`无法加载视频：${path}`);
        }
        const ready = waitFor(element, "loadeddata");
        element.src = url;
        await ready;
        const width = Number(element.videoWidth) || 0;
        const height = Number(element.videoHeight) || 0;
        if (!(width > 0 && height > 0)) {
          throw new Error(`视频没有画面：${path}`);
        }
        return { element, width, height, duration: Number(element.duration) || 0 };
      })();
      entries.set(path, promise);
    }
    return entries.get(path);
  }

  return {
    load,
    /**
     * 让素材停在 `seconds`，返回可以 drawImage 的元素与它的尺寸。
     * 读不出来时抛错，由渲染后端跳过这一层。
     */
    async seek(path, seconds) {
      const entry = await load(path);
      const { element } = entry;
      const wanted = Math.max(0, Number(seconds) || 0);
      const limit = entry.duration > 0 ? Math.max(0, entry.duration - 0.001) : wanted;
      const target = Math.min(wanted, limit);
      if (Math.abs((Number(element.currentTime) || 0) - target) > 0.0005) {
        const seeked = waitFor(element, "seeked");
        element.currentTime = target;
        await seeked;
      }
      return entry;
    },
    /** 导出结束后释放元素，别让一串暂停的视频留在内存里。 */
    clear() {
      for (const promise of entries.values()) {
        Promise.resolve(promise)
          .then(({ element }) => {
            element.pause?.();
            element.removeAttribute?.("src");
            element.load?.();
          })
          .catch(() => {});
      }
      entries.clear();
    },
  };
}
