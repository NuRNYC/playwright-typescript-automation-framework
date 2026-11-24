/**
 * In-process synthetic API stub (ADR-0006). Node built-ins only.
 *
 * A TEST DEPENDENCY, not a deployment: it is started by a worker-scoped
 * fixture only when an API test runs, binds to 127.0.0.1 on a port the OS
 * assigns, and serves fixed synthetic data. There is no environment override
 * of its address, no credentials, and no mutable product state.
 *
 * Scenario ids select the negative cases, so the API client keeps a fixed,
 * client-owned set of endpoints and specs never build URLs.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Product } from './contract';
import { LOOPBACK_ADDRESS, PRODUCTS_PATH, loopbackOrigin } from './request-policy';

/** Fixed synthetic catalogue. Frozen: nothing can mutate it during a run. */
export const STUB_PRODUCTS: readonly Product[] = Object.freeze([
  Object.freeze({ id: 1, name: 'Synthetic Widget', priceCents: 1299 }),
  Object.freeze({ id: 2, name: 'Synthetic Gadget', priceCents: 2499 }),
]);

/** Product ids that trigger each negative scenario. */
export const STUB_SCENARIOS = {
  /** Not in the catalogue: 404. */
  missingId: 404,
  /** Valid JSON that breaks the product contract. */
  malformedId: 900,
  /** A body that is not valid JSON at all. */
  invalidJsonId: 901,
  /** A 302 redirect to the registered redirect target. */
  redirectId: 902,
} as const;

/** Only loopback origins may ever be a redirect target. */
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export interface ApiStub {
  /** The verified loopback origin, e.g. `http://127.0.0.1:53817`. */
  readonly origin: string;
  /**
   * Points the redirect scenario at a loopback origin (or back at the stub
   * itself with `undefined`). Used only by the redirect negative test.
   */
  setRedirectTarget(origin: string | undefined): void;
  close(): Promise<void>;
}

/** A second loopback server that only counts requests. */
export interface RedirectTrap {
  readonly origin: string;
  hits(): number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_ADDRESS, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    // Verify what was actually bound, not what was requested.
    return loopbackOrigin(server.address());
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  // Drop keep-alive sockets so close() cannot hang on an idle connection.
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Starts the synthetic API on 127.0.0.1 with an OS-assigned port. */
export async function startApiStub(): Promise<ApiStub> {
  let redirectTarget: string | undefined;
  let origin = '';

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    const path = new URL(req.url ?? '/', origin).pathname;
    if (path === PRODUCTS_PATH) {
      sendJson(res, 200, STUB_PRODUCTS);
      return;
    }
    const id = Number(/^\/api\/products\/(\d+)$/.exec(path)?.[1] ?? Number.NaN);
    switch (id) {
      case STUB_SCENARIOS.malformedId:
        sendJson(res, 200, { id: 'not-a-number', name: 42, extra: true });
        return;
      case STUB_SCENARIOS.invalidJsonId:
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id": 901, "name": ');
        return;
      case STUB_SCENARIOS.redirectId:
        res.writeHead(302, { location: `${redirectTarget ?? origin}/redirected` });
        res.end();
        return;
      default: {
        const product = STUB_PRODUCTS.find((candidate) => candidate.id === id);
        if (product) {
          sendJson(res, 200, product);
        } else {
          sendJson(res, 404, { error: 'not-found' });
        }
      }
    }
  };

  const server = createServer(handle);
  origin = await listenOnLoopback(server);

  return {
    origin,
    setRedirectTarget(target) {
      if (target !== undefined && !LOOPBACK_ORIGIN.test(target)) {
        throw new Error('redirect target must be a loopback origin');
      }
      redirectTarget = target;
    },
    close: () => closeServer(server),
  };
}

/** Starts a loopback server that answers 200 and counts every request. */
export async function startRedirectTrap(): Promise<RedirectTrap> {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    sendJson(res, 200, { trapped: true });
  });
  const origin = await listenOnLoopback(server);
  return { origin, hits: () => count, close: () => closeServer(server) };
}
