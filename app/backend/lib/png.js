'use strict';
/* Tiny PNG encoder (RGB, no filtering) + helper to render simple
   "architecture diagram" images for READMEs. Zero dependencies. */

const zlib = require('node:zlib');
const { crc32 } = require('./zip');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>[number,number,number]} pixel
 * @returns {Buffer} PNG file bytes
 */
function encodePNG(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[p++] = r & 0xff;
      raw[p++] = g & 0xff;
      raw[p++] = b & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BLOCK_COLORS = [
  [0x00, 0xe5, 0xff],
  [0x29, 0x79, 0xff],
  [0xa8, 0x55, 0xf7],
  [0xff, 0x38, 0x98],
  [0x76, 0xff, 0x03],
];

/**
 * Renders a stacked-block diagram of the transformer so generated READMEs
 * show the *actual* layer stack of the generated model.
 */
function renderArchitectureDiagram(layers) {
  const width = 720;
  const rowH = 46;
  const height = layers.length * rowH + 40;
  const bg = [6, 10, 18];

  return encodePNG(width, height, (x, y) => {
    if (x < 24 || x > width - 24) return bg;
    const idx = Math.floor((y - 20) / rowH);
    if (idx < 0 || idx >= layers.length) return bg;
    const inRow = (y - 20) - idx * rowH;
    if (inRow > rowH - 10) return bg;

    const layer = layers[idx];
    const color = BLOCK_COLORS[layer.kind === 'embed' ? 0 : layer.kind === 'head' ? 4 : 1 + (idx % 3)];
    const pad = 60 + (layer.indent || 0) * 28;
    if (x < pad || x > width - pad) return bg;

    // rounded rect fill with a subtle vertical gradient + border
    const edge = x < pad + 3 || x > width - pad - 3 || inRow < 3 || inRow > rowH - 13;
    if (edge) return color.map((c) => Math.min(255, c + 40));
    const t = inRow / (rowH - 10);
    const scale = 0.35 + 0.35 * (1 - t) + (layer.width || 0.25) * 0.5;
    return color.map((c, i) => Math.round(bg[i] + (c - bg[i]) * Math.min(1, scale)));
  });
}

module.exports = { encodePNG, renderArchitectureDiagram };
