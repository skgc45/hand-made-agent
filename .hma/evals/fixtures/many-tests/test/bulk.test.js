import assert from "node:assert/strict";
import { test } from "node:test";
import { round } from "../src/price.js";

for (let i = 0; i < 400; i++) {
  test(`round ${i}`, () => assert.equal(round(i + 0.004, 2), i));
}
