import * as customerAdminRepository from '../../customer/repositories/customer-admin.repository.js';
import * as pricingRepository from '../repositories/pricing.repository.js';

/**
 * Can the places our customers actually are be priced?
 *
 * WHY THIS IS NOT "IS ANYTHING CONFIGURED?"
 * -----------------------------------------
 * A deployment can hold an active price, an active delivery rule, and a
 * perfectly green Pricing screen, and still refuse every single order — because
 * the price says "Kolkata" and the addresses customers saved say
 * "Chakpachuria". Nothing in the panel could see that: it counted rows rather
 * than checking whether any of them MATCH.
 *
 * So this resolves each real service area exactly the way a quote does, and
 * reports the ones that would fail. It is the difference between "you have
 * prices" and "your customers can buy".
 */

/**
 * Delivery coverage, ignoring quantity bands.
 *
 * A rule scoped to the right place but banded to 1000 L and above still counts
 * as coverage here: that is a deliberate pricing decision, not a
 * misconfiguration, and flagging it would train operators to ignore this list.
 * Only the absence of ANY rule for the area is reported.
 */
const resolveScoped = (rules, { city, pincode }) =>
  (pincode ? rules.find((rule) => rule.pincode === pincode) : undefined) ??
  (city ? rules.find((rule) => rule.pincode === null && rule.city === city) : undefined) ??
  rules.find((rule) => rule.pincode === null && rule.city === null) ??
  null;

export const getCoverage = async () => {
  const [areas, products, deliveryRules] = await Promise.all([
    customerAdminRepository.listServiceAreas(),
    pricingRepository.listProducts({ includeArchived: false }),
    pricingRepository.listDeliveryRules({ status: 'ACTIVE' }),
  ]);

  const active = products.filter((product) => product.status === 'ACTIVE');

  const resolved = await Promise.all(
    areas.map(async (area) => {
      // Every active product must be priced for the area, otherwise a customer
      // there can order some of the catalogue and not the rest.
      const prices = await Promise.all(
        active.map((product) =>
          pricingRepository
            .findActivePrice({ productId: product.id, city: area.city, pincode: area.pincode })
            .then((price) => ({ product, price }))
        )
      );

      const unpriced = prices.filter((entry) => entry.price === null).map((e) => e.product.code);

      return {
        city: area.city,
        pincode: area.pincode,
        addressCount: area.addressCount,
        unpricedProducts: unpriced,
        hasPrice: unpriced.length === 0,
        hasDeliveryRule: resolveScoped(deliveryRules, area) !== null,
      };
    })
  );

  // Broken areas first, then by how many customers they affect: this list is
  // read to find work, not to admire the coverage.
  const ordered = resolved.sort((a, b) => {
    const aOk = a.hasPrice && a.hasDeliveryRule;
    const bOk = b.hasPrice && b.hasDeliveryRule;
    if (aOk !== bOk) return aOk ? 1 : -1;
    return b.addressCount - a.addressCount;
  });

  return {
    areas: ordered,
    summary: {
      total: ordered.length,
      uncovered: ordered.filter((area) => !area.hasPrice || !area.hasDeliveryRule).length,
    },
  };
};
