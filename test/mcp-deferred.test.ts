import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpRules, modeRules } from "../src/harness/index.js";
import { createMcpToolset, TOOL_SEARCH, withMcp } from "../src/mcp/index.js";
import { createPermissions } from "../src/permission/index.js";
import { createProfile } from "../src/profile/index.js";

const calls: string[] = [];
const source = (
  server: string,
  name: string,
  description: string,
  deferred: boolean,
  readOnlyHint?: boolean,
) => ({
  server,
  tool: {
    name,
    description,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint },
  },
  deferred,
  call: async (tool: string) => {
    calls.push(tool);
    return `ok ${tool}`;
  },
});

const sources = (deferred: boolean) => [
  source("notes", "add_note", "ノートを追加する", deferred),
  source("notes", "list_notes", "ノートの一覧", deferred, true),
  source("web", "fetch_page", "ページを取得する", deferred, true),
];

const names = (set: { tools: unknown[] }) =>
  (set.tools as { function: { name: string } }[]).map((t) => t.function.name);

describe("MCP の遅延公開", () => {
  it("既定（全部）は今まで通り全部載り、tool_search は無い", () => {
    const set = createMcpToolset(sources(false));
    assert.deepEqual(names(set), [
      "mcp__notes__add_note",
      "mcp__notes__list_notes",
      "mcp__web__fetch_page",
    ]);
    assert.equal(set.kinds[TOOL_SEARCH], undefined);
  });

  it("遅延のときは tool_search 1本だけが載り、read 扱い", () => {
    const set = createMcpToolset(sources(true));
    assert.deepEqual(names(set), [TOOL_SEARCH]);
    assert.equal(set.kinds[TOOL_SEARCH], "read");
    assert.equal(set.kinds.mcp__notes__add_note, "execute");
    assert.equal(set.kinds.mcp__notes__list_notes, "read");
  });

  it("検索は名前と説明に当たり、名前・説明・スキーマを返す", async () => {
    const set = createMcpToolset(sources(true));
    const out = JSON.parse(await set.execute(TOOL_SEARCH, { query: "ノート" }));
    assert.deepEqual(
      out.map((o: { name: string }) => o.name),
      ["mcp__notes__add_note", "mcp__notes__list_notes"],
    );
    assert.equal(out[0].description, "ノートを追加する");
    assert.equal(out[0].parameters.type, "object");
    assert.match(
      await set.execute(TOOL_SEARCH, { query: "zzz" }),
      /一致するツールがありません/,
    );
  });

  it("見つけたものだけが次から tools に足され、呼べる", async () => {
    const set = createMcpToolset(sources(true));
    await set.execute(TOOL_SEARCH, { query: "fetch" });
    assert.deepEqual(names(set), [TOOL_SEARCH, "mcp__web__fetch_page"]);
    assert.equal(
      await set.execute("mcp__web__fetch_page", {}),
      "ok fetch_page",
    );
  });

  it("見つけていないツールを名前で呼んでも実行され、tools に足される", async () => {
    calls.length = 0;
    const set = createMcpToolset(sources(true));
    assert.equal(await set.execute("mcp__notes__add_note", {}), "ok add_note");
    assert.deepEqual(calls, ["add_note"]);
    assert.deepEqual(names(set), [TOOL_SEARCH, "mcp__notes__add_note"]);
  });

  it("空や空白だけのクエリは何も見つけず、語を入れるよう案内する", async () => {
    const set = createMcpToolset(sources(true));
    for (const query of ["", "   "]) {
      assert.match(await set.execute(TOOL_SEARCH, { query }), /語を入れて/);
    }
    assert.deepEqual(names(set), [TOOL_SEARCH]);
  });

  it("withMcp を通しても tools が最新になる", async () => {
    const base = createProfile("sandbox", process.cwd());
    const profile = withMcp(base, createMcpToolset(sources(true)));
    const before = profile.toolset.tools.length;
    await profile.toolset.execute(TOOL_SEARCH, { query: "web" });
    assert.equal(profile.toolset.tools.length, before + 1);
  });
});

describe("遅延公開と権限", () => {
  it("未発見の遅延ツールを直接呼んでも、readOnlyHint なしは ask", () => {
    const base = createProfile("sandbox", process.cwd());
    const profile = withMcp(base, createMcpToolset(sources(true)));
    const p = createPermissions(mcpRules(profile), "ask", process.cwd());
    assert.equal(p.decide("mcp__notes__add_note", {}), "ask");
    assert.equal(p.decide("mcp__notes__list_notes", {}), "allow");
  });

  it("未発見の非 read ツールも deny に入る", () => {
    const base = createProfile("sandbox", process.cwd());
    const profile = withMcp(base, createMcpToolset(sources(true)));
    const rules = modeRules(profile, "plan");
    assert.ok(rules.deny?.includes("mcp__notes__add_note"));
    assert.ok(!rules.deny?.includes("mcp__notes__list_notes"));
    assert.ok(!rules.deny?.includes(TOOL_SEARCH));
  });
});
