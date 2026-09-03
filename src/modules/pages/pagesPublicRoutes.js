'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const controller = require('./pagesController');
const schemas = require('./pagesValidation');

// Public render-data API for the storefront. No staff auth: only
// "does this workspace exist and is it live" via resolvePublicWorkspace.
// Mounted at /api/v1/store/:workspaceId/pages
const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

// GET /pages            -> home page (path "/"), or ?path=/deep/path
// GET /pages/:slug      -> page at "/:slug"
router.get('/', validate(schemas.publicGetHome), controller.publicGetPage);
router.get('/:slug', validate(schemas.publicGetPage), controller.publicGetPage);

module.exports = router;
