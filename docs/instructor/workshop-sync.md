# workshop snapshot repo への sync

workshop 開催ごとに受講者へ配布する snapshot repo（例: `kanka-jp/coding-agent-playbook-20260707`）へ、upstream（本 repo）の最新内容を反映する手順。agent に「workshop repo に最新を反映して」と頼んだときの再現手順の SoT。

## snapshot repo の構造（前提）

- **upstream と履歴を共有しない独立履歴**。fork ではなく、各ブランチが orphan root commit（`<branch> (workshop YYYY-MM-DD snapshot)`）から始まり、以降は sync commit を積み上げる
- **tree は常に upstream の対応ブランチと完全一致**させる（workshop 側に固有変更を持たない）。sync = 「upstream の tree をそのまま次の commit にする」操作で、upstream の commit 履歴は持ち込まない
- sync commit の件名は `sync: upstream <branch> <short-sha> を反映`（main は括弧内に含まれる PR の要約を付ける。過去 commit の形式に合わせる）
- branch protection なし・**直接 push 運用**（sync は PR にしない）。本 repo の「変更は PR 経由」（[../../rules/commit-pr.md](../../rules/commit-pr.md)）は upstream の開発規約であり、snapshot repo へのミラー push はその対象外
- ブランチ構成は upstream と同じ: `main` + `stage/*`（[stage の checkpoint 連鎖](README.md)）

## sync 手順

commit-tree 方式で行う（checkout 不要・working tree に一切触れない）。

1. **remote 準備 + fetch**（`workshop` remote が未登録なら追加。登録済みかは `git remote -v` で確認し、登録済みで URL が別開催回のものなら `git remote set-url workshop <workshop-url>` で差し替える — `git remote add` は既登録だと fail するため。`<workshop-url>` は対象 snapshot repo の URL で、開催日ごとに変わる — user 指定または `gh repo list kanka-jp` で確認）:

   ```bash
   git remote add workshop <workshop-url>
   git fetch origin --prune
   git fetch workshop --prune
   ```

2. **差分のあるブランチを特定**: workshop 側 head の commit message（`git log -1 workshop/<branch>`）に前回 sync 時点の upstream short-sha が記録されているので、それと `origin/<branch>` の現 head を比較する。tree 単位の確認は次で行う（空出力 = 差分なし = sync 不要）:

   ```bash
   git diff --stat workshop/<branch> origin/<branch>
   ```

   upstream にだけ存在する `stage/*` は新規ブランチとして手順 4 で作る。upstream の stage が最新 main に restack されていない場合も**そのまま反映**する（sync は upstream の現状のミラーであり、restack は upstream 側の作業。勝手に restack しない）。

3. **既存ブランチの sync commit を作成**: tree SHA を取得し、workshop 側 head を親にした commit を作る。`<short-sha>` は `git log -1 --format=%h origin/<branch>` で取得:

   ```bash
   git rev-parse 'origin/<branch>^{tree}'   # → <tree-sha>
   git rev-parse workshop/<branch>          # → <workshop-head-sha>
   git commit-tree <tree-sha> -p <workshop-head-sha> -m 'sync: upstream <branch> <short-sha> を反映 (#NNN 要約, ...)'
   ```

   出力される commit SHA を控える。permission hook 都合でコマンド置換（`$(...)`）は使えないため、tree SHA / head SHA は前のコマンドの出力をリテラルで埋める。

4. **新規ブランチ（upstream で新設された stage 等）**: 親なしの orphan commit にする。body に upstream の short-sha を残す:

   ```bash
   git rev-parse 'origin/stage/NN-slug^{tree}'   # → <tree-sha>
   git commit-tree <tree-sha> -m 'stage/NN-slug (workshop YYYY-MM-DD snapshot)

   upstream stage/NN-slug <short-sha> 時点の snapshot'
   ```

5. **push 前検証**: 作った commit の tree が upstream と完全一致すること（1 本目、**空出力が正**）と、親からの diff が空でないこと（2 本目、**非空が正** — 空なら no-op sync だった = push しない）の両方を確認する:

   ```bash
   git diff --stat origin/<branch> <new-commit-sha>
   git diff --stat <workshop-head-sha> <new-commit-sha>
   ```

6. **push**（複数ブランチは refspec を並べて 1 回で可。既存ブランチは fast-forward になるはず — non-FF を force する状況は手順のどこかが壊れているので停止して調べる）:

   ```bash
   git push workshop <new-commit-sha>:refs/heads/<branch>
   ```

7. **push 後の workflow 確認**: `gh run list --repo <owner>/<workshop-repo>` で確認する。**run が発火しないことが正常のケース**があるので、失敗と混同しない:
   - `pages` は `slides/**`（または pages.yml 自体）の変更を含む main への push でのみ発火（[.github/workflows/pages.yml](../../.github/workflows/pages.yml)）
   - `ci` は `app/**` 変更を含む `stage/**` への push でのみ発火し、ci.yml 自体 `stage/04` 以降にしか存在しない（stage/01–03 で発火しないのは期待動作）
   - lint 系（actionlint / shellcheck / bun-test 等）は `workflow_dispatch` only（[.github/workflows/README.md](../../.github/workflows/README.md)）

   発火した run は完了まで確認し、失敗があれば原因を調べて報告する。

## 新しい開催回の snapshot repo を作る

`gh repo create <owner>/coding-agent-playbook-YYYYMMDD` で空 repo を作り、全ブランチを手順 4 の orphan snapshot として push する（root commit の件名は `<branch> (workshop YYYY-MM-DD snapshot)`、main のみ `coding-agent-playbook (workshop YYYY-MM-DD snapshot)`）。スライド配信を使う場合は repo owner が Settings > Pages で Source = "GitHub Actions" を設定する（[README.md](README.md)「スライド」参照）。
