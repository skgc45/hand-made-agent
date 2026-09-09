import { EventType } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AgentEvent } from "../agent/loop.js";
import type { Sessions } from "../session/index.js";
import type { Transport } from "./index.js";

const PUBLIC = path.resolve(import.meta.dirname, "..", "..", "public");

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
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
      server.listen(this.port);
    });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
