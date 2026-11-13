'use strict';

// The bar's look, pure (cartRewards/barAppearance.js): the WCAG contrast
// ratio, the icon colour on a reached marker, which custom pairs fail, the
// icon a reward shows by its kind, and how a stored look reads back.

const look = require('../../src/modules/cartRewards/barAppearance');

describe('contrast', () => {
  it('measures the WCAG ratio either way round', () => {
    expect(look.contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(look.contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(look.contrastRatio('#777777', '#777777')).toBe(1);
    // Known pairs (WebAIM): #767676 on white is 4.54:1, #949494 on white 3.03:1.
    expect(look.contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(look.contrastRatio('#949494', '#ffffff')).toBeCloseTo(3.03, 2);
  });

  it('puts black or white on a marker, whichever reads better, so the icon always reaches 3:1', () => {
    expect(look.iconColorOn('#ffd400')).toBe('#000000');
    expect(look.iconColorOn('#1d4ed8')).toBe('#ffffff');
    for (const bg of ['#777777', '#808080', '#3366ff', '#ff0000', '#00ff00', '#a0a0a0', '#5a5a5a']) {
      expect(look.contrastRatio(look.iconColorOn(bg), bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('names the failing pair, and checks only pairs with a colour of the merchant’s', () => {
    expect(look.contrastProblems({ ...look.CUSTOM_DEFAULTS })).toEqual([]);
    const pale = look.contrastProblems({ ...look.CUSTOM_DEFAULTS, fillColor: '#e0e0e0', trackColor: '#eeeeee' });
    expect(pale).toHaveLength(1);
    expect(pale[0]).toMatchObject({ field: 'appearance.custom.fillColor', pair: ['fill', 'track'] });
    expect(pale[0].ratio).toBeLessThan(3);
    // Only the track is the merchant's: the error is on it.
    expect(look.contrastProblems({ ...look.CUSTOM_DEFAULTS, trackColor: '#3a7a58' })[0].field).toBe('appearance.custom.trackColor');
    expect(look.contrastProblems({ ...look.CUSTOM_DEFAULTS, fillColor: '#1d4ed8', trackColor: '#e5e7eb' })).toEqual([]);
  });
});

describe('icons and stored looks', () => {
  it('gives a reward its kind’s icon unless the merchant picked one', () => {
    expect(look.iconOf({ type: 'free_shipping' })).toBe('truck');
    expect(look.iconOf({ type: 'percent' })).toBe('percent');
    expect(look.iconOf({ type: 'fixed' })).toBe('tag');
    expect(look.iconOf({ type: 'something_new' })).toBe('gift');
    expect(look.iconOf({ type: 'percent', icon: 'crown' })).toBe('crown');
    expect(look.iconOf({ type: 'percent', icon: 'rocket' })).toBe('percent');
  });

  it('reads nothing stored, or a stored look it cannot read, as the theme’s', () => {
    expect(look.read(null)).toEqual({ mode: 'inherit', custom: null });
    expect(look.read({ mode: 'hologram' })).toEqual({ mode: 'inherit', custom: null });
    expect(look.publicView(null)).toEqual({ mode: 'inherit' });
    expect(look.publicView({ mode: 'inherit', custom: { ...look.CUSTOM_DEFAULTS, shape: 'thin' } })).toEqual({ mode: 'inherit' });
    expect(look.publicView({ mode: 'custom', custom: null })).toEqual({ mode: 'custom', ...look.CUSTOM_DEFAULTS });
    expect(look.normalize({ mode: 'custom' })).toEqual({ mode: 'custom', custom: look.CUSTOM_DEFAULTS });
  });
});
