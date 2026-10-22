'use strict';

// The parts of analytics/traffic/visitorDetails.js that need no database: the
// IP region → governorate table, a session's own fields, click ids as yes/no.

const { governorateFromRegion, sessionFields, clickFlags, ISO_TO_GOVERNORATE } = require('../../src/modules/analytics/traffic/visitorDetails');
const { GOVERNORATE_CODES } = require('../../src/modules/shipping/governorates');
const { derivePage } = require('../../src/modules/analytics/storefrontEventsService');

describe('governorateFromRegion', () => {
  it('maps every Egyptian region code onto one of the 27 shipping codes, and all 27 are reachable', () => {
    for (const code of Object.values(ISO_TO_GOVERNORATE)) expect(GOVERNORATE_CODES).toContain(code);
    expect(new Set(Object.values(ISO_TO_GOVERNORATE)).size).toBe(27);
    expect(governorateFromRegion('EG', 'EG-C')).toBe('cairo');
    expect(governorateFromRegion('EG', 'eg-alx')).toBe('alexandria');
    expect(governorateFromRegion('EG', 'EG-SU')).toBe('giza');
  });

  it('nothing outside Egypt, without a region, or for a code it does not know', () => {
    expect(governorateFromRegion('SA', 'SA-01')).toBeNull();
    expect(governorateFromRegion('EG', null)).toBeNull();
    expect(governorateFromRegion(null, 'EG-C')).toBeNull();
    expect(governorateFromRegion('EG', 'EG-ZZ')).toBeNull();
  });
});

describe('sessionFields', () => {
  const client = { country: 'EG', region: 'EG-GZ' };

  it("a page's own UTM values win over the batch's first touch; click ids become yes/no", () => {
    const page = derivePage({ url: '/p?utm_source=tiktok&utm_campaign=sale&ttclid=T1', hostname: 'shop.zimos.co', referrer: 'https://www.tiktok.com/x' });
    const fields = sessionFields({ attribution: { source: 'facebook', clickIds: { fbclid: 'F1' } }, page, client });
    expect(fields).toMatchObject({
      detailed: true,
      source: 'tiktok',
      campaign: 'sale',
      referrerDomain: 'tiktok.com',
      landingPath: '/p',
      hasFbclid: true,
      hasTtclid: true,
      hasGclid: false,
      governorate: 'giza',
      governorateApprox: 'giza',
      geoSource: 'ip_approx',
    });
    expect(JSON.stringify(fields)).not.toMatch(/F1|T1/);
  });

  it('falls back to the first touch, and to no governorate without a region', () => {
    const page = derivePage({ url: '/', hostname: 'shop.zimos.co' });
    const fields = sessionFields({ attribution: { source: 'google', medium: 'cpc', landingPage: '/landing?x=1', referrer: 'https://google.com/' }, page, client: { country: 'EG' } });
    expect(fields).toMatchObject({ source: 'google', medium: 'cpc', landingPath: '/landing', referrerDomain: 'google.com', governorate: null, geoSource: null });
  });
});

describe('clickFlags', () => {
  it('keeps only whether each id was there', () => {
    expect(clickFlags({ gclid: 'G', fbclid: '', ttclid: 'T' })).toEqual({ gclid: true, ttclid: true });
    expect(clickFlags({})).toBeNull();
    expect(clickFlags(null)).toBeNull();
  });
});
