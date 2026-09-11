import type OpenAI from "openai";

/**
 * system メッセージの組み立て。base のあとに、名前の付いた節を並べる。
 * compaction も事実グラフも messages[0] を作り直すので、文字列連結はここだけにする。
 */
export class SystemPrompt {
  /** 挿入順に並ぶ。同じ見出しを set し直しても位置は動かない */
  private readonly sections = new Map<string, string>();

  constructor(private readonly base: string) {}

  /** 空の本文を渡すと節ごと消える */
  set(heading: string, body: string): void {
    if (body) this.sections.set(heading, body);
    else this.sections.delete(heading);
  }

  render(): string {
    let text = this.base;
    for (const [heading, body] of this.sections) {
      text += `\n\n## ${heading}\n${body}`;
    }
    return text;
  }

  message(): OpenAI.ChatCompletionMessageParam {
    return { role: "system", content: this.render() };
  }
}
