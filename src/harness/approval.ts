import type { BeforeToolCall } from "../agent/loop.js";
import type { Permissions } from "../permission/index.js";

const DENIED = "ユーザーが実行を拒否しました。別の方法を検討してください。";
const BLOCKED =
  "権限ルールで禁止されています。このツールでは実行できません。別の方法を検討してください。";

export type ApprovalRequest = {
  name: string;
  arguments: string;
  /** 当たるルールを作れないときは無い。UI は「常に許可」を出さない */
  suggestedRule?: string;
};

export type ApprovalResult = {
  approved: boolean;
  /** 以降このルールに当たるものを聞かずに通す */
  rule?: string;
  /** ルールを設定ファイルに残す。false ならプロセスが死ぬまで */
  save?: boolean;
};

/** ルールを書き足して、書いたファイルを返す */
export type SaveFn = (rule: string) => Promise<string>;

export type AskFn = (request: ApprovalRequest) => Promise<ApprovalResult>;

function parseInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

async function remember(
  permissions: Permissions,
  result: { rule?: string; save?: boolean },
  save?: SaveFn,
): Promise<void> {
  if (!result.rule) return;

  try {
    permissions.allowForSession(result.rule);
  } catch (error) {
    console.error("ルールを追加できません:", (error as Error).message);
    return;
  }

  if (!result.save || !save) return;
  try {
    console.log(`  ${await save(result.rule)} に保存しました`);
  } catch (error) {
    console.error("ルールを保存できません:", (error as Error).message);
  }
}

/**
 * 権限の判定を承認ゲートに変換する beforeToolCall フック。
 * ask があれば待って決め（stdio）、無ければ Interrupt にして run を終える（http）。
 */
export function approvalHook(
  permissions: Permissions,
  ask?: AskFn,
  save?: SaveFn,
): BeforeToolCall {
  return async ({ name, arguments: args, resume }) => {
    // 中断から戻ってきた。payload の読み方を知っているのはここだけ
    if (resume) {
      const payload = resume.payload as
        | { approved?: boolean; rule?: string; save?: boolean }
        | undefined;
      const approved = resume.status === "resolved" && payload?.approved === true;
      if (approved && payload) await remember(permissions, payload, save);
      return approved ? undefined : { kind: "block", reason: DENIED };
    }

    const input = parseInput(args);
    const decision = permissions.decide(name, input);
    if (decision === "allow") return undefined;
    if (decision === "deny") return { kind: "block", reason: BLOCKED };

    const suggestedRule = permissions.suggestRule(name, input);

    if (ask) {
      const result = await ask({ name, arguments: args, suggestedRule });
      if (result.approved) await remember(permissions, result, save);
      return result.approved ? undefined : { kind: "block", reason: DENIED };
    }

    return {
      kind: "suspend",
      interrupt: {
        reason: "tool_approval",
        message: `${name} を実行しますか？`,
        metadata: suggestedRule
          ? { name, arguments: args, suggestedRule }
          : { name, arguments: args },
        responseSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            rule: { type: "string" },
            save: { type: "boolean" },
          },
          required: ["approved"],
        },
      },
    };
  };
}
