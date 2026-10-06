import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { withSubagents } from "../src/agent/subagent.js";
import { createProfile } from "../src/profile/index.js";

const deps = {
  client: () => ({}) as OpenAI,
  model: "m",
  contextLimit: 1000,
  trim: "none",
  hooks: {},
};

describe("withSubagents", () => {
  it("system は元の末尾に空行を挟んで道具の選び方が付く", () => {
    const base = createProfile("sandbox", process.cwd());
    const { profile } = withSubagents(base, deps);
    assert.ok(profile.system.startsWith(`${base.system}\n\n道具の選び方:\n`));
  });
});
