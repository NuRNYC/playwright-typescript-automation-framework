/**
 * Unit tests for the single-entry ZIP reader (ADR-0010, M8E-4).
 *
 * Same conventions as the other unit tests (ADR-0002). Every archive is
 * synthetic and built in memory by the small writer below; nothing is read
 * from or written to the filesystem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  ENTRY_NAME,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  MAX_RATIO,
  crc32,
  readSingleEntry,
} from './zip-entry.ts';

/* ------------------------------------------------------------------ *
 * Synthetic archive writer
 * ------------------------------------------------------------------ */

interface EntrySpec {
  name?: string;
  content?: Uint8Array;
  method?: 0 | 8;
  /** Compressed bytes to store instead of the real ones. */
  data?: Uint8Array;
  flags?: number;
  versionNeeded?: number;
  madeBy?: number;
  externalAttributes?: number;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  localExtra?: Uint8Array;
  centralExtra?: Uint8Array;
  /** Data descriptor after the data: 'signed' (with signature), 'unsigned' or none. */
  descriptor?: 'signed' | 'unsigned';
  /** Write zero CRC/sizes in the local header (streaming style). */
  zeroLocal?: boolean;
  localName?: string;
  localMethod?: number;
  centralComment?: Uint8Array;
}

interface ArchiveSpec {
  entries?: EntrySpec[];
  prefix?: Uint8Array;
  between?: Uint8Array;
  trailing?: Uint8Array;
  comment?: Uint8Array;
  entriesOverride?: number;
  zip64Locator?: boolean;
  cdOffsetDelta?: number;
}

const enc = new TextEncoder();
const VALID_JSON = '{"schemaVersion":"1.0.0","ok":true}';

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

function zip(spec: ArchiveSpec = {}): Uint8Array {
  const entries = spec.entries ?? [{}];
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = spec.prefix?.length ?? 0;
  for (const e of entries) {
    const content = e.content ?? enc.encode(VALID_JSON);
    const method = e.method ?? 8;
    const data = e.data ?? (method === 8 ? new Uint8Array(deflateRawSync(content)) : content);
    const name = enc.encode(e.name ?? ENTRY_NAME);
    const localName = e.localName === undefined ? name : enc.encode(e.localName);
    const flags = e.flags ?? (e.descriptor ? 1 << 3 : 0);
    const version = e.versionNeeded ?? 20;
    const crc = e.crc ?? crc32(content);
    const csize = e.compressedSize ?? data.length;
    const usize = e.uncompressedSize ?? content.length;
    const localExtra = e.localExtra ?? new Uint8Array(0);
    const centralExtra = e.centralExtra ?? new Uint8Array(0);
    const comment = e.centralComment ?? new Uint8Array(0);
    const zero = e.zeroLocal === true;
    const local = concat([
      u32(0x04034b50),
      u16(version),
      u16(flags),
      u16(e.localMethod ?? method),
      u16(0),
      u16(0),
      u32(zero ? 0 : crc),
      u32(zero ? 0 : csize),
      u32(zero ? 0 : usize),
      u16(localName.length),
      u16(localExtra.length),
      localName,
      localExtra,
      data,
      e.descriptor === 'signed'
        ? concat([u32(0x08074b50), u32(crc), u32(csize), u32(usize)])
        : e.descriptor === 'unsigned'
          ? concat([u32(crc), u32(csize), u32(usize)])
          : new Uint8Array(0),
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(e.madeBy ?? (3 << 8) | 20),
      u16(version),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(csize),
      u32(usize),
      u16(name.length),
      u16(centralExtra.length),
      u16(comment.length),
      u16(0),
      u16(0),
      u32(e.externalAttributes ?? (0o100644 << 16) >>> 0),
      u32(offset),
      name,
      centralExtra,
      comment,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const between = spec.between ?? new Uint8Array(0);
  const cd = concat(centrals);
  const cdOffset = offset + between.length + (spec.cdOffsetDelta ?? 0);
  const comment = spec.comment ?? new Uint8Array(0);
  const count = spec.entriesOverride ?? entries.length;
  const locator = spec.zip64Locator
    ? concat([u32(0x07064b50), u32(0), u32(0), u32(0), u32(1)])
    : new Uint8Array(0);
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(cd.length + locator.length),
    u32(cdOffset),
    u16(comment.length),
    comment,
  ]);
  return concat([
    spec.prefix ?? new Uint8Array(0),
    ...locals,
    between,
    cd,
    locator,
    eocd,
    spec.trailing ?? new Uint8Array(0),
  ]);
}

function status(bytes: Uint8Array): string {
  return readSingleEntry(bytes).status;
}

/* ------------------------------------------------------------------ *
 * Accepted archives
 * ------------------------------------------------------------------ */

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('a deflated single quality-summary.json is read', () => {
  assert.deepEqual(readSingleEntry(zip()), { status: 'ok', text: VALID_JSON });
});

test('a stored single entry is read', () => {
  assert.deepEqual(readSingleEntry(zip({ entries: [{ method: 0 }] })), {
    status: 'ok',
    text: VALID_JSON,
  });
});

test('streaming layout with a signed data descriptor and zero local sizes is read', () => {
  const bytes = zip({ entries: [{ descriptor: 'signed', zeroLocal: true }] });
  assert.deepEqual(readSingleEntry(bytes), { status: 'ok', text: VALID_JSON });
});

test('an unsigned data descriptor is read', () => {
  const bytes = zip({ entries: [{ descriptor: 'unsigned', zeroLocal: true }] });
  assert.equal(status(bytes), 'ok');
});

test('a harmless extended-timestamp extra field is accepted', () => {
  const extra = Uint8Array.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]);
  assert.equal(status(zip({ entries: [{ localExtra: extra, centralExtra: extra }] })), 'ok');
});

test('an empty stored entry yields empty text', () => {
  assert.deepEqual(readSingleEntry(zip({ entries: [{ method: 0, content: new Uint8Array(0) }] })), {
    status: 'ok',
    text: '',
  });
});

test('the input is not modified', () => {
  const bytes = zip();
  const copy = Uint8Array.from(bytes);
  readSingleEntry(bytes);
  assert.deepEqual(bytes, copy);
});

/* ------------------------------------------------------------------ *
 * Entry set
 * ------------------------------------------------------------------ */

test('two entries are unexpected', () => {
  assert.equal(status(zip({ entries: [{}, { name: 'other.json' }] })), 'unexpected-entries');
});

test('duplicate quality-summary.json entries are unexpected', () => {
  assert.equal(status(zip({ entries: [{}, {}] })), 'unexpected-entries');
});

test('zero entries are malformed', () => {
  assert.equal(status(zip({ entries: [], entriesOverride: 0 })), 'malformed');
});

test('a single entry with another name is unexpected', () => {
  assert.equal(status(zip({ entries: [{ name: 'summary.json' }] })), 'unexpected-entries');
});

for (const name of [
  '../quality-summary.json',
  '/quality-summary.json',
  'dir/quality-summary.json',
  '..\\quality-summary.json',
  'quality-summary.json/',
  'QUALITY-SUMMARY.JSON',
  'quality-summary.json\0',
]) {
  test(`traversal or lookalike name is rejected: ${JSON.stringify(name)}`, () => {
    assert.equal(status(zip({ entries: [{ name }] })), 'unexpected-entries');
  });
}

test('a directory entry is rejected', () => {
  const bytes = zip({
    entries: [
      { method: 0, content: new Uint8Array(0), externalAttributes: (0o040755 << 16) | 0x10 },
    ],
  });
  assert.equal(status(bytes), 'unexpected-entries');
});

test('an MS-DOS directory attribute is rejected', () => {
  const bytes = zip({ entries: [{ madeBy: 20, externalAttributes: 0x10 }] });
  assert.equal(status(bytes), 'unexpected-entries');
});

test('a symlink entry is rejected', () => {
  const bytes = zip({
    entries: [
      { method: 0, content: enc.encode('/etc/passwd'), externalAttributes: 0o120777 << 16 },
    ],
  });
  assert.equal(status(bytes), 'unexpected-entries');
});

test('a local name differing from the central name is malformed', () => {
  assert.equal(status(zip({ entries: [{ localName: 'evil.json' }] })), 'malformed');
});

/* ------------------------------------------------------------------ *
 * Unsupported features
 * ------------------------------------------------------------------ */

test('traditional encryption is rejected', () => {
  assert.equal(status(zip({ entries: [{ flags: 1 }] })), 'malformed');
});

test('strong encryption flag is rejected', () => {
  assert.equal(status(zip({ entries: [{ flags: 1 << 6 }] })), 'malformed');
});

test('an AES extra field is rejected', () => {
  const extra = Uint8Array.from([0x01, 0x99, 7, 0, 2, 0, 0x41, 0x45, 3, 8, 0]);
  assert.equal(status(zip({ entries: [{ centralExtra: extra }] })), 'malformed');
});

test('a ZIP64 extra field is rejected', () => {
  const extra = Uint8Array.from([0x01, 0x00, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(status(zip({ entries: [{ localExtra: extra }] })), 'malformed');
});

test('ZIP64 size sentinels are rejected', () => {
  assert.equal(status(zip({ entries: [{ compressedSize: 0xffffffff }] })), 'malformed');
});

test('a ZIP64 end-of-central-directory locator is rejected', () => {
  assert.equal(status(zip({ zip64Locator: true })), 'malformed');
});

test('a version needed above 2.0 is rejected', () => {
  assert.equal(status(zip({ entries: [{ versionNeeded: 45 }] })), 'malformed');
});

test('an unsupported compression method is rejected', () => {
  const bytes = zip({ entries: [{ method: 0 }] });
  // Patch both method fields to 12 (bzip2).
  bytes[8] = 12;
  const cd = bytes.length - 22 - (46 + ENTRY_NAME.length);
  bytes[cd + 10] = 12;
  assert.equal(status(bytes), 'malformed');
});

test('a local method differing from the central method is malformed', () => {
  assert.equal(status(zip({ entries: [{ method: 0, localMethod: 8 }] })), 'malformed');
});

test('a malformed extra field is rejected', () => {
  const extra = Uint8Array.from([0x55, 0x54, 9, 0, 1]);
  assert.equal(status(zip({ entries: [{ centralExtra: extra }] })), 'malformed');
});

test('an entry comment is rejected', () => {
  assert.equal(status(zip({ entries: [{ centralComment: enc.encode('x') }] })), 'malformed');
});

/* ------------------------------------------------------------------ *
 * Ambiguous structure
 * ------------------------------------------------------------------ */

test('an archive comment is rejected', () => {
  assert.equal(status(zip({ comment: enc.encode('hello') })), 'malformed');
});

test('trailing bytes after the end record are rejected', () => {
  assert.equal(status(zip({ trailing: Uint8Array.from([0, 0, 0, 0]) })), 'malformed');
});

test('prefixed bytes before the local header are rejected', () => {
  assert.equal(status(zip({ prefix: enc.encode('MZ-stub') })), 'malformed');
});

test('bytes between the data and the central directory are rejected', () => {
  assert.equal(status(zip({ between: Uint8Array.from([1, 2, 3]) })), 'malformed');
});

test('a central directory offset that does not match is rejected', () => {
  assert.equal(status(zip({ cdOffsetDelta: 1 })), 'malformed');
});

test('a descriptor disagreeing with the central directory is rejected', () => {
  const bytes = zip({ entries: [{ descriptor: 'signed', zeroLocal: true }] });
  // Corrupt the descriptor's CRC (right after its signature).
  const data = Uint8Array.from(bytes);
  const sig = [0x50, 0x4b, 0x07, 0x08];
  let found = false;
  for (let i = 0; i < data.length - 4 && !found; i++) {
    if (sig.every((b, k) => data[i + k] === b)) {
      data[i + 4] = (data[i + 4] as number) ^ 0xff;
      found = true;
    }
  }
  assert.ok(found);
  assert.equal(status(data), 'malformed');
});

test('local sizes disagreeing with the central directory are rejected', () => {
  const bytes = zip();
  bytes[18] = (bytes[18] as number) ^ 0x01; // local compressed size
  assert.equal(status(bytes), 'malformed');
});

test('truncated archives are rejected at every length', () => {
  const bytes = zip();
  for (let n = 0; n < bytes.length; n++) {
    assert.notEqual(status(bytes.subarray(0, n)), 'ok', `length ${String(n)}`);
  }
});

test('random bytes are malformed and never throw', () => {
  let seed = 12345;
  for (let i = 0; i < 200; i++) {
    const bytes = new Uint8Array(64 + (i % 200));
    for (let k = 0; k < bytes.length; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      bytes[k] = seed >>> 24;
    }
    assert.equal(status(bytes), 'malformed');
  }
});

test('single-byte corruption anywhere never yields different content', () => {
  const bytes = zip();
  for (let i = 0; i < bytes.length; i++) {
    const copy = Uint8Array.from(bytes);
    copy[i] = (copy[i] as number) ^ 0x5a;
    const r = readSingleEntry(copy);
    if (r.status === 'ok') {
      assert.equal(r.text, VALID_JSON, `offset ${String(i)}`);
    }
  }
});

test('a non-Uint8Array input is malformed', () => {
  assert.equal(readSingleEntry('PK' as unknown as Uint8Array).status, 'malformed');
});

/* ------------------------------------------------------------------ *
 * Integrity
 * ------------------------------------------------------------------ */

test('a CRC-32 mismatch is rejected', () => {
  assert.equal(status(zip({ entries: [{ crc: 0x12345678 }] })), 'malformed');
});

test('a declared uncompressed size smaller than the real output is rejected', () => {
  const content = enc.encode(VALID_JSON);
  assert.equal(
    status(zip({ entries: [{ content, uncompressedSize: content.length - 1 }] })),
    'malformed',
  );
});

test('a declared uncompressed size larger than the real output is rejected', () => {
  const content = enc.encode(VALID_JSON);
  assert.equal(
    status(zip({ entries: [{ content, uncompressedSize: content.length + 1 }] })),
    'malformed',
  );
});

test('a stored entry whose sizes differ is rejected', () => {
  assert.equal(status(zip({ entries: [{ method: 0, uncompressedSize: 1 }] })), 'malformed');
});

test('a corrupt deflate stream is rejected', () => {
  const content = enc.encode(VALID_JSON);
  const data = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.equal(status(zip({ entries: [{ content, data }] })), 'malformed');
});

test('a deflate stream followed by extra bytes inside the entry is rejected', () => {
  const content = enc.encode(VALID_JSON);
  const data = concat([new Uint8Array(deflateRawSync(content)), [1, 2, 3, 4]]);
  assert.equal(status(zip({ entries: [{ content, data }] })), 'malformed');
});

test('invalid UTF-8 content is rejected', () => {
  assert.equal(
    status(zip({ entries: [{ method: 0, content: Uint8Array.from([0x7b, 0xff, 0x7d]) }] })),
    'malformed',
  );
});

/* ------------------------------------------------------------------ *
 * Size limits and bombs
 * ------------------------------------------------------------------ */

test('an archive over the compressed limit is too large', () => {
  assert.equal(status(new Uint8Array(MAX_ARCHIVE_BYTES + 1)), 'too-large');
});

test('a declared entry over the 5 MiB limit is too large', () => {
  const content = new Uint8Array(MAX_ENTRY_BYTES + 1).fill(0x20);
  assert.equal(status(zip({ entries: [{ content }] })), 'too-large');
});

test('an entry of exactly 5 MiB of varied content is accepted', () => {
  const content = new Uint8Array(MAX_ENTRY_BYTES);
  let seed = 7;
  for (let i = 0; i < content.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    content[i] = 0x61 + ((seed >>> 24) % 26);
  }
  assert.equal(status(zip({ entries: [{ content }] })), 'ok');
});

test('a highly compressed bomb is rejected by ratio before inflating', () => {
  const content = new Uint8Array(4 * 1024 * 1024).fill(0x20);
  const bytes = zip({ entries: [{ content }] });
  assert.ok(content.length > (bytes.length - 100) * MAX_RATIO);
  assert.equal(status(bytes), 'too-large');
});

test('a bomb that lies about its size is stopped by the bounded inflate', () => {
  const content = new Uint8Array(1024 * 1024).fill(0x20);
  const data = new Uint8Array(deflateRawSync(content));
  // Declares a tiny size within the ratio limit; real output is 1 MiB.
  const bytes = zip({ entries: [{ content: enc.encode('{}'), data, uncompressedSize: 100 }] });
  assert.equal(status(bytes), 'malformed');
});
