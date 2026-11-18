'use strict';

const Joi = require('joi');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');

/**
 * A page's live switches (SPEC §8.3): shown in the header, shown in the
 * footer, active. They sit on the website_pages row and take effect at once —
 * no publish needed — while the page's content still comes from the published
 * snapshot.
 */

const FLAG_KEYS = ['showInHeader', 'showInFooter', 'isActive'];

/** Joi keys the page create/update bodies accept. */
const pageFlagKeys = {
  showInHeader: Joi.boolean().optional(),
  showInFooter: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
  menuOrder: Joi.number().integer().min(0).max(100000).allow(null).optional(),
};

/** The flags present in a request body, ready to merge into a page patch. */
function pickPageFlags(data) {
  const out = {};
  for (const key of FLAG_KEYS) {
    if (typeof data[key] === 'boolean') out[key] = data[key];
  }
  if (data.menuOrder === null || Number.isInteger(data.menuOrder)) out.menuOrder = data.menuOrder;
  return out;
}

/** 404 for a published page the merchant has switched off. */
async function assertPageActive(websiteId, path) {
  const row = await db.WebsitePage.findOne({ where: { websiteId, path }, attributes: ['id', 'isActive'] });
  if (row && row.isActive === false) throw new NotFoundError('Page');
}

/**
 * The store's navigation pages: published, active, and flagged for the header
 * or the footer. Titles come from the published snapshot, so a renamed draft
 * does not leak. Home ("/") is never listed — every store links it already.
 */
async function publicNavPages(workspaceId) {
  const website = await db.Website.findOne({
    where: { workspaceId, status: 'published', publishedRevisionId: { [Op.ne]: null } },
    order: [['updatedAt', 'DESC']],
  });
  if (!website) return [];
  const revision = await db.WebsiteRevision.findOne({
    where: { id: website.publishedRevisionId, websiteId: website.id },
  });
  const snapPages = revision && revision.snapshot && Array.isArray(revision.snapshot.pages) ? revision.snapshot.pages : [];
  if (snapPages.length === 0) return [];

  const rows = await db.WebsitePage.findAll({
    where: {
      websiteId: website.id,
      isActive: true,
      [Op.or]: [{ showInHeader: true }, { showInFooter: true }],
    },
    attributes: ['path', 'showInHeader', 'showInFooter'],
    order: [['menuOrder', 'ASC NULLS LAST'], ['path', 'ASC']],
  });
  const titles = new Map(snapPages.map((p) => [p.path, p.title]));
  return rows
    .filter((r) => r.path !== '/' && titles.has(r.path))
    .map((r) => ({
      path: r.path,
      title: titles.get(r.path),
      showInHeader: r.showInHeader,
      showInFooter: r.showInFooter,
    }));
}

module.exports = { pageFlagKeys, pickPageFlags, assertPageActive, publicNavPages };
