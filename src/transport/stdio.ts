import * as readline from "node:readline/promises";
import type { AskFn } from "../harness/approval.js";
import { CliRenderer, cyan, dim, yellow } from "../render/cli.js";
import type { Sessions } from "../session/index.js";
import type { Transport } from "./index.js";

/** stdin/stdout を transport にする。承認は stdin を待てるので await で済む */
export class StdioTransport implements Transport {
  private readonly rl: readline.Interface;
  private readonly closing = new AbortController();
  private running?: AbortController;
  private asking = false;

  constructor(private readonly threadId: string) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.rl.on("close", () => this.closing.abort());
    this.rl.pause();
  }

  /** 閉じられていたら null。呼び出し側は終了として扱う */
  private async ask(prompt: string): Promise<string | null> {
    if (this.closing.signal.aborted) return null;
    this.asking = true;
    this.rl.resume();
    try {
      return await this.rl.question(prompt, { signal: this.closing.signal });
    } catch {
      return null;
    } finally {
      this.asking = false;
      // 閉じたあとに pause すると ERR_USE_AFTER_CLOSE。
      // run 中は割り込みを拾うために resume したままにする
      if (!this.closing.signal.aborted && !this.running) this.rl.pause();
    }
  }

  approve: AskFn = async ({
    name,
    arguments: args,
    suggestedRule,
    attempted,
  }) => {
    if (attempted) {
      console.log(
        yellow(
          "\n  ⚠ 前回このツールは実行を始めたまま落ちています。二重実行になるかもしれません",
        ),
      );
    }
    console.log(yellow(`\n  ${name} を実行しようとしています:`));
    console.log(yellow(`  ${args}`));
    const answer = await this.ask(
      yellow("  許可する? [y]es / [n]o / [a]lways / [s]ave: "),
    );
    if (answer === null) return { approved: false };

    const choice = answer.trim().toLowerCase();
    if (choice === "a" || choice === "s") {
      // 何を常に許可したのか、確定する前に見せて直させる
      const edited = await this.ask(
        yellow(
          suggestedRule
            ? `  許可するルール [${suggestedRule}]: `
            : "  許可するルール（連結コマンドなので提案なし。空なら今回だけ）: ",
        ),
      );
      if (edited === null) return { approved: false };

      const rule = edited.trim() || suggestedRule;
      return {
        approved: true,
        rule,
        save: rule !== undefined && choice === "s",
      };
    }
    return { approved: choice === "y" || choice === "" };
  };

  async start(sessions: Sessions): Promise<void> {
    while (true) {
      const line = await this.ask(cyan("> "));
      if (line === null) return;

      const input = line.trim();
      if (!input) continue;

      const renderer = new CliRenderer();
      this.running = new AbortController();

      // 作業中に打たれた行は新しい run にせず、割り込みとして積む
      const onLine = (line: string) => {
        const text = line.trim();
        if (!text || this.asking) return;
        if (sessions.steer(this.threadId, text, "steering")) {
          console.log(dim("  [割り込みを受け付けました]"));
        }
      };
      // TTY の readline は出力のたびにプロンプト行を描き直すので、
      // run 中は空にしておかないと "> " がツール出力の途中に混ざる
      this.rl.setPrompt("");
      this.rl.on("line", onLine);
      this.rl.resume();

      try {
        const run = sessions.run(
          this.threadId,
          input,
          undefined,
          undefined,
          this.running.signal,
        );
        for await (const event of run) {
          const out = renderer.render(event);
          if (!out) continue;
          if (out.stderr) console.error(out.text);
          else if (out.raw) process.stdout.write(out.text);
          else console.log(out.text);
        }
      } finally {
        this.rl.off("line", onLine);
        this.running = undefined;
        if (!this.closing.signal.aborted) this.rl.pause();
      }
      console.log();
    }
  }

  interrupt(): boolean {
    if (!this.running) return false;
    this.running.abort();
    console.log(yellow("\n  中断しました。"));
    return true;
  }

  async stop(): Promise<void> {
    this.rl.close();
  }
}
