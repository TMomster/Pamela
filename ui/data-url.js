// 把资源缓存交回的 `data:` URL 还原成字节。
// Pamela — inline asset bytes, without a network request.

/**
 * Reads the payload of a `data:<mime>;base64,…` URL.
 *
 * The webview CSP allows `data:` for `img-src` and `media-src` but not for
 * `connect-src`, so `fetch(dataUrl)` is refused there. Assets already arrive as
 * base64 strings, so decoding them here needs no fetch at all — and keeps the
 * call synchronous for callers that just want bytes.
 *
 * @param {string} url
 * @returns {Uint8Array}
 */
export function bytesFromDataUrl(url) {
  if (typeof atob !== "function") {
    throw new Error("当前环境无法解码 data: URL");
  }
  const match = /^data:[^,]*;base64,([A-Za-z0-9+/=\s]*)$/i.exec(String(url ?? ""));
  if (!match) {
    throw new Error("资源不是 base64 的 data: URL");
  }
  const binary = atob(match[1].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/**
 * The same bytes as a standalone `ArrayBuffer`, which is what
 * `AudioContext.decodeAudioData` wants (it detaches the buffer it is given).
 *
 * @param {string} url
 * @returns {ArrayBuffer}
 */
export function arrayBufferFromDataUrl(url) {
  return bytesFromDataUrl(url).buffer;
}
