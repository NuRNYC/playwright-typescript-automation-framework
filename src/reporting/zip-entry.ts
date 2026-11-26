/**
 * Minimal single-entry ZIP reader (ADR-0010, M8E-4).
 *
 *   readSingleEntry(bytes) -> ZipEntryResult
 *
 * Reads the one `quality-summary.json` from a downloaded artifact archive,
 * in memory, and nothing else. This is deliberately NOT a general ZIP
 * implementation: it accepts exactly the narrow layout below and rejects
 * everything else. Nothing is ever written to the filesystem.
 *
 * Accepted layout, byte for byte, with no gaps, prefix or trailing data:
 *
 *   [local file header][name][extra][data][optional data descriptor]
 *   [central directory header][name][extra]
 *   [end of central directory record, no comment]
 *
 * Rules (any violation is a rejection):
 *
 * - Exactly one entry, named exactly `quality-summary.json` (so no
 *   directories, no traversal, no absolute or backslash paths).
 * - Single disk; no ZIP64 (no 0xFFFF/0xFFFFFFFF sentinels, no ZIP64 extra
 *   field, no ZIP64 end-of-central-directory locator); no archive or entry
 *   comment.
 * - No encryption (traditional, strong or AES); only general-purpose flag
 *   bits 1, 2 (deflate options), 3 (data descriptor) and 11 (UTF-8 names).
 * - Compression method 0 (stored) or 8 (deflate) only.
 * - A Unix-made entry must be a regular file (no symlink, device, FIFO or
 *   directory mode); an MS-DOS directory attribute is rejected.
 * - Local and central headers must agree on version, flags, method, name,
 *   CRC-32 and sizes (or the local header defers to a data descriptor that
 *   then agrees).
 * - Declared uncompressed size at most `MAX_ENTRY_BYTES` (5 MiB, the M8A
 *   summary limit); compression ratio at most `MAX_RATIO`; deflate output
 *   bounded to the declared size and the deflate stream must consume exactly
 *   the declared compressed bytes.
 * - CRC-32 and both lengths are verified on the decompressed bytes, which
 *   must then be valid UTF-8.
 *
 * Uses only `node:zlib` (raw inflate, bounded) and pure code; no filesystem,
 * network, clock or environment. Kept free of `@/` imports so Node's
 * type-stripping test runner can load it directly (ADR-0002).
 */
import { inflateRawSync } from 'node:zlib';

/** The only entry name accepted. */
export const ENTRY_NAME = 'quality-summary.json';

/** Largest archive accepted (compressed), matching the transport download cap. */
export const MAX_ARCHIVE_BYTES = 6 * 1024 * 1024;

/** Largest decompressed entry accepted: the M8A summary limit. */
export const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

/** Largest accepted uncompressed/compressed ratio; above this is a suspected bomb. */
export const MAX_RATIO = 200;

/**
 * Fixed outcomes; never contain archive bytes, names or offsets.
 *
 * - `ok`: exactly one valid `quality-summary.json`; `text` is its UTF-8 content.
 * - `unexpected-entries`: well-formed enough to read the directory, but not
 *   exactly one regular file with the expected name.
 * - `too-large`: archive, declared entry size or ratio over the limits.
 * - `malformed`: anything structurally invalid, unsupported or inconsistent.
 */
export type ZipEntryResult =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'unexpected-entries' | 'too-large' | 'malformed' };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;

const LOCAL_LEN = 30;
const CENTRAL_LEN = 46;
const EOCD_LEN = 22;
const ZIP64_LOCATOR_LEN = 20;

const FLAG_DESCRIPTOR = 1 << 3;
const FLAG_UTF8 = 1 << 11;
const ALLOWED_FLAGS = (1 << 1) | (1 << 2) | FLAG_DESCRIPTOR | FLAG_UTF8;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Highest "version needed to extract" accepted: 2.0 (deflate, no ZIP64). */
const MAX_VERSION_NEEDED = 20;

const HOST_MSDOS = 0;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;

/** Extra-field ids that signal ZIP64 or encryption; any of them is rejected. */
const FORBIDDEN_EXTRA_IDS: ReadonlySet<number> = new Set([
  0x0001, // ZIP64 extended information
  0x0017, // strong encryption header
  0x9901, // WinZip AES encryption
]);

const EXPECTED_NAME = new TextEncoder().encode(ENTRY_NAME);

/* ------------------------------------------------------------------ *
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320)
 * ------------------------------------------------------------------ */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `bytes`, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * Parsing helpers
 * ------------------------------------------------------------------ */

class Reject extends Error {
  readonly status: 'unexpected-entries' | 'too-large' | 'malformed';
  constructor(status: 'unexpected-entries' | 'too-large' | 'malformed') {
    super(status);
    this.status = status;
  }
}

function fail(status: 'unexpected-entries' | 'too-large' | 'malformed' = 'malformed'): never {
  throw new Reject(status);
}

/** Bounds-checked little-endian reader over the archive. */
class Reader {
  readonly view: DataView;
  readonly length: number;
  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
  }
  check(offset: number, size: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > this.length) {
      fail();
    }
  }
  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, true);
  }
  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, true);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Walks an extra field; it must be exactly a sequence of well-formed, allowed records. */
function checkExtra(reader: Reader, start: number, length: number): void {
  let offset = start;
  const end = start + length;
  while (offset < end) {
    if (end - offset < 4) fail();
    const id = reader.u16(offset);
    const size = reader.u16(offset + 2);
    if (FORBIDDEN_EXTRA_IDS.has(id)) fail();
    offset += 4 + size;
    if (offset > end) fail();
  }
}

function checkFlagsAndMethod(flags: number, method: number, versionNeeded: number): void {
  // Bit 0 (encrypted) and bit 6 (strong encryption) fall outside ALLOWED_FLAGS.
  if ((flags & ~ALLOWED_FLAGS) !== 0) fail();
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) fail();
  if (versionNeeded > MAX_VERSION_NEEDED) fail();
}

interface Central {
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly name: Uint8Array;
}

/* ------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------ */

function parseEocd(reader: Reader): { cdOffset: number; cdSize: number } {
  if (reader.length < LOCAL_LEN + CENTRAL_LEN + EOCD_LEN) fail();
  const at = reader.length - EOCD_LEN;
  if (reader.u32(at) !== SIG_EOCD) fail(); // Also rejects any archive comment.
  const disk = reader.u16(at + 4);
  const cdDisk = reader.u16(at + 6);
  const entriesOnDisk = reader.u16(at + 8);
  const entriesTotal = reader.u16(at + 10);
  const cdSize = reader.u32(at + 12);
  const cdOffset = reader.u32(at + 16);
  const commentLength = reader.u16(at + 20);
  if (commentLength !== 0) fail();
  if (
    disk === 0xffff ||
    cdDisk === 0xffff ||
    entriesOnDisk === 0xffff ||
    entriesTotal === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    fail(); // ZIP64 sentinels.
  }
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== entriesTotal) fail();
  if (at >= ZIP64_LOCATOR_LEN && reader.u32(at - ZIP64_LOCATOR_LEN) === SIG_ZIP64_LOCATOR) fail();
  // The central directory must end exactly where the EOCD record begins.
  if (cdOffset + cdSize !== at) fail();
  if (entriesTotal !== 1) fail(entriesTotal === 0 ? 'malformed' : 'unexpected-entries');
  return { cdOffset, cdSize };
}

function parseCentral(reader: Reader, cdOffset: number, cdSize: number): Central {
  const at = cdOffset;
  if (reader.u32(at) !== SIG_CENTRAL) fail();
  const madeBy = reader.u16(at + 4);
  const versionNeeded = reader.u16(at + 6);
  const flags = reader.u16(at + 8);
  const method = reader.u16(at + 10);
  const crc = reader.u32(at + 16);
  const compressedSize = reader.u32(at + 20);
  const uncompressedSize = reader.u32(at + 24);
  const nameLength = reader.u16(at + 28);
  const extraLength = reader.u16(at + 30);
  const commentLength = reader.u16(at + 32);
  const diskStart = reader.u16(at + 34);
  const externalAttributes = reader.u32(at + 38);
  const localOffset = reader.u32(at + 42);

  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) fail(); // ZIP64
  if (localOffset === 0xffffffff || diskStart === 0xffff) fail();
  if (commentLength !== 0 || diskStart !== 0) fail();
  // The single entry is the first thing in the file: no prefixed data.
  if (localOffset !== 0) fail();
  // The central directory holds exactly this one header.
  if (CENTRAL_LEN + nameLength + extraLength !== cdSize) fail();
  checkFlagsAndMethod(flags, method, versionNeeded);

  reader.check(at + CENTRAL_LEN, nameLength + extraLength);
  const name = new Uint8Array(
    reader.view.buffer,
    reader.view.byteOffset + at + CENTRAL_LEN,
    nameLength,
  );
  checkExtra(reader, at + CENTRAL_LEN + nameLength, extraLength);

  // Type checks: only a regular file is an expected entry.
  const host = madeBy >>> 8;
  if (host === HOST_UNIX) {
    const mode = externalAttributes >>> 16;
    const type = mode & S_IFMT;
    if (type !== 0 && type !== S_IFREG) fail('unexpected-entries');
  }
  if ((host === HOST_MSDOS || host === HOST_UNIX) && (externalAttributes & DOS_DIRECTORY) !== 0) {
    fail('unexpected-entries');
  }
  if (!sameBytes(name, EXPECTED_NAME)) fail('unexpected-entries');

  return { versionNeeded, flags, method, crc, compressedSize, uncompressedSize, name };
}

/** Validates the local header and returns where the entry data starts. */
function parseLocal(reader: Reader, central: Central, cdOffset: number): number {
  if (reader.u32(0) !== SIG_LOCAL) fail();
  const versionNeeded = reader.u16(4);
  const flags = reader.u16(6);
  const method = reader.u16(8);
  const crc = reader.u32(14);
  const compressedSize = reader.u32(18);
  const uncompressedSize = reader.u32(22);
  const nameLength = reader.u16(26);
  const extraLength = reader.u16(28);

  if (versionNeeded !== central.versionNeeded || flags !== central.flags) fail();
  if (method !== central.method) fail();
  reader.check(LOCAL_LEN, nameLength + extraLength);
  const name = new Uint8Array(reader.view.buffer, reader.view.byteOffset + LOCAL_LEN, nameLength);
  if (!sameBytes(name, central.name)) fail();
  checkExtra(reader, LOCAL_LEN + nameLength, extraLength);

  const dataStart = LOCAL_LEN + nameLength + extraLength;
  const dataEnd = dataStart + central.compressedSize;
  if (dataEnd > cdOffset) fail();

  if ((flags & FLAG_DESCRIPTOR) === 0) {
    if (
      crc !== central.crc ||
      compressedSize !== central.compressedSize ||
      uncompressedSize !== central.uncompressedSize
    ) {
      fail();
    }
    if (dataEnd !== cdOffset) fail(); // No bytes between the data and the directory.
    return dataStart;
  }

  // Deferred sizes: the local fields are zero (or already correct), and the
  // descriptor after the data must agree with the central directory.
  const deferredOk = (local: number, expected: number): boolean =>
    local === 0 || local === expected;
  if (
    !deferredOk(crc, central.crc) ||
    !deferredOk(compressedSize, central.compressedSize) ||
    !deferredOk(uncompressedSize, central.uncompressedSize)
  ) {
    fail();
  }
  let at = dataEnd;
  const remaining = cdOffset - at;
  if (remaining === 16 && reader.u32(at) === SIG_DESCRIPTOR) {
    at += 4;
  } else if (remaining !== 12) {
    fail();
  }
  if (
    reader.u32(at) !== central.crc ||
    reader.u32(at + 4) !== central.compressedSize ||
    reader.u32(at + 8) !== central.uncompressedSize
  ) {
    fail();
  }
  return dataStart;
}

function decompress(data: Uint8Array, central: Central): Uint8Array {
  if (central.method === METHOD_STORED) {
    if (central.compressedSize !== central.uncompressedSize) fail();
    return data;
  }
  if (central.uncompressedSize === 0) {
    // Only the canonical empty deflate stream is accepted.
    if (!(data.length === 2 && data[0] === 0x03 && data[1] === 0x00)) fail();
    return new Uint8Array(0);
  }
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateRawSync(data, {
      maxOutputLength: central.uncompressedSize,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch {
    // Truncated or corrupt stream, or output larger than declared.
    fail();
  }
  // The stream must end exactly at the declared compressed size.
  if (result.engine.bytesWritten !== data.length) fail();
  return new Uint8Array(result.buffer.buffer, result.buffer.byteOffset, result.buffer.byteLength);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Reads the single `quality-summary.json` from `bytes`. Never throws; never
 * touches the filesystem; the input is not modified.
 */
export function readSingleEntry(bytes: Uint8Array): ZipEntryResult {
  try {
    if (!(bytes instanceof Uint8Array)) return { status: 'malformed' };
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) return { status: 'too-large' };
    const reader = new Reader(bytes);
    const { cdOffset, cdSize } = parseEocd(reader);
    const central = parseCentral(reader, cdOffset, cdSize);

    if (central.uncompressedSize > MAX_ENTRY_BYTES) return { status: 'too-large' };
    if (central.uncompressedSize > Math.max(central.compressedSize, 1) * MAX_RATIO) {
      return { status: 'too-large' };
    }

    const dataStart = parseLocal(reader, central, cdOffset);
    const data = bytes.subarray(dataStart, dataStart + central.compressedSize);
    const content = decompress(data, central);
    if (content.byteLength !== central.uncompressedSize) fail();
    if (crc32(content) !== central.crc) fail();

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      fail();
    }
    return { status: 'ok', text };
  } catch (error) {
    return { status: error instanceof Reject ? error.status : 'malformed' };
  }
}
