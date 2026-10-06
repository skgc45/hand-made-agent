import path from "node:path";
import { realpathLoose, relativeInside } from "../agent/realpath.js";

export type Rule = { tool: string; pattern?: string };

/**
 * path の forms は同じ場所の書き方（workspace 相対と絶対）、real はリンクを解決した先の書き方。
 * real があるのは、リンクで場所が変わるときだけ
 */
export type Subject = {
  kind: "command" | "path";
  value: string;
  forms?: string[];
  real?: string[];
};

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
 * && || ; | & と改行で切る。クォートの中まで見ていないので余計に切れることはあるが、
 * 切りすぎた側は allow に一致しなくなるだけで、見逃しにはならない
 */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|&\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 引数のどこを見るか。command があればコマンド、無ければ path */
export function subjectsOf(
  args: unknown,
  workspace?: string,
): (Subject | undefined)[] {
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
    return [pathSubject(record.path, workspace)];
  }
  return [undefined];
}

/** 外のパスは、書かれたとおり（../ 付き）の形も残す */
function formsOf(root: string, abs: string, written?: string): string[] {
  const rel = relativeInside(root, abs);
  if (rel !== undefined) return [rel, abs];
  return written === undefined ? [abs] : [path.normalize(written), abs];
}

/** workspace が分かるときは、相対も絶対も workspace 基準にそろえ、リンクの先も持たせる */
export function pathSubject(value: string, workspace?: string): Subject {
  if (!workspace) return { kind: "path", value };

  const root = path.resolve(workspace);
  const abs = path.resolve(root, value);
  const forms = formsOf(root, abs, value);

  let real: string[];
  try {
    real = formsOf(realpathLoose(root), realpathLoose(abs));
  } catch {
    real = [path.parse(abs).root];
  }

  return {
    kind: "path",
    value: forms[0],
    forms,
    real: real.every((f) => forms.includes(f)) ? undefined : real,
  };
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

const globHit = (pattern: string, forms: string[]) =>
  forms.some((form) =>
    path.matchesGlob(path.normalize(form), path.normalize(pattern)),
  );

/**
 * パスはリンクの先でも判定する。deny / ask は書き方かリンク先のどちらかが当たれば当たり、
 * allow は両方が当たらないと当たらない（止まる側へ倒す）
 */
export function hits(
  rule: Rule,
  name: string,
  subject: Subject | undefined,
  mode: "any" | "all" = "any",
): boolean {
  if (!matchTool(rule.tool, name)) return false;
  if (rule.pattern === undefined) return true;
  if (!subject) return false;

  if (subject.kind === "command") {
    return matchCommand(rule.pattern, subject.value);
  }

  const direct = globHit(rule.pattern, subject.forms ?? [subject.value]);
  if (!subject.real) return direct;
  const viaLink = globHit(rule.pattern, subject.real);
  return mode === "all" ? direct && viaLink : direct || viaLink;
}
