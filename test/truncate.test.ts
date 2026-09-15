import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResultContext } from "../src/agent/loop.js";
import { truncateResult } from "../src/harness/files.js";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `行 ${i + 1}`).join("\n");

function context(name: string, result: string): ToolResultContext {
  return {
    toolCallId: "c1",
    name,
    arguments: "{}",
    messages: [],
    result,
    blocked: false,
  };
}

describe("ツール結果の切り詰め", () => {
  it("bash は 300行で切る", async () => {
    const out = await truncateResult()(context("bash", lines(400)));

    assert.ok(out?.content);
    assert.match(out.content, /残り 100 行/);
    assert.match(out.content, /grep や bash で絞ってください/);
  });

  it("read_file は 300行では切らない", async () => {
    const out = await truncateResult()(context("read_file", lines(400)));

    assert.equal(out, undefined);
  });

  it("read_file も 2000行を超えれば切る。続きの読み方を案内する", async () => {
    const out = await truncateResult()(context("read_file", lines(2500)));

    assert.ok(out?.content);
    assert.match(out.content, /残り 500 行/);
    assert.match(out.content, /sed -n '2001,\$p'/);
  });

  it("行が短くても、文字数の上限で切る", async () => {
    const out = await truncateResult()(
      context("read_file", "あ".repeat(90000)),
    );

    assert.ok(out?.content);
    assert.equal(out.content.split("\n")[0].length, 80000);
  });
});
