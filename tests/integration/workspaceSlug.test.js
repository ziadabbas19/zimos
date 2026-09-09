'use strict';

// Every workspace is reachable at `<slug>.zimos.co` through the storefront
// proxy, so `workspaces.slug` carries a DB-level unique constraint. Two
// merchants picking the same store *name* must still each get a usable
// subdomain: the slug is auto-suffixed, and the race between two simultaneous
// signups with the same name is absorbed by a retry-on-unique-index loop
// rather than failing one of the signups.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

// Same shape the public storefront/cart routes accept as a slug.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

describe('workspace slug uniqueness', () => {
  it('two workspaces created with the same name get two different, valid slugs', async () => {
    const owner = await registerAndActivate();

    const first = await createWorkspace(owner.accessToken, 'Cairo Coffee House');
    const second = await createWorkspace(owner.accessToken, 'Cairo Coffee House');

    expect(first.slug).toBe('cairo-coffee-house');
    expect(second.slug).toBe('cairo-coffee-house-2');
    expect(second.slug).not.toBe(first.slug);
    expect(first.slug).toMatch(SLUG_PATTERN);
    expect(second.slug).toMatch(SLUG_PATTERN);
  });

  it('keeps slugs unique and valid when the same name is submitted concurrently', async () => {
    const owner = await registerAndActivate();
    const name = 'Simultaneous Signup Store';

    // Fire several workspace creations with the identical name at once: they
    // all pass the pre-check against an empty table, then collide on the
    // unique index and fall through to the retry loop.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post('/api/v1/workspaces')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ name })
      )
    );

    expect(results.every((r) => r.status === 201)).toBe(true);

    const slugs = results.map((r) => r.body.workspace.slug);
    expect(slugs.every((s) => SLUG_PATTERN.test(s))).toBe(true);
    expect(new Set(slugs).size).toBe(slugs.length); // all distinct

    // The DB unique index agrees: every row landed, every slug is unique.
    const rows = await db.Workspace.findAll({ where: { name }, attributes: ['slug'] });
    expect(rows.length).toBe(slugs.length);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
    expect(rows.every((r) => SLUG_PATTERN.test(r.slug))).toBe(true);
  });
});
