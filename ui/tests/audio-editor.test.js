// `ui/audio-editor.js` 纯逻辑测试：WAV 编码与采样处理。
// Tests for the pure logic in ui/audio-editor.js: WAV encoding and the sample

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encodeWav,
  wavToDataUrl,
  arrayBufferToBase64,
  applyGain,
  applyFade,
  resample,
  sliceSamples,
  concatSamples,
} from "../audio-editor.js";

test("encodeWav writes a valid 16-bit PCM header", () => {
  const data = new Float32Array([0, 0.5, -0.5, 1]);
  const buffer = encodeWav([data], 44100, 1);
  const view = new DataView(buffer);
  const text = (offset, len) =>
    String.fromCharCode(...new Uint8Array(buffer, offset, len));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(12, 4), "fmt ");
  assert.equal(text(36, 4), "data");
  // 16-bit mono: 4 samples => 8 bytes of data; total 44 + 8 = 52.
  assert.equal(buffer.byteLength, 52);
  // 0.5 * 0x7fff === 16383.
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 16383);
  assert.equal(view.getInt16(48, true), -16384);
  assert.equal(view.getInt16(50, true), 32767);
});

test("wavToDataUrl prefixes the WAV mime", () => {
  const data = new Float32Array([0]);
  const url = wavToDataUrl(encodeWav([data], 8000, 1));
  assert.ok(url.startsWith("data:audio/wav;base64,"));
});

test("arrayBufferToBase64 is reversible", () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const b64 = arrayBufferToBase64(bytes.buffer.slice(0, 4));
  assert.equal(Buffer.from(b64, "base64").toString("hex"), "010203fa");
});

test("applyGain multiplies every sample", () => {
  const s = new Float32Array([0.1, 0.2, -0.5]);
  const out = applyGain(s, 2);
  const approx = [...out].map((v) => Math.round(v * 1e6) / 1e6);
  assert.deepEqual(approx, [0.2, 0.4, -1]);
});

test("applyFade ramps in and out, holds in the middle", () => {
  const s = new Float32Array(20).fill(1);
  const out = applyFade(s, 10, 1, 0); // 1s fade-in at 10Hz, no fade-out
  assert.ok(Math.abs(out[0]) < 1e-6);
  assert.ok(Math.abs(out[5] - 0.5) < 1e-6);
  assert.equal(out[15], 1);
});

test("applyFade fades out at the end", () => {
  const s = new Float32Array(20).fill(1);
  const out = applyFade(s, 10, 0, 1); // no fade-in, 1s fade-out
  assert.equal(out[0], 1);
  assert.ok(Math.abs(out[19] - 0.1) < 1e-6);
});

test("resample halves length at ratio 2", () => {
  const s = new Float32Array([0, 1, 2, 3, 4]);
  const out = resample(s, 2);
  assert.equal(out.length, 3);
  assert.deepEqual([...out], [0, 2, 4]);
});

test("sliceSamples cuts by seconds", () => {
  const s = new Float32Array(100);
  for (let i = 0; i < 100; i += 1) s[i] = i;
  const out = sliceSamples(s, 1, 3, 10); // samples 10..30
  assert.equal(out.length, 20);
  assert.equal(out[0], 10);
  assert.equal(out[19], 29);
});

test("concatSamples joins two buffers", () => {
  const a = new Float32Array([1, 2]);
  const b = new Float32Array([3, 4]);
  assert.deepEqual([...concatSamples(a, b)], [1, 2, 3, 4]);
});
