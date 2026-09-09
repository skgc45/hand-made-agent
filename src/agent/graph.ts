import type OpenAI from "openai";

export type Fact = {
  subject: string;
  predicate: string;
  object: string;
  /** その事実が成り立ち始めた時点。会話から読めなければ空 */
  validFrom: string;
  /** 覆された時刻。空なら現在も有効 */
  validTo: string;
  /** システムがそれを知った時刻。validFrom とは別軸（これが bi-temporal） */
  recordedAt: string;
};

const INSTRUCTION = `会話ログから事実を抽出して JSON で返す。

{"facts":[{"subject":"...","predicate":"...","object":"...","validFrom":"..."}]}

- 判明した数値・ファイル名・実行したコマンドとその結果・結論を落とさない。
- subject は何についての事実か、predicate は属性名、object は値。
- 数値は object にそのまま入れる（"114" のように）。
- 会話から時点が読めるときだけ validFrom に入れる。読めなければ空文字。
- 推測を書かない。ログに出ていないことは抽出しない。
- 同じ subject と predicate の組は1つにまとめる。`;

export type ExtractResult = {
  facts: Fact[];
  /** 応答を配列として読めなかった。抽出漏れを黙って落とさないための印 */
  unparsed: boolean;
  promptTokens: number;
  completionTokens: number;
};

/**
 * モデルは指定した {"facts":[...]} を守らず、裸の配列を返してくることがある。
 * 形の揺れを黙って捨てると、グラフが空のまま気づけない。
 */
function findArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.facts)) return record.facts;
  return Object.values(record).find(Array.isArray) as unknown[] | undefined;
}

function parseFacts(text: string, recordedAt: string): Fact[] | undefined {
  // モデルが ```json で囲んでくることがある
  const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  const raw = findArray(parsed);
  if (!raw) return undefined;

  return raw.flatMap((item): Fact[] => {
    const f = item as Record<string, unknown>;
    const subject = String(f.subject ?? "").trim();
    const predicate = String(f.predicate ?? "").trim();
    const object = String(f.object ?? "").trim();
    if (!subject || !predicate || !object) return [];
    return [
      {
        subject,
        predicate,
        object,
        validFrom: String(f.validFrom ?? "").trim(),
        validTo: "",
        recordedAt,
      },
    ];
  });
}

export async function extractFacts(
  client: OpenAI,
  model: string,
  dropped: OpenAI.ChatCompletionMessageParam[],
  render: (m: OpenAI.ChatCompletionMessageParam) => string,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const transcript = dropped
    .map((m) => `[${m.role}] ${render(m)}`)
    .join("\n")
    .slice(0, 20000);

  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: "system", content: INSTRUCTION },
        { role: "user", content: transcript },
      ],
      response_format: { type: "json_object" },
    },
    { signal },
  );

  const parsed = parseFacts(
    response.choices[0].message.content ?? "",
    new Date().toISOString(),
  );

  return {
    facts: parsed ?? [],
    unparsed: parsed === undefined,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  };
}

/**
 * 同じ subject / predicate に新しい値が来たら、古いほうを消さずに validTo を立てる。
 * 「担当者が A から B に変わった」を上書きではなく履歴として持てる。
 */
export class FactGraph {
  private readonly facts: Fact[] = [];

  apply(incoming: Fact[]): { added: number; superseded: number } {
    let added = 0;
    let superseded = 0;

    for (const fact of incoming) {
      const current = this.facts.find(
        (f) =>
          f.validTo === "" &&
          f.subject === fact.subject &&
          f.predicate === fact.predicate,
      );
      if (current) {
        if (current.object === fact.object) continue;
        current.validTo = fact.recordedAt;
        superseded += 1;
      }
      this.facts.push(fact);
      added += 1;
    }
    return { added, superseded };
  }

  active(): Fact[] {
    return this.facts.filter((f) => f.validTo === "");
  }

  size(): number {
    return this.facts.length;
  }

  /** system プロンプトに畳む形。いまは全件入れる（絞り込みは未実装） */
  render(): string {
    const active = this.active();
    if (active.length === 0) return "";
    return active
      .map(
        (f) =>
          `- ${f.subject} / ${f.predicate}: ${f.object}${f.validFrom ? `（${f.validFrom} 時点）` : ""}`,
      )
      .join("\n");
  }
}
