import {
  CORPORATE_ACCOUNT_STATUS,
  CORPORATE_VERIFICATION_STATUS,
} from '../../../shared/constants/corporate.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { ForbiddenError } from '../../../shared/errors/index.js';
import { registerAccountGate } from '../../identity/services/account-gate.js';
import * as corporateRepository from '../repositories/corporate.repository.js';

/**
 * The corporate login gate (BR-203, BR-209).
 *
 * Registered into identity's gate port rather than called from identity, so
 * the dependency runs Corporate -> Identity and there is no cycle. Identity
 * enforces the answer without knowing what a corporate account is
 * (docs/06 §2).
 *
 * Runs on login AND on refresh, so a company suspended mid-session loses
 * access at the next refresh rather than at token expiry (BR-125).
 *
 * WHY THE REASONS ARE DISTINCT
 * ----------------------------
 * "Under review", "rejected" and "suspended" need three different screens and
 * three different support answers. A single generic failure is indistinguishable
 * from a broken login and generates avoidable tickets (docs/10 §4.4).
 */

/**
 * The decision itself - a PURE function of the caller's memberships.
 *
 * Separated from the query so the rule can be tested exhaustively across every
 * combination of the three axes without a database or module mocking. The gate
 * below is then trivial glue, and the part that is easy to get wrong is the
 * part that is easy to test.
 *
 * A user with NO corporate membership is unaffected: this rule only has an
 * opinion about people who belong to a company.
 *
 * A user who belongs to at least one APPROVED + ACTIVE company passes, even if
 * another of their memberships does not - the usable one is what they are
 * signing in to use.
 *
 * @param {Array<{corporateAccount: {verificationStatus: string, accountStatus: string}}>} memberships
 * @returns {{code: string, message: string}|null}
 */
const blockingReason = (memberships) => {
  if (memberships.length === 0) return null;

  const usable = memberships.find(
    (membership) =>
      membership.corporateAccount.verificationStatus === CORPORATE_VERIFICATION_STATUS.APPROVED &&
      membership.corporateAccount.accountStatus === CORPORATE_ACCOUNT_STATUS.ACTIVE
  );

  if (usable) return null;

  // Report the most actionable membership rather than an arbitrary one: a
  // pending review resolves itself, a rejection does not.
  const byPriority = [
    CORPORATE_VERIFICATION_STATUS.PENDING,
    CORPORATE_VERIFICATION_STATUS.APPROVED,
    CORPORATE_VERIFICATION_STATUS.REJECTED,
  ];

  const [worst] = [...memberships].sort(
    (a, b) =>
      byPriority.indexOf(a.corporateAccount.verificationStatus) -
      byPriority.indexOf(b.corporateAccount.verificationStatus)
  );

  const account = worst.corporateAccount;

  if (account.verificationStatus === CORPORATE_VERIFICATION_STATUS.PENDING) {
    return {
      code: ERROR_CODES.CORPORATE_VERIFICATION_PENDING,
      message: 'Your company registration is still under review',
    };
  }

  if (account.verificationStatus === CORPORATE_VERIFICATION_STATUS.REJECTED) {
    return {
      code: ERROR_CODES.CORPORATE_VERIFICATION_REJECTED,
      message: 'Your company registration was not approved',
    };
  }

  // Approved, so the block is operational: the second axis (BR-213).
  if (account.accountStatus === CORPORATE_ACCOUNT_STATUS.SUSPENDED) {
    return {
      code: ERROR_CODES.CORPORATE_ACCOUNT_SUSPENDED,
      message: 'Your company account is suspended. Please contact support.',
    };
  }

  return {
    code: ERROR_CODES.CORPORATE_ACCOUNT_INACTIVE,
    message: 'Your company account is inactive',
  };
};

/**
 * May they SIGN IN?
 *
 * Everything blocks except a REJECTION, which the applicant is expected to fix
 * themselves (BR-206: a rejected company may re-apply). Locking them out was a
 * dead end — the reason they were rejected is usually a typo in their own
 * details, and the only way to correct it was a phone call.
 *
 * Signing in is NOT permission to buy. A rejected company still cannot place an
 * order; see `decideCorporateOrdering`, which the order path enforces.
 */
export const decideCorporateAccess = (memberships) => {
  const reason = blockingReason(memberships);
  if (reason?.code === ERROR_CODES.CORPORATE_VERIFICATION_REJECTED) return null;
  return reason;
};

/**
 * May they ORDER?
 *
 * Only an APPROVED + ACTIVE company. This is the rule verification exists for,
 * and until now NOTHING enforced it: the login gate was the sole obstacle, so
 * anyone who could sign in could buy. That was safe only while every
 * unapproved member was locked out, and it stopped being safe the moment
 * rejected applicants were let in to fix their details.
 */
export const decideCorporateOrdering = (memberships) => blockingReason(memberships);

/**
 * The gate Identity calls: fetch, then decide.
 *
 * Errors are NOT caught here. An unavailable database must fail the login
 * closed - treating "could not check" as "allowed" would turn a blip into an
 * authorisation bypass.
 */
export const corporateLoginGate = async (user) =>
  decideCorporateAccess(await corporateRepository.findActiveMembershipsForUser(user.id));

/**
 * The same question at ORDER time, for a user id.
 *
 * Errors are not caught, for the same reason: "could not check" must not read
 * as "allowed to buy".
 */
export const assertMayOrder = async (userId) => {
  const reason = decideCorporateOrdering(
    await corporateRepository.findActiveMembershipsForUser(userId)
  );

  if (reason) {
    throw new ForbiddenError(reason.message, { code: reason.code });
  }
};

/**
 * Install the gate.
 *
 * Called once from the v1 router - the composition root - because that is the
 * only place that legitimately knows both modules exist. Importing this file
 * for its side effect alone would be an invisible dependency.
 */
export const installCorporateLoginGate = () => {
  registerAccountGate('corporate', corporateLoginGate);
};
