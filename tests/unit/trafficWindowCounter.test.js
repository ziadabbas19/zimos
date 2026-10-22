'use strict';

// The fixed-window counter behind the events guard's per-minute limits
// (analytics/traffic/windowCounter.js). No database.

const { createWindowCounter } = require('../../src/modules/analytics/traffic/windowCounter');

describe('windowCounter', () => {
  it('counts within a window and starts again after it', () => {
    let now = 1000;
    const c = createWindowCounter({ windowMs: 60000, now: () => now });
    expect(c.wouldExceed('k', 20, 30)).toBe(false);
    expect(c.add('k', 20)).toBe(20);
    expect(c.wouldExceed('k', 11, 30)).toBe(true);
    expect(c.wouldExceed('k', 10, 30)).toBe(false);
    expect(c.retryAfter('k')).toBe(60);
    now += 30000;
    expect(c.get('k')).toBe(20);
    expect(c.retryAfter('k')).toBe(30);
    now += 30000;
    expect(c.get('k')).toBe(0);
    expect(c.add('k', 5)).toBe(5);
  });

  it('keeps its size bounded, dropping finished windows first', () => {
    let now = 0;
    const c = createWindowCounter({ windowMs: 1000, maxKeys: 10, now: () => now });
    for (let i = 0; i < 10; i += 1) c.add(`old${i}`);
    now = 5000;
    c.add('fresh');
    expect(c.size()).toBe(1);
    for (let i = 0; i < 30; i += 1) c.add(`k${i}`);
    expect(c.size()).toBeLessThanOrEqual(10);
    expect(c.get('k29')).toBe(1);
  });
});
