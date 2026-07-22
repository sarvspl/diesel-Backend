import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '#prisma';

import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from '../src/shared/constants/rbac.js';

/**
 * Seed the RBAC catalogue.
 *
 * IDEMPOTENT: safe to run repeatedly. Uses upserts throughout, so re-seeding
 * after adding a permission adds only the new rows and re-syncs role grants.
 * A seed that can only run once is a seed nobody dares run.
 *
 * Deliberately seeds NO users. Creating a default administrator with a known
 * password is how staging credentials end up in production. The first
 * administrator is created explicitly - see `createFirstAdmin` below.
 *
 * Run with:  npm run prisma:seed
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const seedPermissions = async () => {
  for (const [code, resource, action, description] of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: { resource, action, description },
      create: { code, resource, action, description },
    });
  }

  return PERMISSION_DEFINITIONS.length;
};

const seedRoles = async () => {
  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { code: definition.code },
      update: { name: definition.name, description: definition.description, isSystem: true },
      create: {
        code: definition.code,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
      select: { id: true },
    });

    const permissions = await prisma.permission.findMany({
      where: { code: { in: definition.permissions } },
      select: { id: true },
    });

    // Replace rather than merge: the constants file is the source of truth, so
    // removing a permission there must actually revoke it. A merge-only seed
    // silently accumulates grants that nobody intended to keep.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
      skipDuplicates: true,
    });
  }

  return ROLE_DEFINITIONS.length;
};

const main = async () => {
  console.log('Seeding identity data...');

  const permissionCount = await seedPermissions();
  console.log(`  permissions: ${permissionCount}`);

  const roleCount = await seedRoles();
  console.log(`  roles:       ${roleCount}`);

  for (const definition of ROLE_DEFINITIONS) {
    console.log(`    ${definition.code.padEnd(12)} ${definition.permissions.length} permissions`);
  }

  console.log('\nNo users were created. To create the first administrator:');
  console.log('  npm run create:admin -- --email admin@example.com --phone +919876543210');
};

try {
  await main();
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
