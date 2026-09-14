import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import type OpenAI from "openai";
import {
  type AfterToolCall,
  Agent,
  type AgentEvent,
  type BeforeToolCall,
} from "./loop.js";
import type { Toolset } from "./toolset.js";
import type { Profile } from "../profile/index.js";

const NO_APPROVAL =
  "サブエージェントの中では承認を求められません。この呼び出しは実行していません。親エージェントに結果を返し、必要なら親が自分で実行してください。";
const CAPPED =
  "ターン数の上限に達しました。これ以上は道具を使えません。ここまでで分かったことだけで報告してください。";

export type SubagentDef = {
  name: string;
  description: string;
  system: string;
  /** 親の道具のうち、この種類のものだけ渡す */
  kinds: ("read" | "edit" | "execute")[];
  /** ターン数の上限。止まらない子を止める */
  steps: number;
};

export type SubagentDeps = {
  client: OpenAI;
  model: string;
  contextLimit: number;
  trim: string;
  /** 親と同じフックを通す。組み立ての都合で、中身は後から差される */
  hooks: { beforeToolCall?: BeforeToolCall; afterToolCall?: AfterToolCall };
};

const ANSWER = `報告の仕方:
- 呼び出し元はあなたの会話を見られません。最後の返答だけが渡ります。
- 見つけたものは、ファイルパスと該当箇所を添えて書くこと。
- 途中経過ではなく結論から書くこと。`;

export const SUBAGENTS: SubagentDef[] = [
  {
    name: "explore",
    description:
      "調査を別のエージェントに任せる。ファイルを読む道具だけを持ち、調べた結果だけを返す。探索の往復はこちらの履歴に入らないので、当たりが付いていない調べものに使う。",
    kinds: ["read"],
    steps: 12,
    system: `あなたは調査専門のサブエージェントです。読むことしかできません。
渡された質問に答えるために必要なファイルを自分で探して読み、答えを文章で返してください。

${ANSWER}`,
  },
  {
    name: "delegate",
    description:
      "まとまった作業を別のエージェントに任せる。親と同じ道具を持ち、作業の往復はこちらの履歴に入らない。手順が読めていて、結果だけ受け取れば済む作業に使う。",
    kinds: ["read", "edit", "execute"],
    steps: 20,
    system: `あなたは作業を任されたサブエージェントです。
渡された指示をやり切って、何をしたかを文章で返してください。

${ANSWER}`,
  },
];

/**
 * 子の門番。中断の往復ができないので承認は諦め、
 * 上限は殺さずに道具だけ取り上げる（殺すと、そこまでのトークンが報告なしで消える）
 */
function childGate(
  before: BeforeToolCall | undefined,
  overBudget: () => boolean,
): BeforeToolCall {
  return async (context, signal) => {
    if (overBudget()) return { kind: "block", reason: CAPPED };
    const decision = await before?.(context, signal);
    if (decision?.kind === "suspend") {
      return { kind: "block", reason: NO_APPROVAL };
    }
    return decision;
  };
}

/** 親の道具から、この子に渡すぶんだけを抜く。子は子を呼べない */
function toolsFor(profile: Profile, def: SubagentDef, own: Set<string>): Toolset {
  const allowed = new Set(
    profile.toolset.tools
      .filter((tool) => tool.type === "function")
      .map((tool) => tool.function.name)
      .filter(
        (name) =>
          !own.has(name) &&
          def.kinds.includes(profile.kinds[name] ?? "execute"),
      ),
  );

  return {
    tools: profile.toolset.tools.filter(
      (tool) => tool.type === "function" && allowed.has(tool.function.name),
    ),
    execute: (name, input, signal) =>
      allowed.has(name)
        ? profile.toolset.execute(name, input, signal)
        : Promise.resolve(`エラー: このサブエージェントは ${name} を使えません`),
  };
}

/**
 * 子のイベントは親のストリームに混ぜない（UI が親の呼び出しと区別できなくなる）。
 * 何が起きたかは CUSTOM 1種類に畳んで、ツール結果の直前に流す。
 */
export function createSubagentTools(
  profile: Profile,
  deps: SubagentDeps,
): Toolset & { kinds: Record<string, "read" | "edit" | "execute"> } {
  const own = new Set(SUBAGENTS.map((def) => def.name));
  const queue: AgentEvent[] = [];
  const emit = (agent: string, value: Record<string, unknown>) => {
    queue.push({
      type: EventType.CUSTOM,
      name: "subagent",
      value: { agent, ...value },
    });
  };

  async function run(
    def: SubagentDef,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let steps = 0;
    const child = new Agent({
      client: deps.client,
      model: deps.model,
      system: def.system,
      toolset: toolsFor(profile, def, own),
      contextLimit: deps.contextLimit,
      trim: deps.trim,
      stream: false,
      beforeToolCall: childGate(
        deps.hooks.beforeToolCall,
        () => steps >= def.steps,
      ),
      afterToolCall: deps.hooks.afterToolCall,
    });

    // 親の中断は子にも効かせる。ターン上限は子を止める唯一の手段
    const stop = new AbortController();
    const relay = () => stop.abort();
    signal?.addEventListener("abort", relay);

    const texts = new Map<string, string>();
    let last = "";
    let tools = 0;
    let promptTokens = 0;
    let capped = false;

    emit(def.name, { event: "start", prompt: prompt.slice(0, 200) });

    try {
      for await (const event of child.run(
        prompt,
        randomUUID(),
        undefined,
        stop.signal,
      )) {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_CONTENT:
            texts.set(
              event.messageId,
              (texts.get(event.messageId) ?? "") + event.delta,
            );
            last = event.messageId;
            break;
          case EventType.TOOL_CALL_START:
            tools += 1;
            emit(def.name, { event: "tool", tool: event.toolCallName });
            break;
          case EventType.STEP_FINISHED:
            steps += 1;
            if (steps >= def.steps) capped = true;
            // 道具を取り上げても止まらない子がいるので、倍のところで本当に殺す
            if (steps >= def.steps * 2) stop.abort();
            break;
          case EventType.CUSTOM:
            if (event.name === "usage") {
              promptTokens = Number(
                (event.value as { totalPromptTokens?: number })
                  .totalPromptTokens ?? promptTokens,
              );
            }
            break;
        }
      }
    } finally {
      signal?.removeEventListener("abort", relay);
    }

    emit(def.name, { event: "end", tools, steps, promptTokens, capped });

    const answer = texts.get(last)?.trim();
    if (!answer) return "(サブエージェントは何も返しませんでした)";
    return capped
      ? `${answer}\n\n（${def.steps} ターンの上限に達したので、途中までで報告させました。続きが要るなら指示を分けてください）`
      : answer;
  }

  const byName = new Map(SUBAGENTS.map((def) => [def.name, def]));

  return {
    tools: SUBAGENTS.map((def) => ({
      type: "function",
      function: {
        name: def.name,
        description: def.description,
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "サブエージェントへの指示。相手はこの会話を見られないので、必要な背景と、何を返してほしいかを全部書く。",
            },
          },
          required: ["prompt"],
        },
      },
    })),
    kinds: Object.fromEntries(
      SUBAGENTS.map((def) => [
        def.name,
        def.kinds.every((kind) => kind === "read") ? "read" : "execute",
      ]),
    ) as Record<string, "read" | "edit" | "execute">,
    drain: () => queue.splice(0, queue.length),
    async execute(name, input, signal) {
      const def = byName.get(name);
      if (!def) return `エラー: 未知のサブエージェント ${name}`;
      const { prompt } = (input ?? {}) as { prompt?: string };
      if (!prompt) return "エラー: prompt が要ります";
      try {
        return await run(def, prompt, signal);
      } catch (error) {
        return `エラー: サブエージェントが失敗しました: ${(error as Error).message}`;
      }
    },
  };
}

/** 道具があるだけでは選ばれない。いつ任せるかは system で言う */
const CHOOSING = `道具の選び方:
- 当たりが付いていない調べもの（どこにあるか分からない、何ファイルも読む必要がある）は
  explore に任せる。読んだ中身はこちらの履歴に入らないので、長い作業を続けられる。
- 手順が読めていて結果だけ受け取れば済むまとまった作業は delegate に任せる。
- 1〜2ファイル読めば済むときは自分で読む。任せるほうが遅くなる。`;

/** プロファイルに task 系の道具を足す。権限ルールはツール名で効くので、子ごとに別のツールにする */
export function withSubagents(profile: Profile, deps: SubagentDeps): Profile {
  const sub = createSubagentTools(profile, deps);

  return {
    ...profile,
    system: `${profile.system}\n\n${CHOOSING}`,
    kinds: { ...profile.kinds, ...sub.kinds },
    toolset: {
      tools: [...profile.toolset.tools, ...sub.tools],
      drain: sub.drain,
      execute: (name, input, signal) =>
        sub.kinds[name] !== undefined
          ? sub.execute(name, input, signal)
          : profile.toolset.execute(name, input, signal),
    },
  };
}
