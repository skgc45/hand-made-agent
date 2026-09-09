import type OpenAI from "openai";

/** Agent に渡す道具一式。何が入っているかを loop.ts は知らない */
export type Toolset = {
  tools: OpenAI.ChatCompletionTool[];
  execute(
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string>;
};
