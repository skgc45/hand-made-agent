import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
