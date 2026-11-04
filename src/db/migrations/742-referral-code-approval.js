'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Referral codes made by their own agents wait for a creator's review
 * (referrals/referralCodeService).
 *
 *   approval_status      'pending' | 'approved' | 'rejected'. Every code that
 *                        exists today is 'approved'
 *   approval_note        why it was rejected; optional
 *   changes_rejected     the owner's last change to an approved code was
 *                        rejected: the code itself goes on as it was
 *   pending_changes      the owner's change to an approved code, as columns.
 *                        Nothing reads it for pricing: stores using the code
 *                        keep what was approved until a creator approves this
 *   reviewed_by_user_id / reviewed_at   the last review
 *
 * Run-twice safe (every step guarded). down removes everything added here: a
 * code still waiting stays switched off (active false), and a change still
 * waiting is lost, so the code goes on as it was approved.
 */

const CONSTRAINT = 'referral_codes_approval_status_check';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('referral_codes', 'approval_status', { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'approved' });
    await queryInterface.addColumn('referral_codes', 'approval_note', { type: DataTypes.TEXT, allowNull: true });
    await queryInterface.addColumn('referral_codes', 'changes_rejected', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('referral_codes', 'pending_changes', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('referral_codes', 'reviewed_by_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('referral_codes', 'reviewed_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addConstraint('referral_codes', {
      type: 'check',
      name: CONSTRAINT,
      fields: ['approval_status'],
      where: { approval_status: ['pending', 'approved', 'rejected'] },
    });
  },
  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query(`ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
    for (const column of ['reviewed_at', 'reviewed_by_user_id', 'pending_changes', 'changes_rejected', 'approval_note', 'approval_status']) {
      await queryInterface.removeColumn('referral_codes', column);
    }
  },
};
