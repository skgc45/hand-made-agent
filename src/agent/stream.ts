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

  /**
   * delta のどのツール呼び出しかを決める。
   * OpenAI は index を必ず付けるが、Gemini は付けず id で区別してくる。
   * 配列位置で代用すると、別チャンクで来た2つ目が1つ目に融合する。
   */
  private slotFor(part: NonNullable<Delta["tool_calls"]>[number]): number {
    if (typeof part.index === "number") return part.index;
    if (part.id) {
      for (const [slot, call] of this.calls) {
        if (call.id === part.id) return slot;
      }
      return this.calls.size;
    }
    // id も index も無ければ、直前の呼び出しの引数の続き
    return Math.max(0, this.calls.size - 1);
  }

  /** 新しく現れたツール呼び出しの index を返す（TOOL_CALL_START を出す用） */
  add(delta: Delta): { started: number[] } {
    if (delta.content) this.content += delta.content;

    const started: number[] = [];
    for (const part of delta.tool_calls ?? []) {
      const index = this.slotFor(part);
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

  /** ARGS イベントを出すとき、delta の断片がどの呼び出しのものか引く */
  slotOf(part: NonNullable<Delta["tool_calls"]>[number]): number {
    return this.slotFor(part);
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
