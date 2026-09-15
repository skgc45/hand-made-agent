import { EventType } from "@ag-ui/core";
import { CliRenderer } from "../render/cli.js";
import type { Sessions } from "../session/index.js";
import type { Transport } from "./index.js";

/**
 * 入力を待たない transport。1 run だけ回して終わる。
 * `approve` が無いので、承認が要るツールに当たると Interrupt で run が終わる（http と同じ）。
 */
export class PrintTransport implements Transport {
  /** 0 = 完走 / 1 = エラー / 2 = 承認が要って止まった */
  exitCode = 0;
  private readonly running = new AbortController();

  constructor(
    private readonly threadId: string,
    private readonly prompt: string,
  ) {}

  async start(sessions: Sessions): Promise<void> {
    const renderer = new CliRenderer(process.stderr.isTTY === true);
    const run = sessions.run(
      this.threadId,
      this.prompt,
      undefined,
      undefined,
      this.running.signal,
    );

    for await (const event of run) {
      if (event.type === EventType.RUN_ERROR) this.exitCode = 1;
      if (
        event.type === EventType.RUN_FINISHED &&
        event.outcome?.type === "interrupt"
      ) {
        this.exitCode = 2;
        this.write(
          `承認が要るツールで止まりました（${event.outcome.interrupts.map((i) => i.message).join(" / ")}）。\nAPPROVAL=auto にするか allow ルールを足してください。\n`,
          true,
        );
      }

      const out = renderer.render(event);
      // 本文だけ stdout。進捗は stderr に分けて、呼び出し側が捨てられるようにする
      if (out) this.write(out.raw ? out.text : `${out.text}\n`, !out.raw);
    }
  }

  private write(text: string, toStderr: boolean): void {
    (toStderr ? process.stderr : process.stdout).write(text);
  }

  interrupt(): boolean {
    // 2回目は譲る。stopOnSignal がプロセスを落とせなくなる
    if (this.running.signal.aborted) return false;
    this.running.abort();
    return true;
  }

  async stop(): Promise<void> {
    this.running.abort();
  }
}
