import { spawn } from "node:child_process";
import { type Rule, hits, parseRule, subjectsOf } from "../permission/index.js";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookConfig = {
  /** ツール名か tool(pattern)。権限ルールと同じ書式。省略すると全部に当たる */
  matcher?: string;
  command: string;
  /** 秒。既定30秒 */
  timeout?: number;
};

export type HookSet = Partial<Record<HookEvent, HookConfig[]>>;

export type HookOutcome = {
  decision?: "allow" | "block";
  reason?: string;
  /** モデルに渡す追記。JSON でない標準出力はそのままこれになる */
  context?: string;
};

const DEFAULT_TIMEOUT = 30;

export function matchesTool(
  matcher: string | undefined,
  name: string,
  args: unknown,
): boolean {
  if (matcher === undefined) return true;

  let rule: Rule;
  try {
    rule = parseRule(matcher);
  } catch {
    return false;
  }
  return subjectsOf(args).some((subject) => hits(rule, name, subject));
}

/**
 * exit 0 は通す（標準出力があれば context）。exit 2 は止める（標準エラーが理由）。
 * それ以外は警告して通す。フックの失敗でエージェントを止めない
 */
function interpret(
  hook: HookConfig,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): HookOutcome {
  const command = hook.command;

  // timeout で殺されるとコードではなくシグナルで返る
  if (code === null) {
    const why =
      signal === "SIGTERM"
        ? `タイムアウト（${hook.timeout ?? DEFAULT_TIMEOUT}秒）`
        : `異常終了（${signal}）`;
    console.error(`\x1b[33mフックが${why}: ${command}\x1b[0m`);
    return {};
  }

  if (code === 2) {
    return {
      decision: "block",
      reason: stderr.trim() || `フック（${command}）が実行を止めました`,
    };
  }
  if (code !== 0) {
    console.error(
      `\x1b[33mフックが exit ${code}: ${command}\x1b[0m${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    );
    return {};
  }

  const out = stdout.trim();
  if (!out) return {};
  if (!out.startsWith("{")) return { context: out };

  try {
    const parsed = JSON.parse(out) as {
      decision?: unknown;
      reason?: unknown;
      additionalContext?: unknown;
    };
    return {
      decision:
        parsed.decision === "allow" || parsed.decision === "block"
          ? parsed.decision
          : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      context:
        typeof parsed.additionalContext === "string"
          ? parsed.additionalContext
          : undefined,
    };
  } catch {
    // JSON に見えたが読めなかった。捨てずに、そのまま渡す
    return { context: out };
  }
}

export function runHook(
  hook: HookConfig,
  input: unknown,
  signal?: AbortSignal,
): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", hook.command], {
      cwd: process.cwd(),
      signal,
      timeout: (hook.timeout ?? DEFAULT_TIMEOUT) * 1000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    // フックが stdin を読まずに終わると EPIPE になる。失敗ではない
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));

    child.on("error", (error) => {
      console.error(`\x1b[33mフックを起動できません: ${hook.command}\x1b[0m`);
      console.error(error.message);
      resolve({});
    });
    child.on("close", (code, signal) =>
      resolve(interpret(hook, code, signal, stdout, stderr)),
    );
  });
}
