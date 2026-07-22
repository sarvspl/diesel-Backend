import { createLogger } from '../../../shared/logger/index.js';

const log = createLogger({ module: 'identity.gate' });

/**
 * Login gate registry - a dependency-inversion port.
 *
 * WHY THIS EXISTS
 * ---------------
 * BR-203 and BR-209 are blocking rules: a corporate account that is not
 * APPROVED and ACTIVE must not be able to log in. Something has to enforce
 * that on the authentication path.
 *
 * But docs/06 §2 is explicit that Identity "enforces the login gate but does
 * not decide who passes it - it asks Corporate; Corporate answers", and the
 * dependency graph runs Corporate -> Identity. Identity importing Corporate
 * would be a cycle, which the lint rule rejects and which would make Identity
 * un-extractable.
 *
 * So Identity owns the INTERFACE and other modules supply implementations.
 * Identity never learns what a corporate account is; it only knows that some
 * gate said no, and why.
 *
 * A gate returns:
 *   null | undefined            -> allowed
 *   { code, message }           -> denied, surfaced verbatim to the client
 *
 * Denial reasons are deliberately DISTINCT rather than a generic failure
 * (docs/10 §4.4): "your company is still under review" and "your company was
 * rejected" need different screens, and collapsing them generates support
 * calls that look like bugs.
 *
 * Gates run on login AND on refresh, so a company suspended mid-session loses
 * access at the next refresh rather than whenever its token happens to lapse
 * (BR-125).
 */

/** @type {Map<string, (user: object) => Promise<{code: string, message: string}|null>>} */
const gates = new Map();

/**
 * Register a gate. Idempotent by name, so a module imported twice does not
 * install two copies of the same check.
 *
 * @param {string} name  For diagnostics, e.g. 'corporate'.
 * @param {(user: object) => Promise<{code: string, message: string}|null>} check
 */
export const registerAccountGate = (name, check) => {
  if (gates.has(name)) return;

  gates.set(name, check);
  log.debug({ gate: name }, 'account gate registered');
};

/**
 * Run every registered gate. Returns the first denial, or null.
 *
 * Sequential rather than parallel: gates hit the database, most logins trip
 * none of them, and the common case is cheapest when the first gate that says
 * no ends the work.
 *
 * A gate that THROWS is not swallowed. An unavailable gate must fail the login
 * closed - treating "could not check" as "allowed" would turn a database blip
 * into an authorisation bypass.
 *
 * @param {object} user
 * @returns {Promise<{code: string, message: string}|null>}
 */
export const evaluateAccountGates = async (user) => {
  for (const [name, check] of gates) {
    const denial = await check(user);

    if (denial) {
      log.info({ gate: name, userId: user.id, code: denial.code }, 'login denied by gate');
      return denial;
    }
  }

  return null;
};

/** Test seam only. Never called by application code. */
export const __resetAccountGates = () => gates.clear();
