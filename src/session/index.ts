import { EventType } from "@ag-ui/core";
import type OpenAI from "openai";
import {
  type AfterToolCall,
  Agent,
  type AgentEvent,
  type BeforeToolCall,
  type BeforeUserMessage,
} from "../agent/loop.js";
import type { PromptSection } from "../agent/prompt.js";
import type { JobQueue } from "../agent/subagent.js";
import type { Profile } from "../profile/index.js";
import type { Store, ThreadSummary } from "../store/index.js";
import { type Telemetry, toRow } from "../telemetry/index.js";
import { MessageQueue } from "./queue.js";

export type SessionsConfig = {
  client: OpenAI;
  model: string;
  profile: Profile;
  /** 起動時に集めた文脈。全スレッドで同じものを使う */
  sections?: PromptSection[];
  contextLimit: number;
  trim: string;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  beforeUserMessage?: BeforeUserMessage;
  /** 止まろうとしたときに1 run に1回だけ呼ばれる */
  onStop?: () => Promise<string[]>;
  /** background で走っているサブエージェント。完了は steering / follow-up に合流する */
  jobs?: JobQueue;
  stream?: boolean;
  store: Store;
  telemetry?: Telemetry;
};

/** threadId ごとの Agent を作り、store から復元し、run のたびに保存する */
export type QueueKind = "steering" | "followUp";

export class Sessions {
  private readonly live = new Map<string, Agent>();
  private readonly queues = new Map<string, Record<QueueKind, MessageQueue>>();
  private readonly active = new Set<string>();
  /** Stop フックを run に1回しか呼ばないための印。無いと止まれなくなる */
  private readonly stopAsked = new Set<string>();

  constructor(private readonly config: SessionsConfig) {}

  private queuesFor(threadId: string): Record<QueueKind, MessageQueue> {
    let q = this.queues.get(threadId);
    if (!q) {
      q = { steering: new MessageQueue(), followUp: new MessageQueue() };
      this.queues.set(threadId, q);
    }
    return q;
  }

  /** 走っている run があれば割り込みとして積む。無ければ false */
  steer(threadId: string, text: string, kind: QueueKind): boolean {
    if (!this.active.has(threadId)) return false;
    this.queuesFor(threadId)[kind].push(text);
    return true;
  }

  async get(threadId: string): Promise<Agent> {
    let agent = this.live.get(threadId);
    if (!agent) {
      const queues = this.queuesFor(threadId);
      const {
        client,
        model,
        profile,
        sections,
        contextLimit,
        trim,
        beforeToolCall,
        afterToolCall,
        beforeUserMessage,
        stream,
        store,
      } = this.config;
      agent = new Agent({
        client,
        model,
        system: profile.system,
        toolset: profile.toolset,
        sections,
        contextLimit,
        trim,
        beforeToolCall,
        afterToolCall,
        beforeUserMessage,
        stream,
        append: (entry) => store.append(threadId, entry),
        // 終わっている子の報告は、ターンの合間に割り込みと同じ扱いで入れる
        getSteeringMessages: async () => [
          ...queues.steering.drain(),
          ...(this.config.jobs?.poll() ?? []),
        ],
        getFollowUpMessages: async () => {
          const queued = queues.followUp.drain();
          if (queued.length > 0) return queued;
          // まだ走っている子がいるなら、止まる前に待って回収する
          if (this.config.jobs?.running())
            return await this.config.jobs.settle();
          if (!this.config.onStop || this.stopAsked.has(threadId)) return [];
          this.stopAsked.add(threadId);
          return await this.config.onStop();
        },
        threadId,
      });
      agent.replay(await store.load(threadId));
      this.live.set(threadId, agent);
    }
    return agent;
  }

  async *run(
    threadId: string,
    userInput: string,
    runId?: string,
    resume?: Parameters<Agent["run"]>[2],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    // 保存は Agent が append で逐次やる。ここで run の終わりを待つ必要はもう無い
    const agent = await this.get(threadId);
    if (this.active.has(threadId)) {
      throw new Error(
        `thread ${threadId} は実行中です。割り込みは steer() を使ってください`,
      );
    }

    const { telemetry, model, profile } = this.config;
    let currentRunId = runId ?? "";

    this.active.add(threadId);
    this.stopAsked.delete(threadId);
    try {
      // イベント列の2つ目の消費者。transport は表示に、こちらは計測に使う
      for await (const event of agent.run(userInput, runId, resume, signal)) {
        if (event.type === EventType.RUN_STARTED) currentRunId = event.runId;
        telemetry?.record(
          toRow(event, {
            threadId,
            runId: currentRunId,
            profile: profile.name,
            model,
          }),
        );
        yield event;
      }
    } finally {
      this.active.delete(threadId);
      void telemetry?.flush();
    }
  }

  list(): Promise<ThreadSummary[]> {
    return this.config.store.list();
  }

  async close(): Promise<void> {
    await this.config.jobs?.stop();
    await this.config.telemetry?.close();
    await this.config.store.close();
  }
}
