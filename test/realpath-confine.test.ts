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
import { createSkillTools } from "../src/skills/index.js";

describe("リンクで workspace / スキルのディレクトリの外へ出られない", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "hma-confine-")));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  const skillDir = path.join(ws, ".hma", "skills", "x");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(ws, "src", "a.ts"), "inside");
  writeFileSync(path.join(outside, "secret"), "SECRET");
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: x\n---\nbody");
  writeFileSync(path.join(skillDir, "note.md"), "note");
  symlinkSync(outside, path.join(ws, "dir-link"));
  symlinkSync(path.join(outside, "secret"), path.join(ws, "file-link"));
  symlinkSync(path.join(outside, "missing"), path.join(ws, "dangling"));
  symlinkSync("a.ts", path.join(ws, "src", "inner-link"));
  symlinkSync(path.join(outside, "secret"), path.join(skillDir, "leak"));
  after(() => rmSync(base, { recursive: true, force: true }));

  const files = createFileTools(ws);
  const call = (name: string, input: Record<string, unknown>) =>
    files.execute(name, input);

  it("workspace 内のファイルとリンクは通る", async () => {
    assert.equal(await call("read_file", { path: "src/a.ts" }), "inside");
    assert.equal(await call("read_file", { path: "src/inner-link" }), "inside");
  });

  it("外を指すリンクは読めない", async () => {
    assert.match(
      await call("read_file", { path: "file-link" }),
      /外にはアクセスできません/,
    );
    assert.match(
      await call("read_file", { path: "dir-link/secret" }),
      /外にはアクセスできません/,
    );
    assert.match(
      await call("list_files", { path: "dir-link" }),
      /外にはアクセスできません/,
    );
  });

  it("外を指すリンク越しに書けない（新規作成も、切れたリンクも）", async () => {
    assert.match(
      await call("write_file", { path: "dir-link/new.txt", content: "x" }),
      /外にはアクセスできません/,
    );
    assert.match(
      await call("write_file", { path: "dangling", content: "x" }),
      /外にはアクセスできません/,
    );
    assert.equal(existsSync(path.join(outside, "new.txt")), false);
    assert.equal(existsSync(path.join(outside, "missing")), false);
  });

  it("存在しないファイルの新規作成は親の realpath で確かめて通す", async () => {
    await call("write_file", { path: "src/new/b.ts", content: "ok" });
    assert.equal(await call("read_file", { path: "src/new/b.ts" }), "ok");
  });

  it("スキルのディレクトリ外を指すリンクは読めない", async () => {
    const skills = createSkillTools([
      { name: "x", description: "", dir: skillDir, source: "test" },
    ]);
    const read = (file?: string) =>
      skills.execute("skill", { name: "x", file });
    assert.equal(await read("note.md"), "note");
    assert.match(await read("leak"), /外は読めません/);
    assert.match(await read("../../../../../outside/secret"), /外は読めません/);
  });
});
