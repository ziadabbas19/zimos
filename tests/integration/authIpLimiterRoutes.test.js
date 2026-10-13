'use strict';

// Which account routes also count per IP alone (authIpLimiter). The limiters
// themselves are skipped under NODE_ENV=test; this pins where they are mounted.

const { authLimiter, authIpLimiter } = require('../../src/core/middleware/rateLimiters');
const authRoutes = require('../../src/modules/auth/authRoutes');
const securityRoutes = require('../../src/modules/auth/securityRoutes');
const { router: recoveryRoutes } = require('../../src/modules/auth/twoFactorRecovery');

const handlersOf = (router, path) => {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  return layer ? layer.route.stack.map((s) => s.handle) : null;
};

describe('account routes counted per IP as well as per account named', () => {
  it.each([
    [authRoutes, '/verify-phone/request'],
    [securityRoutes, '/two-factor/email/enable'],
    [securityRoutes, '/two-factor/whatsapp/enable'],
    [securityRoutes, '/two-factor/totp/setup'],
    [securityRoutes, '/two-factor/disable'],
    [recoveryRoutes, '/two-factor/backup-codes'],
  ])('%#: POST %s', (router, path) => {
    const handlers = handlersOf(router, path);
    expect(handlers).not.toBeNull();
    expect(handlers).toContain(authIpLimiter);
    expect(handlers).toContain(authLimiter);
    expect(handlers.indexOf(authIpLimiter)).toBeLessThan(handlers.indexOf(authLimiter));
  });

  it('the sign-in second step keeps its own counters', () => {
    expect(handlersOf(securityRoutes, '/two-factor/verify')).not.toContain(authIpLimiter);
  });
});
