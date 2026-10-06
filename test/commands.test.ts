import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type Command,
  expand,
  loadCommands,
  splitArgs,
} from "../src/commands/index.js";

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

  it("クォートで空白を含む引数を1つにする", () => {
    const cmds: Command[] = [
      { name: "p", body: "[$1][$2]", positional: true, source: "test" },
    ];
    assert.equal(expand(`/p "a b" 'c d'`, cmds), "[a b][c d]");
  });

  it("未指定の $2 は空", () => {
    const cmds: Command[] = [
      { name: "p", body: "[$1][$2]", positional: true, source: "test" },
    ];
    assert.equal(expand("/p x", cmds), "[x][]");
  });

  it("既定値つきの位置引数は無いときだけ既定を使う", () => {
    const cmds: Command[] = [
      { name: "p", body: `mode=\${1:-fast}`, positional: true, source: "test" },
    ];
    assert.equal(expand("/p", cmds), "mode=fast");
    assert.equal(expand("/p slow", cmds), "mode=slow");
  });

  it("$@ は区切った全引数を空白で繋ぐ", () => {
    const cmds: Command[] = [
      { name: "p", body: "all: $@", positional: true, source: "test" },
    ];
    assert.equal(expand(`/p a "b c" d`, cmds), "all: a b c d");
  });

  it("$ARGUMENTS は生の文字列のまま、位置引数と共存できる", () => {
    const cmds: Command[] = [
      { name: "p", body: "$1 / $ARGUMENTS", positional: true, source: "test" },
    ];
    assert.equal(expand(`/p "a b" c`, cmds), 'a b / "a b" c');
  });

  it("位置引数があるときは末尾に足さない", () => {
    const cmds: Command[] = [
      { name: "p", body: "対象: $1", positional: true, source: "test" },
    ];
    assert.equal(expand("/p a b", cmds), "対象: a");
  });

  it("引数の中の $1 は再展開しない", () => {
    const cmds: Command[] = [
      { name: "p", body: "$1 $2", positional: true, source: "test" },
    ];
    assert.equal(expand("/p $2 x", cmds), "$2 x");
  });

  it("positional でないコマンドの $1 / $@ は置換せず、引数は末尾に足す", () => {
    const cmds: Command[] = [
      {
        name: "col",
        body: "awk '{print $1}' で列を出す。差分を見る $@",
        source: "test",
      },
    ];
    assert.equal(
      expand("/col a.txt", cmds),
      "awk '{print $1}' で列を出す。差分を見る $@\n\na.txt",
    );
  });
});

describe("splitArgs", () => {
  it("エスケープと空のクォートを扱う", () => {
    assert.deepEqual(splitArgs(String.raw`a\ b "c\"d" ""`), ["a b", 'c"d', ""]);
  });

  it("語の途中のアポストロフィはクォートにしない", () => {
    assert.deepEqual(splitArgs("don't touch it"), ["don't", "touch", "it"]);
  });

  it("クォートの外の \\ は次が特殊文字のときだけエスケープ", () => {
    assert.deepEqual(splitArgs(String.raw`\d+ C:\src\a`), [
      "\\d+",
      "C:\\src\\a",
    ]);
  });
});

describe("loadCommands", () => {
  async function load(files: Record<string, string>): Promise<Command[]> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hma-cmd-"));
    await fs.mkdir(path.join(root, ".hma", "commands"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await fs.writeFile(path.join(root, ".hma", "commands", name), text);
    }
    const cwd = process.cwd();
    const home = process.env.HOME;
    process.env.HOME = path.join(root, "home");
    process.chdir(root);
    try {
      return await loadCommands();
    } finally {
      process.chdir(cwd);
      process.env.HOME = home;
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("フロントマターを剥がし、argument-hint と positional を読む", async () => {
    const [command] = await load({
      "a.md":
        "---\narguments: positional\nargument-hint: <file>\n---\n$1 を見る\n",
    });
    assert.equal(command.body, "$1 を見る");
    assert.equal(command.argumentHint, "<file>");
    assert.equal(command.positional, true);
    assert.equal(expand("/a x.ts", [command]), "x.ts を見る");
  });

  it("フロントマターの無い既存コマンドは $1 を置換せず引数を末尾に足す", async () => {
    const [command] = await load({
      "col.md": "awk '{print $1}' で列を出す。差分を見る",
    });
    assert.equal(command.positional, false);
    assert.equal(
      expand("/col a.txt", [command]),
      "awk '{print $1}' で列を出す。差分を見る\n\na.txt",
    );
  });

  it("フロントマターだけで本文が空のコマンドは登録しない", async () => {
    assert.deepEqual(
      await load({ "e.md": "---\nargument-hint: x\n---\n" }),
      [],
    );
  });
});
