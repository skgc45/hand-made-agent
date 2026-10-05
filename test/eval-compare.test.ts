import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareSplit,
  type EvalRecord,
  median,
  score,
  verdict,
} from "../src/eval/compare.js";

function record(
  train: number[],
  test: number[],
  passed: boolean[] = [],
): EvalRecord {
  const runs = (tokens: number[]) =>
    tokens.map((promptTokens, i) => ({
      passed: passed[i] ?? true,
      promptTokens,
    }));
  return {
    model: "m",
    createdAt: "",
    cases: [
      { name: "a", split: "train", runs: runs(train) },
      { name: "b", split: "test", runs: runs(test) },
      { name: "c", runs: runs([999]) },
    ],
  };
}

describe("median", () => {
  it("奇数個は真ん中", () => assert.equal(median([3, 1, 2]), 2));
  it("偶数個は真ん中2つの平均", () => assert.equal(median([1, 2, 3, 4]), 2.5));
});

describe("score", () => {
  it("split の無いケースは数えない", () => {
    assert.deepEqual(score(record([10, 30, 20], [5]), "train"), {
      passed: 3,
      total: 3,
      tokens: 20,
    });
  });
});

describe("compareSplit", () => {
  it("合格率が上がれば、トークンが増えても良くなった", () => {
    assert.equal(
      compareSplit(
        record([100, 100, 100], [1], [false, false, true]),
        record([200, 200, 200], [1]),
        "train",
      ),
      "良くなった",
    );
  });

  it("範囲が重ならないときだけ良くなった", () => {
    const before = record([90, 100, 110], [1]);
    assert.equal(
      compareSplit(before, record([70, 80, 85], [1]), "train"),
      "良くなった",
    );
    assert.equal(
      compareSplit(before, record([70, 80, 95], [1]), "train"),
      "揺れの範囲内",
    );
  });

  it("範囲が重ならずに増えれば悪くなった", () => {
    assert.equal(
      compareSplit(
        record([90, 100, 110], [1]),
        record([120, 125, 130], [1]),
        "train",
      ),
      "悪くなった",
    );
  });

  it("まとまった側を基準にしても、重なっていれば揺れの範囲内", () => {
    const tight = record([15322, 18621, 19534], [1]);
    const loose = record([15709, 25061, 31951], [1]);
    assert.equal(compareSplit(tight, loose, "train"), "揺れの範囲内");
    assert.equal(compareSplit(loose, tight, "train"), "揺れの範囲内");
  });

  it("良くなったケースと悪くなったケースが混ざれば揺れの範囲内", () => {
    const two = (a: number[], b: number[]): EvalRecord => ({
      model: "m",
      createdAt: "",
      cases: [
        {
          name: "x",
          split: "train",
          runs: a.map((promptTokens) => ({ passed: true, promptTokens })),
        },
        {
          name: "y",
          split: "train",
          runs: b.map((promptTokens) => ({ passed: true, promptTokens })),
        },
      ],
    });
    assert.equal(
      compareSplit(two([100], [100]), two([50], [150]), "train"),
      "揺れの範囲内",
    );
  });
});

describe("verdict", () => {
  it("train も test も良くなれば採用", () => {
    assert.equal(verdict(record([100], [100]), record([90], [90])), "採用");
  });

  it("train だけ良くなれば過学習の疑い", () => {
    assert.equal(
      verdict(record([100], [100]), record([90], [100])),
      "過学習の疑い",
    );
  });

  it("train が揺れの範囲内なら揺れの範囲内", () => {
    assert.equal(
      verdict(record([90, 100, 110], [100]), record([95, 100, 105], [50])),
      "揺れの範囲内",
    );
  });

  it("train が良くなって test が悪くなれば過学習の疑い", () => {
    assert.equal(
      verdict(record([100], [100]), record([90], [110])),
      "過学習の疑い",
    );
  });

  it("合格率が下がれば、トークンが減っても戻す", () => {
    assert.equal(
      verdict(
        record([100, 100, 100], [100]),
        record([50, 50, 50], [50], [false, true, true]),
      ),
      "戻す",
    );
  });

  it("お題の顔ぶれが違えば比べられない", () => {
    const before = record([100], [100]);
    const after = record([90], [90]);
    after.cases.push({
      name: "d",
      split: "train",
      runs: [{ passed: false, promptTokens: 1 }],
    });
    assert.equal(verdict(before, after), "比べられない");
  });

  it("train が悪くなれば戻す", () => {
    assert.equal(verdict(record([100], [100]), record([110], [90])), "戻す");
  });

  it("train か test が無ければ比べられない", () => {
    const noTest: EvalRecord = {
      model: "m",
      createdAt: "",
      cases: [
        {
          name: "a",
          split: "train",
          runs: [{ passed: true, promptTokens: 1 }],
        },
      ],
    };
    assert.equal(verdict(noTest, noTest), "比べられない");
  });
});
