# PR/Issue Body の渡し方と Claude Code フッター

対象: `gh pr create` / `gh pr edit` / `gh pr comment` / `gh issue create` / `gh issue edit` / `gh issue comment` の `--body`。

## 中間ファイル禁則

PR/Issue body は**原則** `--body` に heredoc で直接渡すこと。`.claude/tmp/pr-body.md` 等の**ディスク上の固定ファイル名**を中間ファイルとして作り `--body-file` で参照する方式は禁止（**固定ファイル名**が問題であり、ファイル経由自体を全面禁止するものではない。一意なファイル名を使う場合の例外は下記「中間ファイルが必要な場合の命名規約」参照）。

理由: 複数の box を並列起動して同一 checkout（同一 worktree）上で複数セッションが走ると、`.claude/tmp/` 配下のファイルが共有されるため、固定ファイル名を使うと書き込みが race し、意図しない body で PR/Issue が作成・更新される危険がある。worktree を分ければ checkout 単位で `.claude/tmp/` も分離されるが、同一 checkout 内での並列は共有されたまま。

### 中間ファイルが必要な場合の命名規約

長文 body を `--body` への直接 heredoc 埋め込みで渡すと、Bash コマンド全体に長大なテキストを埋め込むことになり扱いにくい場合がある。そのようなときに限り、**セッション ID を含む一意なファイル名**（例: `.claude/tmp/verify-issue-body-<session_id>.md`）で中間ファイルを作り、`Write` ツールで書き出してから `--body-file` で参照してよい。固定ファイル名は禁止（上記「中間ファイル禁則」参照）。`<session_id>` はフル UUID または先頭 8 文字以上の hex 短縮形。取得方法は呼び出し元 skill の実装に従う。

## PR Body フッター（必須）

**PR を作成する際は、`gh pr create --body` の heredoc 内に必ず以下のフッターを含めること。**

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

heredoc 本文末尾（要約・テストプラン等の後）に**空行を1行挟んで**配置する。

### 具体例

```bash
gh pr create --base <base-branch> --title "fix: example" --body "$(cat <<'EOF'
## Summary
- Fixed example bug

## Test plan
- [x] unit tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

`--base` は必須（省略すると default branch に向く。[commit-pr.md](commit-pr.md) 参照）。

## Issue Close キーワード（必須）

issue に紐づく PR では、マージ時点の PR description（body）に **GitHub の close keyword** を含めること。`gh pr create --body` の初回作成・`gh pr edit --body` の書き換えのいずれでも close keyword を保持/追加する（[fetch-before-update.md](fetch-before-update.md) も参照）。close keyword が無いと PR マージ時に issue が自動 close されず、手動 close の漏れの原因になる。

**default branch を target する PR に限る**: GitHub の close keyword は PR が default branch（本リポジトリでは `main`）にマージされる場合のみ有効。`stage/NN` を base にする stage 作業の fix PR では `Closes #N` は自動 close されない（[docs/instructor/stage-playbook.md](../docs/instructor/stage-playbook.md) 参照）。close keyword を書くこと自体は無害（GitHub がそれを無視するだけ）だが、**stage PR では別途手動で issue を close する**こと。

### 有効な keyword (case-insensitive)

- `close`, `closes`, `closed`
- `fix`, `fixes`, `fixed`
- `resolve`, `resolves`, `resolved`

### 必須形式

- 同一リポジトリの issue: `Closes #123`

`Closes` の代わりに `Fixes` / `Resolves` 等（上記「有効な keyword」のいずれか、case-insensitive）も同様に使える。本リポジトリでは canonical form として `Closes` を推奨するが、`Fixes`/`Resolves` を使った PR も auto-close は正常動作する。

### 認識されない形式の例

以下は close keyword として認識されない（`gh pr create` 時に body に含まれていても issue は close されない）:

- `Related to #123` / `See #123` / `Reference: #123`（keyword 違い）
- bare URL: `https://github.com/<owner>/<repo>/issues/123` のみ
- markdown link: `[#123](https://github.com/<owner>/<repo>/issues/123)`

### 適用範囲

issue に紐づく PR では必須。issue に紐づかない PR（内発的な refactor / docs 等）は不要。

複数 issue を close する場合は **keyword を個別に書く**こと:

```text
Closes #1
Closes #2
```

または同一行で:

```text
Closes #1, closes #2
```

`Closes #1, #2` のようにカンマ区切りで `#` だけ並べる形式は **keyword が先頭の 1 つ (`#1`) にしか効かず `#2` は close されない**ため使わないこと。

### 具体例

```bash
gh pr create --base <base-branch> --title "fix(hooks): example" --body "$(cat <<'EOF'
## Summary

issue (https://github.com/<owner>/<repo>/issues/100) の対応案 1〜4 を実装。

Closes #100

## Test plan

- [x] unit tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
