import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { Agent } from "../src/agent/loop.js";
import type { Toolset } from "../src/agent/toolset.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toolCall(id: string, name: string, args: unknown) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 1回目は tool_calls、2回目以降はただのテキストを返す */
function fakeClient(calls: OpenAI.ChatCompletionMessageToolCall[]): OpenAI {
  let turns = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          turns++;
          return {
            choices: [
              {
                message:
                  turns === 1
                    ? { role: "assistant", content: null, tool_calls: calls }
                    : { role: "assistant", content: "done" },
              },
            ],
          };
        },
      },
    },
  };
  return client as unknown as OpenAI;
}

function slowToolset(log: string[]): Toolset {
  return {
    tools: [],
    async execute(name, input) {
      const { id, ms } = input as { id: string; ms: number };
      log.push(`start:${id}`);
      await sleep(ms);
      log.push(`end:${id}`);
      return `${name}:${id}`;
    },
  };
}

async function drain(agent: Agent, text: string) {
  for await (const _ of agent.run(text)) {
    // イベントは使わない。messages の形だけ見る
  }
}

function base(client: OpenAI, toolset: Toolset) {
  return {
    client,
    model: "fake",
    system: "test",
    toolset,
    contextLimit: 100000,
    trim: "none",
    stream: false,
  };
}

describe("ツールの並列実行", () => {
  it("実行は重なるが、結果は tool_calls の順に積む", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 60 }),
      toolCall("c2", "slow", { id: "b", ms: 10 }),
      toolCall("c3", "slow", { id: "c", ms: 30 }),
    ];
    const log: string[] = [];
    const client = fakeClient(calls);
    const agent = new Agent(base(client, slowToolset(log)));

    await drain(agent, "go");

    assert.deepEqual(log.slice(0, 3), ["start:a", "start:b", "start:c"]);
    assert.deepEqual(log.slice(3), ["end:b", "end:c", "end:a"]);

    const results = agent.messages.flatMap((m) =>
      m.role === "tool" ? [[m.tool_call_id, m.content]] : [],
    );
    assert.deepEqual(results, [
      ["c1", "slow:a"],
      ["c2", "slow:b"],
      ["c3", "slow:c"],
    ]);
  });

  it("承認は重ならない。1件ずつ順に聞く", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 40 }),
      toolCall("c2", "slow", { id: "b", ms: 40 }),
      toolCall("c3", "slow", { id: "c", ms: 40 }),
    ];
    const log: string[] = [];
    const client = fakeClient(calls);
    let asking = 0;
    const agent = new Agent({
      ...base(client, slowToolset(log)),
      beforeToolCall: async (context) => {
        assert.equal(asking, 0, "承認が同時に2件出ている");
        asking++;
        log.push(`ask:${context.toolCallId}`);
        await sleep(20);
        asking--;
        return undefined;
      },
    });

    await drain(agent, "go");

    assert.deepEqual(
      log.filter((l) => l.startsWith("ask:")),
      ["ask:c1", "ask:c2", "ask:c3"],
    );
  });

  it("block されたツールは走らず、結果は元の位置に入る", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 10 }),
      toolCall("c2", "slow", { id: "b", ms: 10 }),
    ];
    const log: string[] = [];
    const client = fakeClient(calls);
    const agent = new Agent({
      ...base(client, slowToolset(log)),
      beforeToolCall: async (context) =>
        context.toolCallId === "c1"
          ? { kind: "block", reason: "だめ" }
          : undefined,
      afterToolCall: async (context) => ({
        content: `[${context.blocked ? "blocked" : "ran"}] ${context.result}`,
      }),
    });

    await drain(agent, "go");

    assert.deepEqual(log, ["start:b", "end:b"]);
    const results = agent.messages.flatMap((m) =>
      m.role === "tool" ? [m.content] : [],
    );
    assert.deepEqual(results, ["[blocked] だめ", "[ran] slow:b"]);
  });
});
