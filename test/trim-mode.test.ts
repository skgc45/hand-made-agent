import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { Agent } from "../src/agent/loop.js";

describe("Agent の trim 検証", () => {
  it("未知の値は黙って safe にせず、分かるメッセージで投げる", () => {
    assert.throws(
      () =>
        new Agent({
          client: {} as OpenAI,
          model: "fake",
          system: "test",
          toolset: { tools: [], execute: async () => "" },
          contextLimit: 100,
          trim: "comapct",
        }),
      /comapct.*none \/ naive \/ safe \/ compact \/ graph/,
    );
  });
});
