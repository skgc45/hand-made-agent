import { EventType } from "@ag-ui/core";
import type { AgentEvent } from "../agent/loop.js";

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export type CliOutput = {
  text: string;
  stderr?: boolean;
  /** 改行を付けずに書く。ストリーミングの delta 用 */
  raw?: boolean;
};

/** AG-UI イベントを端末の1行に変換する。public/index.html と同じ役目 */
export class CliRenderer {
  private readonly toolNames = new Map<string, string>();

  render(event: AgentEvent): CliOutput | null {
    switch (event.type) {
      case EventType.TOOL_CALL_START:
        this.toolNames.set(event.toolCallId, event.toolCallName);
        return null;

      case EventType.TEXT_MESSAGE_CONTENT:
        return { text: event.delta, raw: true };

      case EventType.TEXT_MESSAGE_END:
        return { text: "\n", raw: true };

      case EventType.TOOL_CALL_ARGS:
        return {
          text: dim(`  → ${this.toolNames.get(event.toolCallId)}(${event.delta})`),
        };

      case EventType.TOOL_CALL_RESULT:
        return { text: dim(`  ← ${event.content.split("\n")[0].slice(0, 80)}`) };

      case EventType.CUSTOM:
        return this.custom(event.name, event.value as Record<string, unknown>);

      case EventType.RUN_ERROR:
        return { text: `\n${event.message}\n`, stderr: true };

      default:
        return null;
    }
  }

  private custom(name: string, v: Record<string, unknown>): CliOutput | null {
    switch (name) {
      case "usage":
        return {
          text: dim(
            `  [messages ${v.messages} | ctx ${v.promptTokens} → out ${v.completionTokens} | ${v.charsPerToken} 文字/token | 累計入力 ${v.totalPromptTokens}]`,
          ),
        };
      case "compact":
        return {
          text: dim(
            `  [compact: ${v.dropped}件を要約 | コスト 入力 ${v.promptTokens} / 出力 ${v.completionTokens}]`,
          ),
        };
      case "trim":
        return {
          text: dim(`  [${v.strategy}: ${v.removed}件削除 → ${v.kept}件]`),
        };
      case "retry":
        return {
          text: yellow(
            `  [${v.status ?? "接続エラー"} — ${v.waitSeconds} 秒待って再試行 (${v.attempt}/5)]`,
          ),
        };
      case "graph": {
        const body = `graph: ${v.dropped}件から事実 ${v.added} 追加 / ${v.superseded} 更新 → 有効 ${v.active}件 | コスト 入力 ${v.promptTokens} / 出力 ${v.completionTokens}`;
        return v.unparsed
          ? { text: yellow(`  [${body} — 応答を読めず抽出できなかった]`) }
          : { text: dim(`  [${body}]`) };
      }
      case "recovered": {
        const calls = v.calls as { tool: string; attempted: boolean }[];
        const body = calls
          .map((c) => `${c.tool} は${c.attempted ? "走ったかもしれない" : "未実行"}`)
          .join(" / ");
        return { text: yellow(`  [前の run が落ちています — ${body}]`) };
      }
      case "reexec":
        return {
          text: yellow(`  [${v.tool} を再実行します — 前回走ったかもしれません]`),
        };
      case "subagent": {
        const tag = v.job ? `${v.job} ${v.agent}` : `${v.agent}`;
        if (v.event === "start")
          return { text: dim(`  ┌ ${tag}: ${v.prompt}`) };
        if (v.event === "tool") return { text: dim(`  │ ${tag}: ${v.tool}`) };
        if (v.event === "done")
          return { text: yellow(`  ✓ ${v.job} の結果が届きました`) };
        return {
          text: dim(
            `  └ ${tag}: ${v.steps} ターン / ツール ${v.tools}回 / 入力 ${v.promptTokens}${v.capped ? " — 上限で打ち切り" : ""}`,
          ),
        };
      }
      case "steering":
        return {
          text: dim(
            `  [割り込み: ${(v.messages as string[])
              .map((m) => m.replace(/\s+/g, " ").slice(0, 100))
              .join(" / ")}]`,
          ),
        };
      default:
        return null;
    }
  }
}
