import {
  type AfterToolCall,
  type BeforeToolCall,
  type BeforeUserMessage,
  messageOf,
} from "./loop.js";

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
      try {
        const result = await hook({ ...context, result: content }, signal);
        if (!result) continue;
        touched = true;
        if (result.content !== undefined) content = result.content;
        if (result.terminate !== undefined) terminate = result.terminate;
      } catch (error) {
        // 1つのフックの失敗で、後ろのフックまで飛ばさない。
        // 飛ばすと切り詰めが効かず、ツールの出力がそのまま履歴に入る
        touched = true;
        content = `${content}\n（afterToolCall が失敗しました: ${messageOf(error)}）`;
      }
    }

    return touched ? { content, terminate } : undefined;
  };
}

/**
 * 差し替えた入力は次のフックが受け取る。block は先に言ったほうが勝つ。
 * compact も先勝ちだが、即座には返さない。後続（外部の UserPromptSubmit フックなど）が
 * まだ block できるよう最後まで回し、block が無ければ最後に compact を勝たせる
 * （先に commandHook が同名の `/compact` を展開していても、言ったもの勝ちで無視する）
 */
export function composeUser(
  hooks: (BeforeUserMessage | undefined)[],
): BeforeUserMessage | undefined {
  const list = hooks.filter((hook) => hook !== undefined);
  if (list.length <= 1) return list[0];

  return async (text, signal) => {
    let current = text;
    const contexts: string[] = [];
    let replaced = false;
    let compact: string | undefined;

    for (const hook of list) {
      const result = await hook(current, signal);
      if (!result) continue;
      if (result.blocked) return result;
      if (compact === undefined && result.compact !== undefined) {
        compact = result.compact;
        continue;
      }
      if (result.replace !== undefined) {
        current = result.replace;
        replaced = true;
      }
      if (result.context) contexts.push(result.context);
    }

    if (compact !== undefined) return { compact };
    if (!replaced && contexts.length === 0) return undefined;
    return {
      replace: replaced ? current : undefined,
      context: contexts.length > 0 ? contexts.join("\n\n") : undefined,
    };
  };
}
