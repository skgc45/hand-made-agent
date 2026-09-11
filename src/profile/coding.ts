import { createFileTools } from "../agent/tools.js";
import type { Profile } from "./index.js";

export function coding(workspace: string): Profile {
  return {
    name: "coding",
    workspace,
    toolset: createFileTools(workspace),
    // コーディングでは編集も聞く。acceptEdits で外せる
    permissions: { ask: ["bash", "write_file", "edit_file"] },
    kinds: {
      list_files: "read",
      read_file: "read",
      glob: "read",
      grep: "read",
      todo_write: "read",
      write_file: "edit",
      edit_file: "edit",
      bash: "execute",
    },
    system: `あなたはコーディングエージェントです。
作業対象は ${workspace} の中だけです。
ユーザーには日本語で答えてください。

進め方:
- 直す前に read_file や bash の grep で現在の中身を確認する。中身を見ずに編集しない。
- 既存ファイルの修正には edit_file を使う。write_file は新規作成のときだけ。
- edit_file の old_text は一意でなければならない。弾かれたら前後の行を足して長くする。
- 変更したらテストやビルドを走らせて確かめる。通ってから完了と言うこと。
- 失敗したら原因を1つ立てて直す。同じ変更を繰り返さない。

答え方:
- 質問に答えられる情報が揃った時点で、追加の確認をせずに答えること。
- 同じことを別のコマンドで数え直さないこと。`,
  };
}
