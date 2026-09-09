import type { BeforeToolCall } from "./agent/loop.js";
import { requiresApproval } from "./agent/tools.js";

const DENIED = "ユーザーが実行を拒否しました。別の方法を検討してください。";

export type AskFn = (name: string, args: string) => Promise<boolean>;

/**
 * 承認ゲートを beforeToolCall フックとして組み立てる。
 * ask があれば待って決め（stdio）、無ければ Interrupt にして run を終える（http）。
 */
export function approvalHook(ask?: AskFn): BeforeToolCall {
  return async ({ name, arguments: args, resume }) => {
    if (!requiresApproval.has(name)) return undefined;

    // 中断から戻ってきた。payload の読み方を知っているのはここだけ
    if (resume) {
      const approved =
        resume.status === "resolved" &&
        (resume.payload as { approved?: boolean })?.approved === true;
      return approved ? undefined : { kind: "block", reason: DENIED };
    }

    if (ask) {
      return (await ask(name, args))
        ? undefined
        : { kind: "block", reason: DENIED };
    }

    return {
      kind: "suspend",
      interrupt: {
        reason: "tool_approval",
        message: `${name} を実行しますか？`,
        metadata: { name, arguments: args },
        responseSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
          required: ["approved"],
        },
      },
    };
  };
}
