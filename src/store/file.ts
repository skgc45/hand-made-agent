import fs from "node:fs/promises";
import path from "node:path";
import type { Entry } from "../agent/loop.js";
import { assertThreadId, type Store, type ThreadSummary } from "./index.js";
import { summarize } from "./summary.js";

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
    const lines = text.split("\n");
    const entries: Entry[] = [];
    for (const [i, line] of lines.entries()) {
      if (line === "") continue;
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        // 改行で終わらない最終行だけが書きかけの追記。repairTail と同じ条件
        if (i === lines.length - 1) break;
        throw new Error(
          `${this.fileFor(threadId)} の ${i + 1} 行目が壊れている: ${error}`,
        );
      }
    }
    return entries;
  }

  private readonly repaired = new Set<string>();

  /** 末尾が改行で終わっていなければ、書きかけの追記が残っている */
  private async repairTail(file: string): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (text === "" || text.endsWith("\n")) return;

    const cut = text.lastIndexOf("\n") + 1;
    try {
      JSON.parse(text.slice(cut));
      await fs.appendFile(file, "\n");
    } catch {
      await fs.truncate(file, Buffer.byteLength(text.slice(0, cut)));
    }
  }

  async append(threadId: string, entry: Entry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileFor(threadId);
    // 書きかけが残るのは前のプロセスが落ちたときだけ。追記のたびに全文を読まない
    if (!this.repaired.has(file)) {
      await this.repairTail(file);
      this.repaired.add(file);
    }
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`);
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
      let entries: Entry[];
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        [entries, stat] = await Promise.all([
          this.load(threadId),
          fs.stat(path.join(this.dir, name)),
        ]);
      } catch (error) {
        console.error(`一覧から飛ばす: ${(error as Error).message}`);
        continue;
      }

      summaries.push({
        threadId,
        ...summarize(entries),
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async close(): Promise<void> {}
}
