'use strict';

// Purge-on-publish (storefront/cloudflarePurge.js), with fetch mocked and the
// clock faked: nothing leaves the machine. The store's address is read from a
// stub of Workspace.findByPk.

const env = require('../../src/config/env');
const db = require('../../src/db/models');
const logger = require('../../src/core/utils/logger');
const purge = require('../../src/modules/storefront/cloudflarePurge');

const TOKEN = 'test-only-cloudflare-purge-token-never-real';
const ZONE = 'fedcba9876543210fedcba9876543210';
const host = (slug) => `${slug}.${env.platformRootDomain}`;

const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});
const purged = () => reply(200, { success: true, errors: [], messages: [], result: { id: 'purge-id' } });

let fetchMock;
let slugs;
let written;

// Every request's hosts, in order.
const sentHosts = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).hosts);
// Everything the logger was given and everything written to the console.
const logged = () =>
  [...logger.warn.mock.calls, ...logger.info.mock.calls, ...logger.error.mock.calls].map((args) => JSON.stringify(args)).join('\n') +
  written.join('');

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  purge._reset();
  env.cloudflarePurge.enabled = true;
  env.cloudflarePurge.apiToken = TOKEN;
  env.cloudflarePurge.zoneId = ZONE;
  slugs = new Map();
  jest.spyOn(db.Workspace, 'findByPk').mockImplementation(async (id) => (slugs.has(id) ? { id, slug: slugs.get(id) } : null));
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => purged());
  jest.spyOn(logger, 'warn');
  jest.spyOn(logger, 'info');
  jest.spyOn(logger, 'error');
  written = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    jest.spyOn(stream, 'write').mockImplementation((chunk, ...rest) => {
      written.push(String(chunk));
      return write(chunk, ...rest);
    });
  }
});

afterEach(() => {
  purge._reset();
  jest.useRealTimers();
  jest.restoreAllMocks();
  env.cloudflarePurge.enabled = false;
  env.cloudflarePurge.apiToken = '';
  env.cloudflarePurge.zoneId = '';
});

describe('the switch', () => {
  it('off: no request and no lookup, whatever changes', async () => {
    env.cloudflarePurge.enabled = false;
    slugs.set('w1', 'acme');
    for (let i = 0; i < 5; i += 1) purge.purgeStore('w1', { previousSlug: 'old-acme' });
    await jest.advanceTimersByTimeAsync(120000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.Workspace.findByPk).not.toHaveBeenCalled();
  });

  it('on without a usable token or zone: no request, one warning naming neither value', async () => {
    env.cloudflarePurge.zoneId = 'not-a-zone-id';
    slugs.set('w1', 'acme');
    purge.purgeStore('w1');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(TOKEN);
  });
});

describe('one purge per burst of changes', () => {
  it('twenty saves in a row make one request, once the store has been quiet for 2 s', async () => {
    slugs.set('w1', 'acme');
    for (let i = 0; i < 20; i += 1) {
      purge.purgeStore('w1');
      await jest.advanceTimersByTimeAsync(100);
    }
    // The last save was at 1.9 s: nothing before 3.9 s.
    await jest.advanceTimersByTimeAsync(purge.DEBOUNCE_MS - 200);
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentHosts()).toEqual([[host('acme')]]);

    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a store saved without a pause is still purged 10 s after its first change', async () => {
    slugs.set('w1', 'acme');
    for (let i = 0; i < 10; i += 1) {
      purge.purgeStore('w1');
      await jest.advanceTimersByTimeAsync(999);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('two stores each get their own purge', async () => {
    slugs.set('w1', 'acme');
    slugs.set('w2', 'bolt');
    purge.purgeStore('w1');
    purge.purgeStore('w2');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(purge.DEBOUNCE_MS);
    expect(sentHosts().flat().sort()).toEqual([host('acme'), host('bolt')]);
  });
});

describe('what is purged', () => {
  it("the store's own host by hostname: the fixed URL, POST, the token as a Bearer header, nothing else in the body", async () => {
    slugs.set('w1', 'acme');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(purge.DEBOUNCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body)).toEqual({ hosts: [host('acme')] });
  });

  it('a new address: the old host and the new one', async () => {
    slugs.set('w1', 'acme-new');
    purge.purgeStore('w1', { previousSlug: 'acme-old' });
    await jest.advanceTimersByTimeAsync(purge.DEBOUNCE_MS);
    expect(sentHosts().flat().sort()).toEqual([host('acme-new'), host('acme-old')]);
  });

  it('never a platform host (app, api, admin, media, www, customers…) nor a malformed one', async () => {
    const platform = ['app', 'api', 'admin', 'media', 'www', 'customers', 'fallback', 'store', 'cdn'];
    platform.forEach((slug, i) => slugs.set(`p${i}`, slug));
    slugs.set('bad1', 'has_underscore');
    slugs.set('bad2', 'evil.com');
    slugs.set('bad3', '-dash');
    for (const id of slugs.keys()) purge.purgeStore(id);
    purge.purgeStore('w1', { previousSlug: 'api' });
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).not.toHaveBeenCalled();

    for (const slug of platform) expect(purge.storeHost(slug)).toBeNull();
    expect(purge.storeHost('acme')).toBe(host('acme'));
    expect(purge.storeHost('ACME')).toBe(host('acme'));
    expect(purge.storeHost('a.b')).toBeNull();
    expect(purge.storeHost('')).toBeNull();
    expect(purge.storeHost('x'.repeat(64))).toBeNull();
  });

  it('no platform domain to put a store under: nothing', () => {
    const root = env.platformRootDomain;
    try {
      env.platformRootDomain = 'localhost';
      expect(purge.storeHost('acme')).toBeNull();
      env.platformRootDomain = '';
      expect(purge.storeHost('acme')).toBeNull();
    } finally {
      env.platformRootDomain = root;
    }
  });

  it('a store that is gone: nothing', async () => {
    purge.purgeStore('missing');
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("within Cloudflare's purge limit", () => {
  it('5 requests at once, then one a 12 s; the stores waiting by then share a request of at most 30 hosts', async () => {
    for (let i = 0; i < 5; i += 1) {
      slugs.set(`a${i}`, `first-${i}`);
      purge.purgeStore(`a${i}`);
    }
    await jest.advanceTimersByTimeAsync(purge.DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(purge.BUCKET_SIZE);

    for (let i = 0; i < 40; i += 1) {
      slugs.set(`b${i}`, `next-${i}`);
      purge.purgeStore(`b${i}`);
    }
    // The bucket was emptied at 2 s; they are due at 4 s; the next token comes at 14 s.
    await jest.advanceTimersByTimeAsync(11000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sentHosts()[5]).toHaveLength(purge.MAX_HOSTS_PER_REQUEST);

    // And the one after at 26 s.
    await jest.advanceTimersByTimeAsync(purge.REFILL_MS - 2000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await jest.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(sentHosts()[6]).toHaveLength(10);
    expect(new Set(sentHosts().flat()).size).toBe(45);
  });

  it('a 429 waits for Retry-After, takes a token, and retries once', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(429, { success: false, errors: [{ code: 1015, message: 'rate limited' }] }, { 'retry-after': '20' }))
      .mockResolvedValueOnce(purged());
    slugs.set('w1', 'acme');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(purge.DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(19000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentHosts()).toEqual([[host('acme')], [host('acme')]]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[cloudflare-purge] purged', { hosts: [host('acme')] });
  });

  it('after a 429 nothing else is sent before Retry-After either', async () => {
    fetchMock.mockResolvedValueOnce(reply(429, { success: false, errors: [] }, { 'retry-after': '30' })).mockResolvedValue(purged());
    slugs.set('w1', 'acme');
    slugs.set('w2', 'bolt');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(purge.DEBOUNCE_MS);
    purge.purgeStore('w2');
    await jest.advanceTimersByTimeAsync(25000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(20000);
    expect(sentHosts().slice(1).flat().sort()).toEqual([host('acme'), host('bolt')]);
  });
});

describe('a failure is a warning, never an error for the merchant', () => {
  it('a second 429: no third try, one warning', async () => {
    fetchMock.mockResolvedValue(reply(429, { success: false, errors: [{ code: 1015, message: 'rate limited' }] }, { 'retry-after': '1' }));
    slugs.set('w1', 'acme');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(120000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ hosts: [host('acme')], status: 429 });
  });

  it('a 5xx is retried once', async () => {
    fetchMock.mockResolvedValueOnce(reply(502, null)).mockResolvedValueOnce(purged());
    slugs.set('w1', 'acme');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a 4xx is not retried: one request, one warning with what Cloudflare said', async () => {
    fetchMock.mockResolvedValue(reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
    slugs.set('w1', 'acme');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ status: 403, reason: '10000 Authentication error' });
  });

  it('no answer at all: retried once, then a warning; purgeStore itself never throws', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    slugs.set('w1', 'acme');
    expect(() => purge.purgeStore('w1')).not.toThrow();
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1].reason).toContain('ECONNRESET');
  });

  it("a store whose address can't be read: a warning, no request, no throw", async () => {
    db.Workspace.findByPk.mockRejectedValue(new Error('connection lost'));
    expect(() => purge.purgeStore('w1')).not.toThrow();
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('the token and the zone id stay out of the logs', () => {
  it('whatever Cloudflare or the network says', async () => {
    fetchMock
      // A routing error names the zone; one that echoes the token, in case.
      .mockResolvedValueOnce(
        reply(400, {
          success: false,
          errors: [{ code: 7003, message: `Could not route to /client/v4/zones/${ZONE}/purge_cache, perhaps your object identifier is invalid? (${TOKEN})` }],
        })
      )
      .mockRejectedValueOnce(new TypeError(`fetch failed https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache Bearer ${TOKEN}`))
      .mockRejectedValueOnce(new TypeError(`fetch failed https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache Bearer ${TOKEN}`))
      .mockResolvedValue(purged());
    slugs.set('w1', 'acme');
    slugs.set('w2', 'bolt');
    slugs.set('w3', 'core');
    purge.purgeStore('w1');
    await jest.advanceTimersByTimeAsync(30000);
    purge.purgeStore('w2');
    await jest.advanceTimersByTimeAsync(30000);
    purge.purgeStore('w3');
    await jest.advanceTimersByTimeAsync(30000);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][1].reason).toContain('7003 Could not route');
    expect(logger.info).toHaveBeenCalled();
    const text = logged();
    expect(text).toContain(host('acme'));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ZONE);
  });
});
