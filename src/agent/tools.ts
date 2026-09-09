import type OpenAI from "openai";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WORKSPACE } from "../config.js";

const exec = promisify(execFile);

const ROOT = path.resolve(WORKSPACE);

function resolveInRoot(relPath: string): string {
  const abs = path.resolve(ROOT, relPath);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`${WORKSPACE} の外にはアクセスできません: ${relPath}`);
  }
  return abs;
}

export const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        `${WORKSPACE} 内のディレクトリのファイル一覧を返す。パスを省略するとルート。`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: `${WORKSPACE} からの相対パス` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: `${WORKSPACE} 内のファイルの中身を読む。`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: `${WORKSPACE} からの相対パス` },
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
        `${WORKSPACE} 内のファイルに書き込む。既存ファイルは上書きされる。親ディレクトリは自動作成する。`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: `${WORKSPACE} からの相対パス` },
          content: { type: "string", description: "書き込む内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        `${WORKSPACE} 内のファイルの一部を置き換える。ファイル全体を書き直さずに済むので、既存ファイルの修正はこちらを使う。`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: `${WORKSPACE} からの相対パス` },
          old_text: {
            type: "string",
            description:
              "置き換える前のテキスト。ファイル内でちょうど1箇所に一致する必要があるので、足りなければ前後の行を含めて長くする。",
          },
          new_text: { type: "string", description: "置き換えたあとのテキスト" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        `シェルコマンドを実行して標準出力・標準エラー・終了コードを返す。カレントディレクトリは ${WORKSPACE}。`,
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

  async edit_file({ path: rel, old_text, new_text }) {
    const abs = resolveInRoot(rel);
    const before = await fs.readFile(abs, "utf-8");

    // 一意でない置換は「どこを直したつもりか」が食い違うので、数えてから断る
    const hits = before.split(old_text).length - 1;
    if (hits === 0) {
      return `エラー: old_text が見つかりません。read_file で現在の中身を確認してください。`;
    }
    if (hits > 1) {
      return `エラー: old_text が ${hits} 箇所に一致します。前後の行を含めて一意になるまで長くしてください。`;
    }

    await fs.writeFile(abs, before.replace(old_text, new_text), "utf-8");
    const removed = old_text.split("\n").length;
    const added = new_text.split("\n").length;
    return `${rel} を編集しました（-${removed} +${added} 行）`;
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
