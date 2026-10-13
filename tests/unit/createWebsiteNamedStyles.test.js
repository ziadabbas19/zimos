'use strict';

// Only the check that runs before anything is stored: the model layer is
// stubbed out, so this file loads no models.
const mockTransaction = jest.fn();
jest.mock('../../src/db/models', () => ({ sequelize: { transaction: mockTransaction }, Sequelize: { Op: {} } }));

const pagesService = require('../../src/modules/pages/pagesService');

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const req = { user: { id: 'user-1' } };
const named = (style) => ({ named: [{ id: 'primary', name: 'Primary', style }] });

// A new website's named styles (pages/pagesService.createWebsite): they feed
// the storefront's stylesheet, so they are checked before the site is stored,
// exactly as an update checks them.
describe('createWebsite named styles', () => {
  beforeEach(() => {
    mockTransaction.mockReset().mockResolvedValue({ website: {}, pages: [] });
  });

  it.each([
    ['a colour that is not a hex colour', named({ base: { color: 'red;}/*' } })],
    ['markup in a colour', named({ base: { background: '</style><script>' } })],
    ['a style key that is not on the list', named({ base: { content: 'x' } })],
    ['a device that does not exist', named({ desktop: { color: '#ffffff' } })],
    ['a named list that is not a list', { named: 'primary' }],
    ['a style id with other characters', { named: [{ id: 'a b', name: 'Primary', style: {} }] }],
  ])('refuses %s and stores nothing', async (_name, globalStyles) => {
    await expect(pagesService.createWebsite(WORKSPACE, { name: 'Site', globalStyles }, req)).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Invalid global styles',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('lets a valid named style, other keys and no styles at all through to the store', async () => {
    await pagesService.createWebsite(WORKSPACE, { name: 'Site', globalStyles: named({ base: { color: '#1a2b3c' }, mobile: { fontSize: 14 } }) }, req);
    await pagesService.createWebsite(WORKSPACE, { name: 'Site', globalStyles: { primaryColor: '#ff0000' } }, req);
    await pagesService.createWebsite(WORKSPACE, { name: 'Site' }, req);
    expect(mockTransaction).toHaveBeenCalledTimes(3);
  });
});
