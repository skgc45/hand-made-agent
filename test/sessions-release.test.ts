import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import type { AgentEvent } from "../src/agent/loop.js";
import type { JobQueue } from "../src/agent/subagent.js";
import type { Toolset } from "../src/agent/toolset.js";
import type { Profile } from "../src/profile/index.js";
import { Sessions } from "../src/session/index.js";
import { MemoryStore } from "../src/store/memory.js";

const client = {
  chat: {
    completions: {
      create: async () => ({
        choices: [{ message: { role: "assistant", content: "done" } }],
      }),
    },
  },
} as unknown as OpenAI;

const toolset: Toolset = {
  tools: [],
  async execute() {
    return "";
  },
};

function make(maxLive: number, jobs?: JobQueue) {
  const store = new MemoryStore();
  const sessions = new Sessions({
    client,
    model: "fake",
    profile: { name: "test", system: "test", toolset } as unknown as Profile,
    contextLimit: 100000,
    trim: "none",
    stream: false,
    store,
    jobs,
    maxLive,
  });
  return { sessions, store };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const recovered = (events: AgentEvent[]) =>
  events.filter((e) => e.type === "CUSTOM" && e.name === "recovered").length;

describe("Sessions の LRU", () => {
  it("上限を超えたら、最も長く使われていないものから手放す", async () => {
    const { sessions } = make(2);
    await drain(sessions.run("a", "x"));
    await drain(sessions.run("b", "x"));
    await drain(sessions.run("a", "x"));
    await drain(sessions.run("c", "x"));
    assert.deepEqual(sessions.retainedIds(), ["a", "c"]);
    assert.equal(sessions.retained().queues, 2);
  });

  it("threadId を変えて何度呼んでも上限を超えない", async () => {
    const { sessions } = make(3);
    for (let i = 0; i < 20; i++) await drain(sessions.run(`t${i}`, "x"));
    assert.deepEqual(sessions.retained(), { live: 3, queues: 3, stopAsked: 0 });
  });

  it("手放したスレッドの次の run は store から復元する", async () => {
    const { sessions, store } = make(1);
    await drain(sessions.run("a", "1回目"));
    await drain(sessions.run("b", "x"));
    assert.deepEqual(sessions.retainedIds(), ["b"]);

    await drain(sessions.run("a", "2回目"));
    const users = (await store.load("a")).filter(
      (e) => e.kind === "message" && e.message.role === "user",
    );
    assert.equal(users.length, 2);
  });

  it("走っている run とキューが残るものは手放さない", async () => {
    const { sessions } = make(1);
    const gen = sessions.run("a", "x");
    await gen.next();
    await drain(sessions.run("b", "x"));
    assert.deepEqual(sessions.retainedIds(), ["a"]);
    await drain(gen);

    const first = sessions.run("c", "x");
    await first.next();
    assert.equal(sessions.steer("c", "残り", "followUp"), true);
    await first.return(undefined);
    await drain(sessions.run("d", "x"));
    assert.deepEqual(sessions.retainedIds(), ["c"]);
  });

  it("background の子が走っているあいだは手放さない", async () => {
    let running = 1;
    const jobs = {
      poll: () => [],
      settle: async () => [],
      running: () => running,
      stop: async () => {},
    } as JobQueue;
    const { sessions } = make(1, jobs);
    await drain(sessions.run("a", "x"));
    await drain(sessions.run("b", "x"));
    assert.deepEqual(sessions.retainedIds(), ["a", "b"]);

    running = 0;
    await drain(sessions.run("c", "x"));
    assert.deepEqual(sessions.retainedIds(), ["c"]);
  });

  it("不正な threadId では queues を作らない", async () => {
    const { sessions } = make(2);
    await assert.rejects(sessions.get("../evil"));
    assert.equal(sessions.retained().queues, 0);
  });

  it("同じスレッドを続けて使っても recovered は一度しか出ない", async () => {
    const { sessions, store } = make(2);
    await store.append("a", {
      kind: "message",
      message: { role: "user", content: "x" },
    });
    await store.append("a", {
      kind: "message",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "echo", arguments: "{}" },
          },
        ],
      },
    });
    const first = await drain(sessions.run("a", "続き"));
    const second = await drain(sessions.run("a", "もう一度"));
    assert.equal(recovered(first), 1);
    assert.equal(recovered(second), 0);
  });
});
