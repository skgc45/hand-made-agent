import { composeAfter, composeBefore } from "../agent/hooks.js";
import type { AfterToolCall, BeforeToolCall } from "../agent/loop.js";
import { APPROVAL, PERMISSIONS } from "../config.js";
import { createPermissions } from "../permission/index.js";
import type { Profile } from "../profile/index.js";
import { mergePermissions, saveAllowRule } from "../settings/index.js";
import { type AskFn, approvalHook } from "./approval.js";

export type HarnessOptions = {
  profile: Profile;
  /** 入力を待てる transport だけが渡す。無ければ承認は Interrupt になる */
  ask?: AskFn;
};

export type Hooks = {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
};

/** ツール実行に挿すものを1箇所で束ねる。増えていくのはこの配列 */
export function createHooks({ profile, ask }: HarnessOptions): Hooks {
  const permissions = createPermissions(
    mergePermissions(profile.permissions, PERMISSIONS),
    APPROVAL,
  );

  return {
    beforeToolCall: composeBefore([
      approvalHook(permissions, ask, saveAllowRule),
    ]),
    afterToolCall: composeAfter([]),
  };
}
