# Diesel for You — Backend

REST API for the Diesel for You on-demand fuel delivery platform.

Built as a **modular monolith**: one deployable Express service with hard module
boundaries, so an individual domain can be extracted into its own service later
if a real scaling forcing-function appears. No microservices, no monorepo, no
Docker.

This repository is the backend only. The customer app, driver app, admin panel
and marketing website live in their own repositories.

> **Status: identity foundation.** Authentication, sessions and RBAC are
> implemented. No business domain exists yet — no customers, corporate accounts,
> drivers, fleet, orders, payments or wallets.
> See [What is and isn't implemented](#what-is-and-isnt-implemented).

## Authentication at a glance

| Endpoint                           | Auth          | Status | Purpose                                          |
| ---------------------------------- | ------------- | ------ | ------------------------------------------------ |
| `POST /api/v1/auth/otp/request`    | —             | 202    | Send a code (customer/driver path, BR-101)       |
| `POST /api/v1/auth/otp/verify`     | —             | 200    | Verify a code; creates the identity on SIGNUP    |
| `POST /api/v1/auth/register`       | —             | 201    | Password registration — **customer only**        |
| `POST /api/v1/auth/login`          | —             | 200    | Password login; requires an explicit `principal` |
| `POST /api/v1/auth/refresh`        | refresh token | 200    | Rotate the token pair                            |
| `POST /api/v1/auth/logout`         | access token  | 200    | End the calling session                          |
| `POST /api/v1/auth/logout-all`     | access token  | 200    | End every session                                |
| `GET /api/v1/auth/me`              | access token  | 200    | Identity, roles, permissions                     |
| `GET /api/v1/auth/sessions`        | access token  | 200    | List active devices                              |
| `DELETE /api/v1/auth/sessions/:id` | access token  | 200    | Revoke one device                                |

**Two authentication paths, by design.** Customers and drivers use OTP — BR-101
states no password is required for the customer app. Administrators use email
and password. Both converge on the same session and token machinery.

**Access tokens** are Bearer tokens carrying the caller's roles and permissions,
so authorisation costs no database query. The cost is a staleness window: a
permission or status change takes effect at the next access-token expiry
(default 15 minutes), which is why blocking an account should also revoke its
sessions.

**Refresh tokens** rotate on every use and are stored only as a SHA-256 hash.
Replaying a rotated token revokes the whole session.

**Sessions run on two clocks.** `expiresAt` slides forward on each rotation so
active users stay signed in; `absoluteExpiresAt` is fixed at login and never
extended, so every session eventually ends — including one an attacker keeps
alive with a stolen token (ADR-023).

---

## Requirements

|            | Version           | Notes                                                                                                                              |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | **>= 22.18**      | Required: Node strips the types from Prisma's generated client. See [note on Prisma](#note-prisma-7-generates-a-typescript-client) |
| PostgreSQL | >= 14 (18 tested) | Installed and running locally — no Docker                                                                                          |
| npm        | >= 10             |                                                                                                                                    |

Check with `node --version && psql --version`.

---

## Local setup

```bash
# 1. Clone and enter the repository
git clone <repository-url> diesel-for-you-backend
cd diesel-for-you-backend

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env        # Windows: copy .env.example .env
```

### 4. Create the database

```bash
createdb diesel_for_you
# or:  psql -U postgres -c "CREATE DATABASE diesel_for_you;"
```

### 5. Configure `.env`

Set `DATABASE_URL` to your local PostgreSQL instance:

```
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/diesel_for_you?schema=public
```

Then generate the two JWT secrets — the placeholders shipped in `.env.example`
are **rejected by validation** on purpose:

```bash
node -e "console.log(crypto.randomBytes(48).toString('base64url'))"   # JWT_ACCESS_SECRET
node -e "console.log(crypto.randomBytes(48).toString('base64url'))"   # JWT_REFRESH_SECRET
```

They must differ from each other, and each must be at least 32 characters.

### 6. Generate the Prisma client

```bash
npm run prisma:generate
```

Required before the first run, and again after any change to
`prisma/schema.prisma`. The output lands in `generated/` and is git-ignored.

### 7. Run migrations and seed

```bash
npm run prisma:migrate        # creates the seven identity tables
npm run prisma:seed           # roles + permissions (idempotent, no users)
```

The seed deliberately creates **no user accounts** — a default administrator
with a known password is how staging credentials reach production. Create the
first one explicitly:

```bash
npm run create:admin -- --email admin@example.com --phone +919876543210
```

The generated password is printed **once**. Store it immediately.

### 8. Start the server

```bash
npm run dev
```

Then:

```bash
curl http://localhost:4000/api/v1/health
```

A healthy instance responds `200`:

```json
{
  "success": true,
  "message": "Service is healthy",
  "data": {
    "status": "ok",
    "service": "diesel-for-you-backend",
    "environment": "development",
    "uptimeSeconds": 12,
    "timestamp": "2026-07-18T09:31:04.512Z",
    "dependencies": { "database": { "status": "up", "latencyMs": 1.84 } }
  }
}
```

If the database is unreachable it responds `503` with `status: "degraded"`, so a
load balancer takes the instance out of rotation.

---

## npm scripts

| Script                          | Does                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `npm run dev`                   | Start with auto-reload (`node --watch`)                    |
| `npm start`                     | Start for production                                       |
| `npm run build`                 | Generate the Prisma client — there is no compile step      |
| `npm run check`                 | `lint` + `format:check` + `prisma:validate`                |
| `npm test`                      | Unit tests, plus integration if `TEST_DATABASE_URL` is set |
| `npm run test:unit`             | Unit tests only — never touches a database                 |
| `npm run create:admin`          | Bootstrap the first administrator                          |
| `npm run lint`                  | ESLint                                                     |
| `npm run lint:fix`              | ESLint with autofix                                        |
| `npm run format`                | Prettier write                                             |
| `npm run format:check`          | Prettier check (CI)                                        |
| `npm run prisma:generate`       | Regenerate the Prisma client                               |
| `npm run prisma:migrate`        | Create and apply a migration (development)                 |
| `npm run prisma:migrate:deploy` | Apply pending migrations (production)                      |
| `npm run prisma:seed`           | Seed roles and permissions (idempotent)                    |
| `npm run prisma:studio`         | Prisma Studio database browser                             |
| `npm run prisma:validate`       | Validate the Prisma schema                                 |

> There is no `typecheck` script: this is a JavaScript codebase.
> `npm run check` is the equivalent pre-commit gate.

---

## Environment variables

Validated by Zod at startup (`src/config/env.js`). **The process exits with a
readable report if anything is missing or malformed** — it never boots
half-configured.

| Variable                         | Required | Default                  | Notes                                             |
| -------------------------------- | -------- | ------------------------ | ------------------------------------------------- |
| `NODE_ENV`                       | no       | `development`            | `development` \| `test` \| `production`           |
| `PORT`                           | no       | `4000`                   |                                                   |
| `HOST`                           | no       | `0.0.0.0`                |                                                   |
| `APP_NAME`                       | no       | `diesel-for-you-backend` | Appears in logs and health output                 |
| `DATABASE_URL`                   | **yes**  | —                        | Must start `postgresql://`                        |
| `DATABASE_POOL_MAX`              | no       | `10`                     | Pool size per instance                            |
| `DATABASE_CONNECTION_TIMEOUT_MS` | no       | `10000`                  |                                                   |
| `JWT_ACCESS_SECRET`              | **yes**  | —                        | >= 32 chars, no placeholder                       |
| `JWT_REFRESH_SECRET`             | **yes**  | —                        | >= 32 chars, must differ from the access secret   |
| `JWT_ACCESS_EXPIRES_IN`          | no       | `15m`                    |                                                   |
| `JWT_REFRESH_EXPIRES_IN`         | no       | `30d`                    |                                                   |
| `CORS_ORIGIN`                    | no       | `http://localhost:3000`  | Comma-separated. `*` is rejected in production    |
| `BODY_LIMIT`                     | no       | `100kb`                  | Max request body size                             |
| `TRUST_PROXY`                    | no       | `false`                  | `false` \| `true` \| hop count \| CIDR. See below |
| `RATE_LIMIT_WINDOW_MS`           | no       | `900000`                 | 15 minutes                                        |
| `RATE_LIMIT_MAX`                 | no       | `300`                    | Requests per window per IP                        |
| `LOG_LEVEL`                      | no       | `info`                   | pino level                                        |
| `SHUTDOWN_TIMEOUT_MS`            | no       | `15000`                  | Drain window before forced exit                   |

**`TRUST_PROXY` matters.** Leave it `false` when the app is directly exposed.
Set it only when running behind a proxy you control. Trusting proxies you don't
control lets a client spoof its IP via `X-Forwarded-For` and bypass rate limiting.

`.env` is git-ignored and must never be committed. `.env.example` is the
committed template.

---

## Project structure

```
diesel-for-you-backend/
├── prisma/
│   └── schema.prisma          # datasource + generator; NO models yet
├── prisma.config.js           # Prisma 7 CLI config (holds the datasource URL)
├── generated/                 # Prisma client output (git-ignored)
├── eslint.config.js
└── src/
    ├── server.js              # process lifecycle: boot, signals, graceful shutdown
    ├── app.js                 # Express assembly and middleware order
    │
    ├── config/
    │   └── env.js             # the ONLY module that reads process.env
    │
    ├── api/
    │   └── v1/index.js        # composition root: which module mounts where
    │
    ├── modules/               # one folder per business domain
    │   └── health/            # routes -> controller -> service
    │
    ├── shared/
    │   ├── constants/         # http-status.js, error-codes.js
    │   ├── errors/            # AppError hierarchy
    │   ├── logger/            # pino instance + redaction rules
    │   ├── middleware/        # request-id, http-logger, security, rate-limit,
    │   │                      # validate, shutdown-guard, not-found, error-handler
    │   ├── utils/             # api-response.js
    │   └── lifecycle.js       # shutdown state
    │
    └── infrastructure/
        └── database/prisma.js # single Prisma client + connect/disconnect/health
```

**Only directories with real code exist.** The remaining domains (`auth`,
`users`, `roles`, `customers`, `corporate`, `drivers`, `vehicles`, `fuel`,
`pricing`, `orders`, `dispatch`, `deliveries`, `payments`, `wallets`, `credit`,
`coupons`, `notifications`, `audit`) are created as they are built — an empty
folder tree communicates nothing and rots. The same applies to
`infrastructure/providers/`, which appears when the first external provider
adapter is written.

### Layering

```
routes  →  controller  →  service  →  repository  →  Prisma
 HTTP       HTTP-only     business     data access
```

- Controllers stay thin: read input, call a service, shape a response.
- Business logic lives in services, not controllers or routes.
- Prisma calls belong in a module's repository/data-access layer, never scattered
  through controllers.
- Cross-module access goes through the owning module's service, never by reaching
  into another module's tables.
- `import-x/no-cycle` is an ESLint **error** — circular imports are what turn a
  modular monolith back into a big ball of mud.

---

## Conventions

### Response envelope

Success:

```json
{ "success": true, "message": "Operation successful", "data": {} }
```

Error:

```json
{
  "success": false,
  "message": "Validation failed",
  "error": { "code": "VALIDATION_ERROR", "details": [] },
  "requestId": "0f1c…"
}
```

Clients branch on `error.code` — never on `message`. Codes live in
`src/shared/constants/error-codes.js` and are part of the API contract.

`requestId` is included on errors and returned on **every** response as the
`X-Request-Id` header, so a user's bug report maps to exact log lines.

### Errors

Throw from anywhere; the centralised handler formats the response:

```js
import { NotFoundError, ConflictError } from '../../shared/errors/index.js';

if (!order) throw new NotFoundError('Order not found');
```

Express 5 forwards rejected promises from async handlers automatically — no
`asyncHandler` wrapper is needed.

Errors carry an `isOperational` flag. Operational errors (not found, forbidden,
validation) are described to the client. Anything else is reported as a generic
`Internal server error` in production, with the stack logged but never sent.

### Validation

```js
import { z } from 'zod';
import { validate } from '../../shared/middleware/validate.js';

const schema = { body: z.object({ litres: z.number().positive() }) };

router.post('/orders', validate(schema), createOrder);
```

Read parsed values from **`req.validated.body` / `.query` / `.params`**, not from
`req.body` / `req.query`. `req.query` is a getter in Express 5 and cannot be
reassigned, and reading the validated copy makes it obvious a value has been
through a schema.

### Logging

pino: pretty in development, JSON everywhere else. Each request gets a child
logger at `req.log` with the request id already bound.

```js
req.log.info({ orderId }, 'order confirmed');
```

Passwords, tokens, OTPs, card details and connection strings are stripped by the
redaction list in `src/shared/logger/index.js`. HTTP headers are never
serialised at all, so `Authorization` cannot leak even by accident. **Never log
a raw request body** in a module that handles credentials or payment data.

### Protecting an endpoint

```js
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { PERMISSIONS } from '../../shared/constants/rbac.js';

router.post(
  '/orders/:id/cancel',
  authenticate, // 401 if no valid token
  requirePrincipal('CUSTOMER'), // 403 if a driver token
  requirePermission(PERMISSIONS.ORDER_CANCEL), // 403 if not granted
  cancelOrder
);
```

Check **permissions**, never role names — `if (user.role === 'ADMIN')` scatters
authorisation across call sites and makes "who can do what" unanswerable
(ADR-008). `requireRole` exists for genuinely role-shaped questions and should
be the last thing you reach for.

For "may this caller act on _this_ record?", use `requireOwnership` from
`shared/middleware/ownership.js`. Resources the caller may not see return
**404, not 403** — a 403 confirms the record exists.

---

## Note: Prisma 7 generates a TypeScript client

All source in `src/` is plain JavaScript. However, Prisma 7's `prisma-client`
generator emits **TypeScript**, which Node strips at load time. Two consequences:

1. **Node >= 22.18 is required** (native type stripping). Node 20 reached
   end-of-life in April 2026, so this is not a practical restriction.
2. The generated client is imported via the `#prisma` subpath alias declared in
   `package.json`, so no application file references a `.ts` path directly.

Setting the generator to emit `.js` does not work: it renames the files without
converting the contents. If a pure-JavaScript client is ever required, pin Prisma
to v6 and use the `prisma-client-js` generator — the only file that would change
is `src/infrastructure/database/prisma.js`.

---

## Scaling notes

The service is stateless and safe to run behind a load balancer with one
exception, deliberately isolated:

- **Rate limiting uses an in-memory store.** Counters are per process, so N
  instances means an effective limit of N × `RATE_LIMIT_MAX`. Before running more
  than one instance, add `rate-limit-redis` and pass it as `store` in
  `src/shared/middleware/rate-limit.js`. Nothing else changes.

Redis, BullMQ and Socket.IO are intentionally absent — they are added with the
modules that need them. Nothing in the current design blocks them.

---

## What is and isn't implemented

**Implemented**

- Express 5 app with ordered security, logging and parsing middleware
- Zod-validated environment configuration with fail-fast startup
- PostgreSQL via Prisma 7 with a pg driver adapter and a single shared pool
- Health endpoint with a timeout-guarded database check
- Centralised error handling and a custom error hierarchy
- Request validation foundation
- Request ID propagation and pino structured logging with redaction
- Helmet, CORS allowlist, rate limiting, body size limits
- Versioned `/api/v1` router structure
- Graceful shutdown on SIGINT/SIGTERM with drain and forced-exit backstop
- ESLint (incl. circular-import detection) and Prettier
- **Identity foundation**: seven tables (`users`, `user_sessions`,
  `otp_challenges`, `roles`, `permissions`, `role_permissions`, `user_roles`)
- **Authentication**: OTP (customer/driver) and Argon2id passwords (admin),
  JWT access + refresh, refresh rotation with reuse detection, absolute session
  ceiling, multi-device sessions, individual and bulk revocation
- **Authorisation**: permission middleware, principal separation, ownership
  guards, seeded RBAC catalogue
- **Tests**: 51 unit tests, plus an integration suite gated on a real database

**Not implemented — deliberately**

- **SMS delivery.** OTP issue, verification, expiry, attempt limits and rate
  limiting are all implemented; only the transport is not. The console provider
  logs the code in development and **refuses to run in production**, so a
  misconfiguration fails loudly instead of printing login codes into the log
  aggregator. Adding a DLT-registered vendor is one file (ADR-024).
- Any business table or domain: customers, corporate accounts, drivers, fleet,
  vehicles, orders, dispatch, deliveries, payments, wallets, credit,
  notifications, audit.
- Driver and administrator **registration endpoints**. Both are created by an
  administrator (BR-301, docs/03 §1), so `/auth/register` creates a customer
  identity only. Bootstrap an administrator with `npm run create:admin`.
- Role and permission **management endpoints**. The tables, seed and middleware
  exist; the admin CRUD surface does not.
- External integrations: Google Maps, Flow Meter, payment gateways, SMS,
  AWS, Firebase. These sit behind provider interfaces in
  `src/infrastructure/providers/`.
- Redis, BullMQ, Socket.IO.
- Swagger/OpenAPI document. The structure supports it; nothing is generated yet.

### Known gaps worth tracking

| Gap                                                    | Impact                                                      | Fix                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| Access tokens stay valid up to 15 min after logout     | A token stolen before logout works until it expires         | Redis denylist checked in `authenticate`, once Redis exists                 |
| Password registration is enumerable (409 on duplicate) | An attacker can test whether a phone has a password account | Prefer the OTP path, which is not enumerable; or drop password registration |
| Rate limiting is per process                           | N instances give N x the limit                              | `rate-limit-redis`, one `store` option in two files                         |
| Session and OTP cleanup are not scheduled              | Both tables grow without bound                              | `purgeDeadSessions` / `purgeSpentChallenges` exist; wire them to BullMQ     |
| No cap on concurrent sessions per user                 | A user can accumulate unbounded sessions                    | Evict the oldest beyond N at login                                          |
| Admin MFA not implemented                              | A password alone protects admin accounts                    | TOTP enrolment, with the admin module                                       |

---

## Business rules preserved for the schema phase

Recorded here and in `prisma/schema.prisma` so they survive into the data model:

- **Corporate verification status and account status are separate concepts.**
  Verification is `PENDING` → `APPROVED` | `REJECTED`. Account status is
  `ACTIVE` | `SUSPENDED` | `INACTIVE`. An approved company can later be suspended
  without losing its approval history. Only `APPROVED` + `ACTIVE` may log in.
- **Corporate account approval and corporate credit approval are separate
  processes.** A company can be `APPROVED` + `ACTIVE` with credit `NOT_ENABLED`,
  using normal payment methods but no credit facility.
- A corporate account has many members, with future roles `CORPORATE_OWNER`,
  `CORPORATE_ADMIN`, `PURCHASE_MANAGER`, `VIEWER`.
- **RBAC is permission-based, not role-string-based.** No
  `if (user.role === 'ADMIN')` in controllers; authorisation goes through
  reusable permission-checking middleware.
- **Money is `Decimal`, never a float.** Fuel quantities are `Decimal` litres.
- **Refresh tokens are stored hashed**, never as plaintext, and rotate on use.
- Primary keys are UUIDs.

---

## Next step

**Identity & Authentication schema design and implementation** — users, sessions,
roles, permissions, user roles, role permissions, retail customer profiles,
corporate accounts, corporate members, the corporate verification workflow, and
the authentication rules above.

---

## Related documents

Wider platform planning lives in `../docs/`. Note that those documents predate
this repository and specify Drizzle ORM and TypeScript; this backend uses Prisma
and JavaScript per current direction. Reconcile the two before the schema phase.
