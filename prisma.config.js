/**
 * Prisma CLI configuration (Prisma 7+).
 *
 * From Prisma 7 the datasource connection string lives here rather than in
 * `schema.prisma`, and the CLI does not read `.env` automatically — hence the
 * explicit `dotenv/config` import below.
 *
 * This file is consumed by the Prisma CLI only (generate / migrate / studio).
 * The running application never imports it; it builds its client from the
 * Zod-validated config in `src/config/env.js`.
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
