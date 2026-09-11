import fs from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
};

type FieldKind = "string" | "number" | "boolean" | "permissions";

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

function readPermissions(file: string, value: unknown): PermissionSet | undefined {
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
    if (typeof value !== kind) {
      warn(file, `${key} は ${kind} である必要があります`);
      continue;
    }
    Object.assign(settings, { [key]: value });
  }

  return settings;
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

export type Loaded = {
  settings: Settings;
  /** 実在して読めたファイル。どこから来た設定か分からなくなるので起動時に出す */
  files: string[];
};

/**
 * 既定 < ~/.hma < .hma < .hma/settings.local.json の順に上書きする。
 * 環境変数はさらに上（config.ts）。一時的な実験を設定ファイルに勝たせないため
 */
export function loadSettings(): Loaded {
  const files: string[] = [];
  const layers: Settings[] = [];

  for (const file of [USER, PROJECT, LOCAL]) {
    const settings = readSettings(file);
    if (!settings) continue;
    files.push(display(file));
    layers.push(settings);
  }

  return {
    settings: {
      ...Object.assign({}, ...layers),
      permissions: mergePermissions(...layers.map((l) => l.permissions)),
    },
    files,
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
