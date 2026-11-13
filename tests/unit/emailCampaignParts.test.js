'use strict';

// Email campaigns, the parts that need no store: the unsubscribe token, the
// quota's refusal, the block and audience checks, and the email the blocks
// render to (escaping, links, direction, the per-recipient unsubscribe link).

const tokens = require('../../src/modules/emailCampaigns/campaignTokens');
const quota = require('../../src/modules/emailCampaigns/campaignQuota');
const { blocksSchema, audienceSchema } = require('../../src/modules/emailCampaigns/campaignValidation');
const content = require('../../src/modules/emailCampaigns/campaignContent');

const WS = '11111111-1111-4111-8111-111111111111';
const RID = '22222222-2222-4222-8222-222222222222';
const BRAND = { name: 'Nour & Co <Store>', logoUrl: null, color: '#ffd400', origin: 'https://nour.zimos.test', currency: 'EGP' };

describe('the unsubscribe token', () => {
  it('names its store and recipient, and nothing else reads as one', () => {
    const token = tokens.tokenFor(WS, RID);
    expect(token.startsWith('c1.')).toBe(true);
    expect(tokens.readToken(token)).toEqual({ workspaceId: WS, recipientId: RID });
    expect(tokens.isCampaignToken(token)).toBe(true);
  });

  it('refuses an altered, re-signed, truncated or foreign token', () => {
    const token = tokens.tokenFor(WS, RID);
    const [, payload, sig] = token.split('.');
    const swapped = Buffer.from(`${WS}.33333333-3333-4333-8333-333333333333`).toString('base64url');
    expect(tokens.readToken(`c1.${swapped}.${sig}`)).toBeNull();
    expect(tokens.readToken(`c1.${payload}.${sig.slice(0, -1)}x`)).toBeNull();
    expect(tokens.readToken(`c1.${payload}`)).toBeNull();
    expect(tokens.readToken(`c1.${payload}.${sig}.extra`)).toBeNull();
    expect(tokens.readToken(token.slice(3))).toBeNull();
    expect(tokens.readToken(null)).toBeNull();
    const notUuid = Buffer.from('ws.recipient').toString('base64url');
    expect(tokens.readToken(`c1.${notUuid}.${sig}`)).toBeNull();
  });

  it('links to the store’s own page, and the one-click address to the API', () => {
    const token = tokens.tokenFor(WS, RID);
    expect(tokens.pageLink('https://nour.zimos.test', token)).toBe(`https://nour.zimos.test/unsubscribe?t=${encodeURIComponent(token)}`);
    expect(tokens.pageLink('', token)).toBeNull();
    expect(tokens.oneClickLink(token)).toMatch(/\/api\/v1\/email-campaigns\/unsubscribe\?t=c1\./);
  });
});

describe('the monthly quota', () => {
  const month = (max, used) => ({ max, used, remaining: max === null ? null : Math.max(0, max - used), resetsAt: new Date() });
  it('lets a campaign through that fits, and refuses one that does not, whole', () => {
    expect(quota.overQuota(month(100, 40), 60)).toBeNull();
    expect(quota.overQuota(month(null, 1e6), 1e6)).toBeNull();
    const refused = quota.overQuota(month(100, 40), 61);
    expect(refused.code).toBe('EMAIL_QUOTA_EXCEEDED');
    expect(refused.statusCode).toBe(422);
    expect(refused.details).toEqual(expect.objectContaining({ needed: 61, remaining: 60, max: 100, used: 40 }));
    expect(quota.overQuota(month(0, 0), 1).message).toBe('Your plan does not include email campaigns this month');
  });
});

describe('the checks', () => {
  it('takes the six blocks and nothing else', () => {
    const ok = [
      { type: 'heading', text: 'Hi', size: 'md', align: 'center' },
      { type: 'text', text: 'Body' },
      { type: 'image', url: 'https://cdn.example.com/a.png', alt: 'A', link: 'https://example.com', width: 300 },
      { type: 'button', label: 'Go', url: 'https://example.com', color: '#112233' },
      { type: 'products', productIds: [WS], showPrice: false },
      { type: 'divider' },
    ];
    expect(blocksSchema.validate(ok).error).toBeUndefined();
    for (const bad of [
      [{ type: 'html', html: '<b>x</b>' }],
      [{ type: 'button', label: 'Go', url: 'javascript:alert(1)' }],
      [{ type: 'image', url: '//cdn.example.com/a.png' }],
      [{ type: 'button', label: 'Go', url: 'https://x.com', color: 'red' }],
      [{ type: 'products', productIds: [WS, WS] }],
      [{ type: 'divider', text: 'x' }],
      Array.from({ length: 41 }, () => ({ type: 'divider' })),
    ]) {
      expect(blocksSchema.validate(bad).error).toBeDefined();
    }
  });

  it('takes the four audiences', () => {
    expect(audienceSchema.validate({ type: 'all' }).error).toBeUndefined();
    expect(audienceSchema.validate({ type: 'segment', segmentId: WS }).error).toBeUndefined();
    expect(audienceSchema.validate({ type: 'rfm', labels: ['champions', 'loyal'] }).error).toBeUndefined();
    expect(audienceSchema.validate({ type: 'rules', rules: { minOrders: 2, minSpent: 50000 } }).error).toBeUndefined();
    expect(audienceSchema.validate({ type: 'rules', rules: {} }).error).toBeDefined();
    expect(audienceSchema.validate({ type: 'rfm', labels: ['vip'] }).error).toBeDefined();
    expect(audienceSchema.validate({ type: 'all', segmentId: WS }).error).toBeDefined();
  });
});

describe('the email', () => {
  const render = (campaign) => content.render(WS, { subject: 'Sale', blocks: [], locale: 'ar', ...campaign }, { brand: BRAND });

  it('escapes everything the merchant typed and keeps only http(s) links', async () => {
    const email = await render({
      subject: 'Big <sale>\r\nBcc: x@y.z',
      blocks: [
        { type: 'heading', text: '<script>alert(1)</script>' },
        { type: 'text', text: 'Visit https://nour.example/a?b=1 now\n\nSecond "para"' },
        { type: 'button', label: 'Go <now>', url: 'javascript:alert(1)' },
        { type: 'image', url: 'https://cdn.example.com/x.png', alt: '"onerror="x', link: 'data:text/html,x' },
      ],
    });
    expect(email.subject).toBe('Big <sale> Bcc: x@y.z');
    expect(email.html).not.toMatch(/<script/i);
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('<a href="https://nour.example/a?b=1"');
    expect(email.html).not.toContain('javascript:');
    expect(email.html).not.toContain('data:text/html');
    expect(email.html).toContain('alt="&quot;onerror=&quot;x"');
    expect(email.html).toContain('Nour &amp; Co &lt;Store&gt;');
    expect(email.text).toContain('Second "para"');
  });

  it('is right-to-left in Arabic and left-to-right in English, aligned to match', async () => {
    const ar = await render({ blocks: [{ type: 'text', text: 'مرحبا', align: 'start' }] });
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.html).toContain('text-align:right');
    const en = await render({ locale: 'en', blocks: [{ type: 'text', text: 'Hello', align: 'start' }] });
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    expect(en.html).toContain('text-align:left');
    expect(en.html).toContain('Unsubscribe');
    expect(content.alignOf('end', 'rtl')).toBe('left');
    expect(content.alignOf('center', 'ltr')).toBe('center');
  });

  it('fills each recipient’s unsubscribe link, never text the merchant typed', async () => {
    const email = await render({ preheader: 'Only today', blocks: [{ type: 'text', text: '__unsub_deadbeef__ #' }] });
    const one = email.withLink('https://nour.zimos.test/unsubscribe?t=c1.a.b');
    expect(one.html).toContain('href="https://nour.zimos.test/unsubscribe?t=c1.a.b"');
    expect(one.html).toContain('__unsub_deadbeef__ #');
    expect(one.text).toContain('https://nour.zimos.test/unsubscribe?t=c1.a.b');
    expect(one.html).toContain('Only today');
    expect(email.withLink('javascript:alert(1)').html).not.toContain('javascript:');
  });

  it('puts a readable ink on the button whatever the store colour', () => {
    expect(content.inkOn('#ffd400')).toBe('#18181b');
    expect(content.inkOn('#1e3a8a')).toBe('#ffffff');
    expect(content.inkOn('#ffffff')).toBe('#18181b');
    expect(content.inkOn('#000000')).toBe('#ffffff');
  });
});
