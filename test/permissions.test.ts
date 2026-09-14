import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPermissions } from "../src/permission/index.js";

describe("createPermissions", () => {
  it("deny は auto モードでも止める", () => {
    const p = createPermissions({ deny: ["bash(rm:*)"] }, "auto");
    assert.equal(p.decide("bash", { command: "rm -rf /" }), "deny");
    assert.equal(p.decide("bash", { command: "ls" }), "allow");
  });

  it("deny は allow より強い", () => {
    const p = createPermissions(
      { deny: ["read_file(.env)"], allow: ["read_file"] },
      "ask",
    );
    assert.equal(p.decide("read_file", { path: ".env" }), "deny");
  });

  it("どのルールにも当たらなければ通す", () => {
    const p = createPermissions({ ask: ["bash"] }, "ask");
    assert.equal(p.decide("read_file", { path: "a.ts" }), "allow");
  });

  it("連結コマンドは全区間が allow に当たったときだけ通す", () => {
    const p = createPermissions(
      { allow: ["bash(pnpm test:*)"], ask: ["bash"] },
      "ask",
    );
    assert.equal(p.decide("bash", { command: "pnpm test" }), "allow");
    assert.equal(
      p.decide("bash", { command: "pnpm test && rm -rf /" }),
      "ask",
      "allow に当たらない区間があれば通してはいけない",
    );
  });

  it("コマンド置換を含むものは allow に一致させない", () => {
    const p = createPermissions(
      { allow: ["bash(echo:*)"], ask: ["bash"] },
      "ask",
    );
    assert.equal(p.decide("bash", { command: "echo hi" }), "allow");
    assert.equal(p.decide("bash", { command: "echo $(whoami)" }), "ask");
    assert.equal(p.decide("bash", { command: "echo `whoami`" }), "ask");
  });

  it("allowForSession はそのプロセスの間だけ効く", () => {
    const p = createPermissions({ ask: ["bash"] }, "ask");
    assert.equal(p.decide("bash", { command: "git status" }), "ask");
    p.allowForSession("bash(git status)");
    assert.equal(p.decide("bash", { command: "git status" }), "allow");
  });

  it("APPROVAL に知らない値が来たら投げる", () => {
    assert.throws(() => createPermissions({}, "yolo"));
  });
});
