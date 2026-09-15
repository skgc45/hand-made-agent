---
name: hma-review
description: PR を出す前に、このリポジトリで作っている hma 自身にブランチの差分をレビューさせる。実装が終わって commit したあと、PR を作る前に使う。
---

# hma に差分をレビューさせる

`hma -p`（非対話モード）で hma を1回だけ回し、`main...HEAD` の差分を読ませて指摘を出させる。
自作エージェントを自分の開発に使うための口。

**hma はメインの turn で直接叩かない。subagent を立てて、その中で走らせる。**
レビューは数十秒〜数分かかるうえ、hma の進捗（ツール呼び出しと usage の行）と生の出力が
そのままメインのコンテキストに積まれる。subagent は background で走り、終わると通知が来る。

## 先に確かめること

- 差分が **commit 済み**であること（`git status` が clean）。`APPROVAL=auto` で走らせるので
  hma は承認なしに bash も write_file も使える。プロンプトで「編集するな」と言うが、**auto である以上は書ける**
- `GEMINI_API_KEY` が `.env` にあること
- **無料枠は 5 RPM。** 1回のレビューで5〜7回叩く。429 で落ちても連続で回し直さない（`loop.ts` にリトライがある）
- 既定の `gemini-3.5-flash-lite` は指摘が浅い。深く見せたいときは `LLM_MODEL` を上のモデルにして回す

## 手順

### 1. 範囲を確認する（メイン側）

```bash
git status --short && git diff main...HEAD --stat
```

ツール結果は 300行 / 15000文字で切られる（`src/harness/files.ts`）。
`--stat` で出たファイル名を控えて、次の subagent プロンプトに1行ずつ並べる。

### 2. subagent を background で立てる

Agent tool を `subagent_type: "general-purpose"` で1つ呼ぶ。呼んだ時点で background に入るので、
**完了を待たず、ポーリングもしない。** 通知が来るまでメイン側は他のことをしてよい。

subagent に渡すプロンプト（`（ファイル1）` などは 1. で控えた実際のパスに置き換える）:

````
/Users/shingo/workspace/hand-made-agent で、hma（このリポジトリで作っているエージェント自身）に
ブランチの差分をレビューさせ、出てきた指摘を検証して報告してください。ファイルは編集しないこと。

1. 次を実行する。stdout が指摘、stderr が進捗:

```bash
cd /Users/shingo/workspace/hand-made-agent
APPROVAL=auto pnpm start --profile coding --workspace . -p - <<'PROMPT'
あなたはコードレビュアーです。**ファイルを編集してはいけません。** 読むだけです。

1. CLAUDE.md と PLAN.md を read_file で読み、このリポジトリの決まりを確認する
2. 次のファイルの差分を読む。**1回の bash で1ファイルだけ**指定する。
   複数を1回の `git diff` にまとめると結果が切られて読めなくなる:
   - `git diff main...HEAD -- （ファイル1）`
   - `git diff main...HEAD -- （ファイル2）`
3. 差分が切られたと出たら、`git diff main...HEAD -- <path> | sed -n '300,600p'` で続きを読む
4. 必要なら read_file で周辺のコードを読む

観点:
- 層の向きを壊していないか（下の層は上の層を知らない。agent は IO も承認も永続化も知らない）
- ツールを足したなら profile の kinds に入っているか。種類の分からないツールを read 扱いしていないか
- beforeToolCall / afterToolCall / beforeUserMessage / append の既存の穴に乗せられたのに、
  新しい仕組みを足していないか
- 権限まわりを触ったなら test/*.test.ts に追加があるか
- README / docs/notes.md に実測を残す必要がある変更か

出力:
- **観点ごとに1行**、`観点 — 確認したファイル — 問題の有無` を書く。読めていない観点は「読めていない」と書く
- そのあと指摘を `file:line — 何が問題か — どう直すか` の1行で並べる
- 要約・感想・褒め言葉は書かない
PROMPT
```

終了コードは `0` 完走 / `1` エラー（429 やモデルの失敗）/ `2` 承認が要って止まった。

2. **hma の指摘をそのまま返さない。** モデルが小さく、読み落としも作り話もする。
   指摘ごとに該当箇所を自分で読んで、事実かどうか確かめる
3. hma が読み飛ばした観点があれば、自分で該当ファイルを読んで埋める
4. 報告は次の形で返す:
   - 採用した指摘を `file:line — 何が問題か — どう直すか` で並べる
   - 落とした指摘は「hma はこう言ったが、実際はこうなので落とした」と1行ずつ
   - hma が叩いたツール回数と累計入力トークン（stderr の usage 行の最後）
````

差分が大きくても、subagent や hma を複数回に分けない。
**1回の run の中で1ファイルずつ読ませる**ほうが 5 RPM に優しい。

### 3. 通知が来たら

**通知が来るまで PR を作らない。** user から「PR を出して」と言われても、レビューが走っている間は
「通知を待ってから出す」と伝えて待つ。待っている間に rebase や最新化を済ませておくのはよい。

subagent の報告はそのままでは user に見えない。**必ず relay する。**

1. 採用された指摘を user に出す
2. 直すなら直して、コミットに含める
3. そのうえで PR を出すか user に聞く（順番は 実装 → レビュー → PR）

## 残っている粗さ

- スレッドが毎回 `.threads/agent.db` に増える（`hma list` で見える）
- 未信頼の `.hma` があると stderr に警告が出る。フック・allow・MCP は無効のまま走る（無害）
- レビューの文面はこの skill にしかない。hma 側の `/review` コマンドは作っていない
