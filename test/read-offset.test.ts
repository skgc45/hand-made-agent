import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createFileTools } from "../src/agent/tools.js";

describe("read_file の offset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hma-read-offset-"));
  await writeFile(path.join(dir, "a.txt"), "1\n2\n3\n4", "utf-8");
  await writeFile(path.join(dir, "b.txt"), "1\n2\n3\n", "utf-8");
  const tools = createFileTools(dir);

  it("指定した行から最後まで返す", async () => {
    assert.equal(
      await tools.execute("read_file", { path: "a.txt", offset: 3 }),
      "3\n4",
    );
  });

  it("省略や 1 以下なら全体", async () => {
    assert.equal(
      await tools.execute("read_file", { path: "a.txt" }),
      "1\n2\n3\n4",
    );
    assert.equal(
      await tools.execute("read_file", { path: "a.txt", offset: 0 }),
      "1\n2\n3\n4",
    );
  });

  it("末尾が改行で終わるファイルも、最後の行までが範囲", async () => {
    assert.equal(
      await tools.execute("read_file", { path: "b.txt", offset: 3 }),
      "3\n",
    );
    assert.match(
      await tools.execute("read_file", { path: "b.txt", offset: 4 }),
      /行数 3 を超えています/,
    );
  });

  it("行数を超えればそう伝える", async () => {
    assert.match(
      await tools.execute("read_file", { path: "a.txt", offset: 9 }),
      /行数 4 を超えています/,
    );
  });
});
