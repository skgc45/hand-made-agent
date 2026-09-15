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
  /**
   * そのファイルに触っているツールの id。読みと書きを分ける。
   * 承認待ちで中断されると消えずに残るが、終わった id は待ちに効かないので害は無い
   */
  const active = new Map<string, { reads: Set<string>; writes: Set<string> }>();

  const activeFor = (file: string) => {
    let entry = active.get(file);
    if (!entry) {
      entry = { reads: new Set(), writes: new Set() };
      active.set(file, entry);
    }
    return entry;
  };

  const resolve = (rel: string) => path.resolve(root, rel);

  return {
    before: async ({ name, arguments: args, toolCallId, waitForRunning }) => {
      if (!READS.has(name) && !WRITES.has(name)) return undefined;

      const rel = pathOf(args);
      if (!rel) return undefined;

      const file = resolve(rel);
      const touching = activeFor(file);

      // 書き換え中のファイルを読むと、読んだ中身と after で取る更新時刻がずれる。
      // 古い中身を「最新を読んだ」と覚え、次の書き換えが先行を消してしまう
      if (READS.has(name)) {
        await waitForRunning?.([...touching.writes]);
        touching.reads.add(toolCallId);
        return undefined;
      }

      // 並列だと、同じバッチで先に走った read_file の記録がまだ入っていない。
      // 待たないと「読んだのに読んでいない」と言われ、同じファイルへの編集が
      // 2本同時に read-modify-write して片方が消える。
      // 待つのは同じファイルに触っているぶんだけ。無関係なツールは重なったままでいい
      await waitForRunning?.([...touching.reads, ...touching.writes]);
      touching.writes.add(toolCallId);

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

    after: async ({ name, arguments: args, toolCallId, blocked }) => {
      if (!READS.has(name) && !WRITES.has(name)) return undefined;

      const rel = pathOf(args);
      if (!rel) return undefined;

      const file = resolve(rel);
      const touching = activeFor(file);
      touching.reads.delete(toolCallId);
      touching.writes.delete(toolCallId);
      if (blocked) return undefined;

      // 自分で書いたぶんは読んだことにする。でないと2回目の編集が通らない
      seen.set(file, await mtime(file));
      return undefined;
    },
  };
}

/** 1回のツール結果の上限。溢れると trim を誘発して、会話のほうが削られる */
const MAX_LINES = 300;
const MAX_CHARS = 15000;
/**
 * ファイルを読むときだけ広げる。bash の出力は grep で絞れるが、
 * ソースは絞りようがない。300行だとこのリポジトリの loop.ts すら読み切れない
 */
const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 80000;

export function truncateResult(): AfterToolCall {
  return async ({ name, result }) => {
    const reading = READS.has(name);
    const maxLines = reading ? READ_MAX_LINES : MAX_LINES;
    const maxChars = reading ? READ_MAX_CHARS : MAX_CHARS;

    const lines = result.split("\n");
    if (lines.length <= maxLines && result.length <= maxChars) {
      return undefined;
    }

    const kept = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
    const dropped = lines.length - kept.split("\n").length;
    const how = reading
      ? `sed -n '${kept.split("\n").length + 1},$p' で続きを読めます`
      : "grep や bash で絞ってください";
    return {
      content: `${kept}\n（長すぎるので切りました。残り ${dropped} 行。${how}）`,
    };
  };
}
