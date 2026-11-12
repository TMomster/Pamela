// 无外部依赖的 GIF89a 解码器。
// Pamela — a tiny, dependency-free GIF89a decoder.
// 数据流在结束标记前终止时按损坏处理。

import { bytesFromDataUrl } from "./data-url.js";

/**
 * Whether a path names a GIF the decoder should take over.
 *
 * @param {string} path A project-relative asset path.
 * @returns {boolean}
 */

export function isGifPath(path) {
  return /\.gif$/i.test(String(path ?? ""));
}

/**
 * Reads the bytes of the `data:` URL the asset cache handed back.
 *
 * An asset arrives as `data:<mime>;base64,…`. The shared decoder in
 * `data-url.js` decodes that payload without a `fetch(data:)` request: the
 * webview's CSP has no `connect-src` allowing `data:`, so a refused fetch
 * would leave the GIF with no bytes to draw. Keeping it synchronous also keeps
 * it out of the promise chain that decides when a picture is ready to be shown.
 *
 * @param {string} url
 * @returns {Uint8Array}
 */
export function gifBytesFromDataUrl(url) {
  return bytesFromDataUrl(url);
}

/**
 * Decodes a GIF into its composited frames.
 *
 * @param {ArrayBuffer | Uint8Array} input The file bytes.
 * @returns {{ width: number, height: number,
 *   frames: Array<{ rgba: Uint8ClampedArray, delay: number,
 *     left: number, top: number, width: number, height: number,
 *     disposal: number, transparent: number }> }}
 *   `rgba` is a screen-sized RGBA buffer (length `width * height * 4`) ready for
 *   `putImageData`. `delay` is milliseconds; a missing or tiny delay falls back
 *   to 100ms, the way browsers honour a GIF that forgot to say.
 */
export function decodeGif(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {
    throw new Error("不是有效的 GIF 文件");
  }

  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 0x07);

  let pos = 13;
  let gct = null;
  if (gctFlag) {
    gct = readColorTable(bytes, pos, gctSize);
    pos += gctSize * 3;
  }

  const raw = [];
  // 待应用的图形控制块，作用于下一帧图像。
  let pending = null;

  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) {
      // 读到 GIF 尾部标记，解析结束。
      break;
    }
    if (block === 0x21) {
      // extension
      const label = bytes[pos++];
      if (label === 0xf9) {
        // graphics control extension
        const size = bytes[pos++];
        const flags = bytes[pos];
        const delay = bytes[pos + 1] | (bytes[pos + 2] << 8);
        const transparent = bytes[pos + 3];
        pos += size;
        pending = {
          disposal: (flags >> 2) & 0x07,
          transparent: (flags & 0x01) ? transparent : -1,
          delay: delay > 0 ? delay * 10 : 100,
        };
        skipSubBlocks(bytes, pos);
        pos = nextBlock(bytes, pos);
      } else {
        skipSubBlocks(bytes, pos);
        pos = nextBlock(bytes, pos);
      }
      continue;
    }
    if (block === 0x2c) {
      // image descriptor
      const left = bytes[pos] | (bytes[pos + 1] << 8);
      const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
      const iw = bytes[pos + 4] | (bytes[pos + 5] << 8);
      const ih = bytes[pos + 6] | (bytes[pos + 7] << 8);
      const ipacked = bytes[pos + 8];
      pos += 9;
      const lctFlag = (ipacked & 0x80) !== 0;
      const interlace = (ipacked & 0x40) !== 0;
      const lctSize = 2 << (ipacked & 0x07);
      let lct = null;
      if (lctFlag) {
        lct = readColorTable(bytes, pos, lctSize);
        pos += lctSize * 3;
      }
      const minCode = bytes[pos++];
      const data = readSubBlocks(bytes, pos);
      pos = nextBlock(bytes, pos);

      const indices = lzwDecode(minCode, data);
      const table = lct || gct || [];
      const gce = pending || { disposal: 0, transparent: -1, delay: 100 };
      raw.push({
        indices,
        left,
        top,
        w: iw,
        h: ih,
        interlace,
        table,
        transparent: gce.transparent,
        disposal: gce.disposal,
        delay: gce.delay,
      });
      pending = null;
      continue;
    }
    // Unknown block: step past it.
    pos = nextBlock(bytes, pos);
  }

  return { width, height, frames: composeFrames(width, height, raw) };
}

/**
 * Applies a `step` call to a gif play state, mutating it.
 *
 * A positive frame (1-based) freezes on that frame and stops playback; zero,
 * `null`, `undefined` or any non-positive value resumes from wherever it was.
 *
 * The frame number wraps rather than clamps: a writer says "the 18th frame" of
 * an animation they think of as a loop, so a 16-frame gif answers its 2nd
 * frame instead of stopping dead on the last one — `((18 - 1) % 16) + 1`, the
 * same spot the loop would have reached had it kept playing.
 *
 * @param {{ frames: Array<unknown>, index: number, playing: boolean }} gif
 * @param {number | null | undefined} frame
 */
export function applyStep(gif, frame) {
  const n = Number(frame);
  if (Number.isFinite(n) && n > 0) {
    const count = gif.frames.length;
    const wanted = Math.floor(n) - 1;
    gif.index = count > 0 ? ((wanted % count) + count) % count : 0;
    gif.playing = false;
  } else {
    gif.playing = true;
  }
  return gif;
}

/**
 * Picks the frame a GIF shows at a given instant of virtual time.
 *
 * Playback is a loop over the frames' own delays. A positive `freeze` is the
 * 1-based number a script gives `step()`; it stops the loop on that frame and
 * wraps the way `applyStep()` does. Returning an index (not a bitmap) keeps the
 * pure timing rule testable without a Canvas.
 *
 * @param {{ frames: Array<unknown>, delays?: number[], total?: number }} gif
 * @param {number} t milliseconds since the export started
 * @param {number} [freeze] 1-based frame number, or 0 for normal playback
 * @returns {number} frame index, or -1 when there is nothing to draw
 */
export function gifFrameAt(gif, t, freeze) {
  const frames = Array.isArray(gif?.frames) ? gif.frames : [];
  const count = frames.length;
  if (count === 0) {
    return -1;
  }
  const held = Number(freeze);
  if (Number.isFinite(held) && held > 0) {
    return (((Math.floor(held) - 1) % count) + count) % count;
  }
  const delays = Array.isArray(gif.delays) ? gif.delays : [];
  const span = (index) => {
    const value = Number(delays[index] ?? frames[index]?.delay);
    return Number.isFinite(value) && value > 0 ? value : 100;
  };
  let total = Number(gif.total);
  if (!Number.isFinite(total) || total <= 0) {
    total = 0;
    for (let index = 0; index < count; index += 1) {
      total += span(index);
    }
  }
  let left = (((Number(t) || 0) % total) + total) % total;
  for (let index = 0; index < count; index += 1) {
    left -= span(index);
    if (left < 0) {
      return index;
    }
  }
  return count - 1;
}

// --- internals ---

/** Reads `count` RGB triplets starting at `offset`. */
function readColorTable(bytes, offset, count) {
  const table = [];
  for (let i = 0; i < count; i += 1) {
    const o = offset + i * 3;
    table.push([bytes[o], bytes[o + 1], bytes[o + 2]]);
  }
  return table;
}

/** Strips sub-blocks (each a length byte followed by that many bytes), answering the offset just past them. */
function skipSubBlocks(bytes, offset) {
  let pos = offset;
  while (pos < bytes.length) {
    const size = bytes[pos++];
    if (size === 0) {
      return pos;
    }
    pos += size;
  }
  return pos;
}

/** Reads sub-block data into one flat byte array. */
function readSubBlocks(bytes, offset) {
  const out = [];
  let pos = offset;
  while (pos < bytes.length) {
    const size = bytes[pos++];
    if (size === 0) {
      break;
    }
    for (let i = 0; i < size; i += 1) {
      out.push(bytes[pos + i]);
    }
    pos += size;
  }
  return out;
}

/** Answers the offset of the block after whatever sub-blocks start at `offset`. */
function nextBlock(bytes, offset) {
  if (offset < bytes.length && bytes[offset] === 0) {
    return offset + 1;
  }
  return skipSubBlocks(bytes, offset);
}

/**
 * GIF LZW: variable-width codes packed LSB-first.
 *
 * `minCode` is the bits-per-pixel (at least 2). The code size grows by one bit
 * once the dictionary would need it — `nextCode === (1 << codeSize)` — which is
 * the convention GIF encoders use, so the reader stays in step with them.
 */
function lzwDecode(minCode, data) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let dict = [];
  let nextCode = eoi + 1;

  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i += 1) {
      dict.push([i]);
    }
    // 清除码使字典重置到初始状态。
    dict[clear] = undefined;
    // 结束码标记数据流终止。
    dict[eoi] = undefined;
    nextCode = eoi + 1;
    codeSize = minCode + 1;
  };
  reset();

  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let bytePos = 0;

  const readCode = () => {
    while (bitCount < codeSize) {
      if (bytePos >= data.length) {
        return eoi;
      }
      bitBuffer |= (data[bytePos++] & 0xff) << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  let prev = null;
  for (;;) {
    const code = readCode();
    if (code === eoi) {
      break;
    }
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    let entry;
    if (code < nextCode) {
      entry = dict[code];
    } else if (code === nextCode && prev) {
      entry = prev.concat(prev[0]);
    } else {
      // 数据流在结束标记前终止，按损坏处理。
      break;
    }
    for (let i = 0; i < entry.length; i += 1) {
      out.push(entry[i]);
    }
    if (prev !== null) {
      dict[nextCode] = prev.concat(entry[0]);
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) {
        codeSize += 1;
      }
    }
    prev = entry;
  }
  return out;
}

/** Composed pixels allowed for one animation: 32M ≈ 128 MB of RGBA. */
const MAX_GIF_PIXELS = 32 * 1024 * 1024;

/**
 * Composites raw frames into screen-sized RGBA buffers, honouring each frame's
 * disposal method and transparency, and un-interlacing when the image asked for
 * it. The returned `rgba` is a fresh copy per frame, so the stage can hold them
 * all and paint any one without recomputing.
 */
function composeFrames(screenW, screenH, raw) {
  // Each composed frame keeps a full RGBA copy. A large animation would hold
  // gigabytes before the first frame is shown.
  const pixels = screenW * screenH * Math.max(1, raw.length);
  if (pixels > MAX_GIF_PIXELS) {
    throw new Error(`GIF 过大（${screenW}×${screenH}，${raw.length} 帧），已停止解码`);
  }
  const frames = [];
  const full = new Uint8ClampedArray(screenW * screenH * 4); // starts fully transparent
  let saved = null;
  let prevDisposal = 0;
  let prevRect = null;

  for (const f of raw) {
    if (prevDisposal === 3 && saved) {
      full.set(saved);
    } else if (prevDisposal === 2 && prevRect) {
      clearRect(full, screenW, prevRect);
    }
    const before = full.slice();
    paintFrame(full, screenW, f);
    frames.push({
      rgba: full.slice(),
      delay: f.delay,
      left: f.left,
      top: f.top,
      width: f.w,
      height: f.h,
      disposal: f.disposal,
      transparent: f.transparent,
    });
    if (f.disposal === 3) {
      saved = before;
    }
    prevDisposal = f.disposal;
    prevRect = { left: f.left, top: f.top, w: f.w, h: f.h };
  }
  return frames;
}

function clearRect(full, screenW, rect) {
  const screenH = Math.floor(full.length / (screenW * 4));
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  for (let y = top; y < Math.min(screenH, rect.top + rect.h); y += 1) {
    for (let x = left; x < Math.min(screenW, rect.left + rect.w); x += 1) {
      const o = (y * screenW + x) * 4;
      full[o + 3] = 0;
    }
  }
}

function paintFrame(full, screenW, f) {
  const { indices, w, h, table, transparent, interlace } = f;
  const screenH = Math.floor(full.length / (screenW * 4));
  const rowOrder = interlace ? interlaceRows(h) : null;
  for (let row = 0; row < h; row += 1) {
    const y = rowOrder ? rowOrder[row] : row;
    for (let x = 0; x < w; x += 1) {
      const idx = indices[row * w + x];
      if (idx === transparent) {
        continue;
      }
      const color = table[idx];
      if (!color) {
        continue;
      }
      // A frame rect is not trusted to stay inside the logical screen: an
      // out-of-range pixel would wrap onto the next row.
      const px = f.left + x;
      const py = f.top + y;
      if (px < 0 || py < 0 || px >= screenW || py >= screenH) {
        continue;
      }
      const o = (py * screenW + px) * 4;
      full[o] = color[0];
      full[o + 1] = color[1];
      full[o + 2] = color[2];
      full[o + 3] = 255;
    }
  }
}

/** The four-pass row order an interlaced GIF stores its lines in. */
function interlaceRows(h) {
  const order = [];
  for (let y = 0; y < h; y += 8) order.push(y);
  for (let y = 4; y < h; y += 8) order.push(y);
  for (let y = 2; y < h; y += 4) order.push(y);
  for (let y = 1; y < h; y += 2) order.push(y);
  return order;
}
