'use strict';

// The Home shortcuts catalogue and its rules (dashboard/homeShortcuts.js).

const env = require('../../src/config/env');
const { SYSTEM_ROLES, ALL_PERMISSIONS } = require('../../src/core/security/permissions');
const {
  HOME_SHORTCUT_CATALOG,
  HOME_SHORTCUT_IDS,
  DEFAULT_HOME_SHORTCUTS,
  MAX_HOME_SHORTCUTS,
  allowedIds,
  forMember,
} = require('../../src/modules/dashboard/homeShortcuts');

const tenantWith = (permissions, homeShortcuts = null) => ({
  membership: { homeShortcuts },
  hasPermission: (permission) => permissions.includes('*') || permissions.includes(permission),
});
const OPEN_PLAN = { features: [], enforced: false, growthEnforced: false };

describe('the catalogue', () => {
  it('has stable, unique ids of one shape', () => {
    expect(new Set(HOME_SHORTCUT_IDS).size).toBe(HOME_SHORTCUT_IDS.length);
    for (const id of HOME_SHORTCUT_IDS) expect(id).toMatch(/^[a-z][a-z_]*[a-z]$/);
  });

  it('asks only for permissions that exist', () => {
    for (const entry of HOME_SHORTCUT_CATALOG) {
      for (const permission of entry.requires) expect(ALL_PERMISSIONS).toContain(permission);
    }
  });

  it('holds every page the brief names, and the two actions', () => {
    expect(HOME_SHORTCUT_IDS).toEqual(
      expect.arrayContaining([
        'new_order',
        'add_product',
        'orders',
        'products',
        'customers',
        'reviews',
        'questions',
        'discounts',
        'media',
        'analytics',
        'web_analytics',
        'website',
        'store_settings',
        'confirmation_queue',
        'lost_orders',
        'returns',
        'fraud',
        'size_charts',
        'digital_products',
        'courses',
      ])
    );
  });

  it('keeps the default row exactly as Home always had it, in its order', () => {
    expect(DEFAULT_HOME_SHORTCUTS).toEqual(['new_order', 'add_product', 'confirmation_queue', 'orders', 'lost_orders', 'discounts', 'website', 'store_settings']);
    for (const id of DEFAULT_HOME_SHORTCUTS) expect(HOME_SHORTCUT_IDS).toContain(id);
    expect(DEFAULT_HOME_SHORTCUTS.length).toBeLessThanOrEqual(MAX_HOME_SHORTCUTS);
    expect(MAX_HOME_SHORTCUTS).toBe(12);
  });

  it('no default entry hangs on a plan or a switch, so the row is the same on every plan', () => {
    for (const id of DEFAULT_HOME_SHORTCUTS) {
      const entry = HOME_SHORTCUT_CATALOG.find((e) => e.id === id);
      expect(entry.plan).toBeUndefined();
      expect(entry.on).toBeUndefined();
    }
  });
});

describe('what each role gets by default', () => {
  // What the row's old filter (the side menu's rule for each page) left for each system role.
  const EXPECTED = {
    owner: ['new_order', 'add_product', 'confirmation_queue', 'orders', 'lost_orders', 'discounts', 'website', 'store_settings'],
    workspace_manager: ['new_order', 'add_product', 'confirmation_queue', 'orders', 'lost_orders', 'discounts', 'website', 'store_settings'],
    editor: ['add_product', 'website', 'store_settings'],
    order_operator: ['new_order', 'add_product', 'confirmation_queue', 'orders', 'lost_orders'],
    confirmation_agent: ['new_order', 'confirmation_queue', 'orders', 'lost_orders'],
    accountant: ['new_order', 'orders', 'lost_orders'],
  };

  it.each(Object.keys(EXPECTED))('%s', (role) => {
    const answer = forMember(tenantWith(SYSTEM_ROLES[role].permissions), OPEN_PLAN);
    expect(answer.customized).toBe(false);
    expect(answer.shortcuts).toEqual(EXPECTED[role]);
    expect(answer.defaults).toEqual(EXPECTED[role]);
    expect(answer.max).toBe(12);
  });
});

describe('forMember', () => {
  it('keeps the member\'s order and shows what they may open', () => {
    const answer = forMember(tenantWith(['*'], ['orders', 'new_order', 'customers']), OPEN_PLAN);
    expect(answer.customized).toBe(true);
    expect(answer.shortcuts).toEqual(['orders', 'new_order', 'customers']);
  });

  it('hides what the role has lost and what the catalogue no longer holds, without touching the stored list', () => {
    const stored = ['customers', 'orders', 'gone_from_catalogue'];
    const tenant = tenantWith(['orders.view'], stored);
    expect(forMember(tenant, OPEN_PLAN).shortcuts).toEqual(['orders']);
    expect(tenant.membership.homeShortcuts).toEqual(stored);
  });

  it('an empty list is the member\'s choice, not the default row', () => {
    const answer = forMember(tenantWith(['*'], []), OPEN_PLAN);
    expect(answer.customized).toBe(true);
    expect(answer.shortcuts).toEqual([]);
  });

  it('shows a stored list with a repeated id once', () => {
    expect(forMember(tenantWith(['*'], ['orders', 'orders']), OPEN_PLAN).shortcuts).toEqual(['orders']);
  });
});

describe('allowedIds', () => {
  afterEach(() => {
    env.storeFeatures.length = 0;
  });

  it('an entry open to any member is open to a role with nothing', () => {
    const none = allowedIds(tenantWith([]), OPEN_PLAN);
    expect(none).toEqual(['fraud', 'settings', 'services', 'suggestions']);
  });

  it('one permission of several is enough', () => {
    expect(allowedIds(tenantWith(['orders.manage']), OPEN_PLAN)).toContain('confirmation_queue');
    expect(allowedIds(tenantWith(['orders.confirm']), OPEN_PLAN)).toContain('confirmation_queue');
    expect(allowedIds(tenantWith(['tax.manage']), OPEN_PLAN)).toContain('shipping');
  });

  it('a page behind a switch of this deploy is out while the switch is off', () => {
    const owner = tenantWith(['*']);
    for (const id of ['questions', 'size_charts', 'gift_cards', 'blog', 'loyalty', 'ai_studio']) expect(allowedIds(owner, OPEN_PLAN)).not.toContain(id);
    env.storeFeatures.push('size_charts', 'store_credit');
    const on = allowedIds(owner, OPEN_PLAN);
    expect(on).toContain('size_charts');
    // Rewards are one entry, there while any of its programmes is on.
    expect(on).toContain('loyalty');
    expect(on).not.toContain('questions');
  });

  describe('the plan', () => {
    const owner = tenantWith(['*']);

    it('locks nothing while the gate is off', () => {
      expect(allowedIds(owner, OPEN_PLAN)).toEqual(expect.arrayContaining(['reviews', 'web_analytics', 'realtime', 'visitors']));
    });

    it('with the gate on, a plan without the key loses those pages and no others', () => {
      const allowed = allowedIds(owner, { features: [], enforced: true, growthEnforced: true });
      for (const id of ['reviews', 'web_analytics', 'realtime', 'visitors']) expect(allowed).not.toContain(id);
      for (const id of DEFAULT_HOME_SHORTCUTS) expect(allowed).toContain(id);
    });

    it('a plan with the key keeps them', () => {
      const allowed = allowedIds(owner, { features: ['reviews', 'advanced_analytics'], enforced: true, growthEnforced: true });
      expect(allowed).toEqual(expect.arrayContaining(['reviews', 'web_analytics', 'realtime', 'visitors']));
    });

    it('reviews follow their own switch: the plain gate alone does not lock them', () => {
      const allowed = allowedIds(owner, { features: [], enforced: true, growthEnforced: false });
      expect(allowed).toContain('reviews');
      expect(allowed).not.toContain('web_analytics');
    });
  });
});
