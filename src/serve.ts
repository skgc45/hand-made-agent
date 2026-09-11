import {
  CONTEXT_LIMIT,
  NEEDS_TRUST,
  TRUST_SUBJECT,
  MODEL,
  PORT,
  PROFILE,
  SETTINGS_FILES,
  STORE,
  STORE_PATH,
  STREAM,
  WORKSPACE,
  TRIM,
  createClient,
} from "./config.js";
import { createHooks } from "./harness/index.js";
import { describeTrust } from "./settings/trust.js";
import { createProfile } from "./profile/index.js";
import { Sessions } from "./session/index.js";
import { createStore } from "./store/index.js";
import { createTelemetry } from "./telemetry/index.js";
import { stopOnSignal } from "./shutdown.js";
import { HttpTransport } from "./transport/index.js";

const profile = createProfile(PROFILE, WORKSPACE);

// serve は入力を待てないので聞けない。無効にして、やり方だけ言う
if (NEEDS_TRUST) {
  console.error("\x1b[33m未確認の .hma があるため、フックと allow を無効にしました:\x1b[0m");
  for (const line of describeTrust(TRUST_SUBJECT)) console.error(line);
  console.error("\x1b[2m  有効にするには、このディレクトリで hma trust を実行してください。\x1b[0m");
}

const sessions = new Sessions({
  client: createClient(),
  model: MODEL,
  profile,
  contextLimit: CONTEXT_LIMIT,
  trim: TRIM,
  stream: STREAM,
  ...createHooks({ profile, trusted: !NEEDS_TRUST }),
  store: createStore(),
  telemetry: createTelemetry(),
});

const transport = new HttpTransport(PORT);

console.log(
  `${MODEL} / ${profile.name}:${profile.workspace} / ${STORE}:${STORE_PATH} / http://localhost:${PORT}` +
    (SETTINGS_FILES.length > 0 ? `\n設定: ${SETTINGS_FILES.join(" < ")}` : ""),
);

stopOnSignal(transport);
await transport.start(sessions);
await sessions.close();
