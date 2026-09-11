'use strict';

/**
 * 零依赖图标生成器
 * 手写 PNG 编码（IHDR/IDAT/IEND + zlib），生成应用图标与托盘图标。
 * 用法：node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------- PNG 编码 ---------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba: Uint8Array，长度 = w*h*4 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前面加一个过滤字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy
      ? rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------- 绘制 ---------------------------- */

const hex = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const BG = hex('#1c1c21');
const RING = hex('#8b7cff');
const DOT = hex('#e8e8ee');

/** 圆角矩形 + 同心圆环 + 中心点 */
function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.22; // 圆角
  const ringOuter = size * 0.34;
  const ringWidth = size * 0.055;
  const inner = size * 0.13;
  const dot = size * 0.075;

  const inRounded = (x, y) => {
    const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
    const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
    return Math.hypot(dx, dy) <= radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (inRounded(x, y)) {
        [r, g, b] = BG;
        a = 255;

        const d = Math.hypot(x - c, y - c);

        // 外环
        if (Math.abs(d - ringOuter) <= ringWidth) {
          const t = 1 - Math.abs(d - ringOuter) / ringWidth;
          r = Math.round(r + (RING[0] - r) * t);
          g = Math.round(g + (RING[1] - g) * t);
          b = Math.round(b + (RING[2] - b) * t);
        }

        // 内环
        if (Math.abs(d - inner) <= ringWidth * 0.7) {
          const t = 1 - Math.abs(d - inner) / (ringWidth * 0.7);
          r = Math.round(r + (RING[0] - r) * t * 0.85);
          g = Math.round(g + (RING[1] - g) * t * 0.85);
          b = Math.round(b + (RING[2] - b) * t * 0.85);
        }

        // 中心点
        if (d <= dot) {
          const t = Math.min(1, (dot - d) / (dot * 0.5));
          r = Math.round(r + (DOT[0] - r) * t);
          g = Math.round(g + (DOT[1] - g) * t);
          b = Math.round(b + (DOT[2] - b) * t);
        }
      }

      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }

  return rgba;
}

/* ---------------------------- 输出 ---------------------------- */

const OUT_DIR = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon.png', size: 256 },
  { file: 'icon-512.png', size: 512 },
  { file: 'tray.png', size: 32 },
];

for (const t of targets) {
  const png = encodePng(t.size, t.size, draw(t.size));
  const file = path.join(OUT_DIR, t.file);
  fs.writeFileSync(file, png);
  console.log(`✅ ${t.file}  ${t.size}×${t.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
