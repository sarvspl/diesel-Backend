/**
 * Seed the pricing rules the CUSTOMER path needs.
 *
 * `seed-operations.js` writes orders straight into the database, so it never
 * needed these. The customer app goes through `POST /quotes`, which cannot
 * produce a single quote without:
 *
 *   - a DeliveryChargeRule covering the city and quantity band, else
 *     NO_DELIVERY_CHARGE_RULE;
 *   - TaxRule rows, else every line falls back to the EXEMPT regime.
 *
 * Idempotent: safe to run repeatedly.
 *
 *   node scripts/seed-pricing.js
 */
import { prisma } from '../src/infrastructure/database/prisma.js';

const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000);

/**
 * The standard HSN for High Speed Diesel. Required on every invoice line for
 * goods (BR-706), and a published code rather than anything invented here.
 */
const HSD_HSN = '27101944';

/** SAC for goods transport by road. Used on the delivery line. */
const DELIVERY_SAC = '996511';

async function main() {
  const admin = await prisma.user.findFirst({
    where: { principal: 'ADMIN' },
    select: { id: true },
  });

  if (!admin) throw new Error('No ADMIN user. Run `npm run create:admin` first.');

  const product = await prisma.fuelProduct.findUnique({
    where: { code: 'HSD' },
    select: { id: true, hsnCode: true },
  });

  if (!product) throw new Error('No HSD product. Run `npm run seed:operations` first.');

  if (!product.hsnCode) {
    await prisma.fuelProduct.update({
      where: { id: product.id },
      data: { hsnCode: HSD_HSN, updatedByUserId: admin.id },
    });
    console.log(`  set HSN ${HSD_HSN} on HSD`);
  }

  // --- Delivery charge -------------------------------------------------------
  //
  // Flat ₹250 per delivery, tax-EXCLUSIVE: GST is added on top by the tax
  // engine (BR-705). Adding it here as well would double-count it.
  //
  // `minimumOrderQuantity` 100 L is what makes a 20 L order refuse with
  // BELOW_MINIMUM_ORDER_QUANTITY rather than dispatching a tanker at a loss.
  const existingDelivery = await prisma.deliveryChargeRule.findFirst({
    where: { city: 'Pune', status: 'ACTIVE' },
    select: { id: true },
  });

  if (existingDelivery) {
    console.log('  delivery rule for Pune already present');
  } else {
    await prisma.deliveryChargeRule.create({
      data: {
        name: 'Pune flat delivery',
        chargeType: 'FLAT',
        city: 'Pune',
        flatCharge: '250.00',
        minQuantity: '0',
        maxQuantity: null,
        minimumOrderQuantity: '100.000',
        // Free above ₹50,000 of fuel — roughly a 530 L order at today's rate.
        freeAboveOrderValue: '50000.00',
        sacCode: DELIVERY_SAC,
        priority: 100,
        effectiveFrom: day(-1),
        createdByUserId: admin.id,
        updatedByUserId: admin.id,
      },
    });
    console.log('  created delivery rule: Pune, flat ₹250, minimum 100 L');
  }

  // --- Tax rules -------------------------------------------------------------
  //
  // TWO REGIMES ON ONE DOCUMENT (BR-703):
  //
  //   FUEL      outside GST. Excise and state VAT are already INSIDE the
  //             per-litre rate, so the rule is inclusive and never adds to the
  //             total.
  //   DELIVERY  inside GST at 18%, split CGST 9% + SGST 9% for an intra-state
  //             supply, and EXCLUSIVE — added on top of ₹250.
  //
  // The two 9% components are deliberate rather than one 18% rule: a GST
  // invoice must show CGST and SGST separately, and the engine takes each
  // share of the same base so they sum to exactly 18%.
  const taxRules = [
    {
      code: 'HSD_VAT_EXCISE_MH',
      name: 'Excise and VAT (included in the pump rate)',
      regime: 'VAT_EXCISE',
      appliesTo: 'FUEL',
      calculationType: 'PERCENTAGE',
      /**
       * ZERO, DELIBERATELY, AND THIS NEEDS A BUSINESS DECISION BEFORE
       * PRODUCTION.
       *
       * Diesel genuinely carries central excise (a per-litre duty) and state
       * VAT (a percentage), and both are already inside the ₹94.20 rate. This
       * rule declares the REGIME so the invoice can say "excise and VAT
       * included in the rate" truthfully, without this seed inventing rates
       * that belong to the finance team.
       *
       * Because it is inclusive, a real rate here changes NO total — it only
       * splits out how much duty was already inside the price, which is what
       * an accurate invoice needs. Set the real excise (PER_UNIT) and the
       * Maharashtra VAT percentage before going live.
       */
      rate: '0.0000',
      isInclusive: true,
      state: 'Maharashtra',
      sequence: 1,
      effectiveFrom: day(-1),
    },
    {
      code: 'DELIVERY_CGST_9',
      name: 'CGST',
      regime: 'GST',
      appliesTo: 'DELIVERY',
      calculationType: 'PERCENTAGE',
      rate: '9.0000',
      isInclusive: false,
      state: null,
      sacCode: DELIVERY_SAC,
      sequence: 1,
      effectiveFrom: day(-1),
    },
    {
      code: 'DELIVERY_SGST_9',
      name: 'SGST',
      regime: 'GST',
      appliesTo: 'DELIVERY',
      calculationType: 'PERCENTAGE',
      rate: '9.0000',
      isInclusive: false,
      state: null,
      sacCode: DELIVERY_SAC,
      sequence: 2,
      effectiveFrom: day(-1),
    },
  ];

  for (const rule of taxRules) {
    const existing = await prisma.taxRule.findUnique({
      where: { code: rule.code },
      select: { id: true },
    });

    if (existing) {
      console.log(`  tax rule ${rule.code} already present`);
      continue;
    }

    await prisma.taxRule.create({
      data: { ...rule, createdByUserId: admin.id, updatedByUserId: admin.id },
    });
    console.log(`  created tax rule ${rule.code} (${rule.rate}%)`);
  }

  console.log('\nPricing rules ready. A 200 L Pune order should now quote as:');
  console.log('  fuel      200 x 94.20 = 18,840.00   (excise and VAT in the rate)');
  console.log('  delivery  250 + 45.00 =    295.00   (CGST 9% + SGST 9%)');
  console.log('  total                   19,135.00');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
