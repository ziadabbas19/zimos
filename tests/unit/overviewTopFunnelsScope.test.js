'use strict';

// The breakdown queries, captured instead of run: this file loads no models.
jest.mock('../../src/db/models', () => ({ Sequelize: { Op: {}, QueryTypes: {} }, sequelize: {} }));

const { collectBreakdowns } = require('../../src/modules/analytics/overviewService');

// The dashboard's "top funnels" list (analytics/overviewService): an order may
// carry the id of a funnel that belongs to another store, and that funnel's
// name must not be read into this store's dashboard.
describe('overview top funnels', () => {
  async function queries() {
    const run = jest.fn(async () => []);
    const breakdowns = await collectBreakdowns({ ORDERS: 'SELECT 1', EVENTS: 'SELECT 1', run });
    return { sql: run.mock.calls.map(([text]) => text), breakdowns };
  }

  it('joins funnels of this store only', async () => {
    const { sql } = await queries();
    const funnelQueries = sql.filter((text) => /JOIN funnels f\b/.test(text));
    expect(funnelQueries).toHaveLength(1);
    expect(funnelQueries[0]).toMatch(/JOIN funnels f ON f\.id = ord\.funnel_id AND f\.workspace_id = :workspaceId/);
  });

  it('every table it joins by id is bound to the store', async () => {
    const { sql } = await queries();
    // No breakdown reads a tenant table through a bare id join.
    for (const text of sql) {
      for (const [, table, alias] of text.matchAll(/JOIN (funnels|analytics_events|analytics_sessions) (\w+)\b/g)) {
        expect(text).toMatch(new RegExp(`${alias}\\.workspace_id = `));
        expect(table).toEqual(expect.any(String));
      }
    }
  });

  it('gives an empty list when no funnel of the store sold', async () => {
    const { breakdowns } = await queries();
    expect(breakdowns.topFunnels).toEqual([]);
  });
});
