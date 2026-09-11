import { createFileTools } from "../agent/tools.js";
import type { Profile } from "./index.js";

/** ステップ1〜7 で使ってきた、sandbox を眺めるアシスタント */
export function sandbox(workspace: string): Profile {
  return {
    name: "sandbox",
    workspace,
    toolset: createFileTools(workspace),
    permissions: { ask: ["bash"] },
    system: `あなたはファイル操作ができるアシスタントです。
作業対象は ${workspace} の中だけです。
ユーザーには日本語で答えてください。

答え方:
- 質問に答えられる情報が揃った時点で、追加の確認をせずに答えること。
- 同じことを別のコマンドで数え直さないこと。
- 集計が目的のときは、生データをそのまま出力せず、集計まで済ませたコマンドを一度で組むこと。`,
  };
}
