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
        "range",
      ),
      "良くなった",
    );
  });

  it("範囲が重ならないときだけ良くなった", () => {
    const before = record([90, 100, 110], [1]);
    assert.equal(
      compareSplit(before, record([70, 80, 85], [1]), "train", "range"),
      "良くなった",
    );
    assert.equal(
      compareSplit(before, record([70, 80, 95], [1]), "train", "range"),
      "揺れの範囲内",
    );
  });

  it("範囲が重ならずに増えれば悪くなった", () => {
    assert.equal(
      compareSplit(
        record([90, 100, 110], [1]),
        record([120, 125, 130], [1]),
        "train",
        "range",
      ),
      "悪くなった",
    );
  });

  it("まとまった側を基準にしても、重なっていれば揺れの範囲内", () => {
    const tight = record([15322, 18621, 19534], [1]);
    const loose = record([15709, 25061, 31951], [1]);
    assert.equal(compareSplit(tight, loose, "train", "range"), "揺れの範囲内");
    assert.equal(compareSplit(loose, tight, "train", "range"), "揺れの範囲内");
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
      compareSplit(two([100], [100]), two([50], [150]), "train", "range"),
      "揺れの範囲内",
    );
  });
});

describe("verdict", () => {
  it("train も test も良くなれば採用", () => {
    assert.equal(
      verdict(record([100], [100]), record([90], [90]), "range"),
      "採用",
    );
  });

  it("train だけ良くなれば過学習の疑い", () => {
    assert.equal(
      verdict(record([100], [100]), record([90], [100]), "range"),
      "過学習の疑い",
    );
  });

  it("train が揺れの範囲内なら揺れの範囲内", () => {
    assert.equal(
      verdict(
        record([90, 100, 110], [100]),
        record([95, 100, 105], [50]),
        "range",
      ),
      "揺れの範囲内",
    );
  });

  it("train が良くなって test が悪くなれば過学習の疑い", () => {
    assert.equal(
      verdict(record([100], [100]), record([90], [110]), "range"),
      "過学習の疑い",
    );
  });

  it("合格率が下がれば、トークンが減っても戻す", () => {
    assert.equal(
      verdict(
        record([100, 100, 100], [100]),
        record([50, 50, 50], [50], [false, true, true]),
        "range",
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
    assert.equal(verdict(before, after, "range"), "比べられない");
  });

  it("train が悪くなれば戻す", () => {
    assert.equal(
      verdict(record([100], [100]), record([110], [90]), "range"),
      "戻す",
    );
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
    assert.equal(verdict(noTest, noTest, "range"), "比べられない");
  });
});

describe("U 検定の判定", () => {
  const nine = (start: number) =>
    Array.from({ length: 9 }, (_, i) => start + i * 100);

  it("3回ずつでは、完全に分かれても揺れの範囲内", () => {
    assert.equal(
      compareSplit(
        record([300, 310, 320], [1]),
        record([100, 110, 120], [1]),
        "train",
      ),
      "揺れの範囲内",
    );
  });

  it("9回ずつ分かれていれば良くなった", () => {
    assert.equal(
      compareSplit(record(nine(5000), [1]), record(nine(1000), [1]), "train"),
      "良くなった",
    );
  });

  it("範囲が1つ重なっていても、順位がはっきり分かれていれば差と見る", () => {
    const before = record([...nine(5000).slice(1), 1500], [1]);
    const after = record(nine(1000), [1]);
    assert.equal(compareSplit(before, after, "train", "range"), "揺れの範囲内");
    assert.equal(compareSplit(before, after, "train", "u"), "良くなった");
  });
});
