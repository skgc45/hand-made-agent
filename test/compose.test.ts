import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeUser } from "../src/agent/compose.js";
import type { BeforeUserMessage } from "../src/agent/loop.js";
import { compactHook } from "../src/commands/index.js";

describe("composeUser と手動 /compact の合成（要素が2つ以上のときだけ通る本体のループ）", () => {
  it("同名のユーザー定義コマンドが /compact を展開しても、検出済みの compact が勝つ", async () => {
    // commandHook 相当。同じ `/compact` 名で本文を差し替えようとする
    const sameNameCommand: BeforeUserMessage = async (text) =>
      text.startsWith("/compact")
        ? { replace: "ユーザー定義の compact 本文" }
        : undefined;

    const hook = composeUser([compactHook(), sameNameCommand]);
    assert.deepEqual(await hook?.("/compact 数値だけ残して"), {
      compact: "数値だけ残して",
    });
  });

  it("外部フックの block は、検出済みの compact より後に来ても勝つ", async () => {
    const alwaysBlock: BeforeUserMessage = async () => ({
      blocked: "監査フックで止めた",
    });

    const hook = composeUser([compactHook(), alwaysBlock]);
    assert.deepEqual(await hook?.("/compact 急いで"), {
      blocked: "監査フックで止めた",
    });
  });

  it("/compact でない入力は、ほかのフックの replace / context がそのまま出る", async () => {
    const replacer: BeforeUserMessage = async (text) =>
      text === "/review" ? { replace: "差分を見る" } : undefined;
    const contextAdder: BeforeUserMessage = async () => ({
      context: "追加の文脈",
    });

    const hook = composeUser([compactHook(), replacer, contextAdder]);
    assert.deepEqual(await hook?.("/review"), {
      replace: "差分を見る",
      context: "追加の文脈",
    });
  });
});
