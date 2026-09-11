import type { AskFn } from "../harness/approval.js";
import type { Sessions } from "../session/index.js";

export interface Transport {
  /**
   * 入力を待てる transport だけが持つ。
   * 無ければ承認フックは Interrupt を返し、run が中断される。
   */
  readonly approve?: AskFn;

  /**
   * 走っている run を中断できたら true。
   * シグナルを transport の終了ではなく run の中断に使いたいときに実装する。
   */
  interrupt?(): boolean;

  /** transport が終了したら解決する */
  start(sessions: Sessions): Promise<void>;

  stop(): Promise<void>;
}

export { HttpTransport } from "./http.js";
export { StdioTransport } from "./stdio.js";
