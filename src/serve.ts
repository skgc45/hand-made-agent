import {
  APPROVAL,
  CONTEXT_LIMIT,
  MODEL,
  PORT,
  STORE,
  STORE_PATH,
  STREAM,
  SYSTEM,
  TRIM,
  createClient,
} from "./config.js";
import { approvalHook } from "./approval.js";
import { Sessions } from "./session/index.js";
import { createStore } from "./store/index.js";
import { stopOnSignal } from "./shutdown.js";
import { HttpTransport } from "./transport/index.js";

const sessions = new Sessions({
  client: createClient(),
  model: MODEL,
  system: SYSTEM,
  contextLimit: CONTEXT_LIMIT,
  trim: TRIM,
  stream: STREAM,
  beforeToolCall: approvalHook(
    APPROVAL === "auto" ? async () => true : undefined,
  ),
  store: createStore(),
});

const transport = new HttpTransport(PORT);

console.log(`${MODEL} / ${STORE}:${STORE_PATH} / http://localhost:${PORT}`);

stopOnSignal(transport);
await transport.start(sessions);
await sessions.close();
