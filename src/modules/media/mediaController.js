'use strict';

const multer = require('multer');
const asyncHandler = require('express-async-handler');
const service = require('./mediaService');
const { AppError } = require('../../core/errors/AppError');
const { MAX_BYTES } = require('./mediaService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

// Wrap multer so its errors become our standard AppError shape instead of a 500.
function acceptFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError('FILE_TOO_LARGE', 'The file exceeds the 5MB limit', 413));
      return next(new AppError('UPLOAD_ERROR', err.message, 422));
    }
    return next(err);
  });
}

const uploadMedia = asyncHandler(async (req, res) => {
  const result = await service.storeImage(req.tenant.workspaceId, req.file, req);
  res.status(201).json(result);
});

module.exports = { acceptFile, uploadMedia };
