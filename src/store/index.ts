import { STORE, STORE_PATH } from "../config.js";
import type { Entry } from "../agent/loop.js";
import { FileStore } from "./file.js";
import { MemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";

export interface Store {
  load(threadId: string): Promise<Entry[]>;
  append(threadId: string, entry: Entry): Promise<void>;
  list(): Promise<ThreadSummary[]>;
  close(): Promise<void>;
}

export type ThreadSummary = {
  threadId: string;
  entries: number;
  totalPromptTokens: number;
  pending: boolean;
  updatedAt: string;
};

export function assertThreadId(threadId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) {
    throw new Error(`threadId に使えない文字が含まれています: ${threadId}`);
  }
  return threadId;
}

/** 一覧用の集計。エントリを1件ずつ足していけるように差分で持つ */
export function summaryDelta(entry: Entry): {
  promptTokens: number;
  pending: boolean | undefined;
} {
  return {
    promptTokens: entry.kind === "usage" ? entry.promptTokens : 0,
    pending: entry.kind === "pending" ? entry.pending !== null : undefined,
  };
}

export function createStore(
  kind: string = STORE,
  storePath: string = STORE_PATH,
): Store {
  switch (kind) {
    case "sqlite":
      return new SqliteStore(storePath);
    case "file":
      return new FileStore(storePath);
    case "memory":
      return new MemoryStore();
    default:
      throw new Error(`STORE に不明な値: ${kind}（sqlite / file / memory）`);
  }
}

export { FileStore, MemoryStore, SqliteStore };
