# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリの性質

フレームワークを使わずにエージェントを手で作る**練習用リポジトリ**。「素朴に実装すると何が壊れるか」を
実際に踏んで、pi-agent-core / Mastra / LangGraph が何を代行しているかを理解するのが狙い。

**ただし到達点は「個人開発で常用できるエージェント」。** 教材として穴を残している状態は途中経過であって、
恒久的な前提ではない。粗さや穴を見つけたら「教材なので意図的」で説明を終わらせず、
**実用に向けて直す価値があるかを併せて判断して提案すること**。特にローカル前提のつもりが外に開いている類は、
教材性と無関係に直す対象。

このため、**進め方そのものが制約になっている**（`PLAN.md` と `.hma/commands/step.md` に明文化されている）:

- 先に正解を実装しない。素朴版で壊してから対策を入れる
- 各ステップは「実測を README に残すまで」が1ステップ。同じ入力で前後を取り、数字を丸めず、失敗した試行も残す
- 実装したらコミットせずに差分の要点を出してレビューを待つ。コミットは1関心事、メッセージは日本語1行 + なぜ / 実測 / あえてやらなかったこと
- 既に「入れないと決めた」ものがある（設定の再読み込み、`todo_write` の表示口など）。`PLAN.md` の穴の表を先に見ること

`README.md` は使い方のドキュメント。**設計の経緯と実測は `docs/notes.md`**（ステップ1〜17 の「理解すること」）。
次に何をやるかは `PLAN.md`（ステップ18: 並列ツール実行 / 19: プロンプトインジェクションの実測 / 20: eval ハーネス）。

## コマンド

```bash
pnpm start                # sandbox プロファイルで対話（CLI）
pnpm serve                # HTTP + SSE（自前フロント: http://localhost:3000）
pnpm lint                 # Biome。lint:fix で自動修正
pnpm typecheck            # tsc --noEmit
pnpm test                 # node:test（test/*.test.ts）
cd web && pnpm dev        # CopilotKit 版フロント（http://localhost:5173、serve が別に必要）
docker compose up -d      # ClickHouse（TELEMETRY=clickhouse のとき）
```

**パッケージマネージャは pnpm。** `pnpm setup && pnpm add -g .` で `hma` が入る
（`pnpm link --global` は pnpm 10 以降で廃止）。`hma` はどのディレクトリからでも動く（tsx と `.env` はインストール元から、
作業対象と `.threads/` は実行したディレクトリから解決する）。フラグは `--` を挟まず渡す（`pnpm start --config`）。

```bash
hma / hma code [path] / hma serve / hma list / hma config / hma trust
hma --thread <id> --new --profile <name> --workspace <path>
```

**`hma config` が最初に打つべきコマンド。** 効いている設定・権限ルール・フック・MCP サーバ・スキル・
スラッシュコマンド・system に載る文脈を、それぞれの出所つきで出す。挙動が分からないときはここを見る。

テストは `test/*.test.ts`（権限判定とコマンド展開）。**権限まわりを触ったら必ず追加すること。**
統合的な動作確認は `sandbox/practice`（わざとバグを入れた買い物カゴ。8件中2件落ちる）を
エージェントに直させて `git diff` で見る。`.gitignore` は `sandbox/*` を除外したまま `!sandbox/practice/` で
ここだけ追跡しているので、`git checkout` で何度でもやり直せる。

```bash
cd sandbox/practice && node --test
WORKSPACE=sandbox/practice APPROVAL=auto pnpm start
```

**gitleaks は必須。** `pnpm install` が `core.hooksPath` を `.githooks` に向けるので、未インストールだと commit が中止される。CI でも履歴全体を走査している。

主要な環境変数（README の表が正）: `GEMINI_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL` / `PROFILE` /
`WORKSPACE` / `APPROVAL`（`ask` `auto` `acceptEdits` `plan`）/ `TRIM`（`none` `naive` `safe` `compact` `graph`）/
`CONTEXT_LIMIT` / `STORE` / `TELEMETRY` / `STREAM` / `PORT`。
**Gemini 無料枠は 5 RPM。** 1問で5〜6回叩くのですぐ枯れる（`loop.ts` の `callModel()` に 429 リトライあり）。

## 構成

4層。**下の層は上の層を知らない。**

```
agent/     Agent。AG-UI イベントを yield するだけ。IO を一切知らない
  ↑
session/   threadId ↔ Agent。store から復元し、run のたびに保存する
  ↑    ↑
transport/ store/     stdio / http、sqlite / file / memory
```

`profile/` と `harness/` はこの縦の流れと**直交**する。エントリ（`src/cli.ts` / `src/serve.ts`）が
両方を組み立てて `Sessions` に渡す。組み立ての順序はこの2ファイルを読むのが一番早い。

### 押さえるべき不変条件

- **`src/agent/loop.ts` の `Agent.run()` が本体**（952行）。async generator で AG-UI イベントを yield する。
  IO も承認も永続化も知らず、`beforeToolCall` / `afterToolCall` / `beforeUserMessage` / `append` という
  穴が開いているだけ。**機能を足すときは、まずこの既存の穴に乗せられないか探す**（`PLAN.md` の作法）
- **承認の2モードは transport の制約そのもの。** `Transport.approve?` があれば（stdio）ループの中で `await`、
  無ければ（http）AG-UI の Interrupt で run を終える。Agent は「誰の都合か」を知らない
- **保存は `Sessions#run()` の `finally`。** transport は保存を忘れられない。クライアントが切断して
  generator が捨てられても保存される
- **Profile はデコレータで積む。** `withSubagents(withMcp(withSkills(createProfile(...))))`。
  それぞれが `toolset` / `kinds` / `permissions` を足して新しい Profile を返す
- **権限は `deny > allow > ask`、どれにも当たらなければ通す。** `APPROVAL` のモードは専用の判定を足さず、
  `modeRules()` がルールに展開する（`plan` は read 以外を deny、`acceptEdits` は edit を allow）。
  どのツールが何をするかを知っているのは Profile の `kinds` だけ
- **種類の分からないツールは read 扱いしない。** MCP で `readOnlyHint` を申告しないツールは既定で ask
  （`mcpRules()`）。増えたときに止まる側へ倒す
- **`.hma` の「緩める方向」（フック・allow ルール・MCP サーバ）は初回に本人の確認を取る**（`settings/trust.ts`）。
  未信頼なら `~/.hma`（user 層）のものだけ効く。MCP サーバは信頼を聞いたあとに起動する
- **設定の優先順位はフラグ > 環境変数 > 設定ファイル > 既定**、`~/.hma < .hma < .hma/settings.local.json`。
  `src/config.ts` が一箇所に畳む。**API キーだけは設定ファイルから読まない**（共有される場所に書く習慣を作らないため）
- **`workspace` はセキュリティ境界ではない。** `bash` からも MCP からも外に出られる。止めているのは権限ルールだけ
- **system プロンプトの文字列連結は `agent/prompt.ts` だけ。** 起動時に集める文脈（環境 / AGENTS.md /
  SessionStart フック / plan モード）は IO を伴うので Agent の外（`context/index.ts`）で集める
- **フックの合成順は `harness/index.ts` に集約。** 外部フックが権限ルールより先（block も allow もフックが強い）、
  read-before-edit ガードは承認より先、ツール結果は切ってから PostToolUse に渡す
- **サブエージェントは並列化ではなくコンテキストの隔離のため。** 子は承認を求められず、親と同じフックを通る。
  background の完了は新しい通知経路ではなく steering / follow-up キューに合流する

## 既知の穴（意図的に残してある）

`PLAN.md` の表と `SECURITY.md` が正。実行中に落ちたツールは at-least-once、background の子は落ちたら消える、
子のイベントが実時間で出ない、`workspace` の閉じ込めが MCP に効かない、MCP は tools のみ・stdio のみ・再起動なし。

**これらは「順番が来ていない」のであって「恒久的に残す」ものではない。** 壊れ方を見せる手順を飛ばして
いきなり塞ぐのは作法に反するが、踏んで理解したあとは塞ぐ方向へ進む。触る前に該当ステップの節を読むこと。
