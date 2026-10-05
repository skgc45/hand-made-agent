import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EventType } from "@ag-ui/core";
import { withSubagents } from "./agent/subagent.js";
import { loadCommands } from "./commands/index.js";
import {
  APPROVAL,
  CONTEXT_LIMIT,
  createClient,
  hooksFor,
  MODEL,
  mcpServersFor,
  NEEDS_TRUST,
  PROFILE,
  STREAM,
  TRIM,
  WORKSPACE,
} from "./config.js";
import { collectContext } from "./context/index.js";
import { createHooks, type Hooks } from "./harness/index.js";
import { connectMcp, withMcp } from "./mcp/index.js";
import { createProfile } from "./profile/index.js";
import { Sessions } from "./session/index.js";
import { loadSkills, withSkills } from "./skills/index.js";
import { MemoryStore } from "./store/memory.js";
import { createTelemetry } from "./telemetry/index.js";

type EvalCase = {
  name: string;
  prompt: string;
  profile?: string;
  workspace?: string;
  expect?: {
    /** 1回以上実行されていてほしいツール */
    tools?: string[];
    /** 入力トークンの累計の上限 */
    maxPromptTokens?: number;
  };
};

type Result = {
  name: string;
  outcome: "完走" | "承認待ち" | "エラー";
  failures: string[];
  tools: Map<string, number>;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  asked: number;
  blocked: number;
  seconds: number;
};

const EVAL_DIR = path.resolve(".hma", "evals");

const { positionals } = parseArgs({ allowPositionals: true });

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
const skills = await loadSkills();
const commands = await loadCommands();
const mcp = await connectMcp(mcpServersFor(trusted));
const telemetry = createTelemetry();

async function runCase(c: EvalCase): Promise<Result> {
  const result: Result = {
    name: c.name,
    outcome: "完走",
    failures: [],
    tools: new Map(),
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    asked: 0,
    blocked: 0,
    seconds: 0,
  };
  const started = performance.now();
  let jobs: ReturnType<typeof withSubagents>["jobs"] | undefined;
  try {
    const hooks: Hooks = {};
    const assembled = withSubagents(
      withMcp(
        withSkills(
          createProfile(c.profile ?? PROFILE, c.workspace ?? WORKSPACE),
          skills,
        ),
        mcp,
      ),
      {
        client: createClient(),
        model: MODEL,
        contextLimit: CONTEXT_LIMIT,
        trim: TRIM,
        hooks,
      },
    );
    const { profile } = assembled;
    jobs = assembled.jobs;
    const sections = await collectContext({
      workspace: profile.workspace,
      mode: APPROVAL,
      sessionStart: hooksFor(trusted).SessionStart ?? [],
      skills,
    });
    // ask を渡さないので、承認が要るツールに当たると -p と同じく Interrupt で止まる
    const sessions = new Sessions({
      client: createClient(),
      model: MODEL,
      profile,
      sections,
      contextLimit: CONTEXT_LIMIT,
      trim: TRIM,
      stream: STREAM,
      ...Object.assign(hooks, createHooks({ profile, trusted, commands })),
      jobs,
      store: new MemoryStore(),
      telemetry,
    });

    for await (const event of sessions.run(
      `eval-${c.name}-${randomUUID()}`,
      c.prompt,
    )) {
      if (event.type === EventType.RUN_ERROR) {
        result.outcome = "エラー";
        result.failures.push(event.message);
      } else if (
        event.type === EventType.RUN_FINISHED &&
        event.outcome?.type === "interrupt"
      ) {
        result.outcome = "承認待ち";
      } else if (event.type === EventType.CUSTOM) {
        const value = event.value as Record<string, unknown>;
        if (event.name === "usage") {
          result.modelCalls++;
          result.promptTokens += Number(value.promptTokens ?? 0);
          result.completionTokens += Number(value.completionTokens ?? 0);
        } else if (event.name === "gate") {
          // TOOL_CALL_START はモデルが呼ぼうとした時点で出る。通したものだけ数える
          if (value.decision === "run") {
            const n = String(value.tool);
            result.tools.set(n, (result.tools.get(n) ?? 0) + 1);
          }
          if (value.decision === "ask") result.asked++;
          if (value.decision === "block") result.blocked++;
        }
      }
    }
  } catch (error) {
    result.outcome = "エラー";
    result.failures.push(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await jobs?.stop();
  }
  result.seconds = (performance.now() - started) / 1000;

  if (result.outcome === "承認待ち") result.failures.push("承認待ちで止まった");
  for (const tool of c.expect?.tools ?? []) {
    if (!result.tools.has(tool))
      result.failures.push(`${tool} を実行していない`);
  }
  const max = c.expect?.maxPromptTokens;
  if (max !== undefined && result.promptTokens > max) {
    result.failures.push(`入力トークン ${result.promptTokens} > ${max}`);
  }
  return result;
}

console.error(
  `${MODEL} / APPROVAL=${APPROVAL} / TRIM=${TRIM} / ${cases.length} 件\n`,
);

// 無料枠は 5 RPM。並列にすると自分で 429 を踏むので1件ずつ流す
const results: Result[] = [];
try {
  for (const c of cases) {
    console.error(`  ${c.name} ...`);
    results.push(await runCase(c));
  }
} finally {
  await telemetry.close();
  mcp.close();
}

const header = [
  "名前",
  "判定",
  "ツール",
  "モデル",
  "入力tok",
  "出力tok",
  "ask",
  "block",
  "秒",
];
const rows = results.map((r) => [
  r.name,
  r.failures.length === 0 ? "ok" : "NG",
  [...r.tools].map(([n, k]) => `${n}×${k}`).join(" ") || "-",
  String(r.modelCalls),
  String(r.promptTokens),
  String(r.completionTokens),
  String(r.asked),
  String(r.blocked),
  r.seconds.toFixed(1),
]);
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map(() => "---").join("|")}|`);
for (const row of rows) console.log(`| ${row.join(" | ")} |`);

const failed = results.filter((r) => r.failures.length > 0);
for (const r of failed) {
  console.log(`\n${r.name}（${r.outcome}）`);
  for (const f of r.failures) console.log(`  - ${f}`);
}
process.exitCode = failed.length > 0 ? 1 : 0;
