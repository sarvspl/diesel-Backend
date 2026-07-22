import 'dotenv/config';

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '#prisma';

import { hashPassword } from '../src/modules/identity/services/password.service.js';
import { PRINCIPALS, ROLES } from '../src/shared/constants/rbac.js';

/**
 * Create the first administrator.
 *
 * This exists because the seed deliberately creates no users, and this phase
 * has no admin-creation endpoint - administrators are created by other
 * administrators (docs/03 §1), which leaves a bootstrap gap. This closes it,
 * on the operator's terminal rather than in committed data.
 *
 * The password is generated unless supplied, and printed ONCE. It is never
 * logged through pino and never stored anywhere but as an Argon2id hash.
 *
 * Usage:
 *   npm run create:admin -- --email admin@example.com --phone +919876543210
 *   npm run create:admin -- --email admin@example.com --role SUPER_ADMIN
 */

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    phone: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string', default: ROLES.SUPER_ADMIN },
  },
  allowPositionals: true,
});

if (!values.email && !values.phone) {
  console.error('Provide at least --email or --phone.');
  console.error('  npm run create:admin -- --email admin@example.com --phone +919876543210');
  process.exit(1);
}

if (values.role !== ROLES.ADMIN && values.role !== ROLES.SUPER_ADMIN) {
  console.error(`--role must be ${ROLES.ADMIN} or ${ROLES.SUPER_ADMIN}`);
  process.exit(1);
}

/** 24 random bytes, base64url: ~192 bits. Comfortably beyond guessing. */
const password = values.password ?? randomBytes(24).toString('base64url');
const generated = !values.password;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

try {
  const role = await prisma.role.findUnique({ where: { code: values.role }, select: { id: true } });

  if (!role) {
    console.error(`Role ${values.role} not found. Run "npm run prisma:seed" first.`);
    process.exit(1);
  }

  const user = await prisma.user.create({
    data: {
      principal: PRINCIPALS.ADMIN,
      email: values.email ?? null,
      phone: values.phone ?? null,
      passwordHash: await hashPassword(password),
      // Created out-of-band by a trusted operator, so treat the identifiers as
      // verified: there is no self-service flow that could verify them.
      emailVerifiedAt: values.email ? new Date() : null,
      phoneVerifiedAt: values.phone ? new Date() : null,
      roles: { create: { roleId: role.id } },
    },
    select: { id: true, email: true, phone: true },
  });

  console.log('\nAdministrator created.\n');
  console.log(`  id:    ${user.id}`);
  console.log(`  email: ${user.email ?? '-'}`);
  console.log(`  phone: ${user.phone ?? '-'}`);
  console.log(`  role:  ${values.role}`);

  if (generated) {
    console.log(`\n  password: ${password}`);
    console.log('\n  Shown once. Store it in a password manager now.');
  }

  console.log('\nLog in with:');
  console.log(
    `  POST /api/v1/auth/login  { "principal": "ADMIN", "email": "...", "password": "..." }\n`
  );
} catch (error) {
  if (error?.code === 'P2002') {
    console.error('An administrator with that email or phone already exists.');
  } else {
    console.error('Failed to create administrator:', error?.message ?? error);
  }
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
