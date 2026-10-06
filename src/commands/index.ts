import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BeforeUserMessage } from "../agent/loop.js";
import { frontmatter } from "../skills/index.js";

const MAX_CHARS = 20_000;

export type Command = {
  name: string;
  body: string;
  argumentHint?: string;
  /** フロントマターの `arguments: positional`。$1 / $@ を展開するのはこのときだけ */
  positional?: boolean;
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
    const text = await fs.readFile(path.join(dir, name), "utf-8");
    const { fields, body: rest } = frontmatter(text);
    const body = rest.trim();
    if (body) {
      commands.push({
        name: name.slice(0, -".md".length),
        body: body.slice(0, MAX_CHARS),
        argumentHint: fields["argument-hint"] || undefined,
        positional: fields.arguments === "positional",
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
 * シェル風に区切る。クォートは語の先頭でだけ開く（`don't` のアポストロフィは文字）。
 * `\` は次がクォート・空白・`\` のときだけエスケープで、それ以外は残す
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: string | undefined;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === "\\" && quote !== "'" && next !== undefined) {
      const escapable = quote
        ? next === quote || next === "\\"
        : /[\s'"\\]/.test(next);
      if (escapable) {
        current += next;
        started = true;
        i++;
      } else {
        current += ch;
        started = true;
      }
    } else if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (!started && (ch === "'" || ch === '"')) {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

const PLACEHOLDER = /\$\{([1-9]):-([^}]*)\}|\$([1-9])|\$@|\$ARGUMENTS/g;

/**
 * `/name 引数` を本文に差し替える。$ARGUMENTS があればそこへ、無ければ末尾に足す。
 * フロントマターに `arguments: positional` があるコマンドは $1〜$9 / $@ / ${1:-既定} も展開する。
 * 履歴に残るのは展開後（モデルは「何を頼まれたか」だけ見れば済む）
 */
export function expand(text: string, commands: Command[]): string | undefined {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;

  const command = commands.find((c) => c.name === match[1]);
  if (!command) return undefined;

  const raw = (match[2] ?? "").trim();
  const args = command.positional ? splitArgs(raw) : [];

  let used = false;
  const body = command.body.replace(
    PLACEHOLDER,
    (token, hintIndex?: string, fallback?: string, index?: string) => {
      if (token === "$ARGUMENTS") {
        used = true;
        return raw;
      }
      if (!command.positional) return token;
      used = true;
      if (token === "$@") return args.join(" ");
      if (hintIndex) return args[Number(hintIndex) - 1] || (fallback ?? "");
      return args[Number(index) - 1] ?? "";
    },
  );

  if (used || !raw) return body;
  return `${body}\n\n${raw}`;
}

export function commandHook(
  commands: Command[],
): BeforeUserMessage | undefined {
  if (commands.length === 0) return undefined;

  return async (text) => {
    // 知らない `/xxx` は展開せずそのまま流す。ただの文章かもしれない
    const replaced = expand(text, commands);
    return replaced === undefined ? undefined : { replace: replaced };
  };
}
