import 'dotenv/config';

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '#prisma';

import { hashPassword } from '../src/modules/identity/services/password.service.js';
import { PRINCIPALS, ROLES } from '../src/shared/constants/rbac.js';

/**
 * Seed the super administrator.
 *
 * WHY THIS EXISTS ALONGSIDE `create:admin`:
 *
 *   `create:admin` is an operator action - run once, on a terminal, for a
 *   person. This is a DEPLOYMENT action: it is safe to run on every deploy of
 *   an environment that must always have exactly one known super administrator
 *   (staging, a demo box, a fresh CI database).
 *
 * IDEMPOTENT. Re-running it does not create a second account, does not fail,
 * and does not silently rotate a password that other people are already using.
 * Existing account -> the role grant is re-asserted and nothing else changes,
 * unless `--reset-password` is passed explicitly.
 *
 * WHAT IT DELIBERATELY WILL NOT DO:
 *
 *   There is no baked-in default password, and there never should be. The
 *   identity seed refuses to create users for exactly this reason (see
 *   prisma/seed.js): a default credential committed to a repository is how
 *   staging logins end up working in production. The password must be supplied,
 *   or it is generated randomly and printed once.
 *
 * Usage:
 *   npm run seed:superadmin -- --email admin@example.com
 *   npm run seed:superadmin -- --email admin@example.com --password 'S3cret!'
 *   npm run seed:superadmin -- --email admin@example.com --reset-password
 *
 * Or entirely from the environment, which is the point on a deploy:
 *   SUPERADMIN_EMAIL=admin@example.com SUPERADMIN_PASSWORD=... npm run seed:superadmin
 */

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    phone: { type: 'string' },
    password: { type: 'string' },
    'reset-password': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const email = (values.email ?? process.env.SUPERADMIN_EMAIL ?? '').trim().toLowerCase();
const phone = (values.phone ?? process.env.SUPERADMIN_PHONE ?? '').trim() || null;
const suppliedPassword = values.password ?? process.env.SUPERADMIN_PASSWORD ?? null;

if (!email) {
  console.error('An email is required: --email admin@example.com (or SUPERADMIN_EMAIL).');
  console.error('Email rather than phone because it is the admin panel login identifier.');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

try {
  const role = await prisma.role.findUnique({
    where: { code: ROLES.SUPER_ADMIN },
    select: { id: true },
  });

  if (!role) {
    console.error(`Role ${ROLES.SUPER_ADMIN} not found. Run "npm run prisma:seed" first.`);
    process.exit(1);
  }

  /**
   * Looked up by the (email, principal) compound unique, not by email alone.
   * Uniqueness is scoped per principal (BR-104) - the same address may exist as
   * a customer - so an unscoped lookup could find the wrong human entirely.
   */
  const existing = await prisma.user.findUnique({
    where: { email_principal: { email, principal: PRINCIPALS.ADMIN } },
    select: { id: true, phone: true },
  });

  let password = null;
  let generated = false;

  if (!existing) {
    // 24 random bytes, base64url: ~192 bits, matching scripts/create-admin.js.
    password = suppliedPassword ?? randomBytes(24).toString('base64url');
    generated = !suppliedPassword;
  } else if (values['reset-password']) {
    password = suppliedPassword ?? randomBytes(24).toString('base64url');
    generated = !suppliedPassword;
  }

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          // Only ever widens: a phone supplied now is added, but an existing one
          // is never cleared by a deploy that happened not to pass --phone.
          ...(phone ? { phone, phoneVerifiedAt: new Date() } : {}),
          ...(password ? { passwordHash: await hashPassword(password) } : {}),
        },
        select: { id: true, email: true, phone: true },
      })
    : await prisma.user.create({
        data: {
          principal: PRINCIPALS.ADMIN,
          email,
          phone,
          passwordHash: await hashPassword(password),
          // Created out-of-band by a trusted operator, so the identifiers are
          // treated as verified: no self-service flow could verify them.
          emailVerifiedAt: new Date(),
          phoneVerifiedAt: phone ? new Date() : null,
        },
        select: { id: true, email: true, phone: true },
      });

  /**
   * The grant is re-asserted rather than assumed. An account that exists but
   * lost its role - a botched migration, a manual DELETE - is worse than no
   * account at all, because it looks fine until someone tries to use it.
   */
  const grant = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: role.id },
    select: { userId: true },
  });

  if (!grant) {
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  console.log(existing ? '\nSuper administrator already present.\n' : '\nSuper administrator created.\n');
  console.log(`  id:    ${user.id}`);
  console.log(`  email: ${user.email ?? '-'}`);
  console.log(`  phone: ${user.phone ?? '-'}`);
  console.log(`  role:  ${ROLES.SUPER_ADMIN}${grant ? '' : ' (granted)'}`);

  if (generated) {
    console.log(`\n  password: ${password}`);
    console.log('\n  Shown once. Store it in a password manager now.');
  } else if (password) {
    console.log('\n  Password set from the value supplied.');
  } else {
    console.log('\n  Password unchanged. Pass --reset-password to rotate it.');
  }

  console.log('\nLog in with:');
  console.log(
    `  POST /api/v1/auth/login  { "principal": "ADMIN", "email": "${user.email}", "password": "..." }\n`
  );
} catch (error) {
  console.error('Seeding the super administrator failed:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
