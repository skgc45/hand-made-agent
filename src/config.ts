import OpenAI from "openai";

export const BASE_URL =
  process.env.LLM_BASE_URL ??
  "https://generativelanguage.googleapis.com/v1beta/openai/";
export const API_KEY =
  process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
export const MODEL = process.env.LLM_MODEL ?? "gemini-3.5-flash-lite";
export const CONTEXT_LIMIT = Number(process.env.CONTEXT_LIMIT ?? 0);
export const TRIM = process.env.TRIM ?? "none";
export const PORT = Number(process.env.PORT ?? 3000);
export const APPROVAL = process.env.APPROVAL ?? "ask";
/** エージェントが触れる唯一の場所。相対パスは起動時の cwd から解決される */
export const WORKSPACE = process.env.WORKSPACE ?? "sandbox";
export const PROFILE = process.env.PROFILE ?? "sandbox";
export const STREAM = process.env.STREAM !== "0";
export const STORE = process.env.STORE ?? "sqlite";
export const STORE_PATH =
  process.env.STORE_PATH ??
  (STORE === "sqlite" ? ".threads/agent.db" : ".threads");



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
