import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type OpenAI from "openai";
import type { Toolset } from "./toolset.js";

const exec = promisify(execFile);

/** workspace を閉じ込めたファイル操作ツール一式を作る */
export function createFileTools(workspace: string): Toolset {
  const ROOT = path.resolve(workspace);

  function resolveInRoot(relPath: string): string {
    const abs = path.resolve(ROOT, relPath);
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      throw new Error(`${workspace} の外にはアクセスできません: ${relPath}`);
    }
    return abs;
  }

  const WORKSPACE = workspace;

  const tools: OpenAI.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: `${WORKSPACE} 内のディレクトリのファイル一覧を返す。パスを省略するとルート。`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: `${WORKSPACE} からの相対パス`,
            },
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
            path: {
              type: "string",
              description: `${WORKSPACE} からの相対パス`,
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: `${WORKSPACE} 内のファイルに書き込む。既存ファイルは上書きされる。親ディレクトリは自動作成する。`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: `${WORKSPACE} からの相対パス`,
            },
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
        description: `${WORKSPACE} 内のファイルの一部を置き換える。ファイル全体を書き直さずに済むので、既存ファイルの修正はこちらを使う。`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: `${WORKSPACE} からの相対パス`,
            },
            old_text: {
              type: "string",
              description:
                "置き換える前のテキスト。ファイル内でちょうど1箇所に一致する必要があるので、足りなければ前後の行を含めて長くする。",
            },
            new_text: {
              type: "string",
              description: "置き換えたあとのテキスト",
            },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: `${WORKSPACE} 内のファイルをパターンで探す。名前が分かっているときはこちら。`,
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: `**/*.ts のようなパターン。${WORKSPACE} からの相対`,
            },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: `${WORKSPACE} 内のファイルの中身を正規表現で探し、一致した行を返す。`,
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "正規表現" },
            glob: {
              type: "string",
              description: "探す範囲。省略すると全ファイル（既定 **/*）",
            },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "todo_write",
        description:
          "これからやることの一覧を記録して、いまの状態を返す。手順が3つ以上あるときに使う。",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              description: "やることの一覧。毎回すべて渡す（差分ではない）",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  done: { type: "boolean" },
                },
                required: ["text"],
              },
            },
          },
          required: ["items"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: `シェルコマンドを実行して標準出力・標準エラー・終了コードを返す。カレントディレクトリは ${WORKSPACE}。`,
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

  /** 探索が際限なく返らないようにする。上限に当たったことは結果に書く */
  const MAX_HITS = 200;

  async function* walk(pattern: string): AsyncGenerator<string> {
    // glob は ROOT の外に出られない。パターンに .. が入っていても cwd で閉じる
    for await (const entry of fs.glob(pattern, { cwd: ROOT })) {
      const rel = typeof entry === "string" ? entry : String(entry);
      const abs = path.resolve(ROOT, rel);
      if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) continue;
      yield rel;
    }
  }

  const handlers: Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: ハンドラごとに引数の形が違う
    (input: any, signal?: AbortSignal) => Promise<string>
  > = {
    async glob({ pattern }) {
      const found: string[] = [];
      for await (const rel of walk(pattern)) {
        found.push(rel);
        if (found.length >= MAX_HITS) break;
      }
      if (found.length === 0) return "(一致なし)";
      found.sort();
      return found.length >= MAX_HITS
        ? `${found.join("\n")}\n（${MAX_HITS} 件で打ち切り。パターンを絞ってください）`
        : found.join("\n");
    },

    async grep({ pattern, glob = "**/*" }) {
      let regexp: RegExp;
      try {
        regexp = new RegExp(pattern);
      } catch (error) {
        return `エラー: 正規表現として読めません: ${(error as Error).message}`;
      }

      const hits: string[] = [];
      for await (const rel of walk(glob)) {
        const abs = path.resolve(ROOT, rel);
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        let text: string;
        try {
          text = await fs.readFile(abs, "utf-8");
        } catch {
          continue;
        }
        // バイナリを行として吐くと履歴が壊れる
        if (text.includes("\u0000")) continue;

        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!regexp.test(lines[i])) continue;
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= MAX_HITS) break;
        }
        if (hits.length >= MAX_HITS) break;
      }

      if (hits.length === 0) return "(一致なし)";
      return hits.length >= MAX_HITS
        ? `${hits.join("\n")}\n（${MAX_HITS} 件で打ち切り。パターンを絞ってください）`
        : hits.join("\n");
    },

    async todo_write({ items }) {
      const list: { text: string; done?: boolean }[] = Array.isArray(items)
        ? items
        : [];
      if (list.length === 0) return "(空)";
      return list
        .map((item) => `${item.done ? "[x]" : "[ ]"} ${item.text}`)
        .join("\n");
    },

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
        return (
          [stdout, stderr].filter(Boolean).join("\n").trim() || "(出力なし)"
        );
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

  return {
    tools,
    async execute(name, input, signal) {
      const handler = handlers[name];
      if (!handler) return `エラー: 未知のツール ${name}`;
      try {
        return await handler(input, signal);
      } catch (error) {
        return `エラー: ${(error as Error).message}`;
      }
    },
  };
}
