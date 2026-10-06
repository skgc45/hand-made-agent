export function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function withTax(price, rate) {
  return round(price * rate, 0);
}
