import path from "node:path";

/** 親が実行したツールの呼び出し。arguments はモデルが出した JSON 文字列のまま */
export type Call = { tool: string; arguments: string };

// glob の、ワイルドカードより前の固定部分。先頭の **/ を外し、最初の {a,b} は展開してから見る
function staticPrefixes(pattern: string): string[] {
  const brace = pattern.match(/\{([^{}]*)\}/);
  if (brace) {
    return brace[1]
      .split(",")
      .flatMap((alt) => staticPrefixes(pattern.replace(brace[0], alt)));
  }
  const fixed: string[] = [];
  for (const segment of pattern.replace(/^(\*\*\/)+/, "").split("/")) {
    if (/[*?[{]/.test(segment)) break;
    fixed.push(segment);
  }
  return [fixed.join("/") || "."];
}

/**
 * 呼び出しが見に行く先。引数を知らないツール（explore や MCP）は数えない。
 * explore への指示文に範囲の名前が入るのは、任せた側として当たり前なので
 */
function targets(call: Call): string[] {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return [];
  }
  if (typeof args !== "object" || args === null) return [];
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" ? v : fallback;
  switch (call.tool) {
    case "list_files":
    case "read_file":
      return [str(args.path, ".")];
    case "glob":
      return staticPrefixes(str(args.pattern, "**/*"));
    case "grep":
      return staticPrefixes(str(args.glob, "**/*"));
    case "bash":
      // コメントの中の名前は触ったことにならない。引用符の中の # までは見ない
      return str(args.command, "")
        .replace(/#[^\n]*/g, "")
        .split(/[\s;|&<>()"'`=]+/)
        .filter((w) => w && !w.startsWith("-"));
    default:
      return [];
  }
}

function within(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/** 任せた範囲（untouched、workspace からの相対）に親が手を出した呼び出し */
export function touchedCalls(
  calls: Call[],
  untouched: string[],
  root: string,
): Call[] {
  const dirs = untouched.map((u) => path.resolve(root, u));
  return calls.filter((c) =>
    targets(c).some((t) => {
      const abs = path.resolve(root, t);
      return dirs.some((d) => within(abs, d));
    }),
  );
}
