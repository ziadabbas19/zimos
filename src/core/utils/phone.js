'use strict';

// Shorter than any real subscriber number. Checked before the country code is
// added, which would otherwise pad junk ("abc", "123") into a plausible-looking
// value that every such input shares.
const MIN_PHONE_DIGITS = 8;

// Normalizes a phone number to digits-only with country code, defaulting a
// local-format number (leading 0) to Egypt (20). Returns null for input that
// cannot be a phone number; callers treat that as INVALID_PHONE.
function normalizePhone(raw, defaultCountryCode = '20') {
  if (!raw) return null;
  if (String(raw).replace(/\D/g, '').length < MIN_PHONE_DIGITS) return null;
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
