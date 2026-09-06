'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const controller = require('./templateController');
const schemas = require('./templateValidation');

// Public — mounted at /api/v1/templates. The template picker is the first
// screen a merchant sees after registering, so no auth / no tenant.
const router = Router();

router.get('/', controller.list);
router.get('/:id', validate(schemas.getOne), controller.get);

module.exports = router;
