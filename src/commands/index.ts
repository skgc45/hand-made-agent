import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BeforeUserMessage } from "../agent/loop.js";

const MAX_CHARS = 20_000;

export type Command = {
  name: string;
  body: string;
  /** どのディレクトリから来たか。hma config で出す */
  source: string;
};

async function readDir(dir: string, source: string): Promise<Command[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }

  const commands: Command[] = [];
  for (const name of names) {
    const body = (await fs.readFile(path.join(dir, name), "utf-8")).trim();
    if (body) {
      commands.push({
        name: name.slice(0, -".md".length),
        body: body.slice(0, MAX_CHARS),
        source,
      });
    }
  }
  return commands;
}

/** ~/.hma < .hma の順。同じ名前ならプロジェクト側が勝つ */
export async function loadCommands(): Promise<Command[]> {
  const found = [
    ...(await readDir(
      path.join(os.homedir(), ".hma", "commands"),
      "~/.hma/commands",
    )),
    ...(await readDir(path.resolve(".hma", "commands"), ".hma/commands")),
  ];

  const byName = new Map<string, Command>();
  for (const command of found) byName.set(command.name, command);
  return [...byName.values()];
}

/**
 * `/name 引数` を本文に差し替える。$ARGUMENTS があればそこへ、無ければ末尾に足す。
 * 履歴に残るのは展開後（モデルは「何を頼まれたか」だけ見れば済む）
 */
export function expand(text: string, commands: Command[]): string | undefined {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;

  const command = commands.find((c) => c.name === match[1]);
  if (!command) return undefined;

  const args = (match[2] ?? "").trim();
  return command.body.includes("$ARGUMENTS")
    ? command.body.replaceAll("$ARGUMENTS", args)
    : args
      ? `${command.body}\n\n${args}`
      : command.body;
}

export function commandHook(commands: Command[]): BeforeUserMessage | undefined {
  if (commands.length === 0) return undefined;

  return async (text) => {
    // 知らない `/xxx` は展開せずそのまま流す。ただの文章かもしれない
    const replaced = expand(text, commands);
    return replaced === undefined ? undefined : { replace: replaced };
  };
}
