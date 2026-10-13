'use strict';

// The storage settings check behind the boot log and the admin storage tile:
// which driver is active, the public base URL its links use, and every setting
// that makes those links wrong or short-lived. Nothing here reaches R2.

const env = require('../../src/config/env');
const { storageProblems, describeStorage, publicBaseUrl } = require('../../src/modules/media/storage');

const ORIGINAL = {
  provider: env.storage.provider,
  r2: { ...env.storage.r2 },
  allowLocalInProduction: env.storage.allowLocalInProduction,
  isProduction: env.isProduction,
  appUrl: env.appUrl,
};

const R2_OK = {
  accountId: 'acct123',
  accessKeyId: 'ak',
  secretAccessKey: 'sk-never-printed',
  bucketName: 'zimos-media',
  publicUrl: 'https://media.example.com',
  privateBucketName: '',
};

afterEach(() => {
  env.storage.provider = ORIGINAL.provider;
  Object.assign(env.storage.r2, ORIGINAL.r2);
  env.storage.allowLocalInProduction = ORIGINAL.allowLocalInProduction;
  env.isProduction = ORIGINAL.isProduction;
  env.appUrl = ORIGINAL.appUrl;
});

const useR2 = (overrides = {}) => {
  env.storage.provider = 'r2';
  Object.assign(env.storage.r2, R2_OK, overrides);
};

describe('storage settings check', () => {
  it('is clean for a complete R2 setup and names the driver and public base URL', () => {
    useR2();
    env.isProduction = true;
    expect(storageProblems()).toEqual([]);
    expect(publicBaseUrl()).toBe('https://media.example.com');
    expect(describeStorage()).toBe(
      'r2 (bucket=zimos-media, private=zimos-media [R2_PRIVATE_BUCKET_NAME not set: private files share the public bucket], public=https://media.example.com)'
    );
  });

  it('names the bucket private files are kept in, and says when it is the public one', () => {
    useR2({ privateBucketName: 'zimos-private' });
    expect(describeStorage()).toBe('r2 (bucket=zimos-media, private=zimos-private, public=https://media.example.com)');
    // Naming the media bucket itself separates nothing.
    useR2({ privateBucketName: 'zimos-media' });
    expect(describeStorage()).toBe(
      'r2 (bucket=zimos-media, private=zimos-media [R2_PRIVATE_BUCKET_NAME names the public bucket: private files share the public bucket], public=https://media.example.com)'
    );
  });

  it('does not require the private bucket: unset is the shared bucket, as before', () => {
    useR2({ privateBucketName: '' });
    env.isProduction = true;
    expect(storageProblems()).toEqual([]);
  });

  it('never prints a secret', () => {
    useR2({ publicUrl: '' });
    const text = `${describeStorage()} ${storageProblems().join(' ')}`;
    expect(text).not.toContain('sk-never-printed');
    expect(text).not.toContain('acct123');
  });

  it('names the missing R2 variables', () => {
    useR2({ bucketName: '', publicUrl: '' });
    expect(storageProblems()).toEqual(['STORAGE_PROVIDER=r2 but missing: R2_BUCKET_NAME, R2_PUBLIC_URL']);
  });

  it('refuses an R2_PUBLIC_URL with no scheme (every link would be relative)', () => {
    useR2({ publicUrl: 'pub-abc.r2.dev' });
    expect(storageProblems()).toEqual([expect.stringMatching(/^R2_PUBLIC_URL is not an absolute http\(s\) URL/)]);
  });

  it('refuses the private S3 API endpoint as R2_PUBLIC_URL', () => {
    useR2({ publicUrl: 'https://acct123.r2.cloudflarestorage.com/zimos-media' });
    expect(storageProblems()).toEqual([expect.stringMatching(/private S3 API endpoint/)]);
  });

  it('warns about an http R2_PUBLIC_URL in production only', () => {
    useR2({ publicUrl: 'http://media.example.com' });
    env.isProduction = false;
    expect(storageProblems()).toEqual([]);
    env.isProduction = true;
    expect(storageProblems()).toEqual([expect.stringMatching(/R2_PUBLIC_URL is http:\/\//)]);
  });

  it('flags local disk in production without ALLOW_LOCAL_STORAGE_IN_PRODUCTION', () => {
    env.storage.provider = 'local';
    env.isProduction = true;
    env.appUrl = 'https://api.example.com';
    expect(storageProblems()).toEqual([expect.stringMatching(/ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true/)]);
    expect(describeStorage()).toBe('local (serving /uploads from disk, public=https://api.example.com/uploads)');

    env.storage.allowLocalInProduction = true;
    expect(storageProblems()).toEqual([]);
  });

  it('flags a loopback APP_URL for local disk in production', () => {
    env.storage.provider = 'local';
    env.isProduction = true;
    env.storage.allowLocalInProduction = true;
    env.appUrl = 'http://localhost:4000';
    expect(storageProblems()).toEqual([expect.stringMatching(/^APP_URL is not the public address/)]);
  });

  it('leaves local disk alone outside production', () => {
    env.storage.provider = 'local';
    env.isProduction = false;
    env.appUrl = 'http://localhost:4000';
    expect(storageProblems()).toEqual([]);
  });

  it('reports an unknown provider', () => {
    env.storage.provider = 'disk';
    expect(storageProblems()).toEqual([expect.stringMatching(/Unknown STORAGE_PROVIDER "disk"/)]);
  });
});
