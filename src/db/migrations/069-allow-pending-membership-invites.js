'use strict';

/**
 * Let a workspace invite an email address that has no user account yet: the
 * Membership row is created with status 'invited' and user_id NULL, and gets
 * linked to a real user when they accept. The (workspace_id, user_id) unique
 * index becomes partial so multiple pending invites (all NULL user_id) don't
 * collide, and a matching partial unique index on (workspace_id, invited_email)
 * stops the same address being invited twice.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "memberships" ALTER COLUMN "user_id" DROP NOT NULL;`
    );
    await queryInterface.removeIndex('memberships', 'memberships_workspace_id_user_id_idx');
    await queryInterface.addIndex('memberships', ['workspace_id', 'user_id'], {
      unique: true,
      name: 'memberships_workspace_id_user_id_idx',
      where: { user_id: { [require('sequelize').Op.ne]: null } },
    });
    await queryInterface.addIndex('memberships', ['workspace_id', 'invited_email'], {
      unique: true,
      name: 'memberships_workspace_id_invited_email_idx',
      where: { invited_email: { [require('sequelize').Op.ne]: null } },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('memberships', 'memberships_workspace_id_invited_email_idx');
    await queryInterface.removeIndex('memberships', 'memberships_workspace_id_user_id_idx');
    await queryInterface.sequelize.query(
      `DELETE FROM "memberships" WHERE "user_id" IS NULL;`
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "memberships" ALTER COLUMN "user_id" SET NOT NULL;`
    );
    await queryInterface.addIndex('memberships', ['workspace_id', 'user_id'], {
      unique: true,
      name: 'memberships_workspace_id_user_id_idx',
    });
  },
};
