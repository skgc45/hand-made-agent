/** 標準正規分布の累積分布。Abramowitz & Stegun 7.1.26（誤差 1.5e-7） */
function normalCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Mann-Whitney の U 検定（両側、正規近似、同順位と連続性の補正つき）。
 * 値の大きさではなく順位だけを見るので、2倍揺れる外れ値に引きずられない
 */
export function mannWhitney(
  a: number[],
  b: number[],
): { p: number; u: number } {
  const n1 = a.length;
  const n2 = b.length;
  const all = [
    ...a.map((v) => ({ v, g: 0 })),
    ...b.map((v) => ({ v, g: 1 })),
  ].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  let ties = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const t = j - i + 1;
    ties += t ** 3 - t;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const r1 = all.reduce((n, x, i) => n + (x.g === 0 ? ranks[i] : 0), 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1))));
  if (sigma === 0) return { p: 1, u };
  const z = Math.max(0, Math.abs(u - (n1 * n2) / 2) - 0.5) / sigma;
  return { p: Math.min(1, 2 * (1 - normalCdf(z))), u };
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * Fisher の正確検定（両側）。a/n1 と b/n2 の割合に差があるか。
 * 回数が少ないとき、割合の比較に正規近似は使えない
 */
export function fisherExact(
  a: number,
  n1: number,
  b: number,
  n2: number,
): number {
  const k = a + b;
  const n = n1 + n2;
  const logP = (x: number) =>
    logFactorial(k) -
    logFactorial(x) -
    logFactorial(k - x) +
    logFactorial(n - k) -
    logFactorial(n1 - x) -
    logFactorial(n - k - n1 + x) -
    (logFactorial(n) - logFactorial(n1) - logFactorial(n2));
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, k - n2); x <= Math.min(k, n1); x++) {
    const lp = logP(x);
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}
