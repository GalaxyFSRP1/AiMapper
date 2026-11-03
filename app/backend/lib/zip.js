'use strict';
/* Minimal, dependency-free ZIP writer.
   Supports STORE (0) and DEFLATE (8, via node:zlib) entries.
   Produces byte-exact archives validated by tests/unzip.js (see tests).

   Why not use a library? The whole point of this project is that it runs
   anywhere `node` runs with zero install step, so the helper primitives are
   implemented here and covered by tests.
*/

const zlib = require('node:zlib');

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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

class ZipBuilder {
  constructor(options = {}) {
    this.entries = [];
    this.compress = options.compress !== false;
    this.mtime = options.mtime || new Date('2026-01-01T00:00:00Z');
  }

  /**
   * @param {string} name path inside the archive
   * @param {string|Buffer|Uint8Array} data
   */
  add(name, data) {
    const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) throw new Error('zip: entry name required');
    if (clean.includes('..')) throw new Error(`zip: illegal entry path ${clean}`);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);

    let method = 0;
    let payload = raw;
    // Deflate only helps on text; keep already-compressed blobs stored so the
    // archive stays small to produce and fast to stream.
    const looksText = /\.(json|py|md|txt|yaml|yml|js|css|html|toml|cfg|ini|gitignore|c|h|jsonl|gitattributes)$/i.test(clean);
    if (this.compress && raw.length > 64 && looksText) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }

    this.entries.push({
      name: clean,
      method,
      crc: crc32(raw),
      compressedSize: payload.length,
      uncompressedSize: raw.length,
      payload,
    });
    return this;
  }

  addJSON(name, value) {
    return this.add(name, JSON.stringify(value, null, 2) + '\n');
  }

  /** @returns {Buffer} */
  build() {
    const { time, day } = dosDateTime(this.mtime);
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 flag
      local.writeUInt16LE(entry.method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(entry.crc, 14);
      local.writeUInt32LE(entry.compressedSize, 18);
      local.writeUInt32LE(entry.uncompressedSize, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      localParts.push(local, nameBuf, entry.payload);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x031e, 4); // made by: unix, zip 3.0
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(entry.method, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(day, 14);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.compressedSize, 20);
      central.writeUInt32LE(entry.uncompressedSize, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, 0644
      central.writeUInt32LE(offset, 42);
      centralParts.push(central, nameBuf);

      offset += local.length + nameBuf.length + entry.payload.length;
    }

    const centralBuf = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralBuf, end]);
  }
}

/** Read an archive produced by ZipBuilder (used by the test-suite). */
function readZip(buf) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('readZip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('readZip: bad central header');
    const method = buf.readUInt16LE(ptr + 10);
    const crc = buf.readUInt32LE(ptr + 16);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const payload = buf.slice(dataStart, dataStart + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(payload) : payload;
    if (crc32(raw) !== crc) throw new Error(`readZip: crc mismatch for ${name}`);
    entries.set(name, raw);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

module.exports = { ZipBuilder, readZip, crc32 };
