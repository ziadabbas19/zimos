'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./domainsService');

const add = asyncHandler(async (req, res) => {
  const { domain, record } = await service.addDomain(req.tenant.workspaceId, req.body, req);
  res.status(201).json({
    domain: { id: domain.id, hostname: domain.hostname, status: domain.status, verifiedAt: domain.verifiedAt },
    record,
    next: `Add this TXT record at your DNS provider, then POST /domains/${domain.id}/verify`,
  });
});

const list = asyncHandler(async (req, res) => {
  res.json({ domains: await service.listDomains(req.tenant.workspaceId) });
});

const verify = asyncHandler(async (req, res) => {
  const { domain } = await service.verifyDomain(req.tenant.workspaceId, req.params.domainId, req);
  res.json({
    domain: { id: domain.id, hostname: domain.hostname, status: domain.status, verifiedAt: domain.verifiedAt },
  });
});

const remove = asyncHandler(async (req, res) => {
  res.json(await service.deleteDomain(req.tenant.workspaceId, req.params.domainId, req));
});

module.exports = { add, list, verify, remove };
