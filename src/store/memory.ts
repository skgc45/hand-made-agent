import type { Entry } from "../agent/loop.js";
import {
  type Store,
  type ThreadSummary,
  assertThreadId,
  summaryDelta,
} from "./index.js";

/** 永続化しない実装。ステップ6 以前の挙動をそのまま再現する */
export class MemoryStore implements Store {
  private readonly threads = new Map<
    string,
    { entries: Entry[]; updatedAt: string }
  >();

  async load(threadId: string): Promise<Entry[]> {
    return [...(this.threads.get(assertThreadId(threadId))?.entries ?? [])];
  }

  async append(threadId: string, entry: Entry): Promise<void> {
    const id = assertThreadId(threadId);
    const thread = this.threads.get(id) ?? { entries: [], updatedAt: "" };
    thread.entries.push(entry);
    thread.updatedAt = new Date().toISOString();
    this.threads.set(id, thread);
  }

  async list(): Promise<ThreadSummary[]> {
    return [...this.threads.entries()]
      .map(([threadId, { entries, updatedAt }]) => {
        let totalPromptTokens = 0;
        let pending = false;
        for (const entry of entries) {
          const delta = summaryDelta(entry);
          totalPromptTokens += delta.promptTokens;
          if (delta.pending !== undefined) pending = delta.pending;
        }
        return {
          threadId,
          entries: entries.length,
          totalPromptTokens,
          pending,
          updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async close(): Promise<void> {}
}
