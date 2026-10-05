import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hintSeconds } from "../src/agent/loop.js";

describe("hintSeconds", () => {
  it("秒だけのヒント", () => {
    assert.equal(hintSeconds("Please retry in 12.5s."), 12.5);
  });

  it("時間と分を含むヒント（日ごとの上限）", () => {
    assert.equal(
      hintSeconds("Please retry in 9h18m10.052373026s."),
      9 * 3600 + 18 * 60 + 10.052373026,
    );
  });

  it("分と秒", () => {
    assert.equal(hintSeconds("retry in 2m3s"), 123);
  });

  it("ミリ秒を分と読まない", () => {
    assert.equal(hintSeconds("Please retry in 500ms."), 0.5);
    assert.equal(hintSeconds("retry in 1m500ms"), 60.5);
  });

  it("ヒントが無ければ undefined", () => {
    assert.equal(hintSeconds("Rate limit exceeded"), undefined);
    assert.equal(hintSeconds("retry in soon"), undefined);
  });
});

describe("日ごとの上限の 429", () => {
  it("何時間も先を指すヒントなら、リトライせずに RUN_ERROR で終える", async () => {
    const { default: OpenAI } = await import("openai");
    const { Agent } = await import("../src/agent/loop.js");
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            throw new OpenAI.RateLimitError(
              429,
              undefined,
              "Quota exceeded. Please retry in 9h18m10s.",
              new Headers(),
            );
          },
        },
      },
    } as unknown as InstanceType<typeof OpenAI>;
    const agent = new Agent({
      client,
      model: "fake",
      system: "test",
      toolset: { tools: [], execute: async () => "" },
      contextLimit: 0,
      trim: "none",
      stream: false,
    });
    const names: string[] = [];
    for await (const event of agent.run("hi")) {
      names.push(event.type === "CUSTOM" ? event.name : event.type);
    }
    assert.equal(calls, 1);
    assert.ok(!names.includes("retry"));
    assert.ok(names.includes("RUN_ERROR"));
  });
});
