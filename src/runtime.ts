import type OpenAI from "openai";
import { withSubagents } from "./agent/subagent.js";
import { type Command, loadCommands } from "./commands/index.js";
import {
  APPROVAL,
  CONTEXT_LIMIT,
  createClient,
  hooksFor,
  MODEL,
  mcpServersFor,
  permissionsFor,
  STREAM,
  TRIM,
  TRUST_PRINT,
} from "./config.js";
import { collectContext } from "./context/index.js";
import type { AskFn } from "./harness/approval.js";
import { createHooks, type Hooks } from "./harness/index.js";
import { connectMcp, type McpToolset, withMcp } from "./mcp/index.js";
import { createProfile } from "./profile/index.js";
import { Sessions } from "./session/index.js";
import { isTrusted } from "./settings/trust.js";
import { loadSkills, type Skill, withSkills } from "./skills/index.js";
import type { Store } from "./store/index.js";
import type { Telemetry } from "./telemetry/index.js";

/** 起動のたびに1回だけ用意するもの。eval は全ケースで共有する */
export type Assets = {
  trusted: boolean;
  skills: Skill[];
  commands: Command[];
  mcp: McpToolset;
};

/** MCP サーバは信頼を聞いたあとで起動する。未信頼のまま外部プロセスを立てない */
export async function loadAssets(trusted: boolean): Promise<Assets> {
  return {
    trusted,
    skills: await loadSkills(),
    commands: await loadCommands(),
    mcp: await connectMcp(mcpServersFor(trusted)),
  };
}

export type ProfileOptions = { profile: string; workspace: string };

/**
 * 子は親と同じフックを通す。プロファイルとフックが互いに要るので、
 * フックは空の箱を渡しておき、中身は buildSessions で後から差す
 */
export function buildProfile(assets: Assets, opts: ProfileOptions) {
  const hooks: Hooks = {};
  let client: OpenAI | undefined;
  const { profile, jobs } = withSubagents(
    withMcp(
      withSkills(createProfile(opts.profile, opts.workspace), assets.skills),
      assets.mcp,
    ),
    {
      client: () => (client ??= createClient()),
      model: MODEL,
      contextLimit: CONTEXT_LIMIT,
      trim: TRIM,
      hooks,
    },
  );
  return { profile, jobs, hooks };
}

export async function buildSessions(
  assets: Assets,
  opts: ProfileOptions & {
    /** 入力を待てる transport だけが渡す。無ければ承認は Interrupt で run を終える */
    ask?: AskFn;
    store: Store;
    telemetry: Telemetry;
  },
) {
  // 鍵が無ければ、起動時のフックを走らせる前に落とす
  const client = createClient();
  const { profile, jobs, hooks } = buildProfile(assets, opts);
  const sections = await collectContext({
    workspace: profile.workspace,
    mode: APPROVAL,
    sessionStart: hooksFor(assets.trusted).SessionStart ?? [],
    skills: assets.skills,
    trusted: assets.trusted && isTrusted(TRUST_PRINT),
  });
  Object.assign(
    hooks,
    createHooks({
      profile,
      ask: opts.ask,
      trusted: assets.trusted,
      approval: APPROVAL,
      rules: permissionsFor(assets.trusted),
      hooks: hooksFor(assets.trusted),
      commands: assets.commands,
      skills: assets.skills,
    }),
  );
  const sessions = new Sessions({
    client,
    model: MODEL,
    profile,
    sections,
    contextLimit: CONTEXT_LIMIT,
    trim: TRIM,
    stream: STREAM,
    ...hooks,
    jobs,
    store: opts.store,
    telemetry: opts.telemetry,
  });
  return { sessions, profile, jobs };
}
