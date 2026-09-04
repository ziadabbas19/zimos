'use strict';

const env = require('../../../config/env');
const localStorage = require('./localStorage');
const r2Storage = require('./r2Storage');

const backends = { local: localStorage, r2: r2Storage };

// Picks the backend from STORAGE_PROVIDER at call time so a runtime override
// (in tests) takes effect. Every backend exposes the same
//   put({ workspaceId, filename, buffer, contentType }) -> { url, path }
function getStorage() {
  const backend = backends[env.storage.provider];
  if (!backend) {
    throw new Error(`Unknown STORAGE_PROVIDER "${env.storage.provider}" (expected "local" or "r2")`);
  }
  return backend;
}

module.exports = { getStorage, UPLOAD_ROOT: localStorage.UPLOAD_ROOT };
