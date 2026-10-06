import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventType } from "@ag-ui/core";
import type OpenAI from "openai";
import type { AgentEvent } from "../src/agent/loop.js";
import { withSubagents } from "../src/agent/subagent.js";
import { createProfile } from "../src/profile/index.js";

const deps = {
  client: () => ({}) as OpenAI,
  model: "m",
  contextLimit: 1000,
  trim: "none",
  hooks: {},
};

const custom = (name: string): AgentEvent => ({
  type: EventType.CUSTOM,
  name,
  value: {},
});

describe("withSubagents", () => {
  it("内側の drain を捨てず、内側 → 自分の順で返す", () => {
    const base = createProfile("sandbox", process.cwd());
    const inner = {
      ...base,
      toolset: { ...base.toolset, drain: () => [custom("inner")] },
    };
    const { profile } = withSubagents(inner, deps);
    const names = (profile.toolset.drain?.() ?? []).map((e) =>
      "name" in e ? e.name : "",
    );
    assert.deepEqual(names, ["inner"]);
  });

  it("内側に drain が無くても動く", () => {
    const base = createProfile("sandbox", process.cwd());
    const { profile } = withSubagents(
      { ...base, toolset: { ...base.toolset, drain: undefined } },
      deps,
    );
    assert.deepEqual(profile.toolset.drain?.(), []);
  });

  it("system は元の末尾に空行を挟んで道具の選び方が付く", () => {
    const base = createProfile("sandbox", process.cwd());
    const { profile } = withSubagents(base, deps);
    assert.ok(profile.system.startsWith(`${base.system}\n\n道具の選び方:\n`));
  });
});
