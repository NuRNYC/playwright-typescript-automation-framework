/**
 * Permanent unit tests for the configuration resolver.
 *
 * Run with Node's built-in runner: `npm run test:unit`. No browser, no
 * network, no third-party dependency.
 *
 * These replace the one-off shell probes used while building M3a. Probes
 * proved the behaviour once, interactively, on one machine; these run on every
 * push and block a merge through the required `test` check.
 *
 * TWO CONVENTIONS WORTH NOTING:
 *
 * 1. Imports use an explicit `./env.ts` extension and a relative path. Node's
 *    type-stripping loader requires the extension (an extensionless specifier
 *    fails with ERR_MODULE_NOT_FOUND) and knows nothing of the `@/` alias,
 *    which is a compile-time tsconfig mapping rather than a runtime one.
 *    `allowImportingTsExtensions` lets `tsc` accept the same specifier.
 *
 * 2. No test mutates `process.env`. Every case passes a plain object literal
 *    to `resolveConfig`. Mutating the real environment would make these tests
 *    order-dependent, would require module-cache busting to observe any
 *    effect, and would collide with any parallel runner sharing the process.
 *
 * Credential-shaped strings below are synthetic and exist only to prove
 * redaction. They are not real secrets of any kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_TARGETS,
  ConfigError,
  describeConfig,
  redactBaseURL,
  resolveConfig,
  type TestConfig,
} from './env.ts';

const SAUCEDEMO_URL = 'https://www.saucedemo.com';

/* ------------------------------------------------------------------ *
 * Default target
 * ------------------------------------------------------------------ */

test('an empty environment resolves to the Sauce Demo default', () => {
  const resolved = resolveConfig({});

  assert.equal(resolved.target, 'saucedemo');
  assert.equal(resolved.tier, 'public-demo');
  assert.equal(resolved.baseURL, SAUCEDEMO_URL);
  assert.equal(resolved.baseURLSource, 'registry');
  assert.equal(resolved.execution, 'local');
});

test('Sauce Demo is tiered as a public demo, never as "local"', () => {
  // Guards the modelling decision from ADR-0001: the deployment tier and the
  // execution context are different axes. Nothing is deployed locally.
  // No cast needed: assert.notEqual accepts `unknown`, so comparing the
  // DeploymentTier union against a value outside it is already well typed.
  assert.equal(resolveConfig({}).tier, 'public-demo');
  assert.notEqual(resolveConfig({}).tier, 'local');
});

test('an unset, blank or whitespace APP_TARGET all default', () => {
  for (const value of [undefined, '', '   ']) {
    const resolved = resolveConfig(value === undefined ? {} : { APP_TARGET: value });
    assert.equal(resolved.target, 'saucedemo', `APP_TARGET=${JSON.stringify(value)}`);
  }
});

/* ------------------------------------------------------------------ *
 * Valid targets
 * ------------------------------------------------------------------ */

test('every advertised target resolves when given what it requires', () => {
  assert.deepEqual([...APP_TARGETS], ['saucedemo', 'staging', 'production']);

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['saucedemo', 'public-demo'],
    ['staging', 'internal-staging'],
    ['production', 'production'],
  ];

  for (const [target, expectedTier] of cases) {
    const resolved = resolveConfig({ APP_TARGET: target, BASE_URL: 'https://example.com' });
    assert.equal(resolved.target, target);
    assert.equal(resolved.tier, expectedTier);
  }
});

/* ------------------------------------------------------------------ *
 * Invalid targets
 * ------------------------------------------------------------------ */

test('an unknown target throws ConfigError and names the valid options', () => {
  // Asserting the type proves the intended failure path ran rather than an
  // incidental TypeError; asserting the message proves the diagnostic is still
  // actionable. A bare "it threw" assertion would pass even if the message
  // degraded to something useless.
  assert.throws(() => resolveConfig({ APP_TARGET: 'nonsense' }), {
    name: 'ConfigError',
    message: /Invalid APP_TARGET "nonsense"\. Valid targets: saucedemo, staging, production\./,
  });

  assert.throws(() => resolveConfig({ APP_TARGET: 'nonsense' }), ConfigError);
});

test('target matching is case sensitive', () => {
  for (const value of ['SauceDemo', 'SAUCEDEMO', 'Staging']) {
    assert.throws(() => resolveConfig({ APP_TARGET: value }), ConfigError, value);
  }
});

test('inherited Object.prototype keys are not valid targets', () => {
  // The registry lookup is guarded with Object.prototype.hasOwnProperty.call
  // rather than the `in` operator, which walks the prototype chain. Were that
  // ever "simplified" to `in`, these would resolve to a definition of
  // `undefined` and fail far less helpfully. This pins the security property.
  for (const value of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => resolveConfig({ APP_TARGET: value }), ConfigError, value);
  }
});

/* ------------------------------------------------------------------ *
 * Missing required BASE_URL
 * ------------------------------------------------------------------ */

test('targets without a registry URL demand an explicit BASE_URL', () => {
  for (const target of ['staging', 'production']) {
    assert.throws(() => resolveConfig({ APP_TARGET: target }), {
      name: 'ConfigError',
      message: /requires BASE_URL to be set explicitly/,
    });
  }
});

test('a blank BASE_URL counts as absent, so it cannot satisfy the requirement', () => {
  for (const blank of ['', '   ']) {
    assert.throws(
      () => resolveConfig({ APP_TARGET: 'staging', BASE_URL: blank }),
      ConfigError,
      JSON.stringify(blank),
    );
  }
});

test('a non-demo target never silently falls back to the demo URL', () => {
  // The core guarantee of ADR-0001: the *target name* defaults, the URL never
  // does. A misconfigured staging run must fail, not quietly test Sauce Demo.
  try {
    resolveConfig({ APP_TARGET: 'production' });
    assert.fail('expected a ConfigError');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.doesNotMatch(error.message, /saucedemo\.com/);
  }
});

/* ------------------------------------------------------------------ *
 * URL format and protocol
 * ------------------------------------------------------------------ */

test('malformed URLs are rejected and the offending value is quoted back', () => {
  for (const bad of ['not a url', 'example.com', '//example.com', 'https://']) {
    assert.throws(() => resolveConfig({ BASE_URL: bad }), ConfigError, bad);
  }
});

test('non-http(s) protocols are rejected, including javascript:', () => {
  for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.throws(() => resolveConfig({ BASE_URL: bad }), ConfigError, bad);
  }
});

test('http, https, ports and paths are all accepted and preserved verbatim', () => {
  const accepted = [
    'http://localhost:3000',
    'https://example.com',
    'https://example.com:8443/app',
    'https://example.com/trailing/',
  ];

  for (const url of accepted) {
    const resolved = resolveConfig({ APP_TARGET: 'staging', BASE_URL: url });
    // Preserved exactly: Playwright resolves page paths against this value, so
    // normalising it here would silently change navigation behaviour.
    assert.equal(resolved.baseURL, url);
  }
});

/* ------------------------------------------------------------------ *
 * Provenance of baseURL
 * ------------------------------------------------------------------ */

test('provenance distinguishes a registry default from an override', () => {
  assert.equal(resolveConfig({}).baseURLSource, 'registry');
  assert.equal(resolveConfig({ BASE_URL: 'https://mirror.example.com' }).baseURLSource, 'override');
});

test('an override identical to the default is still reported as an override', () => {
  // Provenance records where the value came from, not whether it differs.
  const resolved = resolveConfig({ BASE_URL: SAUCEDEMO_URL });
  assert.equal(resolved.baseURL, SAUCEDEMO_URL);
  assert.equal(resolved.baseURLSource, 'override');
});

test('tier is never re-derived from an overridden URL', () => {
  // An override is operator intent, not evidence about the deployment.
  // Inferring "this hostname looks like staging" would be guesswork dressed as
  // a safety guarantee, so tier always comes from APP_TARGET.
  const staging = resolveConfig({ APP_TARGET: 'staging', BASE_URL: SAUCEDEMO_URL });
  assert.equal(staging.tier, 'internal-staging');

  const demo = resolveConfig({ BASE_URL: 'https://prod.internal.example.com' });
  assert.equal(demo.tier, 'public-demo');
});

/* ------------------------------------------------------------------ *
 * CI parsing
 * ------------------------------------------------------------------ */

test('CI is parsed explicitly rather than by truthiness', () => {
  for (const value of ['1', 'true', 'yes', 'on', 'TRUE', '  true  ']) {
    assert.equal(resolveConfig({ CI: value }).execution, 'ci', value);
  }

  // The reason this matters: every non-empty string is truthy in JavaScript,
  // so `!!process.env.CI` treated '0' and 'false' as CI and silently enabled
  // retries and forbidOnly for someone who asked for neither.
  for (const value of ['0', 'false', 'no', 'off', '', '  ']) {
    assert.equal(resolveConfig({ CI: value }).execution, 'local', JSON.stringify(value));
  }

  assert.equal(resolveConfig({}).execution, 'local');
});

test('an unrecognised CI value fails loudly instead of guessing', () => {
  for (const value of ['maybe', '2', 'ci']) {
    assert.throws(() => resolveConfig({ CI: value }), {
      name: 'ConfigError',
      message: /Invalid CI value/,
    });
  }
});

test('execution context is independent of the application target', () => {
  // The two axes must compose freely: the public demo from CI is legitimate,
  // and so is an internal target from a developer machine.
  const demoFromCi = resolveConfig({ CI: 'true' });
  assert.equal(demoFromCi.tier, 'public-demo');
  assert.equal(demoFromCi.execution, 'ci');

  const stagingLocally = resolveConfig({
    APP_TARGET: 'staging',
    BASE_URL: 'https://staging.example.com',
    CI: 'false',
  });
  assert.equal(stagingLocally.tier, 'internal-staging');
  assert.equal(stagingLocally.execution, 'local');
});

/* ------------------------------------------------------------------ *
 * URL sanitisation
 * ------------------------------------------------------------------ */

test('redaction removes userinfo, query string and fragment', () => {
  // Synthetic values only.
  const hostile = 'https://alice:s3cr3t@staging.example.com/app?token=abc123#section';
  const redacted = redactBaseURL(hostile);

  assert.equal(redacted, 'https://staging.example.com/app');
  for (const secret of ['alice', 's3cr3t', 'token', 'abc123', 'section']) {
    assert.doesNotMatch(redacted, new RegExp(secret), secret);
  }
});

test('redaction keeps the port, which is not sensitive and aids diagnosis', () => {
  assert.equal(redactBaseURL('https://example.com:8443/app'), 'https://example.com:8443/app');
});

test('redaction degrades safely on an unparseable value', () => {
  assert.equal(redactBaseURL('not a url'), '<unparseable>');
  assert.equal(redactBaseURL(''), '<unparseable>');
});

/* ------------------------------------------------------------------ *
 * Sensitive-data exposure in the banner
 * ------------------------------------------------------------------ */

test('describeConfig emits exactly the five allow-listed fields', () => {
  // An allow-list fails safe: a field added to TestConfig stays out of logs
  // until someone deliberately includes it. A deny-list would leak by default.
  const line = describeConfig(resolveConfig({}));
  const keys = line.split(' ').map((pair) => pair.split('=')[0]);

  assert.deepEqual(keys, ['target', 'tier', 'baseURL', 'baseURLSource', 'execution']);
});

test('describeConfig cannot leak credentials embedded in a URL', () => {
  const resolved = resolveConfig({
    APP_TARGET: 'production',
    BASE_URL: 'https://svc:p4ssw0rd@prod.example.com/api?apikey=XYZ#frag',
  });
  const line = describeConfig(resolved);

  for (const secret of ['svc', 'p4ssw0rd', 'apikey', 'XYZ', 'frag']) {
    assert.doesNotMatch(line, new RegExp(secret), secret);
  }
  assert.match(line, /baseURL=https:\/\/prod\.example\.com\/api/);
});

test('the resolved configuration carries no credential-shaped fields', () => {
  const resolved: TestConfig = resolveConfig({});
  assert.deepEqual(Object.keys(resolved).sort(), [
    'baseURL',
    'baseURLSource',
    'execution',
    'target',
    'tier',
  ]);

  const serialised = JSON.stringify(resolved);
  for (const word of ['password', 'secret', 'token', 'credential']) {
    assert.doesNotMatch(serialised.toLowerCase(), new RegExp(word), word);
  }
});

/* ------------------------------------------------------------------ *
 * Immutability
 * ------------------------------------------------------------------ */

test('resolveConfig returns a plain object; freezing is the singleton’s job', () => {
  // The resolver is pure and returns a fresh object each call. Freezing is
  // applied once, where the singleton is constructed in src/config/index.ts,
  // so this separation is asserted rather than assumed.
  const resolved = resolveConfig({});
  assert.equal(Object.isFrozen(resolved), false);
  assert.notEqual(resolveConfig({}), resolveConfig({}));
  assert.deepEqual(resolveConfig({}), resolveConfig({}));
});

test('a frozen configuration rejects mutation at the intended depth', () => {
  const frozen = Object.freeze(resolveConfig({}));

  assert.equal(Object.isFrozen(frozen), true);
  assert.throws(() => {
    // @ts-expect-error -- readonly is compile-time only; this proves the
    // runtime guard also holds for a consumer with no type information.
    frozen.baseURL = 'https://evil.example.com';
  }, TypeError);
  assert.equal(frozen.baseURL, SAUCEDEMO_URL);

  // TestConfig is flat, so a shallow freeze is a complete freeze. This asserts
  // that shape: if a nested object is ever added, the freeze must become deep
  // and this test will fail to remind us.
  for (const value of Object.values(frozen)) {
    assert.equal(typeof value, 'string');
  }
});
