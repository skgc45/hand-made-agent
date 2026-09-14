import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hits,
  parseRule,
  splitCommand,
  subjectsOf,
} from "../src/permission/rules.js";

describe("parseRule", () => {
  it("ツール名だけを読む", () => {
    assert.deepEqual(parseRule("bash"), { tool: "bash", pattern: undefined });
  });

  it("括弧の中をパターンとして読む", () => {
    assert.deepEqual(parseRule("bash(pnpm test:*)"), {
      tool: "bash",
      pattern: "pnpm test:*",
    });
  });

  it("書式が不正なら投げる", () => {
    assert.throws(() => parseRule("bash(unclosed"));
  });
});

describe("splitCommand", () => {
  it("&& || ; | と改行で切る", () => {
    assert.deepEqual(splitCommand("a && b || c ; d | e\nf"), [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });
});

describe("subjectsOf", () => {
  it("command は区間ごとに分ける", () => {
    assert.deepEqual(subjectsOf({ command: "pnpm test && rm -rf /" }), [
      { kind: "command", value: "pnpm test" },
      { kind: "command", value: "rm -rf /" },
    ]);
  });

  it("command が無ければ path を見る", () => {
    assert.deepEqual(subjectsOf({ path: "src/a.ts" }), [
      { kind: "path", value: "src/a.ts" },
    ]);
  });
});

describe("hits", () => {
  const rule = parseRule("bash(pnpm test:*)");
  const command = (value: string) => ({ kind: "command" as const, value });

  it(":* は前方一致する", () => {
    assert.equal(hits(rule, "bash", command("pnpm test --watch")), true);
  });

  it(":* は引数が無くても当たる", () => {
    assert.equal(hits(rule, "bash", command("pnpm test")), true);
  });

  it(":* は語の途中では切らない", () => {
    assert.equal(hits(rule, "bash", command("pnpm tests")), false);
  });

  it("パターン無しのルールはツール名だけで当たる", () => {
    assert.equal(hits(parseRule("bash"), "bash", command("whatever")), true);
  });

  it("ツール名が違えば当たらない", () => {
    assert.equal(hits(rule, "read_file", command("pnpm test")), false);
  });

  it("末尾 * はツール名の前方一致", () => {
    assert.equal(
      hits(parseRule("mcp__fs__*"), "mcp__fs__read_file", undefined),
      true,
    );
    assert.equal(
      hits(parseRule("mcp__fs__*"), "mcp__git__status", undefined),
      false,
    );
  });

  it("path は glob で当てる", () => {
    const glob = parseRule("read_file(src/**/*.ts)");
    const at = (value: string) => ({ kind: "path" as const, value });
    assert.equal(hits(glob, "read_file", at("src/a/b.ts")), true);
    assert.equal(hits(glob, "read_file", at("src/a/b.js")), false);
  });
});
