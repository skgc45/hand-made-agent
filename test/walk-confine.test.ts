import assert from "node:assert/strict";
import {
  existsSync,
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
import { createFileTools } from "../src/agent/tools.js";

describe("grep / glob / 深い新規作成 / ループするリンク", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "hma-walk-")));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(path.join(ws, "in.txt"), "SECRET inside");
  writeFileSync(path.join(outside, "secret"), "SECRET outside");
  symlinkSync(path.join(outside, "secret"), path.join(ws, "fl"));
  symlinkSync(outside, path.join(ws, "dl"));
  symlinkSync("loop-b", path.join(ws, "loop-a"));
  symlinkSync("loop-a", path.join(ws, "loop-b"));
  after(() => rmSync(base, { recursive: true, force: true }));

  const files = createFileTools(ws);

  it("grep は外を指すリンクの中身を返さない", async () => {
    const out = await files.execute("grep", {
      pattern: "SECRET",
      glob: "**/*",
    });
    assert.match(out, /in\.txt:1/);
    assert.doesNotMatch(out, /outside|fl:|dl\//);
  });

  it("glob は外を指すリンクを列挙しない", async () => {
    const out = await files.execute("glob", { pattern: "**/*" });
    assert.match(out, /in\.txt/);
    assert.doesNotMatch(out, /^fl$|^dl/m);
  });

  it("存在しない成分が 40 個を超えても外に書けない", async () => {
    const deep = Array.from({ length: 45 }, (_, i) => `d${i}`).join("/");
    const out = await files.execute("write_file", {
      path: `dl/${deep}/x.txt`,
      content: "x",
    });
    assert.match(out, /外にはアクセスできません/);
    assert.equal(existsSync(path.join(outside, "d0")), false);
  });

  it("ループするリンクは安全に失敗する", async () => {
    const out = await files.execute("read_file", { path: "loop-a" });
    assert.match(out, /^エラー/);
    const w = await files.execute("write_file", {
      path: "loop-a",
      content: "x",
    });
    assert.match(w, /^エラー/);
  });
});
