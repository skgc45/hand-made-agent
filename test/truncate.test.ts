import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, it } from "node:test";
import type { ToolResultContext } from "../src/agent/loop.js";
import { truncateResult } from "../src/harness/files.js";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `行 ${i + 1}`).join("\n");

function context(name: string, result: string, args = "{}"): ToolResultContext {
  return {
    toolCallId: "c1",
    name,
    arguments: args,
    messages: [],
    result,
    blocked: false,
  };
}

describe("ツール結果の切り詰め", () => {
  it("bash は末尾 300行を残し、省いた行数を先頭に書く", async () => {
    const out = await truncateResult()(context("bash", lines(400)));

    assert.ok(out?.content);
    const [notice, ...kept] = out.content.split("\n");
    assert.match(notice, /先頭 100 行を省きました/);
    assert.equal(kept.length, 300);
    assert.equal(kept[0], "行 101");
    assert.equal(kept.at(-1), "行 400");
  });

  it("bash は全文を一時ファイルに書き、パスを添える", async () => {
    const full = lines(400);
    const out = await truncateResult()(context("bash", full));

    assert.ok(out?.content);
    const file = out.content.match(/全文は (\S+)。/)?.[1];
    assert.ok(file?.startsWith(os.tmpdir()));
    if (!file) return;
    assert.equal(await fs.readFile(file, "utf8"), full);
    assert.doesNotMatch(out.content, /read_file/);
  });

  it("bash を文字数で切っても、先頭の半端な行は残さない", async () => {
    const line = (i: number) =>
      `${String(i).padStart(3, "0")}${"x".repeat(96)}`;
    const body = Array.from({ length: 250 }, (_, i) => line(i + 1)).join("\n");
    const out = await truncateResult()(context("bash", body));

    assert.ok(out?.content);
    const kept = out.content.split("\n").slice(1);
    assert.ok(kept.every((l) => l.length === 99));
    assert.ok(kept.join("\n").length <= 15000);
    assert.equal(kept.at(-1), line(250));
  });

  it("失敗したコマンドの exit 行は、先頭を省いても残す", async () => {
    const out = await truncateResult()(
      context("bash", `exit 1\n${lines(400)}`),
    );

    assert.ok(out?.content);
    const [exit, notice, ...kept] = out.content.split("\n");
    assert.equal(exit, "exit 1");
    assert.match(notice, /先頭 100 行を省きました/);
    assert.equal(kept.at(-1), "行 400");
  });

  it("全文は本人だけが読めるファイルに書く", async () => {
    const out = await truncateResult()(context("bash", lines(400)));

    const file = /全文は (\S+?)。/.exec(out?.content ?? "")?.[1];
    assert.ok(file);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });

  it("全文を書けなくても、末尾を残して返す", async () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = "/nonexistent/hma-test";
    try {
      const out = await truncateResult()(context("bash", lines(400)));
      assert.ok(out?.content);
      assert.match(out.content, /全文は保存できませんでした/);
      assert.equal(out.content.split("\n").at(-1), "行 400");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("read_file は 300行では切らない", async () => {
    const out = await truncateResult()(context("read_file", lines(400)));

    assert.equal(out, undefined);
  });

  it("read_file も 2000行を超えれば切る。続きの読み方を案内する", async () => {
    const out = await truncateResult()(context("read_file", lines(2500)));

    assert.ok(out?.content);
    assert.match(out.content, /残り 500 行/);
    assert.match(out.content, /read_file に offset: 2001 を渡す/);
  });

  it("文字数で切っても、案内する行番号は半端な行を指さない", async () => {
    // 2500行 × 99文字。行数より先に文字数の上限に当たる
    const body = Array.from({ length: 2500 }, () => "x".repeat(99)).join("\n");
    const out = await truncateResult()(context("read_file", body));

    assert.ok(out?.content);
    const kept = out.content.split("\n").slice(0, -1);
    // 半端な行を残すと、その行の残りがどうやっても読めなくなる
    assert.ok(
      kept.every((line) => line.length === 99),
      "行の途中で切れている",
    );
    assert.match(out.content, new RegExp(`offset: ${kept.length + 1} を渡す`));
    assert.match(out.content, new RegExp(`残り ${2500 - kept.length} 行`));
  });

  it("offset から読んだ結果を切ったときは、ファイルの行番号で案内する", async () => {
    const out = await truncateResult()(
      context("read_file", lines(2500), '{"path":"a.ts","offset":2001}'),
    );

    assert.ok(out?.content);
    assert.match(out.content, /read_file に offset: 4001 を渡す/);
  });

  it("1行が長いファイルは、行ではなく文字で案内する", async () => {
    const out = await truncateResult()(
      context("read_file", "あ".repeat(90000)),
    );

    assert.ok(out?.content);
    assert.equal(out.content.split("\n")[0].length, 80000);
    // 「残り 0 行」と言われても続きの読みようがない
    assert.match(out.content, /残り 10000 文字/);
    assert.match(out.content, /tail -c \+80001/);
  });
});
