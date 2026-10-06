import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createHooks } from "../src/harness/index.js";
import type { HookSet } from "../src/hooks/index.js";
import type { PermissionSet } from "../src/permission/index.js";
import { createProfile } from "../src/profile/index.js";

const workspace = mkdtempSync(path.join(os.tmpdir(), "hma-harness-"));
writeFileSync(path.join(workspace, "a.txt"), "a\n");
after(() => rmSync(workspace, { recursive: true, force: true }));

function gate(
  options: {
    approval?: string;
    rules?: PermissionSet;
    hooks?: HookSet;
    asked?: string[];
  } = {},
) {
  const hooks = createHooks({
    profile: createProfile("coding", workspace),
    trusted: false,
    approval: options.approval ?? "ask",
    rules: options.rules ?? {},
    hooks: options.hooks ?? {},
    ask: async (request) => {
      options.asked?.push(request.name);
      return { approved: true };
    },
  });
  return (name: string, args: unknown) =>
    hooks.beforeToolCall?.({
      toolCallId: "t",
      name,
      arguments: JSON.stringify(args),
      messages: [],
      attempted: false,
      waitForRunning: async () => {},
    });
}

describe("createHooks の合成順", () => {
  it("外部フックの block は allow ルールより強い", async () => {
    const decide = gate({
      rules: { allow: ["bash"] },
      hooks: {
        PreToolUse: [{ command: "echo 止めた >&2; exit 2" }],
      },
    });
    const decision = await decide("bash", { command: "ls" });
    assert.equal(decision?.kind, "block");
  });

  it("読んでいないファイルの編集は、承認を聞く前に止める", async () => {
    const asked: string[] = [];
    const decide = gate({ asked });
    const decision = await decide("edit_file", {
      path: "a.txt",
      old_text: "a",
      new_text: "b",
    });
    assert.equal(decision?.kind, "block");
    assert.deepEqual(asked, []);
  });

  it("plan モードは edit を止める", async () => {
    const decision = await gate({ approval: "plan" })("write_file", {
      path: "b.txt",
      content: "b",
    });
    assert.equal(decision?.kind, "block");
  });

  it("ask に当たれば承認を聞き、承認されれば通す", async () => {
    const asked: string[] = [];
    const decision = await gate({ asked })("bash", { command: "ls" });
    assert.deepEqual(asked, ["bash"]);
    assert.notEqual(decision?.kind, "block");
  });
});

describe("外部フックの matcher は workspace 基準でパスを判定する", () => {
  const base = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "hma-hookpath-")),
  );
  const ws = path.join(base, "ws");
  mkdirSync(ws);
  writeFileSync(path.join(ws, ".env"), "KEY=1\n");
  symlinkSync(path.join(ws, ".env"), path.join(ws, "alias"));
  after(() => rmSync(base, { recursive: true, force: true }));

  const decide = (args: unknown) =>
    createHooks({
      profile: createProfile("coding", ws),
      trusted: false,
      approval: "auto",
      rules: {},
      hooks: {
        PreToolUse: [
          { matcher: "read_file(.env)", command: "echo 止めた >&2; exit 2" },
        ],
      },
      ask: async () => ({ approved: true }),
    }).beforeToolCall?.({
      toolCallId: "t",
      name: "read_file",
      arguments: JSON.stringify(args),
      messages: [],
      attempted: false,
      waitForRunning: async () => {},
    });

  for (const [label, p] of [
    ["書かれたとおり", ".env"],
    ["./ 付き", "./.env"],
    ["絶対パス", path.join(ws, ".env")],
    ["リンク越し", "alias"],
  ]) {
    it(`${label}でも発火して止める`, async () => {
      assert.equal((await decide({ path: p }))?.kind, "block");
    });
  }

  it("無関係なファイルでは発火しない", async () => {
    assert.notEqual((await decide({ path: "other.txt" }))?.kind, "block");
  });
});

describe("リンク先でだけ当たったフックの allow は採らない", () => {
  const base = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "hma-hookallow-")),
  );
  const ws = path.join(base, "ws");
  mkdirSync(path.join(ws, "docs"), { recursive: true });
  writeFileSync(path.join(ws, "docs", "a.md"), "a\n");
  symlinkSync(path.join(ws, "docs", "a.md"), path.join(ws, "alias"));
  after(() => rmSync(base, { recursive: true, force: true }));

  const decide = (command: string, p: string) =>
    createHooks({
      profile: createProfile("coding", ws),
      trusted: false,
      approval: "plan",
      rules: {},
      hooks: {
        PreToolUse: [{ matcher: "write_file(docs/*)", command }],
      },
      ask: async () => ({ approved: true }),
    }).beforeToolCall?.({
      toolCallId: "t",
      name: "write_file",
      arguments: JSON.stringify({ path: p, content: "x" }),
      messages: [],
      attempted: false,
      waitForRunning: async () => {},
    });

  const allow = `echo '{"decision":"allow"}'`;

  it("書いたままの位置で当たれば allow を採る", async () => {
    assert.equal((await decide(allow, "docs/a.md"))?.kind, "allow");
  });

  it("リンク先でだけ当たれば allow を採らず、通常の判定（plan で block）に回る", async () => {
    assert.equal((await decide(allow, "alias"))?.kind, "block");
  });

  it("リンク先でだけ当たっても block は効く", async () => {
    const decision = await decide("echo 止めた >&2; exit 2", "alias");
    assert.equal(decision?.kind, "block");
    assert.match(String((decision as { reason?: string }).reason), /止めた/);
  });
});
