'use strict';

const fs = require('fs');
const path = require('path');
const { DataTypes } = require('sequelize');
const sequelize = require('../connection');

const db = {};
const basename = path.basename(__filename);

fs
  .readdirSync(__dirname)
  .filter((file) => file !== basename && file.endsWith('.js') && !file.startsWith('_'))
  .forEach((file) => {
    const definer = require(path.join(__dirname, file));
    const model = definer(sequelize, DataTypes);
    db[model.name] = model;
  });

Object.values(db).forEach((model) => {
  if (typeof model.associate === 'function') {
    model.associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = require('sequelize');

module.exports = db;
