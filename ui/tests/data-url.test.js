// `data:` URL 字节解码测试。
// The asset cache hands back base64 data URLs; the webview CSP forbids fetch(data:).

import assert from "node:assert/strict";
import test from "node:test";

import { arrayBufferFromDataUrl, bytesFromDataUrl } from "../data-url.js";

const inline = (mime, bytes) =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

test("bytesFromDataUrl reads back the exact asset bytes", () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 255, 0x47, 0x49, 0x46]);
  assert.deepEqual(
    Array.from(bytesFromDataUrl(inline("video/mp4", bytes))),
    Array.from(bytes),
  );
});

test("arrayBufferFromDataUrl hands decodeAudioData a standalone buffer", () => {
  const buffer = arrayBufferFromDataUrl(inline("audio/wav", Uint8Array.from([1, 2, 3, 4])));
  assert.ok(buffer instanceof ArrayBuffer);
  assert.equal(buffer.byteLength, 4);
  assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4]);
});

test("whitespace folded into the base64 payload does not change the bytes", () => {
  const bytes = Uint8Array.from([9, 8, 7, 6]);
  const encoded = Buffer.from(bytes).toString("base64");
  const url = `data:audio/mpeg;base64,${encoded.slice(0, 2)}\n ${encoded.slice(2)}`;
  assert.deepEqual(Array.from(bytesFromDataUrl(url)), [9, 8, 7, 6]);
});

test("a URL that is not base64 data is refused rather than silently emptied", () => {
  assert.throws(() => bytesFromDataUrl("assets/a.mp4"), /base64/);
  assert.throws(() => bytesFromDataUrl("data:video/mp4,raw"), /base64/);
  assert.throws(() => bytesFromDataUrl(null), /base64/);
});
