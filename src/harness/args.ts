export function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}
