// GIF 解码器与步进逻辑测试。
// Pamela — GIF decoder and step logic.

import { applyStep, decodeGif, gifBytesFromDataUrl, gifFrameAt, isGifPath } from "../gif.js";
import assert from "node:assert";
import test from "node:test";

test("gifFrameAt loops by each frame's delay and honours a frozen step", () => {
  const gif = { frames: [{}, {}, {}], delays: [50, 100, 50], total: 200 };
  assert.equal(gifFrameAt(gif, 0), 0);
  assert.equal(gifFrameAt(gif, 49), 0);
  assert.equal(gifFrameAt(gif, 50), 1);
  assert.equal(gifFrameAt(gif, 149), 1);
  assert.equal(gifFrameAt(gif, 150), 2);
  assert.equal(gifFrameAt(gif, 200), 0);
  assert.equal(gifFrameAt(gif, -10), 2);
  assert.equal(gifFrameAt(gif, 999, 2), 1);
  assert.equal(gifFrameAt(gif, 0, 5), 1, "1-based step wraps over three frames");
  assert.equal(gifFrameAt(gif, 0, 0), 0);
  assert.equal(gifFrameAt({ frames: [] }, 0), -1);
  assert.equal(gifFrameAt({ frames: [{ delay: 10 }, { delay: 10 }] }, 15), 1);
});

/** Assembles a 2x2, four-colour GIF. `withGce` adds a graphics-control block. */
function buildGif(withGce) {
  const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
  const lsd = [0x02, 0x00, 0x02, 0x00, 0x81, 0x00, 0x00]; // 2x2, GCT of 4
  const gct = [
    0xff, 0x00, 0x00, // 0 red
    0x00, 0xff, 0x00, // 1 green
    0x00, 0x00, 0xff, // 2 blue
    0x00, 0x00, 0x00, // 3 black
  ];
  const gce = withGce
    ? [0x21, 0xf9, 0x04, 0x05, 0x05, 0x00, 0x03, 0x00] // disposal 1, delay 5 (50ms), transparent 3
    : [];
  const descriptor = [0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00];
  const data = [0x02, 0x03, 0x44, 0x34, 0x05, 0x00]; // minCode 2, one sub-block, trailer
  const trailer = [0x3b];
  return Uint8Array.from([...header, ...lsd, ...gct, ...gce, ...descriptor, ...data, ...trailer]);
}

function pixel(rgba, x, y, w = 2) {
  const o = (y * w + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}

test("decodeGif 还原 2x2 四色 GIF 的逐帧像素", () => {
  const gif = decodeGif(buildGif(false));
  assert.equal(gif.width, 2);
  assert.equal(gif.height, 2);
  assert.equal(gif.frames.length, 1);
  const rgba = gif.frames[0].rgba;
  assert.deepEqual(pixel(rgba, 0, 0), [255, 0, 0, 255], "左上红");
  assert.deepEqual(pixel(rgba, 1, 0), [0, 255, 0, 255], "右上绿");
  assert.deepEqual(pixel(rgba, 0, 1), [0, 0, 255, 255], "左下蓝");
  assert.deepEqual(pixel(rgba, 1, 1), [0, 0, 0, 255], "右下黑");
});

test("decodeGif 读取透明色与延迟", () => {
  const gif = decodeGif(buildGif(true));
  const frame = gif.frames[0];
  assert.equal(frame.delay, 50, "延迟按 1/100 秒换算成毫秒");
  assert.equal(frame.transparent, 3, "透明索引为 3");
  // 透明像素保持 alpha 0。
  assert.deepEqual(pixel(frame.rgba, 1, 1), [0, 0, 0, 0], "右下透明");
});

test("isGifPath 只认 .gif", () => {
  assert.ok(isGifPath("bg.gif"));
  assert.ok(isGifPath("assets/Character/a.GIF"));
  assert.ok(isGifPath("ori.si.gif"), "子目录的点号写法仍是 GIF");
  assert.equal(isGifPath("bg.png"), false);
  assert.equal(isGifPath(""), false);
});

test("gifBytesFromDataUrl 读回资源缓存内联的字节", () => {
  const bytes = buildGif(false);
  const url = `data:image/gif;base64,${Buffer.from(bytes).toString("base64")}`;
  assert.deepEqual(Array.from(gifBytesFromDataUrl(url)), Array.from(bytes));
});

test("gifBytesFromDataUrl 拒绝不是 base64 data: 的地址", () => {
  assert.throws(() => gifBytesFromDataUrl("assets/a.gif"), /base64/);
  assert.throws(() => gifBytesFromDataUrl("data:image/gif,abc"), /base64/);
});

test("applyStep 正数定格并停播", () => {
  const gif = { frames: [0, 1, 2], index: 0, playing: true };
  applyStep(gif, 3);
  assert.equal(gif.index, 2);
  assert.equal(gif.playing, false);
});

test("applyStep 超出帧数时按帧数取模", () => {
  const gif = { frames: [0, 1, 2], index: 0, playing: true };
  applyStep(gif, 4);
  assert.equal(gif.index, 0, "第 4 帧就是 3 帧里的第 1 帧");
  applyStep(gif, 99);
  assert.equal(gif.index, 2, "99 % 3 = 0 → 第 3 帧");
  applyStep(gif, 6);
  assert.equal(gif.index, 2, "整除时停在最后一帧");
});

test("applyStep 小数帧向下取整后再取模", () => {
  const gif = { frames: [0, 1, 2], index: 0, playing: true };
  applyStep(gif, 2.9);
  assert.equal(gif.index, 1);
});

test("applyStep 0 / 空 / 负 恢复播放", () => {
  const gif = { frames: [0, 1, 2], index: 1, playing: false };
  applyStep(gif, 0);
  assert.equal(gif.playing, true);
  assert.equal(gif.index, 1, "从当前帧继续");

  applyStep(gif, null);
  assert.equal(gif.playing, true);

  applyStep(gif, -4);
  assert.equal(gif.playing, true);
});
