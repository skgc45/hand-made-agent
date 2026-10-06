import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { EventType } from "@ag-ui/core";
import type { withSubagents } from "./agent/subagent.js";
import { type Call, touchedCalls } from "./eval/behavior.js";
import {
  compareSplit,
  compareTouched,
  type EvalRecord,
  type Rule,
  type Split,
  sameCases,
  score,
  touchedScore,
  verdict,
} from "./eval/compare.js";

type EvalCase = {
  name: string;
  prompt: string;
  profile?: string;
  workspace?: string;
  /** hillclimbing で、見ながら直す train か、直すときに見ない test か */
  split?: Split;
  /** 終わったあと workspace の写しで走らせるコマンド。終了コード 0 で合格。流し始めの写しは $HMA_EVAL_SOURCE */
  check?: string;
  expect?: {
    /** 1回以上実行されていてほしいツール */
    tools?: string[];
    /** 親に読んでほしくない範囲（サブエージェントに任せた先）。合否には入れず、手を出した回を数える */
    untouched?: string[];
    /** 入力トークンの累計の上限 */
    maxPromptTokens?: number;
  };
};

type Run = {
  outcome: "完走" | "承認待ち" | "エラー";
  failures: string[];
  tools: Map<string, number>;
  calls: Call[];
  /** expect.untouched に手を出した呼び出し。untouched が無いお題では undefined */
  touched?: Call[];
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  asked: number;
  blocked: number;
  retries: number;
  /** 429 などのリトライで寝ていた秒 */
  waited: number;
  seconds: number;
  /** NG のときだけ残す workspace の写し */
  kept?: string;
};

const EVAL_DIR = path.resolve(".hma", "evals");
const CHECK_TIMEOUT_MS = 120_000;

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    repeat: { type: "string", default: "1" },
    out: { type: "string" },
    compare: { type: "boolean" },
    rule: { type: "string", default: "u" },
  },
});

if (opts.compare) {
  if (positionals.length !== 2) {
    console.error("使い方: hma eval --compare <変更前.json> <変更後.json>");
    process.exit(2);
  }
  const [before, after] = await Promise.all(
    positionals.map(async (f) => {
      try {
        const record = JSON.parse(await readFile(f, "utf-8")) as EvalRecord;
        if (!Array.isArray(record?.cases))
          throw new Error("cases がありません");
        return record;
      } catch (error) {
        console.error(`${f} を読めません: ${(error as Error).message}`);
        process.exit(2);
      }
    }),
  );
  const rule = opts.rule as Rule;
  if (rule !== "u" && rule !== "range") {
    console.error(`--rule は u か range: ${opts.rule}`);
    process.exit(2);
  }
  if (!sameCases(before, after)) {
    console.error("前後でお題（名前と split）の顔ぶれが違います");
  }
  console.log(
    "| 区分 | 合格（前 → 後） | 入力tok の中央値の合計（前 → 後） | 変化 | 手出し（前 → 後） | 変化 |",
  );
  console.log("|---|---|---|---|---|---|");
  for (const split of ["train", "test"] as const) {
    const b = score(before, split);
    const a = score(after, split);
    const tb = touchedScore(before, split);
    const ta = touchedScore(after, split);
    const touched =
      tb.judged && ta.judged
        ? `${tb.touched}/${tb.judged} → ${ta.touched}/${ta.judged} | ${compareTouched(before, after, split)}`
        : "- | -";
    console.log(
      `| ${split} | ${b.passed}/${b.total} → ${a.passed}/${a.total} | ${b.tokens} → ${a.tokens} | ${b.total && a.total ? compareSplit(before, after, split, rule) : "-"} | ${touched} |`,
    );
  }
  console.log(`\n判定: ${verdict(before, after, rule)}`);
  process.exit(0);
}

// --compare は記録を比べるだけ。設定の検証（API キーなど）で止まらないよう、ここから先で読む
const {
  APPROVAL,
  MODEL,
  NEEDS_TRUST,
  PROFILE,
  TELEMETRY,
  TELEMETRY_URL,
  TRIM,
  WORKSPACE,
} = await import("./config.js");
const { buildSessions, loadAssets } = await import("./runtime.js");
const { MemoryStore } = await import("./store/memory.js");
const { createTelemetry } = await import("./telemetry/index.js");

const repeat = Number(opts.repeat);
if (!Number.isInteger(repeat) || repeat < 1) {
  console.error(`--repeat は1以上の整数: ${opts.repeat}`);
  process.exit(2);
}

async function loadCases(only: string[]): Promise<EvalCase[]> {
  const files = (await readdir(EVAL_DIR).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const cases = await Promise.all(
    files.map(async (f) => {
      let body: Omit<EvalCase, "name">;
      try {
        body = JSON.parse(await readFile(path.join(EVAL_DIR, f), "utf-8"));
      } catch (error) {
        throw new Error(`${f}: ${(error as Error).message}`);
      }
      if (typeof body?.prompt !== "string" || !body.prompt.trim()) {
        throw new Error(`${f}: prompt がありません`);
      }
      if (body.split !== undefined && !["train", "test"].includes(body.split)) {
        throw new Error(`${f}: split は train か test: ${body.split}`);
      }
      // "." や ".." を書くと全部の呼び出しが手出しになる
      const bad = body.expect?.untouched?.find(
        (u) =>
          typeof u !== "string" ||
          ["", ".", ".."].includes(path.normalize(u).split(path.sep)[0]),
      );
      if (bad !== undefined) {
        throw new Error(`${f}: untouched は workspace の中の範囲: ${bad}`);
      }
      return { ...body, name: path.basename(f, ".json") };
    }),
  );
  const unknown = only.filter((n) => !cases.some((c) => c.name === n));
  if (unknown.length > 0) {
    throw new Error(`見つからないケース: ${unknown.join(", ")}`);
  }
  return only.length > 0 ? cases.filter((c) => only.includes(c.name)) : cases;
}

const cases = await loadCases(positionals).catch((error: Error) => {
  console.error(error.message);
  process.exit(2);
});
if (cases.length === 0) {
  console.error(`${EVAL_DIR} に *.json がありません`);
  process.exit(2);
}

// 非対話なので信頼は聞けない。-p と同じく、未信頼なら緩める方向の設定を落として進む
const trusted = !NEEDS_TRUST;
if (NEEDS_TRUST) {
  console.error(
    "未信頼の .hma があります。フック・allow・MCP は無効のまま進みます（hma trust）",
  );
}
const assets = await loadAssets(trusted);
const telemetry = createTelemetry(TELEMETRY, TELEMETRY_URL);

async function runCheck(
  command: string,
  cwd: string,
  source: string,
): Promise<string | null> {
  // check は .hma に書かれた任意のコマンド。API キーまでは見せない
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.LLM_API_KEY;
  try {
    await promisify(execFile)("sh", ["-c", command], {
      cwd,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...env, HMA_EVAL_SOURCE: source },
    });
    return null;
  } catch (error) {
    const e = error as {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const why = e.killed
      ? `${CHECK_TIMEOUT_MS / 1000} 秒でタイムアウト`
      : `exit ${e.code ?? "?"}`;
    const tail = `${e.stdout ?? ""}${e.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-3)
      .join(" / ");
    return `check が失敗（${command} → ${why}）${tail ? `: ${tail}` : ""}`;
  }
}

async function runOnce(c: EvalCase, source: string): Promise<Run> {
  const run: Run = {
    outcome: "完走",
    failures: [],
    tools: new Map(),
    calls: [],
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    asked: 0,
    blocked: 0,
    retries: 0,
    waited: 0,
    seconds: 0,
  };
  const started = performance.now();
  let jobs: ReturnType<typeof withSubagents>["jobs"] | undefined;
  // 前の試行の書き換えを持ち越さないよう、毎回 workspace の写しで動かす
  // macOS の tmpdir は /var → /private/var のリンク。node が出す実パスと境界判定を揃える
  const copy = await realpath(
    await mkdtemp(path.join(os.tmpdir(), `hma-eval-${c.name}-`)),
  );
  try {
    await cp(source, copy, { recursive: true });
    // ask を渡さないので、承認が要るツールに当たると -p と同じく Interrupt で止まる
    const built = await buildSessions(assets, {
      profile: c.profile ?? PROFILE,
      workspace: copy,
      store: new MemoryStore(),
      telemetry,
    });
    jobs = built.jobs;
    const { sessions } = built;

    for await (const event of sessions.run(
      `eval-${c.name}-${randomUUID()}`,
      c.prompt,
    )) {
      if (event.type === EventType.RUN_ERROR) {
        run.outcome = "エラー";
        run.failures.push(event.message);
      } else if (
        event.type === EventType.RUN_FINISHED &&
        event.outcome?.type === "interrupt"
      ) {
        run.outcome = "承認待ち";
      } else if (event.type === EventType.CUSTOM) {
        const value = event.value as Record<string, unknown>;
        if (event.name === "usage") {
          run.modelCalls++;
          run.promptTokens += Number(value.promptTokens ?? 0);
          run.completionTokens += Number(value.completionTokens ?? 0);
        } else if (event.name === "gate") {
          // TOOL_CALL_START はモデルが呼ぼうとした時点で出る。通したものだけ数える
          if (value.decision === "run") {
            const n = String(value.tool);
            run.tools.set(n, (run.tools.get(n) ?? 0) + 1);
            run.calls.push({ tool: n, arguments: String(value.arguments) });
          }
          if (value.decision === "ask") run.asked++;
          if (value.decision === "block") run.blocked++;
        } else if (event.name === "retry") {
          run.retries++;
          run.waited += Number(value.waitSeconds ?? 0);
        }
      }
    }
  } catch (error) {
    run.outcome = "エラー";
    run.failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    await jobs?.stop();
  }
  run.seconds = (performance.now() - started) / 1000;

  if (run.outcome === "承認待ち") run.failures.push("承認待ちで止まった");
  for (const tool of c.expect?.tools ?? []) {
    if (!run.tools.has(tool)) run.failures.push(`${tool} を実行していない`);
  }
  // 途中で止まった回は呼び出しが揃っていないので、手出しの分母に入れない
  if (c.expect?.untouched && run.outcome === "完走") {
    run.touched = touchedCalls(run.calls, c.expect.untouched, copy);
  }
  const max = c.expect?.maxPromptTokens;
  if (max !== undefined && run.promptTokens > max) {
    run.failures.push(`入力トークン ${run.promptTokens} > ${max}`);
  }
  if (c.check && run.outcome !== "エラー") {
    const failed = await runCheck(c.check, copy, source);
    if (failed) run.failures.push(failed);
  }

  if (run.failures.length > 0) run.kept = copy;
  else await rm(copy, { recursive: true, force: true });
  return run;
}

console.error(
  `${MODEL} / APPROVAL=${APPROVAL} / TRIM=${TRIM} / ${cases.length} 件 × ${repeat} 回`,
);
// check は .hma/evals に書かれたコマンドを本人の権限で走らせる。何が走るかを先に見せる
for (const c of cases.filter((c) => c.check)) {
  console.error(`  check ${c.name}: ${c.check}`);
}
console.error("");

const hitQuota = (run: Run) => run.failures.some((f) => f.startsWith("429"));

// 無料枠は 5 RPM。並列にすると自分で 429 を踏むので1件ずつ流す
const results: { c: EvalCase; runs: Run[] }[] = [];
let quota = false;
try {
  for (const c of cases) {
    // 流している間に元の workspace が変わっても、全回を同じ状態から始め、同じ状態と比べる
    const source = await realpath(
      await mkdtemp(path.join(os.tmpdir(), `hma-eval-${c.name}-source-`)),
    );
    const runs: Run[] = [];
    try {
      await cp(path.resolve(c.workspace ?? WORKSPACE), source, {
        recursive: true,
        filter: (src) => path.basename(src) !== ".git",
      });
      for (let i = 1; i <= repeat && !quota; i++) {
        console.error(`  ${c.name} ${i}/${repeat} ...`);
        const run = await runOnce(c, source);
        runs.push(run);
        // リトライしても 429 が残るなら、残りも同じ 429 で落ちて枠も時間も無駄になる
        quota = hitQuota(run);
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
    results.push({ c, runs });
    if (quota) {
      console.error("  429 で落ちたので、残りは流さずに止めます");
      break;
    }
  }
} finally {
  await telemetry.close();
  assets.mcp.close();
}

/** 1回なら値だけ、複数回なら 最小/中央/最大 */
function spread(values: number[], digits = 0): string {
  const sorted = [...values].sort((a, b) => a - b);
  const f = (n: number) => n.toFixed(digits);
  if (sorted.length === 1) return f(sorted[0]);
  const mid = sorted[Math.floor((sorted.length - 1) / 2)];
  return `${f(sorted[0])}/${f(mid)}/${f(sorted[sorted.length - 1])}`;
}

function toolsOf(runs: Run[]): string {
  const total = new Map<string, number>();
  for (const r of runs) {
    for (const [n, k] of r.tools) total.set(n, (total.get(n) ?? 0) + k);
  }
  const per = (k: number) =>
    runs.length === 1 ? String(k) : (k / runs.length).toFixed(1);
  return [...total].map(([n, k]) => `${n}×${per(k)}`).join(" ") || "-";
}

const header = [
  "名前",
  "合格",
  "ツール（1回あたり）",
  "手出し",
  "モデル",
  "入力tok",
  "出力tok",
  "ask",
  "block",
  "retry",
  "秒（待ち除く）",
];
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map(() => "---").join("|")}|`);
for (const { c, runs } of results) {
  const passed = runs.filter((r) => r.failures.length === 0).length;
  const sum = (f: (r: Run) => number) => runs.reduce((n, r) => n + f(r), 0);
  const row = [
    c.name,
    `${passed}/${runs.length}`,
    toolsOf(runs),
    c.expect?.untouched
      ? `${runs.filter((r) => r.touched?.length).length}/${runs.filter((r) => r.touched).length}`
      : "-",
    spread(runs.map((r) => r.modelCalls)),
    spread(runs.map((r) => r.promptTokens)),
    spread(runs.map((r) => r.completionTokens)),
    String(sum((r) => r.asked)),
    String(sum((r) => r.blocked)),
    String(sum((r) => r.retries)),
    spread(
      runs.map((r) => Math.max(0, r.seconds - r.waited)),
      1,
    ),
  ];
  console.log(`| ${row.join(" | ")} |`);
}
if (repeat > 1) console.log("\n複数回の列は 最小/中央/最大。");

let failed = false;
for (const { c, runs } of results) {
  runs.forEach((r, i) => {
    if (r.failures.length === 0) return;
    failed = true;
    console.log(`\n${c.name} ${i + 1}回目（${r.outcome}）`);
    for (const f of r.failures) console.log(`  - ${f}`);
    console.log(`  写し: ${r.kept}`);
  });
}
for (const { c, runs } of results) {
  runs.forEach((r, i) => {
    if (!r.touched?.length || !c.expect?.untouched) return;
    console.log(
      `\n${c.name} ${i + 1}回目: ${c.expect.untouched.join(", ")} に手を出した`,
    );
    for (const call of r.touched) {
      console.log(`  - ${call.tool} ${call.arguments}`);
    }
  });
}
if (opts.out) {
  const record: EvalRecord = {
    model: MODEL,
    createdAt: new Date().toISOString(),
    cases: results.map(({ c, runs }) => ({
      name: c.name,
      split: c.split,
      // 429 の回はお題の結果ではない。残すと --compare が「戻す」を出す
      runs: runs
        .filter((r) => !hitQuota(r))
        .map((r) => ({
          passed: r.failures.length === 0,
          promptTokens: r.promptTokens,
          tools: Object.fromEntries(r.tools),
          touched: r.touched ? r.touched.length > 0 : undefined,
          calls: r.calls,
        })),
    })),
  };
  try {
    await writeFile(opts.out, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    console.log(`\n${opts.out} に保存しました（hma eval --compare で比べる）`);
  } catch (error) {
    console.error(
      `\n${opts.out} に保存できません: ${(error as Error).message}`,
    );
    failed = true;
  }
}

process.exitCode = failed ? 1 : 0;
