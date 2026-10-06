import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fisherExact, mannWhitney } from "../src/eval/stats.js";

describe("mannWhitney", () => {
  it("同じ分布なら p は大きい", () => {
    assert.ok(mannWhitney([1, 3, 5, 7, 9], [2, 4, 6, 8, 10]).p > 0.5);
  });

  it("9回ずつ完全に分かれれば 0.05 を下回る", () => {
    const low = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const high = [11, 12, 13, 14, 15, 16, 17, 18, 19];
    const { p, u } = mannWhitney(low, high);
    assert.equal(u, 0);
    assert.ok(p < 0.001);
  });

  it("3回ずつでは完全に分かれても 0.05 に届かない", () => {
    assert.ok(mannWhitney([1, 2, 3], [4, 5, 6]).p > 0.05);
  });

  it("全部同じ値なら p = 1", () => {
    assert.equal(mannWhitney([5, 5, 5], [5, 5, 5]).p, 1);
  });

  it("外れ値の大きさには引きずられない", () => {
    const a = [10, 11, 12, 13, 14, 15, 16, 17, 18];
    const b = [20, 21, 22, 23, 24, 25, 26, 27, 1000];
    const c = [20, 21, 22, 23, 24, 25, 26, 27, 28];
    assert.equal(mannWhitney(a, b).p, mannWhitney(a, c).p);
  });
});

describe("fisherExact", () => {
  it("既知の値と合う", () => {
    assert.ok(Math.abs(fisherExact(9, 9, 0, 9) - 2 / 48620) < 1e-9);
    assert.ok(Math.abs(fisherExact(3, 3, 0, 3) - 0.1) < 1e-9);
    assert.ok(Math.abs(fisherExact(0, 9, 5, 9) - 5 / 170) < 1e-9);
  });

  it("同じ割合なら 1", () => {
    assert.equal(fisherExact(2, 9, 2, 9), 1);
  });
});
