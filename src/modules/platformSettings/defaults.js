'use strict';

const env = require('../../config/env');

/**
 * What each group holds before anyone saves it in the console: the values the
 * sites carry in their own code today. The console's form starts from these,
 * and the first save of a group writes the whole group (these values with the
 * console's changes on top).
 *
 * The sites never read these: while a group has no row, the public endpoint
 * sends `null` for it and each site shows its own copy, exactly as before.
 * So when one of the values below changes in a site's code, change it here
 * too, or the console's form starts from a stale value:
 *   social   packages/ui/src/social-links/config.ts (SOCIAL_LINKS)
 *   contact  apps/marketing/src/content/policies.json (company.*)
 *   company  the same file, and apps/marketing/src/lib/policies.ts (TAX_REGISTRATION_NUMBER)
 *   footer   apps/marketing/src/i18n/dictionaries/{ar,en}.ts (brand.tomorrow, footer.rights)
 *   email    EMAIL_FROM_NAME; no signature and no footer links today
 */
function defaults() {
  return {
    contact: {
      supportEmail: 'zimossupport@gmail.com',
      phone: '01023641956',
      address: { ar: 'طنطا، محافظة الغربية، مصر', en: 'Tanta, Gharbia, Egypt' },
      hours: { ar: '24/7', en: '24/7' },
    },
    social: {
      links: [
        { platform: 'instagram', url: 'https://instagram.com/zimos.co', enabled: true },
        { platform: 'facebook', url: 'https://facebook.com/zimos.co', enabled: true },
        { platform: 'tiktok', url: 'https://www.tiktok.com/@zimos.co', enabled: true },
        { platform: 'whatsapp', url: 'https://wa.me/201501921444', enabled: true },
        { platform: 'x', url: 'https://x.com/ZimosCo', enabled: true },
        { platform: 'email', url: 'mailto:zimossupport@gmail.com', enabled: true },
      ],
    },
    company: {
      platformName: 'ZIMOS',
      legalName: { ar: 'ZIMOS', en: 'ZIMOS' },
      registration: { ar: 'قيد الإصدار', en: 'Being issued' },
      taxRegistration: '783-889-615',
    },
    footer: {
      tagline: { ar: 'تجارة لغدٍ أكثر إشراقًا.', en: 'Commerce for a brighter tomorrow.' },
      rights: { ar: 'جميع الحقوق محفوظة.', en: 'All rights reserved.' },
    },
    email: {
      senderName: env.notifications.brevo.fromName,
      signature: { ar: '', en: '' },
      footer: { showSupportEmail: false, showSocialLinks: false },
    },
  };
}

module.exports = { defaults };
