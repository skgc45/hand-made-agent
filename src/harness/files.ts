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
  /** いま書き換えている最中のファイル。並列で重なったときだけ中身が入る */
  const writing = new Set<string>();

  const resolve = (rel: string) => path.resolve(root, rel);

  return {
    before: async ({ name, arguments: args, waitForRunning }) => {
      const rel = pathOf(args);
      if (!rel) return undefined;

      // 書き換え中のファイルを読むと、読んだ中身と after で取る更新時刻がずれる。
      // 古い中身を「最新を読んだ」と覚え、次の書き換えが先行を消してしまう
      if (READS.has(name)) {
        if (writing.has(resolve(rel))) await waitForRunning?.();
        return undefined;
      }
      if (!WRITES.has(name)) return undefined;

      // 並列だと、同じバッチで先に走った read_file の記録がまだ入っていない。
      // 待たないと「読んだのに読んでいない」と言われ、同じファイルへの編集が
      // 2本同時に read-modify-write して片方が消える
      await waitForRunning?.();

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

      writing.add(file);
      return undefined;
    },

    after: async ({ name, arguments: args, blocked }) => {
      if (!READS.has(name) && !WRITES.has(name)) return undefined;
      if (blocked) {
        const rel = pathOf(args);
        if (rel) writing.delete(resolve(rel));
        return undefined;
      }

      const rel = pathOf(args);
      if (!rel) return undefined;

      writing.delete(resolve(rel));
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
