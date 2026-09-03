'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { v4: uuidv4 } = require('uuid');
    const bcrypt = require('bcryptjs');
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const userId = uuidv4();
    const workspaceId = uuidv4();
    const ownerRoleId = uuidv4();
    const managerRoleId = uuidv4();
    const editorRoleId = uuidv4();
    const orderOpRoleId = uuidv4();
    const confirmRoleId = uuidv4();
    const accountantRoleId = uuidv4();
    const productId = uuidv4();
    const variantId = uuidv4();
    const planStarterId = uuidv4();
    const planGrowthId = uuidv4();
    const subscriptionId = uuidv4();
    const templateId = uuidv4();
    const templateVersionId = uuidv4();

    const passwordHash = await bcrypt.hash('DemoPassw0rd!123', 12);

    await queryInterface.bulkInsert('users', [
      {
        id: userId,
        email: 'demo@storebuilder.test',
        password_hash: passwordHash,
        full_name: 'Demo Owner',
        status: 'active',
        email_verified_at: now,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('workspaces', [
      {
        id: workspaceId,
        name: 'Demo Store',
        slug: 'demo-store',
        owner_user_id: userId,
        status: 'active',
        default_currency: 'EGP',
        default_locale: 'ar-EG',
        timezone: 'Africa/Cairo',
        settings: '{}',
        created_at: now,
        updated_at: now,
      },
    ]);

    const roleDefs = [
      [ownerRoleId, 'owner', 'Owner', true, '{"*"}'],
      [managerRoleId, 'workspace_manager', 'Workspace Manager', true, '{}'],
      [editorRoleId, 'editor', 'Editor', true, '{}'],
      [orderOpRoleId, 'order_operator', 'Order Operator', true, '{}'],
      [confirmRoleId, 'confirmation_agent', 'Confirmation Agent', true, '{}'],
      [accountantRoleId, 'accountant', 'Accountant', true, '{}'],
    ];
    await queryInterface.bulkInsert(
      'roles',
      roleDefs.map(([id, key, name, isSystem, perms]) => ({
        id,
        workspace_id: workspaceId,
        key,
        name,
        is_system: isSystem,
        permissions: perms,
        created_at: now,
        updated_at: now,
      }))
    );

    await queryInterface.bulkInsert('memberships', [
      {
        id: uuidv4(),
        workspace_id: workspaceId,
        user_id: userId,
        role_id: ownerRoleId,
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('invoice_counters', [
      { workspace_id: workspaceId, last_number: 0, prefix: 'INV' },
    ]);

    await queryInterface.bulkInsert('products', [
      {
        id: productId,
        workspace_id: workspaceId,
        name: 'Demo T-Shirt',
        slug: 'demo-t-shirt',
        description: 'A sample product seeded for local development.',
        product_type: 'physical',
        status: 'active',
        options: '[]',
        media: '[]',
        tags: '{}',
        seo: '{}',
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('product_variants', [
      {
        id: variantId,
        workspace_id: workspaceId,
        product_id: productId,
        sku: 'DEMO-TSHIRT-M',
        option_values: '{"Size":"M"}',
        price_amount: 25000,
        currency: 'EGP',
        stock_on_hand: 50,
        reserved_stock: 0,
        allow_overselling: false,
        status: 'active',
        version: 0,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('plans', [
      {
        id: planStarterId,
        key: 'starter',
        name: 'Starter',
        monthly_price_amount: 29900,
        yearly_price_amount: 299900,
        currency: 'USD',
        trial_days: 14,
        soft_order_quota: 200,
        features: '{}',
        is_active: true,
        created_at: now,
        updated_at: now,
      },
      {
        id: planGrowthId,
        key: 'growth',
        name: 'Growth',
        monthly_price_amount: 79900,
        yearly_price_amount: 799900,
        currency: 'USD',
        trial_days: 14,
        soft_order_quota: 2000,
        features: '{}',
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    ]);

    // Match what workspaceService.createWorkspace does: a trialing subscription
    // on the cheapest plan, 14-day trial.
    await queryInterface.bulkInsert('subscriptions', [
      {
        id: subscriptionId,
        workspace_id: workspaceId,
        plan_id: planStarterId,
        billing_cycle: 'monthly',
        status: 'trialing',
        trial_ends_at: trialEnd,
        current_period_start: now,
        current_period_end: trialEnd,
        cancel_at_period_end: false,
        external_subscription_id: null,
        external_provider: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('templates', [
      {
        id: templateId,
        name: 'Minimal Store',
        category: 'ecommerce',
        is_published: true,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('template_versions', [
      {
        id: templateVersionId,
        template_id: templateId,
        version: 1,
        global_styles: '{"primaryColor":"#111827","font":"Inter"}',
        pages: JSON.stringify([{ path: '/', title: 'Home', builderData: { sections: [] } }]),
        sections: '[]',
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    ]);
  },

  down: async (queryInterface) => {
    await queryInterface.bulkDelete('template_versions', null, {});
    await queryInterface.bulkDelete('templates', null, {});
    await queryInterface.bulkDelete('subscriptions', null, {});
    await queryInterface.bulkDelete('plans', null, {});
    await queryInterface.bulkDelete('product_variants', null, {});
    await queryInterface.bulkDelete('products', null, {});
    await queryInterface.bulkDelete('invoice_counters', null, {});
    await queryInterface.bulkDelete('memberships', null, {});
    await queryInterface.bulkDelete('roles', null, {});
    await queryInterface.bulkDelete('workspaces', null, {});
    await queryInterface.bulkDelete('users', { email: 'demo@storebuilder.test' }, {});
  },
};
