import type OpenAI from "openai";
import type { AgentEvent } from "./loop.js";

/** Agent に渡す道具一式。何が入っているかを loop.ts は知らない */
export type Toolset = {
  tools: OpenAI.ChatCompletionTool[];
  execute(name: string, input: unknown, signal?: AbortSignal): Promise<string>;
  /**
   * 実行中に溜まった出来事を引き取る。ツールの中からはイベントを yield できないので、
   * ループが結果を積む直前にここを見る（サブエージェントが使う）
   */
  drain?(): AgentEvent[];
};
