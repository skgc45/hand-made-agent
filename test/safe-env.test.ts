import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SECRET_ENV_KEYS, safeEnv } from "../src/agent/env.js";
import { createFileTools } from "../src/agent/tools.js";
import { runHook } from "../src/hooks/index.js";

describe("safeEnv", () => {
  it("鍵を除き、ほかの変数は残す", () => {
    const env = safeEnv({
      GEMINI_API_KEY: "a",
      LLM_API_KEY: "b",
      PATH: "/bin",
    });
    for (const key of SECRET_ENV_KEYS) assert.equal(key in env, false);
    assert.equal(env.PATH, "/bin");
  });

  it("元の環境を書き換えない", () => {
    const base = { GEMINI_API_KEY: "a" };
    safeEnv(base);
    assert.equal(base.GEMINI_API_KEY, "a");
  });

  it("あとから重ねた値は鍵でも残る", () => {
    const env = { ...safeEnv({ LLM_API_KEY: "x" }), LLM_API_KEY: "explicit" };
    assert.equal(env.LLM_API_KEY, "explicit");
  });
});

describe("呼び出し元は鍵を子に渡さない", () => {
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    LLM_API_KEY: process.env.LLM_API_KEY,
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  it("bash ツール", async () => {
    process.env.GEMINI_API_KEY = "fake-gemini";
    process.env.LLM_API_KEY = "fake-llm";
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "hma-safe-env-"));
      const tools = createFileTools(dir);
      const out = await tools.execute("bash", {
        command: 'echo "[$GEMINI_API_KEY][$LLM_API_KEY]"',
      });
      assert.equal(out, "[][]");
    } finally {
      restore();
    }
  });

  it("フック", async () => {
    process.env.GEMINI_API_KEY = "fake-gemini";
    process.env.LLM_API_KEY = "fake-llm";
    try {
      const out = await runHook(
        { command: 'echo "[$GEMINI_API_KEY][$LLM_API_KEY]"' },
        {},
      );
      assert.equal(out.context, "[][]");
    } finally {
      restore();
    }
  });
});
