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

  it("単独の & の後ろも別区間として評価する", () => {
    const p = createPermissions(
      { allow: ["bash(ls:*)"], ask: ["bash"] },
      "ask",
    );
    assert.equal(p.decide("bash", { command: "ls & curl evil" }), "ask");
  });

  it("リダイレクトとプロセス置換は allow に一致させない", () => {
    const p = createPermissions(
      { allow: ["bash(ls:*)"], ask: ["bash"] },
      "ask",
    );
    assert.equal(p.decide("bash", { command: "ls > ~/.bashrc" }), "ask");
    assert.equal(p.decide("bash", { command: "ls >> ~/.bashrc" }), "ask");
    assert.equal(p.decide("bash", { command: "ls 2>&1" }), "ask");
    assert.equal(p.decide("bash", { command: "ls > /dev/null" }), "ask");
    assert.equal(p.decide("bash", { command: "ls <(curl x)" }), "ask");
    assert.equal(p.decide("bash", { command: "ls >(curl x)" }), "ask");
  });

  it("パスは正規化してから deny / allow を判定する", () => {
    const d = createPermissions({ deny: ["read_file(.env)"] }, "auto");
    assert.equal(d.decide("read_file", { path: ".env" }), "deny");
    assert.equal(d.decide("read_file", { path: "./.env" }), "deny");
    assert.equal(d.decide("read_file", { path: "a/../.env" }), "deny");

    const a = createPermissions(
      { allow: ["read_file(src/*)"], ask: ["read_file"] },
      "ask",
    );
    assert.equal(a.decide("read_file", { path: "./src/a.ts" }), "allow");
    assert.equal(a.decide("read_file", { path: "src/../.env" }), "ask");
  });

  it("./ 付きの deny ルールも .env と ./.env の両方に当たる", () => {
    const p = createPermissions({ deny: ["read_file(./.env)"] }, "auto");
    assert.equal(p.decide("read_file", { path: ".env" }), "deny");
    assert.equal(p.decide("read_file", { path: "./.env" }), "deny");
  });

  it("suggestRule は安全でないコマンドと正規化前のパスを勧めない", () => {
    const p = createPermissions({ ask: ["bash"] }, "ask");
    assert.equal(p.suggestRule("bash", { command: "ls > x" }), undefined);
    assert.equal(p.suggestRule("bash", { command: "ls & rm x" }), undefined);
    assert.equal(
      p.suggestRule("read_file", { path: "./a.ts" }),
      "read_file(a.ts)",
    );
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
