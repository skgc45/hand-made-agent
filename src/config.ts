import OpenAI from "openai";
import { HOOK_EVENTS, type HookSet } from "./hooks/index.js";
import type { PermissionSet } from "./permission/index.js";
import {
  type HookSource,
  type RuleSource,
  type Settings,
  loadSettings,
} from "./settings/index.js";
import { fingerprint, isTrusted, trustSubject } from "./settings/trust.js";

const { settings, files, sources, rules, hooks } = loadSettings();

/** 実際に読めた設定ファイル。起動時のバナーに出す */
export const SETTINGS_FILES = files;
/** 設定ファイル由来の権限ルール（出所つき）。hma config が出す */
export const SETTINGS_RULES: RuleSource[] = rules;
/** 同じくフック。どのファイルが刺したコマンドか */
export const SETTINGS_HOOKS: HookSource[] = hooks;

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
/**
 * .hma の中身のうち「緩める方向」のものだけ、初回に本人の確認を取る。
 * clone しただけのリポジトリのフックが、黙って自分の権限で走らないようにする
 */
export const TRUST_SUBJECT = trustSubject(hooks, rules);
export const TRUST_PRINT = fingerprint(TRUST_SUBJECT);
export const NEEDS_TRUST =
  (TRUST_SUBJECT.hooks.length > 0 || TRUST_SUBJECT.rules.length > 0) &&
  !isTrusted(TRUST_PRINT);

/** 信頼していないときは、締める方向（deny / ask）だけ残す */
export function permissionsFor(trusted: boolean): PermissionSet {
  const set: PermissionSet = {};
  for (const { action, rule, layer } of rules) {
    if (!trusted && layer !== "user" && action === "allow") continue;
    (set[action] ??= []).push(rule);
  }
  return set;
}

/** 信頼していないときは、本人の ~/.hma のフックだけ走らせる */
export function hooksFor(trusted: boolean): HookSet {
  const set: HookSet = {};
  for (const event of HOOK_EVENTS) {
    const list = hooks
      .filter((h) => h.event === event && (trusted || h.layer === "user"))
      .map((h) => h.hook);
    if (list.length > 0) set[event] = list;
  }
  return set;
}

export type ConfigRow = { name: string; value: string; source: string };

/** 実効値がどこから来たかを、優先順位（フラグ > 環境変数 > ファイル > 既定）のまま説明する */
export function describeConfig(overrides: {
  workspace?: string;
  profile?: string;
} = {}): ConfigRow[] {
  const from = (env: string, key: keyof Settings): string =>
    process.env[env] !== undefined
      ? `環境変数 ${env}`
      : (sources[key] ?? "既定");

  const row = (
    name: string,
    key: keyof Settings,
    value: unknown,
    override?: string,
  ): ConfigRow => ({
    name,
    value: String(value),
    source: override !== undefined ? "フラグ" : from(name, key),
  });

  return [
    row("LLM_MODEL", "model", MODEL),
    row("LLM_BASE_URL", "baseUrl", BASE_URL),
    {
      name: "GEMINI_API_KEY",
      value: API_KEY ? "（設定済み）" : "（未設定）",
      source: API_KEY ? "環境変数" : "既定",
    },
    row("PROFILE", "profile", overrides.profile ?? PROFILE, overrides.profile),
    row(
      "WORKSPACE",
      "workspace",
      overrides.workspace ?? WORKSPACE,
      overrides.workspace,
    ),
    row("APPROVAL", "approval", APPROVAL),
    row("TRIM", "trim", TRIM),
    row("CONTEXT_LIMIT", "contextLimit", CONTEXT_LIMIT),
    row("STREAM", "stream", STREAM),
    row("PORT", "port", PORT),
    row("STORE", "store", STORE),
    row("STORE_PATH", "storePath", STORE_PATH),
    row("TELEMETRY", "telemetry", TELEMETRY),
    row("TELEMETRY_URL", "telemetryUrl", TELEMETRY_URL),
  ];
}

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
