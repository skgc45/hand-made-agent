import {
  type CustomEvent,
  EventType,
  type Interrupt,
  type RunErrorEvent,
  type RunFinishedEvent,
  type ResumeEntry,
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
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { render, summarize } from "./compact.js";
import { type Fact, FactGraph, extractFacts } from "./graph.js";
import { SystemPrompt } from "./prompt.js";
import { MessageAccumulator } from "./stream.js";
import { charCount, splitSafe, trimNaive, trimSafe } from "./trim.js";
import type { Toolset } from "./toolset.js";

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
  /** 中断から再開したときだけ入る。payload をどう読むかはフックが決める */
  resume?: ResumeEntry;
};

/**
 * undefined を返せば実行する。止めるときだけ値を返す（pi の beforeToolCall と同じ形）。
 * suspend は pi に無い。AG-UI の Interrupt に載せて run を中断するために足した。
 */
export type BeforeToolCallResult =
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
  { content?: string; terminate?: boolean } | undefined;

export type AfterToolCall = (
  context: ToolResultContext,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult>;

export type AgentConfig = {
  client: OpenAI;
  model: string;
  system: string;
  /** 何のエージェントかは、ここに何を渡すかで決まる */
  toolset: Toolset;
  contextLimit: number;
  trim: string;
  /** ツール実行の直前に呼ばれる唯一の穴。承認もレート制限もここに挿す */
  beforeToolCall?: BeforeToolCall;
  /** ツール結果の書き換えと terminate の申告 */
  afterToolCall?: AfterToolCall;
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

const ABORTED = "中断されました";
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
  index: number;
  /** 中断より前のツールが全部 terminate を立てていたか */
  terminateSoFar: boolean;
};

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
  | { kind: "fact"; facts: Fact[] }
  | { kind: "usage"; promptTokens: number; charsPerToken: number };

export type AppendFn = (entry: Entry) => Promise<void>;

export class Agent {
  readonly messages: OpenAI.ChatCompletionMessageParam[];
  readonly threadId: string;

  private pending?: Pending;
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
          this.messages.push(entry.message);
          break;
        case "history":
          this.replace(entry.messages);
          this.summaryText = entry.summaryText;
          this.prompt.set(SUMMARY, this.summaryText);
          break;
        case "pending":
          this.pending = entry.pending ?? undefined;
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
    // 保存された messages[0] ではなく、いまの素材から組み直す。
    // プロファイルを変えて同じスレッドを開いたとき、古い system が残らない
    this.syncSystem();
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

    let stopped = false;

    try {
      if (this.pending) {
        const entry = resume?.find(
          (r) => r.interruptId === this.pending?.interruptId,
        );

        const { calls, index, terminateSoFar } = this.pending;
        // メモリ上だけ先に消す。永続化はツール結果が積まれてから（executeCalls 内）
        this.pending = undefined;

        const outcome = yield* this.executeCalls(
          calls,
          index,
          { entry },
          runId,
          signal,
          terminateSoFar,
        );
        if (outcome.suspended) return;
        stopped = outcome.terminate;
      } else {
        await this.pushMessage({ role: "user", content: userInput });
      }

      let step = 0;
      let hasMoreToolCalls = !stopped;
      let injected = await this.poll("getSteeringMessages");

      // 外側は「止まろうとしたときに follow-up があるか」、
      // 内側は「ツール呼び出しが続くか、割り込みが来ているか」。pi と同じ二重ループ
      outer: while (true) {
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
            0,
            undefined,
            runId,
            signal,
          );
          if (outcome.suspended) return;
          hasMoreToolCalls = !outcome.terminate;
          injected = await this.poll("getSteeringMessages");
        }

        if (signal?.aborted) break outer;

        const followUp = await this.poll("getFollowUpMessages");
        if (followUp.length === 0) break outer;
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
   * terminate はバッチ全体のルール。**全部**のツールが立てたときだけ発動する（pi と同じ）。
   * 中断をまたぐので、途中経過は pending に載せて往復させる。
   */
  private async *executeCalls(
    calls: OpenAI.ChatCompletionMessageFunctionToolCall[],
    startIndex: number,
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

    for (let i = startIndex; i < calls.length; i++) {
      const call = calls[i];
      const { name, arguments: args } = call.function;

      // 中断されても残りのツールに結果を積む。tool_calls と tool のペアを割らないため
      // （pi はここで break するが、我々の messages はそのまま API に渡るので 400 になる）
      if (signal?.aborted) {
        yield* this.pushToolResult(call, ABORTED);
        await settle();
        allTerminate = false;
        continue;
      }

      // 再開した1件だけ resume を添えて、同じフックにもう一度聞く。
      // ループは payload の中身を知らない
      const decision = await this.config.beforeToolCall?.(
        {
          toolCallId: call.id,
          name,
          arguments: args,
          messages: this.messages,
          resume: i === startIndex ? resumed?.entry : undefined,
        },
        signal,
      );

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

      if (decision?.kind === "suspend") {
        const interruptId = randomUUID();
        this.pending = {
          interruptId,
          calls,
          index: i,
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
              { id: interruptId, toolCallId: call.id, ...decision.interrupt },
            ],
          },
        };
        return { suspended: true, terminate: false };
      }

      const blocked = decision?.kind === "block";
      let result = blocked
        ? decision.reason
        : await this.config.toolset.execute(name, JSON.parse(args), signal);
      let terminate = blocked ? decision.terminate === true : false;

      const after = await this.config.afterToolCall?.(
        {
          toolCallId: call.id,
          name,
          arguments: args,
          messages: this.messages,
          result,
          blocked,
        },
        signal,
      );
      if (after) {
        result = after.content ?? result;
        terminate = after.terminate ?? terminate;
      }
      allTerminate &&= terminate;

      yield* this.pushToolResult(call, result);
      await settle();
    }

    return {
      suspended: false,
      terminate: calls.length > 0 && allTerminate,
    };
  }

  private async *pushToolResult(
    call: OpenAI.ChatCompletionMessageFunctionToolCall,
    content: string,
  ): AsyncGenerator<AgentEvent> {
    // 先に積んでから通知する。逆にすると、間で落ちたとき結果が抜けた状態が残る
    await this.pushMessage({
      role: "tool",
      tool_call_id: call.id,
      content,
    });
    yield {
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
        const result = yield* (this.config.stream === false
          ? this.generateWhole(signal)
          : this.generateStream(signal, () => {
              emitted = true;
            }));
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
