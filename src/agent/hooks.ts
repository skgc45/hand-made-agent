import type { AfterToolCall, BeforeToolCall } from "./loop.js";

/** 先に値を返したフックが勝つ。deny を先に置けば allow より優先される */
export function composeBefore(
  hooks: (BeforeToolCall | undefined)[],
): BeforeToolCall | undefined {
  const list = hooks.filter((hook) => hook !== undefined);
  if (list.length <= 1) return list[0];

  return async (context, signal) => {
    for (const hook of list) {
      const result = await hook(context, signal);
      if (result) return result;
    }
    return undefined;
  };
}

/** 書き換えた content は次のフックが受け取る。terminate は後勝ち */
export function composeAfter(
  hooks: (AfterToolCall | undefined)[],
): AfterToolCall | undefined {
  const list = hooks.filter((hook) => hook !== undefined);
  if (list.length <= 1) return list[0];

  return async (context, signal) => {
    let content = context.result;
    let terminate: boolean | undefined;
    let touched = false;

    for (const hook of list) {
      const result = await hook({ ...context, result: content }, signal);
      if (!result) continue;
      touched = true;
      if (result.content !== undefined) content = result.content;
      if (result.terminate !== undefined) terminate = result.terminate;
    }

    return touched ? { content, terminate } : undefined;
  };
}
