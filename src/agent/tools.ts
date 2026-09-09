import type OpenAI from "openai";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "..", "..", "sandbox");

function resolveInRoot(relPath: string): string {
  const abs = path.resolve(ROOT, relPath);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`sandbox/ の外にはアクセスできません: ${relPath}`);
  }
  return abs;
}

export const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "sandbox 内のディレクトリのファイル一覧を返す。パスを省略するとルート。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "sandbox からの相対パス" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "sandbox 内のファイルの中身を読む。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "sandbox からの相対パス" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "sandbox 内のファイルに書き込む。既存ファイルは上書きされる。親ディレクトリは自動作成する。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "sandbox からの相対パス" },
          content: { type: "string", description: "書き込む内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "シェルコマンドを実行して標準出力・標準エラー・終了コードを返す。カレントディレクトリは sandbox。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "実行するコマンド" },
        },
        required: ["command"],
      },
    },
  },
];

export const requiresApproval = new Set(["bash"]);

const handlers: Record<
  string,
  (input: any, signal?: AbortSignal) => Promise<string>
> = {
  async list_files({ path: rel = "." }) {
    const entries = await fs.readdir(resolveInRoot(rel), {
      withFileTypes: true,
    });
    if (entries.length === 0) return "(空)";
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n");
  },

  async read_file({ path: rel }) {
    return await fs.readFile(resolveInRoot(rel), "utf-8");
  },

  async write_file({ path: rel, content }) {
    const abs = resolveInRoot(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return `${content.length} 文字を書き込みました`;
  },

  async bash({ command }, signal) {
    try {
      const { stdout, stderr } = await exec("/bin/bash", ["-c", command], {
        cwd: ROOT,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        signal,
      });
      return [stdout, stderr].filter(Boolean).join("\n").trim() || "(出力なし)";
    } catch (error) {
      const e = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (signal?.aborted) return "中断されました";
      if (e.killed) return "タイムアウト（30秒）で中断しました";
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      return `exit ${e.code ?? "?"}\n${output}`.trim();
    }
  },
};

export async function executeTool(
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const handler = handlers[name];
  if (!handler) return `エラー: 未知のツール ${name}`;

  try {
    return await handler(input, signal);
  } catch (error) {
    return `エラー: ${(error as Error).message}`;
  }
}
