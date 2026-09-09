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
  /** CUSTOM の name（usage / trim / compact / retry / steering） */
  name: string;
  tool: string;
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

  return {
    ts: new Date().toISOString().replace("T", " ").replace("Z", ""),
    thread_id: context.threadId,
    run_id: context.runId,
    profile: context.profile,
    model: context.model,
    type: event.type,
    name: custom?.name ?? "",
    tool: (toolCallName as string) ?? "",
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
