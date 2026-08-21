/**
 * STANDALONE FYFT connectivity test — depends on NOTHING in this codebase.
 *
 * Copy this one file to the server (the box whose IP the vendor whitelisted),
 * and run it with plain Node — no npm install, no build, no deploy. It logs in
 * to FYFT and reads one tanker's current stock, so you can confirm the vendor
 * link works before any of the app code goes near the server.
 *
 *   FYFT_SOURCE_CODE=your-code node fyft-standalone.mjs WB19V0441
 *
 * Needs Node 18+ (for global fetch). Run it TWICE a few seconds apart, ideally
 * during a real dispense, to see whether the stock number changes immediately.
 */
const sourceCode = process.env.FYFT_SOURCE_CODE;
const registration = process.argv[2];
const base = process.env.FYFT_BASE_URL ?? 'https://www.dezel4u.com/go_fyft';

if (!sourceCode || !registration) {
  console.error('Usage:  FYFT_SOURCE_CODE=your-code node fyft-standalone.mjs <REGISTRATION>');
  console.error('  e.g.  FYFT_SOURCE_CODE=abc123  node fyft-standalone.mjs WB19V0441');
  process.exit(1);
}

const form = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

async function main() {
  // 1. Authenticate.
  console.log(`\n[1/2] Authenticating with ${base} …`);
  const authRes = await fetch(`${base}/fetch_jwt.php`, {
    method: 'POST',
    headers: { 'Content-type': 'application/x-www-form-urlencoded' },
    body: form({ source_code: sourceCode }),
  });
  const auth = await authRes.json().catch(() => null);

  if (auth?.result !== true || !auth?.token) {
    console.error(`  AUTH FAILED (HTTP ${authRes.status}): ${auth?.msg ?? JSON.stringify(auth)}`);
    console.error('  → wrong source code, or THIS server\'s IP is not whitelisted by the vendor.');
    process.exit(1);
  }
  console.log('  OK — token received.');

  // 2. Read the tanker's stock.
  console.log(`\n[2/2] Reading stock for ${registration} …`);
  const stockRes = await fetch(`${base}/check_bowstock.php`, {
    method: 'POST',
    headers: {
      'Content-type': 'application/x-www-form-urlencoded',
      Authentication: sourceCode,
      'X-Verify': auth.token,
    },
    body: form({ vehicle: registration }),
  });
  const stock = await stockRes.json().catch(() => null);

  console.log(`  raw response: ${JSON.stringify(stock)}`);

  if (stock?.result === true) {
    console.log('\n  ✅ SUCCESS — FYFT is reachable and returns stock.');
    console.log(`     stock    : ${stock.stock}`);
    console.log(`     location : ${stock.latitude}, ${stock.longitude}`);
    console.log(`     movement : ${stock.movement_status}`);
    console.log('\n  Run this again in a few seconds (ideally during a dispense) — the stock');
    console.log('  should change immediately if fuel is moving.\n');
  } else {
    console.error(`\n  ❌ READ FAILED (HTTP ${stockRes.status}): ${stock?.msg ?? JSON.stringify(stock)}`);
    console.error('  → common causes: token/source rejected, unknown registration, or device offline.\n');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n  Unexpected error:', e.message);
  process.exit(1);
});
