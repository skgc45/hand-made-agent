import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CustomEvent,
  EventType,
  type Interrupt,
  type ResumeEntry,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import OpenAI from "openai";
import { render, summarize } from "./compact.js";
import { extractFacts, type Fact, FactGraph } from "./graph.js";
import { type PromptSection, SystemPrompt } from "./prompt.js";
import { MessageAccumulator } from "./stream.js";
import type { Toolset } from "./toolset.js";
import { charCount, splitSafe, trimNaive, trimSafe } from "./trim.js";

export type AgentEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | CustomEvent;

export type ToolCallContext = {
  toolCallId: string;
  name: string;
  arguments: string;
  messages: readonly OpenAI.ChatCompletionMessageParam[];
  /** 前の run が実行を始めたまま落ちている。もう一度走らせると二重になりうる */
  attempted?: boolean;
  /** 中断から再開したときだけ入る。payload をどう読むかはフックが決める */
  resume?: ResumeEntry;
  /**
   * 先に起動したツールが終わるまで待つ。並列だと後続の判定が先行の結果より先に走るので、
   * 順序が要るフック（read-before-edit ガード）だけが呼ぶ。
   * id を渡せばそのぶんだけ待つ。何が衝突するかを知っているのはフックだけなので、
   * ループは渡された id を引くだけにする
   */
  waitForRunning?: (toolCallIds?: string[]) => Promise<void>;
};

/**
 * undefined を返せば実行する。止めるときだけ値を返す（pi の beforeToolCall と同じ形）。
 * suspend は pi に無い。AG-UI の Interrupt に載せて run を中断するために足した。
 */
export type BeforeToolCallResult =
  /** 後ろのフックに聞かずに実行する。承認を飛ばしたいフックが使う */
  | { kind: "allow" }
  | { kind: "block"; reason: string; terminate?: boolean }
  | {
      kind: "suspend";
      /** id と toolCallId はループが埋める。それ以外はフックの言うとおりに載せる */
      interrupt: Omit<Interrupt, "id" | "toolCallId">;
    }
  | undefined;

export type BeforeToolCall = (
  context: ToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult>;

export type ToolResultContext = ToolCallContext & {
  result: string;
  /** beforeToolCall が止めた結果か（ツールは実行されていない） */
  blocked: boolean;
};

/** 省略したフィールドは元の値を保つ。deep merge はしない（pi と同じ） */
export type AfterToolCallResult =
  | { content?: string; terminate?: boolean }
  | undefined;

export type AfterToolCall = (
  context: ToolResultContext,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult>;

/** 入力を履歴に積む前の穴。止めるか、差し替えるか、文脈を足すか、何もしないか */
export type BeforeUserMessageResult =
  | { blocked?: string; replace?: string; context?: string }
  | undefined;

export type BeforeUserMessage = (
  text: string,
  signal?: AbortSignal,
) => Promise<BeforeUserMessageResult>;

export type AgentConfig = {
  client: OpenAI;
  model: string;
  system: string;
  /** 何のエージェントかは、ここに何を渡すかで決まる */
  toolset: Toolset;
  /** 起動時に集めた文脈。IO を伴うので、集めるのは Agent の外 */
  sections?: PromptSection[];
  contextLimit: number;
  trim: string;
  /** ツール実行の直前に呼ばれる唯一の穴。承認もレート制限もここに挿す */
  beforeToolCall?: BeforeToolCall;
  /** ツール結果の書き換えと terminate の申告 */
  afterToolCall?: AfterToolCall;
  /** ユーザー入力を積む前に呼ばれる */
  beforeUserMessage?: BeforeUserMessage;
  /** 状態が変わるたびに呼ばれる。どこに書くかは Agent の関心事ではない */
  append?: AppendFn;
  /** false にすると応答が出揃ってから1回で流す（ステップ7 以前の挙動） */
  stream?: boolean;
  /** 走っている最中に割り込む文言。ターンの合間に context へ注入される */
  getSteeringMessages?: () => Promise<string[]>;
  /** 止まろうとした瞬間に確認される文言。あれば会話を続ける */
  getFollowUpMessages?: () => Promise<string[]>;
  threadId?: string;
};

/** 同時に走らせるツールの数。無料枠の 5 RPM を並列で自分から踏みにいかない値 */
const PARALLEL_LIMIT = 4;

const ABORTED = "中断されました";
const ABORTED_RUNNING =
  "中断されました。このツールは実行中だったので、途中まで走ったかもしれません。";

/** 投げられるのは Error とは限らない。message が無いものを undefined にしない */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const LOST_RUNNING =
  "実行の途中でプロセスが落ちたため、結果が残っていません。副作用が出たかどうかは外から分かりません（実行された可能性があります）。";
const LOST_BEFORE =
  "実行される前にプロセスが落ちました。このツールは実行されていません。";
const SUMMARY = "これまでの経緯";
const FACTS = "分かっている事実";

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIUserAbortError) return false;
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || (error.status ?? 0) >= 500;
  }
  return false;
}

type Pending = {
  interruptId: string;
  calls: OpenAI.ChatCompletionMessageFunctionToolCall[];
  /** 結果が積まれた tool_call の id。並列では「何件目まで」に意味が無い */
  done: string[];
  /** 中断より前のツールが全部 terminate を立てていたか */
  terminateSoFar: boolean;
};

/** 並列化より前に書かれた pending は「何件目まで」しか持たない。id の集合に直す */
function normalizePending(
  pending: Pending | null | undefined,
): Pending | undefined {
  if (!pending) return undefined;
  if (Array.isArray(pending.done)) return pending;

  const index = (pending as { index?: unknown }).index;
  return {
    ...pending,
    done:
      typeof index === "number"
        ? pending.calls.slice(0, index).map((call) => call.id)
        : // どこまで済んだか分からない。再実行より欠落のほうが直せる
          // （結果の無い tool_calls は recover() が埋める）
          pending.calls.map((call) => call.id),
  };
}

type ToolBatchOutcome = { suspended: boolean; terminate: boolean };

type GeneratedMessage = {
  message: OpenAI.ChatCompletionMessageParam & {
    tool_calls?: OpenAI.ChatCompletionMessageToolCall[];
  };
  usage?: OpenAI.CompletionUsage;
};

/**
 * 永続化の単位。snapshot を丸ごと上書きせず、変化した分だけ追記する。
 * AG-UI イベントは表示用に情報を落としているので、復元には使えない（別の口が要る）。
 */
export type Entry =
  | { kind: "message"; message: OpenAI.ChatCompletionMessageParam }
  /** trim / compact は履歴を書き換えるので、その時点の全文を1件として置く */
  | {
      kind: "history";
      messages: OpenAI.ChatCompletionMessageParam[];
      summaryText: string;
    }
  | { kind: "pending"; pending: Pending | null }
  /** 実行を始めた印。対応する tool 結果が積まれるまで閉じない */
  | { kind: "attempt"; toolCallId: string; name: string }
  | { kind: "fact"; facts: Fact[] }
  | { kind: "usage"; promptTokens: number; charsPerToken: number };

export type AppendFn = (entry: Entry) => Promise<void>;

export class Agent {
  readonly messages: OpenAI.ChatCompletionMessageParam[];
  readonly threadId: string;

  private pending?: Pending;
  /** 結果が残っていない実行。落ちた run から持ち越した「走ったかもしれない」 */
  private readonly attempted = new Set<string>();
  /** 起動時の後始末の中身。最初の run で1回だけイベントにして捨てる */
  private recovered: { tool: string; attempted: boolean }[] = [];
  private summaryText = "";
  private readonly graph = new FactGraph();
  private charsPerToken = 3;
  private totalPromptTokens = 0;

  private readonly toolsChars: number;
  private readonly prompt: SystemPrompt;

  constructor(private readonly config: AgentConfig) {
    this.toolsChars = JSON.stringify(config.toolset.tools).length;
    this.threadId = config.threadId ?? randomUUID();
    this.prompt = new SystemPrompt(config.system);
    for (const { heading, body } of config.sections ?? []) {
      this.prompt.set(heading, body);
    }
    this.messages = [this.prompt.message()];
  }

  private syncSystem(): void {
    this.messages[0] = this.prompt.message();
  }

  /** 追記されたエントリを順に適用して状態を組み立て直す */
  replay(entries: Entry[]): void {
    for (const entry of entries) {
      switch (entry.kind) {
        case "message":
          if (entry.message.role === "tool") {
            this.attempted.delete(entry.message.tool_call_id);
          }
          this.messages.push(entry.message);
          break;
        case "attempt":
          this.attempted.add(entry.toolCallId);
          break;
        case "history":
          this.replace(entry.messages);
          this.summaryText = entry.summaryText;
          this.prompt.set(SUMMARY, this.summaryText);
          break;
        case "pending":
          this.pending = normalizePending(entry.pending);
          break;
        case "fact":
          this.graph.apply(entry.facts);
          this.prompt.set(FACTS, this.graph.render());
          break;
        case "usage":
          this.totalPromptTokens += entry.promptTokens;
          this.charsPerToken = entry.charsPerToken;
          break;
      }
    }
    this.recover();
    // 保存された messages[0] ではなく、いまの素材から組み直す。
    // プロファイルを変えて同じスレッドを開いたとき、古い system が残らない
    this.syncSystem();
  }

  /**
   * 結果の無い tool_calls を埋める。落ちた run が残す唯一の壊れ方で、
   * 放っておくとモデルは「実行しました」と話を進めてしまう。
   * 実行したかどうかは attempt の印で分ける。追記はしない（同じログからは毎回同じ結果）。
   */
  private recover(): void {
    const answered = new Set(
      this.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
    );
    // 承認待ちの分はこれから実行するので、埋めると二重になる
    const settled = new Set(this.pending?.done ?? []);
    const pendingIds = new Set(
      this.pending?.calls.filter((c) => !settled.has(c.id)).map((c) => c.id) ??
        [],
    );

    const next: OpenAI.ChatCompletionMessageParam[] = [];
    let missing: OpenAI.ChatCompletionMessageToolCall[] = [];
    const flush = () => {
      for (const call of missing) {
        const attempted = this.attempted.has(call.id);
        next.push({
          role: "tool",
          tool_call_id: call.id,
          content: attempted ? LOST_RUNNING : LOST_BEFORE,
        });
        this.recovered.push({
          tool: call.type === "function" ? call.function.name : call.type,
          attempted,
        });
      }
      missing = [];
    };

    for (const message of this.messages) {
      if (message.role !== "tool") flush();
      next.push(message);
      if (message.role === "assistant" && message.tool_calls?.length) {
        missing = message.tool_calls.filter(
          (c) => !answered.has(c.id) && !pendingIds.has(c.id),
        );
      }
    }
    flush();

    if (next.length !== this.messages.length) this.replace(next);
  }

  private async poll(
    which: "getSteeringMessages" | "getFollowUpMessages",
  ): Promise<string[]> {
    try {
      return (await this.config[which]?.()) ?? [];
    } catch (error) {
      console.error(`${which} が失敗:`, error);
      return [];
    }
  }

  private async record(entry: Entry): Promise<void> {
    try {
      await this.config.append?.(entry);
    } catch (error) {
      console.error("追記に失敗:", error);
    }
  }

  private async pushMessage(
    message: OpenAI.ChatCompletionMessageParam,
  ): Promise<void> {
    this.messages.push(message);
    await this.record({ kind: "message", message });
  }

  async *run(
    userInput: string,
    runId: string = randomUUID(),
    resume?: ResumeEntry[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    yield {
      type: EventType.RUN_STARTED,
      threadId: this.threadId,
      runId,
    };

    if (this.recovered.length > 0) {
      yield {
        type: EventType.CUSTOM,
        name: "recovered",
        value: { calls: this.recovered },
      };
      this.recovered = [];
    }

    let stopped = false;

    try {
      if (this.pending) {
        const entry = resume?.find(
          (r) => r.interruptId === this.pending?.interruptId,
        );

        const { calls, done, terminateSoFar } = this.pending;
        // メモリ上だけ先に消す。永続化はツール結果が積まれてから（executeCalls 内）
        this.pending = undefined;

        const outcome = yield* this.executeCalls(
          calls,
          new Set(done),
          { entry },
          runId,
          signal,
          terminateSoFar,
        );
        if (outcome.suspended) return;
        stopped = outcome.terminate;
      } else {
        const decision = await this.config.beforeUserMessage?.(
          userInput,
          signal,
        );
        if (decision?.blocked) {
          yield {
            type: EventType.CUSTOM,
            name: "hook",
            value: { event: "UserPromptSubmit", reason: decision.blocked },
          };
          yield {
            type: EventType.RUN_FINISHED,
            threadId: this.threadId,
            runId,
          };
          return;
        }
        // 差し替えたぶんが履歴に残る（スラッシュコマンドはここで本文になる）
        if (decision?.replace !== undefined) {
          yield {
            type: EventType.CUSTOM,
            name: "prompt",
            value: {
              from: userInput.trim().slice(0, 40),
              chars: decision.replace.length,
            },
          };
        }
        await this.pushMessage({
          role: "user",
          content: decision?.replace ?? userInput,
        });
        if (decision?.context) {
          await this.pushMessage({ role: "user", content: decision.context });
        }
      }

      let step = 0;
      let hasMoreToolCalls = !stopped;
      let injected = await this.poll("getSteeringMessages");

      // 外側は「止まろうとしたときに follow-up があるか」、
      // 内側は「ツール呼び出しが続くか、割り込みが来ているか」。pi と同じ二重ループ
      while (true) {
        while ((hasMoreToolCalls || injected.length > 0) && !signal?.aborted) {
          for (const text of injected) {
            await this.pushMessage({ role: "user", content: text });
          }
          if (injected.length > 0) {
            yield {
              type: EventType.CUSTOM,
              name: "steering",
              value: { messages: injected },
            };
          }
          injected = [];

          step += 1;
          const stepName = `turn-${step}`;
          yield { type: EventType.STEP_STARTED, stepName };

          // background の子の出来事は、ツールを呼ばないターンでも引き取る
          for (const event of this.config.toolset.drain?.() ?? []) yield event;

          yield* this.trimIfNeeded(signal);

          const { message, usage } = yield* this.generate(signal);

          if (usage) {
            this.totalPromptTokens += usage.prompt_tokens;
            await this.record({
              kind: "usage",
              promptTokens: usage.prompt_tokens,
              charsPerToken: this.charsPerToken,
            });
            yield this.usageEvent(usage);
          }

          await this.pushMessage(message);

          if (!message.tool_calls?.length) {
            yield { type: EventType.STEP_FINISHED, stepName };
            hasMoreToolCalls = false;
            injected = await this.poll("getSteeringMessages");
            continue;
          }

          const calls = message.tool_calls.filter(
            (c) => c.type === "function",
          ) as OpenAI.ChatCompletionMessageFunctionToolCall[];

          yield { type: EventType.STEP_FINISHED, stepName };

          const outcome = yield* this.executeCalls(
            calls,
            new Set(),
            undefined,
            runId,
            signal,
          );
          if (outcome.suspended) return;
          hasMoreToolCalls = !outcome.terminate;
          injected = await this.poll("getSteeringMessages");
        }

        if (signal?.aborted) break;

        const followUp = await this.poll("getFollowUpMessages");
        if (followUp.length === 0) break;
        injected = followUp;
        hasMoreToolCalls = false;
      }

      yield {
        type: EventType.RUN_FINISHED,
        threadId: this.threadId,
        runId,
      };
    } catch (error) {
      // 中断は異常終了ではない。pi の agent_end と同じく正常に閉じる
      if (!signal?.aborted) {
        yield {
          type: EventType.RUN_ERROR,
          message: (error as Error).message,
        };
        return;
      }
      yield {
        type: EventType.RUN_FINISHED,
        threadId: this.threadId,
        runId,
      };
    }
  }

  /**
   * 承認と権限の判定（preflight）は逐次、実行だけ並列。
   * 逐次にしないと承認プロンプトが同時に出て、どれに答えたのか誰にも分からなくなる。
   * terminate はバッチ全体のルール。**全部**のツールが立てたときだけ発動する（pi と同じ）。
   */
  private async *executeCalls(
    calls: OpenAI.ChatCompletionMessageFunctionToolCall[],
    done: ReadonlySet<string>,
    resumed: { entry: ResumeEntry | undefined } | undefined,
    runId: string,
    signal: AbortSignal | undefined,
    terminateSoFar = true,
  ): AsyncGenerator<AgentEvent, ToolBatchOutcome> {
    let allTerminate = terminateSoFar;
    // 再開したバッチは、最初の結果が積まれた時点で承認待ちを解除する。
    // 先に解除すると、ツール実行中に落ちたとき結果の無い tool_calls が残って 400 になる
    let clearPending = resumed !== undefined;

    const settle = async () => {
      if (!clearPending) return;
      clearPending = false;
      await this.record({ kind: "pending", pending: null });
    };

    type Slot = {
      call: OpenAI.ChatCompletionMessageFunctionToolCall;
      result: string;
      terminate: boolean;
    };
    const slots: Slot[] = [];
    const tasks: Promise<void>[] = [];
    const running = new Map<string, Promise<void>>();
    let suspend:
      | {
          call: OpenAI.ChatCompletionMessageFunctionToolCall;
          interrupt: Omit<Interrupt, "id" | "toolCallId">;
        }
      | undefined;
    let first = true;

    for (const call of calls) {
      if (done.has(call.id)) continue;
      const { name, arguments: args } = call.function;

      // 中断されても残りのツールに結果を積む。tool_calls と tool のペアを割らないため
      // （pi はここで break するが、我々の messages はそのまま API に渡るので 400 になる）
      if (signal?.aborted) {
        slots.push({ call, result: ABORTED, terminate: false });
        continue;
      }

      // 引数が読めないものは承認にもフックにもかけない。実行しようがない。
      // ここで投げると、同じバッチで動いている他のツールの結果まで積まれないまま run が終わる
      let input: unknown;
      try {
        input = JSON.parse(args);
      } catch (error) {
        const slot: Slot = {
          call,
          result: `エラー: 引数を JSON として読めません: ${messageOf(error)}`,
          terminate: false,
        };
        slots.push(slot);
        yield {
          type: EventType.CUSTOM,
          name: "gate",
          value: { decision: "block", tool: name, arguments: args },
        };
        tasks.push(this.runTool(slot, name, args, undefined, true, signal));
        continue;
      }

      const attempted = this.attempted.has(call.id);
      // 再開した1件だけ resume を添えて、同じフックにもう一度聞く。
      // ループは payload の中身を知らない
      // フックが投げても、同じバッチで走っているツールの結果を捨てない。
      // そのツールだけ止める（runTool と同じ立場）
      let decision: BeforeToolCallResult;
      try {
        decision = await this.config.beforeToolCall?.(
          {
            toolCallId: call.id,
            name,
            arguments: args,
            messages: this.messages,
            attempted,
            resume: first ? resumed?.entry : undefined,
            // 呼ばれた時点の running を固定する。自分はまだ入っていないので自分待ちにならない。
            // 終わった id は引けないので、フックが持ち越しても待ちは増えない
            waitForRunning: async (ids) => {
              await Promise.all(
                ids
                  ? ids.flatMap((id) => running.get(id) ?? [])
                  : [...running.values()],
              );
            },
          },
          signal,
        );
      } catch (error) {
        decision = {
          kind: "block",
          reason: `エラー: beforeToolCall が失敗しました: ${messageOf(error)}`,
        };
      }
      first = false;

      // 通したのか聞いたのか止めたのかは、ここでしか分からない。
      // 表示には出さないが、計測に残さないと承認の回数を数えられない
      yield {
        type: EventType.CUSTOM,
        name: "gate",
        value: {
          decision:
            decision?.kind === "suspend"
              ? "ask"
              : decision?.kind === "block"
                ? "block"
                : "run",
          tool: name,
          arguments: args,
        },
      };

      // 承認待ちに入ったら、これ以上は起動しない。走っている分は下で待ち切る
      if (decision?.kind === "suspend") {
        suspend = { call, interrupt: decision.interrupt };
        break;
      }

      const slot: Slot = { call, result: "", terminate: false };
      slots.push(slot);

      if (decision?.kind === "block") {
        slot.result = decision.reason;
        slot.terminate = decision.terminate === true;
        tasks.push(this.runTool(slot, name, args, undefined, true, signal));
        continue;
      }

      if (running.size >= PARALLEL_LIMIT) await Promise.race(running.values());

      // 空くのを待っている間に中断された。起動していないので未実行として積む
      if (signal?.aborted) {
        slot.result = ABORTED;
        continue;
      }

      if (attempted) {
        yield {
          type: EventType.CUSTOM,
          name: "reexec",
          value: { tool: name, arguments: args },
        };
      }
      // 実行する前に印を残す。結果が積まれないまま落ちたら、
      // 次の起動で「走ったかもしれない」と言える
      await this.record({ kind: "attempt", toolCallId: call.id, name });

      const task = this.runTool(slot, name, args, input, false, signal).finally(
        () => {
          running.delete(call.id);
        },
      );
      // runTool は投げない約束だが、破れたときに unhandled rejection で
      // プロセスごと落とさないための保険
      task.catch(() => {});
      running.set(call.id, task);
      tasks.push(task);
    }

    await Promise.all(tasks);

    // ツールの中で起きたことは、結果より先に出す。
    // 並列だと drain は共有の1本なので、どの結果に属するかは分からない
    for (const event of this.config.toolset.drain?.() ?? []) yield event;

    // イベントも履歴も tool_calls の順。完了順に積むと、同じログから同じ履歴が戻らない
    for (const slot of slots) {
      allTerminate &&= slot.terminate;
      yield await this.appendToolResult(slot.call, slot.result);
      await settle();
    }

    if (suspend) {
      const interruptId = randomUUID();
      // index ではなく「結果が積まれた id」。並列では index に意味が無い
      this.pending = {
        interruptId,
        calls,
        done: [...done, ...slots.map((s) => s.call.id)],
        terminateSoFar: allTerminate,
      };
      await this.record({ kind: "pending", pending: this.pending });
      yield {
        type: EventType.RUN_FINISHED,
        threadId: this.threadId,
        runId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: interruptId,
              toolCallId: suspend.call.id,
              ...suspend.interrupt,
            },
          ],
        },
      };
      return { suspended: true, terminate: false };
    }

    return {
      suspended: false,
      terminate: calls.length > 0 && allTerminate,
    };
  }

  private async runTool(
    slot: {
      call: OpenAI.ChatCompletionMessageFunctionToolCall;
      result: string;
      terminate: boolean;
    },
    name: string,
    args: string,
    input: unknown,
    blocked: boolean,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // 投げないこと。並列で1件でも投げると Promise.all が落ち、
    // 実行し終わった他のツールの結果まで積まれないまま run が終わる
    try {
      if (!blocked) {
        slot.result = await this.config.toolset.execute(name, input, signal);
      }
    } catch (error) {
      // 中断で落ちたものは未起動分と区別する。副作用が出たかもしれない
      slot.result = signal?.aborted
        ? ABORTED_RUNNING
        : `エラー: ${messageOf(error)}`;
    }

    try {
      const after = await this.config.afterToolCall?.(
        {
          toolCallId: slot.call.id,
          name,
          arguments: args,
          messages: this.messages,
          result: slot.result,
          blocked,
        },
        signal,
      );
      if (after) {
        slot.result = after.content ?? slot.result;
        slot.terminate = after.terminate ?? slot.terminate;
      }
    } catch (error) {
      // フックの失敗でツールの結果を捨てない。副作用はもう出ている
      slot.result = `${slot.result}\n（afterToolCall が失敗しました: ${messageOf(error)}）`;
    }
  }

  private async appendToolResult(
    call: OpenAI.ChatCompletionMessageFunctionToolCall,
    content: string,
  ): Promise<AgentEvent> {
    // 先に積んでから通知する。逆にすると、間で落ちたとき結果が抜けた状態が残る
    await this.pushMessage({
      role: "tool",
      tool_call_id: call.id,
      content,
    });
    this.attempted.delete(call.id);
    return {
      type: EventType.TOOL_CALL_RESULT,
      messageId: randomUUID(),
      toolCallId: call.id,
      content,
      role: "tool",
    };
  }

  private usageEvent(usage: OpenAI.CompletionUsage): CustomEvent {
    return {
      type: EventType.CUSTOM,
      name: "usage",
      value: {
        messages: this.messages.length,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        charsPerToken: Number(this.charsPerToken.toFixed(2)),
        totalPromptTokens: this.totalPromptTokens,
      },
    };
  }

  private limitChars(): number {
    return this.config.contextLimit * this.charsPerToken - this.toolsChars;
  }

  private async *trimIfNeeded(
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const { contextLimit, trim } = this.config;
    if (!contextLimit || trim === "none") return;

    const before = Math.round(
      (charCount(this.messages) + this.toolsChars) / this.charsPerToken,
    );
    if (before <= contextLimit) return;

    if (trim === "graph") {
      const { kept, dropped } = splitSafe(this.messages, this.limitChars());
      if (dropped.length === 0) return;

      const extracted = await extractFacts(
        this.config.client,
        this.config.model,
        dropped,
        render,
        signal,
      );
      this.totalPromptTokens += extracted.promptTokens;
      const { added, superseded } = this.graph.apply(extracted.facts);

      this.replace(kept);
      this.prompt.set(FACTS, this.graph.render());
      this.syncSystem();
      await this.record({ kind: "fact", facts: extracted.facts });
      await this.record({
        kind: "history",
        messages: [...this.messages],
        summaryText: this.summaryText,
      });

      yield {
        type: EventType.CUSTOM,
        name: "graph",
        value: {
          dropped: dropped.length,
          added,
          superseded,
          total: this.graph.size(),
          active: this.graph.active().length,
          unparsed: extracted.unparsed,
          promptTokens: extracted.promptTokens,
          completionTokens: extracted.completionTokens,
        },
      };
    } else if (trim === "compact") {
      const { kept, dropped } = splitSafe(this.messages, this.limitChars());
      if (dropped.length === 0) return;

      const summary = await summarize(
        this.config.client,
        this.config.model,
        this.summaryText,
        dropped,
        signal,
      );
      this.summaryText = summary.text;
      this.totalPromptTokens += summary.promptTokens;

      this.replace(kept);
      this.prompt.set(SUMMARY, this.summaryText);
      this.syncSystem();
      await this.record({
        kind: "history",
        messages: [...this.messages],
        summaryText: this.summaryText,
      });

      yield {
        type: EventType.CUSTOM,
        name: "compact",
        value: {
          dropped: dropped.length,
          promptTokens: summary.promptTokens,
          completionTokens: summary.completionTokens,
          summary: this.summaryText,
        },
      };
    } else {
      const trimmed =
        trim === "naive"
          ? trimNaive(this.messages, this.limitChars())
          : trimSafe(this.messages, this.limitChars());
      if (trimmed.length === this.messages.length) return;
      const removed = this.messages.length - trimmed.length;
      this.replace(trimmed);
      await this.record({
        kind: "history",
        messages: [...this.messages],
        summaryText: this.summaryText,
      });

      yield {
        type: EventType.CUSTOM,
        name: "trim",
        value: { strategy: trim, removed, kept: this.messages.length },
      };
    }
  }

  private replace(next: OpenAI.ChatCompletionMessageParam[]) {
    this.messages.length = 0;
    this.messages.push(...next);
  }

  private async *generate(
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, GeneratedMessage> {
    const sentChars = charCount(this.messages) + this.toolsChars;

    for (let attempt = 0; ; attempt++) {
      // 1文字でも流したあとに投げ直すと同じメッセージが二重に出るので、
      // リトライできるのは最初のチャンクが来る前だけ
      let emitted = false;
      try {
        const result = yield* this.config.stream === false
          ? this.generateWhole(signal)
          : this.generateStream(signal, () => {
              emitted = true;
            });
        if (result.usage?.prompt_tokens) {
          this.charsPerToken = sentChars / result.usage.prompt_tokens;
        }
        return result;
      } catch (error) {
        if (emitted || attempt >= 5 || !isRetryable(error)) throw error;

        const hint =
          error instanceof OpenAI.APIError
            ? /retry in ([\d.]+)s/.exec(error.message)
            : null;
        const wait = hint ? Math.ceil(Number(hint[1])) + 1 : 5 * 2 ** attempt;

        // 黙って寝るとハングと区別が付かない
        yield {
          type: EventType.CUSTOM,
          name: "retry",
          value: {
            attempt: attempt + 1,
            waitSeconds: wait,
            status: error instanceof OpenAI.APIError ? error.status : undefined,
            message: (error as Error).message.slice(0, 120),
          },
        };
        await sleep(wait * 1000, undefined, { signal });
      }
    }
  }

  private async *generateStream(
    signal: AbortSignal | undefined,
    onFirstChunk: () => void,
  ): AsyncGenerator<AgentEvent, GeneratedMessage> {
    const stream = await this.config.client.chat.completions.create(
      {
        model: this.config.model,
        messages: this.messages,
        tools: this.config.toolset.tools,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    const acc = new MessageAccumulator();
    let messageId: string | undefined;
    let usage: OpenAI.CompletionUsage | undefined;

    for await (const chunk of stream) {
      onFirstChunk();
      if (chunk.usage) usage = chunk.usage;

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!messageId) {
          messageId = randomUUID();
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          };
        }
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: delta.content,
        };
      }

      const { started } = acc.add(delta);
      for (const index of started) {
        const call = acc.callAt(index);
        if (!call) continue;
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: call.id,
          toolCallName: call.function.name,
        };
      }
      for (const part of delta.tool_calls ?? []) {
        if (!part.function?.arguments) continue;
        const call = acc.callAt(acc.slotOf(part));
        if (!call) continue;
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: call.id,
          delta: part.function.arguments,
        };
      }
    }

    if (messageId) yield { type: EventType.TEXT_MESSAGE_END, messageId };
    for (const toolCallId of acc.toolCallIds()) {
      yield { type: EventType.TOOL_CALL_END, toolCallId };
    }

    return { message: acc.message(), usage };
  }

  private async *generateWhole(
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, GeneratedMessage> {
    const response = await this.config.client.chat.completions.create(
      {
        model: this.config.model,
        messages: this.messages,
        tools: this.config.toolset.tools,
      },
      { signal },
    );
    const message = response.choices[0].message;

    if (message.content) {
      const messageId = randomUUID();
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: message.content,
      };
      yield { type: EventType.TEXT_MESSAGE_END, messageId };
    }

    for (const call of message.tool_calls ?? []) {
      if (call.type !== "function") continue;
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: call.id,
        toolCallName: call.function.name,
      };
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: call.id,
        delta: call.function.arguments,
      };
      yield { type: EventType.TOOL_CALL_END, toolCallId: call.id };
    }

    return { message, usage: response.usage };
  }
}
