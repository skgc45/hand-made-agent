import { type CustomEvent, EventType } from "@ag-ui/core";

export type SubagentBody = { job?: string } & (
  | { event: "start"; prompt: string }
  | { event: "tool"; tool: string }
  | {
      event: "end";
      tools: number;
      steps: number;
      promptTokens: number;
      capped: boolean;
    }
  | { event: "done" }
);

/** name → value の対応表。フロントとテレメトリは型なしの JSON で受けるので、名前とフィールド名は wire の一部 */
export type CustomPayloads = {
  retry: {
    attempt: number;
    waitSeconds: number;
    status?: number;
    message: string;
  };
  gate: {
    decision: "ask" | "block" | "run";
    tool: string;
    arguments: string;
  };
  recovered: { calls: { tool: string; attempted: boolean }[] };
  hook: { event: string; reason: string };
  prompt: { from: string; chars: number };
  steering: { messages: string[] };
  reexec: { tool: string; arguments: string };
  usage: {
    messages: number;
    promptTokens: number;
    completionTokens: number;
    charsPerToken: number;
    totalPromptTokens: number;
  };
  graph: {
    dropped: number;
    added: number;
    superseded: number;
    total: number;
    active: number;
    unparsed: boolean;
    promptTokens: number;
    completionTokens: number;
  };
  compact: {
    dropped: number;
    promptTokens: number;
    completionTokens: number;
    summary: string;
  };
  trim: { strategy: string; removed: number; kept: number };
  subagent: { agent: string } & SubagentBody;
};

export type CustomName = keyof CustomPayloads;

/** CustomEvent の value は any で、交差させると any に潰れるので外して作る */
export type TypedCustomEvent<N extends CustomName> = Omit<
  CustomEvent,
  "name" | "value"
> & { name: N; value: CustomPayloads[N] };

export type AgentCustomEvent = {
  [N in CustomName]: TypedCustomEvent<N>;
}[CustomName];

export function custom<N extends CustomName>(
  name: N,
  value: CustomPayloads[N],
): TypedCustomEvent<N> {
  return { type: EventType.CUSTOM, name, value };
}
