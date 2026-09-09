import type { Telemetry, TelemetryRow } from "./index.js";

const DDL = `
CREATE TABLE IF NOT EXISTS agent_events (
  ts                DateTime64(3),
  thread_id         String,
  run_id            String,
  profile           LowCardinality(String),
  model             LowCardinality(String),
  type              LowCardinality(String),
  name              LowCardinality(String),
  tool              LowCardinality(String),
  prompt_tokens     UInt32,
  completion_tokens UInt32,
  chars_per_token   Float32,
  payload           String
) ENGINE = MergeTree
ORDER BY (thread_id, ts)
`;

/**
 * HTTP に JSONEachRow を投げるだけ。クライアントライブラリは要らない。
 * 1行ずつ挿すと MergeTree が細かいパートで埋まるので、まとめてから送る。
 */
export class ClickHouseTelemetry implements Telemetry {
  private readonly endpoint: URL;
  private readonly auth: string;
  private buffer: TelemetryRow[] = [];
  private ready?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    url: string,
    private readonly batchSize = 50,
    private readonly flushMs = 2000,
  ) {
    const parsed = new URL(url);
    this.auth = `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64")}`;
    parsed.username = "";
    parsed.password = "";
    this.endpoint = parsed;
  }

  private async query(sql: string, body?: string): Promise<string> {
    const url = new URL(this.endpoint);
    url.searchParams.set("query", sql);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: this.auth },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }

  private ensureTable(): Promise<void> {
    this.ready ??= this.query(DDL).then(() => undefined);
    return this.ready;
  }

  record(row: TelemetryRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => void this.flush(), this.flushMs).unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const rows = this.buffer;
    if (rows.length === 0) return;
    this.buffer = [];

    try {
      await this.ensureTable();
      await this.query(
        "INSERT INTO agent_events FORMAT JSONEachRow",
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
    } catch (error) {
      // 計測が落ちてもエージェントは止めない
      console.error("テレメトリの送信に失敗:", (error as Error).message);
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
