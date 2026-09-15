import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { composeAfter } from "../src/agent/compose.js";
import { Agent } from "../src/agent/loop.js";
import type { Toolset } from "../src/agent/toolset.js";
import { readBeforeEdit, truncateResult } from "../src/harness/files.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toolCall(id: string, name: string, args: unknown) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 1回目は tool_calls、2回目以降はただのテキストを返す */
function fakeClient(calls: OpenAI.ChatCompletionMessageToolCall[]): OpenAI {
  let turns = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          turns++;
          return {
            choices: [
              {
                message:
                  turns === 1
                    ? { role: "assistant", content: null, tool_calls: calls }
                    : { role: "assistant", content: "done" },
              },
            ],
          };
        },
      },
    },
  };
  return client as unknown as OpenAI;
}

function slowToolset(log: string[]): Toolset {
  return {
    tools: [],
    async execute(name, input) {
      const { id, ms } = input as { id: string; ms: number };
      log.push(`start:${id}`);
      await sleep(ms);
      log.push(`end:${id}`);
      return `${name}:${id}`;
    },
  };
}

async function drain(agent: Agent, text: string) {
  for await (const _ of agent.run(text)) {
    // イベントは使わない。messages の形だけ見る
  }
}

function base(client: OpenAI, toolset: Toolset) {
  return {
    client,
    model: "fake",
    system: "test",
    toolset,
    contextLimit: 100000,
    trim: "none",
    stream: false,
  };
}

describe("ツールの並列実行", () => {
  it("実行は重なるが、結果は tool_calls の順に積む", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 60 }),
      toolCall("c2", "slow", { id: "b", ms: 10 }),
      toolCall("c3", "slow", { id: "c", ms: 30 }),
    ];
    const log: string[] = [];
    const client = fakeClient(calls);
    const agent = new Agent(base(client, slowToolset(log)));

    await drain(agent, "go");

    assert.deepEqual(log.slice(0, 3), ["start:a", "start:b", "start:c"]);
    assert.deepEqual(log.slice(3), ["end:b", "end:c", "end:a"]);

    const results = agent.messages.flatMap((m) =>
      m.role === "tool" ? [[m.tool_call_id, m.content]] : [],
    );
    assert.deepEqual(results, [
      ["c1", "slow:a"],
      ["c2", "slow:b"],
      ["c3", "slow:c"],
    ]);
  });

  it("承認は重ならない。1件ずつ順に聞く", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 40 }),
      toolCall("c2", "slow", { id: "b", ms: 40 }),
      toolCall("c3", "slow", { id: "c", ms: 40 }),
    ];
    const log: string[] = [];
    const client = fakeClient(calls);
    let asking = 0;
    const agent = new Agent({
      ...base(client, slowToolset(log)),
      beforeToolCall: async (context) => {
        assert.equal(asking, 0, "承認が同時に2件出ている");
        asking++;
        log.push(`ask:${context.toolCallId}`);
        await sleep(20);
        asking--;
        return undefined;
      },
    });

    await drain(agent, "go");

    assert.deepEqual(
      log.filter((l) => l.startsWith("ask:")),
      ["ask:c1", "ask:c2", "ask:c3"],
    );
  });

  it("block されたツールは走らず、結果は元の位置に入る", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 10 }),
      toolCall("c2", "slow", { id: "b", ms: 10 }),
    ];
    const log: string[] = [];
    const client = fakeClient(calls);
    const agent = new Agent({
      ...base(client, slowToolset(log)),
      beforeToolCall: async (context) =>
        context.toolCallId === "c1"
          ? { kind: "block", reason: "だめ" }
          : undefined,
      afterToolCall: async (context) => ({
        content: `[${context.blocked ? "blocked" : "ran"}] ${context.result}`,
      }),
    });

    await drain(agent, "go");

    assert.deepEqual(log, ["start:b", "end:b"]);
    const results = agent.messages.flatMap((m) =>
      m.role === "tool" ? [m.content] : [],
    );
    assert.deepEqual(results, ["[blocked] だめ", "[ran] slow:b"]);
  });
});

/** read_file / edit_file を実ファイルでやる最小の toolset。編集は read-modify-write */
function fileToolset(root: string, log: string[]): Toolset {
  return {
    tools: [],
    async execute(name, input) {
      const {
        path: rel,
        from,
        to,
      } = input as {
        path: string;
        from?: string;
        to?: string;
      };
      const file = path.join(root, rel);
      if (name === "read_file") {
        log.push(`read:${rel}`);
        return await fs.readFile(file, "utf-8");
      }
      log.push(`edit:${rel}`);
      const before = await fs.readFile(file, "utf-8");
      // 読んでから書くまでの窓。直列化されていないと、ここで他方の書き込みを踏み潰す
      await sleep(20);
      await fs.writeFile(file, before.replace(String(from), String(to)));
      return "ok";
    },
  };
}

async function workspace(content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hma-parallel-"));
  await fs.writeFile(path.join(root, "a.txt"), content);
  return root;
}

function guarded(root: string, client: OpenAI, toolset: Toolset): Agent {
  const guard = readBeforeEdit(root);
  return new Agent({
    ...base(client, toolset),
    beforeToolCall: guard.before,
    afterToolCall: guard.after,
  });
}

function toolResults(agent: Agent): string[] {
  return agent.messages.flatMap((m) =>
    m.role === "tool" ? [String(m.content)] : [],
  );
}

describe("並列実行とファイルの書き換え", () => {
  it("同じバッチの read_file → edit_file が通る", async () => {
    const root = await workspace("hello\n");
    const calls = [
      toolCall("c1", "read_file", { path: "a.txt" }),
      toolCall("c2", "edit_file", { path: "a.txt", from: "hello", to: "bye" }),
    ];
    const log: string[] = [];
    const agent = guarded(root, fakeClient(calls), fileToolset(root, log));

    await drain(agent, "go");

    // 逐次なら通っていた組み合わせ。edit の判定が read の記録より先に走ると弾かれる
    assert.deepEqual(toolResults(agent), ["hello\n", "ok"]);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf-8"), "bye\n");
  });

  it("同じファイルへの edit_file 2件で、どちらの編集も消えない", async () => {
    const root = await workspace("1\n2\n");
    const calls = [
      toolCall("c1", "read_file", { path: "a.txt" }),
      toolCall("c2", "edit_file", { path: "a.txt", from: "1", to: "ONE" }),
      toolCall("c3", "edit_file", { path: "a.txt", from: "2", to: "TWO" }),
    ];
    const log: string[] = [];
    const agent = guarded(root, fakeClient(calls), fileToolset(root, log));

    await drain(agent, "go");

    // 重なると read-modify-write が踏み合って、片方が成功を返したまま消える
    assert.equal(
      await fs.readFile(path.join(root, "a.txt"), "utf-8"),
      "ONE\nTWO\n",
    );
    assert.deepEqual(log, ["read:a.txt", "edit:a.txt", "edit:a.txt"]);
  });
});

describe("並列実行のときの壊れた入力と復元", () => {
  it("壊れた arguments が1件あっても、他のツールの結果は積まれる", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 10 }),
      {
        id: "c2",
        type: "function" as const,
        function: { name: "slow", arguments: '{"id":"b",' },
      },
      toolCall("c3", "slow", { id: "c", ms: 10 }),
    ];
    const log: string[] = [];
    const agent = new Agent(base(fakeClient(calls), slowToolset(log)));

    await drain(agent, "go");

    const results = toolResults(agent);
    assert.equal(results.length, 3, "tool_calls と tool のペアが割れている");
    assert.equal(results[0], "slow:a");
    assert.match(results[1], /^エラー: 引数を JSON として読めません/);
    assert.equal(results[2], "slow:c");
  });

  it("並列化より前の pending を復元しても、済んだツールを再実行しない", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 10 }),
      toolCall("c2", "slow", { id: "b", ms: 10 }),
    ];
    const log: string[] = [];
    const agent = new Agent(base(fakeClient([]), slowToolset(log)));

    // done を持たない、index だけの pending（並列化より前の形）
    agent.replay([
      {
        kind: "message",
        message: { role: "assistant", content: null, tool_calls: calls },
      },
      {
        kind: "message",
        message: { role: "tool", tool_call_id: "c1", content: "slow:a" },
      },
      {
        kind: "pending",
        pending: {
          interruptId: "i1",
          calls,
          index: 1,
          terminateSoFar: false,
        },
      },
    ] as Parameters<Agent["replay"]>[0]);

    for await (const _ of agent.run("", "r1", [
      { interruptId: "i1", status: "resolved", payload: { approved: true } },
    ] as Parameters<Agent["run"]>[2]));

    assert.deepEqual(log, ["start:b", "end:b"], "c1 が再実行されている");
    const ids = agent.messages.flatMap((m) =>
      m.role === "tool" ? [m.tool_call_id] : [],
    );
    assert.deepEqual(ids, ["c1", "c2"], "tool_call_id が重複している");
  });
});

/** 指定した id のときだけ投げる toolset */
function flakyToolset(log: string[]): Toolset {
  return {
    tools: [],
    async execute(name, input) {
      const { id, ms, fail } = input as {
        id: string;
        ms: number;
        fail?: boolean;
      };
      log.push(`start:${id}`);
      await sleep(ms);
      if (fail) throw new Error(`${id} が落ちた`);
      log.push(`end:${id}`);
      return `${name}:${id}`;
    },
  };
}

describe("並列実行のときの例外", () => {
  it("ツールが投げても、同じバッチの他の結果は積まれる", async () => {
    const calls = [
      toolCall("c1", "flaky", { id: "a", ms: 10 }),
      toolCall("c2", "flaky", { id: "b", ms: 5, fail: true }),
      toolCall("c3", "flaky", { id: "c", ms: 10 }),
    ];
    const log: string[] = [];
    const agent = new Agent(base(fakeClient(calls), flakyToolset(log)));

    await drain(agent, "go");

    const results = toolResults(agent);
    assert.equal(results.length, 3, "tool_calls と tool のペアが割れている");
    assert.equal(results[0], "flaky:a");
    assert.equal(results[1], "エラー: b が落ちた");
    assert.equal(results[2], "flaky:c");
  });

  it("afterToolCall が投げても、ツールの結果は捨てない", async () => {
    const calls = [toolCall("c1", "slow", { id: "a", ms: 5 })];
    const log: string[] = [];
    const agent = new Agent({
      ...base(fakeClient(calls), slowToolset(log)),
      afterToolCall: async () => {
        throw new Error("フックのバグ");
      },
    });

    await drain(agent, "go");

    // 副作用はもう出ている。「失敗した」とだけ伝えるとモデルがやり直す
    const [result] = toolResults(agent);
    assert.match(result, /^slow:a\n/);
    assert.match(result, /afterToolCall が失敗しました: フックのバグ/);
  });

  it("Error でないものを投げても、メッセージが undefined にならない", async () => {
    const calls = [toolCall("c1", "slow", { id: "a", ms: 5 })];
    const agent = new Agent({
      ...base(fakeClient(calls), {
        tools: [],
        async execute() {
          throw "ただの文字列";
        },
      }),
    });

    await drain(agent, "go");

    assert.deepEqual(toolResults(agent), ["エラー: ただの文字列"]);
  });
});

describe("並列実行と read の順序", () => {
  it("書き換え中のファイルは、書き終わってから読む", async () => {
    const root = await workspace("1\n2\n");
    const calls = [
      toolCall("c1", "read_file", { path: "a.txt" }),
      toolCall("c2", "edit_file", { path: "a.txt", from: "1", to: "ONE" }),
      toolCall("c3", "read_file", { path: "a.txt" }),
    ];
    const log: string[] = [];
    const agent = guarded(root, fakeClient(calls), fileToolset(root, log));

    await drain(agent, "go");

    // 重なると c3 は書き換え前の中身を返すのに、after は書き換え後の mtime を覚える。
    // 次のターンの write_file がそれを「最新を読んだ」と見なして先行の編集を消す
    assert.deepEqual(toolResults(agent), ["1\n2\n", "ok", "ONE\n2\n"]);
  });

  it("いまの形の pending を復元しても、済んだツールだけを飛ばす", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 10 }),
      toolCall("c2", "slow", { id: "b", ms: 10 }),
    ];
    const log: string[] = [];
    const agent = new Agent(base(fakeClient([]), slowToolset(log)));

    agent.replay([
      {
        kind: "message",
        message: { role: "assistant", content: null, tool_calls: calls },
      },
      {
        kind: "message",
        message: { role: "tool", tool_call_id: "c1", content: "slow:a" },
      },
      {
        kind: "pending",
        pending: {
          interruptId: "i1",
          calls,
          done: ["c1"],
          terminateSoFar: false,
        },
      },
    ] as Parameters<Agent["replay"]>[0]);

    for await (const _ of agent.run("", "r1", [
      { interruptId: "i1", status: "resolved", payload: { approved: true } },
    ] as Parameters<Agent["run"]>[2]));

    assert.deepEqual(log, ["start:b", "end:b"]);
    const ids = agent.messages.flatMap((m) =>
      m.role === "tool" ? [m.tool_call_id] : [],
    );
    assert.deepEqual(ids, ["c1", "c2"]);
  });
});

/** ファイル操作と、ファイルに触らない slow を混ぜた toolset */
function mixedToolset(root: string, log: string[]): Toolset {
  return {
    tools: [],
    async execute(name, input) {
      const {
        path: rel,
        from,
        to,
        id,
        ms,
        text,
      } = input as {
        path?: string;
        from?: string;
        to?: string;
        id?: string;
        ms?: number;
        text?: string;
      };
      if (name === "slow") {
        log.push(`start:${id}`);
        await sleep(Number(ms));
        log.push(`end:${id}`);
        return `slow:${id}`;
      }
      const file = path.join(root, String(rel));
      if (name === "read_file") {
        const body = await fs.readFile(file, "utf-8").catch(() => "(無い)");
        log.push(`read:${body.replace(/\n/g, "")}`);
        return body;
      }
      if (name === "write_file") {
        await sleep(40);
        await fs.writeFile(file, String(text));
        log.push("wrote");
        return "ok";
      }
      const before = await fs.readFile(file, "utf-8");
      await sleep(20);
      await fs.writeFile(file, before.replace(String(from), String(to)));
      log.push("edited");
      return "ok";
    },
  };
}

describe("並列実行で待つ範囲", () => {
  it("同じファイルに触らないツールは、編集と重なったままでいい", async () => {
    const root = await workspace("1\n2\n");
    const calls = [
      toolCall("c1", "read_file", { path: "a.txt" }),
      toolCall("c2", "edit_file", { path: "a.txt", from: "1", to: "ONE" }),
      toolCall("c3", "slow", { id: "x", ms: 200 }),
      toolCall("c4", "read_file", { path: "a.txt" }),
    ];
    const log: string[] = [];
    const agent = guarded(root, fakeClient(calls), mixedToolset(root, log));

    await drain(agent, "go");

    // c4 が待つのは同じファイルを書いている c2 だけ。無関係な c3 は待たない
    assert.ok(
      log.indexOf("read:ONE2") < log.indexOf("end:x"),
      `無関係な slow を待ち切っている: ${log.join(" ")}`,
    );
  });

  it("新規作成中のファイルも、書き終わってから読む", async () => {
    const root = await workspace("dummy");
    const calls = [
      toolCall("c1", "write_file", { path: "new.txt", text: "できた" }),
      toolCall("c2", "read_file", { path: "new.txt" }),
    ];
    const log: string[] = [];
    const agent = guarded(root, fakeClient(calls), mixedToolset(root, log));

    await drain(agent, "go");

    // 待たないと read は ENOENT を返すのに、after は書き込み後の更新時刻を覚える。
    // モデルが中身を見ていないまま、次の edit_file が通ってしまう
    assert.deepEqual(log, ["wrote", "read:できた"]);
  });
});

describe("並列実行とフックの失敗", () => {
  it("afterToolCall が投げても、後ろのフックの切り詰めは効く", async () => {
    const calls = [toolCall("c1", "big", { id: "a", ms: 0 })];
    const agent = new Agent({
      ...base(fakeClient(calls), {
        tools: [],
        async execute() {
          return Array.from({ length: 500 }, (_, i) => `行 ${i}`).join("\n");
        },
      }),
      // 実際の合成順と同じ。いちばん外側の外部フックが投げる
      afterToolCall: composeAfter([
        truncateResult(),
        async () => {
          throw new Error("PostToolUse のバグ");
        },
      ]),
    });

    await drain(agent, "go");

    const [result] = toolResults(agent);
    assert.match(result, /長すぎるので切りました/);
    assert.ok(result.split("\n").length < 310, "切り詰めが効いていない");
    assert.match(result, /afterToolCall が失敗しました: PostToolUse のバグ/);
  });

  it("beforeToolCall が投げても、走っているツールの結果は捨てない", async () => {
    const calls = [
      toolCall("c1", "slow", { id: "a", ms: 30 }),
      toolCall("c2", "slow", { id: "b", ms: 10 }),
    ];
    const log: string[] = [];
    const agent = new Agent({
      ...base(fakeClient(calls), slowToolset(log)),
      beforeToolCall: async (context) => {
        if (context.toolCallId === "c2") throw new Error("PreToolUse のバグ");
        return undefined;
      },
    });

    await drain(agent, "go");

    const results = toolResults(agent);
    assert.equal(results.length, 2, "tool_calls と tool のペアが割れている");
    assert.equal(results[0], "slow:a");
    assert.match(
      results[1],
      /beforeToolCall が失敗しました: PreToolUse のバグ/,
    );
  });
});
