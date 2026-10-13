#!/usr/bin/env bash
# GitHub上の@claudeのStopフック。変更があるのにPRが無いまま終わろうとしたら止める
set -uo pipefail

counter="${RUNNER_TEMP:-/tmp}/claude-stop-gate.count"
n=$(cat "$counter" 2>/dev/null || echo 0)
# 直せない失敗で回り続けないよう、止めるのは3回まで
[ "$n" -ge 3 ] && exit 0

cd "$(git rev-parse --show-toplevel)" || exit 0
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
if [ "$ahead" = "0" ] && [ -z "$(git status --porcelain)" ]; then
    exit 0
fi

branch=$(git branch --show-current)
if [ -n "$(gh pr list --head "$branch" --state all --json number -q '.[].number' 2>/dev/null)" ]; then
    exit 0
fi

echo $((n + 1)) > "$counter"
jq -n --arg branch "$branch" '{decision: "block", reason: (
  "変更があるのに、まだPRが出ていません（ブランチ \($branch)）。終える前に次を済ませてください。\n" +
  "- pnpm lint && pnpm typecheck && pnpm test を前景で走らせ、終わるまで待つ。落ちたら直してやり直す\n" +
  "- コミットして、アクション同梱の git-push.sh でpushし、gh pr create でPRを出す\n" +
  "直せない理由で出せないときは、理由と残りの手順をトラッキングコメントに書いてから終える。"
)}'
