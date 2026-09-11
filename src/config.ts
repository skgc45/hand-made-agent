import OpenAI from "openai";
import { loadSettings } from "./settings/index.js";

const { settings, files } = loadSettings();

/** 実際に読めた設定ファイル。起動時のバナーに出す */
export const SETTINGS_FILES = files;

export const BASE_URL =
  process.env.LLM_BASE_URL ??
  settings.baseUrl ??
  "https://generativelanguage.googleapis.com/v1beta/openai/";
/** 鍵だけは設定ファイルから読まない。共有される場所に書く習慣を作らないため */
export const API_KEY =
  process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
export const MODEL =
  process.env.LLM_MODEL ?? settings.model ?? "gemini-3.5-flash-lite";
export const CONTEXT_LIMIT = Number(
  process.env.CONTEXT_LIMIT ?? settings.contextLimit ?? 0,
);
export const TRIM = process.env.TRIM ?? settings.trim ?? "none";
export const PORT = Number(process.env.PORT ?? settings.port ?? 3000);
export const APPROVAL = process.env.APPROVAL ?? settings.approval ?? "ask";
/** エージェントが触れる唯一の場所。相対パスは起動時の cwd から解決される */
export const WORKSPACE =
  process.env.WORKSPACE ?? settings.workspace ?? "sandbox";
export const PROFILE = process.env.PROFILE ?? settings.profile ?? "sandbox";
export const STREAM =
  process.env.STREAM !== undefined
    ? process.env.STREAM !== "0"
    : (settings.stream ?? true);
export const TELEMETRY =
  process.env.TELEMETRY ?? settings.telemetry ?? "none";
export const TELEMETRY_URL =
  process.env.TELEMETRY_URL ??
  settings.telemetryUrl ??
  "http://hma:hma@localhost:8123/?database=hma";
export const STORE = process.env.STORE ?? settings.store ?? "sqlite";
export const STORE_PATH =
  process.env.STORE_PATH ??
  settings.storePath ??
  (STORE === "sqlite" ? ".threads/agent.db" : ".threads");
/** 設定ファイル由来の権限ルール。プロファイルの既定とマージして使う */
export const PERMISSIONS = settings.permissions ?? {};

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
