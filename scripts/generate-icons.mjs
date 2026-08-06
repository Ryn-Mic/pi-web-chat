// PWA icon generation script (no external dependencies)
// Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(OUT_DIR, { recursive: true });

// --- Minimal PNG encoder ---
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
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Icon drawing: dark background + π glyph ---
const BG = [10, 10, 10]; // #0a0a0a
const FG = [250, 250, 250]; // π color
const ACCENT = [96, 165, 250]; // accent dot at the bottom (#60a5fa)

function drawIcon(size, { paddingRatio, rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const radius = rounded ? size * 0.18 : 0;
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };
  const inRoundedRect = (x, y) => {
    if (!rounded) return true;
    const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
    const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const rect = (x0, y0, w, h, color) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++)
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++)
        if (x >= 0 && y >= 0 && x < size && y < size) set(x, y, color);
  };

  // Background
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (inRoundedRect(x, y)) set(x, y, BG);

  // π glyph (placed inside the safe zone)
  const p = size * paddingRatio; // padding
  const gw = size - p * 2; // glyph area width
  const gh = gw * 0.82; // glyph area height
  const gx = p;
  const gy = p + (size - p * 2 - gh) / 2;
  const stroke = gw * 0.16;

  // Top horizontal stroke
  rect(gx, gy, gw, stroke, FG);
  // Left leg
  rect(gx + gw * 0.18, gy, stroke, gh, FG);
  // Right leg
  rect(gx + gw - gw * 0.18 - stroke, gy, stroke, gh, FG);
  // Accent dot below the left leg
  rect(gx + gw * 0.18, gy + gh + stroke * 0.6, stroke, stroke, ACCENT);

  return px;
}

const icons = [
  { file: "pwa-192x192.png", size: 192, paddingRatio: 0.2, rounded: false },
  { file: "pwa-512x512.png", size: 512, paddingRatio: 0.2, rounded: false },
  // maskable: larger padding to keep the central 80% safe area, full background fill
  { file: "maskable-512x512.png", size: 512, paddingRatio: 0.32, rounded: false },
  // iOS home screen (opaque)
  { file: "apple-touch-icon.png", size: 180, paddingRatio: 0.2, rounded: false },
  // Favicon substitute
  { file: "favicon-64.png", size: 64, paddingRatio: 0.16, rounded: true },
];

for (const { file, size, paddingRatio, rounded } of icons) {
  writeFileSync(join(OUT_DIR, file), encodePNG(size, drawIcon(size, { paddingRatio, rounded })));
  console.log(`✓ public/${file}`);
}
