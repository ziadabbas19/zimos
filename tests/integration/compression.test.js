'use strict';

// Responses go out compressed when the client asks (app.js): brotli first,
// then gzip; small bodies and the live streams stay as they are.

const { app, request } = require('../helpers/factories');

// Reads the raw bytes: no decoding, so the test sees exactly what was sent.
const raw = (res, done) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('response compression', () => {
  it('sends brotli to a client that accepts it', async () => {
    const res = await request(app).get('/docs.json').set('Accept-Encoding', 'br, gzip').buffer(true).parse(raw);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers.vary).toMatch(/accept-encoding/i);
  });

  it('sends gzip to a client that only accepts gzip', async () => {
    const res = await request(app).get('/docs.json').set('Accept-Encoding', 'gzip').buffer(true).parse(raw);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('sends the body as it is to a client that asks for no encoding', async () => {
    const res = await request(app).get('/docs.json').set('Accept-Encoding', 'identity').buffer(true).parse(raw);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(res.body.toString('utf8')).openapi).toBeDefined();
  });

  it('leaves a small body alone', async () => {
    const res = await request(app).get('/health').set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual({ status: 'ok' });
  });
});
