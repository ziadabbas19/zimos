'use strict';

// Normalizes a phone number to digits-only with country code, defaulting a
// local-format number (leading 0) to Egypt (20).
function normalizePhone(raw, defaultCountryCode = '20') {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  digits = digits.replace(/^\+/, '');

  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.slice(1);
  } else if (!digits.startsWith(defaultCountryCode) && digits.length <= 11) {
    // Bare local number with no leading 0 (e.g. "1012345678")
    digits = defaultCountryCode + digits;
  }

  return digits;
}

module.exports = { normalizePhone };
