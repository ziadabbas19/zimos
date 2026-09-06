'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { scoped } = require('../../core/utils/scopedRepository');
const { NotFoundError, ConflictError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const slugify = require('../../core/utils/slugify');
const { validatePageTree, EMPTY_TREE } = require('./pageTree');

const Op = db.Sequelize.Op;

/**
 * Page engine. Workspace-scoped staff tooling, plus `getPublishedPageForStore`
 * for the public render-data API under /store/:workspaceId.
 *
 * Draft/publish separation is absolute: staff edits only write the draft
 * columns; the storefront renders only the frozen `snapshot` of the website's
 * current `publishedRevisionId`. Publishing writes a new numbered
 * WebsiteRevision; rollback just repoints `publishedRevisionId`.
 * `WebsitePage.publishedData` is a convenience mirror, never the render source.
 */

// --- helpers --------------------------------------------------------------

// One-time deep copy — the result shares no reference with the source, so a
// later edit to a template can never reach a website already created from it.
function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

const PAGE_TYPES = ['home', 'product', 'collection', 'static', 'blog_post', 'cart', 'custom'];

// --- path helpers -----------------------------------------------------------

function normalizePath(input) {
  let p = String(input == null ? '/' : input).trim().toLowerCase();
  p = p.replace(/\\+/g, '/');
  if (p === '' || p === '/') return '/';
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

async function ensureUniqueSubdomain(base) {
  let root = slugify(base).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  if (root.length < 3) root = `${root || 'site'}-site`;
  root = root.slice(0, 55);
  let candidate = root;
  let n = 1;
  // subdomain is globally unique, so this is not workspace-scoped.
  while (await db.Website.findOne({ where: { subdomain: candidate }, attributes: ['id'] })) {
    candidate = `${root}-${++n}`;
  }
  return candidate;
}

// --- internal loaders -----------------------------------------------------

async function loadWebsite(workspaceId, websiteId, transaction) {
  return scoped(db.Website, workspaceId).findByPkOrThrow(websiteId, transaction ? { transaction } : {});
}

async function loadPage(workspaceId, websiteId, pageId, transaction) {
  const page = await db.WebsitePage.findOne({
    where: { id: pageId, websiteId, workspaceId },
    ...(transaction ? { transaction } : {}),
  });
  if (!page) throw new NotFoundError('Page');
  return page;
}

// --- websites -----------------------------------------------------------

async function createWebsite(workspaceId, data, req) {
  return db.sequelize.transaction(async (t) => {
    // Optionally seed the site from a ready-made template.
    let templateVersion = null;
    if (data.templateVersionId) {
      templateVersion = await db.TemplateVersion.findOne({
        where: { id: data.templateVersionId, isActive: true },
        transaction: t,
      });
      if (!templateVersion) throw new NotFoundError('TemplateVersion');
    }

    const subdomain = await ensureUniqueSubdomain(data.subdomain || data.name);

    // Template's globalStyles is the starting point; any globalStyles the
    // merchant sent in THIS request override it per key (not the other way).
    const baseStyles = templateVersion ? deepClone(templateVersion.globalStyles || {}) : {};
    const globalStyles = { ...baseStyles, ...(data.globalStyles || {}) };

    const website = await scoped(db.Website, workspaceId).create(
      {
        name: data.name,
        subdomain,
        status: 'draft',
        sourceTemplateVersionId: templateVersion ? templateVersion.id : null,
        globalStyles,
        seo: data.seo || {},
      },
      { transaction: t }
    );

    // Deep-copy every template page into a real WebsitePage. After this the
    // website owns its own copy — editing the template never touches it.
    const createdPages = [];
    if (templateVersion) {
      const templatePages = Array.isArray(templateVersion.pages) ? templateVersion.pages : [];
      for (const tp of templatePages) {
        const path = normalizePath(tp.path || '/');
        const draftData = deepClone(tp.builderData || EMPTY_TREE);
        validatePageTree(draftData, { label: `template page "${path}"` });
        const pageType = PAGE_TYPES.includes(tp.pageType) ? tp.pageType : path === '/' ? 'home' : 'custom';

        const page = await db.WebsitePage.create(
          {
            workspaceId,
            websiteId: website.id,
            path,
            title: tp.title || 'Untitled',
            pageType,
            draftData,
            publishedData: null,
            seo: deepClone(tp.seo || {}) || {},
          },
          { transaction: t }
        );
        createdPages.push(page);
      }
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'website.create',
      entityType: 'Website',
      entityId: website.id,
      after: website.toJSON(),
      metadata: templateVersion
        ? { fromTemplateVersionId: templateVersion.id, pagesCopied: createdPages.length }
        : undefined,
      req,
      transaction: t,
    });

    return { website, pages: createdPages };
  });
}

async function listWebsites(workspaceId) {
  return db.Website.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
}

async function getWebsite(workspaceId, websiteId) {
  const website = await loadWebsite(workspaceId, websiteId);
  const pages = await db.WebsitePage.findAll({
    where: { workspaceId, websiteId },
    order: [['path', 'ASC']],
  });
  let publishedRevision = null;
  if (website.publishedRevisionId) {
    const rev = await db.WebsiteRevision.findOne({
      where: { id: website.publishedRevisionId, websiteId },
      attributes: ['id', 'revisionNumber', 'note', 'createdAt'],
    });
    if (rev) publishedRevision = rev;
  }
  return {
    website,
    pages: pages.map((p) => ({
      ...p.toJSON(),
      isLive: p.publishedData != null,
    })),
    publishedRevision,
  };
}

async function updateWebsite(workspaceId, websiteId, data, req) {
  const website = await loadWebsite(workspaceId, websiteId);
  const before = website.toJSON();
  const patch = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.globalStyles !== undefined) patch.globalStyles = data.globalStyles;
  if (data.seo !== undefined) patch.seo = data.seo;
  await website.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'website.update',
    entityType: 'Website',
    entityId: website.id,
    before,
    after: website.toJSON(),
    req,
  });
  return website;
}

async function deleteWebsite(workspaceId, websiteId, req) {
  const website = await loadWebsite(workspaceId, websiteId);
  const before = website.toJSON();
  // pages / revisions / redirects cascade via FK.
  await website.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'website.delete',
    entityType: 'Website',
    entityId: websiteId,
    before,
    req,
  });
  return { deleted: true };
}

// --- pages ------------------------------------------------------------------

async function createPage(workspaceId, websiteId, data, req) {
  await loadWebsite(workspaceId, websiteId);
  const path = normalizePath(data.path);
  const draftData = data.draftData !== undefined ? data.draftData : EMPTY_TREE;
  validatePageTree(draftData, { label: `page "${path}"` });

  const clash = await db.WebsitePage.findOne({ where: { websiteId, path }, attributes: ['id'] });
  if (clash) throw new ConflictError(`A page already exists at "${path}"`, 'PAGE_PATH_TAKEN');

  const page = await db.WebsitePage.create({
    workspaceId,
    websiteId,
    path,
    title: data.title,
    pageType: data.pageType || 'custom',
    draftData,
    publishedData: null,
    seo: data.seo || {},
  });

  // A freshly (re)created path must resolve to this page, not keep redirecting.
  await db.WebsitePageRedirect.destroy({ where: { websiteId, fromPath: path } });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'page.create',
    entityType: 'WebsitePage',
    entityId: page.id,
    after: page.toJSON(),
    req,
  });
  return page;
}

async function listPages(workspaceId, websiteId) {
  await loadWebsite(workspaceId, websiteId);
  const pages = await db.WebsitePage.findAll({
    where: { workspaceId, websiteId },
    order: [['path', 'ASC']],
  });
  return pages.map((p) => ({ ...p.toJSON(), isLive: p.publishedData != null }));
}

async function getPage(workspaceId, websiteId, pageId) {
  const page = await loadPage(workspaceId, websiteId, pageId);
  const redirects = await db.WebsitePageRedirect.findAll({
    where: { websiteId, [Op.or]: [{ pageId }, { toPath: page.path }] },
    attributes: ['fromPath', 'toPath', 'statusCode'],
  });
  return { ...page.toJSON(), isLive: page.publishedData != null, incomingRedirects: redirects };
}

async function updatePage(workspaceId, websiteId, pageId, data, req) {
  return db.sequelize.transaction(async (t) => {
    await scoped(db.Website, workspaceId).findByPkOrThrow(websiteId, { transaction: t });
    const page = await loadPage(workspaceId, websiteId, pageId, t);
    const before = page.toJSON();

    const patch = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.pageType !== undefined) patch.pageType = data.pageType;
    if (data.seo !== undefined) patch.seo = data.seo;
    if (data.draftData !== undefined) {
      validatePageTree(data.draftData, { label: `page "${page.path}"` });
      patch.draftData = data.draftData;
    }

    let redirect = null;
    if (data.path !== undefined) {
      const newPath = normalizePath(data.path);
      const oldPath = page.path;
      if (newPath !== oldPath) {
        const clash = await db.WebsitePage.findOne({
          where: { websiteId, path: newPath, id: { [Op.ne]: pageId } },
          attributes: ['id'],
          transaction: t,
        });
        if (clash) throw new ConflictError(`Another page already uses the path "${newPath}"`, 'PAGE_PATH_TAKEN');

        // The new path must resolve to THIS page — drop any redirect sending it elsewhere.
        await db.WebsitePageRedirect.destroy({ where: { websiteId, fromPath: newPath }, transaction: t });

        // Only a *published* page's URL is "real" and worth preserving.
        const isLive = page.publishedData != null;
        if (isLive) {
          // Collapse chains: anything that pointed at the old path now points at the new one.
          await db.WebsitePageRedirect.update(
            { toPath: newPath, pageId },
            { where: { websiteId, toPath: oldPath }, transaction: t }
          );
          const [row, created] = await db.WebsitePageRedirect.findOrCreate({
            where: { websiteId, fromPath: oldPath },
            defaults: { workspaceId, websiteId, fromPath: oldPath, toPath: newPath, pageId, statusCode: 301 },
            transaction: t,
          });
          if (!created) {
            await row.update({ toPath: newPath, pageId, statusCode: 301 }, { transaction: t });
          }
          redirect = row;
        }
        patch.path = newPath;
      }
    }

    await page.update(patch, { transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'page.update',
      entityType: 'WebsitePage',
      entityId: page.id,
      before,
      after: page.toJSON(),
      metadata: redirect ? { redirectFrom: redirect.fromPath, redirectTo: redirect.toPath } : undefined,
      req,
      transaction: t,
    });

    return { ...page.toJSON(), isLive: page.publishedData != null, redirectCreated: redirect ? redirect.toJSON() : null };
  });
}

async function deletePage(workspaceId, websiteId, pageId, req) {
  const page = await loadPage(workspaceId, websiteId, pageId);
  const before = page.toJSON();
  // Redirects that target this page have page_id set to NULL by the FK; they
  // still resolve by to_path string. The live snapshot is untouched until the
  // next publish, so a deleted-but-still-published page keeps serving until then.
  await page.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'page.delete',
    entityType: 'WebsitePage',
    entityId: pageId,
    before,
    metadata: before.publishedData != null ? { wasLive: true, republishToRemoveFromLive: true } : undefined,
    req,
  });
  return { deleted: true, wasLive: before.publishedData != null };
}

// --- publish / revisions / rollback --------------------------------------

async function publishWebsite(workspaceId, websiteId, userId, note, req) {
  return db.sequelize.transaction(async (t) => {
    // Lock the website row: serialises concurrent publishes so they can't both
    // claim the same revision_number (unique (website_id, revision_number)).
    const website = await db.Website.findOne({
      where: { id: websiteId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!website) throw new NotFoundError('Website');

    const pages = await db.WebsitePage.findAll({
      where: { workspaceId, websiteId },
      order: [['path', 'ASC']],
      transaction: t,
    });

    // --- pre-publish validation: collect every problem, then reject once ---
    const problems = [];
    if (pages.length === 0) {
      problems.push({ field: 'pages', message: 'This site has no pages — add a home page at "/" before publishing' });
    } else if (!pages.some((p) => p.path === '/')) {
      problems.push({ field: 'pages', message: 'This site has no home page — create a page at path "/" before publishing' });
    }
    for (const p of pages) {
      try {
        validatePageTree(p.draftData, { requireContent: true, label: `page "${p.path}"` });
      } catch (err) {
        if (err instanceof ValidationError && Array.isArray(err.details)) {
          err.details.forEach((d) => problems.push({ pageId: p.id, path: p.path, field: d.field, message: d.message }));
        } else {
          throw err;
        }
      }
    }
    if (problems.length) {
      throw new ValidationError(problems, 'Website cannot be published yet — fix the issues below');
    }

    const maxRow = await db.WebsiteRevision.findOne({
      where: { websiteId },
      order: [['revisionNumber', 'DESC']],
      attributes: ['revisionNumber'],
      transaction: t,
    });
    const revisionNumber = (maxRow ? maxRow.revisionNumber : 0) + 1;

    const snapshotPages = [];
    for (const p of pages) {
      await p.update({ publishedData: p.draftData }, { transaction: t });
      snapshotPages.push({
        id: p.id,
        path: p.path,
        title: p.title,
        pageType: p.pageType,
        data: p.draftData,
        seo: p.seo,
      });
    }

    const snapshot = {
      pages: snapshotPages,
      globalStyles: website.globalStyles,
      seo: website.seo,
    };

    const revision = await db.WebsiteRevision.create(
      {
        workspaceId,
        websiteId,
        revisionNumber,
        snapshot,
        publishedByUserId: userId,
        note: note || null,
      },
      { transaction: t }
    );

    await website.update({ status: 'published', publishedRevisionId: revision.id }, { transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: userId,
      action: 'website.publish',
      entityType: 'Website',
      entityId: website.id,
      after: { revisionId: revision.id, revisionNumber, pageCount: snapshotPages.length },
      metadata: { revisionNumber },
      req,
      transaction: t,
    });

    return { website, revision };
  });
}

async function listRevisions(workspaceId, websiteId) {
  await loadWebsite(workspaceId, websiteId);
  const revisions = await db.WebsiteRevision.findAll({
    where: { workspaceId, websiteId },
    order: [['revisionNumber', 'DESC']],
    attributes: ['id', 'revisionNumber', 'note', 'publishedByUserId', 'createdAt', 'snapshot'],
  });
  return revisions.map((r) => ({
    id: r.id,
    revisionNumber: r.revisionNumber,
    note: r.note,
    publishedByUserId: r.publishedByUserId,
    createdAt: r.createdAt,
    pageCount: Array.isArray(r.snapshot && r.snapshot.pages) ? r.snapshot.pages.length : 0,
  }));
}

async function rollbackToRevision(workspaceId, websiteId, revisionId, userId, req) {
  return db.sequelize.transaction(async (t) => {
    const website = await db.Website.findOne({
      where: { id: websiteId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!website) throw new NotFoundError('Website');

    const revision = await db.WebsiteRevision.findOne({
      where: { id: revisionId, websiteId, workspaceId },
      transaction: t,
    });
    if (!revision) throw new NotFoundError('WebsiteRevision');

    const snapshot = revision.snapshot || {};
    const snapPages = Array.isArray(snapshot.pages) ? snapshot.pages : [];
    const snapById = new Map(snapPages.map((sp) => [sp.id, sp]));

    // Keep the convenience mirror (publishedData) consistent with the revision
    // we're rolling back to. The render path itself reads the snapshot, so this
    // is purely for the staff "isLive" view.
    const pages = await db.WebsitePage.findAll({ where: { workspaceId, websiteId }, transaction: t });
    for (const p of pages) {
      const sp = snapById.get(p.id);
      await p.update({ publishedData: sp ? sp.data : null }, { transaction: t });
    }

    await website.update({ status: 'published', publishedRevisionId: revision.id }, { transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: userId,
      action: 'website.rollback',
      entityType: 'Website',
      entityId: website.id,
      after: { revisionId: revision.id, revisionNumber: revision.revisionNumber },
      metadata: { rolledBackToRevision: revision.revisionNumber },
      req,
      transaction: t,
    });

    return { website, revision };
  });
}

// --- public render-data API ---------------------------------------------

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function resolveOg({ website, path, pageTitle, pageSeo, siteSeo }) {
  const title =
    firstNonEmpty(pageSeo.ogTitle, pageSeo.title, pageTitle, siteSeo.ogTitle, siteSeo.title, website.name) ||
    'Untitled page';
  const description =
    firstNonEmpty(pageSeo.ogDescription, pageSeo.description, siteSeo.ogDescription, siteSeo.description) ||
    `${website.name}${pageTitle ? ` — ${pageTitle}` : ''}`;
  const image =
    firstNonEmpty(pageSeo.ogImage, pageSeo.image, siteSeo.ogImage, siteSeo.image) ||
    `${String(env.appUrl).replace(/\/$/, '')}/og-default.png`;
  const base = `https://${website.subdomain}.${env.platformRootDomain}`;
  const url = firstNonEmpty(pageSeo.canonical) || `${base}${path === '/' ? '' : path}`;
  return { title, description, image, url, type: 'website' };
}

function buildRenderData(website, snapshot, snapPage, path) {
  const pageSeo = snapPage.seo || {};
  const siteSeo = snapshot.seo || {};
  return {
    page: {
      path: snapPage.path,
      title: snapPage.title,
      pageType: snapPage.pageType,
      tree: snapPage.data,
      seo: pageSeo,
      og: resolveOg({ website, path, pageTitle: snapPage.title, pageSeo, siteSeo }),
    },
    site: {
      name: website.name,
      subdomain: website.subdomain,
      globalStyles: snapshot.globalStyles || {},
      seo: siteSeo,
    },
  };
}

/**
 * Public: given a workspace and a path, return the currently-published render
 * data for that page, or signal a permanent redirect, or 404. Reads only the
 * frozen snapshot of the workspace's live website.
 */
async function getPublishedPageForStore(workspaceId, rawPath) {
  const path = normalizePath(rawPath || '/');

  const website = await db.Website.findOne({
    where: { workspaceId, status: 'published', publishedRevisionId: { [Op.ne]: null } },
    order: [['updatedAt', 'DESC']],
  });
  if (!website) throw new NotFoundError('Website');

  const revision = await db.WebsiteRevision.findOne({
    where: { id: website.publishedRevisionId, websiteId: website.id },
  });
  if (!revision) throw new NotFoundError('Website');

  const snapshot = revision.snapshot || {};
  const snapPages = Array.isArray(snapshot.pages) ? snapshot.pages : [];
  const match = snapPages.find((p) => p.path === path);
  if (match) {
    return { kind: 'page', data: buildRenderData(website, snapshot, match, path) };
  }

  const redirect = await db.WebsitePageRedirect.findOne({ where: { websiteId: website.id, fromPath: path } });
  if (redirect) {
    return { kind: 'redirect', to: redirect.toPath, statusCode: redirect.statusCode || 301 };
  }

  throw new NotFoundError('Page');
}

module.exports = {
  normalizePath,
  createWebsite,
  listWebsites,
  getWebsite,
  updateWebsite,
  deleteWebsite,
  createPage,
  listPages,
  getPage,
  updatePage,
  deletePage,
  publishWebsite,
  listRevisions,
  rollbackToRevision,
  getPublishedPageForStore,
};
