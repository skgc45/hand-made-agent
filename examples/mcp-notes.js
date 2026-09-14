#!/usr/bin/env node
// 練習用の MCP サーバ。stdio で1行1 JSON-RPC を喋るだけの最小実装。
// note_list は readOnlyHint を申告し、note_write は申告しない（権限の種類の違いを見るため）。
import { createInterface } from "node:readline";

const notes = new Map([["hello", "最初のメモ"]]);

const TOOLS = [
  {
    name: "note_list",
    description: "メモの一覧を返す",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "note_write",
    description: "メモを書く",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        text: { type: "string" },
      },
      required: ["key", "text"],
    },
  },
];

function call(name, args) {
  if (name === "note_list") {
    return (
      [...notes.entries()].map(([k, v]) => `${k}: ${v}`).join("\n") || "(空)"
    );
  }
  if (name === "note_write") {
    notes.set(args.key, args.text);
    return `${args.key} を書きました`;
  }
  throw new Error(`未知のツール: ${name}`);
}

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // 通知には応答しない

  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });

  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "notes", version: "0.1" },
      });
      break;
    case "tools/list":
      reply({ tools: TOOLS });
      break;
    case "tools/call":
      try {
        reply({
          content: [
            {
              type: "text",
              text: call(message.params.name, message.params.arguments ?? {}),
            },
          ],
        });
      } catch (error) {
        reply({
          content: [{ type: "text", text: error.message }],
          isError: true,
        });
      }
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `未知のメソッド: ${message.method}` },
      });
  }
});
