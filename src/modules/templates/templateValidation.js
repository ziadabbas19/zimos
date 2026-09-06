'use strict';

const Joi = require('joi');

module.exports = {
  getOne: { params: Joi.object({ id: Joi.string().uuid().required() }) },
};
