import type { Transport } from "./transport/index.js";

/**
 * run が走っていればまず中断し、走っていなければ transport を閉じ、
 * それでも来たら即座に落とす。
 */
export function stopOnSignal(transport: Transport): void {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (transport.interrupt?.()) return;
      if (stopping) process.exit(130);
      stopping = true;
      void transport.stop();
    });
  }
}
