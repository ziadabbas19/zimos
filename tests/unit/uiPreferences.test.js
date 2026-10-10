'use strict';

const validate = require('../../src/core/middleware/validate');
const { schema, bodyLimit, stamp, present, MAX_BODY_BYTES } = require('../../src/modules/auth/uiPreferences');

// The look of the dashboard saved to the account (auth/uiPreferences): what a
// save may hold, through the same validate() the route uses, and the shape
// that is stored and answered. Nothing here reads the database.

const look = (over = {}) => ({ look: 'dark', darkTone: 30, glass: true, glowLeft: '#1a2b3c', glowRight: null, glowIntensity: 80, ...over });

/** The route's validation over a body: what it lets through, or the fields it refused (each named once). */
function check(body) {
  const req = { body };
  let refused = null;
  validate(schema)(req, {}, (err) => {
    refused = err || null;
  });
  return refused ? { status: refused.statusCode, fields: [...new Set(refused.details.map((d) => d.field))] } : { body: req.body };
}

const refusedFields = (appearance) => check({ appearance }).fields;

describe('what a save may hold', () => {
  it('takes a whole appearance, with colours kept in lower case', () => {
    expect(check({ appearance: look({ glowLeft: '#1A2B3C', glowRight: '#FFAA00' }) })).toEqual({
      body: { appearance: look({ glowLeft: '#1a2b3c', glowRight: '#ffaa00' }) },
    });
  });

  it('takes no look (the dashboard follows the device) and no colours (the backdrop keeps its own)', () => {
    const appearance = look({ look: null, glowLeft: null, glowRight: null, darkTone: 0, glowIntensity: 100, glass: false });
    expect(check({ appearance })).toEqual({ body: { appearance } });
    for (const name of ['light', 'black', 'dark']) expect(check({ appearance: look({ look: name }) }).body.appearance.look).toBe(name);
  });

  it('refuses a key it does not know instead of dropping it', () => {
    expect(refusedFields({ ...look(), theme: 'neon' })).toEqual(['appearance.theme']);
    expect(refusedFields({ ...look(), darkLook: 'black' })).toEqual(['appearance.darkLook']);
    expect(check({ appearance: look(), language: 'ar' })).toEqual({ status: 422, fields: ['language'] });
  });

  it('never takes the time of the save from the client', () => {
    expect(refusedFields({ ...look(), updatedAt: '2099-01-01T00:00:00.000Z' })).toEqual(['appearance.updatedAt']);
  });

  it('needs every key', () => {
    for (const key of Object.keys(look())) {
      const appearance = look();
      delete appearance[key];
      expect(refusedFields(appearance)).toEqual([`appearance.${key}`]);
    }
    expect(check({}).fields).toEqual(['appearance']);
  });

  it('refuses a look that is not one of the three', () => {
    for (const value of ['blue', 'Dark', '', 1, true, ['dark'], { name: 'dark' }]) {
      expect(refusedFields(look({ look: value }))).toEqual(['appearance.look']);
    }
  });

  it('takes whole numbers from 0 to 100 only, and never as text', () => {
    for (const key of ['darkTone', 'glowIntensity']) {
      for (const value of [-1, 101, 50.5, '50', null, true, [50]]) {
        expect(refusedFields(look({ [key]: value }))).toEqual([`appearance.${key}`]);
      }
      for (const value of [0, 50, 100]) expect(check({ appearance: look({ [key]: value }) }).body.appearance[key]).toBe(value);
    }
  });

  it('takes the glass switch as a boolean only', () => {
    for (const value of ['true', 'off', 1, 0, null]) expect(refusedFields(look({ glass: value }))).toEqual(['appearance.glass']);
  });

  it('takes a colour as #rrggbb and nothing else: no markup, no names, no other notation', () => {
    const notColours = ['<b>#1a2b3c</b>', '<script>alert(1)</script>', '#1a2b3c"><img src=x>', 'red', '#fff', '#1a2b3cff', 'rgb(1,2,3)', '1a2b3c', ' #1a2b3c', '', 0x1a2b3c];
    for (const key of ['glowLeft', 'glowRight']) {
      for (const value of notColours) expect(refusedFields(look({ [key]: value }))).toEqual([`appearance.${key}`]);
    }
  });

  it('refuses a body that is not an object, or is missing', () => {
    for (const body of [undefined, null, 'dark', 7, [look()]]) expect(check(body).status).toBe(422);
    for (const appearance of [null, 'dark', [], 7]) expect(check({ appearance }).fields).toEqual(['appearance']);
  });
});

describe('the size of a save', () => {
  /** What bodyLimit hands on: undefined when it lets the request through. */
  function limit(req) {
    let handed;
    bodyLimit(req, {}, (err) => {
      handed = err;
    });
    return handed;
  }

  it('lets a whole appearance through, well under the limit', () => {
    const raw = Buffer.from(JSON.stringify({ appearance: look({ glowRight: '#ffaa00' }) }));
    expect(raw.length).toBeLessThan(MAX_BODY_BYTES / 4);
    expect(limit({ rawBody: raw, body: JSON.parse(raw) })).toBeUndefined();
    expect(limit({ body: { appearance: look() } })).toBeUndefined();
    expect(limit({})).toBeUndefined();
  });

  it('refuses a larger body, by the bytes that were sent when they are known', () => {
    const big = { appearance: look(), padding: 'x'.repeat(MAX_BODY_BYTES) };
    for (const req of [{ rawBody: Buffer.from(JSON.stringify(big)), body: big }, { body: big }, { rawBody: Buffer.alloc(MAX_BODY_BYTES + 1), body: {} }]) {
      expect(limit(req)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', statusCode: 413 });
    }
    expect(limit({ rawBody: Buffer.alloc(MAX_BODY_BYTES), body: {} })).toBeUndefined();
  });
});

describe('what is stored and answered', () => {
  it('stamps a save with the time here, and keeps the known keys only', () => {
    const at = new Date('2026-10-10T08:30:00.000Z');
    expect(stamp({ ...look(), extra: 'x', updatedAt: '2099-01-01T00:00:00.000Z' }, at)).toEqual({ ...look(), updatedAt: '2026-10-10T08:30:00.000Z' });
    const now = Date.parse(stamp(look()).updatedAt);
    expect(Math.abs(Date.now() - now)).toBeLessThan(5000);
  });

  it('answers null for an account that never saved', () => {
    for (const value of [null, undefined, {}, { appearance: null }, { appearance: [] }, { appearance: 'dark' }, { layout: { dense: true } }, 'dark']) {
      expect(present(value)).toBeNull();
    }
  });

  it('answers the appearance part alone, every key there', () => {
    const saved = stamp(look(), new Date('2026-10-10T08:30:00.000Z'));
    expect(present({ appearance: { ...saved, extra: 'x' }, layout: { dense: true } })).toEqual({ appearance: saved });
    expect(present({ appearance: { look: 'black' } })).toEqual({
      appearance: { look: 'black', darkTone: null, glass: null, glowLeft: null, glowRight: null, glowIntensity: null, updatedAt: null },
    });
  });
});
