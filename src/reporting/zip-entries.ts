/**
 * Bounded reader for a ZIP archive with an EXACT, allow-listed set of entries
 * (ADR-0013, Phase C5B).
 *
 *   readExactEntries(bytes, spec) -> ZipEntriesResult
 *
 * Used for artifacts that are not the single `quality-summary.json`: the
 * two-file `test-health-<attempt>` bundle and the one-file
 * `unit-results-<attempt>` archive. The existing single-entry reader
 * (`zip-entry.ts`, ADR-0010) and its contract are deliberately left
 * unchanged; this module applies the same rules to a fixed list of names
 * instead of one name. Its private helpers are not exported by that module,
 * so the structural checks are restated here rather than widening that
 * reviewed contract; `crc32` and the shared limits are reused.
 *
 * Accepted layout, byte for byte, with no gaps, prefix or trailing data:
 *
 *   [local header][name][extra][data][optional descriptor]   (one per entry,
 *   ...                                                         contiguous)
 *   [central header][name][extra]                             (one per entry,
 *   ...                                                         same order)
 *   [end of central directory record, no comment]
 *
 * Rules (any violation is a rejection, never a partial result):
 *
 * - Exactly `spec.names.length` entries whose names are exactly the
 *   allow-listed names, each once (no duplicates, no extra or missing names,
 *   no directories, no traversal, no absolute or backslash paths).
 * - Single disk; no ZIP64; no archive or entry comments.
 * - No encryption; only general-purpose flag bits 1, 2, 3 and 11.
 * - Compression method 0 (stored) or 8 (deflate) only.
 * - Unix-made entries must be regular files; no MS-DOS directory attribute.
 * - Local and central headers agree (or a data descriptor that then agrees).
 * - The archive is at most `MAX_ARCHIVE_BYTES`; each declared entry at most
 *   `spec.maxEntryBytes`; their sum at most `spec.maxTotalBytes`; each
 *   compression ratio at most `MAX_RATIO`. Deflate output is bounded to the
 *   declared size and must consume exactly the declared compressed bytes.
 * - CRC-32 and both lengths are verified; every entry must be valid UTF-8.
 *
 * Uses only `node:zlib` and pure code; no filesystem, network, clock or
 * environment. Outcomes are fixed codes and never contain archive bytes,
 * names or offsets. Free of `@/` imports (ADR-0002).
 */
import { inflateRawSync } from 'node:zlib';

import { MAX_ARCHIVE_BYTES, MAX_RATIO, crc32 } from './zip-entry.ts';

export interface ExactEntriesSpec {
  /** The exact entry names, each a plain file name. */
  readonly names: readonly string[];
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

/** The `test-health-<attempt>` artifact (ADR-0012 C3). */
export const HEALTH_BUNDLE_SPEC: ExactEntriesSpec = Object.freeze({
  names: Object.freeze(['test-health.json', 'test-health.md']),
  maxEntryBytes: 256 * 1024,
  maxTotalBytes: 512 * 1024,
});

/** The `unit-results-<attempt>` artifact (ADR-0012 C3; the C2 16 KiB limit). */
export const UNIT_RESULTS_SPEC: ExactEntriesSpec = Object.freeze({
  names: Object.freeze(['unit-results.stamped.json']),
  maxEntryBytes: 16 * 1024,
  maxTotalBytes: 16 * 1024,
});

export type ZipEntriesResult =
  | { readonly status: 'ok'; readonly entries: ReadonlyMap<string, string> }
  | { readonly status: 'unexpected-entries' | 'too-large' | 'malformed' | 'invalid-spec' };

type Failure = 'unexpected-entries' | 'too-large' | 'malformed';

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
const ALLOWED_FLAGS = (1 << 1) | (1 << 2) | FLAG_DESCRIPTOR | (1 << 11);
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const MAX_VERSION_NEEDED = 20;
const HOST_MSDOS = 0;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;
const FORBIDDEN_EXTRA_IDS: ReadonlySet<number> = new Set([0x0001, 0x0017, 0x9901]);
/** A plain file name: no separators, no traversal, printable ASCII only. */
const PLAIN_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const MAX_ENTRIES = 16;

class Reject extends Error {
  readonly status: Failure;
  constructor(status: Failure) {
    super(status);
    this.status = status;
  }
}

function fail(status: Failure = 'malformed'): never {
  throw new Reject(status);
}

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
  bytes(offset: number, size: number): Uint8Array {
    this.check(offset, size);
    return new Uint8Array(this.view.buffer, this.view.byteOffset + offset, size);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
  readonly localOffset: number;
}

function parseEocd(reader: Reader, expected: number): { cdOffset: number; cdSize: number } {
  if (reader.length < LOCAL_LEN + CENTRAL_LEN + EOCD_LEN) fail();
  const at = reader.length - EOCD_LEN;
  if (reader.u32(at) !== SIG_EOCD) fail();
  const disk = reader.u16(at + 4);
  const cdDisk = reader.u16(at + 6);
  const onDisk = reader.u16(at + 8);
  const total = reader.u16(at + 10);
  const cdSize = reader.u32(at + 12);
  const cdOffset = reader.u32(at + 16);
  if (reader.u16(at + 20) !== 0) fail();
  if (
    disk === 0xffff ||
    cdDisk === 0xffff ||
    onDisk === 0xffff ||
    total === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    fail();
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) fail();
  if (at >= ZIP64_LOCATOR_LEN && reader.u32(at - ZIP64_LOCATOR_LEN) === SIG_ZIP64_LOCATOR) fail();
  if (cdOffset + cdSize !== at) fail();
  if (total === 0) fail();
  if (total !== expected) fail('unexpected-entries');
  return { cdOffset, cdSize };
}

function parseCentral(reader: Reader, at: number): { central: Central; next: number } {
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
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) fail();
  if (localOffset === 0xffffffff || diskStart === 0xffff) fail();
  if (commentLength !== 0 || diskStart !== 0) fail();
  checkFlagsAndMethod(flags, method, versionNeeded);
  const name = reader.bytes(at + CENTRAL_LEN, nameLength);
  checkExtra(reader, at + CENTRAL_LEN + nameLength, extraLength);
  const host = madeBy >>> 8;
  if (host === HOST_UNIX) {
    const type = (externalAttributes >>> 16) & S_IFMT;
    if (type !== 0 && type !== S_IFREG) fail('unexpected-entries');
  }
  if ((host === HOST_MSDOS || host === HOST_UNIX) && (externalAttributes & DOS_DIRECTORY) !== 0) {
    fail('unexpected-entries');
  }
  return {
    central: {
      versionNeeded,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      name,
      localOffset,
    },
    next: at + CENTRAL_LEN + nameLength + extraLength,
  };
}

/** Validates one local header; returns where its data starts and where the entry ends. */
function parseLocal(reader: Reader, central: Central, boundary: number): number {
  const at = central.localOffset;
  if (reader.u32(at) !== SIG_LOCAL) fail();
  const versionNeeded = reader.u16(at + 4);
  const flags = reader.u16(at + 6);
  const method = reader.u16(at + 8);
  const crc = reader.u32(at + 14);
  const compressedSize = reader.u32(at + 18);
  const uncompressedSize = reader.u32(at + 22);
  const nameLength = reader.u16(at + 26);
  const extraLength = reader.u16(at + 28);
  if (versionNeeded !== central.versionNeeded || flags !== central.flags) fail();
  if (method !== central.method) fail();
  if (!sameBytes(reader.bytes(at + LOCAL_LEN, nameLength), central.name)) fail();
  checkExtra(reader, at + LOCAL_LEN + nameLength, extraLength);
  const dataStart = at + LOCAL_LEN + nameLength + extraLength;
  const dataEnd = dataStart + central.compressedSize;
  if (dataEnd > boundary) fail();
  if ((flags & FLAG_DESCRIPTOR) === 0) {
    if (
      crc !== central.crc ||
      compressedSize !== central.compressedSize ||
      uncompressedSize !== central.uncompressedSize
    ) {
      fail();
    }
    if (dataEnd !== boundary) fail();
    return dataStart;
  }
  const deferredOk = (local: number, expected: number): boolean =>
    local === 0 || local === expected;
  if (
    !deferredOk(crc, central.crc) ||
    !deferredOk(compressedSize, central.compressedSize) ||
    !deferredOk(uncompressedSize, central.uncompressedSize)
  ) {
    fail();
  }
  let d = dataEnd;
  const remaining = boundary - d;
  if (remaining === 16 && reader.u32(d) === SIG_DESCRIPTOR) d += 4;
  else if (remaining !== 12) fail();
  if (
    reader.u32(d) !== central.crc ||
    reader.u32(d + 4) !== central.compressedSize ||
    reader.u32(d + 8) !== central.uncompressedSize
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
    fail();
  }
  if (result.engine.bytesWritten !== data.length) fail();
  return new Uint8Array(result.buffer.buffer, result.buffer.byteOffset, result.buffer.byteLength);
}

function validSpec(spec: ExactEntriesSpec): boolean {
  const { names, maxEntryBytes, maxTotalBytes } = spec;
  return (
    Array.isArray(names) &&
    names.length >= 1 &&
    names.length <= MAX_ENTRIES &&
    new Set(names).size === names.length &&
    names.every((name) => typeof name === 'string' && PLAIN_NAME.test(name)) &&
    Number.isSafeInteger(maxEntryBytes) &&
    maxEntryBytes > 0 &&
    Number.isSafeInteger(maxTotalBytes) &&
    maxTotalBytes >= maxEntryBytes
  );
}

/**
 * Reads exactly the allow-listed entries from `bytes`. Never throws; never
 * touches the filesystem; the input is not modified.
 */
export function readExactEntries(bytes: Uint8Array, spec: ExactEntriesSpec): ZipEntriesResult {
  if (!validSpec(spec)) return { status: 'invalid-spec' };
  try {
    if (!(bytes instanceof Uint8Array)) return { status: 'malformed' };
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) return { status: 'too-large' };
    const reader = new Reader(bytes);
    const { cdOffset, cdSize } = parseEocd(reader, spec.names.length);

    const encoder = new TextEncoder();
    const allowed = new Map(spec.names.map((name) => [name, encoder.encode(name)]));
    const centrals: { name: string; central: Central }[] = [];
    let at = cdOffset;
    for (let i = 0; i < spec.names.length; i++) {
      const { central, next } = parseCentral(reader, at);
      at = next;
      const match = [...allowed].find(([, encoded]) => sameBytes(encoded, central.name));
      if (match === undefined) fail('unexpected-entries'); // unknown or duplicate name
      allowed.delete(match[0]);
      centrals.push({ name: match[0], central });
    }
    if (at !== cdOffset + cdSize) fail();

    // Sizes are checked from the directory before any byte is inflated.
    let total = 0;
    for (const { central } of centrals) {
      if (central.uncompressedSize > spec.maxEntryBytes) return { status: 'too-large' };
      if (central.uncompressedSize > Math.max(central.compressedSize, 1) * MAX_RATIO) {
        return { status: 'too-large' };
      }
      total += central.uncompressedSize;
    }
    if (total > spec.maxTotalBytes) return { status: 'too-large' };

    // Local entries are contiguous, in directory order, from offset 0.
    const entries = new Map<string, string>();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (let i = 0; i < centrals.length; i++) {
      const current = centrals[i];
      if (current === undefined) fail();
      const expectedOffset = i === 0 ? 0 : undefined;
      if (expectedOffset !== undefined && current.central.localOffset !== expectedOffset) fail();
      const boundary = centrals[i + 1]?.central.localOffset ?? cdOffset;
      if (boundary <= current.central.localOffset) fail();
      const dataStart = parseLocal(reader, current.central, boundary);
      const content = decompress(
        bytes.subarray(dataStart, dataStart + current.central.compressedSize),
        current.central,
      );
      if (content.byteLength !== current.central.uncompressedSize) fail();
      if (crc32(content) !== current.central.crc) fail();
      let text: string;
      try {
        text = decoder.decode(content);
      } catch {
        fail();
      }
      entries.set(current.name, text);
    }
    return { status: 'ok', entries };
  } catch (error) {
    return { status: error instanceof Reject ? error.status : 'malformed' };
  }
}
