'use strict';

/**
 * Whether ZIMOS is hidden from a store's shoppers: the footer's "Powered by"
 * line and mark, the header's fallback logo, the sender name on the store's
 * emails to its shoppers, the old EJS shop page.
 *
 * Two things have to be true at once:
 *   - the merchant switched it on — settings.general.hide_platform_branding
 *     (storefront/generalSettings.js, Store settings → General), off unless
 *     exactly true;
 *   - the store has remove_branding right now — its plan or a console grant
 *     (billing/entitlementsService).
 *
 * The plan is read every time, nothing is stored about it: a downgrade shows
 * the branding again on its own and an upgrade hides it again, the setting
 * untouched either way. This is a benefit, not a refusal, so it follows the
 * store's keys whatever PLAN_FEATURE_ENFORCEMENT says. A failed lookup keeps
 * the branding.
 */

const SETTING_KEY = 'hide_platform_branding';

/** The merchant's switch, from a workspace's settings blob. */
function wantsHidden(settings) {
  const general = settings && settings.general;
  return Boolean(general && general[SETTING_KEY] === true);
}

/**
 * True while the branding is hidden for this store. `workspace` is a row (or
 * any object) with `id` and `settings`; the plan is asked only when the
 * switch is on, so a store that never touched the setting costs no query.
 */
async function isHidden(workspace, { transaction } = {}) {
  if (!workspace || !wantsHidden(workspace.settings)) return false;
  return require('../billing/entitlementsService')
    .hasFeature(workspace.id, 'remove_branding', { transaction })
    .catch(() => false);
}

module.exports = { SETTING_KEY, wantsHidden, isHidden };
