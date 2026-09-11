import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PromptSection } from "../agent/prompt.js";
import { type HookConfig, runHook } from "../hooks/index.js";

const exec = promisify(execFile);

/** 1ファイルの上限。長い AGENTS.md が黙って毎ターン効いてくるのを防ぐ */
const MAX_CHARS = 8000;

const MEMORY = "AGENTS.md";

async function readCapped(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_CHARS) return trimmed;

  console.error(
    `\x1b[33m${file} が長すぎます（${trimmed.length} 文字）。先頭 ${MAX_CHARS} 文字だけ読みます\x1b[0m`,
  );
  return `${trimmed.slice(0, MAX_CHARS)}\n（以下省略）`;
}

/** cwd から上へ辿る。外側にあるものほど一般的なので、外から順に並べる */
async function projectMemory(): Promise<string> {
  const home = os.homedir();
  const dirs: string[] = [];

  for (let dir = path.resolve("."); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
  }

  const parts: string[] = [];
  const global = await readCapped(path.join(home, ".hma", MEMORY));
  if (global) parts.push(global);

  for (const dir of dirs) {
    const body = await readCapped(path.join(dir, MEMORY));
    if (body) parts.push(body);
  }
  return parts.join("\n\n");
}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { timeout: 2000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function environment(workspace: string): Promise<string> {
  const [branch, status] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["status", "--porcelain"]),
  ]);

  const lines = [
    `- 作業ディレクトリ: ${path.resolve(".")}`,
    `- 触ってよい場所: ${path.resolve(workspace)}`,
    `- OS: ${os.platform()} ${os.release()}`,
    `- 今日の日付: ${new Date().toISOString().slice(0, 10)}`,
  ];
  if (branch) {
    const changed = status ? status.split("\n").length : 0;
    lines.push(`- git: ${branch}（未コミットの変更 ${changed} 件）`);
  }
  return lines.join("\n");
}

const PLAN = `ファイルの変更もコマンドの実行もできません。試みても止められます。
読み取りだけで調べて、**何をどう変えるか**を文章で出してください。
実行したいコマンドは、実行せずにそのまま書いてください。`;

export type ContextOptions = {
  workspace: string;
  /** plan なら、書けないことをモデルにも伝える */
  mode: string;
  /** 信頼済みの SessionStart フックだけ渡ってくる */
  sessionStart: HookConfig[];
};

/** 起動時に1回だけ集める。IO を伴うので Agent の外に置く */
export async function collectContext({
  workspace,
  mode,
  sessionStart,
}: ContextOptions): Promise<PromptSection[]> {
  const sections: PromptSection[] = [];

  if (mode === "plan") sections.push({ heading: "いまは計画モード", body: PLAN });

  sections.push({ heading: "環境", body: await environment(workspace) });

  const memory = await projectMemory();
  if (memory) sections.push({ heading: "このプロジェクトの決まり", body: memory });

  const started: string[] = [];
  for (const hook of sessionStart) {
    const outcome = await runHook(hook, {
      event: "SessionStart",
      cwd: process.cwd(),
    });
    if (outcome.context) started.push(outcome.context);
  }
  if (started.length > 0) {
    sections.push({ heading: "起動時に集めた情報", body: started.join("\n\n") });
  }

  return sections;
}
