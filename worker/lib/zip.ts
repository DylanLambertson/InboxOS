/**
 * Minimal store-only (uncompressed) ZIP writer. Emits each entry as soon as it
 * is added, so a large export can be streamed without holding the archive in
 * memory. No ZIP64: callers keep archives well under 4 GB and 65,535 entries.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE). Pass the previous result as `crc` to continue over another chunk. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** MS-DOS date/time as used by ZIP headers (local time fields, 2-second precision). */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const enc = new TextEncoder();
const UTF8_FLAG = 0x0800;

export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;

  /** Total bytes emitted so far. */
  get size(): number {
    return this.offset;
  }

  /** Local header followed by the file's bytes. */
  file(name: string, chunks: Uint8Array[], modified = new Date()): Uint8Array[] {
    let crc = 0;
    let size = 0;
    for (const ch of chunks) {
      crc = crc32(ch, crc);
      size += ch.length;
    }
    const nameBytes = enc.encode(name);
    const { time, date } = dosDateTime(modified);
    const h = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, UTF8_FLAG, true);
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    h.set(nameBytes, 30);
    this.entries.push({ name: nameBytes, crc, size, offset: this.offset, time, date });
    this.offset += h.length + size;
    return [h, ...chunks];
  }

  /** Central directory and end-of-central-directory record. */
  finish(): Uint8Array {
    const cdSize = this.entries.reduce((n, e) => n + 46 + e.name.length, 0);
    const out = new Uint8Array(cdSize + 22);
    const v = new DataView(out.buffer);
    let p = 0;
    for (const e of this.entries) {
      v.setUint32(p, 0x02014b50, true);
      v.setUint16(p + 4, 20, true);
      v.setUint16(p + 6, 20, true);
      v.setUint16(p + 8, UTF8_FLAG, true);
      v.setUint16(p + 10, 0, true);
      v.setUint16(p + 12, e.time, true);
      v.setUint16(p + 14, e.date, true);
      v.setUint32(p + 16, e.crc, true);
      v.setUint32(p + 20, e.size, true);
      v.setUint32(p + 24, e.size, true);
      v.setUint16(p + 28, e.name.length, true);
      // extra, comment, disk, internal attrs, external attrs: all zero
      v.setUint32(p + 42, e.offset, true);
      out.set(e.name, p + 46);
      p += 46 + e.name.length;
    }
    v.setUint32(p, 0x06054b50, true);
    v.setUint16(p + 8, this.entries.length, true);
    v.setUint16(p + 10, this.entries.length, true);
    v.setUint32(p + 12, cdSize, true);
    v.setUint32(p + 16, this.offset, true);
    this.offset += out.length;
    return out;
  }
}
