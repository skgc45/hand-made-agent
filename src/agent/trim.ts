import type OpenAI from "openai";

type Messages = OpenAI.ChatCompletionMessageParam[];

export function charCount(messages: Messages): number {
  return messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
}

export function trimNaive(messages: Messages, limitChars: number): Messages {
  const kept = [...messages];
  while (kept.length > 2 && charCount(kept) > limitChars) {
    kept.splice(1, 1);
  }
  return kept;
}

export function splitSafe(
  messages: Messages,
  limitChars: number,
): { kept: Messages; dropped: Messages } {
  const kept = [...messages];
  const dropped: Messages = [];

  while (charCount(kept) > limitChars) {
    const next = kept.findIndex((m, i) => i > 1 && m.role === "user");
    if (next === -1) break;
    dropped.push(...kept.splice(1, next - 1));
  }
  return { kept, dropped };
}

export function trimSafe(messages: Messages, limitChars: number): Messages {
  return splitSafe(messages, limitChars).kept;
}
