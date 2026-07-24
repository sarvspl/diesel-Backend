import { z } from 'zod';

import { USER_STATUS } from '../../shared/constants/identity.js';

/** Request validation for the administrative customer routes. */

export const listCustomersSchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    /**
     * Free-text across name, phone and email. Bounded because it reaches a
     * `contains` predicate - an unbounded term is a cheap way to make the
     * database scan.
     */
    search: z.string().trim().min(1).max(120).optional(),
    status: z.enum(Object.values(USER_STATUS)).optional(),
    /**
     * Retail buyer or company member. Derived from an ACTIVE corporate
     * membership, never from a flag on the profile — the membership is what
     * actually governs ordering and the login gate, so anything else could
     * disagree with it.
     */
    accountType: z.enum(['INDIVIDUAL', 'CORPORATE']).optional(),
  }),
};

export const customerIdSchema = {
  params: z.object({ id: z.string().uuid('Customer id must be a UUID') }),
};
