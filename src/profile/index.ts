import type { Toolset } from "../agent/toolset.js";
import type { PermissionSet } from "../permission/index.js";
import { coding } from "./coding.js";
import { sandbox } from "./sandbox.js";

/**
 * 「何のエージェントか」を決める束。
 * transport（どう入出力するか）とは直交していて、組み合わせて使う。
 */
export type Profile = {
  name: string;
  workspace: string;
  system: string;
  toolset: Toolset;
  /** 既定の権限ルール。deny > allow > ask の順に見て、どれにも当たらなければ通す */
  permissions: PermissionSet;
  /**
   * ツールの種類。read は副作用が無いもの。
   * plan は read 以外を止め、acceptEdits は edit を通す
   */
  kinds: Record<string, "read" | "edit" | "execute">;
};

const builders: Record<string, (workspace: string) => Profile> = {
  sandbox,
  coding,
};

export function createProfile(name: string, workspace: string): Profile {
  const build = builders[name];
  if (!build) {
    throw new Error(
      `PROFILE に不明な値: ${name}（${Object.keys(builders).join(" / ")}）`,
    );
  }
  return build(workspace);
}

export const profileNames = Object.keys(builders);
