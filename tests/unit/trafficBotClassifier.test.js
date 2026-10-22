'use strict';

// The events guard's User-Agent classes (analytics/traffic/botClassifier.js).
// No database: run alone with a config that skips tests/helpers/setup.js.

const { classify } = require('../../src/modules/analytics/traffic/botClassifier');

const BROWSERS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  facebookApp:
    'Mozilla/5.0 (Linux; Android 13; SM-A515F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/442.0.0.33.113;]',
  tiktokApp:
    'Mozilla/5.0 (Linux; Android 12; TECNO KG5 Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.153 Mobile Safari/537.36 trill_310503 AppName/musical_ly ByteLocale/ar Region/EG BytedanceWebview/d8a21c6',
  snapchatApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.53.0.40 (like Safari/8615.3.12.10.4, panda)',
  pinterestApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]',
  instagramApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 307.0.0.34.111 (iPhone14,5; iOS 17_0; ar_EG; ar; scale=3.00; 1170x2532; 531294125)',
};

describe('botClassifier.classify', () => {
  it.each(Object.entries(BROWSERS))('a person in %s is not a bot', (_, ua) => {
    expect(classify(ua)).toEqual({ bot: false });
  });

  it('search engines and link previews are good bots', () => {
    expect(classify('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toEqual({ bot: true, kind: 'search', label: 'googlebot', good: true });
    expect(classify('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)')).toMatchObject({ kind: 'search', label: 'bingbot', good: true });
    expect(classify('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toMatchObject({ kind: 'preview', label: 'facebook', good: true });
    expect(classify('WhatsApp/2.23.20.0 A')).toMatchObject({ kind: 'preview', label: 'whatsapp', good: true });
  });

  it('scripts, headless browsers and SEO crawlers are bad bots', () => {
    expect(classify('curl/8.4.0')).toEqual({ bot: true, kind: 'tool', label: 'curl', good: false });
    expect(classify('python-requests/2.31.0')).toMatchObject({ kind: 'tool', label: 'python', good: false });
    expect(classify('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36')).toMatchObject({
      kind: 'tool',
      label: 'headless',
      good: false,
    });
    expect(classify('Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)')).toMatchObject({ kind: 'seo', label: 'ahrefs', good: false });
    expect(classify('PostmanRuntime/7.36.0')).toMatchObject({ kind: 'tool', label: 'postman' });
  });

  it('no User-Agent at all is a tool', () => {
    expect(classify('')).toEqual({ bot: true, kind: 'tool', label: 'empty', good: false });
    expect(classify(undefined)).toMatchObject({ bot: true, label: 'empty' });
  });

  it('a bot isbot knows but no list names is "other"', () => {
    expect(classify('SomeCrawler/1.0 (+http://example.com/crawler)')).toMatchObject({ bot: true, kind: 'other', good: false });
  });
});
