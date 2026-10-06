import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  createSkillTools,
  loadSkills,
  type Skill,
  skillHook,
  skillsSection,
} from "../src/skills/index.js";

const root = mkdtempSync(path.join(os.tmpdir(), "hma-skills-"));
after(() => rmSync(root, { recursive: true, force: true }));

function put(base: string, name: string, front: string, body = "本文") {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}\n---\n${body}\n`);
}

const manual: Skill = {
  name: "deploy",
  description: "本番に出す",
  dir: path.join(root, "manual", "deploy"),
  source: "test",
  disableModelInvocation: true,
};
const auto: Skill = {
  name: "lint",
  description: "lint を直す",
  dir: path.join(root, "manual", "lint"),
  source: "test",
  disableModelInvocation: false,
};
put(path.join(root, "manual"), "deploy", "description: 本番に出す", "手順A");
put(path.join(root, "manual"), "lint", "description: lint を直す", "手順B");

const signal = new AbortController().signal;

describe("disable-model-invocation", () => {
  it("system の節に載らない", () => {
    const body = skillsSection([manual, auto])?.body ?? "";
    assert.match(body, /lint/);
    assert.doesNotMatch(body, /deploy/);
    assert.equal(skillsSection([manual]), undefined);
  });

  it("skill ツールは拒む", async () => {
    const tools = createSkillTools([manual, auto]);
    const result = await tools.execute("skill", { name: "deploy" });
    assert.match(String(result), /^エラー.*モデルからは呼べません/);
    assert.equal(await tools.execute("skill", { name: "lint" }), "手順B");
  });

  it("/skill:名前 で本文に差し替える（引数は末尾）", async () => {
    const hook = skillHook([manual, auto]);
    const out = await hook?.("/skill:deploy 本番へ", signal);
    assert.match(out?.replace ?? "", /手順A[\s\S]*\n\n本番へ$/);
    const plain = await hook?.("/skill:lint", signal);
    assert.match(plain?.replace ?? "", /手順B/);
  });

  it("知らないスキルや普通の入力は展開しない", async () => {
    const hook = skillHook([manual]);
    assert.equal(await hook?.("/skill:nothing", signal), undefined);
    assert.equal(await hook?.("deploy して", signal), undefined);
  });
});

describe("loadSkills", () => {
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  put(path.join(home, ".agents", "skills"), "a", "description: user-agents");
  put(path.join(home, ".agents", "skills"), "b", "description: user-agents");
  put(path.join(home, ".hma", "skills"), "b", "description: user-hma");
  put(path.join(home, ".hma", "skills"), "c", "description: user-hma");
  put(path.join(cwd, ".agents", "skills"), "c", "description: proj-agents");
  put(path.join(cwd, ".agents", "skills"), "d", "description: proj-agents");
  put(path.join(cwd, ".hma", "skills"), "d", "description: proj-hma");
  put(
    path.join(cwd, ".agents", "skills"),
    "m",
    "description: manual\ndisable-model-invocation: true",
  );

  it("フロントマターを解釈し、~/.agents < ~/.hma < .agents < .hma で後勝ち", async () => {
    const prevHome = process.env.HOME;
    const prevCwd = process.cwd();
    process.env.HOME = home;
    process.chdir(cwd);
    try {
      const skills = await loadSkills();
      const by = Object.fromEntries(skills.map((s) => [s.name, s]));
      assert.equal(by.a.description, "user-agents");
      assert.equal(by.a.source, "~/.agents/skills");
      assert.equal(by.b.description, "user-hma");
      assert.equal(by.c.description, "proj-agents");
      assert.equal(by.d.description, "proj-hma");
      assert.equal(by.d.source, ".hma/skills");
      assert.equal(by.m.disableModelInvocation, true);
      assert.equal(by.a.disableModelInvocation, false);
    } finally {
      process.chdir(prevCwd);
      process.env.HOME = prevHome;
    }
  });
});
