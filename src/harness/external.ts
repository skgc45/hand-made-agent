import type {
  AfterToolCall,
  BeforeToolCall,
  BeforeUserMessage,
} from "../agent/loop.js";
import { type HookConfig, matchesTool, runHook } from "../hooks/index.js";

function parseInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

/** フックの言い分はツール結果に混ぜて返すので、モデルから見て区別が付くようにする */
const NOTE = "[フック]";

export function preToolUse(hooks: HookConfig[]): BeforeToolCall | undefined {
  if (hooks.length === 0) return undefined;

  return async ({ name, arguments: args, toolCallId }, signal) => {
    const input = parseInput(args);

    for (const hook of hooks) {
      if (!matchesTool(hook.matcher, name, input)) continue;

      const outcome = await runHook(
        hook,
        {
          event: "PreToolUse",
          cwd: process.cwd(),
          toolCallId,
          tool: name,
          arguments: input,
        },
        signal,
      );

      if (outcome.decision === "block") {
        return {
          kind: "block",
          reason: outcome.reason ?? `${NOTE} 実行が止められました`,
        };
      }
      if (outcome.decision === "allow") return { kind: "allow" };
    }
    return undefined;
  };
}

export function postToolUse(hooks: HookConfig[]): AfterToolCall | undefined {
  if (hooks.length === 0) return undefined;

  return async ({ name, arguments: args, result, blocked }, signal) => {
    // 実行していないものに後処理は無い
    if (blocked) return undefined;

    const input = parseInput(args);
    let content = result;

    for (const hook of hooks) {
      if (!matchesTool(hook.matcher, name, input)) continue;

      const outcome = await runHook(
        hook,
        {
          event: "PostToolUse",
          cwd: process.cwd(),
          tool: name,
          arguments: input,
          result: content,
        },
        signal,
      );

      const note =
        outcome.decision === "block" ? outcome.reason : outcome.context;
      if (note) content += `\n\n${NOTE} ${note}`;
    }

    return content === result ? undefined : { content };
  };
}

export function userPromptSubmit(
  hooks: HookConfig[],
): BeforeUserMessage | undefined {
  if (hooks.length === 0) return undefined;

  return async (text, signal) => {
    const contexts: string[] = [];

    for (const hook of hooks) {
      const outcome = await runHook(
        hook,
        { event: "UserPromptSubmit", cwd: process.cwd(), prompt: text },
        signal,
      );

      if (outcome.decision === "block") {
        return { blocked: outcome.reason ?? `${NOTE} 入力が止められました` };
      }
      if (outcome.context) contexts.push(outcome.context);
    }

    return contexts.length > 0 ? { context: contexts.join("\n\n") } : undefined;
  };
}

/** 呼ばれるのは1 run に1回だけ（Sessions が保証する）。無限に続けさせないため */
export function onStop(
  hooks: HookConfig[],
): (() => Promise<string[]>) | undefined {
  if (hooks.length === 0) return undefined;

  return async () => {
    const messages: string[] = [];

    for (const hook of hooks) {
      const outcome = await runHook(hook, {
        event: "Stop",
        cwd: process.cwd(),
      });
      const message =
        outcome.decision === "block" ? outcome.reason : outcome.context;
      if (message) messages.push(message);
    }
    return messages;
  };
}
