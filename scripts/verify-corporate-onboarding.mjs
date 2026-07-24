/**
 * The complete corporate onboarding cycle:
 * sign up → register a company → BLOCKED → admin approves → signs in.
 *
 * The interesting property is not that each endpoint works, but that the LOGIN
 * GATE flips at exactly the right moments. A customer must be locked out the
 * instant their company is pending, and let in the instant it is approved —
 * and every refusal must name a reason the app can turn into its own screen.
 *
 *   node scripts/verify-corporate-onboarding.mjs
 *
 * Needs the server running and OTP_INSECURE_FIXED_CODE set.
 *
 * ---------------------------------------------------------------------------
 * SEND BUDGET — why this is split across four applicants
 * ---------------------------------------------------------------------------
 * Requesting a code is capped twice over, and both caps are per HOUR:
 *
 *   OTP_MAX_SENDS_PER_IDENTIFIER_PER_HOUR   default 3    per phone
 *   OTP_MAX_SENDS_PER_IP_PER_HOUR           default 20   per source address
 *
 * Walking one account through every state needs more than three codes, so the
 * fourth request is throttled and the rest of the run reports 429 where it
 * meant to report a gate decision. Each applicant below therefore spends AT
 * MOST THREE sends, and the states are split so the scenarios stay independent.
 *
 * The whole run costs 11 sends against the IP cap of 20, so it passes once an
 * hour from one machine. Re-running immediately exhausts the IP budget — that
 * is the limiter working, not a regression, and the harness says so explicitly.
 */
import { prisma } from '../src/infrastructure/database/prisma.js';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';
const CODE = process.env.OTP_INSECURE_FIXED_CODE ?? '123456';

let passed = 0;
let failed = 0;
const failures = [];

const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  [32mPASS[0m ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}: ${detail}`);
    console.log(`  [31mFAIL[0m ${label}\n       ${detail}`);
  }
};

const equal = (label, actual, expected) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const section = (title) => console.log(`\n[1m${title}[0m`);

async function call(method, path, { body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, data: payload?.data, code: payload?.error?.code };
}

/** Set once the IP send budget is gone: every later result is meaningless. */
let budgetExhausted = false;

/**
 * The app's own sign-in: request a code, then verify it. Costs ONE send.
 *
 * A throttled request issues no code, so verifying afterwards would fail with
 * OTP_INVALID and read as a broken gate. Return the throttle instead.
 */
async function signIn(phone, purpose = 'LOGIN') {
  const requested = await call('POST', '/auth/otp/request', {
    body: { phone, principal: 'CUSTOMER', purpose },
  });

  if (requested.status === 429) {
    budgetExhausted = true;
    return { status: 429, code: requested.code ?? 'OTP_RATE_LIMITED', throttled: true };
  }

  return call('POST', '/auth/otp/verify', {
    body: { phone, principal: 'CUSTOMER', purpose, code: CODE },
  });
}

// An Indian mobile is TEN digits after +91. The leading 9 is part of those ten,
// so only nine more follow it — a short seed silently produces a number the
// validator rejects, and every assertion below then reads as broken.
let phoneSeed = Number(String(Date.now()).slice(-9));
const nextPhone = () => `+919${String(phoneSeed++).padStart(9, '0').slice(-9)}`;

// `@@unique([registrationIdType, registrationNumber])` — one company per
// identifier, forever. A counter starting from a constant collides with the
// PREVIOUS run's companies and every registration comes back 409, so this is
// seeded from the clock like the phones above.
let registrationSeed = Number(String(Date.now()).slice(-6));
const nextRegistrationNumber = () =>
  `27AAPCA${String(registrationSeed++).padStart(6, '0').slice(-6)}A1Z5`;

async function main() {
  console.log(`Verifying corporate onboarding against ${BASE}\n`);

  // --- An admin who can verify companies ------------------------------------
  const userRepository = await import('../src/modules/identity/repositories/user.repository.js');
  const { signAccessToken } = await import('../src/modules/identity/services/token.service.js');

  let adminToken = null;
  for (const candidate of await prisma.user.findMany({
    where: { principal: 'ADMIN' },
    select: { id: true },
  })) {
    const loaded = await userRepository.findByIdWithRoles(candidate.id);
    const flat = userRepository.flattenAuthorisation(loaded);
    if (flat.permissions.includes('corporate.verify')) {
      adminToken = signAccessToken({
        userId: loaded.id,
        principal: 'ADMIN',
        sessionId: 'verify-corporate',
        roles: flat.roles,
        permissions: flat.permissions,
      });
      break;
    }
  }

  if (!adminToken) {
    console.log('No ADMIN holds corporate.verify. Run `npm run seed:superadmin`.');
    process.exitCode = 1;
    return;
  }

  const admin = (path, body) => call('POST', path, { token: adminToken, body });

  /** Sign up a fresh customer. Costs ONE send. */
  const signUpCustomer = async (phone, fullName) => {
    const signup = await signIn(phone, 'SIGNUP');
    const token = signup.data?.tokens?.accessToken;
    if (token) await call('POST', '/customers/register', { token, body: { fullName } });
    return { status: signup.status, token };
  };

  /** Register a company for an already-signed-up customer. Costs no sends. */
  const registerCompany = (token, legalName, extra = {}) =>
    call('POST', '/corporates/register', {
      token,
      body: {
        legalName,
        registrationIdType: 'GSTIN',
        registrationNumber: nextRegistrationNumber(),
        ...extra,
      },
    });

  // ==========================================================================
  // A — the path the customer app walks. THREE sends.
  // ==========================================================================
  section('A. APPLY → BLOCKED → APPROVED → IN');

  const phoneA = nextPhone();
  const a = await signUpCustomer(phoneA, 'Corporate Applicant'); // send 1
  equal('a new customer signs up', a.status, 200);
  check('and gets a token', Boolean(a.token), 'no access token issued');

  const noCompany = await call('GET', '/corporates/me', { token: a.token });
  equal('before registering, they have no company', noCompany.status, 404);

  // Everything the app can supply, so section F can prove each field survives
  // into the projection the admin panel reads.
  const FULL = {
    gstin: '27AAPCA1234A1Z5',
    pan: 'AAPCA1234A',
    contactEmail: 'accounts@sarvottam.in',
    contactPhone: phoneA,
    billingLine1: 'Unit 4, Sarvottam Industrial Estate',
    billingCity: 'Mumbai',
    billingState: 'Maharashtra',
    billingPincode: '400001',
  };

  const registered = await registerCompany(a.token, 'Sarvottam Logistics Pvt Ltd', FULL);
  equal('POST /corporates/register returns 201', registered.status, 201);

  const accountA = registered.data?.account;
  equal('the company starts PENDING review', accountA?.verificationStatus, 'PENDING');
  equal('and INACTIVE for ordering', accountA?.accountStatus, 'INACTIVE');
  check(
    'the company id round-trips as typed',
    accountA?.registration?.idType === 'GSTIN' && Boolean(accountA?.registration?.number),
    JSON.stringify(accountA?.registration)
  );

  const duplicate = await registerCompany(a.token, 'Another Co');
  equal('one customer cannot register a second company', duplicate.code, 'ALREADY_CORPORATE_MEMBER');

  const blocked = await signIn(phoneA); // send 2
  equal('sign-in is now REFUSED', blocked.status, 401);
  equal('with the code the app turns into "Under review"', blocked.code, 'CORPORATE_VERIFICATION_PENDING');

  const approved = await admin(`/admin/corporates/${accountA?.id}/approve`, {});
  equal('an admin approves', approved.status, 200);
  equal('the company becomes APPROVED', approved.data?.account?.verificationStatus, 'APPROVED');
  equal('and ACTIVE', approved.data?.account?.accountStatus, 'ACTIVE');

  const allowed = await signIn(phoneA); // send 3
  equal('THE SAME CUSTOMER CAN NOW SIGN IN', allowed.status, 200);

  const mine = await call('GET', '/corporates/me', { token: allowed.data?.tokens?.accessToken });
  equal('their company is readable', mine.status, 200);
  equal('and reads as approved', mine.data?.account?.verificationStatus, 'APPROVED');

  // ==========================================================================
  // B — the gate must touch corporate customers ONLY. Two sends.
  // ==========================================================================
  section('B. AN INDIVIDUAL IS NEVER GATED');

  const phoneB = nextPhone();
  const b = await signUpCustomer(phoneB, 'Ordinary Customer'); // send 1
  equal('an individual signs up', b.status, 200);

  const individualAgain = await signIn(phoneB); // send 2
  equal('and signs in again with no extra checks', individualAgain.status, 200);

  // ==========================================================================
  // C — rejection is a different screen, with a reason to show. Two sends.
  // ==========================================================================
  section('C. REJECTED IS A DIFFERENT SCREEN');

  const phoneC = nextPhone();
  const c = await signUpCustomer(phoneC, 'Rejected Applicant'); // send 1
  const companyC = (await registerCompany(c.token, 'Dubious Traders LLP')).data?.account;
  check('a company is registered', Boolean(companyC?.id), 'registration failed');

  const APPLICANT_NOTE = 'The GSTIN does not match the legal name.';
  const rejected = await admin(`/admin/corporates/${companyC?.id}/reject`, {
    reasonCode: 'DOCUMENTS_INVALID',
    applicantNote: APPLICANT_NOTE,
    adminNote: 'Internal: flagged by compliance.',
  });
  equal('an admin rejects', rejected.status, 200);
  equal('the company reads REJECTED', rejected.data?.account?.verificationStatus, 'REJECTED');

  const afterReject = await signIn(phoneC); // send 2
  equal('sign-in is refused', afterReject.status, 401);
  equal('with a DIFFERENT code to pending', afterReject.code, 'CORPORATE_VERIFICATION_REJECTED');

  // The app prints the reviewer's note on its rejection screen, so the note
  // written FOR THE APPLICANT has to survive into the record it reads.
  const detail = await call('GET', `/admin/corporates/${companyC?.id}`, { token: adminToken });
  const history =
    detail.data?.account?.verificationHistory ?? detail.data?.verificationHistory ?? [];
  const entry = history.find((h) => h.toStatus === 'REJECTED');
  check('the rejection is recorded in the audit history', Boolean(entry), JSON.stringify(history));
  equal('carrying the note written for the applicant', entry?.applicantNote, APPLICANT_NOTE);

  // ==========================================================================
  // D — suspension is operational, and reversible. Three sends.
  // ==========================================================================
  section('D. SUSPENSION CLOSES THE GATE AGAIN');

  const phoneD = nextPhone();
  const d = await signUpCustomer(phoneD, 'Suspended Applicant'); // send 1
  const companyD = (await registerCompany(d.token, 'Overdue Haulage Pvt Ltd')).data?.account;
  check('a company is registered', Boolean(companyD?.id), 'registration failed');

  await admin(`/admin/corporates/${companyD?.id}/approve`, {});

  const suspended = await admin(`/admin/corporates/${companyD?.id}/suspend`, {
    reason: 'Payment overdue',
  });
  equal('an admin suspends an approved company', suspended.status, 200);
  equal('verification stays APPROVED', suspended.data?.account?.verificationStatus, 'APPROVED');
  equal('only the operational axis moves', suspended.data?.account?.accountStatus, 'SUSPENDED');

  const afterSuspend = await signIn(phoneD); // send 2
  equal('sign-in is refused', afterSuspend.status, 401);
  equal('with the operational reason, not the review one', afterSuspend.code, 'CORPORATE_ACCOUNT_SUSPENDED');

  const noReason = await admin(`/admin/corporates/${companyD?.id}/reactivate`, {});
  equal('reactivating without a reason is rejected (BR-215)', noReason.status, 400);

  const reactivated = await admin(`/admin/corporates/${companyD?.id}/reactivate`, {
    reason: 'Balance cleared',
  });
  equal('with a reason, an admin can reactivate', reactivated.status, 200);
  equal('and the company is ACTIVE again', reactivated.data?.account?.accountStatus, 'ACTIVE');

  const finalSignIn = await signIn(phoneD); // send 3
  equal('after which they sign in once more', finalSignIn.status, 200);

  // ==========================================================================
  // E — the send cap is load-bearing.
  //
  // While OTP_INSECURE_FIXED_CODE is set, knowing the code is free: the ONLY
  // thing between a known phone number and its account is this cap. Applicant A
  // has spent its three sends, so one more must be refused.
  // ==========================================================================
  section('E. THE SEND CAP IS LOAD-BEARING');

  const overBudget = await call('POST', '/auth/otp/request', {
    body: { phone: phoneA, principal: 'CUSTOMER', purpose: 'LOGIN' },
  });
  equal('a fourth code for one number is refused', overBudget.status, 429);
  equal('naming the send cap', overBudget.code, 'OTP_RATE_LIMITED');

  // ==========================================================================
  // F — the SHAPE the admin panel reads.
  //
  // The panel types this payload through an unchecked `api.get<T>()`
  // assertion, so a field that moves nests silently: TypeScript keeps
  // compiling, and the drawer renders a dash that is indistinguishable from a
  // company which supplied nothing. That is exactly how the registration
  // number, GSTIN, phone and billing address all showed as "—" for a company
  // that had provided every one of them. Only asserting the wire shape catches
  // it, so these are field-by-field on purpose.
  // ==========================================================================
  section('F. THE ADMIN PROJECTION KEEPS ITS SHAPE');

  const listed = await call('GET', '/admin/corporates?limit=50', { token: adminToken });
  equal('GET /admin/corporates returns 200', listed.status, 200);
  check(
    'the collection is under `corporates`',
    Array.isArray(listed.data?.corporates),
    `got keys ${JSON.stringify(Object.keys(listed.data ?? {}))}`
  );

  const row = (listed.data?.corporates ?? []).find((item) => item.id === accountA?.id);
  check('the company appears in the list', Boolean(row), 'not found in the first 50');

  equal('registration is NESTED, not flat', typeof row?.registration, 'object');
  equal('  registration.idType', row?.registration?.idType, 'GSTIN');
  equal('  registration.number', row?.registration?.number, accountA?.registration?.number);
  check(
    'there is no flat registrationNumber to read by mistake',
    row?.registrationNumber === undefined,
    `found registrationNumber=${JSON.stringify(row?.registrationNumber)}`
  );

  equal('billingAddress is NESTED, not flat', typeof row?.billingAddress, 'object');
  equal('  billingAddress.line1', row?.billingAddress?.line1, FULL.billingLine1);
  equal('  billingAddress.city', row?.billingAddress?.city, FULL.billingCity);
  equal('  billingAddress.state', row?.billingAddress?.state, FULL.billingState);
  equal('  billingAddress.pincode', row?.billingAddress?.pincode, FULL.billingPincode);

  equal('gstin survives', row?.gstin, FULL.gstin);
  equal('pan survives', row?.pan, FULL.pan);
  equal('contactEmail survives', row?.contactEmail, FULL.contactEmail);
  equal('contactPhone survives', row?.contactPhone, FULL.contactPhone);

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));

    if (budgetExhausted) {
      console.log(
        '\n[33mA send was throttled mid-run.[0m If this harness ran less than an hour\n' +
          'ago, the per-IP cap (OTP_MAX_SENDS_PER_IP_PER_HOUR, default 20) is spent —\n' +
          'wait out the hour or restart the server to clear the in-memory counters.'
      );
    }
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('\nHarness error:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
