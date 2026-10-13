import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { composeUser } from "../src/agent/compose.js";
import type { AgentCustomEvent } from "../src/agent/events.js";
import { Agent } from "../src/agent/loop.js";
import type { Toolset } from "../src/agent/toolset.js";
import { compactHook } from "../src/commands/index.js";

const echo: Toolset = {
  tools: [],
  async execute(_name, input) {
    return JSON.stringify(input);
  },
};

type Call = { role: string; content: string };

/** summarize 呼び出し（INSTRUCTION で始まる）と、普通のターンを区別して記録する */
function fakeClient(summaries: Call[][], turns: string[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: { messages: Call[] }) => {
          if (params.messages[0].content.startsWith("会話ログを要約する")) {
            summaries.push(params.messages);
            return {
              choices: [{ message: { content: "要約済み" } }],
              usage: { prompt_tokens: 100, completion_tokens: 10 },
            };
          }
          turns.push(params.messages.at(-1)?.content ?? "");
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: `回答${turns.length}`,
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  } as unknown as OpenAI;
}

function newAgent(client: OpenAI): Agent {
  return new Agent({
    client,
    model: "fake",
    system: "test",
    toolset: echo,
    contextLimit: 100000,
    trim: "none",
    stream: false,
    beforeUserMessage: composeUser([compactHook()]),
  });
}

function compactEvent(events: unknown[]): AgentCustomEvent["value"] {
  const found = events.find(
    (e) =>
      (e as { type: string }).type === "CUSTOM" &&
      (e as AgentCustomEvent).name === "compact",
  ) as AgentCustomEvent | undefined;
  assert.ok(found, "compact イベントが出ていない");
  return found.value;
}

describe("手動 /compact", () => {
  it("直前の1ターンだけ残し、それより前を要約する。ターンは消費しない", async () => {
    const summaries: Call[][] = [];
    const turns: string[] = [];
    const agent = newAgent(fakeClient(summaries, turns));

    for await (const _ of agent.run("質問1")) void _;
    for await (const _ of agent.run("質問2")) void _;

    const events = [];
    for await (const event of agent.run("/compact")) events.push(event);

    assert.equal(turns.length, 2, "/compact はモデルのターンを消費しない");
    assert.equal(summaries.length, 1);

    const value = compactEvent(events) as { dropped: number; summary: string };
    assert.equal(value.dropped, 2, "質問1のユーザー発言とその応答の2件");
    assert.equal(value.summary, "要約済み");

    assert.deepEqual(
      agent.messages.map((m) => m.content),
      ["test\n\n## これまでの経緯\n要約済み", "質問2", "回答2"],
    );
  });

  it("指示を summarize プロンプトに渡す", async () => {
    const summaries: Call[][] = [];
    const turns: string[] = [];
    const agent = newAgent(fakeClient(summaries, turns));

    for await (const _ of agent.run("質問1")) void _;
    for await (const _ of agent.run("質問2")) void _;
    for await (const _ of agent.run("/compact 数値だけ残して")) void _;

    const userMessage = summaries[0].find((m) => m.role === "user");
    assert.match(
      userMessage?.content ?? "",
      /要約で特に重視すること: 数値だけ残して/,
    );
  });

  it("指示が無ければ重視事項の行を入れない", async () => {
    const summaries: Call[][] = [];
    const turns: string[] = [];
    const agent = newAgent(fakeClient(summaries, turns));

    for await (const _ of agent.run("質問1")) void _;
    for await (const _ of agent.run("質問2")) void _;
    for await (const _ of agent.run("/compact")) void _;

    const userMessage = summaries[0].find((m) => m.role === "user");
    assert.doesNotMatch(userMessage?.content ?? "", /要約で特に重視すること/);
  });

  it("落とすものが無ければ要約を呼ばずに終わる", async () => {
    const summaries: Call[][] = [];
    const turns: string[] = [];
    const agent = newAgent(fakeClient(summaries, turns));

    const events = [];
    for await (const event of agent.run("/compact")) events.push(event);

    assert.equal(summaries.length, 0);
    assert.equal(turns.length, 0);
    const value = compactEvent(events) as { dropped: number };
    assert.equal(value.dropped, 0);
  });
});
