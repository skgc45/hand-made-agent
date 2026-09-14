import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import type OpenAI from "openai";
import type { Profile } from "../profile/index.js";
import {
  type AfterToolCall,
  Agent,
  type AgentEvent,
  type BeforeToolCall,
} from "./loop.js";
import type { Toolset } from "./toolset.js";

const NO_APPROVAL =
  "サブエージェントの中では承認を求められません。この呼び出しは実行していません。親エージェントに結果を返し、必要なら親が自分で実行してください。";
/** 止まる前に子を待つ上限。これを超えたら run を終わらせ、残りは次の run の頭で渡す */
const SETTLE_MS = 60_000;
const CAPPED =
  "ターン数の上限に達しました。これ以上は道具を使えません。ここまでで分かったことだけで報告してください。";

export type SubagentDef = {
  name: string;
  description: string;
  /** background で起動できるか */
  background?: boolean;
  system: string;
  /** 親の道具のうち、この種類のものだけ渡す */
  kinds: ("read" | "edit" | "execute")[];
  /** ターン数の上限。止まらない子を止める */
  steps: number;
};

/**
 * background で走らせた子の受け取り口。
 * 完了は新しい通知経路ではなく、steering / follow-up キューに合流させる
 */
export type JobQueue = {
  /** 終わっているものだけ引き取る。待たない（ターンの合間に呼ばれる） */
  poll(): string[];
  /**
   * 走っているものを待って引き取る（親が止まろうとしたときに呼ばれる）。
   * 待つのは上限まで。間に合わなかったぶんは次の run の頭で届く
   */
  settle(): Promise<string[]>;
  running(): number;
  /** プロセスを畳むときに全部止める */
  stop(): Promise<void>;
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
    background: true,
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
    background: true,
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
function toolsFor(
  profile: Profile,
  def: SubagentDef,
  own: Set<string>,
): Toolset {
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
        : Promise.resolve(
            `エラー: このサブエージェントは ${name} を使えません`,
          ),
  };
}

/**
 * 子のイベントは親のストリームに混ぜない（UI が親の呼び出しと区別できなくなる）。
 * 何が起きたかは CUSTOM 1種類に畳んで、ツール結果の直前に流す。
 */
export function createSubagentTools(
  profile: Profile,
  deps: SubagentDeps,
): Toolset & {
  kinds: Record<string, "read" | "edit" | "execute">;
  jobs: JobQueue;
} {
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
    job?: string,
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

    emit(def.name, { event: "start", job, prompt: prompt.slice(0, 200) });

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
            emit(def.name, { event: "tool", job, tool: event.toolCallName });
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

    emit(def.name, { event: "end", job, tools, steps, promptTokens, capped });

    const answer = texts.get(last)?.trim();
    if (!answer) return "(サブエージェントは何も返しませんでした)";
    return capped
      ? `${answer}\n\n（${def.steps} ターンの上限に達したので、途中までで報告させました。続きが要るなら指示を分けてください）`
      : answer;
  }

  type Job = {
    id: string;
    agent: string;
    stop: AbortController;
    settled: Promise<void>;
  };

  const running = new Map<string, Job>();
  const finished: string[] = [];
  let counter = 0;

  /** 待たずに起動する。結果は steering / follow-up 経由で親の会話に戻る */
  function start(def: SubagentDef, prompt: string): string {
    const id = `job-${(counter += 1)}`;
    const stop = new AbortController();
    const job: Job = {
      id,
      agent: def.name,
      stop,
      settled: run(def, prompt, stop.signal, id)
        .catch((error: Error) => `エラー: ${error.message}`)
        .then((answer) => {
          running.delete(id);
          // ユーザーにはまだ見えていない。親が自分の言葉で伝える必要がある
          finished.push(
            `[${id} / ${def.name} 完了] 以下はサブエージェントからの報告です。` +
              `ユーザーはこれを見ていないので、聞かれたことに答える形で自分の言葉でまとめ直してください。\n${answer}`,
          );
          emit(def.name, { event: "done", job: id });
        }),
    };
    running.set(id, job);
    return `${id} を起動しました（${def.name}）。結果は終わり次第このあとの会話に届きます。待つ道具は要りません（sleep などで待たないこと）。他にやることがあれば進め、無ければその旨だけ答えて構いません。任せた仕事を自分でやり直さないこと。答え終わる前に結果が届きます。届かないまま会話が再開された場合は、プロセスが落ちて失われたと考えてください。`;
  }

  const jobs: JobQueue = {
    poll: () => finished.splice(0, finished.length),
    running: () => running.size,
    async settle() {
      await Promise.race([
        Promise.allSettled([...running.values()].map((job) => job.settled)),
        new Promise((resolve) => setTimeout(resolve, SETTLE_MS).unref()),
      ]);
      return finished.splice(0, finished.length);
    },
    async stop() {
      for (const job of running.values()) job.stop.abort();
      await Promise.allSettled([...running.values()].map((job) => job.settled));
    },
  };

  const byName = new Map(SUBAGENTS.map((def) => [def.name, def]));

  return {
    jobs,
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
            ...(def.background
              ? {
                  background: {
                    type: "boolean",
                    description:
                      "true にすると結果を待たずに戻る。結果は終わり次第この会話に届く。待っている間に進められる作業があるときに使う。",
                  },
                }
              : {}),
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
      const { prompt, background } = (input ?? {}) as {
        prompt?: string;
        background?: boolean;
      };
      if (!prompt) return "エラー: prompt が要ります";
      try {
        // background は run の signal に繋がない。親の run が終わっても走り続ける
        if (background && def.background) return start(def, prompt);
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
- 1〜2ファイル読めば済むときは自分で読む。任せるほうが遅くなる。
- 結果を待たずに別の作業を進められるなら background: true で起動する。
  結果は終わり次第こちらに届くので、届いてからまとめれば足りる。`;

/** プロファイルに task 系の道具を足す。権限ルールはツール名で効くので、子ごとに別のツールにする */
export function withSubagents(
  profile: Profile,
  deps: SubagentDeps,
): { profile: Profile; jobs: JobQueue } {
  const sub = createSubagentTools(profile, deps);

  const next: Profile = {
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

  return { profile: next, jobs: sub.jobs };
}
