'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');

// The "current" version of a template = the highest `version` number that is
// still active. A published template with no active version is not offered.
async function latestActiveVersion(templateId, transaction) {
  return db.TemplateVersion.findOne({
    where: { templateId, isActive: true },
    order: [['version', 'DESC']],
    ...(transaction ? { transaction } : {}),
  });
}

async function listPublishedTemplates() {
  const templates = await db.Template.findAll({
    where: { isPublished: true },
    order: [['name', 'ASC']],
  });

  const out = [];
  for (const t of templates) {
    const version = await latestActiveVersion(t.id);
    if (!version) continue;
    out.push({
      id: t.id,
      name: t.name,
      category: t.category,
      thumbnailUrl: t.thumbnailUrl,
      templateVersionId: version.id,
    });
  }
  return out;
}

async function getTemplateDetail(id) {
  const template = await db.Template.findOne({ where: { id, isPublished: true } });
  if (!template) throw new NotFoundError('Template');

  const version = await latestActiveVersion(id);
  if (!version) throw new NotFoundError('Template');

  return {
    id: template.id,
    name: template.name,
    category: template.category,
    thumbnailUrl: template.thumbnailUrl,
    isPublished: template.isPublished,
    templateVersionId: version.id,
    version: version.version,
    globalStyles: version.globalStyles,
    pages: version.pages,
    sections: version.sections,
  };
}

module.exports = { listPublishedTemplates, getTemplateDetail, latestActiveVersion };
