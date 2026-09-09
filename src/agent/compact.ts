import type OpenAI from "openai";

const INSTRUCTION = `会話ログを要約する。
判明した事実・数値・ファイル名・実行したコマンドとその結果・結論を落とさないこと。
箇条書きで簡潔に。前置き・推測・感想は書かない。`;

function render(message: OpenAI.ChatCompletionMessageParam): string {
  if (message.role === "assistant" && message.tool_calls?.length) {
    return message.tool_calls
      .map((c) =>
        c.type === "function"
          ? `${c.function.name}(${c.function.arguments})`
          : c.type,
      )
      .join(", ");
  }
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

export type SummaryResult = {
  text: string;
  promptTokens: number;
  completionTokens: number;
};

export async function summarize(
  client: OpenAI,
  model: string,
  previous: string,
  dropped: OpenAI.ChatCompletionMessageParam[],
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const transcript = dropped
    .map((m) => `[${m.role}] ${render(m)}`)
    .join("\n")
    .slice(0, 20000);

  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: "system", content: INSTRUCTION },
        {
          role: "user",
          content: `${previous ? `これまでの要約:\n${previous}\n\n` : ""}追加する会話ログ:\n${transcript}`,
        },
      ],
    },
    { signal },
  );

  return {
    text: response.choices[0].message.content?.trim() || previous,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  };
}
