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
  tool_call_id      String,
  content           String,
  prompt_tokens     UInt32,
  completion_tokens UInt32,
  chars_per_token   Float32,
  payload           String
) ENGINE = MergeTree
ORDER BY (thread_id, ts)
`;

class HttpError extends Error {
  constructor(
    readonly status: number,
    text: string,
  ) {
    super(`ClickHouse ${status}: ${text.slice(0, 300)}`);
  }
}

const MAX_BACKOFF_MS = 60_000;

/**
 * HTTP に JSONEachRow を投げるだけ。クライアントライブラリは要らない。
 * 1行ずつ挿すと MergeTree が細かいパートで埋まるので、まとめてから送る。
 */
export class ClickHouseTelemetry implements Telemetry {
  private readonly endpoint: URL;
  private readonly auth: string;
  private buffer: TelemetryRow[] = [];
  private ready?: Promise<void>;
  private inflight?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private backoffMs = 0;
  private nextAt = 0;

  constructor(
    url: string,
    private readonly batchSize = 50,
    private readonly flushMs = 2000,
    private readonly maxBuffer = 1000,
    private readonly timeoutMs = 10_000,
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
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);
    return text;
  }

  private ensureTable(): Promise<void> {
    if (this.ready) return this.ready;
    // 既存テーブルに後から足した列も揃える
    const ready = this.query(DDL)
      .then(() =>
        this.query(
          "ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS tool_call_id String, ADD COLUMN IF NOT EXISTS content String",
        ),
      )
      .then(() => undefined);
    this.ready = ready;
    // 失敗した Promise を握ったままにすると、ClickHouse が復旧しても送れない
    ready.catch(() => {
      if (this.ready === ready) this.ready = undefined;
    });
    return ready;
  }

  record(row: TelemetryRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.batchSize && Date.now() >= this.nextAt) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    this.timer ??= setTimeout(
      () => void this.flush(),
      Math.max(this.flushMs, this.nextAt - Date.now()),
    ).unref();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // 直列化して、close() が走っている送信を待てるようにする
    const run = (this.inflight ?? Promise.resolve()).then(() => this.send());
    this.inflight = run;
    return run;
  }

  private async send(): Promise<void> {
    const rows = this.buffer;
    if (rows.length === 0) return;
    this.buffer = [];

    try {
      await this.ensureTable();
    } catch (error) {
      this.requeue(rows, error);
      return;
    }
    try {
      await this.query(
        "INSERT INTO agent_events FORMAT JSONEachRow",
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
      this.backoffMs = 0;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) {
        // 行かスキーマが原因なので、戻すとバッチ全体を毎回落とす
        console.error(
          `テレメトリ: ${error.status} で拒否された ${rows.length} 行を破棄:`,
          error.message,
        );
        return;
      }
      this.requeue(rows, error);
    }
  }

  private requeue(rows: TelemetryRow[], error: unknown): void {
    // 計測が落ちてもエージェントは止めない
    console.error("テレメトリの送信に失敗:", (error as Error).message);
    this.backoffMs = Math.min(
      this.backoffMs ? this.backoffMs * 2 : this.flushMs,
      MAX_BACKOFF_MS,
    );
    this.nextAt = Date.now() + this.backoffMs;
    this.buffer = [...rows, ...this.buffer];
    const dropped = this.buffer.length - this.maxBuffer;
    if (dropped > 0) {
      this.buffer = this.buffer.slice(dropped);
      console.error(`テレメトリ: 上限超過のため古い ${dropped} 行を破棄`);
    }
    this.schedule();
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
