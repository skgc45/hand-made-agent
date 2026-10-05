import assert from "node:assert/strict";
import { describe, it } from "node:test";
import OpenAI from "openai";
import { transcriptChunks } from "../src/agent/compact.js";
import { Agent } from "../src/agent/loop.js";
import type { Toolset } from "../src/agent/toolset.js";

function toolCall(id: string) {
  return {
    id,
    type: "function" as const,
    function: { name: "echo", arguments: JSON.stringify({ id }) },
  };
}

/** 渡された messages を控え、1回目だけ tool_calls を返す */
function recordingClient(sent: OpenAI.ChatCompletionMessageParam[][]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: {
          messages: OpenAI.ChatCompletionMessageParam[];
        }) => {
          sent.push(structuredClone(params.messages));
          return {
            choices: [
              {
                message:
                  sent.length === 1
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [toolCall("a"), toolCall("b")],
                      }
                    : { role: "assistant", content: "done" },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
}

const echo: Toolset = {
  tools: [],
  async execute(_name, input) {
    return JSON.stringify(input);
  },
};

function unanswered(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  const answered = new Set(
    messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
  );
  return messages.flatMap((m) =>
    m.role === "assistant"
      ? (m.tool_calls ?? []).map((c) => c.id).filter((id) => !answered.has(id))
      : [],
  );
}

describe("受け取る側が途中で抜けた run", () => {
  it("次の run に結果の無い tool_calls を持ち越さない", async () => {
    const sent: OpenAI.ChatCompletionMessageParam[][] = [];
    const agent = new Agent({
      client: recordingClient(sent),
      model: "fake",
      system: "test",
      toolset: echo,
      contextLimit: 100000,
      trim: "none",
      stream: false,
    });

    for await (const event of agent.run("1回目")) {
      if (event.type === "CUSTOM" && event.name === "gate") break;
    }

    const events = [];
    for await (const event of agent.run("2回目")) events.push(event);

    assert.deepEqual(unanswered(sent.at(-1) ?? []), []);
    assert.ok(
      events.some((e) => e.type === "CUSTOM" && e.name === "recovered"),
      "埋めたことを次の run の頭で知らせる",
    );
  });
});

describe("transcriptChunks", () => {
  const message = (content: string): OpenAI.ChatCompletionMessageParam => ({
    role: "user",
    content,
  });

  it("上限を超えたら分けるが、中身は落とさない", () => {
    const dropped = Array.from({ length: 30 }, (_, i) =>
      message(`${i}:${"x".repeat(1000)}`),
    );
    const chunks = transcriptChunks(dropped, 5000);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 5000));
    assert.equal(
      chunks.join("\n"),
      dropped.map((m) => `[user] ${m.content}`).join("\n"),
    );
  });

  it("1行が上限を超えるときだけ、その行を分ける", () => {
    const chunks = transcriptChunks([message("y".repeat(12000))], 5000);
    assert.deepEqual(
      chunks.map((c) => c.length),
      [5000, 5000, 2007],
    );
  });
});

describe("圧縮のリトライ", () => {
  it("要約が 429 を返しても、待ってやり直す", async () => {
    let summaries = 0;
    let turns = 0;
    const client = {
      chat: {
        completions: {
          create: async (params: {
            messages: { role: string; content: string }[];
          }) => {
            if (params.messages[0].content.startsWith("会話ログを要約する")) {
              summaries++;
              if (summaries === 1) {
                throw new OpenAI.RateLimitError(
                  429,
                  undefined,
                  "Please retry in 0s.",
                  new Headers(),
                );
              }
              return { choices: [{ message: { content: "要約" } }] };
            }
            turns++;
            return {
              choices: [
                { message: { role: "assistant", content: `答え${turns}` } },
              ],
              usage: { prompt_tokens: 10_000, completion_tokens: 1 },
            };
          },
        },
      },
    } as unknown as OpenAI;

    const agent = new Agent({
      client,
      model: "fake",
      system: "test",
      toolset: echo,
      contextLimit: 50,
      trim: "compact",
      stream: false,
    });

    const events = [];
    for (const text of [
      "1回目の質問です",
      "2回目の質問です",
      "3回目の質問です",
    ]) {
      for await (const event of agent.run(text)) events.push(event);
    }

    const names = events.flatMap((e) => (e.type === "CUSTOM" ? [e.name] : []));
    assert.ok(names.includes("retry"), "retry を出す");
    assert.ok(names.includes("compact"), "やり直して要約できた");
    assert.ok(!events.some((e) => e.type === "RUN_ERROR"));
  });
});
