import type OpenAI from "openai";

const INSTRUCTION = `会話ログを要約する。
判明した事実・数値・ファイル名・実行したコマンドとその結果・結論を落とさないこと。
箇条書きで簡潔に。前置き・推測・感想は書かない。`;

export function render(message: OpenAI.ChatCompletionMessageParam): string {
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

const CHUNK_CHARS = 20000;

/**
 * 1回に渡すぶんずつ切る。先頭だけ渡して残りを捨てると、要約されないまま履歴から消える。
 * 行の途中では切らない（1行が上限を超えるときだけ、その行を分ける）
 */
export function transcriptChunks(
  dropped: OpenAI.ChatCompletionMessageParam[],
  limit = CHUNK_CHARS,
): string[] {
  const lines = dropped.flatMap((m) => {
    const line = `[${m.role}] ${render(m)}`;
    const parts: string[] = [];
    for (let i = 0; i < line.length; i += limit) {
      parts.push(line.slice(i, i + limit));
    }
    return parts.length > 0 ? parts : [line];
  });

  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + 1 + line.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function summarize(
  client: OpenAI,
  model: string,
  previous: string,
  transcript: string,
  signal?: AbortSignal,
): Promise<SummaryResult> {
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
