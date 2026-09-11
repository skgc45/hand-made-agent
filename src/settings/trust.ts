import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type HookSource, type RuleSource, loadSettings } from "./index.js";

const FILE = path.join(os.homedir(), ".hma", "trust.json");

/**
 * 信頼が要るのは「緩める方向」のものだけ。
 * フックは任意のコマンドを自分の権限で走らせ、allow は承認を外す。
 * deny と ask は締める方向なので、信頼が無くても効かせる
 */
export function trustSubject(
  hooks: HookSource[],
  rules: RuleSource[],
): { hooks: HookSource[]; rules: RuleSource[] } {
  return {
    hooks: hooks.filter((h) => h.layer !== "user"),
    rules: rules.filter((r) => r.layer !== "user" && r.action === "allow"),
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

/**
 * すでに信頼しているプロジェクトの内容が、本人の操作（[s]ave）で変わったとき追随する。
 * 指紋は書き換わっているので、ファイルを読み直して取り直す
 */
export async function retrust(): Promise<void> {
  if (read()[projectKey()] === undefined) return;
  const { hooks, rules } = loadSettings();
  await recordTrust(fingerprint(trustSubject(hooks, rules)));
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
    ...subject.rules.map(
      ({ rule, source }) => `  許可  ${rule}  ← ${source}`,
    ),
  ];
}
