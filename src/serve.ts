import {
  APPROVAL,
  CONTEXT_LIMIT,
  MODEL,
  NEEDS_TRUST,
  PORT,
  PROFILE,
  SETTINGS_FILES,
  STORE,
  STORE_PATH,
  STREAM,
  TRIM,
  TRUST_SUBJECT,
  WORKSPACE,
  createClient,
  hooksFor,
} from "./config.js";
import { collectContext } from "./context/index.js";
import { type Hooks, createHooks } from "./harness/index.js";
import { withSubagents } from "./agent/subagent.js";
import { loadCommands } from "./commands/index.js";
import { loadSkills, withSkills } from "./skills/index.js";
import { describeTrust } from "./settings/trust.js";
import { createProfile } from "./profile/index.js";
import { Sessions } from "./session/index.js";
import { createStore } from "./store/index.js";
import { createTelemetry } from "./telemetry/index.js";
import { stopOnSignal } from "./shutdown.js";
import { HttpTransport } from "./transport/index.js";

// 子は親と同じフックを通す。プロファイルとフックが互いに要るので、中身だけ後から差す
const hooks: Hooks = {};
const skills = await loadSkills();
const commands = await loadCommands();
const { profile, jobs } = withSubagents(
  withSkills(createProfile(PROFILE, WORKSPACE), skills),
  {
    client: createClient(),
    model: MODEL,
    contextLimit: CONTEXT_LIMIT,
    trim: TRIM,
    hooks,
  },
);

// serve は入力を待てないので聞けない。無効にして、やり方だけ言う
if (NEEDS_TRUST) {
  console.error("\x1b[33m未確認の .hma があるため、フックと allow を無効にしました:\x1b[0m");
  for (const line of describeTrust(TRUST_SUBJECT)) console.error(line);
  console.error("\x1b[2m  有効にするには、このディレクトリで hma trust を実行してください。\x1b[0m");
}

const sections = await collectContext({
  workspace: WORKSPACE,
  mode: APPROVAL,
  sessionStart: hooksFor(!NEEDS_TRUST).SessionStart ?? [],
  skills,
});

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
    createHooks({ profile, trusted: !NEEDS_TRUST, commands }),
  ),
  jobs,
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
