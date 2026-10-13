'use strict';

// refresh() with its storage stubbed out: this file loads no models.
const mockSession = { findOne: jest.fn(), findByPk: jest.fn(), update: jest.fn(), create: jest.fn(), addHook: () => {} };
const mockUser = { findByPk: jest.fn() };
const mockTransaction = { id: 'tx-1' };
jest.mock('../../src/db/models', () => ({
  Sequelize: { Op: {} },
  sequelize: { transaction: (work) => work(mockTransaction) },
  Session: mockSession,
  User: mockUser,
}));
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn().mockResolvedValue() }));

const { recordAudit } = require('../../src/modules/audit/auditService');
const authService = require('../../src/modules/auth/authService');

const req = { headers: { 'user-agent': 'jest' }, ip: '198.51.100.9' };
const liveSession = () => ({ id: 'session-old', userId: 'user-1', revokedAt: null, rotatedToSessionId: null, expiresAt: new Date(Date.now() + 60000) });

// Refresh-token rotation (auth/authService.refresh): one token makes one new
// session. The old session is ended by a write that only lands while it is
// still live; a request that finds it already ended is a second presentation.
describe('refresh', () => {
  beforeEach(() => {
    recordAudit.mockClear();
    mockSession.findOne.mockReset().mockResolvedValue(liveSession());
    mockSession.findByPk.mockReset();
    mockSession.update.mockReset();
    mockSession.create.mockReset().mockImplementation(async (row) => ({ ...row }));
    mockUser.findByPk.mockReset().mockResolvedValue({ id: 'user-1', status: 'active' });
  });

  it('ends the old session only while it is live, and writes the new one with it', async () => {
    mockSession.update.mockResolvedValue([1]);
    const result = await authService.refresh('raw-token', req);

    expect(mockSession.update).toHaveBeenCalledTimes(1);
    const [patch, options] = mockSession.update.mock.calls[0];
    expect(options.where).toEqual({ id: 'session-old', revokedAt: null });
    expect(options.transaction).toBe(mockTransaction);
    expect(patch.revokedAt).toBeInstanceOf(Date);

    // The successor is the session the old one was pointed at, in the same transaction.
    expect(mockSession.create).toHaveBeenCalledTimes(1);
    const [row, createOptions] = mockSession.create.mock.calls[0];
    expect(row.id).toBe(patch.rotatedToSessionId);
    expect(row.userId).toBe('user-1');
    expect(createOptions.transaction).toBe(mockTransaction);
    expect(result.sessionId).toBe(patch.rotatedToSessionId);
    expect(result.refreshToken).toEqual(expect.any(String));
  });

  it('a request that finds the session already ended makes no session and is handled as a reuse', async () => {
    // First call: the conditional end matches nothing. Second: the account-wide sweep.
    mockSession.update.mockResolvedValueOnce([0]).mockResolvedValueOnce([2]);
    mockSession.findByPk.mockResolvedValue({ id: 'session-old', userId: 'user-1', revokedAt: new Date(Date.now() - 1000), rotatedToSessionId: 'session-winner' });

    await expect(authService.refresh('raw-token', req)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSE_DETECTED', statusCode: 401 });

    expect(mockSession.create).not.toHaveBeenCalled();
    // The sweep runs on its own, after the rotation's transaction, so the 401 does not undo it.
    const [sweepPatch, sweepOptions] = mockSession.update.mock.calls[1];
    expect(sweepOptions.where).toEqual({ userId: 'user-1', revokedAt: null });
    expect(sweepOptions.transaction).toBeUndefined();
    expect(sweepPatch.revokedAt).toBeInstanceOf(Date);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0][0]).toMatchObject({ action: 'user.refresh_reuse_detected', metadata: { sessionsRevoked: 2, rotated: true } });
  });

  it('a token already rotated away is a reuse, as before', async () => {
    mockSession.findOne.mockResolvedValue({ ...liveSession(), revokedAt: new Date(Date.now() - 5000), rotatedToSessionId: 'session-next' });
    mockSession.update.mockResolvedValue([1]);
    await expect(authService.refresh('raw-token', req)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSE_DETECTED' });
    expect(mockSession.create).not.toHaveBeenCalled();
    expect(mockSession.update.mock.calls[0][1].where).toEqual({ userId: 'user-1', revokedAt: null });
  });

  it('an unknown token is refused before anything is written', async () => {
    mockSession.findOne.mockResolvedValue(null);
    await expect(authService.refresh('raw-token', req)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(mockSession.update).not.toHaveBeenCalled();
  });
});
