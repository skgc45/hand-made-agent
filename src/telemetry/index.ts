import { TELEMETRY, TELEMETRY_URL } from "../config.js";
import type { AgentEvent } from "../agent/loop.js";
import { ClickHouseTelemetry } from "./clickhouse.js";
import { NoopTelemetry } from "./noop.js";

/** 1イベント1行。分析でよく引くものだけ列に出し、残りは payload に置く */
export type TelemetryRow = {
  ts: string;
  thread_id: string;
  run_id: string;
  profile: string;
  model: string;
  type: string;
  /** CUSTOM の name（usage / trim / compact / graph / retry / steering / gate / recovered / reexec） */
  name: string;
  tool: string;
  /** TOOL_CALL_START と TOOL_CALL_RESULT を突き合わせるため */
  tool_call_id: string;
  /** ツール結果の頭。失敗率を数えるのに使う */
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  chars_per_token: number;
  payload: string;
};

export interface Telemetry {
  record(row: TelemetryRow): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type TelemetryContext = {
  threadId: string;
  runId: string;
  profile: string;
  model: string;
};

/** AG-UI イベントを1行に畳む。表示用のイベントを、そのまま計測にも使う */
export function toRow(
  event: AgentEvent,
  context: TelemetryContext,
): TelemetryRow {
  const custom = event.type === "CUSTOM" ? event : undefined;
  const value = (custom?.value ?? {}) as Record<string, unknown>;
  const toolCallName = "toolCallName" in event ? event.toolCallName : undefined;
  const toolCallId = "toolCallId" in event ? event.toolCallId : undefined;
  const content = "content" in event ? event.content : undefined;

  return {
    ts: new Date().toISOString().replace("T", " ").replace("Z", ""),
    thread_id: context.threadId,
    run_id: context.runId,
    profile: context.profile,
    model: context.model,
    type: event.type,
    name: custom?.name ?? "",
    // CUSTOM は toolCallName を持たないので、value.tool を同じ列に寄せる
    tool: (toolCallName as string) ?? (value.tool as string) ?? "",
    tool_call_id: (toolCallId as string) ?? "",
    content: typeof content === "string" ? content.slice(0, 200) : "",
    prompt_tokens: Number(value.promptTokens ?? 0),
    completion_tokens: Number(value.completionTokens ?? 0),
    chars_per_token: Number(value.charsPerToken ?? 0),
    payload: custom ? JSON.stringify(value) : "",
  };
}

export function createTelemetry(
  kind: string = TELEMETRY,
  url: string = TELEMETRY_URL,
): Telemetry {
  switch (kind) {
    case "clickhouse":
      return new ClickHouseTelemetry(url);
    case "none":
      return new NoopTelemetry();
    default:
      throw new Error(`TELEMETRY に不明な値: ${kind}（clickhouse / none）`);
  }
}

export { ClickHouseTelemetry, NoopTelemetry };
