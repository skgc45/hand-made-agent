import { mannWhitney } from "./stats.js";

export type Split = "train" | "test";

/** hma eval --out が書き出す1回分 */
export type RunRecord = {
  passed: boolean;
  promptTokens: number;
  /** 親が実行したツールと回数。ステップ22 の記録には無い */
  tools?: Record<string, number>;
};

export type CaseRecord = {
  name: string;
  split?: Split;
  runs: RunRecord[];
};

export type EvalRecord = {
  model: string;
  createdAt: string;
  cases: CaseRecord[];
};

export type SplitScore = {
  passed: number;
  total: number;
  /** ケースごとの入力トークンの中央値の合計 */
  tokens: number;
};

export type Change = "良くなった" | "悪くなった" | "揺れの範囲内";

export type Verdict =
  | "採用"
  | "過学習の疑い"
  | "揺れの範囲内"
  | "戻す"
  | "比べられない";

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function casesOf(record: EvalRecord, split: Split): CaseRecord[] {
  return record.cases.filter((c) => c.split === split);
}

export function score(record: EvalRecord, split: Split): SplitScore {
  const cases = casesOf(record, split);
  return {
    passed: cases.reduce(
      (n, c) => n + c.runs.filter((r) => r.passed).length,
      0,
    ),
    total: cases.reduce((n, c) => n + c.runs.length, 0),
    tokens: cases.reduce(
      (n, c) => n + median(c.runs.map((r) => r.promptTokens)),
      0,
    ),
  };
}

/**
 * range: 前後の範囲が重ならないときだけ動いたと見る（ステップ22）。回数を増やすほど範囲が広がり、差を言えなくなる。
 * u: 順位の検定で p < 0.05 のときだけ動いたと見る。3回ずつでは完全に分かれても届かない
 */
export type Rule = "range" | "u";

const SIGNIFICANCE = 0.05;

function tokenChange(
  before: RunRecord[],
  after: RunRecord[],
  rule: Rule,
): Change {
  const b = before.map((r) => r.promptTokens);
  const a = after.map((r) => r.promptTokens);
  if (rule === "range") {
    if (Math.max(...a) < Math.min(...b)) return "良くなった";
    if (Math.min(...a) > Math.max(...b)) return "悪くなった";
    return "揺れの範囲内";
  }
  if (mannWhitney(b, a).p >= SIGNIFICANCE) return "揺れの範囲内";
  return median(a) < median(b) ? "良くなった" : "悪くなった";
}

/**
 * 合格率が変われば、それで決める。
 * 同じなら、ケースごとのトークンが揺れを超えて動いたものだけ数え、向きが揃ったときだけ良し悪しを言う
 */
export function compareSplit(
  before: EvalRecord,
  after: EvalRecord,
  split: Split,
  rule: Rule = "u",
): Change {
  const sb = score(before, split);
  const sa = score(after, split);
  const rate = (s: SplitScore) => s.passed / s.total;
  if (rate(sa) > rate(sb)) return "良くなった";
  if (rate(sa) < rate(sb)) return "悪くなった";

  const changes = casesOf(after, split).flatMap((c) => {
    const prev = casesOf(before, split).find((p) => p.name === c.name);
    return prev ? [tokenChange(prev.runs, c.runs, rule)] : [];
  });
  const up = changes.includes("良くなった");
  const down = changes.includes("悪くなった");
  if (up && !down) return "良くなった";
  if (down && !up) return "悪くなった";
  return "揺れの範囲内";
}

/** お題の顔ぶれが違うと、合格率の差がお題の差になる */
export function sameCases(before: EvalRecord, after: EvalRecord): boolean {
  const keys = (r: EvalRecord) =>
    r.cases
      .map((c) => `${c.split ?? ""}:${c.name}`)
      .sort()
      .join("\n");
  return keys(before) === keys(after);
}

export function verdict(
  before: EvalRecord,
  after: EvalRecord,
  rule: Rule = "u",
): Verdict {
  const empty = (["train", "test"] as const).some(
    (split) =>
      score(before, split).total === 0 || score(after, split).total === 0,
  );
  if (empty || !sameCases(before, after)) return "比べられない";

  const train = compareSplit(before, after, "train", rule);
  if (train === "悪くなった") return "戻す";
  if (train === "揺れの範囲内") return "揺れの範囲内";
  return compareSplit(before, after, "test", rule) === "良くなった"
    ? "採用"
    : "過学習の疑い";
}
