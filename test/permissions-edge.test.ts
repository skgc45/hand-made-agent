import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createPermissions } from "../src/permission/index.js";

describe("workspace の外を指す相対パスの deny", () => {
  it("../ 付きの deny が ../ 付きのパスに当たる", () => {
    const p = createPermissions(
      { deny: ["read_file(../**)"] },
      "auto",
      "/ws/a",
    );
    assert.equal(p.decide("read_file", { path: "../secret" }), "deny");
    assert.equal(p.decide("read_file", { path: "src/a.ts" }), "allow");
  });
});

describe("ループするリンク", () => {
  it("権限判定で allow に当たらず ask になる", () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "hma-loop-")));
    try {
      symlinkSync("loop-b", path.join(base, "loop-a"));
      symlinkSync("loop-a", path.join(base, "loop-b"));
      const p = createPermissions(
        { allow: ["read_file(*)"], ask: ["read_file"] },
        "ask",
        base,
      );
      assert.equal(p.decide("read_file", { path: "loop-a" }), "ask");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
