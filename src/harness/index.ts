import { composeAfter, composeBefore } from "../agent/compose.js";
import type {
  AfterToolCall,
  BeforeToolCall,
  BeforeUserMessage,
} from "../agent/loop.js";
import { APPROVAL, hooksFor, permissionsFor } from "../config.js";
import { createPermissions } from "../permission/index.js";
import type { PermissionSet } from "../permission/index.js";
import type { Profile } from "../profile/index.js";
import { mergePermissions, saveAllowRule } from "../settings/index.js";
import { retrust } from "../settings/trust.js";
import { type AskFn, approvalHook } from "./approval.js";
import { onStop, postToolUse, preToolUse, userPromptSubmit } from "./external.js";

export type HarnessOptions = {
  profile: Profile;
  /** 入力を待てる transport だけが渡す。無ければ承認は Interrupt になる */
  ask?: AskFn;
  /** .hma の中身を本人が承認したか。false なら緩める方向の設定を落とす */
  trusted: boolean;
};

export type Hooks = {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  beforeUserMessage?: BeforeUserMessage;
  /** 止まろうとしたときに1 run に1回だけ呼ばれる。続ける文言を返す */
  onStop?: () => Promise<string[]>;
};

/**
 * plan は「読むだけ」。専用の判定を足さず、読まないツールを deny に展開して渡す。
 * どのツールが読むだけかを知っているのはプロファイルだけ
 */
export function planDenies(profile: Profile): PermissionSet {
  const all = profile.toolset.tools
    .filter((tool) => tool.type === "function")
    .map((tool) => tool.function.name);
  return { deny: all.filter((name) => !profile.readOnly.includes(name)) };
}

/** ツール実行に挿すものを1箇所で束ねる。増えていくのはこの配列 */
export function createHooks({ profile, ask, trusted }: HarnessOptions): Hooks {
  const permissions = createPermissions(
    mergePermissions(
      profile.permissions,
      permissionsFor(trusted),
      APPROVAL === "plan" ? planDenies(profile) : undefined,
    ),
    APPROVAL,
  );
  const hooks = hooksFor(trusted);

  // 本人が [s]ave したぶんで指紋が変わる。信頼している間だけ追随させる
  const save = trusted
    ? async (rule: string) => {
        const file = await saveAllowRule(rule);
        await retrust();
        return file;
      }
    : saveAllowRule;

  return {
    // 外部フックが先。block も allow もフックの言い分が権限ルールより強い
    beforeToolCall: composeBefore([
      preToolUse(hooks.PreToolUse ?? []),
      approvalHook(permissions, ask, save),
    ]),
    afterToolCall: composeAfter([postToolUse(hooks.PostToolUse ?? [])]),
    beforeUserMessage: userPromptSubmit(hooks.UserPromptSubmit ?? []),
    onStop: onStop(hooks.Stop ?? []),
  };
}
