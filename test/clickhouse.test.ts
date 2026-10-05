import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ClickHouseTelemetry } from "../src/telemetry/clickhouse.js";
import type { TelemetryRow } from "../src/telemetry/index.js";

const row = (n: number) => ({ content: `row${n}` }) as unknown as TelemetryRow;

type Call = { sql: string; body?: string };

describe("ClickHouseTelemetry", () => {
  const realFetch = globalThis.fetch;
  let calls: Call[];
  let fail: (call: Call) => boolean;
  let status = 503;
  let delayMs = 0;
  let hang = false;

  beforeEach(() => {
    calls = [];
    done.length = 0;
    fail = () => false;
    status = 503;
    delayMs = 0;
    hang = false;
    mock.method(console, "error", () => {});
    globalThis.fetch = (async (url: URL, init?: RequestInit) => {
      const call = {
        sql: new URL(url).searchParams.get("query") ?? "",
        body: init?.body as string | undefined,
      };
      calls.push(call);
      if (hang)
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          ),
        );
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (call.sql.startsWith("INSERT")) done.push(call);
      return fail(call)
        ? new Response("down", { status: status })
        : new Response("");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    mock.restoreAll();
  });

  const done: Call[] = [];
  const inserts = () => calls.filter((c) => c.sql.startsWith("INSERT"));
  const ddls = () => calls.filter((c) => c.sql.includes("CREATE TABLE"));
  const make = (max = 1000, batch = 1000, flushMs = 60_000, timeout = 10_000) =>
    new ClickHouseTelemetry(
      "http://localhost:8123",
      batch,
      flushMs,
      max,
      timeout,
    );
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("初回の DDL が失敗しても次の flush で DDL からやり直して送れる", async () => {
    const t = make();
    let down = true;
    fail = () => down;
    t.record(row(1));
    await t.flush();
    assert.equal(inserts().length, 0);

    down = false;
    await t.flush();
    assert.equal(ddls().length, 2);
    assert.equal(inserts().length, 1);
    assert.match(inserts()[0].body ?? "", /row1/);
  });

  it("INSERT に失敗した行は次の flush で送られる", async () => {
    const t = make();
    let down = false;
    fail = (c) => down && c.sql.startsWith("INSERT");
    t.record(row(1));
    down = true;
    await t.flush();

    down = false;
    t.record(row(2));
    await t.flush();
    const last = inserts().at(-1)?.body ?? "";
    assert.ok(last.includes("row1") && last.includes("row2"));
    assert.ok(last.indexOf("row1") < last.indexOf("row2"));
  });

  it("上限を超えたら古い行から捨てる", async () => {
    const t = make(3);
    fail = (c) => c.sql.startsWith("INSERT");
    for (let i = 1; i <= 5; i++) t.record(row(i));
    await t.flush();

    fail = () => false;
    await t.flush();
    const body = inserts().at(-1)?.body ?? "";
    assert.equal(body.split("\n").length, 3);
    assert.ok(!body.includes("row1") && !body.includes("row2"));
    assert.ok(body.includes("row5"));
  });

  it("close() は走っている flush の INSERT 完了を待つ", async () => {
    const t = make();
    delayMs = 50;
    t.record(row(1));
    void t.flush();
    await sleep(10);
    await t.close();
    assert.equal(done.length, 1);
  });

  it("障害中は batchSize を超えても record() が即座に送らず、タイマーで後から送る", async () => {
    const t = make(1000, 2, 40);
    fail = () => true;
    t.record(row(1));
    t.record(row(2));
    await sleep(10);
    const before = calls.length;
    for (let i = 3; i < 10; i++) t.record(row(i));
    await sleep(10);
    assert.equal(calls.length, before);

    fail = () => false;
    await sleep(150);
    assert.equal(inserts().length, 1);
    assert.ok((inserts()[0].body ?? "").includes("row9"));
  });

  it("応答しない ClickHouse はタイムアウトし、後続の flush と close() を塞がない", async () => {
    const t = make(1000, 1000, 60_000, 30);
    hang = true;
    t.record(row(1));
    await t.flush();
    hang = false;
    await t.close();
    assert.equal(done.length, 1);
    assert.ok((done[0].body ?? "").includes("row1"));
  });

  it("4xx で拒否された行は戻さず、5xx は戻す", async () => {
    const t = make();
    fail = (c) => c.sql.startsWith("INSERT");
    status = 400;
    t.record(row(1));
    await t.flush();
    status = 503;
    t.record(row(2));
    await t.flush();

    fail = () => false;
    await t.flush();
    const body = inserts().at(-1)?.body ?? "";
    assert.ok(body.includes("row2") && !body.includes("row1"));
  });
});
