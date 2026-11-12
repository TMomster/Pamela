// 生成多尺寸 Pamela 程序图标（白色花瓣与黑色花心）。
// Generate a multi-size Pamela program icon (white petals with a black core).
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SIZES = [16, 32, 48, 64, 128, 256];

function petalHit(dx, dy, dist, long, short) {
  for (let k = 0; k < 8; k += 1) {
    const ang = (Math.PI / 4) * k;
    const u = dx * Math.cos(ang) + dy * Math.sin(ang);
    const v = -dx * Math.sin(ang) + dy * Math.cos(ang);
    const eu = (u - dist) / long;
    const ev = v / short;
    if (eu * eu + ev * ev <= 1) return true;
  }
  return false;
}

function makePixels(size) {
  const cx = size / 2;
  const cy = size / 2;
  const coreR = (size * 39.5) / 256;
  const dist = size * 0.30;
  const long = size * 0.22;
  const short = size * 0.12;
  const olong = long + size * 0.02;
  const oshort = short + size * 0.02;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (dx * dx + dy * dy <= coreR * coreR) {
        r = g = b = 0;
        a = 255;
      } else if (petalHit(dx, dy, dist, olong, oshort)) {
        if (petalHit(dx, dy, dist, long, short)) {
          r = g = b = 255;
        } else {
          r = g = b = 120;
        }
        a = 255;
      }
      const idx = (y * size + x) * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = a;
    }
  }
  return buf;
}

function bmpData(px, size) {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8); // ICO convention: doubled height
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(size * size * 4, 20);
  const rows = Buffer.alloc(size * size * 4);
  for (let y = size - 1; y >= 0; y -= 1) {
    px.copy(rows, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([hdr, rows]);
}

const imgs = SIZES.map((s) => bmpData(makePixels(s), s));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(SIZES.length, 4);
let body = Buffer.from(header);
let off = 6 + 16 * SIZES.length;
for (let i = 0; i < SIZES.length; i += 1) {
  const s = SIZES[i];
  const d = imgs[i];
  const e = Buffer.alloc(16);
  e.writeUInt8(s < 256 ? s : 0, 0);
  e.writeUInt8(s < 256 ? s : 0, 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(d.length, 8);
  e.writeUInt32LE(off, 12);
  body = Buffer.concat([body, e]);
  off += d.length;
}
for (const d of imgs) body = Buffer.concat([body, d]);

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "..", "icons", "icon.ico"), body);
console.error(`WROTE icons/icon.ico bytes=${body.length} sizes=${SIZES.join(",")}`);
