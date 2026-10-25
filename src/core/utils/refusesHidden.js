'use strict';

/**
 * Locked orders (modules/orders/orderLock) show a hidden customer detail as
 * "••••" (orderLock.MASK). A dashboard form filled from such a view would
 * write that placeholder over the real name, phone or address. Every
 * dashboard write of those details takes its body schema through
 * `refusesHidden`, which refuses any string that carries it, at any depth
 * (422 VALIDATION_ERROR naming the field).
 */

const HIDDEN = '••••';

/** The dotted path of the first string in `value` that carries HIDDEN, or null. */
function hiddenPath(value, path = []) {
  if (typeof value === 'string') return value.includes(HIDDEN) ? path.join('.') || 'value' : null;
  if (!value || typeof value !== 'object' || value instanceof Date) return null;
  for (const [key, inner] of Object.entries(value)) {
    const found = hiddenPath(inner, [...path, key]);
    if (found) return found;
  }
  return null;
}

/** `schema` (a Joi object) that also refuses a hidden value anywhere in it. */
const refusesHidden = (schema) =>
  schema.custom((value, helpers) => {
    const path = hiddenPath(value);
    return path ? helpers.message(`"${path}" holds a hidden value (${HIDDEN}): type the real one`) : value;
  });

module.exports = { HIDDEN, hiddenPath, refusesHidden };
