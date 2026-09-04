'use strict';

// Media upload with STORAGE_PROVIDER=r2. The S3/R2 client is mocked — no real
// Cloudflare call. Validation (content-based type, 5MB cap) and the response
// shape { url, path, mimeType, size } are unchanged; only the backend differs.

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ __input: input })),
}));

const fs = require('fs');
const path = require('path');
const bwipjs = require('bwip-js');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const env = require('../../src/config/env');
const { UPLOAD_ROOT } = require('../../src/modules/media/mediaService');
const r2Storage = require('../../src/modules/media/storage/r2Storage');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const R2_PUBLIC = 'https://pub-test.r2.dev';
const ORIGINAL_PROVIDER = env.storage.provider;

let PNG;
beforeAll(async () => {
  PNG = await bwipjs.toBuffer({ bcid: 'code128', text: 'r2-test', scale: 1, height: 6, includetext: false });
});

beforeEach(() => {
  mockS3Send.mockReset().mockResolvedValue({});
  PutObjectCommand.mockClear();
  r2Storage._resetClient();
  env.storage.provider = 'r2';
  Object.assign(env.storage.r2, {
    accountId: 'acct123',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    bucketName: 'zimos-media',
    publicUrl: R2_PUBLIC,
  });
});

afterAll(() => {
  env.storage.provider = ORIGINAL_PROVIDER;
  r2Storage._resetClient();
});

const upload = (workspaceId, token, buffer, opts) =>
  request(app)
    .post(`/api/v1/workspaces/${workspaceId}/media`)
    .set(bearer(token))
    .attach('file', buffer, opts);

describe('media upload — R2 backend', () => {
  it('puts a valid PNG in the bucket and returns the public URL + same response shape', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();

    const res = await upload(workspace.id, auth.accessToken, PNG, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.size).toBe(PNG.length);
    expect(res.body.path).toMatch(new RegExp(`^/${workspace.id}/[0-9a-f-]+\\.png$`));
    expect(res.body.url).toBe(`${R2_PUBLIC}${res.body.path}`);
    expect(Object.keys(res.body).sort()).toEqual(['mimeType', 'path', 'size', 'url']);

    // the object really went through the R2 client
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const putInput = PutObjectCommand.mock.calls[0][0];
    expect(putInput.Bucket).toBe('zimos-media');
    expect(putInput.Key).toBe(res.body.path.slice(1)); // key = path without leading slash
    expect(putInput.ContentType).toBe('image/png');
    expect(Buffer.isBuffer(putInput.Body)).toBe(true);
    expect(putInput.Body.length).toBe(PNG.length);

    // and nothing was written to local disk
    const localGuess = path.join(UPLOAD_ROOT, res.body.path.replace(/^\//, ''));
    expect(fs.existsSync(localGuess)).toBe(false);
  });

  it('still decides type by content, not extension', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await upload(workspace.id, auth.accessToken, PNG, { filename: 'note.txt', contentType: 'text/plain' });
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/png');
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it('rejects non-image bytes before touching R2', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await upload(workspace.id, auth.accessToken, Buffer.from('not an image at all'), {
      filename: 'x.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('rejects a file over 5MB before touching R2', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
    const res = await upload(workspace.id, auth.accessToken, big, { filename: 'huge.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when STORAGE_PROVIDER=r2 but credentials are missing', async () => {
    env.storage.r2.bucketName = '';
    r2Storage._resetClient();
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await upload(workspace.id, auth.accessToken, PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
