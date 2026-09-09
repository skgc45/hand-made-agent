import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCoupon, checkout, subtotal, withTax } from "./cart.js";

const items = [
  { name: "書籍", price: 1200, quantity: 2 },
  { name: "ペン", price: 150, quantity: 3 },
];

test("subtotal は数量を掛けて合計する", () => {
  assert.equal(subtotal(items), 2850);
});

test("subtotal は空配列で 0", () => {
  assert.equal(subtotal([]), 0);
});

test("percent クーポンは割合で引く", () => {
  assert.equal(applyCoupon(1000, { type: "percent", value: 0.1 }), 900);
});

test("fixed クーポンは金額で引く", () => {
  assert.equal(applyCoupon(1000, { type: "fixed", value: 300 }), 700);
});

test("クーポンで負の金額にはならない", () => {
  assert.equal(applyCoupon(200, { type: "fixed", value: 500 }), 0);
});

test("percent クーポンの割引上限は 50%", () => {
  assert.equal(applyCoupon(1000, { type: "percent", value: 0.8 }), 500);
});

test("withTax は四捨五入する", () => {
  assert.equal(withTax(2850, 0.1), 3135);
});

test("checkout は小計→クーポン→税の順", () => {
  assert.equal(checkout(items, { type: "fixed", value: 350 }, 0.1), 2750);
});
