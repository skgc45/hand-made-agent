import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Entry } from "../src/agent/loop.js";
import { FileStore } from "../src/store/file.js";
import { SqliteStore } from "../src/store/sqlite.js";

const msg = (content: string) =>
  ({ kind: "message", message: { role: "user", content } }) as unknown as Entry;
const line = (content: string) => JSON.stringify(msg(content));

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hma-store-"));
  return { dir, file: path.join(dir, "t.jsonl"), store: new FileStore(dir) };
}

test("FileStore: 末尾の壊れた行は捨てて読める", async () => {
  const { file, store } = await setup();
  await fs.writeFile(file, `${line("a")}\n{"kind":"message","mess`);
  assert.deepEqual(await store.load("t"), [msg("a")]);
  assert.equal((await store.list()).length, 1);
});

test("FileStore: 途中の壊れた行はファイル名と行番号つきで失敗する", async () => {
  const { file, store } = await setup();
  await fs.writeFile(file, `${line("a")}\n{broken\n${line("b")}\n`);
  await assert.rejects(
    store.load("t"),
    (e: Error) => e.message.includes("t.jsonl") && e.message.includes("2 行目"),
  );
});

test("FileStore: 壊れた末尾の後の append は新しい壊れ行を作らない", async () => {
  const { file, store } = await setup();
  await fs.writeFile(file, `${line("a")}\n{"kind":"mess`);
  await store.append("t", msg("b"));
  assert.deepEqual(await store.load("t"), [msg("a"), msg("b")]);
});

test("FileStore: 改行だけ欠けた完全な行は残して append する", async () => {
  const { file, store } = await setup();
  await fs.writeFile(file, line("a"));
  await store.append("t", msg("b"));
  assert.deepEqual(await store.load("t"), [msg("a"), msg("b")]);
});

test("FileStore: 改行で終わる壊れた最終行は捨てずにエラーにする", async () => {
  const { file, store } = await setup();
  await fs.writeFile(file, `${line("a")}\n{broken\n`);
  await assert.rejects(store.load("t"), (e: Error) =>
    e.message.includes("2 行目"),
  );
  await assert.rejects(store.append("t", msg("b")).then(() => store.load("t")));
});

test("FileStore: 壊れたスレッドがあっても list は他を返す", async () => {
  const { dir, file, store } = await setup();
  await fs.writeFile(file, `${line("a")}\n{broken\n${line("b")}\n`);
  await store.append("ok", msg("c"));
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    const list = await store.list();
    assert.deepEqual(
      list.map((t) => t.threadId),
      ["ok"],
    );
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.ok(String(errors[0]).includes(dir));
});

test("SqliteStore: 別プロセスが書き込み中でも busy_timeout 内なら待って成功する", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hma-store-"));
  const file = path.join(dir, "db.sqlite");
  const store = new SqliteStore(file);
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       console.log("locked");
       setTimeout(() => db.exec("COMMIT"), 500);`,
      file,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  await store.append("t", msg("a"));
  assert.equal((await store.load("t")).length, 1);
  await once(child, "exit");
  await store.close();
});
