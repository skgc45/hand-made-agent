import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** MCP の stdio は「1行1 JSON-RPC」。フレーミングはそれだけ */
const PROTOCOL = "2025-06-18";
const TIMEOUT = 15_000;

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** サーバの自己申告。readOnlyHint があれば権限の種類に写す */
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
};

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    readonly name: string,
    config: McpServerConfig,
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    const stdout = this.child.stdout;
    if (!stdout) throw new Error(`${this.name}: stdout を開けません`);
    createInterface({ input: stdout }).on("line", (line) => {
      this.receive(line);
    });
    // サーバのログは stderr に出る。混ぜると JSON-RPC が壊れるので、そのまま流すだけ
    this.child.stderr?.on("data", () => {});
    this.child.on("exit", () => this.failAll("サーバが終了しました"));
    this.child.on("error", (error) => this.failAll(error.message));
  }

  private failAll(reason: string): void {
    this.closed = true;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(`${this.name}: ${reason}`));
      this.pending.delete(id);
    }
  }

  private receive(line: string): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return; // JSON でない行は無視する（起動メッセージを吐くサーバがある）
    }
    if (typeof message.id !== "number") return;

    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(message.id);

    if (message.error) {
      waiting.reject(new Error(message.error.message ?? "エラー"));
    } else {
      waiting.resolve(message.result);
    }
  }

  private send(payload: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error(`${this.name}: 接続されていません`));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.name}: ${method} が ${TIMEOUT / 1000} 秒で応答しません`,
          ),
        );
      }, TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "hma", version: "0.1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list")) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  /** content は種類つきの配列で返る。履歴に積めるのは文字列なので畳む */
  async callTool(name: string, args: unknown): Promise<string> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };

    const parts = (result.content ?? []).map((item) =>
      item.type === "text"
        ? (item.text ?? "")
        : `(${item.type} は文字列にできないので省略)`,
    );
    const text =
      parts.join("\n").trim() ||
      (result.structuredContent
        ? JSON.stringify(result.structuredContent)
        : "(出力なし)");

    return result.isError ? `エラー: ${text}` : text;
  }

  close(): void {
    this.closed = true;
    this.child.kill();
  }
}
