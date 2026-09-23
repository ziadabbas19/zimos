'use strict';

// The seeded templates used to ship thumbnail URLs under media.zimos.co, a
// host that never served those files, so every gallery card rendered a broken
// image. The seeder no longer sets one, and migration 086 clears the rows
// production already has.

const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const seeder = require('../../src/db/seeders/20260103000000-website-templates');
const clearThumbnails = require('../../src/db/migrations/086-clear-seeded-template-thumbnails');

describe('template thumbnails', () => {
  it('seeds every template with no thumbnail rather than a URL that 404s', async () => {
    await seeder.up(db.sequelize.getQueryInterface());

    const templates = await db.Template.findAll();
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) expect(t.thumbnailUrl).toBeNull();

    // The public gallery serves that null through untouched.
    const res = await request(app).get('/api/v1/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates.length).toBe(templates.length);
    for (const card of res.body.templates) expect(card.thumbnailUrl).toBeNull();
  });

  it('migration 086 clears only the seeded URLs, leaving a real thumbnail alone', async () => {
    const seeded = await db.Template.create({
      name: 'Seeded look',
      thumbnailUrl: 'https://media.zimos.co/templates/minimal.png',
      isPublished: true,
    });
    const uploaded = await db.Template.create({
      name: 'Real screenshot',
      thumbnailUrl: 'https://media.example.com/uploads/real.png',
      isPublished: true,
    });

    await clearThumbnails.up(db.sequelize.getQueryInterface());

    expect((await db.Template.findByPk(seeded.id)).thumbnailUrl).toBeNull();
    expect((await db.Template.findByPk(uploaded.id)).thumbnailUrl).toBe('https://media.example.com/uploads/real.png');
  });
});
