import type { BeforeToolCall } from "../agent/loop.js";
import type { Permissions } from "../permission/index.js";

const DENIED = "ユーザーが実行を拒否しました。別の方法を検討してください。";
const BLOCKED =
  "権限ルールで禁止されています。このツールでは実行できません。別の方法を検討してください。";

export type ApprovalRequest = {
  name: string;
  arguments: string;
  suggestedRule: string;
};

export type ApprovalResult = {
  approved: boolean;
  /** 以降このルールに当たるものを聞かずに通す */
  rule?: string;
};

export type AskFn = (request: ApprovalRequest) => Promise<ApprovalResult>;

function parseInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

function remember(permissions: Permissions, rule?: string): void {
  if (!rule) return;
  try {
    permissions.allowForSession(rule);
  } catch (error) {
    console.error("ルールを追加できません:", (error as Error).message);
  }
}

/**
 * 権限の判定を承認ゲートに変換する beforeToolCall フック。
 * ask があれば待って決め（stdio）、無ければ Interrupt にして run を終える（http）。
 */
export function approvalHook(
  permissions: Permissions,
  ask?: AskFn,
): BeforeToolCall {
  return async ({ name, arguments: args, resume }) => {
    // 中断から戻ってきた。payload の読み方を知っているのはここだけ
    if (resume) {
      const payload = resume.payload as
        | { approved?: boolean; rule?: string }
        | undefined;
      const approved = resume.status === "resolved" && payload?.approved === true;
      if (approved) remember(permissions, payload?.rule);
      return approved ? undefined : { kind: "block", reason: DENIED };
    }

    const input = parseInput(args);
    const decision = permissions.decide(name, input);
    if (decision === "allow") return undefined;
    if (decision === "deny") return { kind: "block", reason: BLOCKED };

    const suggestedRule = permissions.suggestRule(name, input);

    if (ask) {
      const result = await ask({ name, arguments: args, suggestedRule });
      if (result.approved) remember(permissions, result.rule);
      return result.approved ? undefined : { kind: "block", reason: DENIED };
    }

    return {
      kind: "suspend",
      interrupt: {
        reason: "tool_approval",
        message: `${name} を実行しますか？`,
        metadata: { name, arguments: args, suggestedRule },
        responseSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            rule: { type: "string" },
          },
          required: ["approved"],
        },
      },
    };
  };
}
