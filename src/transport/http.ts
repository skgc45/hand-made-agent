import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { EventType, type ResumeEntry } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { AgentEvent } from "../agent/loop.js";
import type { Sessions } from "../session/index.js";
import type { Transport } from "./index.js";

const PUBLIC = path.resolve(import.meta.dirname, "..", "..", "public");
const HOST = process.env.HOST ?? "127.0.0.1";

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

const MAX_BODY = 1_000_000;

type RunBody = {
  threadId?: string;
  runId?: string;
  message?: string;
  messages?: unknown;
  queue?: string;
  resume?: ResumeEntry[];
};

async function readBody(req: http.IncomingMessage): Promise<RunBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("リクエストが大きすぎます");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as RunBody;
}

/**
 * ブラウザから叩かれる前提の門番。認証が無いので、ここが唯一の入口の守り。
 * - Content-Type を JSON に限る（preflight を回避する単純リクエストでの CSRF を塞ぐ）
 * - Origin があればループバック由来のみ（他サイトの JS からの CSRF を塞ぐ）
 * - ループバックに待ち受けているときは Host も見る（DNS リバインディングを塞ぐ）
 */
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

const hostname = (value: string): string =>
  value.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

function allowed(req: http.IncomingMessage): boolean {
  const type = req.headers["content-type"] ?? "";
  if (type.split(";")[0].trim() !== "application/json") return false;

  // HOST を明示的に外へ開いた人は、Host での判定を諦める（前段で守る前提）
  if (LOOPBACK.includes(HOST)) {
    const host = req.headers.host;
    if (!host || !LOOPBACK.includes(hostname(host))) return false;
  }

  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    // ポートは見ない。web/ の Vite プロキシが 5173 の Origin を転送してくる
    return LOOPBACK.includes(hostname(new URL(origin).hostname));
  } catch {
    return false;
  }
}

/**
 * HTTP + SSE を transport にする。
 * リクエストは1本のストリームなので承認を await できない（approve を持たない）。
 */
export class HttpTransport implements Transport {
  private readonly encoder = new EventEncoder();
  private server?: http.Server;

  constructor(private readonly port: number) {}

  private async handleRun(
    sessions: Sessions,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const body = await readBody(req);
    const threadId: string = body.threadId ?? randomUUID();
    const runId: string | undefined = body.runId;
    const message: string = body.message ?? lastUserText(body.messages);

    // 実行中のスレッドへの POST は新しい run にせず、割り込みとして積む
    const kind = body.queue === "followUp" ? "followUp" : "steering";
    if (!body.resume && sessions.steer(threadId, message, kind)) {
      res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ queued: kind, threadId }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": this.encoder.getContentType(),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const write = (event: AgentEvent) => {
      if (!res.writableEnded) res.write(this.encoder.encodeSSE(event));
    };

    // タブを閉じられたら走っている run を止める。放っておくとトークンを食い続ける
    const aborter = new AbortController();
    res.on("close", () => aborter.abort());

    try {
      const run = sessions.run(
        threadId,
        message,
        runId,
        body.resume,
        aborter.signal,
      );
      for await (const event of run) write(event);
    } catch (error) {
      write({ type: EventType.RUN_ERROR, message: (error as Error).message });
    } finally {
      res.end();
    }
  }

  private async route(
    sessions: Sessions,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    try {
      if (req.method === "POST" && req.url === "/") {
        if (!allowed(req)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        return await this.handleRun(sessions, req, res);
      }
      if (req.method === "GET" && req.url === "/threads") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(await sessions.list(), null, 2));
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        const html = await fs.readFile(path.join(PUBLIC, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      res.writeHead(404).end("not found");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  }

  async start(sessions: Sessions): Promise<void> {
    const server = http.createServer((req, res) =>
      this.route(sessions, req, res),
    );
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("close", resolve);
      // 承認を返すのはクライアント自身。外に開けると誰でも自分で承認できる
      server.listen(this.port, HOST);
    });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
