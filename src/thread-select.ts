import type { Store } from "./store/index.js";

export function conflictOfContinue(opts: {
  continue?: boolean;
  thread?: string;
  new?: boolean;
}): string | undefined {
  if (!opts.continue) return undefined;
  if (opts.thread !== undefined)
    return "--continue と --thread は同時に指定できません";
  if (opts.new) return "--continue と --new は同時に指定できません";
  return undefined;
}

/** updatedAt が最も新しいスレッドの id。スレッドが無ければ undefined */
export async function latestThreadId(
  store: Store,
): Promise<string | undefined> {
  const threads = await store.list();
  let latest: (typeof threads)[number] | undefined;
  for (const t of threads) {
    if (!latest || t.updatedAt > latest.updatedAt) latest = t;
  }
  return latest?.threadId;
}
