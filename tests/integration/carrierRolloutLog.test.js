'use strict';

// What the logs say about the courier rollout: the boot line with the parsed
// CARRIERS_* lists and their warnings (quoted values, unknown codes, beta
// slugs that match no store), and the GET /carriers line with the slug the
// store was decided on.

const crypto = require('crypto');
const { setupWorkspaceWithProduct } = require('../helpers/factories');
const env = require('../../src/config/env');
const logger = require('../../src/core/utils/logger');
const carriers = require('../../src/modules/shipping/carriers');
const fakes = require('../helpers/fakeCarriers');

const original = { ...env.carriers };
let uninstall;

beforeAll(() => {
  env.carriers.credentialsKey = crypto.randomBytes(32).toString('base64');
});

afterEach(() => {
  if (uninstall) uninstall();
  uninstall = null;
  Object.assign(env.carriers, original, { credentialsKey: env.carriers.credentialsKey });
  jest.restoreAllMocks();
});

afterAll(() => {
  env.carriers.credentialsKey = original.credentialsKey;
});

function setRollout({ enabled = ['bosta'], beta = [], betaWorkspaces = [] }) {
  Object.assign(env.carriers, { enabled, beta, betaWorkspaces });
}

describe('describeRollout', () => {
  it('reports the parsed lists, the registered codes and what is on, with no warnings when all is well', () => {
    setRollout({ beta: ['mylerz', 'jtexpress'], betaWorkspaces: ['mj'] });
    const report = carriers.describeRollout({ existingSlugs: ['mj'] });
    expect(report).toEqual({
      enabled: ['bosta'],
      beta: ['mylerz', 'jtexpress'],
      betaWorkspaces: ['mj'],
      registered: ['bosta', 'mylerz', 'jtexpress'],
      active: ['bosta', 'mylerz', 'jtexpress'],
      warnings: [],
    });
  });

  it('flags a value typed with quotes, which switches the beta carriers off', () => {
    // CARRIERS_BETA="mylerz,jtexpress" with the quotes kept by the env editor.
    setRollout({ beta: ['"mylerz', 'jtexpress"'], betaWorkspaces: ['"mj"'] });
    const report = carriers.describeRollout({ existingSlugs: [] });
    expect(report.active).toEqual(['bosta']);
    expect(report.warnings).toEqual([
      'CARRIERS_BETA entry "\\"mylerz" contains a quote character; set the variable without quotes',
      'CARRIERS_BETA entry "jtexpress\\"" contains a quote character; set the variable without quotes',
      'CARRIERS_BETA_WORKSPACES entry "\\"mj\\"" contains a quote character; set the variable without quotes',
    ]);
  });

  it('flags typographic quotes and other stray characters too', () => {
    setRollout({ beta: ['“mylerz”', 'jt​express'], betaWorkspaces: ['mj'] });
    const { warnings } = carriers.describeRollout();
    expect(warnings[0]).toMatch(/CARRIERS_BETA entry .*mylerz.* contains a quote character/);
    expect(warnings[1]).toMatch(/CARRIERS_BETA entry .*express.* contains unexpected characters/);
  });

  it('flags a code no adapter is registered under', () => {
    setRollout({ enabled: ['bosta', 'aramex'], beta: ['jt-express'], betaWorkspaces: ['mj'] });
    expect(carriers.describeRollout().warnings).toEqual([
      'CARRIERS_ENABLED entry "aramex" is not a registered carrier (registered: bosta, mylerz, jtexpress)',
      'CARRIERS_BETA entry "jt-express" is not a registered carrier (registered: bosta, mylerz, jtexpress)',
    ]);
  });

  it('flags beta carriers with no beta stores', () => {
    setRollout({ beta: ['mylerz'] });
    expect(carriers.describeRollout().warnings).toEqual([
      'CARRIERS_BETA is set but CARRIERS_BETA_WORKSPACES is empty: no store sees the beta carriers',
    ]);
  });
});

describe('logRollout (boot)', () => {
  it('logs the config once and warns for every beta slug that matches no workspace', async () => {
    const { workspace } = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });
    const slug = String(workspace.slug).toLowerCase();
    setRollout({ beta: ['mylerz'], betaWorkspaces: [slug, 'no-such-store'] });
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await carriers.logRollout(logger);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Carrier rollout', {
      enabled: ['bosta'],
      beta: ['mylerz'],
      betaWorkspaces: [slug, 'no-such-store'],
      registered: ['bosta', 'mylerz', 'jtexpress'],
      active: ['bosta', 'mylerz'],
    });
    expect(warn.mock.calls).toEqual([
      ['Carrier rollout: CARRIERS_BETA_WORKSPACES entry "no-such-store" matches no workspace slug'],
    ]);
  });

  it('matches slugs case-insensitively, as the gate does', async () => {
    const { workspace } = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });
    setRollout({ beta: ['mylerz'], betaWorkspaces: [String(workspace.slug).toLowerCase()] });
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await carriers.logRollout(logger);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('GET /carriers', () => {
  it('logs the slug it looked up and the carrier codes it answered with', async () => {
    uninstall = fakes.installFakeCarriers({ beta: true });
    const setup = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });
    const slug = String(setup.workspace.slug).toLowerCase();
    env.carriers.betaWorkspaces = [slug];
    const info = jest.spyOn(logger, 'info');

    const res = await fakes.api(setup.auth.accessToken).list(setup.workspace.id);
    expect(res.status).toBe(200);

    const listed = info.mock.calls.filter(([message]) => message === 'Carriers listed');
    expect(listed).toEqual([
      ['Carriers listed', { workspaceId: setup.workspace.id, slug, inBeta: true, carriers: ['bosta', 'fakepoll', 'fakemanual'] }],
    ]);
  });

  it('logs the slug for a store outside the beta, and with no beta configured at all', async () => {
    const setup = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });
    const slug = String(setup.workspace.slug).toLowerCase();
    const info = jest.spyOn(logger, 'info');

    await fakes.api(setup.auth.accessToken).list(setup.workspace.id);

    expect(info.mock.calls.filter(([message]) => message === 'Carriers listed')).toEqual([
      ['Carriers listed', { workspaceId: setup.workspace.id, slug, inBeta: false, carriers: ['bosta'] }],
    ]);
  });
});
