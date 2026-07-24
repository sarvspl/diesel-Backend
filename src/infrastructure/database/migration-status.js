import { readdir } from 'node:fs/promises';

import { prisma } from './prisma.js';

/**
 * Migrations that exist in the repository but have not been applied to the
 * database this instance is pointed at.
 *
 * WHY THIS IS CHECKED AT BOOT
 * ---------------------------
 * A schema that is behind the code does not fail visibly. Reads keep working,
 * the health check stays green, and the instance sits in the load balancer
 * looking healthy — until the first write touches a column that does not exist
 * and returns a 500 to a real user. That is the worst possible moment to find
 * out, and the error the user sees says nothing about migrations.
 *
 * Deliberately NOT the Prisma CLI: `prisma migrate status` is a dev dependency
 * and spawning it from a running server is both slow and unavailable in a
 * production image. Comparing the migrations directory against the
 * `_prisma_migrations` table is exactly what the CLI does, and needs nothing
 * that is not already here.
 *
 * @returns {Promise<{pending: string[], checked: boolean}>} `checked` is false
 *   when the question could not be answered — a database with no migration
 *   table at all, for instance — which must not be reported as "nothing
 *   pending".
 */
export const findPendingMigrations = async () => {
  let onDisk;

  try {
    const entries = await readdir(new URL('../../../prisma/migrations/', import.meta.url), {
      withFileTypes: true,
    });
    onDisk = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // No migrations directory — a deployment artefact that ships only compiled
    // source, say. Nothing can be concluded.
    return { pending: [], checked: false };
  }

  if (onDisk.length === 0) return { pending: [], checked: false };

  let applied;
  try {
    applied = await prisma.$queryRaw`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;
  } catch {
    // The table is absent or unreadable. Say so rather than claiming the schema
    // is current.
    return { pending: [], checked: false };
  }

  const appliedNames = new Set(applied.map((row) => row.migration_name));

  return {
    pending: onDisk.filter((name) => !appliedNames.has(name)).sort(),
    checked: true,
  };
};
