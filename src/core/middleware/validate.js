'use strict';

const { ValidationError } = require('../errors/AppError');

/**
 * Builds an Express middleware that validates req.body / req.params / req.query
 * against Joi schemas. Unknown/malformed input is rejected outright — nothing
 * from the client is ever trusted past this point without being validated.
 */
function validate(schemas) {
  return (req, res, next) => {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const { error, value } = schemas[part].validate(req[part], {
        abortEarly: false,
        stripUnknown: true,
      });
      if (error) {
        return next(
          new ValidationError(
            error.details.map((d) => ({ field: d.path.join('.'), message: d.message })),
            `Invalid ${part}`
          )
        );
      }
      if (part === 'query') {
        // Express 5 exposes req.query as a getter-only accessor over the
        // parsed URL, so a plain assignment throws. Redefine the property
        // instead so validated/defaulted query values still flow through.
        Object.defineProperty(req, 'query', { value, writable: true, configurable: true, enumerable: true });
      } else {
        req[part] = value;
      }
    }
    next();
  };
}

module.exports = validate;
