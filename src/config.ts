import OpenAI from "openai";

export const BASE_URL =
  process.env.LLM_BASE_URL ??
  "https://generativelanguage.googleapis.com/v1beta/openai/";
export const API_KEY =
  process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
export const MODEL = process.env.LLM_MODEL ?? "gemini-3.8-flash";
export const CONTEXT_LIMIT = Number(process.env.CONTEXT_LIMIT ?? 0);
export const TRIM = process.env.TRIM ?? "none";
export const PORT = Number(process.env.PORT ?? 3000);
export const APPROVAL = process.env.APPROVAL ?? "ask";
/** エージェントが触れる唯一の場所。相対パスは起動時の cwd から解決される */
export const WORKSPACE = process.env.WORKSPACE ?? "sandbox";
export const STREAM = process.env.STREAM !== "0";
export const STORE = process.env.STORE ?? "sqlite";
export const STORE_PATH =
  process.env.STORE_PATH ??
  (STORE === "sqlite" ? ".threads/agent.db" : ".threads");

export const SYSTEM = `あなたはファイル操作ができるアシスタントです。
作業対象は ${WORKSPACE} の中だけです。
ユーザーには日本語で答えてください。

ツールの使い方:
- 質問に答えられる情報が揃った時点で、追加の確認をせずに答えること。
- 同じことを別のコマンドで数え直さないこと。
- 集計が目的のときは、生データをそのまま出力せず、集計まで済ませたコマンドを一度で組むこと。`;

export function createClient(): OpenAI {
  if (!API_KEY) {
    console.error("GEMINI_API_KEY が設定されていません。");
    console.error("https://aistudio.google.com/apikey で取得して:");
    console.error("  export GEMINI_API_KEY=...");
    process.exit(1);
  }
  return new OpenAI({
    apiKey: API_KEY,
    baseURL: BASE_URL,
    maxRetries: 0,
    timeout: 120_000,
  });
}
