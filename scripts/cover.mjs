// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-blue gradient, a
// projector seen from the front with its lens, and the light beam drawing a
// screen with a power symbol. Plain Node (zlib), no dependency.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [8, 14, 36];
const BLUE = [0, 70, 150];
const WHITE = [255, 255, 255];
const BODY = [235, 238, 245];
const LENS = [20, 30, 60];
const BEAM = [150, 200, 255];
const ACCENT = [80, 170, 255];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The colour of one pixel. */
function pixel(x, y) {
  let color = mix(DARK, BLUE, (x / WIDTH) * 0.4 + (y / HEIGHT) * 0.6);
  // The screen, top right: a pale frame with a power symbol.
  const screen = roundedBox(x, y, 545, 170, 200, 118, 6);
  color = mix(color, mix([40, 70, 120], [70, 110, 170], (x - 345) / 400), smooth(0, screen));
  color = mix(color, WHITE, smooth(3, Math.abs(screen)) * 0.9);
  const dx = x - 545;
  const dy = y - 172;
  const r = Math.hypot(dx, dy);
  const angle = Math.atan2(dx, -dy);
  const ring = smooth(8, Math.abs(r - 55)) * (Math.abs(angle) > 0.6 ? 1 : 0);
  const bar = smooth(8, Math.abs(dx)) * (dy > -78 && dy < -10 ? 1 : 0);
  color = mix(color, WHITE, Math.max(ring, bar));
  // The beam: a soft cone from the lens to the screen.
  const lx = 215;
  const ly = 395;
  if (x > lx && x < 345) {
    const t = (x - lx) / (345 - lx);
    const top = ly - t * (ly - 52);
    const bottom = ly + t * (288 - ly);
    if (y > top && y < bottom) {
      color = mix(color, BEAM, 0.18 * (1 - t * 0.5));
    }
  }
  // The projector: a white body, a dark lens ring, a blue lens.
  const body = roundedBox(x, y, 200, 410, 150, 52, 22);
  color = mix(color, BODY, smooth(0, body));
  const feet = Math.min(roundedBox(x, y, 100, 468, 18, 6, 4), roundedBox(x, y, 300, 468, 18, 6, 4));
  color = mix(color, BODY, smooth(0, feet));
  const lens = Math.hypot(x - lx, y - ly);
  color = mix(color, LENS, smooth(38, lens));
  color = mix(color, ACCENT, smooth(24, lens));
  color = mix(color, WHITE, smooth(6, Math.hypot(x - lx + 8, y - ly + 8)) * 0.8);
  // Vents and an indicator.
  for (let i = 0; i < 5; i += 1) {
    const vent = roundedBox(x, y, 110 + i * 14, 410, 3, 24, 3);
    color = mix(color, [190, 196, 210], smooth(0, vent));
  }
  color = mix(color, ACCENT, smooth(5, Math.hypot(x - 320, y - 385)));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
