import type { Entry } from "../agent/loop.js";

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

/** ファイル / メモリ store は集計を持たないので、エントリを畳んで数える */
export function summarize(entries: Entry[]): {
  entries: number;
  totalPromptTokens: number;
  pending: boolean;
} {
  let totalPromptTokens = 0;
  let pending = false;
  for (const entry of entries) {
    const delta = summaryDelta(entry);
    totalPromptTokens += delta.promptTokens;
    if (delta.pending !== undefined) pending = delta.pending;
  }
  return { entries: entries.length, totalPromptTokens, pending };
}
