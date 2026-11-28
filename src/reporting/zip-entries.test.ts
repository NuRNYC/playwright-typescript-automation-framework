/**
 * Unit tests for the bounded exact-entry ZIP reader (ADR-0013, Phase C5B).
 * Every archive is synthetic and built in memory; nothing touches the
 * filesystem or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  HEALTH_BUNDLE_SPEC,
  UNIT_RESULTS_SPEC,
  readExactEntries,
  type ExactEntriesSpec,
} from './zip-entries.ts';
import { MAX_ARCHIVE_BYTES, crc32, readSingleEntry } from './zip-entry.ts';

const enc = new TextEncoder();

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

interface Entry {
  name: string;
  content?: Uint8Array;
  method?: 0 | 8;
  flags?: number;
  mode?: number;
  crc?: number;
  uncompressedSize?: number;
  descriptor?: boolean;
  extra?: Uint8Array;
}

interface Archive {
  entries: Entry[];
  prefix?: Uint8Array;
  between?: Uint8Array;
  trailing?: Uint8Array;
  comment?: Uint8Array;
  countOverride?: number;
}

function zip(spec: Archive): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = spec.prefix?.length ?? 0;
  spec.entries.forEach((e, index) => {
    const content = e.content ?? enc.encode(`content of ${e.name}`);
    const method = e.method ?? 8;
    const data = method === 8 ? new Uint8Array(deflateRawSync(content)) : content;
    const name = enc.encode(e.name);
    const flags = e.flags ?? (e.descriptor === true ? 1 << 3 : 0);
    const crc = e.crc ?? crc32(content);
    const usize = e.uncompressedSize ?? content.length;
    const extra = e.extra ?? new Uint8Array(0);
    const zero = e.descriptor === true;
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(zero ? 0 : crc),
      u32(zero ? 0 : data.length),
      u32(zero ? 0 : usize),
      u16(name.length),
      u16(extra.length),
      name,
      extra,
      data,
      e.descriptor === true
        ? concat([u32(0x08074b50), u32(crc), u32(data.length), u32(usize)])
        : new Uint8Array(0),
      index < spec.entries.length - 1 ? (spec.between ?? new Uint8Array(0)) : new Uint8Array(0),
    ]);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16((3 << 8) | 20),
        u16(20),
        u16(flags),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(usize),
        u16(name.length),
        u16(extra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(((e.mode ?? 0o100644) << 16) >>> 0),
        u32(offset),
        name,
        extra,
      ]),
    );
    locals.push(local);
    offset += local.length;
  });
  const cd = concat(centrals);
  const comment = spec.comment ?? new Uint8Array(0);
  const count = spec.countOverride ?? spec.entries.length;
  return concat([
    spec.prefix ?? new Uint8Array(0),
    ...locals,
    cd,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(cd.length),
    u32(offset),
    u16(comment.length),
    comment,
    spec.trailing ?? new Uint8Array(0),
  ]);
}

const JSON_TEXT = '{"kind":"test-health"}\n';
const MD_TEXT = '## Test health\n';

function bundle(overrides: Partial<Archive> = {}, entries?: Entry[]): Uint8Array {
  return zip({
    entries: entries ?? [
      { name: 'test-health.json', content: enc.encode(JSON_TEXT) },
      { name: 'test-health.md', content: enc.encode(MD_TEXT), method: 0 },
    ],
    ...overrides,
  });
}

function status(bytes: Uint8Array, spec: ExactEntriesSpec = HEALTH_BUNDLE_SPEC): string {
  return readExactEntries(bytes, spec).status;
}

/* ------------------------------------------------------------------ *
 * Accepted archives
 * ------------------------------------------------------------------ */

test('reads exactly the two allow-listed health bundle entries', () => {
  const result = readExactEntries(bundle(), HEALTH_BUNDLE_SPEC);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual([...result.entries.keys()].sort(), ['test-health.json', 'test-health.md']);
  assert.equal(result.entries.get('test-health.json'), JSON_TEXT);
  assert.equal(result.entries.get('test-health.md'), MD_TEXT);
});

test('entry order does not matter; data descriptors are accepted', () => {
  const reversed = bundle({}, [
    { name: 'test-health.md', content: enc.encode(MD_TEXT), descriptor: true },
    { name: 'test-health.json', content: enc.encode(JSON_TEXT), descriptor: true },
  ]);
  assert.equal(status(reversed), 'ok');
});

test('reads the single unit-results entry', () => {
  const unit = zip({ entries: [{ name: 'unit-results.stamped.json', content: enc.encode('{}') }] });
  const result = readExactEntries(unit, UNIT_RESULTS_SPEC);
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.equal(result.entries.get('unit-results.stamped.json'), '{}');
});

test('the existing single-entry reader contract is unchanged', () => {
  // It still accepts only one `quality-summary.json` and rejects these archives.
  assert.equal(readSingleEntry(bundle()).status, 'unexpected-entries');
  const unit = zip({ entries: [{ name: 'unit-results.stamped.json' }] });
  assert.equal(readSingleEntry(unit).status, 'unexpected-entries');
});

/* ------------------------------------------------------------------ *
 * Entry set
 * ------------------------------------------------------------------ */

test('missing, extra, duplicate and unknown entries are rejected', () => {
  const json: Entry = { name: 'test-health.json' };
  const md: Entry = { name: 'test-health.md' };
  assert.equal(status(bundle({}, [json])), 'unexpected-entries');
  assert.equal(status(bundle({}, [json, md, { name: 'extra.txt' }])), 'unexpected-entries');
  assert.equal(status(bundle({}, [json, json])), 'unexpected-entries');
  assert.equal(status(bundle({}, [json, { name: 'test-health.markdown' }])), 'unexpected-entries');
  assert.equal(
    status(bundle({}, [json, md]), {
      names: ['test-health.json'],
      maxEntryBytes: 1024,
      maxTotalBytes: 1024,
    }),
    'unexpected-entries',
  );
});

test('traversal, nested, absolute and backslash names are rejected', () => {
  for (const name of [
    '../test-health.json',
    'test-health/test-health.json',
    '/test-health.json',
    'test-health\\test-health.json',
    'TEST-HEALTH.json',
  ]) {
    assert.equal(
      status(bundle({}, [{ name }, { name: 'test-health.md' }])),
      'unexpected-entries',
      name,
    );
  }
});

test('directories and symbolic links are rejected', () => {
  const dir: Entry = { name: 'test-health.json', mode: 0o040755 };
  const link: Entry = { name: 'test-health.json', mode: 0o120777 };
  for (const entry of [dir, link]) {
    assert.equal(status(bundle({}, [entry, { name: 'test-health.md' }])), 'unexpected-entries');
  }
});

/* ------------------------------------------------------------------ *
 * Unsupported or malformed structure
 * ------------------------------------------------------------------ */

test('encryption, unsupported methods and ZIP64 markers are rejected', () => {
  const md: Entry = { name: 'test-health.md' };
  assert.equal(status(bundle({}, [{ name: 'test-health.json', flags: 1 }, md])), 'malformed');
  assert.equal(status(bundle({}, [{ name: 'test-health.json', flags: 1 << 6 }, md])), 'malformed');
  const aes = Uint8Array.from([0x01, 0x99, 0x00, 0x00]);
  assert.equal(status(bundle({}, [{ name: 'test-health.json', extra: aes }, md])), 'malformed');
  const zip64 = Uint8Array.from([0x01, 0x00, 0x00, 0x00]);
  assert.equal(status(bundle({}, [{ name: 'test-health.json', extra: zip64 }, md])), 'malformed');
});

test('prefixes, gaps, trailing data, comments and wrong counts are rejected', () => {
  const junk = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(status(bundle({ prefix: junk })), 'malformed');
  assert.equal(status(bundle({ between: junk })), 'malformed');
  assert.equal(status(bundle({ trailing: junk })), 'malformed');
  assert.equal(status(bundle({ comment: junk })), 'malformed');
  // A directory count other than the allow-list size is never read further.
  assert.equal(status(bundle({ countOverride: 3 })), 'unexpected-entries');
  assert.equal(status(bundle({ countOverride: 1 })), 'unexpected-entries');
});

test('CRC mismatches, truncation and invalid UTF-8 are rejected', () => {
  const md: Entry = { name: 'test-health.md' };
  assert.equal(status(bundle({}, [{ name: 'test-health.json', crc: 1 }, md])), 'malformed');
  const truncated = bundle().subarray(0, bundle().length - 5);
  assert.equal(status(truncated), 'malformed');
  const bad = Uint8Array.from([0xff, 0xfe, 0x00]);
  assert.equal(
    status(bundle({}, [{ name: 'test-health.json', content: bad, method: 0 }, md])),
    'malformed',
  );
  assert.equal(status(new Uint8Array(0)), 'malformed');
  assert.equal(
    readExactEntries('nope' as unknown as Uint8Array, HEALTH_BUNDLE_SPEC).status,
    'malformed',
  );
});

/* ------------------------------------------------------------------ *
 * Size limits
 * ------------------------------------------------------------------ */

test('excessive archive, entry, total and ratio sizes are rejected before inflating', () => {
  assert.equal(status(new Uint8Array(MAX_ARCHIVE_BYTES + 1)), 'too-large');
  const big = enc.encode('x'.repeat(HEALTH_BUNDLE_SPEC.maxEntryBytes + 1));
  assert.equal(
    status(
      bundle({}, [
        { name: 'test-health.json', content: big, method: 0 },
        { name: 'test-health.md' },
      ]),
    ),
    'too-large',
  );
  const tight: ExactEntriesSpec = {
    names: ['test-health.json', 'test-health.md'],
    maxEntryBytes: 40,
    maxTotalBytes: 50,
  };
  const thirty = enc.encode('y'.repeat(30));
  assert.equal(
    status(
      bundle({}, [
        { name: 'test-health.json', content: thirty, method: 0 },
        { name: 'test-health.md', content: thirty, method: 0 },
      ]),
      tight,
    ),
    'too-large',
  );
  // A compression bomb: highly repetitive content over the ratio limit.
  const bomb = enc.encode('a'.repeat(200_000));
  assert.equal(
    status(bundle({}, [{ name: 'test-health.json', content: bomb }, { name: 'test-health.md' }])),
    'too-large',
  );
});

test('a declared size that understates the content is rejected', () => {
  const md: Entry = { name: 'test-health.md' };
  assert.equal(
    status(
      bundle({}, [
        { name: 'test-health.json', content: enc.encode(JSON_TEXT), uncompressedSize: 4 },
        md,
      ]),
    ),
    'malformed',
  );
});

test('an invalid specification is refused without reading', () => {
  for (const spec of [
    { names: [], maxEntryBytes: 10, maxTotalBytes: 10 },
    { names: ['a', 'a'], maxEntryBytes: 10, maxTotalBytes: 10 },
    { names: ['../a'], maxEntryBytes: 10, maxTotalBytes: 10 },
    { names: ['a'], maxEntryBytes: 0, maxTotalBytes: 10 },
    { names: ['a'], maxEntryBytes: 10, maxTotalBytes: 5 },
  ]) {
    assert.equal(readExactEntries(bundle(), spec).status, 'invalid-spec', JSON.stringify(spec));
  }
});

test('outcomes never carry archive content or names', () => {
  const secret = enc.encode('SECRET-CONTENT-CANARY');
  const result = readExactEntries(
    bundle({}, [{ name: 'test-health.json', content: secret }, { name: 'unexpected-name.txt' }]),
    HEALTH_BUNDLE_SPEC,
  );
  assert.deepEqual(result, { status: 'unexpected-entries' });
});
