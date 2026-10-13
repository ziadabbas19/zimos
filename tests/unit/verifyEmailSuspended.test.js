'use strict';

// verifyEmail with its storage stubbed out: this file loads no models.
const mockTokenFindOne = jest.fn();
const mockUserFindByPk = jest.fn();
jest.mock('../../src/db/models', () => ({
  Sequelize: { Op: {} },
  sequelize: { transaction: (work) => work({ LOCK: { UPDATE: 'UPDATE' } }) },
  VerificationToken: { findOne: mockTokenFindOne },
  User: { findByPk: mockUserFindByPk },
  // core/security/sessionGate registers its hooks when it loads.
  Session: { addHook: () => {} },
}));

const authService = require('../../src/modules/auth/authService');

function userRow(fields) {
  const row = {
    id: 'user-1',
    status: 'pending_verification',
    deletedAt: null,
    emailVerifiedAt: null,
    ...fields,
    update: jest.fn(async (patch) => Object.assign(row, patch)),
    toSafeJSON: () => ({ id: row.id, status: row.status, emailVerifiedAt: row.emailVerifiedAt }),
  };
  return row;
}

// The email-verification link (auth/authService.verifyEmail): it confirms an
// address and activates an account that was waiting for that — never one the
// platform suspended or deleted after the link was sent.
describe('verifyEmail', () => {
  let token;
  beforeEach(() => {
    token = { userId: 'user-1', usedAt: null, expiresAt: new Date(Date.now() + 60000), update: jest.fn().mockResolvedValue() };
    mockTokenFindOne.mockReset().mockResolvedValue(token);
    mockUserFindByPk.mockReset();
  });

  it('activates an account still waiting for its email', async () => {
    const user = userRow({ status: 'pending_verification' });
    mockUserFindByPk.mockResolvedValue(user);
    const result = await authService.verifyEmail('raw-token');
    expect(result.status).toBe('active');
    expect(user.update.mock.calls[0][0]).toMatchObject({ status: 'active', emailVerifiedAt: expect.any(Date) });
    expect(token.update).toHaveBeenCalledWith({ usedAt: expect.any(Date) }, expect.anything());
  });

  it('leaves a suspended account suspended, and still spends the link', async () => {
    const user = userRow({ status: 'suspended' });
    mockUserFindByPk.mockResolvedValue(user);
    const result = await authService.verifyEmail('raw-token');
    expect(result.status).toBe('suspended');
    expect(user.update).toHaveBeenCalledTimes(1);
    expect(user.update.mock.calls[0][0]).not.toHaveProperty('status');
    expect(user.update.mock.calls[0][0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(token.update).toHaveBeenCalledTimes(1);
  });

  it('does not touch the status of an account that is already active', async () => {
    const user = userRow({ status: 'active' });
    mockUserFindByPk.mockResolvedValue(user);
    await authService.verifyEmail('raw-token');
    expect(user.update.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('refuses the link of a deleted account and writes nothing', async () => {
    const user = userRow({ status: 'suspended', deletedAt: new Date() });
    mockUserFindByPk.mockResolvedValue(user);
    await expect(authService.verifyEmail('raw-token')).rejects.toMatchObject({ code: 'INVALID_VERIFICATION_TOKEN', statusCode: 400 });
    expect(user.update).not.toHaveBeenCalled();
    expect(token.update).not.toHaveBeenCalled();
  });

  it('reads the account under a row lock, in the same transaction as the token', async () => {
    mockUserFindByPk.mockResolvedValue(userRow({}));
    await authService.verifyEmail('raw-token');
    expect(mockUserFindByPk.mock.calls[0][1]).toMatchObject({ lock: 'UPDATE' });
  });
});
