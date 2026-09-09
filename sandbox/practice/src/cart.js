export function subtotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  return total;
}

export function applyCoupon(amount, coupon) {
  if (!coupon) return amount;
  if (coupon.type === "percent") {
    const rate = Math.min(coupon.value, 0.5);
    return Math.max(0, amount - amount * rate);
  }
  return Math.max(0, amount - coupon.value);
}

export function withTax(amount, rate) {
  return Math.round(amount * (1 + rate));
}

export function checkout(items, coupon, rate) {
  return withTax(applyCoupon(subtotal(items), coupon), rate);
}
