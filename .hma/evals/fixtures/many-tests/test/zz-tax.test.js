import assert from "node:assert/strict";
import { test } from "node:test";
import { withTax } from "../src/price.js";

test("10% の税込み価格", () => assert.equal(withTax(1000, 0.1), 1100));
