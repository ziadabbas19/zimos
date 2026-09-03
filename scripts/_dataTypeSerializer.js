'use strict';

// Converts a live Sequelize DataType instance (as found on model.rawAttributes[x].type)
// into a string of JS source that reconstructs it against `Sequelize.DataTypes` inside
// a migration file. This keeps every migration's column type in lockstep with the
// model definition it was generated from, rather than hand-duplicating types.
function serialize(type) {
  const key = type.key;
  switch (key) {
    case 'STRING': {
      const len = type.options && type.options.length;
      return len ? `DataTypes.STRING(${len})` : 'DataTypes.STRING';
    }
    case 'TEXT':
      return 'DataTypes.TEXT';
    case 'CITEXT':
      return 'DataTypes.CITEXT';
    case 'UUID':
      return 'DataTypes.UUID';
    case 'BIGINT':
      return 'DataTypes.BIGINT';
    case 'INTEGER':
      return 'DataTypes.INTEGER';
    case 'BOOLEAN':
      return 'DataTypes.BOOLEAN';
    case 'DATE':
      return 'DataTypes.DATE';
    case 'JSONB':
      return 'DataTypes.JSONB';
    case 'ENUM':
      return `DataTypes.ENUM(${type.values.map((v) => `'${v}'`).join(', ')})`;
    case 'ARRAY':
      return `DataTypes.ARRAY(${serialize(type.options.type)})`;
    default:
      throw new Error(`Unhandled DataType key in migration serializer: ${key}`);
  }
}

module.exports = { serialize };
