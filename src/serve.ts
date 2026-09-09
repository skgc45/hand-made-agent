import {
  APPROVAL,
  CONTEXT_LIMIT,
  MODEL,
  PORT,
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
import { HttpTransport } from "./transport/index.js";

const profile = createProfile(PROFILE, WORKSPACE);

const sessions = new Sessions({
  client: createClient(),
  model: MODEL,
  profile,
  contextLimit: CONTEXT_LIMIT,
  trim: TRIM,
  stream: STREAM,
  beforeToolCall: approvalHook(
    profile.requiresApproval,
    APPROVAL === "auto" ? async () => true : undefined,
  ),
  store: createStore(),
});

const transport = new HttpTransport(PORT);

console.log(
  `${MODEL} / ${profile.name}:${profile.workspace} / ${STORE}:${STORE_PATH} / http://localhost:${PORT}`,
);

stopOnSignal(transport);
await transport.start(sessions);
await sessions.close();
