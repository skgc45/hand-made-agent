import type OpenAI from "openai";
import {
  type AfterToolCall,
  type AgentEvent,
  Agent,
  type BeforeToolCall,
} from "../agent/loop.js";
import { MessageQueue } from "../queue.js";
import type { Store, ThreadSummary } from "../store/index.js";

export type SessionsConfig = {
  client: OpenAI;
  model: string;
  system: string;
  contextLimit: number;
  trim: string;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  stream?: boolean;
  store: Store;
};

/** threadId ごとの Agent を作り、store から復元し、run のたびに保存する */
export type QueueKind = "steering" | "followUp";

export class Sessions {
  private readonly live = new Map<string, Agent>();
  private readonly queues = new Map<string, Record<QueueKind, MessageQueue>>();
  private readonly active = new Set<string>();

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
        system,
        contextLimit,
        trim,
        beforeToolCall,
        afterToolCall,
        stream,
        store,
      } = this.config;
      agent = new Agent({
        client,
        model,
        system,
        contextLimit,
        trim,
        beforeToolCall,
        afterToolCall,
        stream,
        append: (entry) => store.append(threadId, entry),
        getSteeringMessages: async () => queues.steering.drain(),
        getFollowUpMessages: async () => queues.followUp.drain(),
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

    this.active.add(threadId);
    try {
      yield* agent.run(userInput, runId, resume, signal);
    } finally {
      this.active.delete(threadId);
    }
  }

  list(): Promise<ThreadSummary[]> {
    return this.config.store.list();
  }

  close(): Promise<void> {
    return this.config.store.close();
  }
}
