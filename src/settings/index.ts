import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HOOK_EVENTS,
  type HookConfig,
  type HookEvent,
  type HookSet,
} from "../hooks/index.js";
import type { McpServerConfig } from "../mcp/index.js";
import { type PermissionSet, parseRule } from "../permission/index.js";

export type Settings = {
  model?: string;
  baseUrl?: string;
  workspace?: string;
  profile?: string;
  approval?: string;
  trim?: string;
  contextLimit?: number;
  stream?: boolean;
  port?: number;
  store?: string;
  storePath?: string;
  telemetry?: string;
  telemetryUrl?: string;
  permissions?: PermissionSet;
  hooks?: HookSet;
  /** 起動する MCP サーバ。任意のコマンドなので、フックと同じく信頼の対象 */
  mcpServers?: Record<string, McpServerConfig>;
};

type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "permissions"
  | "hooks"
  | "mcpServers";

const FIELDS: Record<keyof Settings, FieldKind> = {
  model: "string",
  baseUrl: "string",
  workspace: "string",
  profile: "string",
  approval: "string",
  trim: "string",
  contextLimit: "number",
  stream: "boolean",
  port: "number",
  store: "string",
  storePath: "string",
  telemetry: "string",
  telemetryUrl: "string",
  permissions: "permissions",
  hooks: "hooks",
  mcpServers: "mcpServers",
};

const USER = path.join(os.homedir(), ".hma", "settings.json");
/** プロジェクトは cwd で決まる。workspace で決めると「設定が workspace を決める」と循環する */
const PROJECT = path.resolve(".hma", "settings.json");
export const LOCAL = path.resolve(".hma", "settings.local.json");

const LISTS = ["allow", "ask", "deny"] as const;

/** ~/.hma を ../../.. と出されても分からないので、home だけ ~ に畳む */
function display(file: string): string {
  const home = os.homedir();
  if (file.startsWith(home + path.sep)) return `~${file.slice(home.length)}`;
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") ? file : relative;
}

function warn(file: string, message: string): void {
  console.error(`\x1b[33m${display(file)}: ${message}\x1b[0m`);
}

function readPermissions(
  file: string,
  value: unknown,
): PermissionSet | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warn(file, "permissions はオブジェクトである必要があります");
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const set: PermissionSet = {};

  for (const key of Object.keys(source)) {
    if (!LISTS.includes(key as (typeof LISTS)[number])) {
      warn(file, `permissions の未知のキー: ${key}（${LISTS.join(" / ")}）`);
      continue;
    }
    const list = source[key];
    if (!Array.isArray(list) || list.some((r) => typeof r !== "string")) {
      warn(file, `permissions.${key} は文字列の配列である必要があります`);
      continue;
    }
    // 書式が通らないルールは1つも当たらないまま黙って無視されるので、読んだ時点で言う
    const valid = (list as string[]).filter((rule) => {
      try {
        parseRule(rule);
        return true;
      } catch (error) {
        warn(file, (error as Error).message);
        return false;
      }
    });
    set[key as (typeof LISTS)[number]] = valid;
  }

  return set;
}

/** 無ければ undefined。「置いていない」と「置いたが空」を区別する */
function readHooks(file: string, value: unknown): HookSet | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warn(file, "hooks はオブジェクトである必要があります");
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const set: HookSet = {};

  for (const key of Object.keys(source)) {
    if (!HOOK_EVENTS.includes(key as HookEvent)) {
      warn(
        file,
        `hooks の未知のイベント: ${key}（${HOOK_EVENTS.join(" / ")}）`,
      );
      continue;
    }
    const list = source[key];
    if (!Array.isArray(list)) {
      warn(file, `hooks.${key} は配列である必要があります`);
      continue;
    }

    const valid = [];
    for (const entry of list) {
      const hook = entry as Record<string, unknown>;
      if (typeof hook?.command !== "string") {
        warn(file, `hooks.${key} の要素に command がありません`);
        continue;
      }
      if (hook.matcher !== undefined) {
        if (typeof hook.matcher !== "string") {
          warn(file, `hooks.${key} の matcher は文字列である必要があります`);
          continue;
        }
        // 書式が通らない matcher は1つも当たらないまま無視されるので、読んだ時点で言う
        try {
          parseRule(hook.matcher);
        } catch (error) {
          warn(file, (error as Error).message);
          continue;
        }
      }
      if (hook.timeout !== undefined && typeof hook.timeout !== "number") {
        warn(file, `hooks.${key} の timeout は number である必要があります`);
        continue;
      }
      valid.push({
        matcher: hook.matcher as string | undefined,
        command: hook.command,
        timeout: hook.timeout as number | undefined,
      });
    }
    set[key as HookEvent] = valid;
  }

  return set;
}

function readSettings(file: string): Settings | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(file, `JSON として読めません: ${(error as Error).message}`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(file, "オブジェクトである必要があります");
    return {};
  }

  const source = parsed as Record<string, unknown>;
  const settings: Settings = {};

  for (const [key, value] of Object.entries(source)) {
    const kind = FIELDS[key as keyof Settings];
    if (!kind) {
      warn(file, `未知のキー: ${key}`);
      continue;
    }
    if (kind === "permissions") {
      settings.permissions = readPermissions(file, value);
      continue;
    }
    if (kind === "hooks") {
      settings.hooks = readHooks(file, value);
      continue;
    }
    if (kind === "mcpServers") {
      settings.mcpServers = readMcpServers(file, value);
      continue;
    }
    if (typeof value !== kind) {
      warn(file, `${key} は ${kind} である必要があります`);
      continue;
    }
    Object.assign(settings, { [key]: value });
  }

  return settings;
}

/** フックも層をまたいで全部走らせる。上の層で下のフックを消せないようにする */
export function mergeHooks(...sets: (HookSet | undefined)[]): HookSet {
  const merged: HookSet = {};
  for (const event of HOOK_EVENTS) {
    const list = sets.flatMap((set) => set?.[event] ?? []);
    if (list.length > 0) merged[event] = list;
  }
  return merged;
}

/** allow / ask / deny はどの層のものも全部効かせる。deny は1つでも当たれば止まる */
export function mergePermissions(
  ...sets: (PermissionSet | undefined)[]
): PermissionSet {
  const merged: PermissionSet = {};
  for (const key of LISTS) {
    const list = sets.flatMap((set) => set?.[key] ?? []);
    if (list.length > 0) merged[key] = list;
  }
  return merged;
}

/** user は本人の設定。project と local は、そのディレクトリから来たもの */
export type Layer = "user" | "project" | "local";

export type RuleSource = {
  action: (typeof LISTS)[number];
  rule: string;
  source: string;
  layer: Layer;
};

export type Loaded = {
  settings: Settings;
  /** 実在して読めたファイル。どこから来た設定か分からなくなるので起動時に出す */
  files: string[];
  /** スカラーごとに、最後に値を置いた層 */
  sources: Partial<Record<keyof Settings, string>>;
  /** ルールは層をまたいで連結するので、1本ずつ出所を持つ */
  rules: RuleSource[];
  /** フックも同じ。どのファイルが刺したコマンドかを追えるようにする */
  hooks: HookSource[];
  /** MCP サーバも、どのファイルが起動させるのかを追えるようにする */
  mcp: McpSource[];
};

export type HookSource = {
  event: HookEvent;
  hook: HookConfig;
  source: string;
  layer: Layer;
};

export type McpSource = {
  name: string;
  config: McpServerConfig;
  source: string;
  layer: Layer;
};

/**
 * 既定 < ~/.hma < .hma < .hma/settings.local.json の順に上書きする。
 * 環境変数はさらに上（config.ts）。一時的な実験を設定ファイルに勝たせないため
 */
export function loadSettings(): Loaded {
  const files: string[] = [];
  const layers: Settings[] = [];
  const sources: Partial<Record<keyof Settings, string>> = {};
  const rules: RuleSource[] = [];
  const hooks: HookSource[] = [];
  const mcp: McpSource[] = [];

  const layers_: [string, Layer][] = [
    [USER, "user"],
    [PROJECT, "project"],
    [LOCAL, "local"],
  ];

  for (const [file, layer] of layers_) {
    const settings = readSettings(file);
    if (!settings) continue;

    const name = display(file);
    files.push(name);
    layers.push(settings);

    for (const key of Object.keys(settings) as (keyof Settings)[]) {
      if (key !== "permissions") sources[key] = name;
    }
    for (const action of LISTS) {
      for (const rule of settings.permissions?.[action] ?? []) {
        rules.push({ action, rule, source: name, layer });
      }
    }
    for (const event of HOOK_EVENTS) {
      for (const hook of settings.hooks?.[event] ?? []) {
        hooks.push({ event, hook, source: name, layer });
      }
    }
    for (const [server, config] of Object.entries(settings.mcpServers ?? {})) {
      mcp.push({ name: server, config, source: name, layer });
    }
  }

  return {
    settings: {
      ...Object.assign({}, ...layers),
      permissions: mergePermissions(...layers.map((l) => l.permissions)),
      hooks: mergeHooks(...layers.map((l) => l.hooks)),
    },
    files,
    sources,
    rules,
    hooks,
    // 同じ名前なら後の層が勝つ。フックと違って「増やす」ではなく「置き換える」
    mcp: [...new Map(mcp.map((m) => [m.name, m])).values()],
  };
}

/** [a]lways の保存先。共有される .hma/settings.json には勝手に書かない */
export async function saveAllowRule(rule: string): Promise<string> {
  parseRule(rule);

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(LOCAL, "utf-8"));
  } catch {
    current = {};
  }

  const permissions = (current.permissions ?? {}) as PermissionSet;
  const allow = permissions.allow ?? [];
  if (!allow.includes(rule)) allow.push(rule);

  const next = { ...current, permissions: { ...permissions, allow } };
  await mkdir(path.dirname(LOCAL), { recursive: true });
  await writeFile(LOCAL, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return display(LOCAL);
}

/** MCP サーバの設定。command だけ必須で、args と env は任意 */
function readMcpServers(
  file: string,
  value: unknown,
): Record<string, McpServerConfig> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warn(file, "mcpServers はオブジェクトである必要があります");
    return undefined;
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      warn(file, `mcpServers.${name} はオブジェクトである必要があります`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== "string") {
      warn(file, `mcpServers.${name}.command が要ります`);
      continue;
    }
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env =
      typeof entry.env === "object" && entry.env !== null
        ? Object.fromEntries(
            Object.entries(entry.env as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, v as string]),
          )
        : undefined;

    servers[name] = { command: entry.command, args, env };
  }
  return servers;
}
