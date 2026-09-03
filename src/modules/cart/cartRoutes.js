'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const controller = require('./cartController');
const schemas = require('./cartValidation');

const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

router.post('/', validate(schemas.workspaceParam), controller.getOrCreate);
router.get('/', validate(schemas.workspaceParam), controller.getCurrent);
router.post('/items', validate(schemas.addItem), controller.addItem);
router.patch('/items/:itemId', validate(schemas.updateItem), controller.updateItem);
router.delete('/items/:itemId', validate(schemas.removeItem), controller.removeItem);

module.exports = router;
