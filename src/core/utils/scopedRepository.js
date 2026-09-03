'use strict';

const { NotFoundError } = require('../errors/AppError');

/**
 * Wraps a Sequelize model so every read/write is forced to a single
 * workspaceId — a service using `scoped(db.Product, workspaceId)` can't
 * touch another workspace's row even if it forgets a `where` clause. The
 * `OrThrow` variants raise NotFoundError instead of returning null for a
 * row in another workspace.
 */
function scoped(model, workspaceId, resourceName = model.name) {
  if (!workspaceId) {
    throw new Error('scoped() called without a workspaceId — refusing to build an unscoped repository');
  }

  const withScope = (where = {}) => ({ ...where, workspaceId });

  return {
    model,

    async findAll(options = {}) {
      return model.findAll({ ...options, where: withScope(options.where) });
    },

    async findOne(options = {}) {
      return model.findOne({ ...options, where: withScope(options.where) });
    },

    async findByPk(id, options = {}) {
      return model.findOne({ ...options, where: withScope({ id }) });
    },

    async findByPkOrThrow(id, options = {}) {
      const row = await this.findByPk(id, options);
      if (!row) throw new NotFoundError(resourceName);
      return row;
    },

    async count(options = {}) {
      return model.count({ ...options, where: withScope(options.where) });
    },

    async create(data, options = {}) {
      return model.create({ ...data, workspaceId }, options);
    },

    async update(id, data, options = {}) {
      const row = await this.findByPkOrThrow(id, options);
      return row.update(data, options);
    },

    async destroy(id, options = {}) {
      const row = await this.findByPkOrThrow(id, options);
      await row.destroy(options);
      return row;
    },
  };
}

module.exports = { scoped };
