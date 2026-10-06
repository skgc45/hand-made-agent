import type OpenAI from "openai";
import type { Toolset } from "../agent/toolset.js";
import type { Profile } from "../profile/index.js";
import { McpClient, type McpServerConfig, type McpTool } from "./client.js";

export type { McpServerConfig } from "./client.js";

/** ツール名の衝突を避ける。権限ルールもこの名前で書く */
const prefix = (server: string, tool: string) => `mcp__${server}__${tool}`;

export const TOOL_SEARCH = "tool_search";
const SEARCH_LIMIT = 10;

export type McpToolset = Toolset & {
  kinds: Record<string, "read" | "edit" | "execute">;
  /** どのサーバの何が生えたか。hma config で出す */
  listing: { server: string; tool: string; readOnly: boolean }[];
  close(): void;
};

export type McpSource = {
  server: string;
  tool: McpTool;
  deferred: boolean;
  call(name: string, input: unknown): Promise<string>;
};

function toFunction(server: string, tool: McpTool): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: prefix(server, tool.name),
      description: tool.description ?? "",
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    },
  };
}

/**
 * 遅延のツールは tool_search で見つかるまで tools に載せない。
 * tools は呼ばれるたびに作るので、見つけたぶんが次の API リクエストから足される
 */
export function createMcpToolset(
  sources: McpSource[],
  close: () => void = () => {},
): McpToolset {
  const eager: OpenAI.ChatCompletionTool[] = [];
  const hidden = new Map<string, OpenAI.ChatCompletionTool>();
  const found = new Set<string>();
  const kinds: McpToolset["kinds"] = {};
  const listing: McpToolset["listing"] = [];
  const routes = new Map<string, McpSource>();

  for (const source of sources) {
    const full = prefix(source.server, source.tool.name);
    // 種類を申告しないサーバのツールは read 扱いしない。止まる側へ倒す
    const readOnly = source.tool.annotations?.readOnlyHint === true;
    const fn = toFunction(source.server, source.tool);
    if (source.deferred) hidden.set(full, fn);
    else eager.push(fn);
    kinds[full] = readOnly ? "read" : "execute";
    routes.set(full, source);
    listing.push({ server: source.server, tool: source.tool.name, readOnly });
  }

  const deferredServers = [
    ...new Set(sources.filter((s) => s.deferred).map((s) => s.server)),
  ];
  const search: OpenAI.ChatCompletionTool | undefined =
    hidden.size > 0
      ? {
          type: "function",
          function: {
            name: TOOL_SEARCH,
            description: `tools に載っていない MCP ツール（サーバ: ${deferredServers.join(", ")}）を、名前と説明の語で探す。見つかったツールは次から呼べる。`,
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "空白区切りの語。名前か説明に含まれるもの",
                },
              },
              required: ["query"],
            },
          },
        }
      : undefined;
  if (search) kinds[TOOL_SEARCH] = "read";

  function runSearch(input: unknown): string {
    const raw = (input as { query?: unknown } | null)?.query;
    const terms = (typeof raw === "string" ? raw : "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) {
      return `query に探したい語を入れてください（例: ${deferredServers[0] ?? "notes"}）`;
    }
    const hits = [...hidden]
      .flatMap(([name, tool]) => {
        if (tool.type !== "function") return [];
        const text = `${name} ${tool.function.description ?? ""}`.toLowerCase();
        const score = terms.filter((t) => text.includes(t)).length;
        return score > 0 ? [{ name, fn: tool.function, score }] : [];
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, SEARCH_LIMIT);
    if (hits.length === 0) {
      return `一致するツールがありません: ${terms.join(" ")}`;
    }

    for (const hit of hits) found.add(hit.name);
    return JSON.stringify(
      hits.map(({ fn }) => ({
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      })),
      null,
      2,
    );
  }

  return {
    get tools() {
      return [
        ...(search ? [search] : []),
        ...eager,
        ...[...found].flatMap((name) => hidden.get(name) ?? []),
      ];
    },
    kinds,
    listing,
    close,
    async execute(name, input) {
      if (name === TOOL_SEARCH && search) return runSearch(input);
      const route = routes.get(name);
      if (!route) return `エラー: 未知の MCP ツール ${name}`;
      // tool_search はスキーマを知るための道具で、呼べるかどうかの門ではない。
      // 権限は kinds と mcpRules が見るので、未発見でも実行し、found は tools に並べるかだけを決める
      if (hidden.has(name)) found.add(name);
      try {
        return await route.call(route.tool.name, input);
      } catch (error) {
        return `エラー: ${(error as Error).message}`;
      }
    },
  };
}

/**
 * 設定に書かれたサーバを全部起動して、ツールを1つの Toolset に畳む。
 * 起動に失敗したサーバは警告して飛ばす（他のサーバまで道連れにしない）
 */
export async function connectMcp(
  servers: Record<string, McpServerConfig>,
): Promise<McpToolset> {
  const clients: McpClient[] = [];
  const sources: McpSource[] = [];

  for (const [name, config] of Object.entries(servers)) {
    const client = new McpClient(name, config);
    try {
      await client.initialize();
      for (const tool of await client.listTools()) {
        sources.push({
          server: name,
          tool,
          deferred: config.expose === "deferred",
          call: (toolName, input) => client.callTool(toolName, input),
        });
      }
      clients.push(client);
    } catch (error) {
      console.error(
        `\x1b[33mMCP サーバ ${name} に繋がりません: ${(error as Error).message}\x1b[0m`,
      );
      client.close();
    }
  }

  return createMcpToolset(sources, () => {
    for (const client of clients) client.close();
  });
}

export function withMcp(profile: Profile, mcp: McpToolset): Profile {
  if (mcp.listing.length === 0) return profile;

  return {
    ...profile,
    kinds: { ...profile.kinds, ...mcp.kinds },
    toolset: {
      get tools() {
        return [...profile.toolset.tools, ...mcp.tools];
      },
      drain: profile.toolset.drain,
      execute: (name, input, signal) =>
        mcp.kinds[name] !== undefined
          ? mcp.execute(name, input, signal)
          : profile.toolset.execute(name, input, signal),
    },
  };
}
