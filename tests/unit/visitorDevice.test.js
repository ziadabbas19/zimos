'use strict';

// zimos.co visitor devices for the console (siteAnalytics/visitorDevice.js):
// what the User-Agent and Client Hints say, and null for what they hide.

const { parseDevice, screenOf, languageOf, shortVersion } = require('../../src/modules/siteAnalytics/visitorDevice');

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  androidReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  webview: 'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  windows7: 'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
};

const headers = (map) => (name) => map[name];

describe('parseDevice', () => {
  it('an iPhone is "iPhone", with its iOS and Safari versions; never a guessed model', () => {
    expect(parseDevice({ userAgent: UA.iphone })).toEqual({ model: 'iPhone', osVersion: '17.5', browserVersion: '17.5' });
    expect(parseDevice({ userAgent: UA.iphone, hints: { model: 'iPhone15,2' } }).model).toBe('iPhone');
    expect(parseDevice({ userAgent: UA.ipad })).toEqual({ model: 'iPad', osVersion: '16', browserVersion: '120' });
  });

  it("Chrome's reduced Android agent hides model and version; Client Hints give them", () => {
    expect(parseDevice({ userAgent: UA.androidReduced })).toEqual({ model: null, osVersion: null, browserVersion: '131' });
    expect(parseDevice({ userAgent: UA.androidReduced, hints: { model: 'Pixel 7', platformVersion: '14.0.0' } })).toEqual({
      model: 'Pixel 7',
      osVersion: '14',
      browserVersion: '131',
    });
    const fromHeaders = parseDevice({
      userAgent: UA.androidReduced,
      getHeader: headers({ 'sec-ch-ua-model': '"SM-A546E"', 'sec-ch-ua-platform-version': '"15.0.0"' }),
    });
    expect(fromHeaders).toMatchObject({ model: 'SM-A546E', osVersion: '15' });
  });

  it('other Android agents: the model when named, without the brand prefix or the build', () => {
    expect(parseDevice({ userAgent: UA.samsung })).toEqual({ model: 'SM-S918B', osVersion: '14', browserVersion: '25' });
    expect(parseDevice({ userAgent: UA.webview })).toMatchObject({ model: 'SM-A536E', osVersion: '13' });
    expect(parseDevice({ userAgent: UA.firefoxAndroid })).toEqual({ model: null, osVersion: '14', browserVersion: '132' });
  });

  it('Windows 10 and 11 are told apart only by Client Hints; macOS 10.15.7 is a frozen value', () => {
    expect(parseDevice({ userAgent: UA.windows }).osVersion).toBeNull();
    expect(parseDevice({ userAgent: UA.windows, hints: { platformVersion: '15.0.0' } }).osVersion).toBe('11');
    expect(parseDevice({ userAgent: UA.windows, hints: { platformVersion: '10.0.0' } }).osVersion).toBe('10');
    expect(parseDevice({ userAgent: UA.windows7 })).toEqual({ model: null, osVersion: '7', browserVersion: '115' });
    expect(parseDevice({ userAgent: UA.mac })).toEqual({ model: null, osVersion: null, browserVersion: '17.4' });
    expect(parseDevice({ userAgent: UA.mac, hints: { platformVersion: '14.5.0' } }).osVersion).toBe('14.5');
    expect(parseDevice({ userAgent: UA.linux })).toEqual({ model: null, osVersion: null, browserVersion: '133' });
  });

  it('no agent: nothing', () => {
    expect(parseDevice({ userAgent: '' })).toEqual({ model: null, osVersion: null, browserVersion: null });
    expect(parseDevice({ userAgent: undefined })).toEqual({ model: null, osVersion: null, browserVersion: null });
  });
});

describe('screen, language and versions', () => {
  it('keeps a plain WxH screen only', () => {
    expect(screenOf('390x844')).toBe('390x844');
    expect(screenOf('0390x0844')).toBe('390x844');
    for (const bad of ['0x844', '390*844', '390x', '', null, '123456x1']) expect(screenOf(bad)).toBeNull();
  });

  it("the beacon's language, else the first of Accept-Language; anything else is null", () => {
    expect(languageOf('ar-EG', 'en-US,en;q=0.9')).toBe('ar-EG');
    expect(languageOf(undefined, 'en-US,en;q=0.9')).toBe('en-US');
    expect(languageOf(undefined, undefined)).toBeNull();
    expect(languageOf('<script>', undefined)).toBeNull();
    expect(languageOf(undefined, '*')).toBeNull();
  });

  it('versions keep the major, and the minor when it is not zero', () => {
    expect(shortVersion('131.0.0')).toBe('131');
    expect(shortVersion('17.5.0')).toBe('17.5');
    expect(shortVersion('')).toBeNull();
  });
});
