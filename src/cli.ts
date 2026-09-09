import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  APPROVAL,
  CONTEXT_LIMIT,
  MODEL,
  PROFILE,
  STORE,
  STORE_PATH,
  STREAM,
  WORKSPACE,
  TRIM,
  createClient,
} from "./config.js";
import { approvalHook } from "./approval.js";
import { createProfile } from "./profile/index.js";
import { Sessions } from "./session/index.js";
import { createStore } from "./store/index.js";
import { stopOnSignal } from "./shutdown.js";
import { StdioTransport } from "./transport/index.js";

const { values: opts } = parseArgs({
  options: {
    thread: { type: "string" },
    new: { type: "boolean" },
    list: { type: "boolean" },
    profile: { type: "string" },
    workspace: { type: "string" },
  },
});

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
  beforeToolCall: approvalHook(
    profile.requiresApproval,
    APPROVAL === "auto" ? async () => true : transport.approve,
  ),
  store,
});

const restored = (await sessions.get(threadId)).messages.length - 1;
console.log(
  `\x1b[2m${MODEL} / ${profile.name}:${profile.workspace} / ${STORE}:${STORE_PATH} / thread ${threadId}` +
    (restored > 0 ? `（履歴 ${restored} 件を復元）` : "") +
    `\nCtrl+C で終了。作業対象は ${profile.workspace} です。\n\x1b[0m`,
);

stopOnSignal(transport);
await transport.start(sessions);
await sessions.close();
