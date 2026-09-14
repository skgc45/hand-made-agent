import { composeAfter, composeBefore, composeUser } from "../agent/compose.js";
import { type Command, commandHook } from "../commands/index.js";
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
import { readBeforeEdit, truncateResult } from "./files.js";
import { onStop, postToolUse, preToolUse, userPromptSubmit } from "./external.js";

export type HarnessOptions = {
  profile: Profile;
  /** 入力を待てる transport だけが渡す。無ければ承認は Interrupt になる */
  ask?: AskFn;
  /** .hma の中身を本人が承認したか。false なら緩める方向の設定を落とす */
  trusted: boolean;
  /** スラッシュコマンド。入力を本文に差し替える */
  commands?: Command[];
};

export type Hooks = {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  beforeUserMessage?: BeforeUserMessage;
  /** 止まろうとしたときに1 run に1回だけ呼ばれる。続ける文言を返す */
  onStop?: () => Promise<string[]>;
};

function toolNames(profile: Profile): string[] {
  return profile.toolset.tools
    .filter((tool) => tool.type === "function")
    .map((tool) => tool.function.name);
}

/**
 * モードは専用の判定を足さず、ルールに展開して渡す。
 * どのツールが何をするかを知っているのはプロファイルだけ
 */
export function modeRules(profile: Profile, mode: string): PermissionSet {
  const names = toolNames(profile);

  // 種類の分からないツールは read 扱いしない。増えたときに止まる側へ倒す
  if (mode === "plan") {
    return { deny: names.filter((name) => profile.kinds[name] !== "read") };
  }
  if (mode === "acceptEdits") {
    return { allow: names.filter((name) => profile.kinds[name] === "edit") };
  }
  return {};
}

/**
 * 外から生えたツールは、プロファイルが知らない。
 * サーバが readOnlyHint を申告しなかったものは既定で聞く（allow を書けば外せる）
 */
export function mcpRules(profile: Profile): PermissionSet {
  return {
    ask: toolNames(profile).filter(
      (name) => name.startsWith("mcp__") && profile.kinds[name] !== "read",
    ),
  };
}

/** ツール実行に挿すものを1箇所で束ねる。増えていくのはこの配列 */
export function createHooks({
  profile,
  ask,
  trusted,
  commands = [],
}: HarnessOptions): Hooks {
  const permissions = createPermissions(
    mergePermissions(
      profile.permissions,
      mcpRules(profile),
      permissionsFor(trusted),
      modeRules(profile, APPROVAL),
    ),
    APPROVAL,
  );
  const hooks = hooksFor(trusted);
  const files = readBeforeEdit(profile.workspace);

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
      // 承認より先に見る。読んでいないファイルは、許可しても書かせない
      files.before,
      approvalHook(permissions, ask, save),
    ]),
    // 切ってからフックに渡す。モデルが見るものとフックが見るものを揃える
    afterToolCall: composeAfter([
      files.after,
      truncateResult(),
      postToolUse(hooks.PostToolUse ?? []),
    ]),
    // コマンドを先に展開する。外部フックは展開後の本文を見て止められる
    beforeUserMessage: composeUser([
      commandHook(commands),
      userPromptSubmit(hooks.UserPromptSubmit ?? []),
    ]),
    onStop: onStop(hooks.Stop ?? []),
  };
}
