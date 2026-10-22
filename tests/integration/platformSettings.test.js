'use strict';

// The platform's public details edited in the console (modules/platformSettings,
// PLATFORM_SETTINGS_ENABLED):
//
//   GET  /platform-settings/public                       no sign-in, flag on
//   GET  /admin/platform-settings                        platform_settings.view
//   GET  /admin/platform-settings/:group/history         platform_settings.view
//   PUT  /admin/platform-settings/:group                 platform_settings.manage
//   POST /admin/platform-settings/:group/reset           platform_settings.manage
//   POST /admin/platform-settings/:group/revert          platform_settings.manage
//
// And the system emails taking their sender name, signature and footer links
// from the email group.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const service = require('../../src/modules/platformSettings/platformSettingsService');
const { defaults } = require('../../src/modules/platformSettings/defaults');
const notify = require('../../src/modules/notifications/notify');
const brevoEmailProvider = require('../../src/modules/notifications/brevoEmailProvider');

const PUBLIC = '/api/v1/platform-settings/public';
const ADMIN = '/api/v1/admin/platform-settings';

// A right-to-left override and a bell: characters that must never reach a page.
const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);
// Look-alike secrets, put together here so no key-shaped text sits in the repo.
const FAKE_SECRETS = [
  ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlLW5vdC1yZWFs'].join('.'),
  ['sk', 'live', 'Z'.repeat(24)].join('_'),
  'password: ' + 'not-a-real-one',
  ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '),
  'AKIA' + 'Q'.repeat(16),
  'a1'.repeat(20),
];

const put = (who, group, body) => request(app).put(`${ADMIN}/${group}`).set(who.H).send(body);
const audits = () => db.AuditLog.findAll({ where: { entityType: 'platform_setting' }, order: [['createdAt', 'ASC']] });

const SOCIAL = {
  links: [
    { platform: 'youtube', url: 'https://www.youtube.com/@zimos', enabled: true },
    { platform: 'whatsapp', url: 'https://wa.me/201001234567?text=hi', enabled: true },
    { platform: 'linkedin', url: 'https://linkedin.com/company/zimos', enabled: false },
    { platform: 'email', url: 'mailto:Help@Zimos.co', enabled: true },
  ],
};
const CONTACT = {
  supportEmail: 'help@zimos.co',
  phone: '010 2364 1956',
  address: { ar: 'القاهرة، مصر', en: 'Cairo, Egypt' },
  hours: { ar: 'كل يوم', en: 'Every day' },
};

let creator;

beforeEach(async () => {
  env.platformSettings.enabled = true;
  creator = await makePlatformUser('creator');
});

afterEach(() => {
  env.platformSettings.enabled = false;
  service.setCacheMs(0);
  jest.restoreAllMocks();
});

describe('the public read', () => {
  it('needs no sign-in, sends null for every group never saved, never the email group, and is cacheable', async () => {
    const res = await request(app).get(PUBLIC);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(res.body).toEqual({ settings: { contact: null, social: null, company: null, footer: null } });
  });

  it('answers 404 like an unknown path while the flag is off', async () => {
    env.platformSettings.enabled = false;
    const res = await request(app).get(PUBLIC);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('sends a saved group: the links that are on, in their order, and nothing of the email group', async () => {
    expect((await put(creator, 'social', SOCIAL)).status).toBe(200);
    expect((await put(creator, 'email', { ...defaults().email, signature: { ar: 'فريق زيموس', en: 'The Zimos team' } })).status).toBe(200);
    const res = await request(app).get(PUBLIC);
    expect(res.body.settings.social).toEqual({
      links: [
        { platform: 'youtube', url: 'https://www.youtube.com/@zimos', enabled: true, order: 1 },
        { platform: 'whatsapp', url: 'https://wa.me/201001234567?text=hi', enabled: true, order: 2 },
        { platform: 'email', url: 'mailto:help@zimos.co', enabled: true, order: 3 },
      ],
    });
    expect(res.body.settings.contact).toBeNull();
    expect(res.body.settings).not.toHaveProperty('email');
    expect(JSON.stringify(res.body)).not.toContain('Zimos team');
  });
});

describe('the console page', () => {
  it('starts every group from the values the sites carry today, and says whether the flag is on', async () => {
    env.platformSettings.enabled = false;
    const res = await request(app).get(ADMIN).set(creator.H);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.groups.social).toEqual({ value: defaults().social, source: 'default', updatedAt: null, updatedBy: null });
    expect(res.body.groups.contact.value.supportEmail).toBe('zimossupport@gmail.com');
    expect(res.body.groups.email.value.senderName).toBe(env.notifications.brevo.fromName);
    expect(res.body.rules.socialDomains.whatsapp).toEqual(['wa.me']);
  });

  it('saves while the flag is off, and the public read still answers 404', async () => {
    env.platformSettings.enabled = false;
    expect((await put(creator, 'contact', CONTACT)).status).toBe(200);
    expect((await request(app).get(PUBLIC)).status).toBe(404);
  });

  it('shows who saved a group and when', async () => {
    await put(creator, 'footer', defaults().footer);
    const res = await request(app).get(ADMIN).set(creator.H);
    expect(res.body.groups.footer.source).toBe('saved');
    expect(res.body.groups.footer.updatedBy).toMatchObject({ id: creator.userId });
    expect(res.body.groups.footer.updatedAt).toEqual(expect.any(String));
  });
});

describe('who may read and write', () => {
  it('no one without the keys: an admin (not granted), an agent, a merchant, and no sign-in', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await makePlatformUser('agent');
    const merchant = await registerAndActivate();
    const merchantH = { H: { Authorization: `Bearer ${merchant.accessToken}` } };
    const answer = (res) => ({ status: res.status, code: res.body && res.body.error && res.body.error.code });
    for (const [name, who] of [['admin', admin], ['agent', agent], ['merchant', merchantH]]) {
      const forbidden = { status: 403, code: 'FORBIDDEN' };
      expect({ name, ...answer(await request(app).get(ADMIN).set(who.H)) }).toEqual({ name, ...forbidden });
      expect({ name, ...answer(await put(who, 'contact', CONTACT)) }).toEqual({ name, ...forbidden });
      expect({ name, ...answer(await request(app).post(`${ADMIN}/contact/reset`).set(who.H)) }).toEqual({ name, ...forbidden });
      expect({ name, ...answer(await request(app).get(`${ADMIN}/contact/history`).set(who.H)) }).toEqual({ name, ...forbidden });
    }
    expect((await request(app).put(`${ADMIN}/contact`).send(CONTACT)).status).toBe(401);
    expect(await db.PlatformSetting.count()).toBe(0);
  });

  it('an account granted the view key reads but cannot write; a body naming a role changes nothing', async () => {
    const viewer = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['platform_settings.view'] }, { where: { id: viewer.userId } });
    expect((await request(app).get(ADMIN).set(viewer.H)).status).toBe(200);
    const res = await put(viewer, 'contact', { ...CONTACT, platformRole: 'creator', role: 'creator' });
    expect(res.status).toBe(403);
  });

  it('refuses a group that does not exist', async () => {
    const res = await put(creator, 'secrets', { a: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('group');
  });
});

describe('the links', () => {
  const linkError = async (platform, url) => {
    const res = await put(creator, 'social', { links: [{ platform, url, enabled: true }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    return res.body.error.details[0].message;
  };

  it('refuses javascript:, data:, and every scheme but https (mailto for email)', async () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', 'http://instagram.com/zimos', 'ftp://instagram.com/x', '//instagram.com/x', 'instagram.com/zimos']) {
      expect(await linkError('instagram', url)).toMatch(/https/);
    }
    expect(await linkError('email', 'https://zimos.co')).toMatch(/mailto/);
    expect(await linkError('email', 'mailto:a@b.co?subject=hi')).toMatch(/one email address/);
    expect(await linkError('facebook', 'mailto:a@b.co')).toMatch(/https/);
  });

  it('refuses a domain off the allowlist, a lookalike, a user, a port and spaces', async () => {
    expect(await linkError('instagram', 'https://instagram.com.evil.example/x')).toMatch(/instagram\.com/);
    expect(await linkError('instagram', 'https://evil-instagram.com/x')).toMatch(/instagram\.com/);
    expect(await linkError('tiktok', 'https://instagram.com/x')).toMatch(/tiktok\.com/);
    expect(await linkError('youtube', 'https://linktr.ee/zimos')).toMatch(/youtube\.com or youtu\.be/);
    // (A user AND a password in a link is refused earlier, as a secret: see below.)
    expect(await linkError('x', 'https://someone@x.com/zimos')).toMatch(/user, a password or a port/);
    expect(await linkError('x', 'https://x.com:8443/zimos')).toMatch(/user, a password or a port/);
    expect(await linkError('linkedin', 'https://linkedin.com/in/a b')).toMatch(/spaces/);
  });

  it('takes WhatsApp as a wa.me link to a valid number only', async () => {
    for (const url of ['https://wa.me/+201001234567', 'https://wa.me/01001234567', 'https://wa.me/2010', 'https://wa.me/2010012345678901', 'https://wa.me/20100abc', 'https://wa.me/201001234567/x']) {
      expect(await linkError('whatsapp', url)).toMatch(/number/);
    }
    expect(await linkError('whatsapp', 'https://whatsapp.com/channel/x')).toMatch(/wa\.me/);
    expect(await linkError('whatsapp', 'https://wa.me/201001234567?phone=1')).toMatch(/text/);
  });

  it('refuses an unknown platform, the same platform twice, and a link that is on with no url', async () => {
    expect((await put(creator, 'social', { links: [{ platform: 'myspace', url: 'https://myspace.com/x', enabled: true }] })).status).toBe(422);
    const twice = await put(creator, 'social', {
      links: [
        { platform: 'x', url: 'https://x.com/a', enabled: true },
        { platform: 'x', url: 'https://twitter.com/b', enabled: false },
      ],
    });
    expect(twice.status).toBe(422);
    expect(twice.body.error.details[0].message).toMatch(/twice/);
    expect(await linkError('tiktok', '')).toMatch(/needs a url/);
    expect(await db.PlatformSetting.count()).toBe(0);
  });

  it('keeps a link that is off with no url, and an empty list hides every link', async () => {
    const res = await put(creator, 'social', { links: [{ platform: 'x', url: '', enabled: false }] });
    expect(res.status).toBe(200);
    expect(res.body.value).toEqual({ links: [{ platform: 'x', url: null, enabled: false }] });
    expect((await request(app).get(PUBLIC)).body.settings.social).toEqual({ links: [] });
  });
});

describe('the other fields', () => {
  it('stores the phone in international form and the email in lower case; refuses a wrong one', async () => {
    const res = await put(creator, 'contact', { ...CONTACT, supportEmail: 'Help@Zimos.CO' });
    expect(res.status).toBe(200);
    expect(res.body.value).toMatchObject({ supportEmail: 'help@zimos.co', phone: '+201023641956' });
    expect((await put(creator, 'contact', { ...CONTACT, phone: 'call us' })).status).toBe(422);
    expect((await put(creator, 'contact', { ...CONTACT, supportEmail: 'not an email' })).status).toBe(422);
  });

  it('keeps text as plain text: tags, control and direction-override characters go; spaces collapse', async () => {
    const res = await put(creator, 'footer', {
      tagline: { ar: '<script>alert(1)</script>تجارة   لغد', en: `Commerce${RLO}for <b>all</b>${BEL}` },
      rights: { ar: 'جميع الحقوق محفوظة.', en: 'All rights reserved.' },
    });
    expect(res.status).toBe(200);
    expect(res.body.value.tagline).toEqual({ ar: 'alert(1)تجارة لغد', en: 'Commercefor all' });
  });

  it('holds each text to its length, and refuses a required one left empty', async () => {
    const long = await put(creator, 'footer', { tagline: { ar: 'أ'.repeat(161), en: 'ok' }, rights: { ar: 'x', en: 'x' } });
    expect(long.status).toBe(422);
    expect(long.body.error.details[0].message).toMatch(/at most 160/);
    const empty = await put(creator, 'company', { ...defaults().company, legalName: { ar: '<b></b>', en: 'ZIMOS' } });
    expect(empty.status).toBe(422);
    expect(empty.body.error.details[0].message).toMatch(/must not be empty/);
    const blank = await put(creator, 'footer', { ...defaults().footer, rights: { ar: '', en: 'ok' } });
    expect(blank.status).toBe(422);
    expect(blank.body.error.details[0].field).toBe('rights.ar');
  });

  it('drops a field it does not know (stripUnknown) and keeps the rest', async () => {
    const res = await put(creator, 'company', { ...defaults().company, logoHtml: '<img>', extra: { a: 1 } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.value).sort()).toEqual(['legalName', 'platformName', 'registration', 'taxRegistration']);
  });

  it('refuses a sender name with quotes, angle brackets or a line break', async () => {
    for (const senderName of ['Zimos <x@y.z>', 'Zimos "Team"', 'Zimos\nBcc: x', '']) {
      expect((await put(creator, 'email', { ...defaults().email, senderName })).status).toBe(422);
    }
  });
});

describe('secrets are refused, never stored', () => {
  it('a field named like a secret, at any depth', async () => {
    for (const body of [
      { ...CONTACT, apiKey: 'abc' },
      { ...CONTACT, address: { ...CONTACT.address, password: 'x' } },
      { ...CONTACT, client_secret: 'x' },
      { ...CONTACT, BREVO_API_KEY: 'x' },
      { ...CONTACT, accessToken: 'x' },
    ]) {
      const res = await put(creator, 'contact', body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SECRET_NOT_ALLOWED');
    }
    expect(await db.PlatformSetting.count()).toBe(0);
  });

  it('a value that looks like a key, a token or a password', async () => {
    for (const text of FAKE_SECRETS) {
      const res = await put(creator, 'contact', { ...CONTACT, hours: { ar: text, en: 'Every day' } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SECRET_NOT_ALLOWED');
      expect(res.body.error.details[0].field).toBe('hours.ar');
    }
    const inLink = await put(creator, 'social', { links: [{ platform: 'x', url: 'https://u:p@x.com/a', enabled: true }] });
    expect(inLink.body.error.code).toBe('SECRET_NOT_ALLOWED');
    expect(await db.PlatformSetting.count()).toBe(0);
  });
});

describe('the audit trail and putting a value back', () => {
  it('writes every change with who, the old and the new value, and lists them newest first', async () => {
    const first = await put(creator, 'contact', CONTACT);
    expect(first.body).toMatchObject({ group: 'contact', changed: true, source: 'saved' });
    await put(creator, 'contact', { ...CONTACT, hours: { ar: '٩ - ٥', en: '9 - 5' } });

    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['platform_settings.update', 'platform_settings.update']);
    expect(rows[0]).toMatchObject({ actorUserId: creator.userId, entityId: 'contact', beforeState: null });
    expect(rows[0].metadata).toMatchObject({ group: 'contact', fromDefault: true });
    expect(rows[0].metadata.fields).toEqual(['address', 'hours', 'phone', 'supportEmail']);
    expect(rows[1].beforeState.hours).toEqual(CONTACT.hours);
    expect(rows[1].afterState.hours).toEqual({ ar: '٩ - ٥', en: '9 - 5' });
    expect(rows[1].metadata.fields).toEqual(['hours']);

    const res = await request(app).get(`${ADMIN}/contact/history`).set(creator.H);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({ action: 'update', fields: ['hours'], actor: { id: creator.userId } });
    expect(res.body.entries[0].before.hours).toEqual(CONTACT.hours);
  });

  it('writes nothing when the value is the same', async () => {
    await put(creator, 'contact', CONTACT);
    const again = await put(creator, 'contact', CONTACT);
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(await audits()).toHaveLength(1);
  });

  it('puts back the value before a change, audited as a revert', async () => {
    await put(creator, 'contact', CONTACT);
    await put(creator, 'contact', { ...CONTACT, hours: { ar: '٩ - ٥', en: '9 - 5' } });
    const [, second] = await audits();
    const res = await request(app).post(`${ADMIN}/contact/revert`).set(creator.H).send({ auditId: second.id });
    expect(res.status).toBe(200);
    expect(res.body.value.hours).toEqual(CONTACT.hours);
    const rows = await audits();
    expect(rows[2]).toMatchObject({ action: 'platform_settings.revert' });
    expect(rows[2].metadata.revertedAuditId).toBe(second.id);
    expect((await request(app).get(PUBLIC)).body.settings.contact.hours).toEqual(CONTACT.hours);
  });

  it('reverting a group’s first save takes it back to the values in the sites’ code', async () => {
    await put(creator, 'contact', CONTACT);
    const [first] = await audits();
    const res = await request(app).post(`${ADMIN}/contact/revert`).set(creator.H).send({ auditId: first.id });
    expect(res.body).toMatchObject({ source: 'default', value: defaults().contact });
    expect(await db.PlatformSetting.count()).toBe(0);
    expect((await request(app).get(PUBLIC)).body.settings.contact).toBeNull();
  });

  it('refuses a history entry of another group, or one that does not exist', async () => {
    await put(creator, 'contact', CONTACT);
    const [first] = await audits();
    expect((await request(app).post(`${ADMIN}/footer/revert`).set(creator.H).send({ auditId: first.id })).status).toBe(404);
    expect((await request(app).post(`${ADMIN}/contact/revert`).set(creator.H).send({ auditId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await request(app).post(`${ADMIN}/contact/revert`).set(creator.H).send({ auditId: 'x' })).status).toBe(422);
  });

  it('resets a group to the defaults: its row goes, the old value stays in the log', async () => {
    await put(creator, 'contact', CONTACT);
    const res = await request(app).post(`${ADMIN}/contact/reset`).set(creator.H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, source: 'default' });
    const rows = await audits();
    expect(rows[1]).toMatchObject({ action: 'platform_settings.reset', afterState: null });
    expect(rows[1].beforeState.supportEmail).toBe('help@zimos.co');
    expect((await request(app).post(`${ADMIN}/contact/reset`).set(creator.H)).body.changed).toBe(false);
  });
});

describe('the cache', () => {
  it('serves the public read from memory for its minute, and a save in the console drops it at once', async () => {
    service.setCacheMs(60 * 1000);
    await put(creator, 'footer', defaults().footer);
    expect((await request(app).get(PUBLIC)).body.settings.footer.tagline.en).toBe('Commerce for a brighter tomorrow.');

    // A change that bypasses the service is not seen until the cache runs out…
    const changed = { ...defaults().footer, tagline: { ar: 'جديد', en: 'Changed behind its back' } };
    await db.PlatformSetting.update({ value: changed }, { where: { key: 'footer' } });
    expect((await request(app).get(PUBLIC)).body.settings.footer.tagline.en).toBe('Commerce for a brighter tomorrow.');

    // …a save through the console is seen on the next read.
    await put(creator, 'footer', { ...defaults().footer, tagline: { ar: 'أحدث', en: 'Saved in the console' } });
    expect((await request(app).get(PUBLIC)).body.settings.footer.tagline.en).toBe('Saved in the console');
  });
});

describe('the system emails', () => {
  async function sendWithBrevo(template, data) {
    const original = env.notifications.emailProvider;
    env.notifications.emailProvider = 'brevo';
    const sent = jest.spyOn(brevoEmailProvider, 'sendEmail').mockResolvedValue({ messageId: 'test', attempts: 1 });
    try {
      await notify.email({ recipient: 'merchant@zimos.test', template, data });
      return sent.mock.calls[0][0];
    } finally {
      env.notifications.emailProvider = original;
    }
  }

  const EMAIL = {
    senderName: 'Zimos Support',
    signature: { ar: 'فريق زيموس', en: 'The Zimos team\nTanta, Egypt' },
    footer: { showSupportEmail: true, showSocialLinks: true },
  };
  const RESET = { name: 'Mona', url: 'https://app.zimos.test/reset?t=1', minutes: 30, locale: 'en' };

  it('go out exactly as before while the email group was never saved', async () => {
    const mail = await sendWithBrevo('password_reset', RESET);
    expect(mail.fromName).toBeUndefined();
    expect(mail.html).not.toContain('Zimos team');
  });

  it('take the console’s sender name, signature and footer links', async () => {
    await put(creator, 'contact', CONTACT);
    await put(creator, 'social', SOCIAL);
    await put(creator, 'email', EMAIL);
    const mail = await sendWithBrevo('password_reset', RESET);
    expect(mail.fromName).toBe('Zimos Support');
    expect(mail.html).toContain('The Zimos team<br />Tanta, Egypt');
    expect(mail.html).toContain('href="mailto:help@zimos.co"');
    expect(mail.html).toContain('href="https://www.youtube.com/@zimos"');
    expect(mail.html).not.toContain('linkedin');
    expect(mail.text).toContain('Support: help@zimos.co');
  });

  it('never on a store’s email to its shopper, which keeps the store’s own sender name', async () => {
    await put(creator, 'email', EMAIL);
    const mail = await sendWithBrevo('order_email', { subject: 'Your order', body: 'Thanks', storeName: 'Mona Shop', fromName: 'Mona Shop' });
    expect(mail.fromName).toBe('Mona Shop');
    expect(mail.html).not.toContain('Zimos team');
    expect(mail.html).not.toContain('mailto:');
  });

  it('go out as before while the flag is off, even with the group saved', async () => {
    await put(creator, 'email', EMAIL);
    env.platformSettings.enabled = false;
    const mail = await sendWithBrevo('password_reset', RESET);
    expect(mail.fromName).toBeUndefined();
    expect(mail.html).not.toContain('Zimos team');
  });
});
