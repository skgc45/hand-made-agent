import {
  MODEL,
  NEEDS_TRUST,
  PORT,
  PROFILE,
  SETTINGS_FILES,
  STORE,
  STORE_PATH,
  TRUST_SUBJECT,
  WORKSPACE,
} from "./config.js";
import { buildSessions, loadAssets } from "./runtime.js";
import { describeTrust } from "./settings/trust.js";
import { stopOnSignal } from "./shutdown.js";
import { createStore } from "./store/index.js";
import { createTelemetry } from "./telemetry/index.js";
import { HttpTransport } from "./transport/index.js";

// serve は入力を待てないので聞けない。無効にして、やり方だけ言う
if (NEEDS_TRUST) {
  console.error(
    "\x1b[33m未確認の .hma があるため、フックと allow を無効にしました:\x1b[0m",
  );
  for (const line of describeTrust(TRUST_SUBJECT)) console.error(line);
  console.error(
    "\x1b[2m  有効にするには、このディレクトリで hma trust を実行してください。\x1b[0m",
  );
}

const assets = await loadAssets(!NEEDS_TRUST);
const { sessions, profile } = await buildSessions(assets, {
  profile: PROFILE,
  workspace: WORKSPACE,
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
assets.mcp.close();
