import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AgentCustomEvent, custom } from "../src/agent/events.js";

describe("custom", () => {
  it("name と value の型がずれるとコンパイルが通らない", () => {
    // @ts-expect-error promptTokens を改名した値は usage に渡せない
    custom("usage", { prompt_tokens: 1 });
    // @ts-expect-error 未登録の name は作れない
    custom("unknown", {});

    const kept = (event: AgentCustomEvent) => {
      // @ts-expect-error name で絞る前は kept に触れない
      event.value.kept;
      return event.name === "trim" ? event.value.kept : undefined;
    };
    assert.equal(
      kept(custom("trim", { strategy: "safe", removed: 1, kept: 2 })),
      2,
    );
  });

  it("wire の形は AG-UI の CUSTOM のまま", () => {
    assert.deepEqual(custom("steering", { messages: ["a"] }), {
      type: "CUSTOM",
      name: "steering",
      value: { messages: ["a"] },
    });
  });
});
