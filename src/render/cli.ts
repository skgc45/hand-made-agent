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
  private readonly dim: (s: string) => string;
  private readonly yellow: (s: string) => string;

  /** 端末でなければ色を付けない。パイプの先で ANSI を剥がす手間を無くす */
  constructor(color = true) {
    this.dim = color ? dim : (s) => s;
    this.yellow = color ? yellow : (s) => s;
  }

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
          text: this.dim(
            `  → ${this.toolNames.get(event.toolCallId)}(${event.delta})`,
          ),
        };

      case EventType.TOOL_CALL_RESULT:
        return {
          text: this.dim(`  ← ${event.content.split("\n")[0].slice(0, 80)}`),
        };

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
          text: this.dim(
            `  [messages ${v.messages} | ctx ${v.promptTokens} → out ${v.completionTokens} | ${v.charsPerToken} 文字/token | 累計入力 ${v.totalPromptTokens}]`,
          ),
        };
      case "compact":
        return {
          text: this.dim(
            `  [compact: ${v.dropped}件を要約 | コスト 入力 ${v.promptTokens} / 出力 ${v.completionTokens}]`,
          ),
        };
      case "trim":
        return {
          text: this.dim(`  [${v.strategy}: ${v.removed}件削除 → ${v.kept}件]`),
        };
      case "retry":
        return {
          text: this.yellow(
            `  [${v.status ?? "接続エラー"} — ${v.waitSeconds} 秒待って再試行 (${v.attempt}/5)]`,
          ),
        };
      case "graph": {
        const body = `graph: ${v.dropped}件から事実 ${v.added} 追加 / ${v.superseded} 更新 → 有効 ${v.active}件 | コスト 入力 ${v.promptTokens} / 出力 ${v.completionTokens}`;
        return v.unparsed
          ? { text: this.yellow(`  [${body} — 応答を読めず抽出できなかった]`) }
          : { text: this.dim(`  [${body}]`) };
      }
      case "recovered": {
        const calls = v.calls as { tool: string; attempted: boolean }[];
        const body = calls
          .map(
            (c) =>
              `${c.tool} は${c.attempted ? "走ったかもしれない" : "未実行"}`,
          )
          .join(" / ");
        return { text: this.yellow(`  [前の run が落ちています — ${body}]`) };
      }
      case "reexec":
        return {
          text: this.yellow(
            `  [${v.tool} を再実行します — 前回走ったかもしれません]`,
          ),
        };
      case "subagent": {
        const tag = v.job ? `${v.job} ${v.agent}` : `${v.agent}`;
        if (v.event === "start")
          return { text: this.dim(`  ┌ ${tag}: ${v.prompt}`) };
        if (v.event === "tool")
          return { text: this.dim(`  │ ${tag}: ${v.tool}`) };
        if (v.event === "done")
          return { text: this.yellow(`  ✓ ${v.job} の結果が届きました`) };
        return {
          text: this.dim(
            `  └ ${tag}: ${v.steps} ターン / ツール ${v.tools}回 / 入力 ${v.promptTokens}${v.capped ? " — 上限で打ち切り" : ""}`,
          ),
        };
      }
      case "prompt":
        return {
          text: this.dim(`  [${v.from} を展開しました（${v.chars} 文字）]`),
        };
      case "steering":
        return {
          text: this.dim(
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
