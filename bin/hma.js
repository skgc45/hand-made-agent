#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `hma — 手書きエージェント

  hma [...]           sandbox プロファイルで対話（既定）
  hma code [path]     コーディングエージェント。path 省略時は現在のディレクトリ
  hma serve           HTTP + SSE で起動
  hma list            保存されているスレッド一覧
  hma config          いま効いている設定と権限ルール（どこから来たかつき）
  hma trust           .hma のフックと allow を確認して信頼する

CLI のオプション: --thread <id> / --new / --profile <name> / --workspace <path>
`;

const [sub, ...rest] = process.argv.slice(2);

let entry = "src/cli.ts";
let args = [];

switch (sub) {
  case "serve":
    entry = "src/serve.ts";
    args = rest;
    break;
  case "code": {
    // 第1引数がオプションでなければ作業ディレクトリとして受け取る
    const [maybePath, ...others] =
      rest[0] && !rest[0].startsWith("-") ? rest : [".", ...rest];
    args = ["--profile", "coding", "--workspace", maybePath, ...others];
    break;
  }
  case "list":
    args = ["--list", ...rest];
    break;
  case "config":
    args = ["--config", ...rest];
    break;
  case "trust":
    args = ["--trust", ...rest];
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(USAGE);
    process.exit(0);
    break;
  default:
    args = sub === undefined ? rest : [sub, ...rest];
}

// tsx と .env はインストール元から解決する。cwd はユーザーのいる場所のまま渡す
const child = spawn(
  process.execPath,
  [
    `--env-file-if-exists=${path.join(root, ".env")}`,
    "--import",
    pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href,
    path.join(root, entry),
    ...args,
  ],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
