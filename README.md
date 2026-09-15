# hand-made-agent

フレームワークを使わずに書いた、端末で動くコーディングエージェント。`hma` コマンドで起動する。

- **ファイル操作とコマンド実行** — 読む / 書く / 差分編集 / glob / grep / bash
- **権限ルールで承認を制御** — ツール名だけでなく、コマンドやパス単位で `allow` / `ask` / `deny`
- **サブエージェント** — 調査や作業を隔離して投げる。`background` で待たずに進める
- **スキル / スラッシュコマンド** — 手順を Markdown で外から足す
- **MCP** — 外部のツールサーバを繋ぐ
- **フック** — ツール実行の前後に自分のコマンドを挿す
- **設定ファイル** — チームで共有する層と、手元だけの層を分ける
- **履歴の永続化** — 再起動しても会話が続く。承認待ちのまま落ちても再開できる
- **Web UI / HTTP API** — SSE で同じエージェントをブラウザから使う

OpenAI 互換エンドポイントを叩くので、Gemini / Ollama / Groq を環境変数だけで差し替えられる。

> 実装の経緯と設計判断は [docs/notes.md](docs/notes.md)。
> 既知の穴は [SECURITY.md](SECURITY.md)。

---

## セットアップ

必要なもの:

- **Node.js 24 以上**（`node:sqlite` を使うため）
- **pnpm**
- **[gitleaks](https://github.com/gitleaks/gitleaks)** — `.env` に本物の API キーを置くので、
  コミット前の走査を必須にしている。**入っていないと commit できない**

```bash
brew install gitleaks     # Linux は release から。Go なら go install

git clone https://github.com/skgc45/hand-made-agent
cd hand-made-agent
pnpm install              # pre-commit フックもここで有効になる
```

`hma` コマンドをどこからでも使えるようにする。

```bash
pnpm setup      # 初回だけ。PNPM_HOME を shell に設定する（設定済みなら不要）
pnpm add -g .   # hma が入る
```

> `pnpm setup` が shell の設定を書き換えるのが嫌なら、入れなくてよい。
> リポジトリの中で `pnpm start` / `pnpm serve` を叩けば同じものが動く。

API キーを `.env` に置く。[AI Studio](https://aistudio.google.com/apikey) の無料枠はクレカ不要。

```bash
cp .env.example .env
$EDITOR .env      # GEMINI_API_KEY=...
```

> 無料枠は入力がモデルの学習に使われる規約。**業務のコードやデータを入れないこと。**
> 有料枠か Ollama に切り替えるなら「[モデルを差し替える](#モデルを差し替える)」を見る。

動くか確認する。

```bash
hma code .
> このリポジトリの構成を教えて
```

---

## コマンド

```bash
hma                    # sandbox プロファイルで対話（sandbox/ の中だけ触れる）
hma code               # コーディングエージェント。作業対象は現在のディレクトリ
hma code path/to/proj  # 作業対象を指定
hma serve              # HTTP + SSE で起動（http://localhost:3000）
hma list               # 保存されているスレッド一覧
hma config             # いま効いている設定・権限・フック・スキルを出所つきで出す
hma trust              # .hma のフックと allow を確認して信頼する
hma help
```

共通オプション:

| | |
|---|---|
| `--thread <id>` | スレッドを指定（既定は `cli`） |
| `--new` | 新しいスレッドを立てる |
| `-p <prompt>` | 非対話。1回だけ答えて終わる（`-p -` で stdin から読む）。答えは stdout、進捗は stderr |
| `--profile <name>` | `sandbox` / `coding` |
| `--workspace <path>` | 触ってよいディレクトリ |

**`hma` はどのディレクトリからでも動く。** 実行ファイルと `.env` はインストール元から、
作業対象・`.hma/`・`.threads/` は**実行したディレクトリ**から解決する。
つまりプロジェクトごとに、設定も会話履歴も別々になる。

開発中はリポジトリの中で `pnpm start` / `pnpm serve` のほうが速い（グローバルに入れなくてよい）。
フラグはそのまま渡す（`pnpm start --config`）。**pnpm では `--` を挟まない。**

---

## 対話中の操作

```
> テストが落ちています。node --test で確認して直してください

  → list_files({})
  ← package.json
  → bash({"command":"node --test"})

  bash を実行しようとしています:
  {"command":"node --test"}
  許可する? [y]es / [n]o / [a]lways / [s]ave:
```

| 入力 | 意味 |
|---|---|
| `y` | 今回だけ許可 |
| `n` | 拒否。理由を書くとモデルに伝わる |
| `a` | このセッション中は同じルールを聞かない |
| `s` | 同じルールを `.hma/settings.local.json` に保存して、次回以降も聞かない |

`a` / `s` が提案するルールは、コマンドの先頭部分から作られる（`bash(node --test:*)` など）。
`&&` や `|` で繋いだコマンドには提案が出ない（区間ごとに評価されるため）。

**走っている最中にも入力できる。** Enter で送ると、いまのターンの切れ目でモデルに届く（steering）。
エージェントが止まろうとしたタイミングで届いたものは、会話の続きとして処理される（follow-up）。

`Ctrl+C` は、走っている最中なら**そのターンの中断**、止まっているなら終了。

---

## プロファイルとツール

「何のエージェントか」は**プロファイル**で決まる。system プロンプト・ツール・既定の権限ルールの束。

| プロファイル | 作業対象の既定 | 用途 |
|---|---|---|
| `sandbox` | `sandbox/` | 試し用。同梱の練習プロジェクトを触る |
| `coding` | カレントディレクトリ | 実際のコードを読み書きする |

どちらも同じツールを持つ。違いは system プロンプトと、既定でどれを承認対象にするか。

| ツール | 種類 | 何をするか |
|---|---|---|
| `list_files` | read | ディレクトリの一覧 |
| `read_file` | read | ファイルを読む |
| `glob` | read | `src/**/*.ts` のようなパターンでファイルを探す |
| `grep` | read | 中身を正規表現で検索（最大 200 件） |
| `todo_write` | read | 作業計画を書き出す |
| `skill` | read | スキルの手順を読む（スキルがあるときだけ生える） |
| `explore` | read | 調査サブエージェント |
| `delegate` | execute | 作業サブエージェント |
| `write_file` | edit | 新規作成・全文書き換え |
| `edit_file` | edit | 差分編集。`old_text` が一意でないと弾かれる |
| `bash` | execute | コマンド実行（30秒でタイムアウト） |

この**種類**（read / edit / execute）が、あとで出てくる `plan` / `acceptEdits` モードの効き方を決める。

いくつか仕掛けがある:

- **`edit_file` は `old_text` がファイル内でちょうど1箇所に一致することを要求する。**
  2箇所以上あると「どこを直すつもりか分からない」ので断る。前後の行を足して一意にする
- **読んでいないファイルは書き換えられない。** `read_file` していない既存ファイルへの
  `edit_file` / `write_file` は、権限で許可されていても止まる
- **ツール結果は 300 行 / 15,000 文字で切られる。** 長い出力でコンテキストを潰さないため

### 作業対象（workspace）

ファイル操作ツールは `--workspace` の外に出られない。`..` を混ぜても弾かれる。

**ただしこれはセキュリティ境界ではない。** `bash` は任意のコマンドを実行できるので、
`cat ../../etc/passwd` は通る。外に出させたくないなら権限ルールで `bash` を絞る。

---

## 権限と承認

### 判定の順番

```
deny  →  当たれば必ず止める（auto モードでも止まる）
allow →  当たれば聞かずに実行
ask   →  当たれば聞く
どれにも当たらなければ通す
```

### ルールの書き方

```
bash                      ← ツール名だけ。その道具を全部
bash(pnpm test:*)         ← コマンドの前方一致
bash(git status)          ← 完全一致
read_file(src/**/*.ts)    ← パスの glob
mcp__github__*            ← 末尾 * はツール名の前方一致。サーバ単位で書ける
```

`:*` の前方一致は**語の途中では切らない**。`pnpm test:*` は `pnpm test --watch` に
当たるが、`pnpm tests` には当たらない。

連結コマンド（`&&` `||` `;` `|` 改行）は**区間ごとに切って全部を見る**。
`pnpm test && rm -rf /` は、`rm -rf /` が `allow` に当たらないので通らない。
`$(...)` やバッククォートを含むコマンドは、中身を評価できないので `allow` に一致させない。

### 承認モード

`APPROVAL` 環境変数か、設定ファイルの `approval` で切り替える。

| モード | 挙動 |
|---|---|
| `ask`（既定） | ルールに従って聞く |
| `acceptEdits` | edit 系（`write_file` / `edit_file`）を聞かずに通す |
| `plan` | read 系**以外を全部止める**。調査だけさせたいとき |
| `auto` | `deny` 以外は全部通す。**中身を確認したリポジトリでだけ使う** |

`plan` と `acceptEdits` は専用の判定ではなく、起動時に権限ルールへ展開される。
どう展開されたかは `hma config` で見える。

---

## 設定ファイル

`.hma/settings.json` に書く。3層あって、**下ほど強い**。

| ファイル | 用途 | git |
|---|---|---|
| `~/.hma/settings.json` | 自分の既定。全プロジェクトに効く | — |
| `.hma/settings.json` | プロジェクトの決まり。チームで共有する | 追跡する |
| `.hma/settings.local.json` | 手元だけの上書き。`[s]ave` の保存先 | 無視する |

**環境変数はこれら全部より強い。**一時的な実験は環境変数でやる。

```jsonc
{
  "model": "gemini-3.5-flash-lite",
  "approval": "ask",
  "workspace": ".",
  "profile": "coding",
  "trim": "compact",
  "contextLimit": 100000,

  "permissions": {
    "deny": ["bash(rm -rf:*)", "read_file(.env)"],
    "allow": ["bash(pnpm test:*)", "bash(git status)"],
    "ask": ["bash", "write_file", "edit_file"]
  },

  "hooks": {
    "PostToolUse": [
      { "matcher": "edit_file", "command": "pnpm exec prettier --write $(jq -r .arguments.path)" }
    ]
  },

  "mcpServers": {
    "notes": { "command": "node", "args": ["examples/mcp-notes.js"] }
  }
}
```

`permissions` だけ**マージの仕方が違う**。他のキーは下の層が上書きするが、
`permissions` は3層ぶんが全部足し合わされる（チームの `deny` を手元で消せないように）。

**API キーは設定ファイルから読まない。** 共有される場所に鍵を書く習慣を作らないため、
環境変数（`GEMINI_API_KEY` か `LLM_API_KEY`）だけを見る。

### 設定がどこから来たか見る

```bash
hma config
```

実効値・出所（フラグ / 環境変数 / どのファイル / 既定）・展開後の権限ルール・フック・
MCP サーバ・スキル・スラッシュコマンド・system に載る文脈を全部出す。
**挙動が思ったとおりでないときは、まずこれを見る。**

---

## 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `GEMINI_API_KEY` / `LLM_API_KEY` | — | API キー |
| `LLM_MODEL` | `gemini-3.5-flash-lite` | モデル |
| `LLM_BASE_URL` | Gemini の OpenAI 互換 | エンドポイント |
| `PROFILE` | `sandbox` | `sandbox` / `coding` |
| `WORKSPACE` | `sandbox` | 触ってよいディレクトリ |
| `APPROVAL` | `ask` | `ask` / `acceptEdits` / `plan` / `auto` |
| `TRIM` | `none` | `none` / `naive` / `safe` / `compact` / `graph` |
| `CONTEXT_LIMIT` | `0`（無効） | トリム発動のトークン閾値 |
| `STREAM` | 有効 | `0` で応答が出揃ってから1回で流す |
| `STORE` | `sqlite` | `sqlite` / `file` / `memory` |
| `STORE_PATH` | `.threads/agent.db` | 保存先 |
| `HOST` | `127.0.0.1` | `hma serve` の待ち受け先 |
| `PORT` | `3000` | |
| `TELEMETRY` | `none` | `clickhouse` で計測を流す |
| `TELEMETRY_URL` | `http://hma:hma@localhost:8123/?database=hma` | |

---

## プロジェクトの決まりを渡す — AGENTS.md

カレントディレクトリから上へ辿って `AGENTS.md` を集め、system プロンプトに載せる。
「このリポジトリではこう書く」を毎回説明しなくて済む。

```markdown
# AGENTS.md

- パッケージマネージャは pnpm。npm は使わない
- テストは `pnpm test`。1ファイルだけなら `pnpm test path/to/file`
- コミットメッセージは日本語1行
```

1ファイル 8,000 文字まで（超えると警告して切る）。**毎ターン払う固定費**なので、短く保つ。

> `AGENTS.md` の中身は**信頼の対象にしていない**。リポジトリを clone しただけで
> 権限が緩むことはない（フックや allow ルールとは扱いが違う）。

---

## スキル

手順書を Markdown で置くと、エージェントが必要なときだけ読みに来る。

```
.hma/skills/
  release/
    SKILL.md
    checklist.md
```

```markdown
---
name: release
description: このリポジトリのリリース手順。バージョンを上げるとき、タグを打つときに読む。
---

# リリース手順

1. `pnpm test` が通ることを確認する
2. `pnpm version minor` でバージョンを上げる
3. ...
```

`~/.hma/skills/` にも置ける（同じ名前ならプロジェクト側が勝つ）。

**system に載るのは `name` と `description` だけ。** 本文は `skill` ツールで取りに行く。
スキルが10個あっても、毎ターン払うのは説明文10行ぶんで済む。

`description` には**いつ読むべきか**を書く。これだけを見て選ぶので、
「リリース手順」より「バージョンを上げるとき、タグを打つときに読む」のほうが効く。

同じディレクトリに置いた他のファイルも `skill` ツールで読める（`SKILL.md` から参照する）。
スキルのディレクトリの外は読めない。

---

## スラッシュコマンド

よく打つ指示を Markdown にして、`/名前` で呼ぶ。

```
.hma/commands/review.md
```

```markdown
変更内容をレビューする。

1. `git diff` で差分を見る
2. 各変更について、壊れうるケースを1つずつ挙げる
3. テストが要るものを指摘する

$ARGUMENTS
```

```
> /review src/agent/loop.ts
```

`$ARGUMENTS` があればそこへ、無ければ本文の末尾に引数が入る。
**入力を本文に差し替えるだけ**なので、履歴に残るのは展開後の文章。

知らない `/xxx` は展開せずそのまま流す（ただの文章かもしれないので）。

---

## サブエージェント

調査や作業を別のエージェントに投げる。**往復が親の履歴に入らない**のが効き目で、
速くするための仕組みではない。

| ツール | 渡す道具 | ターン上限 |
|---|---|---|
| `explore` | read 系だけ | 12 |
| `delegate` | 親と同じ全部 | 20 |

```
> 権限の判定がどこでどう実装されているか調べて

  → explore({"prompt":"権限の判定ロジックの実装箇所を調べて..."})
  ┌ explore: 権限の判定ロジックの実装箇所を調べて...
  │ explore: glob
  │ explore: read_file
  │ explore: grep
  └ explore: 6 ターン / ツール 9回 / 入力 18420
  ← src/permission/index.ts の createPermissions() が判定の中心です。...
```

親の履歴に入るのは**最後の報告だけ**。途中で読んだファイルの中身は入らないので、
長い作業を続けられる。

### background

`background: true` を付けると、結果を待たずに親が先へ進む。

```
  → explore({"prompt":"...", "background":true})
  ← job-1 を起動しました（explore）。結果は終わり次第このあとの会話に届きます。
  → read_file({"path":"src/cli.ts"})        ← 親は待たずに次の仕事
  ...
  ✓ job-1 の結果が届きました                 ← 終わり次第ここに合流する
```

完了通知は steering / follow-up キューに合流する。親が止まろうとしたときには、
走っている子を最大60秒待つ。間に合わなければ次のターンの頭で届く。

### 制限

- **子は承認を求められない。** 承認が要るツールを呼ぶと、その呼び出しだけが止まり、
  「親が自分で実行してください」という結果が返る
- **子は子を呼べない。**
- **ターン上限に達しても殺さない。** 道具だけ取り上げて、そこまでで報告させる
  （殺すと使ったトークンが丸損になるため）
- **background の子は、親のプロセスが落ちると消える。**

---

## MCP

外部のツールサーバを繋ぐ。stdio 接続の `tools` のみに対応している。

```jsonc
{
  "mcpServers": {
    "fs": {
      "command": "pnpm",
      "args": ["dlx", "@modelcontextprotocol/server-filesystem@latest", "./src"]
    }
  }
}
```

ツールは `mcp__<サーバ名>__<ツール名>` という名前で生える。権限ルールもこの名前で書く。

```jsonc
{ "permissions": { "allow": ["mcp__fs__read_file"], "ask": ["mcp__fs__*"] } }
```

**`readOnlyHint` を申告しないツールは、既定で承認が要る。** 種類の分からないものを
read 扱いしない（止まる側へ倒す）方針。`allow` を書けば外せる。

`hma config` に、どのサーバから何個ツールが生えたかが出る。

> **`workspace` の閉じ込めは MCP に効かない。** サーバは自分のルールで動くので、
> `/` を渡すサーバを書けばその通りに見える。効かせられるのは権限ルールだけ。

制限: stdio のみ / `tools` のみ（`resources` / `prompts` / `sampling` は未対応）/
起動時に1回 `tools/list` を引くだけ / 落ちたサーバの再起動はしない。

---

## フック

ツール実行の前後などに、自分のコマンドを挿す。TypeScript を書かずに挙動を変えられる。

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash(git push:*)", "command": "echo '手で push して' >&2; exit 2" }
    ],
    "PostToolUse": [
      { "matcher": "edit_file", "command": "pnpm exec prettier --write $(jq -r .arguments.path)" }
    ],
    "SessionStart": [
      { "command": "git log --oneline -5" }
    ]
  }
}
```

| イベント | いつ | 何ができるか |
|---|---|---|
| `SessionStart` | 起動時に1回 | 標準出力が system プロンプトに載る |
| `UserPromptSubmit` | 入力を履歴に積む前 | 止める / 文脈を足す |
| `PreToolUse` | ツール実行の直前 | 止める / 承認を飛ばして通す |
| `PostToolUse` | ツール結果が出たあと | 結果に注記を足す |
| `Stop` | 止まろうとしたとき（1 run に1回） | 続けさせる文言を返す |

**契約は終了コードで決まる。**

| 終了コード | 意味 |
|---|---|
| `0` | 通す。標準出力があればモデルに渡る |
| `2` | 止める。標準エラーが理由としてモデルに渡る |
| その他 | 警告を出して通す（フックの失敗でエージェントを止めない） |

標準出力が `{...}` なら JSON として読む（`decision` / `reason` / `additionalContext`）。
そうでなければ、そのまま文脈として渡す。

フックの**標準入力に JSON が届く**。

```jsonc
// PreToolUse
{ "event": "PreToolUse", "cwd": "...", "toolCallId": "...", "tool": "bash", "arguments": { "command": "pnpm test" } }
// PostToolUse — 上に加えて "result": "ツールの出力"
// UserPromptSubmit — { "event": "...", "cwd": "...", "prompt": "ユーザーの入力" }
```

`matcher` は権限ルールと同じ書式。省略すると全ツールに当たる。既定のタイムアウトは30秒
（`"timeout": 60` で変える）。

**フックは権限ルールより先に見る。** フックの `allow` は承認を飛ばし、`block` は承認を待たずに止める。

---

## 信頼 — `hma trust`

`.hma/settings.json` には**任意のコマンドが書ける**（フックと MCP サーバ）。
clone しただけのリポジトリのコマンドが、黙って自分の権限で走るのは困る。

そこで、**緩める方向の設定**（フック・`allow` ルール・MCP サーバ）は初回に中身を見せて確認する。

```
$ hma code some-cloned-repo

このディレクトリの .hma に、あなたの権限で動くものが入っています:
  フック  PostToolUse  edit_file  pnpm exec prettier --write ...
  allow   bash(pnpm test:*)
  MCP     fs  pnpm dlx @modelcontextprotocol/server-filesystem ./

実行はあなた自身の権限で、承認を通らずに行われます（環境変数も見えます）。
信頼しますか? [y]es / [n]o:
```

- 信頼しない場合、**締める方向（`deny` / `ask`）だけが残る。** フックは走らず、MCP サーバも起動しない
- 信頼は中身の指紋で覚える（`~/.hma/trust.json`）。**設定が変わればもう一度聞く**
- `~/.hma`（自分で書いたもの）は常に効く

---

## Web UI / HTTP API

```bash
hma serve                  # http://localhost:3000
cd web && pnpm dev         # CopilotKit 版（http://localhost:5173、上のサーバーが必要）
```

同梱のフロントは素の JS 1ファイル（`public/index.html`）。
ストリーミング・ツール呼び出しの表示・承認ボタンが付いている。

> ### ⚠️ `hma serve` は 127.0.0.1 にだけ待ち受ける
>
> このサーバーには認証が無い。そして承認はクライアントが返す形（`resume`）なので、
> 繋いだ側が自分で承認できてしまう。`bash` がある以上、外に開けば無認証の
> リモートコード実行になる。`HOST=0.0.0.0` で変えられるが、
> **前段に認証を置かずにやらないこと。**

ブラウザ経由で他サイトから叩かれないように、`POST /` は次を満たすときだけ通す。

| 見るもの | 弾くもの |
|---|---|
| `Content-Type: application/json` | preflight を回避する単純リクエストでの CSRF |
| `Origin` があればループバック由来のみ | 他サイトの JS からの CSRF |
| `Host` がループバック（ループバックに待ち受けているときだけ） | DNS リバインディング |

ポートは見ない（`web/` の Vite プロキシが 5173 の `Origin` を転送してくるため）。
`HOST` を明示的に外へ開いた場合、`Host` の判定は諦める（前段で守る前提）。
リクエストボディは 1MB まで。

### API

イベントは [AG-UI](https://docs.ag-ui.com/) 形式の SSE で流れる。

```bash
curl -N http://localhost:3000/ \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"demo","message":"sandbox に何がある?"}'
```

| | |
|---|---|
| `POST /` | 実行。`{threadId, message}`。実行中のスレッドへ送ると割り込み（steering）になる |
| `GET /threads` | スレッド一覧 |
| `GET /` | 同梱のフロントエンド |

承認が要るツールに当たると、run が `RUN_FINISHED` の `outcome: interrupt` で終わる。
承認を返して再開する:

```jsonc
{
  "threadId": "demo",
  "resume": [{ "interruptId": "...", "status": "resolved", "payload": { "approved": true } }]
}
```

`payload` に `{"rule": "bash(pnpm test:*)"}` を足すと「常に許可」、
`{"save": true}` も足すと設定ファイルに保存される。

---

## 履歴

会話はスレッド単位で保存される。既定は SQLite（`.threads/agent.db`）。

```bash
hma list                    # 一覧。承認待ちのものも分かる
hma --thread review         # 名前を付けて使い分ける
hma --new                   # 新しく始める
```

**保存は追記式で、ツールを実行する前に印を残す。** そのため:

- 承認待ちのまま終了しても、次に起動すると**同じ承認から再開する**
- 実行中に落ちたツールは、次の起動時に「実行された可能性がある」と明示される
  （結果が残っていないだけで、副作用は出ているかもしれないため）

`STORE=file` で JSON 追記、`STORE=memory` で保存しない。

---

## コンテキストが溢れるとき

長い会話でトークンが積み上がったときの処理を選べる。`CONTEXT_LIMIT` を超えると発動する。

| `TRIM` | 挙動 |
|---|---|
| `none`（既定） | 何もしない |
| `naive` | 古いメッセージから捨てる。**ツール呼び出しの対で壊れることがある** |
| `safe` | 対を壊さない位置で捨てる |
| `compact` | 捨てる代わりに LLM に要約させて畳む |
| `graph` | 事実を抽出して構造で持つ（実験。`compact` に負けた） |

```bash
CONTEXT_LIMIT=100000 TRIM=compact hma code .
```

実用上は `compact` を選んでおけばよい。それぞれの実測は [docs/notes.md](docs/notes.md) にある。

---

## モデルを差し替える

OpenAI 互換エンドポイントを叩いているので、環境変数だけで変わる。コードは触らない。

```bash
# Gemini（既定）
GEMINI_API_KEY=...

# Ollama（ローカル）
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=dummy
LLM_MODEL=qwen3:30b

# Groq
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_...
LLM_MODEL=llama-3.3-70b-versatile
```

> **Gemini の無料枠は 5 RPM。** 1問で5〜6回叩くのですぐ枯れる。
> 429 は `retry in Xs` をパースして自動で待つが、実用するなら有料枠か Ollama を勧める。
> 小さいローカルモデルは tool calling が崩れやすい。

---

## 計測する

トークン・ツール呼び出し・権限判定を ClickHouse に流せる。

```bash
docker compose up -d
TELEMETRY=clickhouse hma code .
```

全部 `agent_events` テーブルに入る。`name` 列が出来事の種類（`usage` / `gate` / `compact` / `subagent` …）。

```sql
-- スレッドごとのトークンと所要時間
SELECT thread_id, any(model) AS model,
  countIf(name='usage')  AS calls,
  sum(prompt_tokens)     AS in_tok,
  sum(completion_tokens) AS out_tok
FROM agent_events GROUP BY thread_id ORDER BY in_tok DESC

-- 承認がどう判定されたか（run = 聞かずに実行 / ask = 聞いた / block = 止めた）
SELECT tool, JSONExtractString(payload, 'decision') AS decision, count()
FROM agent_events WHERE name='gate' GROUP BY tool, decision
```

`FORMAT PrettyCompactMonoBlock` を末尾に足すと表で返る。クエリ例は [docs/notes.md](docs/notes.md) に。

---

## 開発

```
src/agent/      Agent 本体。AG-UI イベントを yield するだけで IO を知らない
src/session/    threadId ↔ Agent。復元と保存
src/transport/  stdio / http。入出力だけ
src/store/      sqlite / file / memory
src/profile/    何のエージェントか（system / ツール / 既定の権限）
src/harness/    ツール実行に挿すもの（承認・read-before-edit・外部フック）
src/permission/ ルールの構文と判定
src/settings/   .hma を重ねて読む / 信頼
src/skills/     スキル      src/commands/  スラッシュコマンド
src/mcp/        MCP クライアント（自前実装）
```

下の層は上の層を知らない。詳しい設計は [docs/notes.md](docs/notes.md)。

```bash
pnpm lint          # Biome（フォーマット + lint）。--write なら pnpm lint:fix
pnpm typecheck     # tsc --noEmit
pnpm test          # node:test。権限判定とコマンド展開の単体テスト
```

同梱の `sandbox/practice/` は、わざとバグを入れた練習用プロジェクト（8件中2件落ちる）。
エージェントに直させて `git diff` で結果を見られる。

```bash
cd sandbox/practice && node --test     # 2件落ちることを確認
cd ../.. && hma code sandbox/practice
> テストが落ちています。node --test で確認して直してください
```

### コミット前に鍵を止める

`pnpm install` が `core.hooksPath` を `.githooks` に向けるので、`git commit` のたびに
staged の差分が gitleaks で走査される。秘密情報が見つかればコミットを中止する
（誤検出なら `--no-verify`）。

**gitleaks が入っていない場合もコミットを中止する。** 走査を黙って飛ばすと、
入っているつもりで素通りする事故が起きるため。CI でも履歴全体を毎回走査している。

### CI

| ワークフロー | 内容 |
|---|---|
| `ci` | `pnpm lint` / `pnpm typecheck` / `pnpm test` |
| `security` | gitleaks（履歴全体）/ `pnpm audit` / CodeQL / dependency-review。毎週も走る |

依存の更新は [Renovate](https://docs.renovatebot.com/)（`renovate.json`）。毎週月曜の早朝にまとめて PR が立つ。
脆弱性由来の更新だけは時間帯を問わず、`security` ラベル付きで来る。
GitHub Actions はダイジェスト（SHA）で固定する。PR のタイトルは Conventional Commits。

**minor / patch は CI が通れば自動でマージされる。** major は必ず人が見る。

`main` へは直接 push できない（管理者も含む）。変更は必ず PR を通し、
`check` / `secrets` / `audit` / `codeql` / `deps` が全部通ってからマージする。
マージ方法はマージコミットのみ（squash と rebase は禁止）。force push とブランチ削除も禁止。
レビューの承認は必須にしていない。必須にすると Renovate が自分の PR をマージできなくなるため。

---

## 制限

- **`bash` は任意のコマンドを実行する。** 承認ゲートは操作性のためのもので、防御ではない
- **`workspace` はセキュリティ境界ではない。** `bash` からも MCP からも外に出られる
- **並列ツール実行のイベントは完了順に出ない。** 実行は同時（最大4件）だが、結果は出揃ってから元の順に出る
- **設定の再読み込みをしない。** 起動時に1回だけ読む

全部は [SECURITY.md](SECURITY.md) と [PLAN.md](PLAN.md) に。

---

## ライセンス

MIT。詳細は [LICENSE](LICENSE)。

**いまは個人開発で使えるところを目指している途中で、まだ塞いでいない穴がある。**
既知のものは [SECURITY.md](SECURITY.md) に一覧してある。
