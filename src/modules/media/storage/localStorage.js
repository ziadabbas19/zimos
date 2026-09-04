'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../config/env');

// public/uploads at the project root — served statically by app.js at /uploads.
const UPLOAD_ROOT = path.resolve(__dirname, '../../../../public/uploads');

async function put({ workspaceId, filename, buffer }) {
  const dir = path.join(UPLOAD_ROOT, workspaceId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, filename), buffer);

  const relPath = `/uploads/${workspaceId}/${filename}`;
  return {
    url: `${env.appUrl.replace(/\/$/, '')}${relPath}`,
    path: relPath,
  };
}

module.exports = { put, UPLOAD_ROOT };
