import { composeAfter, composeBefore } from "../agent/hooks.js";
import type { AfterToolCall, BeforeToolCall } from "../agent/loop.js";
import { type AskFn, approvalHook } from "../approval.js";
import { APPROVAL } from "../config.js";
import type { Profile } from "../profile/index.js";

export type HarnessOptions = {
  profile: Profile;
  /** 入力を待てる transport だけが渡す。無ければ承認は Interrupt になる */
  ask?: AskFn;
};

export type Hooks = {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
};

const approveAll: AskFn = async () => true;

/** ツール実行に挿すものを1箇所で束ねる。増えていくのはこの配列 */
export function createHooks({ profile, ask }: HarnessOptions): Hooks {
  return {
    beforeToolCall: composeBefore([
      approvalHook(profile.requiresApproval, APPROVAL === "auto" ? approveAll : ask),
    ]),
    afterToolCall: composeAfter([]),
  };
}
