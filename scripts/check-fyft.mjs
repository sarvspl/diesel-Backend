/**
 * FYFT connectivity smoke test — the FIRST real test.
 *
 * Authenticates with FYFT and reads one tanker's current stock, printing exactly
 * what came back. This proves auth + IP binding + connectivity + our parsing,
 * WITHOUT a driver, an order, or the delivery flow — so if it fails you know the
 * problem is the vendor link, not our code.
 *
 * MUST run on the server whose IP the vendor whitelisted (a dev box is blocked).
 *
 *   FYFT_SOURCE_CODE=your-code node scripts/check-fyft.mjs WB19V0441
 *
 * Read it TWICE a few seconds apart, ideally side by side with a real dispense,
 * to answer the one open question: does the stock figure change immediately when
 * fuel moves? If it lags, the whole stock-difference method needs a rethink.
 */
import { createDezel4uProvider } from '../src/infrastructure/providers/flow-meter/dezel4u-flow-meter-provider.js';
import { FlowMeterError } from '../src/infrastructure/providers/flow-meter/flow-meter-provider.js';

const sourceCode = process.env.FYFT_SOURCE_CODE;
const registration = process.argv[2];
const baseUrl = process.env.FYFT_BASE_URL ?? 'https://www.dezel4u.com/go_fyft';

if (!sourceCode) {
  console.error('Set FYFT_SOURCE_CODE=<your source code> in the environment.');
  process.exit(1);
}
if (!registration) {
  console.error('Usage: FYFT_SOURCE_CODE=... node scripts/check-fyft.mjs <REGISTRATION>');
  console.error('e.g.   FYFT_SOURCE_CODE=... node scripts/check-fyft.mjs WB19V0441');
  process.exit(1);
}

const provider = createDezel4uProvider({ sourceCode, baseUrl });

try {
  console.log(`\nReading ${registration} from ${baseUrl} …\n`);
  const reading = await provider.read({ registration });

  console.log('  OK — FYFT responded and we parsed it:');
  console.log(`    stock            : ${reading.stockLitres} L`);
  console.log(`    location         : ${reading.location ? `${reading.location.latitude}, ${reading.location.longitude}` : '—'}`);
  console.log(`    movement         : ${reading.movementStatus ?? '—'}`);
  console.log(`    measurement model: ${reading.measurement}`);
  console.log(`    read at (ours)   : ${reading.capturedAt.toISOString()}`);
  console.log(`\n  raw vendor payload:\n    ${JSON.stringify(reading.raw)}\n`);
  console.log('  Now run this again in a few seconds — the stock should reflect any dispense in between.\n');
} catch (error) {
  if (error instanceof FlowMeterError) {
    console.error(`\n  FYFT read FAILED — ${error.code}: ${error.message}`);
    console.error(`  detail: ${JSON.stringify(error.detail)}`);
    console.error('\n  Likely causes:');
    console.error('    AUTH_FAILED       → wrong source code, or this server\'s IP is not whitelisted.');
    console.error('    DEVICE_OFFLINE    → the tanker\'s monitor is unreachable right now.');
    console.error('    VEHICLE_NOT_FOUND → no FYFT device mapped to that registration.\n');
  } else {
    console.error('\n  Unexpected error:', error);
  }
  process.exitCode = 1;
}
