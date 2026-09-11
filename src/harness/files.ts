import fs from "node:fs/promises";
import path from "node:path";
import type { AfterToolCall, BeforeToolCall } from "../agent/loop.js";

const READS = new Set(["read_file"]);
const WRITES = new Set(["write_file", "edit_file"]);

function pathOf(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

async function mtime(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * 読んでいないファイルを書き換えさせない。
 * モデルは「たぶんこう書いてあるはず」で edit_file を投げるので、
 * 一意でない old_text より先に、そもそも中身を見ていないことを止める
 */
export function readBeforeEdit(workspace: string): {
  before: BeforeToolCall;
  after: AfterToolCall;
} {
  const root = path.resolve(workspace);
  /** 読んだ時点の更新時刻。ファイルが無いときは undefined を覚える */
  const seen = new Map<string, number | undefined>();

  const resolve = (rel: string) => path.resolve(root, rel);

  return {
    before: async ({ name, arguments: args }) => {
      if (!WRITES.has(name)) return undefined;

      const rel = pathOf(args);
      if (!rel) return undefined;

      const file = resolve(rel);
      const now = await mtime(file);

      // 存在しないファイルへの write_file は新規作成。読みようがない
      if (now === undefined) return undefined;

      if (!seen.has(file)) {
        return {
          kind: "block",
          reason: `${rel} をまだ読んでいません。read_file で現在の中身を確認してから書き換えてください。`,
        };
      }
      if (seen.get(file) !== now) {
        return {
          kind: "block",
          reason: `${rel} は読んだあとに変わっています。read_file で読み直してください。`,
        };
      }
      return undefined;
    },

    after: async ({ name, arguments: args, blocked }) => {
      if (blocked) return undefined;
      if (!READS.has(name) && !WRITES.has(name)) return undefined;

      const rel = pathOf(args);
      if (!rel) return undefined;

      // 自分で書いたぶんは読んだことにする。でないと2回目の編集が通らない
      seen.set(resolve(rel), await mtime(resolve(rel)));
      return undefined;
    },
  };
}

/** 1回のツール結果の上限。溢れると trim を誘発して、会話のほうが削られる */
const MAX_LINES = 300;
const MAX_CHARS = 15000;

export function truncateResult(): AfterToolCall {
  return async ({ result }) => {
    const lines = result.split("\n");
    if (lines.length <= MAX_LINES && result.length <= MAX_CHARS) {
      return undefined;
    }

    const kept = lines.slice(0, MAX_LINES).join("\n").slice(0, MAX_CHARS);
    const dropped = lines.length - kept.split("\n").length;
    return {
      content: `${kept}\n（長すぎるので切りました。残り ${dropped} 行。grep や bash で絞ってください）`,
    };
  };
}
