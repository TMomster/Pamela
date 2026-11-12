// 用真实解释器跑入口脚本，把演出交给录制代理登记进时间线。
// Pamela — drives `run()` under the virtual clock for the MP4 export.
//
// 这是 `createExportSession` 的 `performance(session)` 实现：脚本照常执行，
// 所有计时走虚拟时钟，所有画面动作写进 `session.timeline`。

import { createRecordGlobals } from "./export-stage.js";
import { decodeGif, gifBytesFromDataUrl, isGifPath } from "./gif.js";
import { isMpePath, transpile } from "./mpe.js";
import { run } from "./pamela.js";

/** 与 `main.js` 的 `resolveScenePath` 同形：裸名补到 scripts/ 下。 */
export function resolveScenePath(asked) {
  const cleaned = String(asked ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return cleaned.includes("/") ? cleaned : "scripts/" + cleaned;
}

const IMAGE_IN_SOURCE = /["']([^"'\n]+\.(?:png|jpe?g|webp|gif|bmp))["']/gi;

/** 一帧 GIF 需要一个能 putImageData 的离屏画布；测试可注入其它实现。 */
function defaultCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * 把脚本里出现的图片预解码成位图，帧渲染时才能同步取用。
 * GIF 用 `gif.js` 解出全部帧与各自的 delay，渲染器按虚拟时间循环取帧；
 * 缺失或读不到的资源交给渲染器跳过，不阻断导出。
 */
export async function preloadAssets(source, invoke, assets, seen = new Set(), makeCanvas = defaultCanvas) {
  const names = [...String(source ?? "").matchAll(IMAGE_IN_SOURCE)].map((match) =>
    match[1].trim(),
  );
  await Promise.all(
    names.map(async (name) => {
      if (seen.has(name)) {
        return;
      }
      seen.add(name);
      try {
        const url = await invoke("read_asset", { path: name });
        if (isGifPath(name)) {
          try {
            const gif = decodeGif(gifBytesFromDataUrl(String(url)));
            const frames = gif.frames.map((frame) => {
              const canvas = makeCanvas(gif.width, gif.height);
              const ctx = canvas.getContext("2d");
              const data = ctx.createImageData(gif.width, gif.height);
              data.data.set(frame.rgba);
              ctx.putImageData(data, 0, 0);
              return canvas;
            });
            const delays = gif.frames.map((frame) => (frame.delay > 0 ? frame.delay : 100));
            assets.set(name, {
              kind: "gif",
              width: gif.width,
              height: gif.height,
              frames,
              delays,
              total: delays.reduce((sum, ms) => sum + ms, 0),
            });
            return;
          } catch {
            // 解码失败时回退到浏览器自带的首帧，与实时舞台的降级一致。
          }
        }
        const image = new Image();
        image.src = String(url);
        await image.decode();
        assets.set(name, image);
      } catch {
        // 资源缺失由渲染器跳过；脚本本身不因此失败。
      }
    }),
  );
}

/** 缓存已扫描过的名字，主脚本与 include 的子脚本可以共用同一个预加载器。 */
export function makePreloader(invoke, assets, makeCanvas) {
  const seen = new Set();
  return (source) => preloadAssets(source, invoke, assets, seen, makeCanvas);
}

/**
 * Every image a dialogue plate's layers can ask for, once, across both slots.
 *
 * A style file holds `styles.dialog` / `styles.narration`, but older files may
 * be a single style set on its own. Invisible layers are skipped: the painter
 * never draws them, so decoding them would only waste memory.
 *
 * @param {object} doc A style document, or null when no style could be read.
 * @returns {string[]}
 */
export function plateImageSources(doc) {
  if (!doc || typeof doc !== "object") {
    return [];
  }
  const sets = doc.styles ? Object.values(doc.styles) : [doc];
  const sources = new Set();
  for (const set of sets) {
    for (const layer of set?.layers ?? []) {
      if (layer?.type === "image" && layer.visible !== false && layer.source) {
        sources.add(String(layer.source));
      }
    }
  }
  return [...sources];
}

/**
 * Decodes the plate's images into the very same asset map the script uses.
 *
 * Layers address their bitmaps by `source`, and `draw()` looks them up in that
 * map, so a plate image is loaded exactly like a background or a character.
 * A missing file leaves that layer out, matching the stage's own behaviour.
 */
export async function preloadPlateImages(doc, invoke, assets) {
  await Promise.all(
    plateImageSources(doc).map(async (name) => {
      if (assets.has(name)) {
        return;
      }
      try {
        const url = await invoke("read_asset", { path: name });
        const image = new Image();
        image.src = String(url);
        await image.decode();
        assets.set(name, image);
      } catch {
        // The renderer skips layers whose bitmap is absent.
      }
    }),
  );
}

/**
 * @param {object} options
 * @param {string} options.source 入口脚本原文
 * @param {string} options.path 入口脚本的项目相对路径
 * @param {(path: string) => Promise<string>} options.read 读 include 的文件
 * @param {(source: string) => Promise<void>} [options.preload]
 * @param {(labels: string[]) => Promise<number>} [options.chooseStrategy]
 * @param {() => boolean} [options.isStopped]
 * @returns {(session: object) => Promise<object>} performance 回调
 */
export function createExportPerformance({
  source,
  path,
  read,
  preload = async () => {},
  chooseStrategy,
  isStopped,
  config,
}) {
  const scenes = new Map();
  const readScene = async (asked) => {
    const resolved = resolveScenePath(asked);
    if (!scenes.has(resolved)) {
      scenes.set(
        resolved,
        read(resolved).then(async (text) => {
          const raw = String(text ?? "");
          await preload(raw);
          return isMpePath(resolved) ? transpile(raw) : raw;
        }),
      );
    }
    return scenes.get(resolved);
  };

  return async (session) => {
    await preload(source);
    const program = isMpePath(path) ? transpile(source) : source;
    const result = await run(program, {
      globals: createRecordGlobals(session, { config }),
      sleep: (ms) => session.clock.wait(ms),
      choose:
        chooseStrategy ?? ((labels) => Promise.resolve(labels?.length ? 0 : -1)),
      readScene,
      useStyle: async () => {},
      source: path,
      stopped: () => Boolean(isStopped?.()),
      onNode: () => {},
      onChoice: () => {},
      onLive: () => {},
    });
    if (result?.error) {
      const where = result.error.line ? `第 ${result.error.line} 行：` : "";
      throw new Error(`脚本${where}${result.error.message}`);
    }
    return result;
  };
}
