# hand-made-agent

フレームワークを使わずにエージェントを手で作って理解するための練習用リポジトリ。

動くプロダクトを作るのが目的ではない。**素朴に実装すると何が壊れるかを実際に踏んで**、
pi-agent-core / Mastra / LangGraph が何を代行しているのかを腹落ちさせるのが狙い。

進め方の原則は「先に正解を実装せず、まず素朴版で壊してから対策を入れる」。
各ステップで実測値を取り、前後で比較する。

## セットアップ

1. https://aistudio.google.com/apikey で API キーを取得（無料枠、クレカ不要）
2. `.env` に書く（`node --env-file-if-exists` を npm scripts に仕込んであるので export は不要）

```bash
echo 'GEMINI_API_KEY=...' > .env
npm start
```

`sandbox/` の中だけを触れるファイル操作エージェントが立ち上がる。

> 無料枠は入力がモデルの学習に使われる規約。**業務のコードやデータは入れないこと。**

## 実行方法

```bash
npm link            # 一度だけ。hma コマンドが入る
```

```bash
hma                 # sandbox プロファイルで対話
hma code            # コーディングエージェント。作業対象は現在のディレクトリ
hma code path/to/x  # 作業対象を指定
hma serve           # HTTP + SSE（自前フロント: http://localhost:3000）
hma list            # 保存されているスレッド一覧
hma --thread foo    # スレッドを指定（--new で新規）
```

**`hma code` はどのディレクトリからでも動く。** tsx と `.env` はインストール元から、
作業対象と `.threads/` は実行したディレクトリから解決する（プロジェクトごとに会話が分かれる）。

`npm start` / `npm run serve` も残してある。開発中はこちらのほうが速い。

```bash
npm start
npm run serve
cd web && npm run dev   # CopilotKit 版（http://localhost:5173、上のサーバーが必要）
npm run typecheck
```

### 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `GEMINI_API_KEY` | — | AI Studio の無料枠キー |
| `LLM_MODEL` | `gemini-3.5-flash-lite` | 無料枠で回しやすいもの |
| `LLM_BASE_URL` | Gemini の OpenAI 互換 | Ollama / Groq に差し替え可能 |
| `CONTEXT_LIMIT` | `0`（無効） | トリム発動のトークン閾値。実験では `1200` |
| `TRIM` | `none` | `none` / `naive` / `safe` / `compact` |
| `APPROVAL` | `ask` | `auto` で bash を自動承認 |
| `WORKSPACE` | `sandbox` | エージェントが触れる唯一の場所 |
| `PROFILE` | `sandbox` | `sandbox` / `coding` |
| `STREAM` | 有効 | `0` で応答が出揃ってから1回で流す |
| `PORT` | `3000` | |
| `STORE` | `sqlite` | `sqlite` / `file` / `memory` |
| `STORE_PATH` | sqlite: `.threads/agent.db`<br>file: `.threads` | 保存先 |

よく使う実験コマンド:

```bash
CONTEXT_LIMIT=1200 TRIM=compact npm start
```

## ステップ

- [x] 1. 素の while ループ
- [x] 2. bash ツール + 承認ゲート
- [x] 3. 会話が長くなってコンテキストが溢れる
- [x] 4. 捨てる代わりに要約する（compaction）
- [x] 5. 進捗を UI に出したくなる（AG-UI）+ 承認を Interrupt に載せ替え
- [x] 6. プロセスを再起動すると履歴が消える（永続化）← いまここ

各ステップは「素で書くと困る → だからフレームワークにその機能がある」を体感するのが目的。

未実装のまま残しているもの: `STATE_SNAPSHOT` / `MESSAGES_SNAPSHOT` / `REASONING_*` などの AG-UI 機能。

## 構成

4層に分けている。**下の層は上の層を知らない。**

```
  agent/     Agent。AG-UI イベントを yield するだけ。IO を一切知らない
    ↑
  session/   threadId ↔ Agent。store から復元し、run のたびに保存する
    ↑           ↑
  transport/ │ store/     どこに置くか（sqlite / file / memory）
    │
    ├── stdio.ts ──→ render/cli.ts ──→ 端末
    └── http.ts  ──→ SSE ──→ public/index.html
                          └→ web/src/main.tsx (CopilotKit)
```

```
bin/hma.js             hma コマンド。サブコマンドを entry に振り分ける
src/cli.ts             エントリ: 層を組み立てて StdioTransport を起動
src/serve.ts           エントリ: 層を組み立てて HttpTransport を起動
src/config.ts          環境変数と SYSTEM プロンプト
src/shutdown.ts        SIGINT / SIGTERM → transport.stop()

src/agent/loop.ts      Agent クラス。AG-UI イベントを yield する async generator ← 本体
src/agent/stream.ts    ストリーミングの delta を1つのメッセージに畳む
src/agent/tools.ts     createFileTools(workspace) — ファイル操作ツール一式
src/agent/toolset.ts   interface Toolset（loop.ts が知る唯一のツールの姿）
src/profile/index.ts   Profile 型と createProfile()
src/profile/sandbox.ts   sandbox を眺めるアシスタント
src/profile/coding.ts    コーディングエージェント
src/agent/trim.ts      charCount / trimNaive / splitSafe / trimSafe（文字数ベース）
src/agent/compact.ts   LLM に要約させる rolling compaction

src/session/index.ts   Sessions。Map<threadId, Agent> と store の読み書き
src/store/index.ts     interface Store と createStore()
src/store/sqlite.ts      node:sqlite（既定）
src/store/file.ts        JSON ファイル
src/store/memory.ts      永続化しない（ステップ6 以前の挙動）

src/transport/index.ts interface Transport
src/transport/stdio.ts stdin/stdout。承認プロンプトもここ
src/transport/http.ts  HTTP + SSE。ルーティングと encodeSSE
src/render/cli.ts      AG-UI イベント → 端末文字列

public/index.html      自前フロントエンド（素の JS）
web/src/main.tsx       CopilotKit 版フロントエンド（Vite + React）
sandbox/               エージェントが触れる唯一の場所（WORKSPACE で変更可）
```

### なぜ CLI にも transport 層を切ったか

最初は CLI（`agent.ts`）と HTTP（`server.ts`）が並列だったが、両方が
「Agent を作る / store から復元する / 実行する / 保存する」を**別々に書いていた**。
そこを `Sessions` に抜くと、transport 側に残るのは本当に入出力だけになる。

```ts
// stdio                                    // http
for await (const e of sessions.run(id, input))   for await (const e of sessions.run(id, msg, runId, resume))
  print(renderer.render(e));                       write(encoder.encodeSSE(e));
```

保存を `Sessions#run()` の `finally` に置いたので、**transport は保存を忘れられない。**
クライアントが切断して generator が捨てられたときも保存される。

### interface Transport

```ts
export interface Transport {
  /** 入力を待てる transport だけが持つ。無ければ承認は Interrupt 経路になる */
  readonly approve?: ApproveFn;
  /** transport が終了したら解決する */
  start(sessions: Sessions): Promise<void>;
  stop(): Promise<void>;
}
```

`approve?` を interface に載せたのが要点。**承認の2モードは transport の制約そのもの**で、
`Agent` は「`approve` があるか無いか」しか見ておらず、それが誰の都合かは知らない。

| transport | 入力を待てるか | 承認 |
|---|---|---|
| `stdio` | 待てる（同一プロセスの stdin） | `approve` を持つ → ループの中で `await` |
| `http` | 待てない（リクエストは1本のストリーム） | `approve` を持たない → Interrupt で run を終える |

引数の置き場所も揃えた。**transport 固有のものはコンストラクタ、共有依存は `start()`。**

```ts
new StdioTransport(threadId).start(sessions)   // threadId は stdio 固有
new HttpTransport(PORT).start(sessions)        // port は http 固有
```

`stdio` が `sessions` をコンストラクタで受け取れないのは、
`Sessions` が `transport.approve` を必要とするから（transport → approve → Sessions → start の順になる）。
片方だけの制約を interface に合わせて全体で揃えている。

`start()` は「transport が終了したら」解決する。おかげで終了処理に置き場所ができた。

```ts
stopOnSignal(transport);        // SIGINT / SIGTERM → transport.stop()
await transport.start(sessions);
await sessions.close();         // store を閉じる
```

これを入れるまで `store.close()` は `--list` 経路でしか呼ばれておらず、
CLI もサーバーも DB を開いたままプロセスごと落ちていた。

> 起動バナーは `start()` の**前**に出している。
> ポートを掴む前に「listening」と言う小さな嘘だが、`onReady` コールバックを
> interface に生やすより安い。

この形にすると、**次の transport はファイルを1つ足すだけ**になる。
ACP（エディタ向け、stdio 上の JSON-RPC）を足すなら `transport/acp.ts` と `render/acp.ts` で、
`agent/` `session/` `store/` は1行も変わらない。

### `render/cli.ts` は `public/index.html` と同じ役目

どちらも「AG-UI イベントを人が読む形にする」だけのプレゼンテーション層。
違いは前者がプロセス内、後者がブラウザにあることだけ。
CLI 側も分けておくと、端末を用意せずに「このイベント列がどう表示されるか」を確かめられる。

## ステップ1 で理解すること

エージェントの本体は `src/agent/loop.ts` の `Agent.run()` にある while ループだけ。

```
ユーザー入力を messages に積む
  ↓
messages を LLM に投げる
  ↓
tool_calls が無ければ終了
  ↓
返ってきた tool_calls を実行する
  ↓
結果を role:"tool" のメッセージとして積む
  ↓
最初に戻る
```

これがエージェントのすべて。フレームワークが足しているものは、全部このループの周辺装備。

### 押さえどころ

**`messages.push(message)` — レスポンスをそのまま積む**
`message.content` だけ抜き出して積むと `tool_calls` が落ちる。次のリクエストで「ツールを呼んだ記録」が消え、`role:"tool"` のメッセージが宙に浮いてエラーになる。

**`tool_call_id` で結果と呼び出しを対応づける**
LLM が並列に3つツールを呼んだら、`role:"tool"` のメッセージを3つ積む。ID が対応していないと弾かれる。

**エラーもツール結果として返す**
ツールが失敗しても例外でループを止めない。`"エラー: ..."` という文字列を結果として返せば、LLM が自分でリトライや別の手段を考える。ここがワークフローとエージェントの分かれ目。

**ループの終了条件は `tool_calls` の有無**
返ってきたテキストの中身を見て「終わったっぽい」と判断しない。

## 試してみるとよいこと

```
> sandbox に memo.txt を作って、好きな俳句を3つ書いて
> memo.txt を読んで、それぞれの季語を教えて
> 存在しないファイルを読んでみて
```

3つ目でエラーが LLM に戻り、LLM が自分で `list_files` を試しにいくのが見える。

`src/render/cli.ts` がループの可視化。ここを消すと何も見えなくなる。
逆にここを厚くしていくと pi や Mastra が出しているイベントに近づいていく（そして実際ステップ5でそうなった）。

## ステップ2 で理解すること

`bash` を1つ足すと、`read_file` / `write_file` / `list_files` は全部その部分集合になる。
**ツールを増やすほど強くなるわけではない**、というのがツール設計の最初の分かれ道。

- 粗いツール（bash 1個）… 何でもできる。モデルがコマンドを組み立てる自由度が高い。危険
- 細かいツール（read/write/list）… 何ができるかがスキーマで縛られる。安全。表現力は落ちる

実運用のエージェントはたいてい両方持っていて、危ないものにだけゲートを置く。

### 承認ゲートは「ループの途中の await」でしかない

human-in-the-loop に特別な仕組みは要らない。ツールを実行する直前で人間に聞いて待つ、それだけ。

```
tool_calls を受け取る
  ↓
承認が必要なツールか？
  ↓ yes
人間に聞いて待つ  ← ここが human-in-the-loop
  ↓ 拒否
「拒否されました」を tool 結果として積む
```

ただしこの `await` が成立するのは CLI だけ。**Web では同じ手が使えない**（ステップ5参照）。

### 拒否も「結果」として返す

拒否したときに例外を投げたりループを抜けたりしない。
`"ユーザーが実行を拒否しました。別の方法を検討してください。"` を **`role:"tool"` の中身として返す**。
するとモデルは拒否を認識して、別の手段を提案するか、理由を尋ねてくる。

ステップ1 のエラー処理とまったく同じ形。
**エージェントに起きたことは、良い知らせも悪い知らせも全部ツール結果として本人に伝える。**
ここを例外で処理した瞬間、エージェントは「自分で立て直す」能力を失う。

### `[a]lways` が生まれる理由

毎回 y を押すのはすぐ面倒になる。だから許可を覚える仕組みが要る。
Claude Code の「このコマンドを常に許可」も、突き詰めればこの `autoApproved` の Set と同じもの。
そして「どの単位で覚えるか」（ツール名？ コマンド？ 引数のパターン？）が、そのまま実運用の設計問題になる。

### ⚠️ cwd はセキュリティ境界ではない

`bash` の cwd は `sandbox/` にしているが、`cd ..` も絶対パスも通る。
**bash を渡した時点でサンドボックスは無い。** 守っているのは承認ゲートだけ。
`read_file` などのパスチェックとは守備範囲がまったく違うので、混同しないこと。

## ステップ3 で理解すること — 素朴なトリムは会話を壊す

`CONTEXT_LIMIT` を超えたら古いメッセージを消す。これを素直に書くと `trimNaive`（`src/agent/trim.ts`）になる。

```js
while (kept.length > 2 && charCount(kept) > limitChars) {
  kept.splice(1, 1);   // 古い順に1件ずつ落とす
}
```

**これは 400 で落ちる。** `tool_calls` を持つ assistant メッセージだけが消えて、
対応する `role:"tool"` が宙に浮くから。ステップ1 で踏んだのと同じ罠を、今度はトリムが作り出す。

対策が `splitSafe` / `trimSafe`。**1件単位ではなく「ユーザー発言から次のユーザー発言まで」を1かたまりとして落とす。**
`tool_calls` と `tool` は必ず同じかたまりに入るので、ペアが割れない。

```
[system][user A][assistant+tool_calls][tool][assistant]  ← このかたまりごと落とす
                └──────────── やり取り1単位 ───────────┘
```

### 文字数で測るしかない、という妥協

トリムの判定はリクエストを投げる**前**に必要なので、そこにはまだ `usage` が無い。
なので文字数を数え、直前のレスポンスから較正した `charsPerToken` で割ってトークンを推定している（`agent/loop.ts` の `limitChars()`）。

この係数は**実測で 2.17〜3.57 まで動く**（1.6倍）。日本語の会話か英数字のログかで変わる。
「トークン数を正確に事前に知る手段が無い」というのがトリム実装のいちばん厄介なところで、
tiktoken 相当を積むか、この程度の推定で妥協するかの二択になる。

### 計測でハマった点

- **tools スキーマ 967 文字が毎リクエスト送られている。** これを計上していなかったので推定が常に低く出ていた（`TOOLS_CHARS`）
- **要約のための API 呼び出し自体もトークンを食う。** compaction のコストを計上していなかった

どちらも「見えていないものは測れない」典型。`response.usage` を信じて、推定は必ず実測で較正する。

## ステップ4 で理解すること — 捨てるのではなく畳む

`trimSafe` は壊れないが、**落とした内容は完全に消える**。
`compact`（`src/agent/compact.ts`）は、落とすかたまりを LLM に要約させて system プロンプトの末尾に畳み込む。

```
[system + これまでの経緯（要約）][user D][assistant]...
                └ 落とした分がここに圧縮されて残る
```

要約は毎回ゼロから作り直さず、前回の要約を入力に混ぜて更新していく（rolling compaction）。

### 実測: safe と compact はトークンがほぼ同じ

同じ5問を投げた結果:

| | 累計入力トークン | 結果 |
|---|---|---|
| `TRIM=safe` | 11,885 | WARN 件数・時間帯を忘れた。無関係な俳句を混入 |
| `TRIM=compact` | 11,924 | 数値と結論が保たれた |

**コストはほぼ同じで、答えの質だけが違う。**
要約 API のぶんトークンを余分に使うが、そのぶん後続のプロンプトが短くなるので相殺される。
「compaction は高くつく」という直感は、少なくともこの規模では当たらなかった。

要約プロンプト（`INSTRUCTION`）で「数値・ファイル名・コマンドと結果を落とすな」と明示しているのが効いている。
ここを曖昧にすると、要約はきれいだが後続の質問に答えられないログになる。

## ステップ5 で理解すること — AG-UI とプレゼンテーション層の分離

`Agent.run()` を「イベントを yield する async generator」にすると、UI を完全に外に出せる。

```ts
for await (const event of agent.run(input)) { ... }   // CLI: console.log
for await (const event of agent.run(input)) { ... }   // Server: encoder.encodeSSE(event)
```

イベントの型は AG-UI 標準（`@ag-ui/core`）をそのまま使っている。
自分でイベント型を決めてもいいが、標準に合わせると **CopilotKit のような既製フロントがそのまま載る**。

### AG-UI の encoder の実体

```js
return `data: ${JSON.stringify(event)}\n\n`
```

**1行。** SSE のエンコーダに魔法は無い。プロトコルの価値は転送形式ではなく「イベントの語彙が揃うこと」にある。

### Web では `await` で承認を待てない

CLI は同一プロセスなので `await approve()` でそのまま止められる。
Web は HTTP リクエストが1本のストリームなので、**承認を待つあいだ接続を握り続けるわけにいかない**。

AG-UI の答えが Interrupt。`RUN_FINISHED` に `outcome` を載せて **run をいったん終わらせる**。

```json
{"type":"RUN_FINISHED","outcome":{"type":"interrupt","interrupts":[
  {"id":"...","reason":"tool_approval","message":"bash を実行しますか？",
   "toolCallId":"call_373974","metadata":{"name":"bash","arguments":"{\"command\":\"echo hi\"}"},
   "responseSchema":{"type":"object","properties":{"approved":{"type":"boolean"}}}}]}}
```

`Agent` は `this.pending = { interruptId, calls, index }` を持っておき、
次のリクエストの `resume` を見て `executeCalls` を途中から再開する。

クライアントが返してくるのは AG-UI 標準の `resume` 配列:

```json
"resume":[{"interruptId":"...","status":"resolved","payload":{"approved":true}}]
```

**`config.approve` の有無だけで2モードが切り替わる。** CLI は前者、Web は後者。ループ本体は共通。

> `Interrupt` の型は `id / reason / message / toolCallId / responseSchema / metadata` しか持たない。
> **どのコマンドを承認するのかは `metadata` に自分で載せないと届かない。**
> ここを空にすると「bash を実行しますか？」としか出ない承認 UI ができあがる。

### CopilotKit はデフォルトでは Interrupt に何も出さない

SSE には Interrupt がちゃんと届いているのに、画面は無反応のまま。
`useInterrupt` の `render` は必須プロパティで、**省略時のデフォルト UI が存在しない**ため。

```tsx
useInterrupt({
  enabled: ({ value }) => value?.reason === "tool_approval",
  render: ({ interrupt, resolve }) => (
    <> <div>{interrupt?.message}</div>
       <button onClick={() => resolve({ approved: true })}>許可</button>
       <button onClick={() => resolve({ approved: false })}>拒否</button> </>
  ),
});
```

`renderInChat` が既定 true なので、フックを呼ぶだけで `<CopilotChat>` の中に差し込まれる。
返り値は使わないので `return null` のダミーコンポーネントに置く。

拒否は `resolve({approved:false})` でも `cancel()`（`status:"cancelled"`）でもよい。
`agent/loop.ts` の判定は「`resolved` かつ `approved===true`」のみ真なので、どちらも拒否として通る。

### 実測: CopilotKit vs 自前フロント

| | 行数 | ツール呼び出しの表示 |
|---|---|---|
| CopilotKit (`web/src/main.tsx`) | 65行（チャット描画は `<CopilotChat />` 1行、承認 UI が30行） | 何も出ない。`TOOL_CALL_*` は届いているが描画されない |
| 自前 (`public/index.html`) | 229行（CSS 90 + JS 118） | コマンドと結果、トークン統計まで出せる |

Interrupt と同じ構図で、**ツール呼び出しにもデフォルトの表示は無い**（出したければ `useFrontendTool` などでレンダラを登録する）。
自前フロントは同じイベントから `→ bash({"command":"echo hi"})` / `← hi` / `messages 4 | ctx 399 → out 1 | …` まで出している。

**チャットの見た目はタダで手に入るが、エージェント固有の表示は結局自分で書く。**
AG-UI（プロトコル）だけ採用して UI は自前、という選択は合理的。

## ステップ6 で理解すること — 永続化と「どこで保存するか」

`Map<threadId, Agent>` はプロセスと寿命を共にする。再起動すると会話も承認待ちも消える。

### 素朴版の壊れ方は「履歴が消える」ではない

承認待ちのまま再起動して、同じ `resume` を送ると:

```
再起動前: interrupt id=74bbb16d… で中断
再起動後: 同じ resume を送る → RUN_STARTED → LLM 呼び直し(372 tokens) → また interrupt id=089b1c0a…
```

`this.pending` が無いので `run()` は `else` 分岐に入り、**`resume` 配列は `find()` にすら到達しない。**
ユーザーから見ると「許可を押したのにまた許可を求められる」。エラーにならないぶん質が悪い。

### 何を保存するか

`AgentSnapshot`（`src/agent/loop.ts`）。`messages` と `pending` だけでは足りない。

| フィールド | 落とすとどうなるか |
|---|---|
| `messages` | 会話が消える |
| `pending` | 承認の往復が成立しない（上記） |
| `summaryText` | compaction の要約が消え、次の compaction がゼロからやり直しになる |
| `charsPerToken` | 較正がリセットされ、再起動直後のトリム判定がずれる |
| `totalPromptTokens` | 累計コストの計測が途切れる |

`pending.calls` には Gemini の `extra_content.thought_signature` がそのまま入る。
**プロバイダ固有の状態も一緒に往復させる必要がある**ので、`calls` を自前の型に詰め直さずそのまま保存している。

### 誰が保存するか

`agent/` が UI を知らないのと同じ理屈で、**`agent/` は保存先も知らない。**

- `Agent#snapshot()` / `Agent#restore()` — 自分の状態は自分しか知らないので Agent が持つ
- `src/store/` — 読み書きだけ。`interface Store` で実装を差し替える
- `src/session/` — **いつ**保存するかを決める（`Sessions#run()` の `finally`）

LangGraph の checkpointer や pi のセッション永続化も、切り方はこれと同じ。

```ts
export interface Store {
  load(threadId: string): Promise<AgentSnapshot | undefined>;
  save(snapshot: AgentSnapshot): Promise<void>;
  list(): Promise<ThreadSummary[]>;
  close(): Promise<void>;
}
```

| 実装 | 既定の保存先 | 用途 |
|---|---|---|
| `SqliteStore` | `.threads/agent.db` | **既定。** `node:sqlite` なので追加依存ゼロ |
| `FileStore` | `.threads/<threadId>.json` | 中身を目で見たいとき |
| `MemoryStore` | — | ステップ6 以前の挙動を再現する（`STORE=memory`） |

3実装とも同じ snapshot を round-trip することを確認済み。`STORE` を変えるだけで入れ替わる。

### SQLite にして何が変わるか

`node:sqlite` は Node 22.5 から標準添付なので、**`npm install` は増えない**。

- **アトミック性がタダで手に入る。** `FileStore` は一時ファイルに書いてから `rename` して自分で担保している。SQLite は WAL を有効にすれば書き込み途中の停止でも直前のコミットまで残る
- **複数プロセスが同じ store を見られる。** CLI と HTTP サーバーが同じ `.threads/agent.db` を共有する
- **一覧が引ける。** JSON ファイルだと `list()` が全ファイルを読んでパースする実装になる（`FileStore#list()`）

`snapshot` 列に JSON をまるごと入れ、`messages` / `total_prompt_tokens` / `pending` / `updated_at` だけ列に出している。
一覧のためだけの非正規化で、**メッセージを行に分ける正規化まではやっていない**。

```
$ curl -s localhost:3000/threads
[ { "threadId": "s1",  "messages": 3, "totalPromptTokens": 372, "pending": true,  ... },
  { "threadId": "cli", "messages": 5, "totalPromptTokens": 774, "pending": false, ... } ]
```

`cli` は `npm start` が書いたスレッド。**同じ DB を CLI と HTTP サーバーが共有している。**

### threadId をそのままパスにしない

`threadId` はクライアントが送ってくる文字列。そのままファイル名にすると `../../` が通る。
`store/index.ts` の `assertThreadId()` で `^[A-Za-z0-9_-]{1,128}$` に限定し、3実装すべてが通す。

```
$ curl ... -d '{"threadId":"../../../tmp/pwned","message":"hi"}'
{"error":"threadId に使えない文字が含まれています: ../../../tmp/pwned"}
```

SQLite ならパスを組み立てないので traversal は起きないが、**store を差し替えたら安全になったり危なくなったりする**のは筋が悪い。
バリデーションは実装ではなく interface 側に置いている。

### 実測: 再起動をまたいだ承認

```
起動 → t2 で bash を要求 → interrupt (.threads/t2.json に pending が落ちる)
kill → 再起動
resume を送る → TOOL_CALL_RESULT "hi" → 最終回答  (totalPromptTokens 372 → 771 と継続)
kill → 再起動
「さっき実行したコマンドは？」→「「echo hi」です。」  (totalPromptTokens 1191)
```

**LLM を呼び直していない。** 承認待ちだったツールがそのまま実行されている。

### ⚠️ 残っている穴: run の途中で落ちるとツールが二重実行される

保存するのは run が終わったとき。**ツールが副作用を出した直後にクラッシュすると、その結果は保存されない。**

`echo tick >> ticks.txt && sleep 30` を承認し、sleep 中にサーバーを `kill -9` して、同じ resume を送り直した結果:

```
ticks.txt:
     1  tick     ← クラッシュした run で実行された
     2  tick     ← 再送した resume で実行された
```

`pending` は `index 0` のまま保存されているので、同じツールをもう一度実行しにいく。**at-least-once。**

これは保存の粒度を上げれば軽くなるが、原理的には消えない。
**クラッシュ時にツールが完了したかどうかは、外から見て分からない。**
at-least-once（もう一度実行する）か at-most-once（実行済みかもしれないので諦める）かを選ぶしかない。
どちらを選ぶかはツール側の冪等性の問題で、ループの問題ではない。

### CLI も同じ store に乗る

```
$ npm start
> 私の好きな色は青です。覚えておいて。
  承知いたしました。…

$ npm start                    # プロセスを立て直す
gemini-3.5-flash-lite / sqlite:.threads/agent.db / thread cli（履歴 2 件を復元）
> 私の好きな色は何でしたか？
  あなたの好きな色は「青」です！
    [messages 4 | ctx 399 → out 8 | 3.82 文字/token | 累計入力 774]
```

累計 774 = 前プロセスの 375 + 今回の 399。**計測も再起動をまたいで続く。**

CLI は既定でスレッド `cli` に書く。`--thread <id>` で切り替え、`--new` で新しい UUID、`--list` で一覧。
CLI には `approve` があるので `pending` は発生しない。保存されるのは会話と計測値だけ。

## AG-UI はどこに位置するのか — エージェント関連プロトコルの地図

AG-UI は「エージェント界隈のプロトコル一族」の一つで、層ごとに役割が分かれている。

| 層 | プロトコル | 誰と誰を繋ぐ | 主体 | 形式 |
|---|---|---|---|---|
| ツール・データ | MCP | エージェント ↔ ツール / データソース | Anthropic | JSON-RPC（stdio / HTTP） |
| エージェント間 | A2A | エージェント ↔ エージェント | Google → Linux Foundation | HTTP + Agent Card |
| ユーザー / UI | **AG-UI** | エージェント ↔ フロントエンド | CopilotKit | SSE イベントストリーム |
| エディタ | ACP（Agent Client Protocol） | コーディングエージェント ↔ エディタ | Zed | JSON-RPC 2.0 over stdio |
| UI の記述形式 | A2UI / MCP-UI | エージェントが返す UI ウィジェットの表現 | Google / Shopify ほか | データ仕様（輸送は別） |
| 決済・コマース | UCP / AP2 / ACP(commerce) | エージェント ↔ 店舗・決済 | Google+Shopify / Google→FIDO / OpenAI+Stripe | HTTP |

**「MCP が文脈、A2A が協調、AG-UI が人との接点」** という分け方が定番の整理。

### イベント列を規格化しているのは実質2つ

- **AG-UI** — `RUN_STARTED` / `TEXT_MESSAGE_CONTENT` / `TOOL_CALL_*` / `STATE_DELTA` … を SSE で流す。Web フロントエンド向け
- **ACP (Zed)** — LSP をモデルにした JSON-RPC。エージェントをサブプロセスとして起動し、`session/update` 通知で思考・ツール呼び出し・差分を流す。エディタ向け

MCP と A2A も notification は持つが、基本は request/response で「実行中の途中経過を UI に流し続ける」ことが主目的ではない。
このリポジトリで **イベント名を差し替えるだけで別プロトコルに載せ替えられそうに見える**のは、AG-UI と ACP がどちらもこの形をしているから。

pi-agent-core は ACP 対応の議論が動いている（コミュニティ製の pi-acp アダプタが Zed と繋がっている）。
pi にとっては AG-UI（ブラウザ）より ACP（エディタ）のほうが本来の用途に近い。

### ⚠️ ACP という略語は3つある

これが一番の罠。

1. **Agent Client Protocol**（Zed、2025年8月）— エージェント ↔ エディタ。JetBrains・Neovim・Emacs が対応、2026年1月に Zed と JetBrains が ACP Registry を共同ローンチ。**今「ACP」と言えば大抵これ**
2. **Agent Communication Protocol**（IBM / BeeAI、2025年3月）— エージェント間。Linux Foundation 傘下で A2A に統合され開発終了。歴史上の名前
3. **Agentic Commerce Protocol**（OpenAI + Stripe）— 決済チェックアウト。ChatGPT の Instant Checkout の裏側（同機能は 2026年3月に終了）

記事を読むときは、どの ACP の話か毎回確認すること。

### 実務上の要点

- **MCP はツール層で事実上決着済み**（Anthropic / OpenAI / Google / Microsoft が採用）
- **AG-UI と A2UI は競合しない。** A2UI が「どんな UI を返すか（what）」、AG-UI が「それをどう運ぶか（how）」
- **A2A / UCP / AP2 は「組織をまたぐ相互運用」が価値の源泉**なので、ひとつの組織の中でシステムを繋ぐだけなら急いで採用する理由は薄い

<details>
<summary>出典</summary>

- Top AI Agent Protocols in 2026 — MCP, A2A, ACP & More (GetStream)
- Zed — Agent Client Protocol / The ACP Registry is Live
- ACP Joins Forces with A2A Under the Linux Foundation (LF AI & Data)
- pi Discussion #4444: Supporting the Agent Client Protocol
- AG-UI and A2UI: Understanding the Differences (CopilotKit)
- Universal Commerce Protocol (ucp.dev) / Agentic Payments: AP2 vs ACP (Grid Dynamics)

</details>

## pi-agent-core と突き合わせる

このリポジトリの当初のゴール。https://github.com/earendil-works/pi の `packages/agent` を読んで、
自分で書いた実装と1対1で比べる。**規模は `packages/agent` だけで 25,291行、我々は 1,335行。**

| 観点 | 我々 | pi |
|---|---|---|
| ループ | `Agent.run()` の while 1本 | `runLoop()` の**二重ループ** |
| イベント | AG-UI 標準を `yield` | 独自 `AgentEvent` を `EventStream` に push |
| 承認 | `requiresApproval` + `approve` / Interrupt | **ループに承認の概念が無い**（後述） |
| 拒否の表現 | tool 結果の文字列 | `createErrorToolResult()` — **同じ** |
| 終了条件 | `!message.tool_calls?.length` | `hasMoreToolCalls` + `shouldStopAfterTurn` + `terminate` |
| steering | 無い | `getSteeringMessages()` |
| follow-up | 無い | `getFollowUpMessages()` |
| ツール並列実行 | 逐次 | **`parallel` が既定** |
| 永続化の粒度 | run 終了時に snapshot 丸ごと | `message_end` ごとに append-only JSONL |
| 中断 | 無い（Ctrl+C でプロセスごと） | `AbortSignal` を全域に通す |
| コンテキスト操作 | `trimIfNeeded()` をループ内に直書き | `transformContext` / `prepareNextTurn` フック |

### pi のループには「承認」という概念が無い

いちばん効いた発見。pi の `agent-loop.ts` を `permission` や `approve` で grep しても**1件も出ない**。
あるのは `beforeToolCall` が `{ block: true, reason }` を返せることだけ。

```ts
if (beforeResult?.block) {
  const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
  if (beforeResult.terminate === true) result.terminate = true;
  return { kind: "immediate", result, isError: true };
}
```

承認 UI は `packages/coding-agent` 側で、`beforeToolCall` を extension runner に配線しているだけ。

我々は `requiresApproval` を `agent/tools.ts` に、分岐を `executeCalls()` に**埋め込んだ**。
動くが、承認以外（監査ログ・レート制限・引数の書き換え）を足したくなると同じ場所を何度も切ることになる。
**pi の切り方は穴が1つで、そこに何を挿すかは外の都合**、という分け方になっている。
`store` を interface にしたのと同じ発想を、ツール実行にも当てている。

### 拒否の表現は完全に一致した

`createErrorToolResult(...)` を `role:"toolResult"` として積む。
我々の `"ユーザーが実行を拒否しました。別の方法を検討してください。"` と**同じ形**。
ステップ2 で書いた「良い知らせも悪い知らせも全部ツール結果として本人に伝える」が、
独立に書いた実装と 25,000行のフレームワークで一致した。ここは自信を持っていい部分。

### steering がループの形を決めている

我々の単一 while では表現できない。pi は二重ループになる。

```
outer: 止まる直前に getFollowUpMessages() を確認 → あれば inner に戻す
  inner: while (hasMoreToolCalls || pendingMessages.length > 0)
           ├ pendingMessages を context に注入してから LLM を呼ぶ
           ├ ツール実行
           ├ shouldStopAfterTurn() で抜けるか判定
           └ getSteeringMessages() を poll
```

- **steering** = 走っている最中に割り込む。ターンの合間に注入され、実行中のツール呼び出しは飛ばさない
- **follow-up** = 止まってから続ける。エージェントが終わろうとした瞬間に確認される

poll のタイミングが**3箇所**あるのが実装の肝。開始時（待っている間に打たれた分）、
`prepareNextTurn` の後（compaction が長引く間に打たれた分）、`turn_end` の後。
2つ目にはこういうコメントが付いている。

> Preparation can be long-running (for example, compaction). Pick up steering queued while it ran.
> Only poll again if the earlier poll returned nothing; otherwise one-at-a-time mode would deliver two messages in this turn.

### 並列ツール実行: イベントは完了順、履歴は元の順序

`executeToolCallsParallel()` は preflight（`beforeToolCall` と引数検証）だけ逐次で回し、
実行本体をクロージャの配列にして `Promise.all` に渡す。

- `emitToolExecutionEnd()` は**各クロージャの中**で呼ばれる → **完了した順**にイベントが出る
- `Promise.all` の結果配列は**元の順序**を保つ → tool result メッセージは assistant の並び順で積まれる

**UI は速いものから光り、履歴は決定論的。** 意図的に別々の順序にしている。
我々は逐次実行なのでこの問題自体が発生しないが、並列にした瞬間に必ず踏む。

### 永続化の粒度が、我々の穴の答えになっている

我々は run 終了時に snapshot を丸ごと上書きする。だから
[ツールの二重実行](#-残っている穴-run-の途中で落ちるとツールが二重実行される)が起きる。

pi は `message_end` ごとに `appendMessage()` して、append-only の JSONL に1行ずつ足す。

```ts
// coding-agent/src/core/agent-session.ts
} else if (event.message.role === "user" || event.message.role === "assistant" ||
           event.message.role === "toolResult") {
  this.sessionManager.appendMessage(event.message);
}
```

**「保存する」ではなく「追記する」**にすると、粒度を細かくしてもコストが上がらない。
`MutationLine`（read-modify-write を1本に直列化する 23行のクラス）で並行書き込みを捌いている。

我々の `Store` は `save(snapshot)` の1メソッドなので、粒度を上げるなら
`append(threadId, entry)` を生やすところから設計が変わる。

### pi は AG-UI を使っていない。理由は「ブラウザ向けだから」ではない

pi のイベントは独自の10種。`agent_start` / `turn_start` / `message_start` / `message_update` /
`message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` /
`turn_end` / `agent_end`。リポジトリ全体を `ag-ui` で grep しても**0件**で、変換アダプタも無い。

「AG-UI は SSE 前提だから使えない」ではない。`@ag-ui/core` の依存は `zod` **だけ**で、
転送への依存はゼロ。SSE エンコーダは `@ag-ui/encoder` という別パッケージ。
イベント種別も35個あり `THINKING_*` `REASONING_*` `SUBAGENT_*` `STATE_*` まで揃っている。
**このリポジトリの `render/cli.ts` が、転送なしで AG-UI を消費できる証拠になっている。**

本当の違いは、**イベントが状態そのものを運んでいるか、状態から導出した表示用か**。

| | 我々 | pi |
|---|---|---|
| 保存している形 | `OpenAI.ChatCompletionMessageParam[]` | `AgentMessage`（イベントの中身と同じ） |
| AG-UI イベント | そこから**導出**。捨てても状態は無事 | — |

pi の `AgentMessage` は3役を兼ねている。**LLM に渡す context** であり、
**JSONL に append される永続エントリ**であり、**イベントの payload** でもある。
`AgentEvent` を AG-UI に置き換えると、永続フォーマットが UI プロトコルの都合に縛られる。

型の上で実際に噛み合わないのは1点だけ。

```ts
// AG-UI
content: z.ZodString              // TOOL_CALL_RESULT の中身は string

// pi
result: AgentToolResult<any>      // content + details（ツールごとに型付き）
```

`harness/tools/edit-diff.ts`（500行）のようなツールは構造化した差分を `details` に載せて TUI が描く。
AG-UI に載せるには文字列に潰して受け側で再パースするしかない。
`tool_execution_update`（ツール実行中の部分結果）に相当するイベントも AG-UI には無い。

なので **AG-UI を内部イベント型として採用するのは割に合わないが、
AG-UI を出力する変換器を別に持つのは普通にできる**。それはこのリポジトリの
`transport/http.ts` + `render/cli.ts` がやっていることそのもので、
`@earendil-works/pi-agui` 相当が無いのは需要の問題であって設計上の障害ではない。

### その他

- **`terminate`** — ツール結果が「これ以上ループを回すな」と言える。我々に相当物は無い
- **`AbortSignal`** — `prepareToolCall()` の中だけで aborted チェックが3回。中断は後付けできない、という実例
- **ACP** — リポジトリ内に `Agent Client Protocol` の言及は**0件**。in-tree の実装はまだ無い
- **`packages/protocol` は AG-UI の競合ではない** — CBOR over Unix socket。
  1つの durable Session に複数の presentation を attach するルーティング、
  correlated request/response とキャンセル、複製状態の delta 配信をやる**双方向 RPC 層**で、
  エージェントのイベントはその上を流れる payload の1つでしかない。
  payload には strict JSON を強制していて**バイト配列を弾く**ので、CBOR は速度ではなくフレーミング目的

## pi を元にエンハンスする

読み合わせで見つかった差を、1つずつ持ち込む。

- [x] **1. `beforeToolCall` — 承認をループから追い出す**
- [x] **2. `afterToolCall` と `terminate`**
- [x] **3. `AbortSignal` を全域に通す**
- [x] **4. store を `append` にして保存粒度を上げる**
- [x] **5. steering / follow-up キュー**

### 1. `beforeToolCall` — 承認をループから追い出す

pi の `agent-loop.ts` には `permission` も `approve` も出てこない。あるのは
`beforeToolCall` が「止めろ」と言えることだけ。同じ形にした。

**前** — `executeCalls()` の中に承認の分岐が直に埋まっていた。

```ts
let allowed = true;
if (requiresApproval.has(name)) {              // ← どのツールが対象か
  if (i === startIndex && firstDecision !== undefined) allowed = firstDecision;
  else if (this.config.approve) allowed = await this.config.approve(name, args);
  else { /* Interrupt を組み立てて return */ }  // ← 承認 UI の文言
}
const result = allowed
  ? await executeTool(name, JSON.parse(args))
  : "ユーザーが実行を拒否しました。…";           // ← 拒否の文言
```

**後** — ループは「フックが止めろと言ったか」しか見ない。

```ts
const decision =
  i === startIndex && resumed
    ? resumed.decision
    : await this.config.beforeToolCall?.({ toolCallId, name, arguments: args, messages });

if (decision?.kind === "suspend") { /* Interrupt にして run を終える */ }

const result =
  decision?.kind === "block"
    ? decision.reason
    : await executeTool(name, JSON.parse(args));
```

`requiresApproval` も承認の文言も `src/approval.ts`（29行）に移った。

```ts
export function approvalHook(ask?: AskFn): BeforeToolCall {
  return async ({ name, arguments: args }) => {
    if (!requiresApproval.has(name)) return undefined;      // 許可
    if (ask) {
      return (await ask(name, args)) ? undefined : { kind: "block", reason: DENIED };
    }
    return { kind: "suspend", message: `${name} を実行しますか？`, denyReason: DENIED,
             metadata: { name, arguments: args } };
  };
}
```

**`ask` を渡すかどうかだけで2モードが決まる。** `src/cli.ts` は `approvalHook(transport.approve)`、
`src/serve.ts` は `approvalHook(undefined)`。Agent はどちらの都合も知らない。

#### pi と違えた点

- **`kind` で判別する。** pi は `{ block?: boolean; reason?: string; terminate?: boolean }` と
  全部 optional な1つのオブジェクトだが、TypeScript の絞り込みが効かないので判別子を付けた
- **`suspend` を足した。** pi に無い。AG-UI の Interrupt に載せて run を中断するため
- **`denyReason` を `pending` に持たせた。** 中断して再開するまでプロセスが落ちているかもしれないので、
  拒否時の文言も snapshot に載せて往復させる。おかげでループ側に承認の文言が1つも残っていない

#### 承認の匂いは 7 で完全に消した（[後述](#7-interrupt-の形もフックに決めさせる)）

### 2. `afterToolCall` と `terminate`

穴のもう半分。**ツール結果を書き換える**のと、**ツールが「もうループを回すな」と言える**ようにする。

```ts
export type ToolResultContext = ToolCallContext & {
  result: string;
  blocked: boolean;   // beforeToolCall が止めた結果か（ツールは動いていない）
};

/** 省略したフィールドは元の値を保つ。deep merge はしない（pi と同じ） */
export type AfterToolCallResult = { content?: string; terminate?: boolean } | undefined;
```

`executeCalls()` の末尾はこうなった。

```ts
const blocked = decision?.kind === "block";
let result = blocked ? decision.reason : await executeTool(name, JSON.parse(args));
let terminate = blocked ? decision.terminate === true : false;

const after = await this.config.afterToolCall?.({ ...ctx, result, blocked });
if (after) {
  result = after.content ?? result;
  terminate = after.terminate ?? terminate;
}
allTerminate &&= terminate;
```

#### `terminate` はバッチ全体のルール

ここが読まないと分からない部分。pi はこうなっている。

```ts
function shouldTerminateToolBatch(finalizedCalls) {
  return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}
```

**`some` ではなく `every`。** 1つのツールが「止めろ」と言っても、
同じ assistant メッセージで呼ばれた他のツールが言っていなければ止まらない。
並列で3つ呼ばれたうち1つが終了を主張しただけで会話を切ったら、残り2つの結果が宙に浮くから。
`block` した結果も `terminate` を立ててこのルールに参加できる。

停止しても**ツール結果は積まれる**。単に次の LLM 呼び出しをしないだけで、
会話はツール結果で終わる（assistant の締めの発言が無い）。

#### 中断をまたぐ問題は pi に無い

pi には suspend が無いので、バッチは必ず1回の `executeCalls` で終わる。
我々は承認で中断するので、**中断より前のツールが立てた `terminate` が失われる**。
`pending.terminateSoFar` に載せて往復させた。`AgentSnapshot` に入るので再起動もまたぐ。

#### 検証（スタブ LLM で4件）

| | 結果 |
|---|---|
| `content` の書き換え | ツール結果が `＜書き換え済み＞` に |
| 2つとも `terminate` | LLM 呼び出し **1回**で `RUN_FINISHED` |
| 1つだけ `terminate` | LLM 呼び出し **2回**（`every` の確認） |
| 中断をまたぐ | `terminateSoFar: true` が保存され、再開後も LLM を呼ばずに終了 |

#### まだ誰も使っていない

`afterToolCall` は `cli.ts` / `serve.ts` のどちらからも渡していない。
**pi も同じで**、`packages/agent` はフックを開けるだけ、実際に挿すのは `packages/coding-agent` の仕事。
使うとしたら「長すぎるツール結果を切り詰める」「監査ログを取る」あたりが最初の客になる。

### 3. `AbortSignal` を全域に通す

pi は `agent-loop.ts` だけで `signal` が **37回**出てくる。
LLM 呼び出し、ツール実行、`beforeToolCall` / `afterToolCall`、リトライ待ち、全部に通っている。
**中断は後から足せない**ので、通す場所を一箇所ずつ確認しながら足した。

| 通した先 | 通さないとどうなるか |
|---|---|
| `client.chat.completions.create(body, { signal })` | LLM の応答を最後まで待つ |
| `sleep(wait * 1000, undefined, { signal })` | 429 のバックオフ中は最大80秒無反応 |
| `executeTool(name, args, signal)` → `execFile` の `signal` | `sleep 25` が終わるまで止まらない |
| `summarize(..., signal)` | compaction の API 呼び出しが止まらない |
| `beforeToolCall` / `afterToolCall` の第2引数 | フックの中の長い処理が止まらない |

#### pi と違えた点: 中断してもツール結果は積む

pi は中断すると残りのツール呼び出しを**結果なしで打ち切る**。

```ts
if (signal?.aborted) {
  break;      // executeToolCallsSequential
}
```

我々の `messages` はそのまま OpenAI API に渡るので、これをやると
`tool_calls` が3つで `tool` が1つ、という状態になって**次のリクエストが 400 で落ちる**。
ステップ1 とステップ3 で踏んだのと同じ罠。なので残り全部に `"中断されました"` を積む。

```ts
if (signal?.aborted) {
  yield* this.pushToolResult(call, ABORTED);
  allTerminate = false;
  continue;
}
```

スタブ LLM で確認: 3つのツール呼び出しの1つ目の直後に中断 →
**`tool_calls` 3 / `tool` 結果 3 でペアが保たれ**、`RUN_ERROR` ではなく `RUN_FINISHED` で閉じる。

中断は異常終了ではないので、`catch` で `signal.aborted` を見て `RUN_FINISHED` を出す（pi の `agent_end` と同じ）。

#### transport ごとに「中断とは何か」が違う

承認と同じ構図がここでも出た。

| transport | 中断の合図 | 中断後 |
|---|---|---|
| `stdio` | 走っている最中の Ctrl+C | プロンプトに戻る（プロセスは生きたまま） |
| `http` | クライアントの切断（`res.on("close")`） | run を捨てる |

`stopOnSignal()` は**まず `transport.interrupt?.()` を試す**ようになった。
run が走っていなければ従来どおり `stop()`、それでも来たら `exit(130)`。

```
> bash で sleep 25 を実行して
  許可する? [y]es / [n]o / [a]lways: y
^C
  中断しました。
  ← 中断されました
> 直前に何が起きた？                    ← プロンプトが返ってきて、会話も続く
  直前のコマンド `sleep 25` は…「中断されました」と判定されました。
```

HTTP 側は curl を8秒で切ると、`sleep 25` の完了を待たずに4秒後には
`[tool] 中断されました` が保存されていた。**タブを閉じたらトークンを食うのを止める**、が効くようになった。
どちらも中断後にスレッドの会話を継続できる（= messages が壊れていない）ことを実接続で確認済み。

### 4. store を `append` にして保存粒度を上げる

pi は `message_end` ごとに append-only の JSONL に1行足す。我々は run 終了時に snapshot を丸ごと
上書きしていた。**「保存する」から「追記する」**に変えた。

```ts
export interface Store {
  load(threadId: string): Promise<Entry[]>;        // ← snapshot ではなくエントリの列
  append(threadId: string, entry: Entry): Promise<void>;
  ...
}
```

`Agent#snapshot()` / `restore()` は無くなり、`replay(entries)` になった。

```ts
export type Entry =
  | { kind: "message"; message: ChatCompletionMessageParam }
  /** trim / compact は履歴を書き換えるので、その時点の全文を1件として置く */
  | { kind: "history"; messages: ChatCompletionMessageParam[]; summaryText: string }
  | { kind: "pending"; pending: Pending | null }
  | { kind: "usage"; promptTokens: number; charsPerToken: number };
```

#### pi の手が使えなかった

pi は**イベントを見て**永続化する。`message_end` を受けて `appendMessage(event.message)` するだけ。

我々は同じことができない。**AG-UI イベントは表示用に情報を落としている**からで、
Gemini の `extra_content.thought_signature` のような復元に必要なものが乗っていない。
なので Agent に永続化専用の口（`append?: AppendFn`）を別に開けた。
[pi が AG-UI を使わない理由](#pi-は-ag-ui-を使っていない理由はブラウザ向けだからではない)が、
そのままこちらの設計に跳ね返ってきた形。

`agent/` は「どこに書くか」を知らない。`Sessions` が `(entry) => store.append(threadId, entry)` を注入する。

#### 順序が2箇所で効く

**1. ツール結果は積んでから通知する。**

```ts
await this.pushMessage({ role: "tool", tool_call_id: call.id, content });
yield { type: EventType.TOOL_CALL_RESULT, ... };
```

逆にすると、間で落ちたとき結果が抜けた状態が残る。

**2. 承認待ちの解除はツール結果が積まれてから。**
再開時にすぐ `pending: null` を追記すると、ツール実行中に落ちたときに
「承認待ちでもない・ツール結果も無い」状態になり、`tool_calls` が宙に浮いて次のリクエストが 400 になる。

```ts
this.pending = undefined;   // メモリ上だけ先に消す
// …ツール結果を積んだあとで await this.record({ kind: "pending", pending: null })
```

#### 実測: 途中で落ちても、そこまでが残る

ツール実行後・次の LLM 呼び出しで落ちる状況をスタブで作った。

```
落ちるまでに追記された: 4 件
  message  user
  usage
  message  assistant
  message  tool
復元後: system,user,assistant,tool | tool_calls 1 = tool 結果 1
```

**旧モデルでは run 終了時にしか保存しないので、この4件が丸ごと失われていた。**

実接続の追記ログはこう見える。承認の往復が記録として残る。

```
 1 message  user: bash で `echo tick >> ticks.txt…
 2 usage
 3 message  assistant
 4 pending  承認待ちを設定
 5 message  tool: タイムアウト（30秒）で中断しました
 6 pending  承認待ちを解除
 7 usage
 8 message  assistant: コマンドを実行しましたが…
```

#### 二重実行は「減った」であって「消えた」ではない

ステップ6 の実験をやり直すと、**`ticks.txt` はやはり2行になる**。
ツールが走っている最中に `kill -9` したので、結果がまだ追記されていない = 承認待ちのまま。
再開すればもう一度実行する。

改善したのはここ。

| | 旧（run 単位で snapshot） | 新（エントリ単位で追記） |
|---|---|---|
| 完了したツールの結果 | run が終わるまで消えうる | 即座に残る |
| run 途中のやり取り | 丸ごと失われる | そこまで全部残る |
| 実行中に落ちた1件 | 再実行される | **再実行される（変わらず）** |

**実行中に落ちたツールが完了したかどうかは、外から見て分からない。**
粒度を上げても最後の1件は残る。ここは at-least-once を選んだ、という判断であって実装の不足ではない。

### 5. steering / follow-up キュー

pi にあって我々に無かった、唯一の**エージェント側**の機能。
「走っている最中に口を挟む」と「止まろうとした瞬間に続きを渡す」の2つ。

単一の `while` では表現できず、ループが二重になる。

```
outer: 止まろうとしたときに follow-up があるか
  inner: while (ツール呼び出しが続く || 割り込みが来ている)
           ├ 溜まっている割り込みを user メッセージとして注入してから LLM を呼ぶ
           ├ ツール実行
           └ getSteeringMessages() を poll
```

| | いつ届くか | 使いどころ |
|---|---|---|
| **steering** | ターンの合間。実行中のツール呼び出しは飛ばさない | 「やっぱり違う、こっちにして」 |
| **follow-up** | エージェントが終わろうとした瞬間 | 「終わったら次にこれもやって」 |

poll するのは**開始時**（待っている間に打たれた分）と**各ターンの後**の2箇所。
pi は3箇所で、間に `prepareNextTurn`（compaction など長い処理）の後がある。
我々はそのフックが無いので2箇所で足りる。

#### キューを持つのは transport

承認・中断と同じ結論になった。`Agent` は `getSteeringMessages()` を呼ぶだけで、
誰が積んだかは知らない。`Sessions` が `MessageQueue`（12行）をスレッドごとに持ち、注入する。

| transport | 割り込みの入り口 |
|---|---|
| `stdio` | 作業中に打たれた行（`rl.on("line")`） |
| `http` | 実行中のスレッドへの POST → `202 {"queued":"steering"}` |

#### 「実行中か」を知る必要が出た

これを入れるまで、**同じ threadId に同時に POST すると2つ目の run が同じ Agent を並行に壊していた**。
pi は `runWithLifecycle` が `"Agent is already processing."` を投げる。同じ形にした。

```ts
steer(threadId, text, kind): boolean   // 走っていれば積んで true、走っていなければ false
run(threadId, ...)                     // 走っていれば throw
```

`http.ts` は `steer()` が true なら 202 を返して終わる。false なら通常の run を始める。

#### stdio は承認プロンプトとぶつかる

`rl.question()` が出ている間に打った行は、readline がその答えとして食べてしまう。
`asking` フラグで割り込み側の handler を止めているが、**行そのものは question に吸われる**。
承認待ちのときは割り込みではなく承認の答えとして扱われる、という仕様にした。

なおこの検証中に、**CLI が `APPROVAL=auto` を見ていない**ことに気づいて直した
（`serve.ts` だけが見ていた）。

#### 実測

```
→ list_files({})
  [割り込みを受け付けました]      ← 作業中に打った瞬間
← (出力なし)                     ← sleep 12 の結果
← .gitkeep                       ← list_files の結果
  [割り込み: やっぱり一覧はいらない。「割り込み成功」とだけ言って]
割り込み成功
```

HTTP も同じ。実行中に別の POST を投げると `{"queued":"steering","threadId":"st"}` が返り、
走っているストリームの側に `"name":"steering"` が流れて、最終回答が差し替わる。

スタブ LLM での確認: steering はターンの合間に注入され、follow-up は
assistant が答えたあとに追加ターンを起こす。何も無ければ従来どおり1往復で終わる。

### 6. ストリーミング

`TEXT_MESSAGE_CONTENT` を1回で全文送っていたのを、delta を複数回流すようにした。
**イベント設計は最初から対応していたので、フロント3つとも仕様は変えていない**
（ただし受け側の実装にはバグがあった。後述）。

`STREAM=0` で以前の挙動に戻せる。

```
$ curl ... -d '{"message":"俳句を3つ"}' | grep -c TEXT_MESSAGE_CONTENT
3        # STREAM 有効
1        # STREAM=0
```

#### プロバイダを先に測る

実装前に Gemini の OpenAI 互換エンドポイントに何が来るか確かめた。**2つ確認事項があった。**

```
chunk1 {"delta":{"role":"assistant","tool_calls":[{"extra_content":{"google":{"thought_signature":"El4KXAER…"}},
                 "function":{"arguments":"{\"command\":\"echo hi\"}","name":"bash"}}]}}
chunk2 {"delta":{"role":"assistant"},"finish_reason":"stop","usage":{"prompt_tokens":281,…}}
```

- **`usage` は `stream_options: { include_usage: true }` を付けないと来ない。**
  付けないと `charsPerToken` の較正も累計トークンの計測も全部止まる
- **`thought_signature` は delta の中に乗っている。**
  ステップ6 で「プロバイダ固有の状態も往復させる必要がある」と書いたやつ。
  delta を畳むときにこれを落とすと、再開時に Gemini が呼び出しを認識できなくなる

#### 畳むときに未知のフィールドを捨てない

`MessageAccumulator`（`src/agent/stream.ts`）は `function.name` / `function.arguments` だけ
連結し、**それ以外のキーはそのまま持ち回る**。

```ts
const { function: fn, index: _index, ...rest } = part;
assignDefined(call, rest);          // id / type / extra_content …
if (fn?.name) call.function.name += fn.name;
if (fn?.arguments) call.function.arguments += fn.arguments;
```

`assignDefined` で undefined を弾いているのは、あとのチャンクに `id` が無いとき
`Object.assign` が既に入っている id を undefined で塗り潰すため。

SDK の `client.chat.completions.stream()` を使えば畳み込みは書かずに済むが、
既知フィールドから組み直す実装なので `extra_content` が残る保証がない。手で畳むことにした。

#### リトライできるのは最初のチャンクが来る前だけ

429 のリトライはストリーミングと相性が悪い。**1文字でも流したあとに投げ直すと、
同じメッセージが二重に表示される。**

```ts
let emitted = false;
try {
  return yield* this.generateStream(signal, () => { emitted = true; });
} catch (error) {
  if (emitted || attempt >= 5 || !isRetryable(error)) throw error;
  …
}
```

429 は最初のリクエストで返ってくるので実用上はこれで足りる。
途中で切れた場合は諦めて `RUN_ERROR` にする。

#### 受け側に隠れていたバグ

「フロントは無改修で対応できる」と踏んでいたが、**2つとも直す必要があった**。
delta が1回しか来ない前提で書かれていたため。

| | 症状 | 原因 |
|---|---|---|
| `render/cli.ts` | 1文字ごとに改行された | `console.log(delta)` していた |
| `public/index.html` | delta ごとに新しい行ができた | `add("msg", delta)` で毎回要素を作っていた |

CLI は `CliOutput` に `raw` を足して `process.stdout.write` に、
HTML は `messageId` / `toolCallId` をキーに要素を持ち回って `textContent += delta` にした。

**イベントの語彙が変わっていなくても、受け側の「1回で来る」という思い込みは残る。**
プロトコルが対応していることと、実装が対応していることは別だった。

ツール呼び出しの引数も `TOOL_CALL_ARGS` として delta で流れるようになった。
Gemini は1チャンクで返してくるので今は分割されないが、
長い引数を出すモデルではここが効く（コーディングエージェントの編集内容など）。

### 7. Interrupt の形もフックに決めさせる

ステップ1 で承認をフックに追い出したが、**中断の側にまだ承認が残っていた**。

```ts
// ループが決めていたもの
reason: "tool_approval",                                     // ← 用途が固定
responseSchema: { properties: { approved: { type: "boolean" } } },  // ← 応答の形が固定
const approved = (entry.payload as { approved?: boolean })?.approved === true;  // ← payload の解釈
```

承認以外の中断（「どのファイルにする？」と選ばせる、パスワードを聞く）を足そうとすると、
全部この3行を書き換えることになる。

#### 鍵は「再開時にもう一度フックを呼ぶ」

`resolve` のような関数を `suspend` の結果に持たせたくなるが、**関数は永続化できない。**
中断中にプロセスが落ちたら復元できない。

代わりに、**再開した1件だけ `resume` を添えて同じフックにもう一度聞く**ことにした。
フックは `cli.ts` / `serve.ts` が起動時に組み立てるので、別プロセスでも必ず存在する。

```ts
// loop.ts — payload の中身を知らない
const decision = await this.config.beforeToolCall?.({
  toolCallId: call.id, name, arguments: args, messages: this.messages,
  resume: i === startIndex ? resumed?.entry : undefined,
}, signal);
```

```ts
// approval.ts — payload の読み方を知っているのはここだけ
if (resume) {
  const approved =
    resume.status === "resolved" &&
    (resume.payload as { approved?: boolean })?.approved === true;
  return approved ? undefined : { kind: "block", reason: DENIED };
}
```

Interrupt の中身もフックが丸ごと持つ。ループが埋めるのは `id` と `toolCallId` だけ。

```ts
| { kind: "suspend"; interrupt: Omit<Interrupt, "id" | "toolCallId"> }
```

```ts
yield { …, outcome: { type: "interrupt",
  interrupts: [{ id: interruptId, toolCallId: call.id, ...decision.interrupt }] } };
```

#### `Pending` が1つ痩せた

再開時にフックが決め直すので、`denyReason` を往復させる必要が無くなった。

```ts
type Pending = {
  interruptId: string;
  calls: ChatCompletionMessageFunctionToolCall[];
  index: number;
  terminateSoFar: boolean;
};
```

**ループに承認の語彙は 0 件**になった。

```
$ grep -c "approved\|approve\|tool_approval\|denyReason\|requiresApproval\|拒否" src/agent/loop.ts
0
```

#### 検証

`status: "cancelled"`（payload 無し）も拒否として通ることを確認した。
これは AG-UI の `cancel()` が送ってくる形で、その解釈もフック側に移っている。

| 経路 | 結果 |
|---|---|
| HTTP `approved: true` | `TOOL_CALL_RESULT "hi"` |
| HTTP `approved: false` | `ユーザーが実行を拒否しました。…` |
| HTTP `status: "cancelled"` | `ユーザーが実行を拒否しました。…` |
| CLI `y` | `← hi` |

## コーディングエージェントにする

ここまでで足りていなかったのは3つだけだった。

| | 変更 |
|---|---|
| `WORKSPACE` | `sandbox` 固定をやめて環境変数に。`ROOT` も `import.meta.dirname` 相対から cwd 相対へ |
| `edit_file` | 差分編集。`write_file` は全文書き直しなので実コードだと破綻する |
| SYSTEM プロンプト | 「ファイル操作ができるアシスタント」→「コーディングエージェント」（168 → 411 文字） |

### `edit_file` の一意性ルール

`old_text` が**ファイル内でちょうど1箇所に一致すること**を要求する。

- 0 箇所 → どこを直すか分からない
- 2 箇所以上 → **モデルが意図した箇所と、実際に置換される箇所が食い違う**

数えてから断り、逃がし方をエラーメッセージで指示する。

```
エラー: old_text が 3 箇所に一致します。前後の行を含めて一意になるまで長くしてください。
```

Claude Code の `str_replace` も pi の `edit-diff.ts` も同じ制約を持っている。
**「置換は一意でなければならない」は編集ツールの本質的な要件**で、
モデルの賢さで回避できるものではない。

### 練習用プロジェクト

`sandbox/practice/` に買い物カゴの計算とテスト。`applyCoupon` に意図的なバグが2つあり、
8 件中 2 件が落ちる（0 でクランプしない / percent の割引上限が無い）。

`.gitignore` は `sandbox/*` を除外したまま `!sandbox/practice/` で
ここだけ追跡する。**エージェントの変更を `git diff` で見せて、`git checkout` でやり直せる。**

### 実測: 自分で直させる

```
WORKSPACE=sandbox/practice APPROVAL=auto npm start
> src/cart.js のテストが落ちています。node --test で確認して、落ちているテストが通るように直してください。
```

```
→ list_files({})                  ← どんなプロジェクトか見る
→ list_files({"path":"src"})
→ bash({"command":"node --test"}) ← まず落ちることを確認
  ← exit 1
→ read_file({"path":"src/cart.js"})
→ read_file({"path":"src/cart.test.js"})   ← 期待値をテストから読む
→ edit_file({...})                ← applyCoupon を関数まるごと置換
  ← src/cart.js を編集しました（-7 +8 行）
→ bash({"command":"node --test"}) ← 通ることを確認
  ← ✔ subtotal は数量を掛けて合計する
```

| | |
|---|---|
| LLM 呼び出し | 8 回 |
| 累計入力トークン | 13,280 |
| 結果 | **8 pass / 0 fail**、差分は3行 |

**2つのバグが同じ関数の中にあるので、`edit_file` を2回呼ぶと1回目の置換で
2回目の `old_text` が変わってしまう。** モデルは関数まるごとを `old_text` にして
1回で置換した。一意性ルールがそのまま「まとめて直す」方向に働いている。

テストを先に走らせて落ちることを確認し、期待値をテストファイルから読み、
直してからもう一度走らせる。**この順序はプロンプトに書いた5行がそのまま出ている。**

## 判断済みのこと

- **OpenAI 互換エンドポイントを使う**（Google SDK ではなく）。Ollama / Groq への差し替えが `LLM_BASE_URL` だけで済む
- **サーバーはステートフル**（`Map<threadId, Agent>`）。AG-UI 標準のステートレス型ではなく、承認の往復をやりやすくするため
- **CopilotKit は必須ではない。** AG-UI だけ採用するのは合理的

## モデルの差し替え

OpenAI 互換エンドポイントを使っているので、環境変数だけで差し替えられる。コードは触らない。

```bash
# Gemini（デフォルト）
GEMINI_API_KEY=...

# Ollama（ローカル）
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=dummy
LLM_MODEL=qwen3:30b

# Groq
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_...
```

同じループが別のモデルで動くのを見るのが、それ自体いい練習になる。
小さいローカルモデルは tool calling が崩れやすいので、まずは Gemini で仕組みを固めてから試すとよい。

> Gemini 無料枠は **5 RPM**。1問で5〜6回叩くのですぐ枯れる。
> `agent/loop.ts` の `callModel()` に 429 リトライ（`retry in Xs` をパースして待つ）を入れてあるのはこのため。
