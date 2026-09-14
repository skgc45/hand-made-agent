import type OpenAI from "openai";
import type { Toolset } from "../agent/toolset.js";
import type { Profile } from "../profile/index.js";
import { McpClient, type McpServerConfig, type McpTool } from "./client.js";

export type { McpServerConfig } from "./client.js";

/** ツール名の衝突を避ける。権限ルールもこの名前で書く */
const prefix = (server: string, tool: string) => `mcp__${server}__${tool}`;

export type McpToolset = Toolset & {
  kinds: Record<string, "read" | "edit" | "execute">;
  /** どのサーバの何が生えたか。hma config で出す */
  listing: { server: string; tool: string; readOnly: boolean }[];
  close(): void;
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
 * 設定に書かれたサーバを全部起動して、ツールを1つの Toolset に畳む。
 * 起動に失敗したサーバは警告して飛ばす（他のサーバまで道連れにしない）
 */
export async function connectMcp(
  servers: Record<string, McpServerConfig>,
): Promise<McpToolset> {
  const clients = new Map<string, McpClient>();
  const tools: OpenAI.ChatCompletionTool[] = [];
  const kinds: Record<string, "read" | "edit" | "execute"> = {};
  const listing: McpToolset["listing"] = [];
  const routes = new Map<string, { client: McpClient; tool: string }>();

  for (const [name, config] of Object.entries(servers)) {
    const client = new McpClient(name, config);
    try {
      await client.initialize();
      for (const tool of await client.listTools()) {
        const full = prefix(name, tool.name);
        // 種類を申告しないサーバのツールは read 扱いしない。止まる側へ倒す
        const readOnly = tool.annotations?.readOnlyHint === true;
        tools.push(toFunction(name, tool));
        kinds[full] = readOnly ? "read" : "execute";
        routes.set(full, { client, tool: tool.name });
        listing.push({ server: name, tool: tool.name, readOnly });
      }
      clients.set(name, client);
    } catch (error) {
      console.error(
        `\x1b[33mMCP サーバ ${name} に繋がりません: ${(error as Error).message}\x1b[0m`,
      );
      client.close();
    }
  }

  return {
    tools,
    kinds,
    listing,
    close: () => {
      for (const client of clients.values()) client.close();
    },
    async execute(name, input) {
      const route = routes.get(name);
      if (!route) return `エラー: 未知の MCP ツール ${name}`;
      try {
        return await route.client.callTool(route.tool, input);
      } catch (error) {
        return `エラー: ${(error as Error).message}`;
      }
    },
  };
}

export function withMcp(profile: Profile, mcp: McpToolset): Profile {
  if (mcp.tools.length === 0) return profile;

  return {
    ...profile,
    kinds: { ...profile.kinds, ...mcp.kinds },
    toolset: {
      tools: [...profile.toolset.tools, ...mcp.tools],
      drain: profile.toolset.drain,
      execute: (name, input, signal) =>
        mcp.kinds[name] !== undefined
          ? mcp.execute(name, input, signal)
          : profile.toolset.execute(name, input, signal),
    },
  };
}
