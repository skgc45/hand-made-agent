import type { Telemetry } from "./index.js";

export class NoopTelemetry implements Telemetry {
  record(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}
