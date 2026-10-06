import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createPermissions } from "../src/permission/index.js";

describe("パスの deny は workspace 基準とリンク先で判定する", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "hma-perm-")));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(ws, "secrets"), { recursive: true });
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(ws, ".env"), "KEY=1");
  writeFileSync(path.join(ws, "secrets", "a"), "x");
  writeFileSync(path.join(ws, "src", "a.ts"), "x");
  writeFileSync(path.join(outside, "file"), "x");
  symlinkSync("../.env", path.join(ws, "src", "env-link"));
  symlinkSync("../secrets", path.join(ws, "src", "dir-link"));
  symlinkSync(path.join(outside, "file"), path.join(ws, "src", "out-link"));
  symlinkSync(path.join(ws, ".env"), path.join(ws, "src", "abs-link"));
  after(() => rmSync(base, { recursive: true, force: true }));

  const deny = createPermissions(
    { deny: ["read_file(.env)", "read_file(secrets/**)"] },
    "auto",
    ws,
  );
  const decide = (p: string) => deny.decide("read_file", { path: p });

  it("workspace 内を指す絶対パスにも当たる", () => {
    assert.equal(decide(path.join(ws, ".env")), "deny");
    assert.equal(decide(path.join(ws, "secrets", "a")), "deny");
    assert.equal(decide(path.join(ws, "src", "..", ".env")), "deny");
    assert.equal(decide("./.env"), "deny");
    assert.equal(decide("src/../.env"), "deny");
    assert.equal(decide(path.join(ws, "src", "a.ts")), "allow");
  });

  it("リンクの先が deny に当たれば止める", () => {
    assert.equal(decide("src/env-link"), "deny");
    assert.equal(decide("src/abs-link"), "deny");
    assert.equal(decide("src/dir-link/a"), "deny");
    assert.equal(decide("src/dir-link/new-file"), "deny");
  });

  it("allow はリンク先が allow に当たらないと効かない", () => {
    const p = createPermissions(
      { allow: ["read_file(src/*)"], ask: ["read_file"] },
      "ask",
      ws,
    );
    assert.equal(p.decide("read_file", { path: "src/a.ts" }), "allow");
    assert.equal(p.decide("read_file", { path: "src/out-link" }), "ask");
    assert.equal(p.decide("read_file", { path: "src/env-link" }), "ask");
  });

  it("workspace の外の絶対パスは絶対のまま判定する", () => {
    const p = createPermissions(
      { deny: [`read_file(${path.join(outside, "*")})`] },
      "auto",
      ws,
    );
    assert.equal(
      p.decide("read_file", { path: path.join(outside, "file") }),
      "deny",
    );
    assert.equal(p.decide("read_file", { path: "src/out-link" }), "deny");
  });
});
