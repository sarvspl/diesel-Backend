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
`401 TOKEN_EXPIRED` (→ refresh, see §2.9).

Three account types ("principals"): `CUSTOMER`, `DRIVER`, `ADMIN`. A token is bound
to one principal. Calling an endpoint with the wrong principal → `403 WRONG_PRINCIPAL`.

### 1.4 Rate limiting
All endpoints are rate-limited; `/auth/*` more strictly. On a limit you get
`429` with a code like `OTP_RATE_LIMITED` / `OTP_RESEND_TOO_SOON`
(`error.details.retryAfterSeconds` tells you how long to wait).

---

## 2. Auth flow (Customer & Driver)

Customers and drivers have **two ways to sign in to the same account**:

| Method | Calls | Works for |
|---|---|---|
| **Mobile + OTP** | `otp/request` → `otp/verify` (§2.1, §2.2) | every account |
| **Mobile or email + password** | `login` (§2.3) | accounts that have a password (`user.hasPassword`) |

Where a password comes from:
- **Customer** — chosen at sign-up (§2.4), or set later (§2.6 / §2.7).
- **Driver** — drivers cannot self-register; ops creates the account and may set an
  email + initial password. Otherwise the driver signs in by OTP and sets one in the app
  (§2.7), or uses *Forgot password* (§2.6).

Rules that apply to every call below:
- `phone` is E.164 India: `+91` + 10 digits starting 6–9 (`+919812345678`).
- `password` / `newPassword`: **12–128 characters**, no composition rules.
- `email` is lower-cased by the server. Email is **not** verified yet, it is only a
  second login identifier.
- `principal` is always explicit (`CUSTOMER` in the customer app, `DRIVER` in the driver
  app). The same number can be a customer and a driver — they are separate accounts.

**Sign-in response** — `otp/verify`, `login`, `register`, `password/reset` and `refresh`
all return the same `data`:
```json
{ "success": true, "data": {
    "user": { "id","principal","phone","email","status",
              "phoneVerified","emailVerified","hasPassword","createdAt" },
    "roles": ["…"], "permissions": ["…"],
    "tokens": { "accessToken": "…", "refreshToken": "…" }
} }
```
Store both tokens securely. Use `accessToken` as the bearer; keep `refreshToken` for
§2.9. `user.hasPassword` tells you whether to show *Set password* or *Change password*.

> A `401` from these **unauthenticated** calls (`login`, `register`, `otp/*`,
> `password/reset`) is a wrong credential, not an expired session — show the error, do
> **not** run your refresh-token logic on it.

### 2.1 Request an OTP — `POST /auth/otp/request`
No auth.
```json
{ "phone": "+919812345678", "principal": "CUSTOMER", "purpose": "LOGIN" }
```
- `principal`: `CUSTOMER` or `DRIVER`.
- `purpose`:
  - `LOGIN` — sign in an existing account.
  - `SIGNUP` — customer sign-up (CUSTOMER only). Use before §2.4, or with §2.2 for
    passwordless sign-up.
  - `PASSWORD_RESET` — forgot password (§2.6).
  - `PHONE_VERIFICATION`.
- Response `202`:
  ```json
  { "success": true, "data": { "challengeId": "…", "expiresAt": "…",
    "retryAfterSeconds": 30, "devCode": "123456" } }
  ```
  - **`devCode`** — the OTP itself. In production it is present **only because the
    server currently runs with a fixed test OTP** (see §8 security note). Treat its
    presence as temporary; the real flow is "user reads SMS, types code."
  - Resend: wait `retryAfterSeconds` (30 s, 60 s, 120 s, 300 s…). Too early →
    `429 OTP_RESEND_TOO_SOON`; too many per hour → `429 OTP_RATE_LIMITED`.
  - Each purpose has its own code: a `SIGNUP` code cannot be used for `PASSWORD_RESET`
    and vice-versa. Codes are single-use.

### 2.2 Sign in with OTP — `POST /auth/otp/verify`
No auth.
```json
{ "phone": "+919812345678", "principal": "CUSTOMER", "purpose": "LOGIN", "code": "123456" }
```
- `purpose`: `LOGIN`, `SIGNUP` or `PHONE_VERIFICATION` (not `PASSWORD_RESET`).
- Response `200`: the sign-in response above.
- `CUSTOMER` + `SIGNUP` **creates the account on first use and signs in an existing
  one** — i.e. passwordless sign-up. That account has no password until one is set (§2.7).
- `DRIVER` accounts must already exist (created by admin) — an unknown driver number →
  `401 INVALID_CREDENTIALS`. An unknown number with `LOGIN` → same.
- Wrong/expired code → `401 OTP_INVALID`; too many tries → `401 OTP_ATTEMPTS_EXCEEDED`
  (request a new code).

### 2.3 Sign in with password — `POST /auth/login`
No auth. Send **exactly one** of `phone` or `email`:
```json
{ "principal": "DRIVER", "phone": "+919812345678", "password": "my-long-password" }
{ "principal": "CUSTOMER", "email": "asha@example.com", "password": "my-long-password" }
```
- Response `200`: the sign-in response above.
- Suggested UI: one field *"Mobile number or email"* — contains `@` → send `email`,
  otherwise normalise to `+91XXXXXXXXXX` and send `phone`.
- Unknown account, wrong password, and **account without a password** all return the
  same `401 INVALID_CREDENTIALS` (so nobody can probe which numbers are registered).
  Show: *"Incorrect mobile/email or password — or sign in with OTP / use Forgot
  password."*
- Blocked / deleted account → `401 ACCOUNT_BLOCKED` / `ACCOUNT_DELETED`.

### 2.4 Customer sign-up with password — `POST /auth/register`
CUSTOMER only. No auth. The mobile number is verified by OTP **in the same call**:

1. Sign-up form: mobile, email (optional), password, confirm password.
2. `POST /auth/otp/request` `{ phone, principal: "CUSTOMER", purpose: "SIGNUP" }`
3. User types the code, then:
```json
{ "phone": "+919812345678", "code": "123456",
  "password": "my-long-password", "email": "asha@example.com",
  "consentVersion": "2026-07-01" }
```
- `email` and `consentVersion` are optional.
- Response `201`: the sign-in response above (`hasPassword: true`, `phoneVerified: true`).
  The user can now sign in either way (§2.2 or §2.3).
- Then create the customer profile as today: `POST /customers/register` (§3.1).
- Errors:
  - `401 OTP_INVALID` / `OTP_ATTEMPTS_EXCEEDED` — wrong code.
  - `409 ACCOUNT_ALREADY_EXISTS`, `error.details.field = "phone"` — number already
    registered → send the user to sign in.
  - `409 ACCOUNT_ALREADY_EXISTS`, `error.details.field = "email"` — email used by another
    account. The code was spent: let the user fix/remove the email and request a new code.

### 2.5 Driver accounts
Drivers **cannot** sign up in the app. Ops creates the driver in the admin panel
(`POST /admin/drivers`) with the mobile number and, optionally, an email and initial
password. If no password was set, the driver signs in by OTP (`purpose: "LOGIN"`) and can
then set one (§2.7) — or use *Forgot password* (§2.6) straight from the login screen.

### 2.6 Forgot password — `POST /auth/password/reset`
No auth. Customer or driver. Also the way an OTP-only account gets its first password
without signing in.

1. `POST /auth/otp/request` `{ phone, principal, purpose: "PASSWORD_RESET" }`
2. User types the code and a new password, then:
```json
{ "phone": "+919812345678", "principal": "DRIVER",
  "code": "123456", "newPassword": "my-new-long-password" }
```
- Response `200`: the sign-in response above — the user is **signed in**.
- **All other sessions/devices are signed out.**
- `401 OTP_INVALID` / `OTP_ATTEMPTS_EXCEEDED` — wrong code.
- `401 INVALID_CREDENTIALS` — no account for this number and principal.

### 2.7 Set / change password (signed in) — `POST /auth/password`
Bearer token.
```json
{ "currentPassword": "old-long-password", "newPassword": "my-new-long-password" }
```
- `currentPassword` is **required only if `user.hasPassword` is true**. For an OTP-only
  account (first password) send just `newPassword`.
- Response `200`: `{ "hasPassword": true, "revokedSessions": 2 }` — every **other**
  session is signed out; this one keeps working.
- Wrong or missing current password → **`400 CURRENT_PASSWORD_INCORRECT`** (a 400, so it
  never triggers your token-refresh logic).

### 2.8 Account email — `GET /auth/me`, `PATCH /auth/me`
Bearer token.
- `GET /auth/me` → `{ user, roles, permissions }` (includes `hasPassword`).
- `PATCH /auth/me` `{ "email": "asha@example.com" }` adds/changes the email used for
  password sign-in; `{ "email": null }` removes it. Changing it resets `emailVerified`.
  Taken → `409 ACCOUNT_ALREADY_EXISTS` (`details.field = "email"`).

### Optional device metadata
Any sign-in call (`register`/`login`/`otp/verify`/`password/reset`) may include:
`deviceId`, `deviceName`, `platform` (`ANDROID|IOS|WEB|UNKNOWN`), `appVersion`.
Recommended so the user can see/manage their devices.

### 2.9 Refresh tokens — `POST /auth/refresh`
No bearer (the refresh token *is* the credential).
```json
{ "refreshToken": "…" }
```
- Response `200`: the sign-in response, with a **new** token pair. The old refresh
  token is rotated (invalidated) — always replace both with the new pair.
- Do this when an access token returns `401 TOKEN_EXPIRED`, then retry the call once.

### 2.10 Session management
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

### 3.4 Live tracking map — `GET /orders/:id/tracking`
Poll every ~20 s while the order is `ASSIGNED`, `EN_ROUTE`, `ARRIVED` or `DISPENSING`.
```
200 { tracking:{
  orderId, status,
  destination:{ latitude, longitude } | null,          // the delivery address pin
  tanker:{ latitude, longitude, updatedAt, stale } | null,
  route:{ source:"GOOGLE"|"STRAIGHT_LINE", distanceMeters,
          durationSeconds|null, polyline|null } | null } }
```
- `tanker` = the driver's phone position as last reported by the driver app. `null`
  until the driver reports one (or outside the statuses above). `stale:true` = older
  than 5 min: show "last updated …", not "live".
- `route` only while `ASSIGNED`/`EN_ROUTE` with a fresh position. `source:"GOOGLE"`:
  road route — draw `polyline` (Google encoded polyline, precision 5) and show
  `durationSeconds` as ETA. `source:"STRAIGHT_LINE"`: no road data (server key not
  set) — draw a dashed straight line, show distance only, no ETA.
- Numbers here are JSON numbers (coordinates), not strings.

### 3.5 Order object (`data.order`)
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

### 4.3 Nearby requests — pick up open orders (first driver wins)
Customer pay-on-delivery orders are open (`CONFIRMED`) until a driver accepts them.
Any driver with a tanker assigned can see open orders near their phone and accept one.
The **first** driver to accept gets it; the order then shows in `GET /driver/orders`
as `ASSIGNED`, and the delivery sequence (§4.6) continues as normal.

- `GET /driver/requests?latitude=<number>&longitude=<number>` — the phone's current
  GPS position (both required). Also saves it as the driver's last known location.
  → `200`
  ```
  { requests:[ { id, orderNumber, quantity, product:{name,code}|null, paymentMode,
                 amountToCollect (CASH_ON_DELIVERY only, else null),
                 area:{ landmark, city, pincode }, distanceKm, placedAt } ],
    radiusKm: 25,
    hasVehicle: boolean }
  ```
  Nearest first; only orders within `radiusKm` (straight line). **No customer name,
  phone or exact address** here — those come with the order after accepting.
  `hasVehicle:false` → the driver has no tanker assigned: show "Ask the admin to assign
  a tanker" instead of the list. Refresh the list every ~20 s while it is open (other
  drivers take orders), and on pull-to-refresh.
- `POST /driver/requests/:id/accept` — no body. `:id` is the request `id`.
  → `200 { order }` (driver order shape, §4.5 — now with customer + full address).
  Errors:
  - `409 ORDER_ALREADY_TAKEN` — another driver was faster. Remove it and refresh the list.
  - `409 INSUFFICIENT_FUEL` — this tanker doesn't have enough free fuel for the order.
  - `409 VEHICLE_NOT_ASSIGNED` — no tanker assigned to this driver.

  **Online only — do not queue `accept` in an offline outbox.** It is a race against
  other drivers; an accept replayed later is meaningless.

### 4.4 Location and route map
- `POST /driver/location` — body `{ "latitude": <number>, "longitude": <number> }` →
  `200`. Report the phone's position (every ~30 s while on a trip). This is what
  moves the tanker on the customer's map (§3.4).
- `GET /driver/orders/:id/route?latitude=<number>&longitude=<number>` — route from
  the phone's position to the order's delivery point. **Also records the position**
  (no separate `/driver/location` call needed while this screen polls).
  ```
  200 { orderId, status, destination:{latitude,longitude}|null,
        route:{ source:"GOOGLE"|"STRAIGHT_LINE", distanceMeters,
                durationSeconds|null, polyline|null } }
  ```
  Same `route` rules as §3.4. For turn-by-turn driving, hand off to the Google Maps
  app: `google.navigation:q=<lat>,<lng>&mode=d`.

> **Maps keys.** The apps use the Google Maps SDK for Android (map tiles) with an
> Android key restricted to the app package + signing SHA-1. Routes/ETA come from
> **our server** (Google Routes API with a server key) — never call Google's
> Directions/Routes web APIs from the app, and never put that server key in an APK.

### 4.5 Orders on the vehicle
- `GET /driver/orders?scope=ACTIVE|COMPLETED&limit=25` →
  `{ orders:[order], vehicleId }`.
  Driver order shape:
  `{ id, orderNumber, status, quantity, deliveredQuantity, product, paymentMode,
     amountToCollect (only for CASH_ON_DELIVERY, else null),
     customer:{fullName,phone}, address, deliveryInstructions, placedAt, statusChangedAt }`.
- `GET /driver/orders/:id` → `{ order, timeline[], reservation|null,
     readings:[{id,readingType,totalizer,capturedAt,hasPhoto}] }`.

### 4.6 The delivery sequence (call in order)
1. `POST /driver/orders/:id/start-trip` — → `EN_ROUTE`. No body.
2. `POST /driver/orders/:id/arrive` — body `{ "latitude"?, "longitude"? }` (numbers;
   a missing GPS fix is allowed) → `ARRIVED`.
   - **2a. Unlock the pump (IoT pump tankers)** — `POST /driver/orders/:id/iot-authorize`,
     no body. Call it after `arrive` (allowed when the order is `ARRIVED` or
     `DISPENSING`). The server asks the tanker's IoT pump controller to allow the
     order's litres and returns the MPIN the driver types on the pump device:
     ```
     200 { authorization:{ id, status:"AUTHORIZED", mpin:"123456",
                           iotTransactionId, authorizedLitres, deviceId, createdAt,
                           reused: boolean } }
     ```
     Show `mpin` large on screen. Calling it again is safe: it returns the **same**
     MPIN (`reused:true`) and does not unlock the pump a second time — use this to
     show the MPIN again after the app was closed. Online only (no outbox).
     Errors:
     - `409 IOT_DEVICE_NOT_CONFIGURED` — this tanker has no IoT pump. Tell the driver
       to skip this step.
     - `400 IOT_DISPENSE_NOT_ENABLED` — pump unlock is switched off on the server.
       Skip this step.
     - `503 IOT_AUTHORIZATION_FAILED` — pump service unreachable; let the driver retry.
     - `409 IOT_AUTHORIZATION_FAILED` — the pump service refused (`details.status`).
     - `409 INVALID_STATE_TRANSITION` — not arrived yet.
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
| `TOKEN_EXPIRED` | access token old | refresh (§2.9), retry once |
| `TOKEN_MISSING` / `TOKEN_INVALID` | bad/absent bearer | send to login |
| `WRONG_PRINCIPAL` | customer token on driver route (or vice-versa) | bug in app — fix the token used |
| `VALIDATION_ERROR` | bad request body/params | show per-field `error.details` |
| `OTP_INVALID` / `OTP_ATTEMPTS_EXCEEDED` | wrong/too many OTP | re-request |
| `OTP_RESEND_TOO_SOON` / `OTP_RATE_LIMITED` | 429 | wait `details.retryAfterSeconds` |
| `INVALID_CREDENTIALS` (401) | wrong mobile/email/password, no password set, or unknown account | show error; offer OTP sign-in / Forgot password — never refresh |
| `ACCOUNT_ALREADY_EXISTS` (409) | sign-up/email change; `details.field` = `phone` or `email` | phone → go to sign-in; email → change it |
| `CURRENT_PASSWORD_INCORRECT` (400) | change password with wrong current one | ask again |
| `ACCOUNT_BLOCKED` / `ACCOUNT_DELETED` (401) | account disabled | show message, stay on login |
| `PROFILE_NOT_FOUND` | customer has no profile | send to profile setup |
| `QUOTE_EXPIRED` (410) / `QUOTE_ALREADY_USED` | stale/used quote | get a fresh quote |
| `NO_ACTIVE_PRICE` / `NO_DELIVERY_CHARGE_RULE` / `BELOW_MINIMUM_ORDER_QUANTITY` | can't price | show reason, block checkout |
| `IDEMPOTENCY_KEY_REQUIRED` | placing order without the header | add `Idempotency-Key` |
| `DUPLICATE_ORDER` | likely double-tap | confirm, resend with `acknowledgeDuplicate:true` |
| `NO_VEHICLE_AVAILABLE` | no stock/tanker | tell user to try later |
| `ORDER_ALREADY_TAKEN` (409) | driver accept lost the race | remove from list, refresh nearby requests |
| `INSUFFICIENT_FUEL` (409) | driver's tanker lacks free fuel for that order | show message |
| `VEHICLE_NOT_ASSIGNED` (409) | driver accept with no tanker | ask admin to assign a tanker |
| `IOT_DEVICE_NOT_CONFIGURED` (409) / `IOT_DISPENSE_NOT_ENABLED` (400) | pump unlock not available for this tanker/server | skip the unlock step |
| `IOT_AUTHORIZATION_FAILED` (503/409) | pump service down or refused | show message, allow retry |
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
   Password sign-in is **not** affected by this bypass, but while it is on, anyone who
   knows a number can still get in via OTP or reset its password via `PASSWORD_RESET`.
2. **Never ship any third-party credential in the app.** The IoT vendor's code, SMS
   keys, etc. all live on our server. Your app only ever holds the user's own
   access/refresh tokens.
3. Store tokens in secure storage (Keychain / EncryptedSharedPreferences), not plain
   prefs.

---

*Questions or a missing endpoint (e.g. driver/customer-scoped live telemetry, push
notifications)? Send them over and we'll extend this backend — the app only ever needs
to talk to us.*
