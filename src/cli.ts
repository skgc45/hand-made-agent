import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  CONTEXT_LIMIT,
  MODEL,
  SETTINGS_RULES,
  PROFILE,
  SETTINGS_FILES,
  STORE,
  STORE_PATH,
  STREAM,
  WORKSPACE,
  TRIM,
  createClient,
  describeConfig,
} from "./config.js";
import { createHooks } from "./harness/index.js";
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
  },
});

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
  const current = createProfile(
    opts.profile ?? PROFILE,
    opts.workspace ?? WORKSPACE,
  );
  const rules = [
    ...ORDER.flatMap((action) =>
      (current.permissions[action] ?? []).map((rule) => ({
        action,
        rule,
        source: `プロファイル ${current.name}`,
      })),
    ),
    ...SETTINGS_RULES,
  ].sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));

  console.log("\n権限ルール（deny > allow > ask の順に見る。どれにも当たらなければ通す）:");
  if (rules.length === 0) console.log("  （なし）");
  const ruleWidth = Math.max(1, ...rules.map((r) => cells(r.rule)));
  for (const { action, rule, source } of rules) {
    console.log(
      `  ${pad(action, 5)}  ${pad(rule, ruleWidth)}  \x1b[2m${source}\x1b[0m`,
    );
  }
  process.exit(0);
}

const profile = createProfile(
  opts.profile ?? PROFILE,
  opts.workspace ?? WORKSPACE,
);

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

const transport = new StdioTransport(threadId);
const sessions = new Sessions({
  client: createClient(),
  model: MODEL,
  profile,
  contextLimit: CONTEXT_LIMIT,
  trim: TRIM,
  stream: STREAM,
  ...createHooks({ profile, ask: transport.approve }),
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
