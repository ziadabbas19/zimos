'use strict';

const dns = require('dns');
const http = require('http');
const env = require('../../src/config/env');
const { checkUrl, isPrivateAddress, guardedLookup, literalAddressError, UNUSABLE_HOST_MESSAGE } = require('../../src/modules/webhooks/webhookUrlGuard');
const { send } = require('../../src/modules/webhooks/webhookSender');

// A webhook URL is typed by a merchant and then called by our server: the
// platform's own network (Railway's *.railway.internal, 10/8, the metadata
// service, loopback) must stay out of reach — when the URL is saved, when it
// is sent to a literal IP, and when a name resolves privately at connect time
// (DNS rebinding).

const saved = env.webhooks.allowPrivateUrls;
beforeEach(() => {
  env.webhooks.allowPrivateUrls = false;
});
afterEach(() => {
  env.webhooks.allowPrivateUrls = saved;
  jest.restoreAllMocks();
});

const refused = (url) => {
  try {
    checkUrl(url);
    return false;
  } catch (err) {
    return err.details[0].message;
  }
};

describe('saving a webhook URL', () => {
  it.each([
    ['https://postgres.railway.internal/x', 'Must be a public hostname'],
    ['https://api.railway.internal:8080/admin', 'Must be a public hostname'],
    ['https://postgres.railway.internal./x', 'Must not end with a dot'],
    ['https://hooks.example.com./x', 'Must not end with a dot'],
    ['https://localhost/x', 'Must be a public hostname'],
    ['https://127.0.0.1/x', 'Must be a public address'],
    ['https://10.1.2.3/x', 'Must be a public address'],
    ['https://169.254.169.254/latest/meta-data', 'Must be a public address'],
    ['https://[::1]/x', 'Must be a public address'],
    ['https://[::ffff:127.0.0.1]/x', 'Must be a public address'],
    ['https://[::ffff:a00:1]/x', 'Must be a public address'],
    ['https://[::7f00:1]/x', 'Must be a public address'],
    ['https://[2002:a00:1::]/x', 'Must be a public address'],
    ['https://[fd00:1::5]/x', 'Must be a public address'],
    ['https://[fec0::1]/x', 'Must be a public address'],
  ])('refuses %s', (url, message) => {
    expect(refused(url)).toBe(message);
  });

  it('accepts a public https URL, on any port', () => {
    expect(refused('https://hooks.example.com/zimos')).toBe(false);
    expect(refused('https://hooks.example.com:8443/zimos')).toBe(false);
  });
});

describe('isPrivateAddress spells IPv6 every way', () => {
  it.each([
    ['::ffff:7f00:1', true],
    ['::ffff:a9fe:a9fe', true],
    ['::127.0.0.1', true],
    ['64:ff9b:1::a', true],
    ['2001:0:4136:e378::1', true],
    ['fe80::1%eth0', true],
    ['::ffff:808:808', false],
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

/** A receiver on loopback that records any request reaching it. */
function receiver() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.end('ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, hits, close: () => new Promise((d) => server.close(d)) })));
}

describe('sending', () => {
  it('never opens a socket to a private literal IP (a URL saved before the rules, or edited in the database)', async () => {
    const r = await receiver();
    try {
      const result = await send({ url: `http://127.0.0.1:${r.port}/hook`, body: '{}', headers: {}, timeoutMs: 2000 });
      expect(result).toEqual({ status: null, error: UNUSABLE_HOST_MESSAGE });
      const mapped = await send({ url: `http://[::ffff:127.0.0.1]:${r.port}/hook`, body: '{}', headers: {}, timeoutMs: 2000 });
      expect(mapped.status).toBeNull();
      expect(r.hits).toEqual([]);
      expect(literalAddressError('8.8.8.8')).toBeNull();
    } finally {
      await r.close();
    }
  });

  it('checks the address a name resolves to when connecting: a rebinding name never reaches loopback', async () => {
    const r = await receiver();
    const real = dns.lookup;
    // The name's answer turns to loopback after it was saved. ("localhost" is
    // the one name the suite's network guard lets a socket ask for; its
    // answer here is the resolver's, as a rebinding name's would be.)
    jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => {
      if (hostname === 'localhost') return callback(null, [{ address: '127.0.0.1', family: 4 }]);
      return real(hostname, options, callback);
    });
    try {
      // A public name passes the save check: the check that matters is at connect time.
      expect(refused('https://rebind.example.com/hook')).toBe(false);
      const result = await send({ url: `http://localhost:${r.port}/hook`, body: '{}', headers: {}, timeoutMs: 2000 });
      expect(result.status).toBeNull();
      expect(result.error).toBe(UNUSABLE_HOST_MESSAGE);
      expect(r.hits).toEqual([]);
    } finally {
      await r.close();
    }
  });

  it('hands the socket the very address it checked', (done) => {
    jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    guardedLookup('public.example.com', { all: false }, (err, address, family) => {
      expect(err).toBeNull();
      expect([address, family]).toEqual(['93.184.216.34', 4]);
      done();
    });
  });
});
