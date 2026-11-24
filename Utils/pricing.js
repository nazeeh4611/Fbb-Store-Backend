// Single source of truth for prices and order totals.
// The cart, checkout summary and order creation all use these helpers so the
// amount shown to the shopper is exactly the amount charged.

export const TAX_RATE = 0.18;

const isDiscountActive = (discount, now = new Date()) => {
  if (!discount) return false;
  const { percentage = 0, amount = 0, startDate, endDate } = discount;
  if (!(percentage > 0) && !(amount > 0)) return false;
  if (startDate && new Date(startDate) > now) return false;
  if (endDate && new Date(endDate) < now) return false;
  return true;
};

/** Effective INR unit price after any active discount. */
export const getUnitPriceINR = (product) => {
  const base = Number(product?.priceINR) || 0;
  if (!isDiscountActive(product?.discount)) return base;
  const { percentage = 0, amount = 0 } = product.discount;
  let price = base;
  if (percentage > 0) price = base * (1 - percentage / 100);
  else if (amount > 0) price = base - amount;
  return Math.max(0, Math.round(price)); // whole rupees
};

/** Shipping for one cart line (charged once per line, not per unit). */
export const getLineShipping = (product) => {
  if (!product?.shippingInfo) return 0;
  if (product.shippingInfo.freeShipping) return 0;
  return Number(product.shippingInfo.shippingCost) || 0;
};

export const computeTax = (subtotal) => Math.round(subtotal * TAX_RATE);

/**
 * Totals for a list of { product, quantity } lines where product is a
 * populated product document.
 */
export const computeTotals = (lines) => {
  let subtotal = 0;
  let shipping = 0;
  let items = 0;
  for (const line of lines) {
    if (!line.product) continue;
    subtotal += getUnitPriceINR(line.product) * line.quantity;
    shipping += getLineShipping(line.product);
    items += line.quantity;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const tax = computeTax(subtotal);
  const total = Math.round((subtotal + shipping + tax) * 100) / 100;
  return { items, subtotal, shipping, tax, total };
};
