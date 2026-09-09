# Diesel For You — API for the App Developer

This is the complete API your mobile apps (Customer + Driver) talk to. **Everything
goes through this backend.** Your apps never call any third-party service directly —
not the IoT/fuel-monitoring vendor, not the SMS provider, nothing. You call *our*
endpoints; we deal with everything behind them.

- **Base URL (production):** `https://diesel.sarstage.online/api/v1`
- All paths below already include the `/api/v1` prefix.
- All requests and responses are JSON (`Content-Type: application/json`), except
  where noted.

---

## 1. Conventions you must follow

### 1.1 Response envelope
Every response has the same shape.

**Success:**
```json
{ "success": true, "message": "…", "data": { … } }
```
The useful payload is always inside `data`.

**Error:**
```json
{
  "success": false,
  "message": "human readable message",
  "error": { "code": "MACHINE_CODE", "details": [ … ] },
  "requestId": "…"
}
```
- Branch on `error.code` (a stable machine string), **not** on the message text.
- Validation failures use `code: "VALIDATION_ERROR"` (HTTP 400) and list each bad
  field in `error.details` as `{ field, message, code }`, where `field` is prefixed
  by its source, e.g. `body.phone`, `params.id`.
- Unknown route → `404 ROUTE_NOT_FOUND`.

### 1.2 Money and quantities are STRINGS
Every amount, litre quantity, and GPS coordinate is sent and expected as a **string**
(e.g. `"2500.00"`, `"10.530"`, `"22.5449983"`). Do **not** parse them into a JS
`number` and back — you will lose paise/millilitres. Keep them as strings; use a
decimal library if you must do math.

### 1.3 Authentication header
All authenticated calls need:
```
Authorization: Bearer <accessToken>
```
Missing → `401 TOKEN_MISSING`; malformed → `401 TOKEN_INVALID`; expired →
`401 TOKEN_EXPIRED` (→ refresh, see §2.4).

Three account types ("principals"): `CUSTOMER`, `DRIVER`, `ADMIN`. A token is bound
to one principal. Calling an endpoint with the wrong principal → `403 WRONG_PRINCIPAL`.

### 1.4 Rate limiting
All endpoints are rate-limited; `/auth/*` more strictly. On a limit you get
`429` with a code like `OTP_RATE_LIMITED` / `OTP_RESEND_TOO_SOON`
(`error.details.retryAfterSeconds` tells you how long to wait).

---

## 2. Auth flow (Customer & Driver = OTP)

Customers and drivers sign in with a phone OTP. (Admins use password login; your apps
don't need that.)

### 2.1 Request an OTP — `POST /auth/otp/request`
No auth.
```json
{ "phone": "+919812345678", "principal": "CUSTOMER", "purpose": "LOGIN" }
```
- `principal`: `CUSTOMER` or `DRIVER`.
- `purpose`: `LOGIN` (existing user), `SIGNUP` (new customer — CUSTOMER only), or
  `PHONE_VERIFICATION`.
- Response `202`:
  ```json
  { "success": true, "data": { "challengeId": "…", "expiresAt": "…",
    "retryAfterSeconds": 30, "devCode": "123456" } }
  ```
  - **`devCode`** — the OTP itself. In production it is present **only because the
    server currently runs with a fixed test OTP** (see §7 security note). Treat its
    presence as temporary; the real flow is "user reads SMS, types code."

### 2.2 Verify the OTP → get tokens — `POST /auth/otp/verify`
No auth.
```json
{ "phone": "+919812345678", "principal": "CUSTOMER", "purpose": "LOGIN", "code": "123456" }
```
- Response `200`:
  ```json
  { "success": true, "data": {
      "user": { "id","principal","phone","email","status","phoneVerified","emailVerified","createdAt" },
      "roles": ["…"], "permissions": ["…"],
      "tokens": { "accessToken": "…", "refreshToken": "…" }
  } }
  ```
- Store both tokens securely. Use `accessToken` as the bearer; keep `refreshToken`
  for §2.4.
- First-time `CUSTOMER` + `SIGNUP` creates the account. `DRIVER` accounts must already
  exist (created by admin) — an unknown driver number → `401 INVALID_CREDENTIALS`.
- Wrong/expired code → `401 OTP_INVALID`; too many tries → `401 OTP_ATTEMPTS_EXCEEDED`.

### 2.3 Optional device metadata
Any auth call (`register`/`login`/`otp/verify`) may include:
`deviceId`, `deviceName`, `platform` (`ANDROID|IOS|WEB|UNKNOWN`), `appVersion`.
Recommended so the user can see/manage their devices.

### 2.4 Refresh tokens — `POST /auth/refresh`
No bearer (the refresh token *is* the credential).
```json
{ "refreshToken": "…" }
```
- Response `200`: same shape as verify, with a **new** token pair. The old refresh
  token is rotated (invalidated) — always replace both with the new pair.
- Do this when an access token returns `401 TOKEN_EXPIRED`, then retry the call once.

### 2.5 Session management
- `GET /auth/me` — current user, roles, permissions.
- `GET /auth/sessions` — list this user's sessions/devices (`isCurrent` flags the one in use).
- `DELETE /auth/sessions/:id` — revoke one device.
- `POST /auth/logout` — end current session. `POST /auth/logout-all` — end all.

---

## 3. Customer app

All routes need a **CUSTOMER** bearer token.

### 3.1 Profile
- `POST /customers/register` — create the customer profile after first sign-in.
  Body (all optional): `fullName`, `preferredLanguage` (default `"en"`),
  `emergencyContactName`, `emergencyContactPhone`, `marketingOptIn`,
  `notifyByPush`, `notifyBySms`, `notifyByEmail`.
- `GET /customers/me` — read profile. No profile yet → `404 PROFILE_NOT_FOUND`.
- `PATCH /customers/me` — update (send only changed fields; ≥1 required). Phone/email
  are **not** editable here.

`profile` shape: `{ id, userId, phone, email, phoneVerified, emailVerified,
accountStatus, fullName, preferredLanguage, profileImageKey,
emergencyContact:{name,phone}, preferences:{…}, createdAt, updatedAt }`.

### 3.2 Addresses
- `GET /customers/addresses` — list.
- `POST /customers/addresses` — create (first one becomes default). Body:
  - **Required:** `line1`, `city`, `state`, `pincode` (`^[1-9]\d{5}$`),
    `latitude` (string, −90..90), `longitude` (string, −180..180).
  - Optional: `nickname`, `line2`, `landmark`, `googlePlaceId`,
    `deliveryInstructions`, `contactName`, `contactPhone`, `isDefault`.
  - Response includes `isServiceable` / `serviceCheckedAt` — whether we deliver to
    that pincode. Use it to warn the user early.
- `PATCH /customers/addresses/:id` — update (send `latitude`+`longitude` together).
- `DELETE /customers/addresses/:id` — archive (kept for order history); returns
  `{ id, archived: true }`.
- Max 50 addresses → `400 ADDRESS_LIMIT_REACHED`.

### 3.3 The ordering journey (do it in this order)

**Step 1 — discover the product:** `GET /products`
```json
{ "data": { "products": [ { "id","code","name","description","unit" } ] } }
```
Only ACTIVE products; `unit` is usually `LITRE`. Never hardcode the product id — read
it here.

**Step 2 — get a price quote:** `POST /quotes`
```json
{ "addressId": "<uuid>", "productId": "<uuid>", "quantity": "500" }
```
- You do **not** send a price — the server computes and locks it.
- Response `201` → `data.quote`:
  ```json
  { "id","productId","addressId","quantity","currency":"INR",
    "fuelAmount","deliveryAmount","taxAmount","totalAmount",
    "lines":[…], "priceVersion":{"priceId","pricePerUnit"},
    "deliveryWaived", "expiresAt", "isExpired", "status", "createdAt" }
  ```
- Quotes **expire** (`expiresAt`) and are single-use. Common errors: `404` address/
  product not found, `409 NO_ACTIVE_PRICE`, `409 NO_DELIVERY_CHARGE_RULE`,
  `400 BELOW_MINIMUM_ORDER_QUANTITY`. Any of these means "you can't price this now" —
  show the reason.
- `GET /quotes/:id` re-reads a quote (returns expired ones flagged, for a re-quote screen).

**Step 3 — place the order:** `POST /orders`
- **Header required:** `Idempotency-Key: <uuid>` (generate once per attempt; reuse on
  retry so a dropped response never double-orders). Missing → `400 IDEMPOTENCY_KEY_REQUIRED`.
```json
{ "quoteId": "<uuid>", "paymentMode": "CASH_ON_DELIVERY", "deliveryInstructions": "…",
  "acknowledgeDuplicate": false }
```
- `paymentMode`: this phase only `CASH_ON_DELIVERY` and `PREPAID_ONLINE` are accepted.
- Response `201` → `data.order` (full shape in §3.4). COD orders start `CONFIRMED`;
  prepaid start `PENDING_PAYMENT`.
- Errors: `409 QUOTE_ALREADY_USED`, `410 QUOTE_EXPIRED` (re-quote), `409 NO_VEHICLE_AVAILABLE`,
  `409 DUPLICATE_ORDER` (a soft warning — if the user really means it, resend with
  `acknowledgeDuplicate: true`; `error.details` names the existing order).

**Step 4 — track the order:**
- `GET /orders` — list (cursor paginated). Query: `status` (comma-separated filter,
  e.g. `?status=ASSIGNED,EN_ROUTE`), `limit` (1–100, default 20), `cursor`.
  Response: `{ orders:[summary], pagination:{ nextCursor, hasMore } }`.
- `GET /orders/:id` — full detail (`data.order`).
- `GET /orders/:id/history` — status timeline:
  `{ orderId, orderNumber, currentStatus, timeline:[{status,previousStatus,actor,reason,occurredAt}] }`.
- `POST /orders/:id/cancel` — body `{ "reason": "…" }`. Only works from early states
  (see §6); once `EN_ROUTE`/`ARRIVED`/`DISPENSING` it can't be self-cancelled.

### 3.4 Order object (`data.order`)
```
{ id, orderNumber, status, paymentStatus, settlementStatus, paymentMode,
  quantity, deliveredQuantity, currency:"INR",
  fuelAmount, deliveryAmount, taxAmount, totalAmount, finalTotalAmount,
  placedAt, statusChangedAt, expiresAt,
  product:{code,name,unit},
  deliveryAddress:{nickname,line1,line2,landmark,city,state,pincode,contactName,contactPhone},
  deliveryInstructions,
  breakdown:{lines,totals},
  cancellation:{cancelledAt,cancelledBy,reason} | null }
```
(List responses return a lighter summary of the same fields plus `city`.)

---

## 4. Driver app

All routes need a **DRIVER** bearer token. No route takes a driver id — the driver is
the token.

### 4.1 Launch screen — `GET /driver/me`
Everything the app needs on open:
```
{ driver:{ id,userId,employeeCode,fullName,employmentStatus,availability,licenseExpiry,phone },
  vehicle:{ id,vehicleNumber,registrationNumber,makeModel,tankCapacity,status,
            calibrationExpiry,pesoLicenseExpiry,
            inventory:{currentQuantity,heldQuantity,availableQuantity,lastVerifiedAt} } | null,
  shift:{ id,vehicleId,status,startedAt,endedAt,openingTotalizer,closingTotalizer,openingFuelQuantity } | null,
  blockers:[ { code, severity:"HARD", message, detail? } ],
  canStartShift: boolean }
```
`blockers` is why the driver can't work yet (expired licence, no vehicle, expired
calibration/PESO, …). If non-empty, show them and disable Go-Online.

### 4.2 Availability & shifts
- `PATCH /driver/availability` — body `{ "availability": "ONLINE" | "BREAK" | "OFFLINE" }`
  (`ON_TRIP` is system-set, not settable). Going ONLINE with no open shift →
  `409 SHIFT_NOT_OPEN`.
- `GET /driver/shifts/current` — `{ shift } | { shift: null }`.
- `POST /driver/shifts/start` — body:
  `{ "vehicleId":"<uuid>", "openingTotalizer":"<string>", "openingFuelQuantity"?:"<string>",
     "photoKey"?, "notes"? }` → `201 { shift }`.
- `POST /driver/shifts/end` — body:
  `{ "closingTotalizer":"<string>", "closingFuelQuantity"?, "declaredCash"?, "photoKey"?, "notes"? }`
  → `200 { shift }`.

### 4.3 Orders on the vehicle
- `GET /driver/orders?scope=ACTIVE|COMPLETED&limit=25` →
  `{ orders:[order], vehicleId }`.
  Driver order shape:
  `{ id, orderNumber, status, quantity, deliveredQuantity, product, paymentMode,
     amountToCollect (only for CASH_ON_DELIVERY, else null),
     customer:{fullName,phone}, address, deliveryInstructions, placedAt, statusChangedAt }`.
- `GET /driver/orders/:id` → `{ order, timeline[], reservation|null,
     readings:[{id,readingType,totalizer,capturedAt,hasPhoto}] }`.

### 4.4 The delivery sequence (call in order)
1. `POST /driver/orders/:id/start-trip` — → `EN_ROUTE`. No body.
2. `POST /driver/orders/:id/arrive` — body `{ "latitude"?, "longitude"? }` (numbers;
   a missing GPS fix is allowed) → `ARRIVED`.
3. `POST /driver/orders/:id/start-dispensing` — verify the receiver and take the
   **opening** reading → `DISPENSING`. Body:
   ```json
   {
     "receiverVerification": { "method": "OTP", "code": "1234" },
     "openingTotalizer": "…",   // manual tankers only — see note
     "openingStock": "…",       // manual fallback for a stock-model bowser
     "photoKey": "…"            // required for a manually-typed reading
   }
   ```
   `receiverVerification` is one of:
   - `{ "method":"OTP", "code":"<4-10 digits>" }`, or
   - `{ "method":"FALLBACK", "receiverName":"…", "signatureKey":"…", "sitePhotoKey":"…", "reasonCode":"…" }`.
4. `POST /driver/orders/:id/complete` — take the **closing** reading and the outcome.
   ```json
   {
     "clientDeliveryId": "<uuid generated once, reused on every retry>",
     "outcome": "FULL",                 // FULL | PARTIAL | FAILED
     "reasonCode": "…",                 // REQUIRED when outcome != FULL
     "closingTotalizer": "…",           // manual tankers only
     "closingStock": "…",               // manual fallback (stock-model)
     "photoKey": "…",                   // required for a manual reading
     "temperatureC"?: 29, "notes"?: "…"
   }
   ```
   Response: `{ order, replayed: boolean, deliveredQuantity: string|null, rollover: boolean }`.
   A retry with the same `clientDeliveryId` safely replays (`replayed: true`).

> **IMPORTANT — IoT (bowser-monitor) tankers.** If the tanker has the IoT monitor
> fitted (admin sets this per vehicle), the backend **fetches the opening/closing
> readings from the device itself** — the driver does **not** type them. On those
> vehicles:
> - Send `start-dispensing` / `complete` **without** `openingTotalizer`/`openingStock`/
>   `closingTotalizer`/`closingStock` and **without** `photoKey`; the server reads the
>   device.
> - Only if the device is unreachable does the server reply `503` with
>   `error.code: "METER_DEVICE_UNAVAILABLE"`. That is your signal to show the manual
>   entry (stock litres + photo) and resubmit **with** `openingStock`/`closingStock`
>   and `photoKey`.
>
> Your app can tell whether a vehicle is IoT-monitored from its telemetry/vehicle
> data (see §5). Design the reading screen to **hide** the manual field by default on
> IoT tankers and only reveal it on that `503`.

---

## 5. Live IoT telemetry (fuel level, location, movement)

The tanker's live data comes from an IoT monitor on the bowser. **Only our backend can
reach that device platform** (its credentials and an IP allow-list live on our server),
so your app reads it **from us**:

### `GET /admin/vehicles/:id/telemetry`  *(currently ADMIN token; see note)*
Response `data.telemetry`:
```json
{
  "vehicleId": "…", "vehicleNumber": "…", "registrationNumber": "WB19V9607",
  "measurement": "STOCK",
  "stockLitres": "10.530",
  "tankCapacity": "12000",
  "fillPercent": 0.1,
  "temperatureC": "29.0",
  "status": "IDLE",
  "location": { "latitude": 22.5449983, "longitude": 88.3245866 },
  "movementStatus": "PARKED",
  "capturedAt": "2026-09-09T11:29:46.706Z"
}
```
- `stockLitres` = litres in the tank right now (a **string**). `fillPercent` is a
  convenience (0–100).
- `capturedAt` is **our** receive time (the device sends none).
- Failure modes: `409 FLOW_METER_NOT_ENABLED` (vehicle has no monitor),
  `404` (registration not mapped to a device), `503 METER_DEVICE_UNAVAILABLE`
  (device offline/faulty — retryable).

> **Note on access:** this endpoint is exposed under `/admin` today (it powers the
> admin panel's live-device view). If the **driver app** needs to show its own
> tanker's live level, or the **customer app** needs the tanker's live location while
> tracking an order, tell us and we'll add principal-scoped variants
> (`/driver/vehicle/telemetry`, `/orders/:id/telemetry`) that return the same shape,
> scoped to the caller. The data source and format stay identical — only the auth
> scope changes.

---

## 6. Enum reference

**Order status** (`status`): `DRAFT, PENDING_PAYMENT, PAYMENT_FAILED, CONFIRMED,
ALLOCATING, ALLOCATION_FAILED, ASSIGNED, EN_ROUTE, ARRIVED, DISPENSING, DELIVERED,
PARTIALLY_DELIVERED, DELIVERY_FAILED, CANCELLED_BY_CUSTOMER, CANCELLED_BY_ADMIN,
EXPIRED, CLOSED`.

**Self-cancellable statuses** (customer `POST /orders/:id/cancel`): `DRAFT,
PENDING_PAYMENT, PAYMENT_FAILED, CONFIRMED, ALLOCATING, ALLOCATION_FAILED, ASSIGNED`.

**paymentStatus:** `NOT_REQUIRED, PENDING, AUTHORIZED, CAPTURED, SETTLED, FAILED,
PARTIALLY_REFUNDED, REFUNDED`.
**settlementStatus:** `NOT_REQUIRED, PENDING, SETTLED`.
**paymentMode:** `PREPAID_ONLINE, WALLET, CASH_ON_DELIVERY, CORPORATE_CREDIT`
(accepted now: `CASH_ON_DELIVERY`, `PREPAID_ONLINE`).

**Delivery outcome** (`complete`): `FULL, PARTIAL, FAILED` →
order `DELIVERED, PARTIALLY_DELIVERED, DELIVERY_FAILED`.
**Driver availability:** `OFFLINE, ONLINE, ON_TRIP, BREAK` (`ON_TRIP` is system-set).
**Actor** (in timelines): `CUSTOMER, DRIVER, ADMIN, SYSTEM`.
**Telemetry `measurement`:** `STOCK` (litres in tank) or `TOTALIZER` (lifetime meter);
FYFT tankers are `STOCK`. **`status`:** `IDLE, DISPENSING, FAULT`.

---

## 7. Common error codes

| Code | When | What the app should do |
|---|---|---|
| `TOKEN_EXPIRED` | access token old | refresh (§2.4), retry once |
| `TOKEN_MISSING` / `TOKEN_INVALID` | bad/absent bearer | send to login |
| `WRONG_PRINCIPAL` | customer token on driver route (or vice-versa) | bug in app — fix the token used |
| `VALIDATION_ERROR` | bad request body/params | show per-field `error.details` |
| `OTP_INVALID` / `OTP_ATTEMPTS_EXCEEDED` | wrong/too many OTP | re-request |
| `OTP_RESEND_TOO_SOON` / `OTP_RATE_LIMITED` | 429 | wait `details.retryAfterSeconds` |
| `PROFILE_NOT_FOUND` | customer has no profile | send to profile setup |
| `QUOTE_EXPIRED` (410) / `QUOTE_ALREADY_USED` | stale/used quote | get a fresh quote |
| `NO_ACTIVE_PRICE` / `NO_DELIVERY_CHARGE_RULE` / `BELOW_MINIMUM_ORDER_QUANTITY` | can't price | show reason, block checkout |
| `IDEMPOTENCY_KEY_REQUIRED` | placing order without the header | add `Idempotency-Key` |
| `DUPLICATE_ORDER` | likely double-tap | confirm, resend with `acknowledgeDuplicate:true` |
| `NO_VEHICLE_AVAILABLE` | no stock/tanker | tell user to try later |
| `METER_DEVICE_UNAVAILABLE` (503) | IoT device unreachable | show manual reading entry + photo, resubmit |
| `METER_PHOTO_REQUIRED` | manual reading without photo | attach `photoKey` |
| `FLOW_METER_NOT_ENABLED` (409) | telemetry asked for a non-IoT vehicle | hide the live-level UI |

---

## 8. Security notes (please read)

1. **OTP test bypass is currently ON in production.** The server runs with a fixed OTP
   (`123456`) so anyone who knows a phone number can sign in as it, and the code is even
   echoed back in `devCode`. This is a **temporary testing setting** and will be turned
   off before real launch — do **not** design the app to depend on `devCode`; read the
   OTP from SMS as normal.
2. **Never ship any third-party credential in the app.** The IoT vendor's code, SMS
   keys, etc. all live on our server. Your app only ever holds the user's own
   access/refresh tokens.
3. Store tokens in secure storage (Keychain / EncryptedSharedPreferences), not plain
   prefs.

---

*Questions or a missing endpoint (e.g. driver/customer-scoped live telemetry, push
notifications)? Send them over and we'll extend this backend — the app only ever needs
to talk to us.*
