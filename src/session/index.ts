import { EventType } from "@ag-ui/core";
import type OpenAI from "openai";
import {
  type AfterToolCall,
  type AgentEvent,
  Agent,
  type BeforeToolCall,
  type BeforeUserMessage,
} from "../agent/loop.js";
import type { Profile } from "../profile/index.js";
import { MessageQueue } from "./queue.js";
import type { Store, ThreadSummary } from "../store/index.js";
import { type Telemetry, toRow } from "../telemetry/index.js";

export type SessionsConfig = {
  client: OpenAI;
  model: string;
  profile: Profile;
  contextLimit: number;
  trim: string;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  beforeUserMessage?: BeforeUserMessage;
  /** 止まろうとしたときに1 run に1回だけ呼ばれる */
  onStop?: () => Promise<string[]>;
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
        contextLimit,
        trim,
        beforeToolCall,
        afterToolCall,
        beforeUserMessage,
        stream,
        append: (entry) => store.append(threadId, entry),
        getSteeringMessages: async () => queues.steering.drain(),
        getFollowUpMessages: async () => {
          const queued = queues.followUp.drain();
          if (queued.length > 0) return queued;
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
    await this.config.telemetry?.close();
    await this.config.store.close();
  }
}
