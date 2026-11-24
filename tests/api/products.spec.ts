import { test, expect } from '@/fixtures/test';
import { STUB_PRODUCTS, STUB_SCENARIOS } from '@/api/stub';

/**
 * API request layer against the in-process synthetic stub (ADR-0006).
 *
 * Runs only in the browser-free `api` project. Specs use the typed
 * `apiClient` fixture and assert on its discriminated `ApiResult`; they never
 * build URLs or requests themselves. This validates the layer, not a real
 * production API.
 */
test.describe('API request layer', { tag: '@api' }, () => {
  test('lists products with a valid typed contract', async ({ apiClient }) => {
    const result = await apiClient.listProducts();

    expect(result).toEqual({ ok: true, status: 200, data: STUB_PRODUCTS });
  });

  test('gets one product by id', async ({ apiClient }) => {
    const result = await apiClient.getProduct(2);

    expect(result).toEqual({ ok: true, status: 200, data: STUB_PRODUCTS[1] });
  });

  test('a missing product is a typed 404 HTTP error', async ({ apiClient }) => {
    const result = await apiClient.getProduct(STUB_SCENARIOS.missingId);

    expect(result).toEqual({ ok: false, kind: 'http-error', status: 404 });
  });

  test('a structurally invalid response is a contract violation', async ({ apiClient }) => {
    const result = await apiClient.getProduct(STUB_SCENARIOS.malformedId);

    expect(result).toEqual({
      ok: false,
      kind: 'contract-violation',
      status: 200,
      problem: 'product.id must be a positive integer',
    });
  });

  // Added deliberately (see ADR-0006): a body that is not JSON at all is a
  // different failure from valid JSON with the wrong shape, and the client
  // reports it as its own kind rather than throwing.
  test('a response that is not valid JSON is a malformed-json result', async ({ apiClient }) => {
    const result = await apiClient.getProduct(STUB_SCENARIOS.invalidJsonId);

    expect(result).toEqual({ ok: false, kind: 'malformed-json', status: 200 });
  });

  test('a redirect is refused and its destination is never contacted', async ({
    apiClient,
    redirectTrap,
  }) => {
    const result = await apiClient.getProduct(STUB_SCENARIOS.redirectId);

    expect(result).toEqual({ ok: false, kind: 'redirect-refused', status: 302 });
    expect(redirectTrap.hits()).toBe(0);
  });
});
