'use strict';

const db = require('../../db/models');
const { NotFoundError, ConflictError } = require('../../core/errors/AppError');

// The "current" version of a template = the highest `version` number that is
// still active. A published template with no active version is not offered.
async function latestActiveVersion(templateId, transaction) {
  return db.TemplateVersion.findOne({
    where: { templateId, isActive: true },
    order: [['version', 'DESC']],
    ...(transaction ? { transaction } : {}),
  });
}

// The card the gallery grid renders. `primaryColor` falls back to the active
// version's globalStyles, so a template whose denormalized column was never
// filled in still paints the right swatch. `priceAmount` is a BIGINT column,
// which pg hands back as a string — the API emits it as a number.
function toGalleryCard(template, version) {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    thumbnailUrl: template.thumbnailUrl,
    kind: template.kind,
    priceAmount: Number(template.priceAmount),
    isFree: template.isFree,
    primaryColor: template.primaryColor || (version.globalStyles || {}).primaryColor || null,
    tags: template.tags || [],
    rtl: template.rtl,
    templateVersionId: version.id,
  };
}

// `kind` is the gallery's tab (store / funnel / landing). Absent = the whole
// grid, which is what the picker opens on.
async function listPublishedTemplates({ kind } = {}) {
  const templates = await db.Template.findAll({
    where: { isPublished: true, ...(kind ? { kind } : {}) },
    order: [['name', 'ASC']],
  });

  const out = [];
  for (const t of templates) {
    const version = await latestActiveVersion(t.id);
    if (!version) continue;
    out.push(toGalleryCard(t, version));
  }
  return out;
}

async function getTemplateDetail(id) {
  const template = await db.Template.findOne({ where: { id, isPublished: true } });
  if (!template) throw new NotFoundError('Template');

  const version = await latestActiveVersion(id);
  if (!version) throw new NotFoundError('Template');

  return {
    ...toGalleryCard(template, version),
    isPublished: template.isPublished,
    version: version.version,
    globalStyles: version.globalStyles,
    pages: version.pages,
    sections: version.sections,
  };
}

// ------------------------------------------------------------------- admin
// The write side of the gallery, driven by /api/v1/admin/templates. Kept in
// this module rather than platformAdmin's so one file owns what a Template
// row means; the admin routes only supply the platform-admin guard.

// The columns the editor owns. Version content (pages, sections, styles) is
// deliberately not here: a version is the immutable thing a merchant's site is
// copied from, and it is authored, not edited in a metadata form.
const EDITABLE = ['name', 'category', 'thumbnailUrl', 'isPublished', 'kind', 'priceAmount', 'isFree', 'primaryColor', 'tags', 'rtl'];

// Nullable text columns. A form clears one by sending "", which has to land as
// NULL so the gallery's "no value — fall back" branches still fire.
const NULLABLE_TEXT = new Set(['category', 'thumbnailUrl', 'primaryColor']);

/**
 * The admin grid's row. Two things separate it from the public gallery card:
 *
 * - `primaryColor` is the raw column, with no fallback to the version's
 *   globalStyles. The card resolves it for display; the editor must not, or
 *   saving the form back would freeze an inherited colour into the column.
 * - `versionCount` / `activeVersion` exist because the public list silently
 *   drops a template with no active version. Without them a published
 *   template that never appears in the gallery has no visible explanation.
 */
function toAdminRow(template, versions = []) {
  const active = versions.find((v) => v.isActive) || null;
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    thumbnailUrl: template.thumbnailUrl,
    isPublished: template.isPublished,
    kind: template.kind,
    priceAmount: Number(template.priceAmount),
    isFree: template.isFree,
    primaryColor: template.primaryColor,
    tags: template.tags || [],
    rtl: template.rtl,
    versionCount: versions.length,
    activeVersion: active ? active.version : null,
    templateVersionId: active ? active.id : null,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

// Newest-first: the row an admin just created is the one they want to see.
const ADMIN_ORDER = [['createdAt', 'DESC']];
// Newest version first, so the first active entry found is the current one.
const VERSION_ORDER = [['version', 'DESC']];

async function listAllTemplates({ kind } = {}) {
  const templates = await db.Template.findAll({
    where: kind ? { kind } : undefined,
    order: ADMIN_ORDER,
  });
  if (templates.length === 0) return [];

  // One query for every version rather than one per template: this list is the
  // whole library, drafts included, so it is the longest loop in the module.
  const versions = await db.TemplateVersion.findAll({
    where: { templateId: templates.map((t) => t.id) },
    order: VERSION_ORDER,
  });
  const byTemplate = new Map();
  for (const v of versions) {
    if (!byTemplate.has(v.templateId)) byTemplate.set(v.templateId, []);
    byTemplate.get(v.templateId).push(v);
  }
  return templates.map((t) => toAdminRow(t, byTemplate.get(t.id) || []));
}

function versionsOf(templateId) {
  return db.TemplateVersion.findAll({ where: { templateId }, order: VERSION_ORDER });
}

/** Create (no `id`) or update (with `id`). The update is partial — only keys
 *  actually present are written, so a grid that toggles one switch cannot
 *  blank out the fields its form never loaded. */
async function saveTemplate(input) {
  const fields = {};
  for (const key of EDITABLE) {
    if (input[key] === undefined) continue;
    fields[key] = NULLABLE_TEXT.has(key) && input[key] === '' ? null : input[key];
  }

  const template = input.id ? await db.Template.findByPk(input.id) : null;
  if (input.id && !template) throw new NotFoundError('Template');

  // A template being created has no versions yet, which is exactly why the
  // guard below applies to it too: nothing can be born published.
  const versions = template ? await versionsOf(template.id) : [];

  // Publishing a template with no active version puts it nowhere: the gallery
  // drops it on the way out. Refuse loudly instead of leaving the console
  // showing "published" next to a template that never appears.
  if (fields.isPublished === true && !versions.some((v) => v.isActive)) {
    throw new ConflictError(
      'This template has no active version yet, so publishing it would hide it from the gallery',
      'TEMPLATE_HAS_NO_ACTIVE_VERSION'
    );
  }

  if (!template) return toAdminRow(await db.Template.create(fields), []);

  await template.update(fields);
  return toAdminRow(template, versions);
}

async function deleteTemplate(id) {
  const template = await db.Template.findByPk(id);
  if (!template) throw new NotFoundError('Template');

  const versions = await versionsOf(id);
  if (versions.length > 0) {
    // websites.source_template_version_id is ON DELETE SET NULL, so the
    // database would let this through and quietly cut every affected site
    // loose from the template it came from. This guard is the only thing
    // keeping that provenance.
    const inUse = await db.Website.count({
      where: { sourceTemplateVersionId: versions.map((v) => v.id) },
    });
    if (inUse > 0) {
      throw new ConflictError(
        `${inUse} website(s) were created from this template — unpublish it instead`,
        'TEMPLATE_IN_USE'
      );
    }
  }

  // template_versions.template_id is ON DELETE CASCADE, so the versions go
  // with it; nothing was built from them, per the check above.
  await template.destroy();
  return { success: true };
}

module.exports = {
  listPublishedTemplates,
  getTemplateDetail,
  latestActiveVersion,
  listAllTemplates,
  saveTemplate,
  deleteTemplate,
};
