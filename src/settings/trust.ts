import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type HookSource,
  loadSettings,
  type McpSource,
  type RuleSource,
} from "./index.js";

const FILE = path.join(os.homedir(), ".hma", "trust.json");

/**
 * 信頼が要るのは「緩める方向」のものだけ。
 * フックは任意のコマンドを自分の権限で走らせ、allow は承認を外す。
 * deny と ask は締める方向なので、信頼が無くても効かせる
 */
export function trustSubject(
  hooks: HookSource[],
  rules: RuleSource[],
  mcp: McpSource[] = [],
): { hooks: HookSource[]; rules: RuleSource[]; mcp: McpSource[] } {
  return {
    hooks: hooks.filter((h) => h.layer !== "user"),
    rules: rules.filter((r) => r.layer !== "user" && r.action === "allow"),
    // MCP サーバはフックと同じく、本人の権限で任意のコマンドを起動する
    mcp: mcp.filter((m) => m.layer !== "user"),
  };
}

export function fingerprint(subject: ReturnType<typeof trustSubject>): string {
  const canonical = JSON.stringify([
    subject.hooks.map((h) => [
      h.event,
      h.hook.matcher ?? "",
      h.hook.command,
      h.hook.timeout ?? 0,
    ]),
    subject.rules.map((r) => r.rule),
    // env も起動の中身。NODE_OPTIONS だけ書き換えても任意のコードが走る
    subject.mcp.map((m) => [
      m.name,
      m.config.command,
      ...(m.config.args ?? []),
      Object.entries(m.config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** プロジェクトは絶対パスで区別する。同じ内容でも別の場所なら聞き直す */
function projectKey(): string {
  return path.resolve(".");
}

function read(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function isTrusted(print: string): boolean {
  return read()[projectKey()] === print;
}

export async function recordTrust(print: string): Promise<void> {
  const all = { ...read(), [projectKey()]: print };
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, `${JSON.stringify(all, null, 2)}\n`, "utf-8");
}

function currentPrint(): string {
  const { hooks, rules, mcp } = loadSettings();
  return fingerprint(trustSubject(hooks, rules, mcp));
}

/**
 * 本人の [s]ave で指紋が変わったとき、信頼を追随させる。
 * 保存の直前に信頼済みの中身と一致したときだけ。起動後にエージェントが .hma に書いたフックまで追認しない
 */
export async function saveTrusted(
  save: () => Promise<string>,
): Promise<string> {
  const wasTrusted = isTrusted(currentPrint());
  const file = await save();
  if (wasTrusted) await recordTrust(currentPrint());
  return file;
}

/** 何を承認しようとしているのかを、そのまま並べる */
export function describeTrust(
  subject: ReturnType<typeof trustSubject>,
): string[] {
  return [
    ...subject.hooks.map(
      ({ event, hook, source }) =>
        `  実行  ${event} ${hook.matcher ? `(${hook.matcher}) ` : ""}${hook.command}  ← ${source}`,
    ),
    ...subject.rules.map(({ rule, source }) => `  許可  ${rule}  ← ${source}`),
    ...subject.mcp.map(
      ({ name, config, source }) =>
        `  起動  MCP ${name}: ${[
          ...Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`),
          config.command,
          ...(config.args ?? []),
        ].join(" ")}  ← ${source}`,
    ),
  ];
}
