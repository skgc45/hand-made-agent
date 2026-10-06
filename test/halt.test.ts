import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { Agent, type AgentEvent, type Entry } from "../src/agent/loop.js";
import type { Toolset } from "../src/agent/toolset.js";
import type { Profile } from "../src/profile/index.js";
import { Sessions } from "../src/session/index.js";
import { MemoryStore } from "../src/store/memory.js";

const call = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "wait", arguments: JSON.stringify({ id }) },
});

type Sent = OpenAI.ChatCompletionMessageParam[];

function client(sent: Sent[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: { messages: Sent }) => {
          sent.push(structuredClone(params.messages));
          const first = sent.length === 1;
          return {
            choices: [
              {
                message: first
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [call("a"), call("b")],
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

function unanswered(messages: Sent): string[] {
  const answered = new Set(
    messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
  );
  return messages.flatMap((m) =>
    m.role === "assistant"
      ? (m.tool_calls ?? []).map((c) => c.id).filter((id) => !answered.has(id))
      : [],
  );
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

class FlakyStore extends MemoryStore {
  failOn?: (entry: Entry) => boolean;
  async append(threadId: string, entry: Entry): Promise<void> {
    if (this.failOn?.(entry)) throw new Error("disk full");
    return super.append(threadId, entry);
  }
}

function setup() {
  const aborted: string[] = [];
  const started: string[] = [];
  const toolset: Toolset = {
    tools: [],
    async execute(_name, input, signal) {
      const id = (input as { id: string }).id;
      started.push(id);
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 200);
      });
      if (signal?.aborted) aborted.push(id);
      return `done:${id}`;
    },
  };
  const sent: Sent[] = [];
  const store = new FlakyStore();
  const sessions = new Sessions({
    client: client(sent),
    model: "fake",
    profile: { name: "t", system: "t", toolset } as unknown as Profile,
    contextLimit: 100000,
    trim: "none",
    stream: false,
    store,
  });
  return { sessions, store, sent, aborted, started };
}

describe("保存の失敗で止まった Agent", () => {
  it("並列の2件目の attempt が落ちたら、1件目に abort が届き、次の run は store から作り直す", async () => {
    const { sessions, store, sent, aborted, started } = setup();
    store.failOn = (e) => e.kind === "attempt" && e.toolCallId === "b";

    const events = await drain(sessions.run("t1", "go"));
    assert.equal(events.at(-1)?.type, "RUN_ERROR");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(started, ["a"]);
    assert.deepEqual(aborted, ["a"]);
    assert.equal(sessions.retained().live, 0, "halted な Agent は手放す");

    store.failOn = undefined;
    const next = await drain(sessions.run("t1", "続き"));
    assert.ok(!next.some((e) => e.type === "RUN_ERROR"));
    assert.deepEqual(unanswered(sent.at(-1) ?? []), []);
  });

  it("halted な Agent に run が来たらエラーにする", async () => {
    const store = new FlakyStore();
    store.failOn = () => true;
    const agent = new Agent({
      client: client([]),
      model: "fake",
      system: "t",
      toolset: { tools: [], execute: async () => "" },
      contextLimit: 100000,
      trim: "none",
      stream: false,
      append: (e) => store.append("t", e),
    });
    await drain(agent.run("x"));
    assert.equal(agent.halted, true);
    await assert.rejects(drain(agent.run("y")), /使えません/);
  });

  it("承認待ちの pending の保存が落ちたら RUN_ERROR で止まり、作り直せる", async () => {
    const { store, sent } = setup();
    store.failOn = (e) => e.kind === "pending" && e.pending !== null;
    const gated = new Sessions({
      client: client(sent),
      model: "fake",
      profile: {
        name: "t",
        system: "t",
        toolset: { tools: [], execute: async () => "x" },
      } as unknown as Profile,
      contextLimit: 100000,
      trim: "none",
      stream: false,
      store,
      beforeToolCall: async () => ({
        kind: "suspend",
        interrupt: { reason: "tool_call", message: "ok?" } as never,
      }),
    });
    const events = await drain(gated.run("t3", "go"));
    assert.equal(events.at(-1)?.type, "RUN_ERROR");
    assert.equal(gated.retained().live, 0);

    store.failOn = undefined;
    sent.length = 0;
    const next = await drain(gated.run("t3", "続き"));
    assert.ok(next.length > 0);
    assert.deepEqual(unanswered(sent.at(-1) ?? []), []);
  });
});
