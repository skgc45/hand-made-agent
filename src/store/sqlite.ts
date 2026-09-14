import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Entry } from "../agent/loop.js";
import {
  assertThreadId,
  type Store,
  summaryDelta,
  type ThreadSummary,
} from "./index.js";

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:")
      fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);

    // クラッシュしても直前のコミットまで残る。既定の journal だと書き込み中の停止で壊れうる
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        thread_id TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        entry     TEXT NOT NULL,
        PRIMARY KEY (thread_id, seq)
      )
    `);
    // 一覧のためだけの非正規化。entries を全部読まずに済ませる
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id           TEXT PRIMARY KEY,
        entries             INTEGER NOT NULL,
        total_prompt_tokens INTEGER NOT NULL,
        pending             INTEGER NOT NULL,
        updated_at          TEXT NOT NULL
      )
    `);
  }

  async load(threadId: string): Promise<Entry[]> {
    const rows = this.db
      .prepare("SELECT entry FROM entries WHERE thread_id = ? ORDER BY seq")
      .all(assertThreadId(threadId)) as { entry: string }[];
    return rows.map((r) => JSON.parse(r.entry));
  }

  async append(threadId: string, entry: Entry): Promise<void> {
    const id = assertThreadId(threadId);
    const { promptTokens, pending } = summaryDelta(entry);

    // 1件の追記と一覧用の集計を必ず一緒にコミットする
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO entries (thread_id, seq, entry)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM entries WHERE thread_id = ?), ?)`,
        )
        .run(id, id, JSON.stringify(entry));

      this.db
        .prepare(
          `INSERT INTO threads (thread_id, entries, total_prompt_tokens, pending, updated_at)
           VALUES (?, 1, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             entries = threads.entries + 1,
             total_prompt_tokens = threads.total_prompt_tokens + excluded.total_prompt_tokens,
             pending = CASE WHEN ? IS NULL THEN threads.pending ELSE excluded.pending END,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          promptTokens,
          pending === undefined ? 0 : Number(pending),
          new Date().toISOString(),
          pending === undefined ? null : 1,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async list(): Promise<ThreadSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT thread_id, entries, total_prompt_tokens, pending, updated_at
           FROM threads ORDER BY updated_at DESC`,
      )
      .all() as {
      thread_id: string;
      entries: number;
      total_prompt_tokens: number;
      pending: number;
      updated_at: string;
    }[];

    return rows.map((r) => ({
      threadId: r.thread_id,
      entries: r.entries,
      totalPromptTokens: r.total_prompt_tokens,
      pending: r.pending === 1,
      updatedAt: r.updated_at,
    }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
