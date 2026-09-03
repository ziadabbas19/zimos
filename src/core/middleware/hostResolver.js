'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');

const ROOT = String(env.platformRootDomain || '').toLowerCase();

function bareHost(hostHeader) {
  return String(hostHeader || '').split(':')[0].toLowerCase().replace(/\.$/, '');
}
function isLocalOrIp(h) {
  return !h || h === 'localhost' || h === '::1' || h.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

/**
 * Storefront host routing. If the Host header is `<slug>.${PLATFORM_ROOT_DOMAIN}`
 * or a verified custom `Domain`, the request is internally rewritten to
 * `/shop/:workspaceId<path>` — no redirect, the URL bar stays put.
 *
 * localhost, an IP, the bare root, or an unknown host fall through untouched,
 * so the path-based `/shop/:workspaceId` and `/api/...` routes are unaffected.
 */
const hostResolver = asyncHandler(async (req, res, next) => {
  const host = bareHost(req.headers.host);
  if (isLocalOrIp(host) || host === ROOT) return next();
  if (req.url.startsWith('/shop/') || req.url.startsWith('/docs') || req.url === '/health' || req.url.startsWith('/health/')) {
    return next();
  }

  let workspaceId = null;

  if (ROOT && host.endsWith('.' + ROOT)) {
    const slug = host.slice(0, host.length - (ROOT.length + 1));
    if (slug && !slug.includes('.')) {
      const ws = await db.Workspace.findOne({ where: { slug, status: 'active' }, attributes: ['id'] });
      if (ws) workspaceId = ws.id;
    }
  } else {
    const domain = await db.Domain.findOne({ where: { hostname: host }, attributes: ['workspaceId', 'status'] });
    if (domain) {
      if (domain.status === 'verified' || domain.status === 'active') {
        workspaceId = domain.workspaceId;
      } else {
        res.removeHeader('Content-Security-Policy');
        return res.status(409).render('domain-pending', { title: 'Domain not verified', hostname: host });
      }
    }
  }

  if (!workspaceId) return next();

  req.url = `/shop/${workspaceId}${req.url === '/' ? '' : req.url}`;
  next();
});

module.exports = { hostResolver };
