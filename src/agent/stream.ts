import type OpenAI from "openai";

type Delta = OpenAI.ChatCompletionChunk.Choice.Delta;
type Call = OpenAI.ChatCompletionMessageFunctionToolCall & {
  [key: string]: unknown;
};

function assignDefined(target: Record<string, unknown>, source: object): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
}

/** delta を1つのメッセージに畳む。プロバイダ固有の追加フィールドも落とさない */
export class MessageAccumulator {
  private content = "";
  private readonly calls = new Map<number, Call>();

  /** 新しく現れたツール呼び出しの index を返す（TOOL_CALL_START を出す用） */
  add(delta: Delta): { started: number[] } {
    if (delta.content) this.content += delta.content;

    const started: number[] = [];
    for (const [i, part] of (delta.tool_calls ?? []).entries()) {
      const index = part.index ?? i;
      let call = this.calls.get(index);
      if (!call) {
        call = {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        } as Call;
        this.calls.set(index, call);
        started.push(index);
      }

      // function 以外（id / type / Gemini の extra_content など）はそのまま持ち回る
      const { function: fn, index: _index, ...rest } = part;
      assignDefined(call as unknown as Record<string, unknown>, rest);
      if (fn?.name) call.function.name += fn.name;
      if (fn?.arguments) call.function.arguments += fn.arguments;
    }
    return { started };
  }

  callAt(index: number): Call | undefined {
    return this.calls.get(index);
  }

  toolCallIds(): string[] {
    return [...this.calls.values()].map((c) => c.id);
  }

  message(): OpenAI.ChatCompletionAssistantMessageParam {
    const calls = [...this.calls.values()];
    return {
      role: "assistant",
      content: this.content || null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    };
  }
}
