import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import type { PromptSection } from "../agent/prompt.js";
import type { Toolset } from "../agent/toolset.js";
import type { Profile } from "../profile/index.js";

/** 本文の上限。スキルは「必要なときに読む」ものなので、AGENTS.md より緩くていい */
const MAX_CHARS = 20_000;
const FILE = "SKILL.md";
const HEADING = "使えるスキル";

export type Skill = {
  name: string;
  description: string;
  dir: string;
  /** どのディレクトリから来たか。hma config で出す */
  source: string;
};

/** --- で挟まれた name / description だけ読む。YAML パーサは持たない */
function frontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { fields: {}, body: text };

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const found = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
    if (found) fields[found[1]] = found[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fields, body: text.slice(match[0].length) };
}

async function readDir(dir: string, source: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const name of entries) {
    const file = path.join(dir, name, FILE);
    let text: string;
    try {
      text = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }
    const { fields } = frontmatter(text);
    if (!fields.description) {
      console.error(
        `\x1b[33m${file} に description がありません。飛ばします\x1b[0m`,
      );
      continue;
    }
    skills.push({
      name: fields.name || name,
      description: fields.description,
      dir: path.join(dir, name),
      source,
    });
  }
  return skills;
}

/** ~/.hma < .hma の順。同じ名前ならプロジェクト側が勝つ */
export async function loadSkills(): Promise<Skill[]> {
  const found = [
    ...(await readDir(
      path.join(os.homedir(), ".hma", "skills"),
      "~/.hma/skills",
    )),
    ...(await readDir(path.resolve(".hma", "skills"), ".hma/skills")),
  ];

  const byName = new Map<string, Skill>();
  for (const skill of found) byName.set(skill.name, skill);
  return [...byName.values()];
}

/**
 * system に載せるのは名前と説明だけ。本文は skill ツールで取りに行かせる。
 * 全文を載せると、使わないスキルのぶんまで毎ターン払うことになる
 */
export function skillsSection(skills: Skill[]): PromptSection | undefined {
  if (skills.length === 0) return undefined;
  return {
    heading: HEADING,
    body: [
      "作業に当てはまるものがあれば、skill ツールで手順を読んでから進めること。",
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    ].join("\n"),
  };
}

export function createSkillTools(skills: Skill[]): Toolset {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  const tools: OpenAI.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "skill",
        description:
          "スキルの手順を読む。system に名前と説明だけ載っているものの本文を取りに行く。file を指定すると、そのスキルのディレクトリ内のファイルを読む。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "スキルの名前" },
            file: {
              type: "string",
              description:
                "スキルのディレクトリからの相対パス（省略時は SKILL.md）",
            },
          },
          required: ["name"],
        },
      },
    },
  ];

  return {
    tools,
    async execute(_tool, input) {
      const { name, file } = (input ?? {}) as { name?: string; file?: string };
      const skill = name ? byName.get(name) : undefined;
      if (!skill) {
        return `エラー: ${name} というスキルはありません（${[...byName.keys()].join(" / ") || "なし"}）`;
      }

      // スキルのディレクトリの外は読ませない。workspace と同じ閉じ込め方
      const target = path.resolve(skill.dir, file ?? FILE);
      if (target !== skill.dir && !target.startsWith(skill.dir + path.sep)) {
        return `エラー: スキルのディレクトリの外は読めません: ${file}`;
      }

      let text: string;
      try {
        text = await fs.readFile(target, "utf-8");
      } catch {
        return `エラー: ${file ?? FILE} を読めません`;
      }
      const body = (file ? text : frontmatter(text).body).trim();
      const capped =
        body.length > MAX_CHARS
          ? `${body.slice(0, MAX_CHARS)}\n（長すぎるので切りました）`
          : body;

      const others = (await fs.readdir(skill.dir)).filter((n) => n !== FILE);
      return others.length > 0 && !file
        ? `${capped}\n\n---\n同じディレクトリのファイル: ${others.join(" / ")}（skill の file で読める）`
        : capped;
    },
  };
}

/** プロファイルに skill ツールを足す。副作用が無いので read 扱い */
export function withSkills(profile: Profile, skills: Skill[]): Profile {
  if (skills.length === 0) return profile;
  const sub = createSkillTools(skills);

  return {
    ...profile,
    kinds: { ...profile.kinds, skill: "read" },
    toolset: {
      tools: [...profile.toolset.tools, ...sub.tools],
      drain: profile.toolset.drain,
      execute: (name, input, signal) =>
        name === "skill"
          ? sub.execute(name, input, signal)
          : profile.toolset.execute(name, input, signal),
    },
  };
}
