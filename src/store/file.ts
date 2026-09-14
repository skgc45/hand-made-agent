import fs from "node:fs/promises";
import path from "node:path";
import type { Entry } from "../agent/loop.js";
import {
  assertThreadId,
  type Store,
  summaryDelta,
  type ThreadSummary,
} from "./index.js";

/** 1スレッド1ファイルの JSONL。追記なので既存行は触らない */
export class FileStore implements Store {
  constructor(private readonly dir: string) {}

  private fileFor(threadId: string): string {
    return path.join(this.dir, `${assertThreadId(threadId)}.jsonl`);
  }

  async load(threadId: string): Promise<Entry[]> {
    let text: string;
    try {
      text = await fs.readFile(this.fileFor(threadId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async append(threadId: string, entry: Entry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.fileFor(threadId), `${JSON.stringify(entry)}\n`);
  }

  async list(): Promise<ThreadSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const summaries: ThreadSummary[] = [];
    for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
      const threadId = name.slice(0, -".jsonl".length);
      const [entries, stat] = await Promise.all([
        this.load(threadId),
        fs.stat(path.join(this.dir, name)),
      ]);

      // ファイル store は集計を持たないので毎回読み直して数える
      let totalPromptTokens = 0;
      let pending = false;
      for (const entry of entries) {
        const delta = summaryDelta(entry);
        totalPromptTokens += delta.promptTokens;
        if (delta.pending !== undefined) pending = delta.pending;
      }

      summaries.push({
        threadId,
        entries: entries.length,
        totalPromptTokens,
        pending,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async close(): Promise<void> {}
}
