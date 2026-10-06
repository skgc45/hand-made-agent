import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "../src/agent/loop.js";
import { MemoryStore } from "../src/store/memory.js";
import { conflictOfContinue, latestThreadId } from "../src/thread-select.js";

const msg = (content: string) =>
  ({ kind: "message", message: { role: "user", content } }) as unknown as Entry;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("updatedAt が最も新しいスレッドを選ぶ", async () => {
  const store = new MemoryStore();
  await store.append("old", msg("a"));
  await sleep(5);
  await store.append("new", msg("b"));
  await sleep(5);
  await store.append("old", msg("c"));
  assert.equal(await latestThreadId(store), "old");
  await sleep(5);
  await store.append("new", msg("d"));
  assert.equal(await latestThreadId(store), "new");
});

test("スレッドが無ければ undefined", async () => {
  assert.equal(await latestThreadId(new MemoryStore()), undefined);
});

test("--continue は --thread / --new と同時に指定できない", () => {
  assert.match(
    conflictOfContinue({ continue: true, thread: "x" }) ?? "",
    /--thread/,
  );
  assert.match(
    conflictOfContinue({ continue: true, new: true }) ?? "",
    /--new/,
  );
  assert.equal(conflictOfContinue({ continue: true }), undefined);
  assert.equal(conflictOfContinue({ thread: "x", new: true }), undefined);
});
