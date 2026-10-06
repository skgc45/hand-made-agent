import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Call, touchedCalls } from "../src/eval/behavior.js";

const ROOT = "/ws";
const touched = (tool: string, args: Record<string, unknown>) =>
  touchedCalls(
    [{ tool, arguments: JSON.stringify(args) } satisfies Call],
    ["store"],
    ROOT,
  ).length > 0;

describe("touchedCalls", () => {
  it("explore への指示に範囲の名前が入っていても手出しではない", () => {
    assert.equal(touched("explore", { prompt: "store/ を調べて" }), false);
  });

  it("範囲の中を読めば手出し", () => {
    assert.equal(touched("list_files", { path: "store" }), true);
    assert.equal(touched("read_file", { path: "./store/sqlite.ts" }), true);
    assert.equal(touched("read_file", { path: "/ws/store/file.ts" }), true);
    assert.equal(touched("glob", { pattern: "store/**/*.ts" }), true);
    assert.equal(touched("grep", { pattern: "x", glob: "store/*.ts" }), true);
  });

  it("範囲の外や、範囲を含む全体を見るだけなら手出しではない", () => {
    assert.equal(touched("list_files", { path: "." }), false);
    assert.equal(touched("list_files", {}), false);
    assert.equal(
      touched("read_file", { path: "store/../agent/loop.ts" }),
      false,
    );
    assert.equal(touched("glob", { pattern: "**/*.ts" }), false);
    assert.equal(touched("grep", { pattern: "store" }), false);
    assert.equal(touched("read_file", { path: "storefront/a.ts" }), false);
  });

  it("bash はコマンドの語で見て、コメントは数えない", () => {
    assert.equal(touched("bash", { command: "ls -l store" }), true);
    assert.equal(
      touched("bash", { command: "cat agent/x.ts|grep a;wc -l store/file.ts" }),
      true,
    );
    assert.equal(
      touched("bash", { command: "# store の結果を待つ間に\nls agent" }),
      false,
    );
  });

  it("glob の先頭の **/ と {a,b} は展開して見る", () => {
    assert.equal(touched("glob", { pattern: "**/store/*.ts" }), true);
    assert.equal(touched("glob", { pattern: "{store,agent}/*.ts" }), true);
    assert.equal(touched("grep", { pattern: "x", glob: "**/store/**" }), true);
    assert.equal(touched("glob", { pattern: "{agent,transport}/*.ts" }), false);
  });

  it("..x という名前は範囲の外と取り違えない", () => {
    assert.equal(touched("read_file", { path: "store/..x/y" }), true);
  });

  it("引数がオブジェクトでなければ数えない", () => {
    for (const a of ["null", "[]", '"ls store"', "1"]) {
      assert.equal(
        touchedCalls([{ tool: "read_file", arguments: a }], ["store"], ROOT)
          .length,
        0,
      );
    }
  });

  it("引数が JSON でなければ数えない", () => {
    assert.equal(
      touchedCalls([{ tool: "read_file", arguments: "{" }], ["store"], ROOT)
        .length,
      0,
    );
  });
});
