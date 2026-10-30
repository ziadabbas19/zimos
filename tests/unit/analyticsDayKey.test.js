'use strict';

// analyticsService.dayKey: the day an order or a session falls on, in the
// store's time zone. It keeps one formatter per zone (the summary names the
// day of every order in its range); the answers must not change.

const { dayKey } = require('../../src/modules/analytics/analyticsService');

const lateEvening = new Date('2026-10-29T22:30:00.000Z');

describe('dayKey', () => {
  it("names the day in the store's time zone", () => {
    expect(dayKey(lateEvening, 'Africa/Cairo')).toBe('2026-10-30');
    expect(dayKey(lateEvening, 'UTC')).toBe('2026-10-29');
    expect(dayKey(lateEvening, 'America/New_York')).toBe('2026-10-29');
    // Asked again, from the formatter kept for the zone.
    expect(dayKey(new Date('2026-10-30T21:59:00.000Z'), 'Africa/Cairo')).toBe('2026-10-30');
  });

  it('gives the UTC day for a zone it does not know, every time it is asked', () => {
    expect(dayKey(lateEvening, 'Not/A_Zone')).toBe('2026-10-29');
    expect(dayKey(lateEvening, 'Not/A_Zone')).toBe('2026-10-29');
  });

  it('answers the same for every spelling of a zone, past the formatters it keeps', () => {
    const name = 'africa/cairo';
    for (let i = 0; i < 200; i += 1) {
      const spelling = [...name].map((c, j) => ((i >> j) & 1 ? c.toUpperCase() : c)).join('');
      expect(dayKey(lateEvening, spelling)).toBe('2026-10-30');
    }
  });
});
