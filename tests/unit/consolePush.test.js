'use strict';

// Who a console notification reaches on their devices (platformAdmin/consolePush.js
// recipientsOf: the bell's own rules), the text each type sends (pushPayload's
// "console." entries), and the console's shortcut rows (consoleShortcuts.js).

const pushPayload = require('../../src/modules/notifications/push/pushPayload');
const { TYPES } = require('../../src/modules/platformAdmin/platformNotificationService');
const { recipientsOf, pushTypeOf } = require('../../src/modules/platformAdmin/consolePush');
const consoleShortcuts = require('../../src/modules/platformAdmin/consoleShortcuts');
const { PLATFORM_PERMISSIONS: P, ALL_PLATFORM_PERMISSIONS } = require('../../src/core/security/platformPermissions');

const account = (id, keys, role = 'admin') => ({ id, platformRole: role, platformPermissions: keys });
const SUPPORT = account('a-support', [P.SUPPORT_VIEW]);
const STORES = account('a-stores', [P.WORKSPACES_VIEW]);
const REVIEWER = account('a-reviewer', [P.REFERRAL_CODES_APPROVE]);
const AUTHOR = account('a-author', [P.REFERRAL_CODES_APPROVE]);
const CREATOR = account('a-creator', [], 'creator');
const ALL = [SUPPORT, STORES, REVIEWER, AUTHOR, CREATOR];

describe('recipientsOf', () => {
  it("the type's permission decides; a creator holds every one", () => {
    expect(recipientsOf({ type: 'support_ticket' }, ALL)).toEqual(['a-support', 'a-creator']);
    expect(recipientsOf({ type: 'workspace_created' }, ALL)).toEqual(['a-stores', 'a-creator']);
  });

  it('never the account that did it', () => {
    expect(recipientsOf({ type: 'support_ticket', actorUserId: 'a-support' }, ALL)).toEqual(['a-creator']);
  });

  it("a row's recipients narrow it, and its hidden accounts are left out, a creator aside", () => {
    expect(recipientsOf({ type: 'referral_code_review', hiddenFromUserIds: ['a-author', 'a-creator'] }, ALL)).toEqual(['a-reviewer', 'a-creator']);
    expect(recipientsOf({ type: 'referral_code_review', recipientUserIds: ['a-author'] }, ALL)).toEqual(['a-author']);
  });

  it('a type turned off in the bell or for devices reaches nobody of those', () => {
    const prefs = new Map([
      ['a-support', { enabled: true, push: false }],
      ['a-creator', { enabled: false, push: null }],
    ]);
    expect(recipientsOf({ type: 'support_ticket' }, ALL, prefs)).toEqual([]);
    expect(recipientsOf({ type: 'support_ticket' }, ALL, new Map([['a-support', { enabled: true, push: null }]]))).toEqual(['a-support', 'a-creator']);
  });
});

describe('the text of every console type', () => {
  const pushTypes = new Set();
  for (const type of TYPES) {
    for (const data of [{}, { decision: 'approved', change: 'new' }, { decision: 'rejected', change: 'change' }]) pushTypes.add(pushTypeOf({ type, data }));
  }

  it.each([...pushTypes])('%s: a sentence in Arabic and English, with and without its code', (type) => {
    for (const locale of ['ar', 'en']) {
      const one = JSON.parse(pushPayload.build(type, { locale, params: { code: 'NILE10' }, url: '/tickets/1' }));
      expect(one).toMatchObject({ v: 1, type, title: 'Zimos', url: '/tickets/1', count: 1 });
      expect(one.body.length).toBeGreaterThan(3);
      const bare = JSON.parse(pushPayload.build(type, { locale, params: { code: 'not a code!' } }));
      expect(bare.body).not.toContain('not a code');
    }
  });

  it('a decided review takes its decision', () => {
    expect(pushTypeOf({ type: 'referral_code_decided', data: { decision: 'rejected', change: 'change' } })).toBe('console.referral_change_rejected');
    expect(pushTypeOf({ type: 'agent_link_decided', data: { decision: 'approved' } })).toBe('console.agent_link_approved');
  });
});

describe("the console's shortcut rows", () => {
  it('ask only for permissions that exist, with stable ids', () => {
    for (const entry of consoleShortcuts.CONSOLE_SHORTCUT_CATALOG) {
      expect(entry.id).toMatch(/^[a-z][a-z_]*[a-z]$/);
      for (const key of entry.requires) expect(ALL_PLATFORM_PERMISSIONS).toContain(key);
    }
    for (const row of Object.values(consoleShortcuts.ROWS)) for (const id of row.defaults) expect(consoleShortcuts.CONSOLE_SHORTCUT_IDS).toContain(id);
  });

  it("offer and show only the pages the account opens; the defaults narrow to them, eight at most", () => {
    const agent = account('agent', [P.REFERRALS_VIEW_OWN], 'agent');
    expect(consoleShortcuts.rowFor('home', agent, null)).toMatchObject({ customized: false, shortcuts: ['my_referrals', 'notifications'] });
    expect(consoleShortcuts.rowFor('home', agent, ['admin_users', 'notifications']).shortcuts).toEqual(['notifications']);
    expect(consoleShortcuts.rowFor('home', CREATOR, null).shortcuts).toHaveLength(8);
    expect(consoleShortcuts.rowFor('mobileNav', CREATOR, null).shortcuts).toEqual(['overview', 'workspaces', 'subscriptions', 'tickets']);
    expect(consoleShortcuts.rowFor('mobileNav', STORES, []).shortcuts).toEqual([]);
  });
});
