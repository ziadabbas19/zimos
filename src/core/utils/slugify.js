'use strict';

function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180) || 'workspace';
}

module.exports = slugify;
