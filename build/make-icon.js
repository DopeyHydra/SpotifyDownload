// Erzeugt build/icon.ico (grüner Kreis mit Download-Pfeil) ohne externe Abhängigkeiten.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Abstand eines Punkts zu einer Strecke
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function renderPng(size) {
  const SS = 4; // Supersampling für Kantenglättung
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const green = [29, 185, 84];
  const ink = [17, 17, 17];
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let cov = 0, inkCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Koordinaten auf 0..24 normiert (wie das SVG-Favicon)
          const u = ((x + (sx + 0.5) / SS) / size) * 24;
          const v = ((y + (sy + 0.5) / SS) / size) * 24;
          if (Math.hypot(u - 12, v - 12) <= 11.2) {
            cov++;
            const w = 1.25;
            const onArrow =
              segDist(u, v, 12, 5.5, 12, 14) <= w ||
              segDist(u, v, 12, 14, 8.3, 10.3) <= w ||
              segDist(u, v, 12, 14, 15.7, 10.3) <= w ||
              segDist(u, v, 7, 18, 17, 18) <= w;
            if (onArrow) inkCov++;
          }
        }
      }
      const a = cov / (SS * SS);
      const m = cov ? inkCov / cov : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(green[i] * (1 - m) + ink[i] * m);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [256, 64, 48, 32, 16];
const pngs = sizes.map(renderPng);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // Farbebenen
  e.writeUInt16LE(32, 6); // Bit pro Pixel
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, Buffer.concat([header, ...dir, ...pngs]));
fs.writeFileSync(path.join(__dirname, 'icon-256.png'), pngs[0]);
console.log('Icon erstellt:', out);
