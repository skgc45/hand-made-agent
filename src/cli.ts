import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  APPROVAL,
  describeConfig,
  hooksFor,
  MODEL,
  NEEDS_TRUST,
  PROFILE,
  SETTINGS_FILES,
  SETTINGS_HOOKS,
  SETTINGS_MCP,
  SETTINGS_RULES,
  STORE,
  STORE_PATH,
  TELEMETRY,
  TELEMETRY_URL,
  TRUST_PRINT,
  TRUST_SUBJECT,
  WORKSPACE,
} from "./config.js";
import { collectContext, hasProjectMemory } from "./context/index.js";
import { mcpRules, modeRules } from "./harness/index.js";
import { dim, yellow } from "./render/cli.js";
import { buildProfile, buildSessions, loadAssets } from "./runtime.js";
import { describeTrust, recordTrust } from "./settings/trust.js";
import { stopOnSignal } from "./shutdown.js";
import { createStore } from "./store/index.js";
import { createTelemetry } from "./telemetry/index.js";
import { conflictOfContinue, latestThreadId } from "./thread-select.js";
import {
  PrintTransport,
  StdioTransport,
  type Transport,
} from "./transport/index.js";

const { values: opts } = parseArgs({
  options: {
    thread: { type: "string" },
    new: { type: "boolean" },
    continue: { type: "boolean", short: "c" },
    list: { type: "boolean" },
    profile: { type: "string" },
    workspace: { type: "string" },
    config: { type: "boolean" },
    trust: { type: "boolean" },
    print: { type: "string", short: "p" },
  },
});

/** -p の値。`-` なら stdin をまとめて読む */
async function promptOf(value: string): Promise<string> {
  if (value !== "-" && value !== "") return value;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** .hma には任意のコマンドが書ける。走らせる前に、何が走るのかを見せて聞く */
async function askTrust(): Promise<boolean> {
  console.log(
    "\n\x1b[33mこのディレクトリの .hma に、あなたの権限で動くものが入っています:\x1b[0m",
  );
  for (const line of describeTrust(TRUST_SUBJECT)) console.log(line);
  console.log(
    "\n\x1b[2m実行はあなた自身の権限で、承認を通らずに行われます（環境変数も見えます）。\x1b[0m",
  );
  if (await hasProjectMemory()) {
    console.log(
      "\x1b[2mこのディレクトリから上の AGENTS.md も、注記なしで載せるようになります。\x1b[0m",
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(
    "\x1b[33m信頼しますか? [y]es / [n]o: \x1b[0m",
  );
  rl.close();

  if (answer.trim().toLowerCase() !== "y") {
    console.log(
      "\x1b[2m  信頼しませんでした。フックと allow は無効のまま進みます。\x1b[0m\n",
    );
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
    await recordTrust(TRUST_PRINT);
    console.log(
      "このディレクトリの .hma に、確認が要るものはありません。このディレクトリの AGENTS.md を信頼済みとして記録しました。",
    );
  } else if (!NEEDS_TRUST) {
    console.log("信頼済みです（AGENTS.md も注記なしで載せます）:");
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
    console.log(
      "設定ファイル: なし（.hma/settings.json は起動したディレクトリから探す）\n",
    );
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
  // 実際に起動して tools/list を引く。繋がらないサーバはここで分かる
  const assets = await loadAssets(!NEEDS_TRUST);
  const { skills, commands, mcp } = assets;
  const { profile: current } = buildProfile(assets, {
    profile: opts.profile ?? PROFILE,
    workspace: opts.workspace ?? WORKSPACE,
  });
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

  console.log(
    "\n権限ルール（deny > allow > ask の順に見る。どれにも当たらなければ通す）:",
  );
  if (rules.length === 0) console.log("  （なし）");
  const ruleWidth = Math.max(1, ...rules.map((r) => cells(r.rule)));
  for (const { action, rule, source, layer } of rules) {
    const off =
      NEEDS_TRUST &&
      layer !== undefined &&
      layer !== "user" &&
      action === "allow";
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

  console.log(
    "\nスキル（名前と説明だけが system に載る。本文は skill ツールか /skill:名前 で読む）:",
  );
  if (skills.length === 0) console.log("  （なし）");
  const skillWidth = Math.max(1, ...skills.map((s) => cells(s.name)));
  for (const skill of skills) {
    console.log(
      `  ${pad(skill.name, skillWidth)}  ${skill.description}  \x1b[2m${skill.source}${skill.disableModelInvocation ? "  disable-model-invocation" : ""}\x1b[0m`,
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

const conflict = conflictOfContinue(opts);
if (conflict) {
  console.error(conflict);
  process.exit(2);
}

const store = createStore(STORE, STORE_PATH);

if (opts.list) {
  for (const t of await store.list()) {
    console.log(
      `${t.threadId}\t${t.entries} entries\t${t.totalPromptTokens} tokens\t${t.pending ? "承認待ち" : ""}\t${t.updatedAt}`,
    );
  }
  await store.close();
  process.exit(0);
}

// -p は入力を待たない。スレッドを共有すると前回の続きになるので、既定は毎回新しい
const printing = opts.print !== undefined;
const prompt = printing ? await promptOf(opts.print as string) : "";
if (printing && !prompt.trim()) {
  console.error(
    "-p にプロンプトがありません（`-p -` なら stdin から読みます）",
  );
  process.exit(2);
}

let threadId: string;
if (opts.continue) {
  const latest = await latestThreadId(store);
  threadId = latest ?? randomUUID();
  console.error(
    latest
      ? `直近のスレッド ${latest} を開きます`
      : "再開できるスレッドがないので、新しいスレッドで始めます",
  );
} else {
  threadId = opts.new
    ? randomUUID()
    : (opts.thread ?? (printing ? randomUUID() : "cli"));
}

// 非対話では信頼を聞けない。緩める方向の設定は落としたまま進む
const trusted = NEEDS_TRUST ? (printing ? false : await askTrust()) : true;
// -p の stderr はパイプされる。端末でなければ色を付けない
const paint = (f: (s: string) => string) =>
  printing && process.stderr.isTTY !== true ? (s: string) => s : f;

if (printing && NEEDS_TRUST) {
  console.error(
    paint(yellow)(
      "未信頼の .hma があります。フック・allow・MCP は無効のまま進みます（hma trust）",
    ),
  );
}

const assets = await loadAssets(trusted);
const transport: Transport = printing
  ? new PrintTransport(threadId, prompt)
  : new StdioTransport(threadId);
const { sessions, profile } = await buildSessions(assets, {
  profile: opts.profile ?? PROFILE,
  workspace: opts.workspace ?? WORKSPACE,
  ask: transport.approve,
  store,
  telemetry: createTelemetry(TELEMETRY, TELEMETRY_URL),
});

const restored = (await sessions.get(threadId)).messages.length - 1;
// 本文以外は stderr に寄せる。-p の stdout は答えだけにする
const banner = printing ? console.error : console.log;
banner(
  paint(dim)(
    `${MODEL} / ${profile.name}:${profile.workspace} / ${STORE}:${STORE_PATH} / thread ${threadId}` +
      (restored > 0 ? `（履歴 ${restored} 件を復元）` : "") +
      (SETTINGS_FILES.length > 0
        ? `\n設定: ${SETTINGS_FILES.join(" < ")}`
        : "") +
      (printing ? "\n" : "\nCtrl+C で終了。") +
      `作業対象は ${profile.workspace} です。\n`,
  ),
);

stopOnSignal(transport);
await transport.start(sessions);
await sessions.close();
assets.mcp.close();

if (transport instanceof PrintTransport) process.exitCode = transport.exitCode;
