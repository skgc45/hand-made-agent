import path from "node:path";

export type Rule = { tool: string; pattern?: string };

export type Subject = { kind: "command" | "path"; value: string };

/** 末尾 * はツール名の前方一致。MCP のようにツールが束で増えるとき、サーバ単位で書ける */
const RULE = /^([A-Za-z0-9_-]+\*?)(?:\((.*)\))?$/s;

export function parseRule(text: string): Rule {
  const matched = RULE.exec(text.trim());
  if (!matched) {
    throw new Error(
      `ルールの書式が不正です: ${text}（tool または tool(pattern)）`,
    );
  }
  return { tool: matched[1], pattern: matched[2] };
}

export function formatRule(rule: Rule): string {
  return rule.pattern === undefined
    ? rule.tool
    : `${rule.tool}(${rule.pattern})`;
}

/**
 * && || ; | と改行で切る。クォートの中まで見ていないので余計に切れることはあるが、
 * 切りすぎた側は allow に一致しなくなるだけで、見逃しにはならない
 */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 引数のどこを見るか。command があればコマンド、無ければ path */
export function subjectsOf(args: unknown): (Subject | undefined)[] {
  const record =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};

  if (typeof record.command === "string") {
    const parts = splitCommand(record.command);
    if (parts.length === 0) return [undefined];
    return parts.map((value) => ({ kind: "command", value }));
  }
  if (typeof record.path === "string") {
    return [{ kind: "path", value: record.path }];
  }
  return [undefined];
}

/** 末尾 :* は前方一致。ただし語の途中では切らない（npm run test:* は npm run tests に当たらない） */
function matchCommand(pattern: string, command: string): boolean {
  if (!pattern.endsWith(":*")) return pattern === command;

  const prefix = pattern.slice(0, -2);
  if (!command.startsWith(prefix)) return false;
  const rest = command.slice(prefix.length);
  return rest === "" || /^\s/.test(rest);
}

function matchTool(pattern: string, name: string): boolean {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

export function hits(
  rule: Rule,
  name: string,
  subject: Subject | undefined,
): boolean {
  if (!matchTool(rule.tool, name)) return false;
  if (rule.pattern === undefined) return true;
  if (!subject) return false;

  return subject.kind === "command"
    ? matchCommand(rule.pattern, subject.value)
    : path.matchesGlob(subject.value, rule.pattern);
}
