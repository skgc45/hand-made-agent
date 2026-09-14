import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Command, expand } from "../src/commands/index.js";

const commands: Command[] = [
  { name: "review", body: "差分を見る\n\n$ARGUMENTS", source: "test" },
  { name: "step", body: "次のステップに進む", source: "test" },
];

describe("expand", () => {
  it("$ARGUMENTS を引数で置き換える", () => {
    assert.equal(
      expand("/review src/a.ts", commands),
      "差分を見る\n\nsrc/a.ts",
    );
  });

  it("$ARGUMENTS が無ければ末尾に足す", () => {
    assert.equal(
      expand("/step いそぎ", commands),
      "次のステップに進む\n\nいそぎ",
    );
  });

  it("引数が無ければ本文だけ", () => {
    assert.equal(expand("/step", commands), "次のステップに進む");
  });

  it("知らないコマンドは展開しない", () => {
    assert.equal(expand("/unknown", commands), undefined);
  });

  it("コマンドでない入力は展開しない", () => {
    assert.equal(expand("これは / を含むただの文章", commands), undefined);
  });
});
