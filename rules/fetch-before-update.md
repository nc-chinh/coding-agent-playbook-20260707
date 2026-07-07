# 更新前の現状取得

既存の内容を上書きする更新操作を行う前に、まず現状を取得すること。事前取得を省くと、既存の説明・チェックリスト・他者が追記した内容を意図せず消す事故につながる。

## 対象操作と取得コマンド

| 更新操作 | 事前取得コマンド |
|----------|------------------|
| `gh pr edit <num> --body ...` | `gh pr view <num> --json body -q .body` |
| `gh pr edit <num> --title ...` | `gh pr view <num> --json title -q .title` |
| `gh issue edit <num> --body ...` | `gh issue view <num> --json body -q .body` |
| `gh issue edit <num> --title ...` | `gh issue view <num> --json title -q .title` |
| 設定ファイル（`.claude/settings.json` / `.claude/settings.local.json` 等）の項目追加・変更 | `Read` で既存値を確認し、`Edit` で差分更新する（`Write` 全置換は使わない。下記「設定ファイルは Edit で差分更新する」参照） |

## 例

```bash
# 良い例: PR body を上書きする前に現状取得
gh pr view 123 --json body -q .body
# 出力を確認し、既存の Summary / Test plan / 他者追記を踏まえた new body を組み立ててから:
gh pr edit 123 --body "$(cat <<'EOF'
... 既存内容を踏まえた new body 全文 ...
EOF
)"

# 悪い例: 現状を見ずに body を上書き
gh pr edit 123 --body "新しい要約だけ"  # 既存の Test plan 等を意図せず消す
```

## 設定ファイルは Edit で差分更新する

`.claude/settings.json` / `.claude/settings.local.json` 等、複数キーを持つ JSON 設定ファイルへ項目を追加・変更する場合は、`Write`（全置換）ではなく `Edit`（対象箇所のみ差し替え）を使うこと。`Write` は渡した全文でファイルを丸ごと置換するため、追加したいキーだけを内容にすると既存の他キーを消失させる。

- `Write` を使ってよいのは、対象ファイルが実在しないことを `Read` で確認できた場合（新規作成）のみ
- 既存ファイルへ 1 キー追加するだけでも `Edit` で該当箇所のみ差し替える

## 例外

- 自分が直前に書いた body であることが明らかで、他者の介在がない場合
- `--add-label` / `--remove-label` 等の追加・削除系オプション（上書きではない）
- `gh pr create` / `gh issue create` 等の新規作成（既存内容が存在しない）
- `Edit` ツールでのファイル編集（ツール自身が事前 `Read` を強制する）。`Write` ツールも事前 `Read` を強制するが**全置換**のため本例外に含めない（既存内容のあるファイルへの変更は `Edit` を使う）

## 背景

`gh pr edit --body` や `gh issue edit --body` は body 全文の置換であり、引数として渡した文字列で丸ごと差し替わる。一部だけ書き換えたつもりでも、事前取得を省くと既存内容を消失させやすい。
