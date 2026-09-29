# Diesel For You — API Quick Start (Mobile Apps)

The short version: how to sign in, stay signed in, and make the main calls.
For every field and error, see [API-FOR-APP-DEVELOPER.md](API-FOR-APP-DEVELOPER.md).

**Base URL:** `https://diesel.sarstage.online/api/v1`

---

## 1. Basics

**Every request**
```
Content-Type: application/json
Authorization: Bearer <accessToken>     ← all calls except sign-in / refresh
```

**Every response**
```json
{ "success": true,  "message": "...", "data": { ... } }
{ "success": false, "message": "...", "error": { "code": "OTP_INVALID", "details": [] } }
```
- Read the payload from `data`.
- On failure, check `error.code` (never the message text).

**Rules**
- Phone numbers: Indian mobile in `+91XXXXXXXXXX` form, e.g. `+919876543210`.
- Money, litres and GPS values are **strings** (`"2500.00"`, `"500"`). Don't convert them to numbers.
- Keep tokens in secure storage (Keychain / EncryptedSharedPreferences).

---

## 2. Sign in (OTP) — both apps

Sign-in is two calls: send the OTP, then check it.

| App | `principal` | `purpose` | Notes |
|---|---|---|---|
| Customer | `CUSTOMER` | `SIGNUP` | Works for new **and** existing customers: signs in an existing account, creates a new one. |
| Driver | `DRIVER` | `LOGIN` | The admin must create the driver account first. An unknown number gets `INVALID_CREDENTIALS`. |

### Step 1 — Send the OTP
`POST /auth/otp/request`
```json
{ "phone": "+919876543210", "principal": "CUSTOMER", "purpose": "SIGNUP" }
```
Response `202`:
```json
{ "success": true, "data": { "challengeId": "…", "expiresAt": "…", "retryAfterSeconds": 30 } }
```
- Show a "Resend" button only after `retryAfterSeconds`.
- On the test server the response also has `devCode` (the OTP), to make testing easier. **Don't build on it** — in the real app the user types the code from the SMS.

### Step 2 — Check the OTP → get tokens
`POST /auth/otp/verify`
```json
{
  "phone": "+919876543210",
  "principal": "CUSTOMER",
  "purpose": "SIGNUP",
  "code": "123456",
  "deviceName": "Pixel 7", "platform": "ANDROID", "appVersion": "1.0.0"
}
```
(`deviceId`, `deviceName`, `platform` = `ANDROID|IOS|WEB|UNKNOWN`, and `appVersion` are optional but recommended.)

Response `200`:
```json
{
  "success": true,
  "data": {
    "user": { "id": "…", "principal": "CUSTOMER", "phone": "+919876543210", "status": "ACTIVE" },
    "roles": ["…"],
    "permissions": ["…"],
    "tokens": { "accessToken": "…", "refreshToken": "…" }
  }
}
```
Save both tokens. The user is now signed in.

**Errors to handle**
| `error.code` | Show / do |
|---|---|
| `OTP_INVALID` | "Wrong or expired code" |
| `OTP_ATTEMPTS_EXCEEDED` | Ask for a new code |
| `OTP_RESEND_TOO_SOON`, `OTP_RATE_LIMITED` (429) | Wait `error.details.retryAfterSeconds` |
| `INVALID_CREDENTIALS` | Driver app: "This number is not registered as a driver" |
| `VALIDATION_ERROR` | Bad phone format etc. — see `error.details` |
| `CORPORATE_VERIFICATION_PENDING` (403) | Company still under review — see §2.3 |
| `CORPORATE_ACCOUNT_SUSPENDED` / `CORPORATE_ACCOUNT_INACTIVE` (403) | "Company account blocked, contact support" |

---

## 2.3 Customer sign up (new user)

There is **no separate sign-up call and no password**. A new customer signs up with the same OTP calls as sign-in (§2), using `purpose: "SIGNUP"`. Their account is created the first time the OTP check succeeds.

```
Phone screen ─► POST /auth/otp/request   (purpose SIGNUP)
OTP screen   ─► POST /auth/otp/verify    (purpose SIGNUP)  → tokens, account exists now
             ─► GET  /customers/me
                   ├─ 200                → existing customer → Home
                   └─ 404 PROFILE_NOT_FOUND → new customer ↓
Profile screen ─► POST /customers/register → Home
      (optional) Company? ─► POST /corporate/register → "Under review" screen
```

### Step 3 — Create the profile (new customers only)
`POST /customers/register` (CUSTOMER token)
```json
{
  "fullName": "Ravi Kumar",
  "preferredLanguage": "en",
  "marketingOptIn": false,
  "notifyByPush": true, "notifyBySms": true, "notifyByEmail": false
}
```
- All fields are optional; `fullName` is the one worth asking for.
- `emergencyContactName` / `emergencyContactPhone` (`+91…`) are optional extras.
- Leave `marketingOptIn` unticked by default. It must be the user's own choice.
- Response `201` → `data.profile`. Calling it again → `409 PROFILE_ALREADY_EXISTS` (treat that as "done").
- Later edits go through `PATCH /customers/me`.

### Step 4 (optional) — Register a company
For business customers who order on the company's account.
`POST /corporate/register` (CUSTOMER token)
```json
{
  "legalName": "Acme Logistics Pvt Ltd",
  "displayName": "Acme Logistics",
  "registrationIdType": "GSTIN",
  "registrationNumber": "19ABCDE1234F1Z5",
  "gstin": "19ABCDE1234F1Z5",
  "pan": "ABCDE1234F",
  "billingLine1": "…", "billingCity": "Kolkata", "billingState": "West Bengal", "billingPincode": "700001",
  "contactEmail": "accounts@acme.in", "contactPhone": "+919876543210"
}
```
- **Required:** `legalName`, `registrationIdType` (`CIN` | `GSTIN` | `PAN` | `UDYAM` | `OTHER`), `registrationNumber`. The rest are optional.
- The company starts as **PENDING** until an admin approves it. **While it is pending, this user cannot sign in or refresh.** `otp/verify` and `refresh` return `403 CORPORATE_VERIFICATION_PENDING`, so show an "Under review" screen.
- **Rejected:** the user can sign in again but can't order. They fix the details and re-apply with `POST /corporate/me/resubmit` (same body).
- **Approved:** sign-in and ordering work normally. `GET /corporate/me` shows the company.
- Already registered → `409 CORPORATE_ALREADY_REGISTERED`.

---

## 3. Stay signed in (refresh)

Access tokens are short-lived. When any call returns **401 `TOKEN_EXPIRED`**:

`POST /auth/refresh` (no `Authorization` header)
```json
{ "refreshToken": "…" }
```
- The response looks the same as verify and includes a **new** `accessToken` + `refreshToken`. **Replace both.** The old refresh token stops working.
- Then retry the original call **once**.
- If the refresh itself fails, clear the tokens and go to the sign-in screen.
- `TOKEN_MISSING` / `TOKEN_INVALID` → go straight to sign-in.

**Tip:** run only one refresh at a time. If several calls fail together, make them all wait for the same refresh, because a used refresh token can't be sent a second time.

---

## 4. Sign out & account

| Call | What it does |
|---|---|
| `GET /auth/me` | Current user, roles, permissions |
| `POST /auth/logout` | Sign out this device (send the bearer), then delete local tokens |
| `POST /auth/logout-all` | Sign out every device |
| `GET /auth/sessions` | List signed-in devices |
| `DELETE /auth/sessions/:id` | Sign out one device |

---

## 5. Customer app — main calls

All of these need a **CUSTOMER** token.

**Profile** — `GET /customers/me`, `PATCH /customers/me` (send only the changed fields). New users: see §2.3.

**Addresses**
- `GET /customers/addresses`
- `POST /customers/addresses`
  ```json
  { "line1": "12 MG Road", "city": "Kolkata", "state": "West Bengal", "pincode": "700001",
    "latitude": "22.5726", "longitude": "88.3639", "nickname": "Site A" }
  ```
  If the response has `isServiceable: false`, we don't deliver there yet.
- `PATCH /customers/addresses/:id`, `DELETE /customers/addresses/:id`

**Order diesel** (in this order)
1. `GET /products` — get the product `id` (don't hardcode it).
2. `POST /quotes` `{ "addressId": "…", "productId": "…", "quantity": "500" }`
   → `data.quote` with `totalAmount` and `expiresAt`. Show the price to the user.
3. `POST /orders` with header **`Idempotency-Key: <new uuid>`**
   ```json
   { "quoteId": "…", "paymentMode": "CASH_ON_DELIVERY" }
   ```
   - If the network drops, retry with the **same** key; this prevents a double order.
   - `QUOTE_EXPIRED` → get a new quote (step 2).
   - `DUPLICATE_ORDER` → ask "Place again?" and resend with `"acknowledgeDuplicate": true`.

**Track orders**
- `GET /orders?limit=20&cursor=…` — list. Filter with `?status=ASSIGNED,EN_ROUTE`.
- `GET /orders/:id` — details.
- `GET /orders/:id/history` — status timeline.
- `POST /orders/:id/cancel` `{ "reason": "…" }` — works only until the tanker leaves (`ASSIGNED` or earlier).

Order status flow: `CONFIRMED → ASSIGNED → EN_ROUTE → ARRIVED → DISPENSING → DELIVERED`

---

## 6. Driver app — main calls

All of these need a **DRIVER** token. You never send a driver id; the token says which driver it is.

**On app open:** `GET /driver/me` returns the driver, vehicle, current shift and `blockers`.
If `blockers` is not empty (expired licence, no vehicle…), show them and disable "Go online".

**Shift**
- `POST /driver/shifts/start` `{ "vehicleId": "…", "openingTotalizer": "12345.6" }`
- `PATCH /driver/availability` `{ "availability": "ONLINE" }` (`ONLINE` | `BREAK` | `OFFLINE`)
- `POST /driver/shifts/end` `{ "closingTotalizer": "12845.6" }`

**Jobs**
- `GET /driver/orders?scope=ACTIVE` (or `COMPLETED`)
- `GET /driver/orders/:id`

**Delivery** (call in order)
1. `POST /driver/orders/:id/start-trip` → EN_ROUTE
2. `POST /driver/orders/:id/arrive` `{ "latitude": 22.57, "longitude": 88.36 }` → ARRIVED
3. `POST /driver/orders/:id/start-dispensing` → DISPENSING
   ```json
   { "receiverVerification": { "method": "OTP", "code": "1234" },
     "openingTotalizer": "…", "photoKey": "…" }
   ```
4. `POST /driver/orders/:id/complete` → DELIVERED
   ```json
   { "clientDeliveryId": "<uuid, reuse on retry>", "outcome": "FULL",
     "closingTotalizer": "…", "photoKey": "…" }
   ```
   `outcome`: `FULL` | `PARTIAL` | `FAILED` (send `reasonCode` when it isn't `FULL`).

**Tankers with an IoT meter:** leave the reading and `photoKey` fields out. The server reads the meter itself.
Only if it replies **503 `METER_DEVICE_UNAVAILABLE`** should you show manual entry and resend with the reading + photo.

---

## 7. Test with curl

```bash
BASE=https://diesel.sarstage.online/api/v1

curl -X POST $BASE/auth/otp/request -H "Content-Type: application/json" \
  -d '{"phone":"+919876543210","principal":"CUSTOMER","purpose":"SIGNUP"}'

curl -X POST $BASE/auth/otp/verify -H "Content-Type: application/json" \
  -d '{"phone":"+919876543210","principal":"CUSTOMER","purpose":"SIGNUP","code":"<otp>"}'

curl $BASE/auth/me -H "Authorization: Bearer <accessToken>"
```
