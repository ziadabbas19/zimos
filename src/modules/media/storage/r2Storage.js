'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const env = require('../../../config/env');

// Cloudflare R2 is S3-compatible. The bucket is served publicly from
// R2_PUBLIC_URL (an r2.dev URL or a custom domain configured in the
// dashboard); the returned `url` is that prefix + the object key.
let client = null;
function getClient() {
  const { accountId, accessKeyId, secretAccessKey, bucketName, publicUrl } = env.storage.r2;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
    throw new Error(
      'R2 storage is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_URL)'
    );
  }
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }
  return client;
}

async function put({ workspaceId, filename, buffer, contentType }) {
  const s3 = getClient();
  const key = `${workspaceId}/${filename}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.storage.r2.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return {
    url: `${env.storage.r2.publicUrl}/${key}`,
    path: `/${key}`,
  };
}

// Lets tests reset the memoized client between provider switches.
function _resetClient() {
  client = null;
}

module.exports = { put, _resetClient };
