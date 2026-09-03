'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('credit_notes', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      invoice_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'invoices', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      refund_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'refunds', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      credit_note_number: {
        type: DataTypes.STRING(40),
        allowNull: false,
      },
      amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      reason: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      issued_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('credit_notes', ["workspace_id","credit_note_number"], { unique: true, name: 'credit_notes_workspace_id_credit_note_number_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('credit_notes');
  },
};
