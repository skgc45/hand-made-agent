import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  APPROVAL,
  CONTEXT_LIMIT,
  MODEL,
  NEEDS_TRUST,
  PROFILE,
  SETTINGS_FILES,
  SETTINGS_HOOKS,
  SETTINGS_MCP,
  SETTINGS_RULES,
  STORE,
  STORE_PATH,
  STREAM,
  TRIM,
  TRUST_PRINT,
  TRUST_SUBJECT,
  WORKSPACE,
  createClient,
  describeConfig,
  hooksFor,
  mcpServersFor,
} from "./config.js";
import { collectContext } from "./context/index.js";
import {
  type Hooks,
  createHooks,
  mcpRules,
  modeRules,
} from "./harness/index.js";
import { withSubagents } from "./agent/subagent.js";
import { loadCommands } from "./commands/index.js";
import { loadSkills, withSkills } from "./skills/index.js";
import { connectMcp, withMcp } from "./mcp/index.js";
import { describeTrust, recordTrust } from "./settings/trust.js";
import { createProfile } from "./profile/index.js";
import { Sessions } from "./session/index.js";
import { createStore } from "./store/index.js";
import { createTelemetry } from "./telemetry/index.js";
import { stopOnSignal } from "./shutdown.js";
import { StdioTransport } from "./transport/index.js";

const { values: opts } = parseArgs({
  options: {
    thread: { type: "string" },
    new: { type: "boolean" },
    list: { type: "boolean" },
    profile: { type: "string" },
    workspace: { type: "string" },
    config: { type: "boolean" },
    trust: { type: "boolean" },
  },
});

/** .hma には任意のコマンドが書ける。走らせる前に、何が走るのかを見せて聞く */
async function askTrust(): Promise<boolean> {
  console.log(
    "\n\x1b[33mこのディレクトリの .hma に、あなたの権限で動くものが入っています:\x1b[0m",
  );
  for (const line of describeTrust(TRUST_SUBJECT)) console.log(line);
  console.log(
    "\n\x1b[2m実行はあなた自身の権限で、承認を通らずに行われます（環境変数も見えます）。\x1b[0m",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question("\x1b[33m信頼しますか? [y]es / [n]o: \x1b[0m");
  rl.close();

  if (answer.trim().toLowerCase() !== "y") {
    console.log("\x1b[2m  信頼しませんでした。フックと allow は無効のまま進みます。\x1b[0m\n");
    return false;
  }
  await recordTrust(TRUST_PRINT);
  console.log("\x1b[2m  信頼しました（~/.hma/trust.json に記録）。\x1b[0m\n");
  return true;
}

if (opts.trust) {
  if (
    TRUST_SUBJECT.hooks.length === 0 &&
    TRUST_SUBJECT.rules.length === 0 &&
    TRUST_SUBJECT.mcp.length === 0
  ) {
    console.log("このディレクトリの .hma に、確認が要るものはありません。");
  } else if (!NEEDS_TRUST) {
    console.log("信頼済みです:");
    for (const line of describeTrust(TRUST_SUBJECT)) console.log(line);
  } else {
    await askTrust();
  }
  process.exit(0);
}

if (opts.config) {
  if (SETTINGS_FILES.length > 0) {
    console.log(`設定ファイル: ${SETTINGS_FILES.join(" < ")}\n`);
  } else {
    console.log("設定ファイル: なし（.hma/settings.json は起動したディレクトリから探す）\n");
  }

  // 全角は2桁。ASCII 前提の padEnd だと表がずれる
  const cells = (text: string) =>
    [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
  const pad = (text: string, width: number) =>
    text + " ".repeat(Math.max(0, width - cells(text)));

  const rows = describeConfig({
    workspace: opts.workspace,
    profile: opts.profile,
  });
  const nameWidth = Math.max(...rows.map((r) => cells(r.name)));
  const valueWidth = Math.max(...rows.map((r) => cells(r.value)));
  for (const { name, value, source } of rows) {
    console.log(
      `  ${pad(name, nameWidth)}  ${pad(value, valueWidth)}  \x1b[2m${source}\x1b[0m`,
    );
  }

  const ORDER = ["deny", "allow", "ask"] as const;
  const skills = await loadSkills();
  const commands = await loadCommands();
  // 実際に起動して tools/list を引く。繋がらないサーバはここで分かる
  const mcp = await connectMcp(mcpServersFor(!NEEDS_TRUST));
  const { profile: current } = withSubagents(
    withMcp(
      withSkills(
        createProfile(opts.profile ?? PROFILE, opts.workspace ?? WORKSPACE),
        skills,
      ),
      mcp,
    ),
    { ...subagentDeps(), hooks: {} },
  );
  const rules = [
    ...ORDER.flatMap((action) =>
      (current.permissions[action] ?? []).map((rule) => ({
        action,
        rule,
        source: `プロファイル ${current.name}`,
        layer: undefined,
      })),
    ),
    ...(["deny", "allow", "ask"] as const).flatMap((action) =>
      (mcpRules(current)[action] ?? []).map((rule) => ({
        action,
        rule,
        source: "MCP（readOnlyHint なし）",
        layer: undefined,
      })),
    ),
    ...SETTINGS_RULES,
    ...(["deny", "allow", "ask"] as const).flatMap((action) =>
      (modeRules(current, APPROVAL)[action] ?? []).map((rule) => ({
        action,
        rule,
        source: `${APPROVAL} モード`,
        layer: undefined,
      })),
    ),
  ].sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));

  console.log("\n権限ルール（deny > allow > ask の順に見る。どれにも当たらなければ通す）:");
  if (rules.length === 0) console.log("  （なし）");
  const ruleWidth = Math.max(1, ...rules.map((r) => cells(r.rule)));
  for (const { action, rule, source, layer } of rules) {
    const off =
      NEEDS_TRUST && layer !== undefined && layer !== "user" && action === "allow";
    console.log(
      `  ${pad(action, 5)}  ${pad(rule, ruleWidth)}  \x1b[2m${source}${off ? " — 未信頼のため無効" : ""}\x1b[0m`,
    );
  }

  console.log("\nフック（設定ファイルから刺した外部コマンド）:");
  if (SETTINGS_HOOKS.length === 0) console.log("  （なし）");
  const eventWidth = Math.max(1, ...SETTINGS_HOOKS.map((h) => cells(h.event)));
  const matcherWidth = Math.max(
    1,
    ...SETTINGS_HOOKS.map((h) => cells(h.hook.matcher ?? "*")),
  );
  for (const { event, hook, source, layer } of SETTINGS_HOOKS) {
    const off = NEEDS_TRUST && layer !== "user";
    console.log(
      `  ${pad(event, eventWidth)}  ${pad(hook.matcher ?? "*", matcherWidth)}  ${hook.command}  \x1b[2m${source}${off ? " — 未信頼のため無効（hma trust）" : ""}\x1b[0m`,
    );
  }

  console.log("\nMCP サーバ（設定ファイルから起動する外部プロセス）:");
  if (SETTINGS_MCP.length === 0) console.log("  （なし）");
  for (const { name, config, source, layer } of SETTINGS_MCP) {
    const off = NEEDS_TRUST && layer !== "user";
    const tools = mcp.listing.filter((t) => t.server === name);
    const detail = off
      ? "未信頼のため起動しない（hma trust）"
      : `ツール ${tools.length}（read ${tools.filter((t) => t.readOnly).length}）`;
    console.log(
      `  ${name}  ${config.command} ${(config.args ?? []).join(" ")}  \x1b[2m${detail}  ${source}\x1b[0m`,
    );
  }
  mcp.close();

  console.log("\nスキル（名前と説明だけが system に載る。本文は skill ツールで読む）:");
  if (skills.length === 0) console.log("  （なし）");
  const skillWidth = Math.max(1, ...skills.map((s) => cells(s.name)));
  for (const skill of skills) {
    console.log(
      `  ${pad(skill.name, skillWidth)}  ${skill.description}  \x1b[2m${skill.source}\x1b[0m`,
    );
  }

  console.log("\nスラッシュコマンド（入力を本文に差し替える）:");
  if (commands.length === 0) console.log("  （なし）");
  const commandWidth = Math.max(1, ...commands.map((c) => cells(c.name) + 1));
  for (const command of commands) {
    console.log(
      `  ${pad(`/${command.name}`, commandWidth)}  \x1b[2m${command.body.length} 文字  ${command.source}\x1b[0m`,
    );
  }

  const context = await collectContext({
    workspace: opts.workspace ?? WORKSPACE,
    mode: APPROVAL,
    sessionStart: hooksFor(!NEEDS_TRUST).SessionStart ?? [],
    skills,
  });
  console.log("\nsystem プロンプトに載る文脈:");
  if (context.length === 0) console.log("  （なし）");
  const headingWidth = Math.max(1, ...context.map((c) => cells(c.heading)));
  for (const { heading, body } of context) {
    console.log(
      `  ${pad(heading, headingWidth)}  \x1b[2m${body.length} 文字\x1b[0m`,
    );
  }
  process.exit(0);
}

/** サブエージェントは親と同じモデル・同じ上限で回す */
function subagentDeps() {
  return {
    client: createClient(),
    model: MODEL,
    contextLimit: CONTEXT_LIMIT,
    trim: TRIM,
  };
}

const store = createStore();

if (opts.list) {
  for (const t of await store.list()) {
    console.log(
      `${t.threadId}\t${t.entries} entries\t${t.totalPromptTokens} tokens\t${t.pending ? "承認待ち" : ""}\t${t.updatedAt}`,
    );
  }
  await store.close();
  process.exit(0);
}

const threadId = opts.new ? randomUUID() : (opts.thread ?? "cli");

const trusted = NEEDS_TRUST ? await askTrust() : true;

// MCP サーバは信頼を聞いたあとで起動する。未信頼のまま外部プロセスを立てない。
// 子は親と同じフックを通すので、フックの中身だけ後から差す
const hooks: Hooks = {};
const skills = await loadSkills();
const commands = await loadCommands();
const mcp = await connectMcp(mcpServersFor(trusted));
const { profile, jobs } = withSubagents(
  withMcp(
    withSkills(
      createProfile(opts.profile ?? PROFILE, opts.workspace ?? WORKSPACE),
      skills,
    ),
    mcp,
  ),
  { ...subagentDeps(), hooks },
);

const sections = await collectContext({
  workspace: profile.workspace,
  mode: APPROVAL,
  sessionStart: hooksFor(trusted).SessionStart ?? [],
  skills,
});

const transport = new StdioTransport(threadId);
const sessions = new Sessions({
  client: createClient(),
  model: MODEL,
  profile,
  sections,
  contextLimit: CONTEXT_LIMIT,
  trim: TRIM,
  stream: STREAM,
  ...Object.assign(
    hooks,
    createHooks({ profile, ask: transport.approve, trusted, commands }),
  ),
  jobs,
  store,
  telemetry: createTelemetry(),
});

const restored = (await sessions.get(threadId)).messages.length - 1;
console.log(
  `\x1b[2m${MODEL} / ${profile.name}:${profile.workspace} / ${STORE}:${STORE_PATH} / thread ${threadId}` +
    (restored > 0 ? `（履歴 ${restored} 件を復元）` : "") +
    (SETTINGS_FILES.length > 0 ? `\n設定: ${SETTINGS_FILES.join(" < ")}` : "") +
    `\nCtrl+C で終了。作業対象は ${profile.workspace} です。\n\x1b[0m`,
);

stopOnSignal(transport);
await transport.start(sessions);
await sessions.close();
mcp.close();
