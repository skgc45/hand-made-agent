# 実装ノート

`hand-made-agent` を作る過程で取った記録。**使い方は [README](../README.md) にある。**

フレームワークを使わずに素朴に実装すると何が壊れるかを順に踏んで、対策を入れて、
前後の実測を取った記録が入っている。設計判断の経緯を追うときに読む。

---

## ステップ

- [x] 1. 素の while ループ
- [x] 2. bash ツール + 承認ゲート
- [x] 3. 会話が長くなってコンテキストが溢れる
- [x] 4. 捨てる代わりに要約する（compaction）
- [x] 5. 進捗を UI に出したくなる（AG-UI）+ 承認を Interrupt に載せ替え
- [x] 6. プロセスを再起動すると履歴が消える（永続化）
- [x] 7. 承認がツール名でしか効かない（権限ルール）
- [x] 8. 環境変数だけだと、決めたことを共有できない（設定ファイル）
- [x] 9. 効いている設定が分からなくなる（hma config）
- [x] 10. フックを足すたびにコードを触ることになる（外部プロセス）
- [x] 11. 毎回同じことを説明している（プロジェクト文脈・環境・plan）
- [x] 12. 探索が全部 bash を通る / 読まずに書き換える（ツールの質）← いまここ

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

`profile/` と `harness/` はこの縦の流れと**直交している**。エントリ（`cli.ts` /
`serve.ts`）が両方を組み立てて `session/` に渡す。

```
  profile/     何のエージェントか（system / toolset / 既定の権限ルール）

  harness/     ツール実行に何を挿すか。いまは承認ゲートだけ
    ↑
  permission/  ルールで allow / ask / deny を決める
    ↑
  settings/    .hma/*.json を重ねて読む。config.ts の既定になる
```

```
bin/hma.js             hma コマンド。サブコマンドを entry に振り分ける
src/cli.ts             エントリ: 層を組み立てて StdioTransport を起動
src/serve.ts           エントリ: 層を組み立てて HttpTransport を起動
src/config.ts          設定ファイル + 環境変数を1箇所に畳む
src/settings/index.ts  ~/.hma < .hma < .hma/settings.local.json を重ねて読む
src/shutdown.ts        SIGINT / SIGTERM → transport.stop()

src/agent/loop.ts      Agent クラス。AG-UI イベントを yield する async generator ← 本体
src/agent/stream.ts    ストリーミングの delta を1つのメッセージに畳む
src/agent/tools.ts     createFileTools(workspace) — ファイル操作ツール一式
src/agent/toolset.ts   interface Toolset（loop.ts が知る唯一のツールの姿）
src/agent/compose.ts   composeBefore / composeAfter — フックを1本に束ねる
src/agent/prompt.ts    SystemPrompt — base + 名前付きの節。system の文字列連結はここだけ
src/harness/index.ts   createHooks() — ツール実行に挿すものを組み立てる
src/harness/external.ts  設定から刺したフックを、ループの穴の形に変換する
src/harness/files.ts   read-before-edit ガードと、ツール結果の切り詰め
src/hooks/index.ts     外部プロセスの起動と、終了コード・標準出力の解釈
src/settings/trust.ts  .hma の「緩める方向」の中身に指紋を取り、本人の確認を覚える
src/context/index.ts   起動時に集める文脈（環境 / AGENTS.md / SessionStart / plan）
src/harness/approval.ts  権限の判定を承認ゲート（待つ / Interrupt）に変換する
src/permission/rules.ts  ルールの構文とマッチング（前方一致 / glob / 連結の分割）
src/permission/index.ts  deny > allow > ask の判定と、セッション中の allow
src/profile/index.ts   Profile 型と createProfile()
src/profile/sandbox.ts   sandbox を眺めるアシスタント
src/profile/coding.ts    コーディングエージェント
src/agent/trim.ts      charCount / trimNaive / splitSafe / trimSafe（文字数ベース）
src/agent/compact.ts   LLM に要約させる rolling compaction
src/agent/graph.ts     事実を抽出して持つ bi-temporal なグラフ（TRIM=graph）

src/session/index.ts   Sessions。Map<threadId, Agent> と store の読み書き
src/session/queue.ts   steering / follow-up の待ち行列。transport が積み Agent が drain する
src/store/index.ts     interface Store と createStore()
src/store/sqlite.ts      node:sqlite（既定）
src/store/file.ts        JSON ファイル
src/store/memory.ts      永続化しない（ステップ6 以前の挙動）
src/telemetry/index.ts interface Telemetry と toRow()
src/telemetry/clickhouse.ts  HTTP に JSONEachRow を投げるだけ
src/telemetry/noop.ts        既定。何もしない

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

→ ステップ11 で保存の粒度を上げ、[ステップ13](#ステップ13-で理解すること--二重実行は消せない分かるようにする)で
「消せないことは認めたうえで、**走ったかもしれない**と分かるようにする」ところまで進めた。

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

## ステップ7 で理解すること — ツール名では粗すぎる

ステップ2 の承認ゲートは `requiresApproval: Set(["bash"])` だった。ツール名でしか
判断できないので、選べるのは2つしかない。

- 毎回聞く → `ls` でも止まる
- `[a]lways` で通す → 以降 `rm -rf` まで通る

しかも `[a]lways` は `StdioTransport` の `Set` に入るだけで、プロセスが死ねば消える。

### ルールにする

`tool` か `tool(pattern)`。pattern の読み方は引数で決まる。

```
bash                    bash なら何でも
bash(npm run test:*)    末尾 :* は前方一致
write_file(src/**)      path を見るツールは glob
```

引数のどこを見るかにツールごとの表は持たない。`command` があればコマンド、無ければ
`path`。MCP でツールが増えても表を足さずに済む。

### 優先順位

```
deny → allow → ask → 既定（通す）
```

`deny` は `APPROVAL=auto` でも効く。既定が「通す」なのは、いまのプロファイルが
「bash だけ聞く」＝それ以外は通す、という現状を壊さないため。

### 連結コマンドで破れる

ここが素で書くと必ず落ちる穴。

```
bash(npm run test:*) を許可した状態で
npm run test && rm -rf /      ← 前方一致で通ってしまう
```

`&&` `||` `;` `|` と改行で切って、**全部の区間が allow に当たったときだけ通す**。
`deny` は逆に**1区間でも当たれば**止める。

クォートの中までは見ていない。`echo "a && b"` は余計に切れるが、切りすぎた側は
allow に当たらなくなるだけなので、緩む方向には壊れない。

前方一致にはもう1つ、コマンド置換の穴がある。

```
bash(npm run test:*) を許可した状態で
npm run test $(rm -rf /)      ← 先頭が一致する
```

中身を別に評価しないと判定できないので、**`$(` とバッククォートを含む区間は allow に
一致させない**（ask に落とす）ことにした。

### 前方一致は語の途中で切らない

```
bash(npm run test:*) は npm run tests-of-doom に当たらない
```

一致した残りが空白で始まるときだけ通す。素の `startsWith` だけだと、名前の似た別の
コマンドを巻き込む。

### 実測: 書き換えたルールがその場で効く

http で確かめた。承認 UI には**提案されたルールが出て、確定前に直せる**。

1. `ls -1` で Interrupt。metadata に `suggestedRule: bash(ls -1:*)`
2. `{"approved":true,"rule":"bash(ls:*)"}` で再開（提案より**広いルールに書き換えた**）
3. 次の `ls -1` は聞かれずに実行された
4. `ls -1 | head -2` は聞かれた。`head -2` が allow に当たらないため

4 が出るのが目的。ツール名で持っていたときは、ここが素通りしていた。

### 連結コマンドには「常に許可」を出さない

最初はここで提案ルールを出していたが、**受け入れても同じコマンドがまた聞かれる**。

```
コマンド : npm test && ls
提案ルール: bash(npm test:*)   ← ls が allow に当たらないので、結局 ask のまま
```

区間が複数あるコマンドと、コマンド置換を含むコマンドでは提案を出さないことにした
（CLI では自分で書けるし、書かなければ今回だけの承認になる）。**当たらないルールを
勧めるくらいなら、何も勧めないほうがいい。**

### ⚠️ これは防御ではない

`cwd` がセキュリティ境界でないのと同じで、権限ルールも**事故を減らすだけ**。シェルの
構文を正しく解釈しているわけではないので、抜ける書き方はいくらでもある。本気で閉じる
ならプロセスの外側（コンテナ / seatbelt）が要る。

実際に抜けられた。`deny: ["bash(rm:*)"]` の状態で `rm memo.txt` を頼むと、拒否された
モデルは**綴りを変えて同じことをやろうとする**。

```
1回目  rm memo.txt                                              → block
2回目  python3 -c "import os; os.remove('memo.txt') if ..."     → ask
```

2回目は `rm:*` に当たらないので `deny` をすり抜けている。止まったのは「ルールに
当たらないものは聞く」側の動きで、`deny` が効いたからではない。**`deny` はコマンドの
綴りを止めるだけで、意図は止めない。**

### まだやっていないこと

- **`acceptEdits` / `plan` モード。** いまのプロファイルは編集系を聞いていないので
  `acceptEdits` は `ask` と同じ挙動にしかならない。`plan` は「書けない」ことを system
  プロンプト側でも伝えないと、モデルが deny を食って空回りするだけになる

## ステップ8 で理解すること — 環境変数だけだと共有できない

ステップ7 の `[a]lways` はプロセスが死ねば消える。かといって環境変数に逃がすと、
今度は「このリポジトリでは `npm test` を許す」をチームで共有できない。逆にモデルや
ポートのような個人の好みは、共有したくない。**同じ「設定」でも寿命と共有範囲が違う。**

### 3層にする

```
~/.hma/settings.json        個人の既定。全プロジェクトに効く
.hma/settings.json          プロジェクト。コミットして共有する
.hma/settings.local.json    個人 × プロジェクト。gitignore
```

優先順位は **既定 < user < project < local < 環境変数**。

環境変数を一番上に置いたのは、README のこれを壊さないため。

```bash
CONTEXT_LIMIT=1200 TRIM=compact npm start
```

設定ファイルが環境変数に勝つと、一時的な実験ができなくなる。**設定は「普段の値」、
環境変数は「今回だけ」**。

### permissions だけマージの仕方が違う

スカラーは上の層が下を上書きするが、`allow` / `ask` / `deny` は**全層を連結する**。
上の層で下の `deny` を消せてしまうと、共有した禁止が個人設定で外せることになる。
プロファイルの既定（`ask: ["bash"]`）も同じ配列に合流する。

### プロジェクトは cwd で決まる。workspace ではない

設定ファイルが `workspace` を決められるので、workspace から設定を探すと循環する。
`.hma/` は**起動したディレクトリ**から探す。

### 鍵は設定ファイルから読まない

`GEMINI_API_KEY` / `LLM_API_KEY` は環境変数だけ。`.hma/settings.local.json` は
gitignore してあるとはいえ、鍵をファイルに書く習慣を作らないため。

### 壊れた設定は、黙って無視されるのが一番困る

読んだ時点で言う。

```
.hma/settings.local.json: 未知のキー: typo
.hma/settings.local.json: port は number である必要があります
.hma/settings.json: ルールの書式が不正です: bash(x
```

特に**ルールの書式**は、間違っていても「1つも当たらない」だけで普通に動いてしまう。
`bash(npm test` と書いて「なぜか毎回聞かれる」のを自力で気付くのは難しい。

### `[s]ave` を足した

```
許可する? [y]es / [n]o / [a]lways / [s]ave:
許可するルール [bash(cat memo.txt:*)]: bash(cat:*)
  .hma/settings.local.json に保存しました
```

`a` はプロセスが生きている間だけ、`s` は `.hma/settings.local.json` に書く。
**共有される `.hma/settings.json` には勝手に書かない。** あちらはレビューして
コミットするもの。

### 実測: 別ディレクトリに設定を置いて動かす

```json
// /tmp/proj/.hma/settings.json
{
  "workspace": "work",
  "permissions": { "allow": ["bash(ls:*)"], "deny": ["bash(rm:*)"] }
}
```

`hma serve` をそのディレクトリで起動して、

1. バナーが `sandbox:work` になる（workspace も設定から来ている）
2. `ls -1` は**聞かれずに実行**された
3. `rm memo.txt` は「権限ルールで禁止されています」で止まった
4. ルールに無い `cat memo.txt` は Interrupt。`{"approved":true,"rule":"bash(cat:*)","save":true}`
   で再開すると `.hma/settings.local.json` が書かれた
5. **サーバを再起動しても `cat` は聞かれない**

5 がステップ7 との差。

### 起動時にどのファイルを読んだか出す

```
設定: .hma/settings.json < .hma/settings.local.json
```

設定ファイルの一番の害は「この値がどこから来たのか分からない」ことなので、
少なくとも**どのファイルが効いているか**は毎回出す。

### まだやっていないこと

- **CLI フラグ**は `--profile` / `--workspace` だけ（`flags > env > files`）
- **再読み込み**。起動時に1回だけ読む

## ステップ9 で理解すること — 効いている設定が分からなくなる

ステップ8 で層が3つになり、その上に環境変数と CLI フラグが乗った。**値の出所が5通り**
ある。起動時のバナーは「どのファイルを読んだか」までしか言わない。

```
$ hma config
設定ファイル: ~/.hma/settings.json < .hma/settings.json < .hma/settings.local.json

  LLM_MODEL       user-model                                                ~/.hma/settings.json
  LLM_BASE_URL    https://generativelanguage.googleapis.com/v1beta/openai/  既定
  GEMINI_API_KEY  （設定済み）                                              環境変数
  PROFILE         coding                                                    フラグ
  WORKSPACE       work                                                      .hma/settings.json
  TRIM            compact                                                   環境変数 TRIM
  STORE           file                                                      ~/.hma/settings.json
  STORE_PATH      .threads                                                  既定
  …

権限ルール（deny > allow > ask の順に見る。どれにも当たらなければ通す）:
  deny   bash(curl:*)  ~/.hma/settings.json
  deny   bash(rm:*)    .hma/settings.json
  allow  bash(ls:*)    .hma/settings.json
  allow  bash(cat:*)   .hma/settings.local.json
  ask    bash          プロファイル sandbox
```

### 出所を持つのは設定側、優先順位を知っているのは config.ts

`loadSettings()` は**スカラーごとに「最後に値を置いた層」**を覚える。ルールは層をまたいで
連結するので、こちらは**1本ずつ出所を持つ**（マージの仕方が違うので、記録の仕方も違う）。

その上に環境変数とフラグを重ねているのは `config.ts` なので、説明する関数も `config.ts`
に置いた。`describeConfig()` がやっているのは**優先順位をもう一度なぞること**だけで、
値そのものは既に決まっている定数を読んでいる。**決める場所と説明する場所が離れると、
説明のほうが嘘になる。**

### 鍵は値を出さない

`GEMINI_API_KEY` だけは `（設定済み）` / `（未設定）` にした。設定を人に見せるための
コマンドが、そのまま鍵の表示装置になっては困る。

### これは次のステップの道具でもある

ステップ10 でフックを設定ファイルから刺せるようにすると、「なぜこのコマンドが走ったのか」
が設定ファイルを読まないと分からなくなる。`hma config` はその答え合わせに使う。

## ステップ10 で理解すること — フックがコードの中にあると誰も刺せない

土台A で `beforeToolCall` を合成できるようにしたが、**刺せるのは TypeScript を書ける
人だけ**だった。「編集したら必ず `tsc --noEmit` を走らせる」をやるのに `loop.ts` を
触るのはおかしい。

### 設定から刺す

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "command": ".hma/scripts/block-secrets.sh" }
    ],
    "PostToolUse": [
      { "matcher": "edit_file", "command": "npm run typecheck 2>&1 | tail -5" }
    ],
    "UserPromptSubmit": [{ "command": ".hma/scripts/add-context.sh" }],
    "Stop": [{ "command": ".hma/scripts/checklist.sh" }]
  }
}
```

`matcher` は**権限ルールと同じ書式**（`bash` / `bash(npm run test:*)` /
`write_file(src/**)`）。ツールの引数のどこを見るかの決まりを2つ持ちたくない。
省略すると全部に当たる。

### 契約は終了コードで決まる

```
exit 0   通す。標準出力が JSON なら decision / reason / additionalContext を読む
         JSON でなければ、その文字列がそのまま context になる
exit 2   止める。標準エラーがそのまま「なぜ止めたか」としてモデルに渡る
その他   警告して通す。フックの失敗でエージェントは止めない
```

最後の1行が効く。フックはユーザーが書いた野良スクリプトなので、**落ちるのが普通**。
落ちたら止まる作りにすると、誰も怖くて刺せない。タイムアウト（既定30秒）も同じ扱い。

入力は stdin に JSON で渡す。フックが stdin を読まずに終わると EPIPE になるが、
これは失敗ではないので握り潰す。

### 4つの穴

| イベント | 刺さる場所 | できること |
|---|---|---|
| `PreToolUse` | `beforeToolCall` | `block` で止める / `allow` で承認を飛ばす |
| `PostToolUse` | `afterToolCall` | ツール結果に追記する |
| `UserPromptSubmit` | `run()` の冒頭 | 入力を止める / 文脈を足す |
| `Stop` | `getFollowUpMessages` | 止まろうとしたところで続けさせる |

**`Stop` はすでに穴が空いていた。** ステップ「pi を元にエンハンスする」で入れた
follow-up キューがそのままの形だったので、Sessions の口を足すだけで済んだ。

### フックは権限ルールより先に見る

```ts
composeBefore([
  preToolUse(HOOKS.PreToolUse),          // 先
  approvalHook(permissions, ask, save),  // 後
])
```

土台A で決めた「先に値を返したほうが勝つ」がそのまま効く。つまり**フックの `allow` は
`deny` ルールも飛ばす**。危なく見えるが、フックもルールも同じ設定ファイルから来るので
信頼の度合いは同じ。分けても嘘の安心にしかならない。

### `allow` をループの語彙に足した

`BeforeToolCallResult` に `{ kind: "allow" }` を足した。「undefined を返せば実行する」
のままだと、**フックが「実行していい」と言っても後ろの承認ゲートに聞きにいってしまう**。
`loop.ts` 側は suspend でも block でもないので何も変えずに済んだ。

### Stop フックは1 run に1回しか呼ばない

```
止まろうとする → Stop が「続けろ」と言う → 答える → 止まろうとする → …
```

素直に書くと止まれなくなる。Sessions が run ごとに印を持って、**2回目以降は呼ばない**。

### 実測

`ask: ["bash"]` のプロジェクトに4つ刺して動かした。

```
PreToolUse   bash  block-secrets.sh   .env を含むコマンドを exit 2 で止める
PreToolUse   bash  auto-allow-ls.sh   ls で始まれば {"decision":"allow"}
PostToolUse  bash  count-lines.sh     結果の行数を数えて足す
UserPromptSubmit   add-context.sh     「回答は必ず了解で始めること」を足す
```

- `ls -1` は **承認を聞かれずに実行**され、結果が
  `memo.txt\n\n[フック] 結果は 1 行でした` になった（allow と PostToolUse が同時に効いた）
- `cat .env` はツール結果が `.env には触れない決まりです。` になった。承認は**聞かれていない**
  （フックのほうが先なので）
- モデルの答えは `了解` で始まった
- `Stop` に「毎回続けろ」と言うフックを刺しても、1往復だけ伸びて止まった

なお、これらは**すべて `hma trust` で承認したあとの話**（次の節）。

`gate` イベントにもそのまま出る。`allow` は `run`、`block` は `block`。

### ⚠️ 「設定から刺せる」は「任意のコードが走る」ということ

フックは**承認を通らない**。実測するとこうなる。

```
フックから見た環境変数: SECRET-abcdef     ← GEMINI_API_KEY がそのまま見える
フックの cwd:          起動したディレクトリ
フックのユーザー:        あなた自身
```

そして `.hma/settings.json` は**コミットして共有する**ものなので、素直に作ると
**そういうリポジトリを clone して `hma` を起動した瞬間に、他人の書いたコマンドが自分の
権限で走る。**

もう1つ、エージェント自身が経路になる。`hma code`（引数なし＝ workspace が cwd）だと
`write_file` は承認を通らないので、こう書ける。

```
write_file .hma/settings.json        -> 57 文字を書き込みました      ← フックを仕込む
write_file .hma/settings.local.json  -> 34 文字を書き込みました      ← allow: ["bash"] を書き足す
```

ステップ7 で見た「`deny` は綴りを止めるだけ」よりも深い。**ルールそのものを次回のために
書き換えられる。**

### だから、初回に本人へ見せて聞く

`.hma` の中身のうち**緩める方向のものだけ**（フックと `allow`）を並べて聞く。

```
$ hma
このディレクトリの .hma に、あなたの権限で動くものが入っています:
  実行  PreToolUse (bash) .hma/scripts/block-secrets.sh  ← .hma/settings.json
  実行  Stop .hma/scripts/checklist.sh                   ← .hma/settings.json
  許可  bash(ls:*)                                       ← .hma/settings.local.json

実行はあなた自身の権限で、承認を通らずに行われます（環境変数も見えます）。
信頼しますか? [y]es / [n]o:
```

- **`deny` と `ask` は聞かない。** 締める方向なので、信頼が無くても効かせる
- **`~/.hma` は聞かない。** 本人が置いたもの
- 断っても止まらない。**フックと `allow` を落としたまま動く**
- 承認したら、その内容の sha256 を `~/.hma/trust.json` に**プロジェクトの絶対パスごと**記録する

内容が1文字でも変われば指紋が変わるので、また聞く（実測: `.hma/settings.json` を1文字
変えたら5本とも「未信頼のため無効」に戻った）。ただし**本人が `[s]ave` で足した `allow`
は聞き直さない**。承認したのは本人なので、書いたあとに指紋を取り直している。

`hma serve` は入力を待てないので聞けない。**無効にして、何が無効かと `hma trust` を
案内する**。

### 実測

| | 未信頼 | 信頼後 |
|---|---|---|
| `ls -1`（`auto-allow-ls.sh` が `allow` を返す） | 承認を聞かれる（`gate: ask`） | 聞かれず実行 |
| `PostToolUse` の追記 | 無し | `memo.txt\n\n[フック] 結果は 1 行でした` |

### 残っている穴

`bash` 経由の書き込み（`echo x > .hma/settings.json`）は `deny` できない。コマンドの
中身からリダイレクト先を読むのは、ステップ7 で「やらない」と決めた領域。いま書ける
一番強い対処はこれで、実測で効くことは確認した。

```json
"deny": ["write_file(.hma/**)", "edit_file(.hma/**)"]
```

### まだやっていないこと

- **フック自身の計測。** `gate` は「止まった」ことしか言わず、**どのフックが止めたか**は
  残らない。フックはイベントを yield できる場所にいないので、`gate` と同じ形の問題が
  もう一段深いところにある
- **`PreToolUse` の `additionalContext`。** 置き場所が無いので読み捨てている

## ステップ11 で理解すること — 毎回同じことを説明している

「作業対象は work」「回答は日本語で」「このリポジトリではバッククォートで囲む」。
**毎回言うことになる。** プロファイルの `system` に書けばいいが、それはコードなので
プロジェクトごとには変えられない。

土台B で `SystemPrompt` を名前付きの節にしてあるので、**足すのは `prompt.set()` だけ**。
集めるほうだけ書けばいい。

### 集めるのは Agent の外

`agent/` は「IO を一切知らない」層なので、ファイルを読むのも `git` を叩くのも外でやる。
`collectContext()` が起動時に1回だけ集めて、`AgentConfig.sections` として渡す。

```
## いまは計画モード      ← APPROVAL=plan のときだけ
## 環境                  ← cwd / 触ってよい場所 / OS / 日付 / git
## このプロジェクトの決まり ← AGENTS.md（cwd から上へ辿って集める）
## 起動時に集めた情報     ← SessionStart フックの出力
```

`AGENTS.md` は **cwd から上に辿って**、外側にあるものから順に並べる。外側ほど一般的で、
内側ほど具体的なので、後に来たほうが効く。`~/.hma/AGENTS.md` が一番外側。

**1ファイル8000文字で切る。** 長い `AGENTS.md` を置くと、それが**毎ターン効いてくる**。
黙って効くのが一番困るので、切ったら警告を出す。

### `plan` モードは、専用の判定を足さずに deny へ展開する

ステップ7 で見送ったのは「どのツールが読むだけか」を権限の層が知らなかったから。
プロファイルに `readOnly` を申告させて、**読まないツールを全部 `deny` に展開**した。

```
$ APPROVAL=plan hma config
権限ルール（deny > allow > ask の順に見る。どれにも当たらなければ通す）:
  deny   write_file    plan モード
  deny   edit_file     plan モード
  deny   bash          plan モード
  ask    bash          プロファイル sandbox
```

判定側には `plan` という分岐が要らない（`ask` と同じ）。**ツールが増えても、
プロファイルが `readOnly` に入れない限り自動で止まる側になる。**

そして、ステップ7 で「system プロンプト側でも伝えないと空回りする」と書いたほうも、
いまは節を1つ足すだけで済む。実測すると、モデルは**実行せずにコマンドを書いて出した**。

```
$ APPROVAL=plan hma
> memo.txt の中身を全部大文字に書き換えて
【proj4】
実行するコマンド：
    tr '[:lower:]' '[:upper:]' < memo.txt > memo.txt.tmp && mv memo.txt.tmp memo.txt
```

ファイルは変わっていない。

### 実測: 効くが、毎ターン効く

`AGENTS.md` に「回答の先頭に必ず【proj4】と書く」「ファイル名はバッククォートで囲む」と
書いて動かした。

```
> work にあるファイルを1つ挙げて。あと今日の日付と git のブランチも教えて
【proj4】
work にあるファイルは `memo.txt` です。
今日の日付は 2026-09-11、git のブランチは master です。
```

日付もブランチも**ツールを呼ばずに**答えている。環境ブロックが効いている。

コストも測った。同じ「こんにちは」を投げて `ctx`（prompt tokens）を比べる。

| 節 | 文字数 | 増えたトークン |
|---|---|---|
| 環境 | 331 | **+196** |
| このプロジェクトの決まり（`AGENTS.md`） | 65 | +48 |
| 起動時に集めた情報（`SessionStart`） | 21 | +24 |

合計で**毎ターン約 270 トークン**。**7割が環境ブロック**で、中身はほとんど絶対パスだった。
日本語はだいたい1文字1トークンなので、`AGENTS.md` は文字数がそのままコストになる。

`hma config` に文字数を出すようにしたのはこのため。

```
system プロンプトに載る文脈:
  環境                      331 文字
  このプロジェクトの決まり  65 文字
  起動時に集めた情報        21 文字
```

### `SessionStart` は信頼の対象、`AGENTS.md` は対象外

`SessionStart` は**コマンドを実行する**ので、ステップ10 の信頼確認を通る（未信頼なら
走らない。実測で「起動時に集めた情報」の節が消えた）。`AGENTS.md` は**ただのテキスト**
なので確認しない。ただし clone したリポジトリの `AGENTS.md` は**モデルへの指示**として
効くので、無害ではない。

### まだやっていないこと

- **`AGENTS.md` の再読み込み。** 起動時に1回だけ。編集しても効くのは次回から
- **節ごとのトリム。** `contextLimit` を超えたとき、削られるのは会話のほうで、
  文脈の節は最後まで残る。`AGENTS.md` が大きいと**その分だけ会話が短くなる**

## ステップ12 で理解すること — ツールが粗いと、承認もコンテキストも巻き添えになる

ツールが `list_files` / `read_file` / `write_file` / `edit_file` / `bash` の5つしかないと、
**探索が全部 `bash` を通る**。`bash` は `ask` なので、探すたびに聞かれる。聞かれるのが
嫌で `[a]lways` すると、今度は何でも通る。

### `glob` と `grep` を足す

副作用が無いので `ask` の対象にならない。これだけで承認の回数が変わる。

同じ質問（「`composeBefore` を定義しているファイルと、使っているファイルを全部挙げて」）を
`src/` を作業対象にして投げ、`glob` / `grep` を `deny` した場合と比べた。

| | ツール呼び出し | 内訳 | 入力トークン |
|---|---|---|---|
| `glob` / `grep` あり | **1** | grep 1 | **2,023** |
| 無し（`bash` に落ちる） | 20 | bash 3 / list_files 13 / read_file 2 | 32,983 |

**承認を求める回数は 3 → 0、入力トークンは 16 分の1。** `list_files` を13回叩いて
ディレクトリを1つずつ降りていたものが、`grep` 1回で終わる。

ツールを足すのは「できることを増やす」ためだと思いがちだが、ここでの効果は
**できることを減らさずに、聞く回数とトークンを減らす**ことだった。

### 読んでいないファイルを書き換えさせない

モデルは「たぶんこう書いてあるはず」で `edit_file` を投げる。`old_text` の一意性
チェック（ステップ「コーディングエージェントにする」）はその後の話で、**そもそも中身を
見ていない**のが先にある。

`beforeToolCall` に1本足した。承認より**先**に見る。許可しても、読んでいなければ書かせない。

```
> read_file を使わずに、いきなり edit_file で memo.txt の alpha を ALPHA に変えて

  ← memo.txt をまだ読んでいません。read_file で現在の中身を確認してから書き換えてください。
  ← alpha\nBRAVO\ncharlie        ← モデルが read_file を呼び直した
  ← memo.txt を編集しました（-1 +1 行）
```

**止めるだけでなく、次に何をすればいいかを結果として返す**と、モデルは自分で復帰する。

読んだ時刻（mtime）も覚えていて、**読んだあとに外で変わっていたら**もう一度止める。
自分で書いたぶんは「読んだこと」にする（でないと2回目の編集が通らない）。

### 出力を切る

`bash` の `maxBuffer` は 1MB で、それがそのまま履歴に入る。**自分でコンテキストを溢れ
させて、自分で trim を誘発していた。** 300行 / 15000文字で切って、切ったことと残り行数を
書く。

切ってからフックに渡す。**モデルが見るものとフックが見るものを揃える**ため。

### `readOnly` を `kinds` にした

ステップ11 でプロファイルに `readOnly` を足したが、`acceptEdits` には「編集するツール」の
ほうが要る。2つのリストを持つより、1つの表にした。

```ts
kinds: {
  list_files: "read", read_file: "read", glob: "read", grep: "read",
  todo_write: "read",                    // 副作用が無いという意味
  write_file: "edit", edit_file: "edit",
  bash: "execute",
}
```

- `plan` → `read` 以外を `deny`
- `acceptEdits` → `edit` を `allow`

**種類の分からないツールは `read` 扱いしない。** ツールが増えたとき、止まる側に倒れる。

### `acceptEdits` がここで意味を持つ

ステップ7 で「いまのプロファイルは編集を聞いていないので `acceptEdits` は `ask` と
同じ」と書いた。`coding` プロファイルの既定を変えて、**編集も聞く**ようにした。

```
$ APPROVAL=ask hma code
  edit_file を実行しようとしています        ← 聞かれる
  許可するルール [edit_file(memo.txt)]:

$ APPROVAL=acceptEdits hma code
  ← memo.txt を編集しました（-1 +1 行）     ← 聞かれない。bash は聞かれたまま
```

`sandbox` プロファイルは変えていない。ステップ1〜6 の説明が変わってしまうため。

### `todo_write` は入れたが、出し先が無い

手順が3つ以上あるときに一覧を記録させるツール。ただし**状態を表示する口が無い**。
ツール結果として返るので履歴には残るが、UI に出すには AG-UI の `STATE_SNAPSHOT` が要る
（未実装のまま残しているもの）。いまは**モデル自身の整理**にしかなっていない。

### まだやっていないこと

- **`read_file` の範囲指定。** 切られた続きを読む手段が `grep` と `bash` しかない
- **`grep` は自前実装。** `.gitignore` を見ないので `node_modules` も舐める。
  上限200件で止まるだけ

## ステップ13 で理解すること — 二重実行は消せない。分かるようにする

ステップ6 で踏んだ穴の続き。`execute` → 結果を積む、の順なので**副作用の直後に落ちると結果だけが残らない**。
ステップ11 で保存の粒度を上げても最後の1件は残った。

再実行するかどうかは決められない。決められるのは**落ちたことを知っているかどうか**のほうで、
ステップ13 はそこだけをやる。

### 実行する前に印を残す（write-ahead）

```ts
// 実行する前に印を残す。結果が積まれないまま落ちたら、
// 次の起動で「走ったかもしれない」と言える
await this.record({ kind: "attempt", toolCallId: call.id, name });
result = await this.config.toolset.execute(name, JSON.parse(args), signal);
```

`attempt` は同じ `tool_call_id` の tool 結果が積まれた時点で閉じる。これで跡が3通りに分かれる。

| ログ | 意味 | 再実行 |
|---|---|---|
| attempt 無し・結果無し | 実行する前に落ちた | **安全** |
| attempt あり・結果無し | 実行中に落ちた | **走ったかもしれない** |
| attempt あり・結果あり | 完了 | — |

印が無ければ「実行前に落ちた」と断定できる。**印を足した価値はここで、
悲観的に全部を「走ったかもしれない」と言わずに済む。** コストはツール1回につき追記1行。

### 結果の無い `tool_calls` を埋める

落ちた run が残す壊れ方はこれ1つ。`replay()` の最後で、結果の無い `tool_call` を合成の tool 結果で埋める。
承認待ちの分（これから実行する）は触らない。

**追記はしない。** 同じログからは毎回同じ結果になるので、`replay` は純粋なまま置ける。

```
追記ログ（自動実行のツールが、副作用を出した直後に落ちた）:
 1 message   user       tick して
 2 usage
 3 message   assistant  (tool_calls: tick)
 4 attempt   tick       ← 実行する前に置いた印
                        ← ここで落ちる（ticks.txt は1行）

次の起動で組み直した messages:
  user      "tick して"
  assistant ["tick"]
  tool      "実行の途中でプロセスが落ちたため、結果が残っていません。
             副作用が出たかどうかは外から分かりません（実行された可能性があります）。"
```

### 穴あきのままだと、モデルは「実行しました」と言う

400 で弾かれると思っていたが、Gemini の OpenAI 互換エンドポイントは**通してしまう**。
同じ会話を穴あきのまま投げた場合と、埋めてから投げた場合。

```
穴あきのまま: はい、裏側で「tick」のシステム処理（タイマーや定期的な動作のトリガー）を実行しました。
埋めたあと:   おそらく実行途中でエラー（プロセスのクラッシュ）が発生したため、正常に完了したかどうかは
              **不明**です。…もう一度同じ処理を行いますか？
```

**埋めるのはプロトコルを満たすためではなく、モデルに嘘をつかせないため。**
穴を見せられたモデルは、走ったことにして話を進める。

### 承認待ちのまま落ちた場合

こちらは `pending` が残るので、合成の結果では埋めない（これから実行する分だから）。
代わりに `attempted` をフックまで渡す。

```
A. 承認待ちで止まる                    [gate] ask → interrupt「tick を実行しますか？」
B. 承認 → 実行 → 副作用の直後に kill     ticks.txt 1行 / attempt が残る
C. 同じ resume をもう一度送る            [reexec] {"tool":"tick"} → ticks.txt 2行
D. 新しいクライアントが話しかける         interrupt「⚠ 前回このツールは実行を始めたまま
                                        落ちています。/ tick を実行しますか？」
```

**C は二重実行のまま。** クライアントが「承認済み」と言い張っているので通す。
黙って通らないだけで、`reexec` イベントとして CLI にも ClickHouse にも1行残る。
**D は承認をやり直す。** 二重実行にするかどうかを人が決める、という形に落ちた。

### 変わったこと / 変わらないこと

| | ステップ12まで | いま |
|---|---|---|
| 実行前に落ちた1件 | 黙って再実行 | 「未実行」と分かる |
| 実行中に落ちた1件 | 黙って再実行 | 「走ったかもしれない」と出す。人が決める |
| 結果の無い `tool_calls` | モデルが成功と誤解する | 事実を伝える |
| at-least-once | — | **変わらず** |

**この節で消えたのは二重実行ではなく、二重実行が黙って起きることのほう。**

### まだやっていないこと

- **冪等キー。** ツール側が「同じ呼び出しは1回」を保証すれば本当に消せるが、`bash` には渡せない
- **`attempt` の掃除。** 閉じた印も追記ログに残り続ける（ツール1回につき1行）

## ステップ14 で理解すること — サブエージェントは「並列化」ではなく「コンテキストの隔離」

別のエージェントに任せると、**その往復が親の履歴に入らない**。速くするためではなく、
親のコンテキストを汚さないための道具。

### Task(subagent_type) ではなく、ツールを2つに分けた

Claude Code は `Task` 1つに `subagent_type` を渡す。我々は `explore` と `delegate` の
**別々のツール**にした。権限ルールがツール名で効くので、そのほうが噛み合う。

```
$ APPROVAL=plan hma config --profile coding
  deny   write_file  plan モード
  deny   edit_file   plan モード
  deny   bash        plan モード
  deny   delegate    plan モード      ← explore は残る
```

`kinds` に `explore: "read"` / `delegate: "execute"` と書くだけで、plan モードでは
**調査だけ任せられて、作業は任せられない**という形になる。引数で種類を選ぶ設計だと、
ルールの pattern（`command` か `path` を見る）にサブエージェントの種類を足すことになって、
[ステップ7 で決めた「表を増やさない」](#ルールにする)に反する。

| | explore | delegate |
|---|---|---|
| 渡す道具 | `read` のものだけ | 親と同じ全部 |
| ターン上限 | 12 | 20 |
| `kinds` | `read` | `execute` |

子は子を呼べない（深さ1）。会話は store に残さず、メモリだけで捨てる。

### 実測: 親のコンテキストが汚れない

同じ質問（「ツールの結果が履歴に積まれるまでに通るフックを順番に説明して」）を
`src/` に投げた。

| | 親が自分で読む | explore に任せる |
|---|---|---|
| 親のツール呼び出し | 多数（messages 60） | **1** |
| 親の累計入力トークン | **340,529** | **4,437** |
| 子の入力トークン | — | 123,651 |
| 合計 | 340,529 | **128,088** |

親の文脈は `ctx 1,523 → 2,914` しか増えていない。**読んだ中身ではなく、報告だけが入る。**
合計でも安いのは、親が全文を抱えたまま何度も往復していたから。

### 道具があるだけでは選ばれない

1回目は `explore` を渡しても**使わなかった**。自分で `list_files` と `grep` を
繰り返して 340,529 トークン使った。system に「選び方」を書いても変わらない。

```
道具の選び方:
- 当たりが付いていない調べもの（…）は explore に任せる。
- 1〜2ファイル読めば済むときは自分で読む。任せるほうが遅くなる。
```

上の実測は「explore に任せて」と明示したときのもの。**小さいモデルでは、任せる判断まで
含めて期待できない。** Claude Code の system プロンプトが Task の使いどころを
くどく書いているのは、たぶんこれが理由。

### 上限で殺すと、使ったトークンが丸損になる

最初はターン上限で `AbortController` を叩いて止めた。結果はこうなった。

```
  └ explore: 12 ターン / ツール 12回 / 入力 139433 — 上限で打ち切り
  ← (サブエージェントは何も返しませんでした)
```

**139,433 トークン使って報告ゼロ。** 殺すのではなく、門番で**道具だけ取り上げる**ように変えた。

```ts
if (overBudget()) return { kind: "block", reason: CAPPED };
```

`CAPPED` は「これ以上は道具を使えません。ここまでで分かったことだけで報告してください」。
ツール結果としてモデルに返るので、次のターンで**まとめが出てくる**。

```
  └ explore: 15 ターン / ツール 14回 / 入力 123651 — 上限で打ち切り
  ← エージェントの処理フローにおいて、ユーザー入力の受付から…
```

既にあるフックで書けて、ループは触っていない。倍のターン数まで来たら本当に殺す（保険）。

### 承認は親のものをそのまま通す

子は親と**同じ `Hooks` インスタンス**を使う。権限ルールも、`[a]lways` で足した
セッション限りのルールも、read-before-edit も、そのまま子に効く。

```
$ APPROVAL=acceptEdits hma code
  → delegate({"prompt":"memo.txt の担当者を…"})
  │ list_files / read_file / edit_file / read_file
  └ delegate: 5 ターン / ツール 4回 / 入力 8373
  ← memo.txt の中身を「担当者: 鈴木」から「担当者: 佐藤」に書き換えました。
```

子の中でも「読んでから書く」が要求されている（`read_file` → `edit_file` の順）。

**中断の往復だけは子に通せない。** `suspend` は run を終わらせて `Interrupt` を返す仕組みで、
子の run が終わっても親のツール呼び出しは終わらない。なので子の中の `suspend` は
`block` に落とす。

```
（HTTP で delegate に編集を任せた場合）
  [subagent] delegate: edit_file / write_file / bash   ← 全部 block
  ← …承認ブロックによりファイルの直接編集が実行できませんでした
  {"type":"interrupt"}                                  ← 親が自分でやろうとして、人に聞く
```

子は諦めて報告し、**親が自分で同じことをやろうとして承認を出す。** 承認は人と親の間だけにある、
という形に落ちた。stdio は `ask` を待てるので、子の中でもそのまま聞ける。

### 子のイベントは、終わってからまとめて出る

ツールの中からは AG-UI イベントを `yield` できない（親のジェネレータは `execute` を
await して止まっている）。`Toolset` に引き取り口を足して、ループが結果を積む直前に流している。

```ts
/** 実行中に溜まった出来事を引き取る。ツールの中からはイベントを yield できない */
drain?(): AgentEvent[];
```

```
  ┌ explore: ツールの結果が履歴に積まれるまでに…
  │ glob
  │ grep
  └ explore: 15 ターン / ツール 14回 / 入力 123651
```

**実時間では出ない。** 子が走っている数十秒、UI は無言になる。本当に流すなら
ツール実行をイベントストリームの中に畳み込む必要があって、それはループの作り直しになる。

### まだやっていないこと

- **並列実行。** ツール実行が逐次なので、`explore` を2つ同時には走らせられない
- **子の進捗がリアルタイムに出ない**（上記）
- **子のログが残らない。** 何を読んだかは `subagent` イベントのツール名だけ

## ステップ15 で理解すること — background は「待たない」ではなく「別の仕事があるときだけ効く」

`explore` / `delegate` に `background: true` を足した。起動して即座に戻り、結果は
**終わり次第この会話に届く**。

### 完了通知に、新しい経路を作らなかった

ステップ11 で入れた2つの口がそのまま使えた。

```ts
// ターンの合間: 終わっている子の報告を、割り込みと同じ扱いで入れる
getSteeringMessages: async () => [
  ...queues.steering.drain(),
  ...(this.config.jobs?.poll() ?? []),
],
// 止まろうとした瞬間: まだ走っている子がいるなら、待って回収する
if (this.config.jobs?.running()) return await this.config.jobs.settle();
```

**「走っている最中に割り込む」「止まろうとした瞬間に続きを渡す」が、そのまま
「子が終わった」に使える。** 通知の仕組みを別に作る必要はなかった。

待つのは60秒まで。超えたぶんは run を終わらせて、次の run の頭（steering の poll は
開始時にも走る）で渡す。

### 種類はツール名、実行の仕方は引数

ステップ14 では子の種類を引数にせず、ツールを2つに分けた（権限ルールがツール名で効くから）。
`background` は引数にした。**権限に効くものはツール名、効かないものは引数**、という線。

### 実測: 親は待たない

同じ指示（`src/store/` の3実装を explore に調べさせつつ、`src/agent/` の一覧も出す）。

| | 同期 | background |
|---|---|---|
| 親が別作業を始めた時刻 | 9.0s（子の完了後） | **1.0s** |
| 全体 | 12.0s | **7.0s** |

### 実測: 逐次ループのままで並列になった

ツール実行は逐次のまま（[ステップ14 の「まだやっていないこと」](#まだやっていないこと-5)）。
それでも background なら2つ同時に走る。

```
 1.0s ┌ job-1 explore: src/store/ の実装ファイルを全て読み…
 1.0s ┌ job-2 explore: src/transport/ の実装ファイルを全て読み…
 2.0s 親は src/agent/ の一覧を報告して、いったん止まろうとする
 9.0s └ job-2: 5 ターン / 入力 9,880
 9.0s └ job-1: 6 ターン / 入力 10,586
12.0s 両方をまとめて回答
```

**起動して戻るだけのツールなら、逐次ループのままで並列になる。** 親のツール実行が逐次
であることと、子が並列に走ることは別の話だった。

### 待たせないと、モデルは同じ仕事を自分でやり直す

最初はツール結果に「待たずに次の作業へ進んでください」としか書かなかった。

```
 1.0s job-1 を起動
 3.0s 親が自分で store/ を読み始める     ← 任せたのと同じ調べもの
 6.0s 親が自分の答えを書く
69.0s 子の報告が届く
71.0s まとめ直して終了
```

**71秒、トークンは2倍。** 「任せた仕事を自分でやり直さないこと」を1行足したら 7秒になった。
background は待たせないぶん、**何をしないか**を言う必要がある。

上の 69秒にはもう一つ理由がある。無料枠は 5 RPM で、**親と子は同じレート枠を食い合う**。
子は 429 のリトライ待ちに入っていた。並列は速さとレート制限の交換でもある。

### 落ちたら消える（ステップ13 の再来）

背景の子は store に残らない。親の履歴に残るのは「job-1 を起動しました」だけなので、
プロセスが落ちると**結果は永久に来ない**のに、履歴は「これから届く」と言っている。

[ステップ13](#ステップ13-で理解すること--二重実行は消せない分かるようにする) では
`attempt` の印を置いて「走ったかもしれない」と分かるようにしたが、子は store を持たないので
印の置き場がない。いまはツール結果の文面で予防線を張っただけ。

```
job-1 を起動しました（explore）。… 届かないまま会話が再開された場合は、
プロセスが落ちて失われたと考えてください。
```

### まだやっていないこと

- **走っている子を止める口が無い。** プロセスを畳むときに全部 abort するだけ
- **60秒を超えたぶんは次の run の頭で届く。** その run が来なければ黙って消える
- **子のイベントは相変わらずターンの境目でまとめて出る**（ステップ14 と同じ）

## ステップ16 で理解すること — スキルは「毎ターン払うか、使うときだけ払うか」の交換

`.hma/skills/<name>/SKILL.md` と `.hma/commands/<name>.md` を読むようにした。

```
$ hma config --profile coding
スキル（名前と説明だけが system に載る。本文は skill ツールで読む）:
  commit-message  このリポジトリのコミットメッセージを書く。…  .hma/skills
  measure         ステップの実測を取って README に残す。…      .hma/skills

スラッシュコマンド（入力を本文に差し替える）:
  /measure  119 文字  .hma/commands
  /step     238 文字  .hma/commands
```

### スラッシュコマンドは、入力を差し替える穴を1つ足すだけ

`beforeUserMessage` は「止めるか、文脈を足すか」の2つだった。`replace` を足した。

```ts
export type BeforeUserMessageResult =
  | { blocked?: string; replace?: string; context?: string }
  | undefined;
```

`/measure 引数` が `.hma/commands/measure.md` の本文に差し替わる。`$ARGUMENTS` があれば
そこへ、無ければ末尾に足す。**履歴に残るのは展開後**で、モデルは `/measure` を見ない。

知らない `/xxx` は展開せずそのまま流す（ただの文章かもしれない）。合成は `composeUser` で、
**差し替えた入力を次のフックが受け取る** — 外部の `UserPromptSubmit` フックは展開後の本文を
見て止められる。

```
> /measure いまはテストなので実測は取らず、何をするつもりかだけ3行で答えて。
  [/measure いまはテストなので実測は取らず… を展開しました（142 文字）]
  → skill({"name":"measure"})
```

コマンドがスキルを呼び、スキルの手順に従って答えた。**どちらも「プロンプトを外から差し込む」
仕組みで、置き場所と届き方だけが違う。**

| | いつ届くか | 何に効くか |
|---|---|---|
| スラッシュコマンド | 人が打ったとき | その1回の入力 |
| スキル | モデルが読みに行ったとき | そのターン以降の手順 |
| `AGENTS.md` | 毎ターン | 会話全体 |

### 実測: 固定費と往復の交換

スキル2つ（本文の合計 1,102 文字）。同じ質問を、**本文を全部 `AGENTS.md` に置いた場合**と
**スキルにした場合**で比べた。

| | 関係ない質問 | スキルを使う質問（1ターン目 ctx） | スキルを使う質問（累計入力） |
|---|---|---|---|
| 全文を `AGENTS.md` | 2,301 | 2,336 | **2,336** |
| スキル（名前と説明だけ） | **1,796** | **1,831** | 3,974 |

- 使わないターンは **505 トークン安い**。これは毎ターン効く
- 使うターンは往復が1回増えるので **+70% 高い**

**スキルは無条件に得ではない。** 本文が長く、たまにしか使わないものほど効く。
1問1答で必ず使うものは `AGENTS.md` に書いたほうが安い。progressive disclosure は
「減らす仕組み」ではなく、**固定費と往復の交換**だった。

### プロンプトは信頼の対象にしない

[ステップ10](#ステップ10-で理解すること--フックがコードの中にあると誰も刺せない) で
`.hma` のフックと `allow` は本人の確認を取るようにした。スキルとコマンドは**確認を取らない**。
権限を緩めないからで、スキルが「`rm -rf` しろ」と書いていても、実行は権限ルールと承認ゲートを
そのまま通る。**緩める方向のものだけ確認する**、という線はここでも同じ。

### `skill` は read なので、サブエージェントにも渡る

`kinds` に `skill: "read"` と入れただけで、[ステップ14](#ステップ14-で理解すること--サブエージェントは並列化ではなくコンテキストの隔離) の
`explore` にもそのまま渡り、plan モードでも使える。種類の表を1行足すだけで、権限・モード・
サブエージェントの3つに同時に効く。

### まだやっていないこと

- **スキルに `allowed-tools` のようなメタ情報が書けない**（frontmatter は name と description だけ）
- **コマンドの引数は `$ARGUMENTS` だけ。** `$1` `$2` は無い
- **`/` の補完も一覧も無い**（`hma config` に出るだけ）

## ステップ17 で理解すること — MCP はツールが外から生える。権限モデルがそのまま試される

`.hma/settings.json` の `mcpServers` に書いたサーバを起動して、ツールを合流させる。
クライアントは自前（`src/mcp/client.ts`、200行）。

```json
{
  "mcpServers": {
    "notes": { "command": "node", "args": ["examples/mcp-notes.js"] },
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@latest", "./sandbox"]
    }
  }
}
```

### プロトコルは「1行1 JSON-RPC」だけ

stdio の MCP はフレーミングが改行だけで、`initialize` → `notifications/initialized` →
`tools/list` → `tools/call` の4つで動く。踏んだのはこのあたり。

- **`content` は種類つきの配列**で返る。履歴に積めるのは文字列なので畳む
- **サーバは stderr にログを吐く。** stdout に混ぜると JSON-RPC が壊れる（実際、
  filesystem サーバは起動メッセージを stderr に出す）
- **起動に失敗したサーバは飛ばす。** 1つ落ちても他のサーバまで道連れにしない

### ツール名に出所を入れる — 権限ルールが名前で効くから

`mcp__<server>__<tool>`。[ステップ7](#ルールにする) でルールをツール名で書くと決めたので、
名前が出所を持っていないとサーバ単位で禁止できない。そのために**ツール名の末尾 `*` を許した**。
コマンドの `:*`（前方一致）と同じ発想で、表は増えていない。

```
$ hma config
  deny   mcp__notes__*  ~/.../.hma/settings.local.json

> メモを一覧して。
  → mcp__notes__note_list({})
  ← 権限ルールで禁止されています。このツールでは実行できません。
```

### `readOnlyHint` を `kinds` に写す

MCP のツールは `annotations.readOnlyHint` を自己申告できる。**あれば read、無ければ execute。**
[ステップ12](#readonly-を-kinds-にした) で決めた「種類の分からないツールは read 扱いしない」を
そのまま当てる。

```
$ hma config
MCP サーバ:
  notes  node examples/mcp-notes.js                       ツール 2（read 1）
  fs     npx -y @modelcontextprotocol/server-filesystem…   ツール 14（read 10）

権限ルール:
  ask    mcp__fs__write_file        MCP（readOnlyHint なし）
  ask    mcp__fs__edit_file         MCP（readOnlyHint なし）
  ask    mcp__fs__create_directory  MCP（readOnlyHint なし）
  ask    mcp__fs__move_file         MCP（readOnlyHint なし）
```

公式の filesystem サーバは14ツール中10に `readOnlyHint` を付けていて、**残り4つだけが
自動で `ask` になった**。

これが要る理由は、最初の実装で踏んだから。権限の既定は「どれにも当たらなければ通す」なので、
MCP を足した瞬間に**承認なしで書けるツールが増えていた**。

```
  → mcp__notes__note_write({"key":"今日","text":"MCP を実装した"})
  ← 今日 を書きました                    ← 聞かれていない
```

`mcpRules()` を足したあと。

```
  mcp__notes__note_write を実行しようとしています:
  ← ユーザーが実行を拒否しました。別の方法を検討してください。
```

**外から生えたツールは、プロファイルが知らない。** 知らないものを既定で通すか止めるかは、
ツールが自分で増える仕組みを入れた瞬間に効いてくる。

### 引数の表を増やさなかったのが、外のツールにも効いた

[ステップ7](#ルールにする) で「引数のどこを見るかにツールごとの表は持たない。`command` が
無ければ `path`」と決めた。MCP サーバは慣習的に `path` を使うので、**pattern がそのまま効く**。

```
deny: ["mcp__fs__read_text_file(**/*.md)"]

  → mcp__fs__read_text_file({"path":".../sandbox/memo2.md"})
  ← 権限ルールで禁止されています。
```

ただし `file_path` のような別名を使うサーバには効かない。**慣習に乗っているだけ**で保証ではない。

### 実測: ツールが増えるぶんは毎ターン払う

| | ツール定義 | ツールの JSON | 1ターンの ctx |
|---|---|---|---|
| MCP なし | 11 | 3,373 文字 | 1,793 |
| + notes（2ツール） | 13 | 3,717 文字 | 1,881 |
| + filesystem（14ツール） | 27 | 12,249 文字 | **3,591** |

**filesystem サーバ1つで +1,710 トークン／ターン。** 20ターンの会話なら 34,000 トークンで、
1回も使わなくても払う。[ステップ16](#ステップ16-で理解すること--スキルは毎ターン払うか使うときだけ払うかの交換) の
結論がそのまま当てはまる。**MCP サーバを足すのは、`AGENTS.md` に全文を書くのと同じ形の支払い。**

### 信頼の対象に足した

`mcpServers` は任意のコマンドを起動する。[ステップ10](#ステップ10-で理解すること--フックがコードの中にあると誰も刺せない) の枠にそのまま入れた。

```
$ hma trust
このディレクトリの .hma に、あなたの権限で動くものが入っています:
  起動  MCP notes: node examples/mcp-notes.js  ← ~/.../settings.local.json
```

未信頼なら起動しない（`hma config` にも「未信頼のため起動しない」と出る）。
**プロンプト（スキル・コマンド）は確認しないが、プロセスを立てるものは確認する。**
線はステップ10 と同じで、緩める方向のものだけ聞く。

### `workspace` の閉じ込めは MCP に効かない

`resolveInRoot` は我々のツールの中の話でしかない。MCP サーバは自分のルールで動く
（filesystem サーバは起動引数で閉じている）。**閉じ込めはサーバ側の責任**で、
こちらから効かせられるのは権限ルールだけ。`mcpServers` に `/` を渡すサーバを書けば、
`workspace` の外がそのまま見える。

### ツール名も外から来た文字列だった

承認 UI は `${name} を実行しますか？` を出す。この `name` はプロファイルが決めた
`bash` や `edit_file` だけだと思っていたが、MCP を足した時点で
**サーバが申告した文字列がそのまま入る**ようになっていた。

```js
// public/index.html — 直す前
box.innerHTML = `<div>${interrupt.message}</div><code></code>`;
```

`<img src=x onerror=...>` という名前のツールを生やすサーバがあれば、承認を出した瞬間に走る。
`textContent` に変えて直した。**踏んだのは「外から生えたものは名前まで外部由来」**という点で、
権限ルールが名前で効く（`mcp__server__tool`）ことにばかり気を取られて、
その名前を人に見せる側を見落としていた。

### まだやっていないこと

- **tools だけ。** resources / prompts / sampling は実装していない
- **stdio だけ。** HTTP transport は無い
- **`tools/list_changed` を見ていない。** 起動時に1回引くだけ
- **サーバの再起動が無い。** 落ちたらそのサーバのツールは全部エラーになる

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
（`requiresApproval` はステップ7 で権限ルールに置き換えた。当時の形として残す）

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

## 計測する — ClickHouse に流す

`Sessions.run()` が yield している AG-UI イベントに、**2つ目の消費者**を足しただけ。
transport は表示に、telemetry は計測に、同じ列を使う。

```bash
docker compose up -d          # clickhouse-server が :8123 で上がる
TELEMETRY=clickhouse hma      # 既定は none なので、普段は無関係
```

ClickHouse クライアントライブラリは足していない。HTTP に JSONEachRow を投げるだけ。
1行ずつ挿すと MergeTree が細かいパートで埋まるので、50件か2秒でまとめて送る。
**計測が落ちてもエージェントは止めない**（catch してログだけ出す）。

```sql
CREATE TABLE agent_events (
  ts, thread_id, run_id, profile, model,
  type,              -- RUN_STARTED / TOOL_CALL_START / CUSTOM …
  name,              -- CUSTOM の種類: usage / compact / graph / retry / steering / gate
  tool, tool_call_id, content,
  prompt_tokens, completion_tokens, chars_per_token,
  payload            -- CUSTOM の値をそのまま JSON で
) ENGINE = MergeTree ORDER BY (thread_id, ts)
```

### 叩き方

シェル関数を一度だけ定義しておく。

```bash
Q() { curl -s -u hma:hma 'http://localhost:8123/?database=hma' --data-binary "$1"; }
```

つながっているか確認する。

```bash
$ Q "SELECT count() FROM agent_events"
650
```

**表で見たいときは末尾に `FORMAT PrettyCompactMonoBlock` を足す。** 付けないと TSV で返る。

```bash
$ Q "SELECT thread_id, count() AS n FROM agent_events GROUP BY thread_id ORDER BY n DESC LIMIT 3 FORMAT PrettyCompactMonoBlock"
   ┌─thread_id─┬───n─┐
1. │ m-compact │ 139 │
2. │ m-graph   │ 109 │
3. │ m-graph2  │ 105 │
   └───────────┴─────┘
```

### よく使うクエリ

以下は SQL 本体だけ。`Q "..."` に包んで、必要なら `FORMAT PrettyCompactMonoBlock` を足す。

**スレッドごとのコストと所要時間**

```sql
SELECT thread_id, any(model) AS model,
  countIf(name='usage')      AS calls,
  sum(prompt_tokens)         AS in_tok,
  sum(completion_tokens)     AS out_tok,
  round(dateDiff('millisecond', min(ts), max(ts))/1000, 1) AS sec
FROM agent_events GROUP BY thread_id ORDER BY in_tok DESC
```

**ツール別の呼び出しと失敗**

`TOOL_CALL_START`（ツール名を持つ）と `TOOL_CALL_RESULT`（結果を持つ）を
`tool_call_id` で突き合わせる。結果側は `any()` で畳んでから join しないと行が増える。

```sql
SELECT s.tool AS tool, count() AS calls,
  countIf(r.content LIKE 'エラー%')                 AS errors,
  countIf(r.content LIKE 'ユーザーが実行を拒否%')     AS denied
FROM (SELECT tool, tool_call_id FROM agent_events
      WHERE type='TOOL_CALL_START' AND tool_call_id != '') s
LEFT JOIN (SELECT tool_call_id, any(content) AS content FROM agent_events
           WHERE type='TOOL_CALL_RESULT' GROUP BY tool_call_id) r
  ON s.tool_call_id = r.tool_call_id
GROUP BY tool ORDER BY calls DESC
```

**トリム戦略の比較**（`compact` と `graph` のどちらが高いか）

```sql
SELECT name AS strategy, count() AS fired,
  sum(JSONExtractUInt(payload,'promptTokens')) AS extract_in_tok,
  sum(JSONExtractUInt(payload,'dropped'))      AS dropped_msgs
FROM agent_events WHERE name IN ('compact','graph','trim') GROUP BY name
```

**文字/token の較正がどれだけ振れたか**（ステップ3 の 2.17〜3.57 を測り直す）

```sql
SELECT thread_id, round(min(chars_per_token),2) AS min, round(max(chars_per_token),2) AS max
FROM agent_events WHERE name='usage' AND chars_per_token > 0
GROUP BY thread_id ORDER BY max DESC
```

**429 に何回当たったか**

```sql
SELECT thread_id, count() AS retries,
  sum(JSONExtractUInt(payload,'waitSeconds')) AS waited_sec
FROM agent_events WHERE name='retry' GROUP BY thread_id
```

> 列を後から足したので、古い行は `tool_call_id` と `content` が空。
> join するクエリは `tool_call_id != ''` で除外する（しないと空 id 同士が
> 総当たりで結合して、件数が桁違いに膨らむ）。

### 権限の判定を数える

ステップ7 で承認をルールにしたあと、**その効果を数字で言えないことに気付いた。**
`allow` で通したのか、そもそもルールに当たらなかったのかは、AG-UI のイベント列に
出てこない。`ask` に至っては `RUN_FINISHED` の `outcome` にしか無く、行に残らない。

```
perm-allow │ TOOL_CALL_START → … → TOOL_CALL_RESULT   ← 通した
perm-ask   │ TOOL_CALL_START → … → RUN_FINISHED       ← 聞いた（結果が無いだけ）
```

**allow と ask が計測上ほぼ同じ形**になる。`TOOL_CALL_START` と `TOOL_CALL_RESULT` を
anti join すれば「結果が無い呼び出し」は数えられるが、承認待ちと中断とクラッシュの
区別が付かない。

そこで `beforeToolCall` の結果を `CUSTOM` イベントに1本足した。**表示には使わない、
計測のためだけのイベント**はこれが最初。

```
gate  { decision: "run" | "ask" | "block", tool, arguments }
```

判定の内訳:

```sql
SELECT JSONExtractString(payload,'decision') AS decision, count() AS n
FROM agent_events WHERE name='gate' GROUP BY decision ORDER BY n DESC
```

```
┌─decision─┬─n─┐
│ ask      │ 2 │
│ run      │ 1 │
│ block    │ 1 │
└──────────┴───┘
```

**どのコマンドが ask を引き起こしたか** — つまり、どの `allow` ルールを足せば聞かれる
回数が減るかが、そのまま出る。

```sql
SELECT JSONExtractString(JSONExtractString(payload,'arguments'),'command') AS command,
       count() AS n
FROM agent_events
WHERE name='gate' AND JSONExtractString(payload,'decision')='ask'
GROUP BY command ORDER BY n DESC LIMIT 5
```

```
┌─command───────────────────────────────────────┬─n─┐
│ head -1 memo.txt                              │ 1 │
│ python3 -c "import os; os.remove('memo.txt')" │ 1 │
└───────────────────────────────────────────────┴───┘
```

2行目は `deny: ["bash(rm:*)"]` を迂回しようとしたもの。**ルールの抜けが計測に出る。**

> ⚠️ `arguments` をそのまま流しているので、**コマンドに書いた秘密は ClickHouse に残る**。
> ローカルの実験用と割り切っている。

## 記憶を構造で持つ — TRIM=graph（結果: 負けた）

compaction は散文を散文に圧縮するので、何が落ちたか分からない。
事実を構造で別に持てば消えないはず、という仮説で bi-temporal なグラフを足した。

```ts
export type Fact = {
  subject: string; predicate: string; object: string;
  validFrom: string;   // その事実が成り立つ時点
  validTo: string;     // 覆された時刻。空なら現在も有効
  recordedAt: string;  // システムがそれを知った時刻 ← validFrom とは別軸
};
```

同じ `subject` / `predicate` に別の値が来たら、**消さずに `validTo` を立てる**。
「担当者が A から B に変わった」を上書きではなく履歴で持てる。
`Entry` に `fact` 種別を足したので、追記ログから replay で組み直せる。

### 実測: 勝てなかった

**同じ5問**（`CONTEXT_LIMIT=1200`）

| | LLM 呼び出し | 入力トークン | 数値の保持 |
|---|---|---|---|
| `compact` | 17 | 17,609 | ERROR 45 / WARN 114 / 09時 42件 |
| `graph` | 12 | **23,566（+34%）** | 同じ |

**事実が変わるケース**（担当者 田中 → 鈴木、`CONTEXT_LIMIT=600`）

| | 入力トークン | 「誰から誰に変わったか」 |
|---|---|---|
| `compact` | 7,493 | 「田中」から「鈴木」に変わりました |
| `graph` | 5,526 | 同じ（事実欄を根拠に挙げた） |

**TKG の本命であるはずの時系列ケースでも差が出なかった。**

### 踏んだ壊れ方

**1. モデルが指定した JSON の形を守らない。**
`{"facts":[...]}` を指示したのに**裸の配列**を返してきて、最初のパーサはそれを黙って捨てていた。
3回中2回の抽出が無言で消えて、グラフが1件のまま気づかなかった。
形の揺れを許容し、読めなかったら `unparsed` を立てて CLI に警告を出すようにした。

**2. 述語が安定しないと、時系列の上書きが発動しない。**

```
memo.txt / content = 担当者: 田中
memo.txt / 担当者  = 鈴木
```

`content` と `担当者` で述語が揺れたので、`validTo` を立てる機構は**一度も発火していない**
（単体では A→B で動作確認済み）。正答したのは両方の事実が残っていたからで、時間軸のおかげではない。
**Graphiti のような実装が entity / predicate resolution に大量の実装を割いている理由が分かった。**

**3. 抽出にゴミが混じる。** コマンド全文が subject になる。

```
grep "WARN" app.log | cut -d'[' -f2 | ... / command = grep "WARN" app.log | ...
```

### では、どういうときに効きそうか

負けた条件を裏返すと、効く条件が見える。

| 条件 | なぜ効くか | 今回の課題では |
|---|---|---|
| **述語を先に決められる** | スキーマを固定すれば supersession が発動する。抽出も「この項目を埋めろ」になり、ゴミが減る | 自由抽出だったので述語が揺れた |
| **同じ事実が何度も覆る** | 上書きせず履歴で持つ価値が出る。「いつ変わったか」を聞ける | 1回変わっただけで、履歴を問われなかった |
| **真実の源が会話にしかない** | 読み直せないので、落としたら終わり | コードとログが手元にあり、いつでも読み直せた |
| **会話が長く、事実が散らばる** | 散文要約だと後半に押し出される | 5問で収まった |

具体的には、**運用の申し送り**（担当・状態・期限が変わり続ける）、**顧客対応の履歴**
（「前回は A と言ったが今回 B に変わった」）、**組織のナレッジ**（決定が上書きされる）あたり。
逆に**コーディングエージェントには向かない** — コードベース自体が真実の源で、
`read_file` すればいつでも正解が取れるから。

### いまの結論

**この規模では compaction で足りている。** TKG はコストと失敗モードが勝つ。
入れるなら、まず**述語のスキーマを固定する**ところから。自由抽出のままでは
時間軸の機構が動かないので、TKG を名乗る意味がない。

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

