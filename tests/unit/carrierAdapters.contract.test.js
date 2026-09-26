'use strict';

// Every real courier adapter file in src/modules/shipping/carriers/ held to
// the same contract: defineAdapter accepted it (it would throw at require
// otherwise), its capabilities are honest about the functions behind them,
// its forms match its schemas, and its state table only speaks our Shipment
// statuses. New adapters are picked up from the directory automatically.
// No network: nothing here calls a carrier.

const fs = require('fs');
const path = require('path');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const carriers = require('../../src/modules/shipping/carriers');

const DIR = path.join(__dirname, '../../src/modules/shipping/carriers');
const NOT_ADAPTERS = new Set(['index.js', 'adapterContract.js', 'carrierHttp.js', 'carrierErrors.js']);

const adapters = fs
  .readdirSync(DIR)
  .filter((file) => file.endsWith('.js') && !NOT_ADAPTERS.has(file))
  .map((file) => [path.basename(file, '.js'), require(path.join(DIR, file))]);

const SHIPMENT_STATUSES = db.Shipment.rawAttributes.status.values;
const keysOf = (schema) => Object.keys(schema.describe().keys || {});

it('finds the adapters (bosta and every carrier added after it)', () => {
  expect(adapters.map(([file]) => file)).toEqual(expect.arrayContaining(['bosta', 'mylerz', 'jtexpress']));
});

describe.each(adapters)('%s', (file, adapter) => {
  const caps = adapter.capabilities;

  it('is the adapter its file names, frozen by defineAdapter', () => {
    expect(adapter.code).toBe(file);
    expect(Object.isFrozen(caps)).toBe(true);
    expect(typeof adapter.name).toBe('string');
    expect(Array.isArray(adapter.nameAliases)).toBe(true);
  });

  it('backs every claimed capability with its function', () => {
    for (const fn of ['verifyCredentials', 'createShipment', 'getShipment']) expect(typeof adapter[fn]).toBe('function');
    if (caps.cancel === 'api') expect(typeof adapter.cancelShipment).toBe('function');
    if (caps.label) expect(typeof adapter.getLabel).toBe('function');
    if (caps.bulkStatus) expect(typeof adapter.getShipments).toBe('function');
    if (caps.webhook !== 'none') expect(typeof adapter.parseWebhook).toBe('function');
    if (!caps.webhookRefetch) expect(typeof adapter.verifyWebhook).toBe('function');
  });

  it('has some way to learn a shipment\'s status: a webhook or polling', () => {
    expect(caps.webhook !== 'none' || caps.polling).toBe(true);
  });

  it('has 1 to 3 address levels, with the function that lists them', () => {
    expect(caps.addressLevels.length).toBeGreaterThanOrEqual(1);
    expect(caps.addressLevels.length).toBeLessThanOrEqual(3);
    expect(typeof adapter.listAddressTree === 'function' || typeof adapter.listCities === 'function').toBe(true);
  });

  it('asks for exactly the credentials its schema requires, and every setting field is in the settings schema', () => {
    const credentialKeys = keysOf(adapter.credentialsSchema);
    expect(adapter.credentialFields.map((f) => f.key).sort()).toEqual([...credentialKeys].sort());
    expect(adapter.credentialsSchema.validate({}).error).toBeTruthy();
    // Something in the form is secret: a password, key or token.
    expect(adapter.credentialFields.some((f) => f.secret)).toBe(true);

    const settingKeys = keysOf(adapter.settingsSchema);
    for (const field of adapter.settingFields) expect(settingKeys).toContain(field.key);
    expect(adapter.settingsSchema.validate({}).error).toBeFalsy();
  });

  it('maps carrier states only onto our Shipment statuses (or null = no change)', () => {
    const table = adapter.STATE_MAP || {};
    for (const status of Object.values(table)) {
      if (status !== null) expect(SHIPMENT_STATUSES).toContain(status);
    }
  });

  it('resolves a package with no tier from settings alone, and treats no carrier state as not cancelled', () => {
    if (typeof adapter.resolvePackage === 'function') expect(() => adapter.resolvePackage({}, null)).not.toThrow();
    if (typeof adapter.isCancelSettled === 'function') expect(adapter.isCancelSettled(null)).toBe(false);
  });

  it('is off by default: only Bosta is in CARRIERS_ENABLED, and only Bosta reserves its name before connecting', () => {
    if (adapter.code === 'bosta') {
      expect(env.carriers.enabled).toContain('bosta');
      expect(caps.reserveNameWhenUnconnected).toBe(true);
    } else {
      expect(env.carriers.enabled).not.toContain(adapter.code);
      expect(env.carriers.beta).not.toContain(adapter.code);
      expect(carriers.getAdapter(adapter.code)).toBeNull();
      expect(caps.reserveNameWhenUnconnected).toBe(false);
    }
  });
});
