---
name: verify
argument-hint: "[PR番号] --mode=local|deploy [--url <URL>] [--track=github|none]"
description: "Verifies application behavior after code changes by generating verification items from PR diffs and checking them via Chrome DevTools MCP and HTTP requests. Supports local dev server (mode=local) and production/staging URLs (mode=deploy). Use when the user wants to verify a deployment, test changes in the browser, or run post-merge smoke tests."
---

# verify

diff から検証項目を自動生成し、Chrome DevTools MCP / HTTP で動的に動作確認する leaf skill ([rules/skills.md](../../../rules/skills.md))。

## モード

| モード | 用途 | 対象 |
|--------|------|------|
| `local` | 実装後・PR作成前の動作確認 | ローカル dev サーバー |
| `deploy` | merge 後の本番/staging 確認 | 本番・staging・preview URL |

## verify / manual-verify / refactor-check との使い分け

| スキル | 何をするか | base との等価比較 |
|--------|-----------|------------------|
| **verify** | diff から検証項目を生成し「動くか」を確認。`getComputedStyle` は補助 | しない (片方向) |
| `manual-verify` | base/PR を該当箇所ごとの 3 タブ群で並べ、人間が目視で比較 | 人間の目に依存 |
| `refactor-check` | base/PR の対応要素の computed style を機械的に差分 | する |

「新機能が動くか」を確認したいときは本 skill、「リファクタで何も変わっていないか」を保証したいときは `refactor-check`、人間が手を動かして最終確認したいときは `manual-verify` を使う。

## 手順

### 1. 引数の解析と前処理

#### 引数の抽出

`{ARGUMENTS}` から以下を抽出する:
- **PR番号**: 数値（省略可。省略時は手順2で `git diff` を使用）
- **--mode**: `local` または `deploy`（省略時はユーザーに確認。`--auto` 時は案内して終了）
- **--url**: 検証対象 URL（省略可。mode=local / mode=deploy 共通の正規引数。mode=local では指定時に対象 URL として優先し、dev server の auto-start を skip する。mode=deploy では URL 解決の優先順位 1 位として使用）
- **--auto**: 自動実行フラグ（省略可。orchestrator skill (`pr-codex-ci` / `pr-ci`) 等からの自動呼び出し時に付与される）
- **--track**: `github` または `none`（明示指定が最優先。未指定時は環境変数 `CLAUDE_SKILL_VERIFY_TRACK` を参照し、それも未定義なら `none`）

#### --auto ガード（環境変数 CLAUDE_SKILL_VERIFY_AUTO）

`--auto` フラグが指定されている場合、環境変数 `CLAUDE_SKILL_VERIFY_AUTO` を確認する:
- `CLAUDE_SKILL_VERIFY_AUTO` が `1`（完全一致） → 続行
- 未定義 / それ以外の値 → 「検証を行う場合は `/verify {PR番号} --mode=local` または `/verify {PR番号} --mode=deploy` を実行してください」と案内して**正常終了**する（終了コード 0）

`--auto` フラグがない場合（ユーザーが直接呼び出した場合）はこのガードをスキップし、常に実行する。

**skip の契約**:

- この「案内して終了」と、本 SKILL 本文で `--auto` 時に列挙されている各種「案内して終了」（`--mode` 未指定、PR 番号未指定 for mode=deploy、state が MERGED でない、URL 未解決等）は、いずれも**正常終了（exit 0）**で終了する。
- 呼び出し側はこれらを skip（正常終了）として扱ってよい。

ただし、skip の意味は理由ごとに異なる。

- `auto-guard` は**ユーザーの opt-out**（`CLAUDE_SKILL_VERIFY_AUTO=1` 未設定、default-off）
- 他の理由（`mode-missing` / `url-unresolved` 等）は**前提条件不足**

呼び出し側（orchestrator skill 等）は、後述の理由表と固定タグ `VERIFY_SKIP: <理由>` を使って分岐すること。

**skip 時の出力契約**: skip で終了する際は、案内メッセージとは別に以下の固定タグ行を stdout に1回だけ出力すること（案内の前後どちらでもよい）:

```
VERIFY_SKIP: <理由>
```

**タグ行の厳密なフォーマット**（呼び出し側が確実にパースできるよう以下を守ること）:

- **行頭から開始**する（先頭に空白・インデント・装飾文字を置かない）
- **1回のみ出力**する（同一 skip に対して複数回の `VERIFY_SKIP:` は出力しない）
- **`VERIFY_REPORT:` と相互排他**（skip 時は `VERIFY_REPORT:` を出さない、検証完了時は `VERIFY_SKIP:` を出さない）
- タグ行の本体（`VERIFY_SKIP: <理由>`）の前後に余計な空白を入れない
- 説明文・サンプル・ヘルプ出力中にリテラル `VERIFY_SKIP:` を出さない（どうしても例示する場合は行頭以外に配置する、あるいは `\`VERIFY_SKIP:\`` のように fenced にする）

`<理由>` は以下の識別子いずれか（将来の拡張時は本セクションに追記する）:

| 識別子 | 発生条件 | 意味 |
|--------|----------|------|
| `auto-guard` | `--auto` 付きで `CLAUDE_SKILL_VERIFY_AUTO` が `1` 以外 | **ユーザー opt-out**（`CLAUDE_SKILL_VERIFY_AUTO=1` 未設定、default-off） |
| `mode-missing` | `--auto` かつ `--mode` 未指定 | 前提条件不足 |
| `pr-missing` | `--auto` かつ `mode=deploy` で PR 番号未指定 | 前提条件不足 |
| `pr-not-merged` | `--auto` かつ `mode=deploy` で PR state が MERGED でない | 前提条件不足 |
| `url-unresolved` | `--auto` かつ `mode=deploy` で対象 URL が解決できない | 前提条件不足 |

呼び出し側（orchestrator skill 等）はこの固定タグを最優先で検出し、フレーズマッチはバックアップとして扱う。

### 2. 変更内容の取得

PR 番号が指定された場合:
```
gh pr view {PR番号} \
  --json title,body,files,state,mergedAt,baseRefName,headRefName
gh pr diff {PR番号}
```

PR 番号が省略された場合（mode=local で PR 作成前）:
```
git diff HEAD
git diff --staged
```

- mode=deploy では PR 番号を必須とする（省略時はユーザーに確認。`--auto` 時は案内して終了）
- mode=deploy で state が MERGED でない場合、警告してユーザーに確認する（`--auto` 時は案内して終了）

**{owner}/{repo} の解決**: GitHub API で `{owner}/{repo}` が必要な場合は `gh repo view --json nameWithOwner --jq .nameWithOwner` で取得する。

### 3. 検証項目の自動生成

**生成ファイルの除外（入力前）**: 純粋なドキュメント/データ生成物は UI/挙動の変更を生まないため、検証項目生成の入力から外す（ただし API クライアント等ランタイムで実行される生成物は下記の通り除外しない）。手順 2 の diff 取得方法に対応する検出 CLI を実行し、出力 JSON の `generated[].path` を確認する:

- PR 番号あり: `bun --config=/dev/null .claude/skills/mark-generated-viewed/scripts/detect-generated.ts {PR番号}`
- PR 番号省略（mode=local）: `bun --config=/dev/null .claude/skills/_shared/detect-generated-local.ts --worktree`（`git diff HEAD` 相当）。`--staged` 分も見る場合は `--staged` も実行する

`reason` が `content:*` / `gitattributes:*` のものは、**ロックファイル・API 定義以外の純粋なドキュメント/データ生成物**（`content:generated-tag` / `content:do-not-edit` の非コードファイル等）に限り機械的に除外する。**orval クライアント (`content:orval`) や protobuf/gRPC 生成コード (`content:go-codegen` 等) のように、生成されていてもランタイムで実際に実行される API クライアント / データ処理ロジックは機械的に除外しない** — エンドポイント URL・レスポンス型・フィールド追加等の変更は生成物であっても API 振る舞いに影響しうるため（mark-generated-viewed の「レビュー不要」という判定基準とは目的が異なり、verify は「動作に影響しうるか」で判断する）。これらはチェックリストに「[generated (runtime)] `<path>`（要確認: API/データ変更の影響を確認）」として残す。**`reason` が `name:*`（内容を読まないファイル名だけの判定）のものも自動除外しない** — 手書きの `openapi.yaml` 等を誤検出しうるため（[mark-generated-viewed の注意点](../mark-generated-viewed/SKILL.md) 参照）。`name:*` 判定のファイルはチェックリストに「[generated?要確認] `<path>`（name 判定のみ）」として残し、ユーザーに妥当性を確認してもらう。

除外・要確認としたファイルはチェックリスト提示時に「生成ファイル N 件（内訳: 純粋な生成物 M 件を検証対象外、API/データ生成物 L 件・name:* K 件は要確認としてチェックリストに残置）」と注記する。

diff を分析し、以下のカテゴリで検証項目を生成する:

- **UI 変更**: 新規/変更されたページ、コンポーネント、テキスト、レイアウト
- **API 変更**: 新規/変更されたエンドポイント、レスポンス形式
- **設定変更**: 環境変数、ルーティング、認証設定
- **自動検証不可**: DB マイグレーション、バックグラウンドジョブ等 → 「手動確認が必要」とマーク
- **操作を伴う検証**: トグル、フォーム送信、削除等（staging では自動検証可。本番では「手動確認が必要」とマーク）

チェックリストをユーザーに提示し、確認を得る（`--auto` 時は確認をスキップし、生成した検証項目をそのまま実行する）:

```
📋 検証項目 (PR #42, mode=deploy, env=staging):
1. [UI] /settings ページの「通知設定」セクションが表示される
2. [API] GET /api/notifications → 200 OK
3. [UI] トグル操作で状態が変化する
4. [manual] DB マイグレーションの適用確認

Enter で実行 / 項目を編集:
```

### 4. 対象 URL の決定

#### mode=local

**`--url` 指定時（auto-start skip）**: `--url` 引数が指定されている場合、その URL を対象 URL とし、以下 1〜4 の dev server auto-start を **skip する**。`CLAUDE_SKILL_DEV_COMMAND` / `CLAUDE_SKILL_DEV_PORT` も参照しない。これにより、既に外部で起動済みの dev server を検証対象にでき、auto-start による `EADDRINUSE` や誤対象検証を構造的に回避する。手順9 のクリーンアップでは verify が起動したプロセスが無いため停止対象なし。

**`--url` 未指定時（auto-start）**:

1. 環境変数 `CLAUDE_SKILL_DEV_COMMAND` があればそれを使用。なければプロジェクト種別を検出（`package.json`, `Cargo.toml`, `flake.nix` 等）して推定
2. dev サーバーをバックグラウンドで起動
3. ポートの待機: サーバーが応答するまでリトライ（最大 30 秒、3 秒間隔）。環境変数 `CLAUDE_SKILL_DEV_PORT` があればそのポートを使用
4. 対象 URL: `http://localhost:{port}`

#### mode=deploy

優先順位:
1. `--url` 引数で指定された URL
2. 環境変数 `CLAUDE_SKILL_DEPLOY_URL`
3. GitHub Pages: `gh api repos/{owner}/{repo}/pages --jq '.html_url'`（`{owner}/{repo}` は手順2で解決）
4. ユーザーに質問（`--auto` 時は案内して終了）

デプロイ反映待機: URL に対して HTTP GET を最大 5 分間、30 秒間隔でリトライする。最新コミットのデプロイ確認が可能なら（レスポンスヘッダ、バージョン API 等）それも確認する。

認証保護環境（Cloudflare Access / VPN / IAP / SSO 等）では、未認証 HTTP GET が 302（認証リダイレクト）や 401/403 を返すため「デプロイ未反映」と区別できない。以下のいずれかに従うこと（1 回の 302/401/403 で「反映済み」あるいは「未反映」と断定しない。リトライ周期を維持したまま以下の代替に切り替える）:

- 302/401/403 が続いている間はデプロイ未反映と断定せず、手順5 の認証 preflight で認証を確立後に再確認する
- **同一 deployment / preview / staging 環境に紐づく**公開ヘルスチェック URL があれば、reflect-wait の待機対象にしてよい。別環境（本番・公開ミラー等）の health endpoint を待機対象に流用しない。health URL で readiness を確認した後も、最終的な検証対象は手順4の対象 URL のまま
- 認証付き GET が実施可能ならプロジェクト手順に従い認証ヘッダ・cookie を付与する

いずれの場合も、デプロイ反映待機の失敗を理由に対象 URL を別 URL（本番・公開ミラー等）へ暗黙に差し替えてはならない（「対象 URL の authoritative 扱い」参照）。

#### 環境の判定（staging / 本番）

対象 URL が staging か本番かを以下の優先順位で判定する:

1. 環境変数 `CLAUDE_SKILL_PRODUCTION_URL` が定義されている場合、`scheme/host/port/path` を正規化して比較する
   - 末尾 `/` の有無、デフォルトポート（80/443）、host の大文字小文字差は同一とみなす
   - 正規化後に一致すれば本番
   - 判定不能・曖昧な場合は安全側として本番扱いにする（`click` を使わない）
2. **`.pages.dev` ドメインは判定 3 の汎用文字列マッチより先にサブドメインの階層数で判定する**（Cloudflare Pages は production を `<project>.pages.dev`、preview を `<branch-or-hash>.<project>.pages.dev` で配信するため、判定 3 の `dev` 文字列マッチを先に適用すると `<project>.pages.dev` の `dev` 部分文字列にヒットして production を staging と誤判定する）: host が `<project>.pages.dev` の 1 階層のみ（`.` で区切って `pages.dev` の直前セグメントが 1 つだけ）なら本番相当、`<branch-or-hash>.<project>.pages.dev` のように 2 階層以上あれば staging
3. （`.pages.dev` 以外のドメインで）host を `.` で分割したラベルのいずれかが `staging` / `preview` / `dev` / `test` と完全一致する、またはいずれかのラベルが `-staging` で終わる（例: `foo-staging.example.com` の `foo-staging` ラベル）→ staging。**部分文字列一致では判定しない** — `mydevtools.com` や `contest.example.com` のような本番ドメインが `dev` / `test` を部分文字列として含むだけで誤って staging と判定され、production に対して mutating な `click` 操作を許可してしまう事故を防ぐ
4. 上記に該当しない → 本番として扱い、`click` は使用しない

#### 対象 URL の authoritative 扱い

手順4で決定した対象 URL は**検証対象の唯一の真実**として扱う。認証失敗・認可失敗・HTTP エラー等を理由に別 URL（本番・公開ミラー等）へ**暗黙に差し替えない**。対象環境が何らかの認証保護下にある場合は、手順5 の「認証 preflight」に従って認証を確立すること。認証を確立できなければ**該当検証項目のみを**手順8 の blocked 扱いとし、代替 URL で成功したことを検証成功と見なしてはならない（認証不要な検証項目があれば手順8 の方針に従って続行する）。

### 5. 検証の実行

各項目を順に検証する:

**認証 preflight（認証保護環境では必須）**:
- 手順4で選んだ対象 URL が Cloudflare Access / VPN / IAP / SSO 等で認証保護下にある場合（staging・preview・認証保護された本番を含む）、HTTP チェック・UI チェック（Chrome DevTools MCP）を**開始する前に**認証を確立する
- 認証手順はプロジェクトの instructions（`CLAUDE.md`, `AGENTS.md` 等）を参照する。プロジェクトが認証ヘルパー（MCP ツール、cookie 投入手順、Service Token 等）を定義していれば、それを使用する
- 環境変数（`CF_ACCESS_CLIENT_ID` 等）の有無のみで判断して staging を諦めないこと。プロジェクト手順の認証方法が別途存在する場合がある
- 認証を確立できない、または認証手順が見つからない場合は、**当該検証項目のみを**手順8 の `❌ [blocked] 認証必須 → 手動確認が必要` として報告し、検証対象 URL を**差し替えない**。認証不要な検証項目があれば手順8 の方針に従って続行する
- ブラウザ（Chrome DevTools MCP）側の認証と HTTP 用 `curl` に必要な認証が異なる場合、プロジェクト手順に従い同等のヘッダ／トークン／cookie を `curl` 側にも付与すること。片方のみ認証済みで検証するとチェック結果が食い違う
- **HTTP 側で同等認証を再現できない場合**（mTLS クライアント証明書、WebAuthn / device challenge、短命トークンで refresh 不能、rate-limited な token 発行等）は、その HTTP チェックのみ `❌ [blocked]` として扱い、ブラウザで完結する UI チェックは継続する。長時間検証中にトークンが切れる場合は同じ方針で当該項目のみ blocked とする
- **認証情報の露出防止**: トークン・cookie・Service Token 等の秘匿値を `curl` のコマンドライン引数に載せない。`curl -H "Authorization: Bearer $TOKEN"` のように環境変数を展開しても、展開後の全文が `argv` に入り `/proc/<pid>/cmdline` や `ps` から他プロセス・他ユーザーに露出し得る。プロジェクトが提供する認証ヘルパー（argv に秘匿値を載せないラッパー）か、`.claude/tmp/` 配下に `0600` で作成した一時ファイルを `--cookie <file>` / `--netrc-file <file>` / `-K <file>`（curl config ファイル。ヘッダは `header = "Authorization: Bearer ..."` の形式で記述する。`-H` は `@file` によるファイル読み込みをサポートしないため使わない）で渡す形を優先する。環境変数の存在確認は値を表示する `printenv VAR` ではなく `[ -n "${VAR:-}" ] && echo set` のように値を出さない形を使う。検証結果レポート・コマンド引用時は秘匿値を `<redacted>` に置換し、セッション・トランスクリプトへの漏洩を避ける

**HTTP チェック**:
- `curl -s -o /dev/null -w '%{http_code}' -- "{URL}"` でステータスコード確認（URL は必ずクォートする）
- レスポンスボディの内容確認が必要なら `WebFetch` を使用

**UI チェック（Chrome DevTools MCP）**:

**共通注意事項**:
- `navigate_page` では常に `ignoreCache: true` を指定する（Service Worker や CDN キャッシュで古いビルドが返ることがある）
- **スタイル適用の検証手段として**ビルド成果物（JS バンドル）の文字列 `grep` を使わない。minified JS 内のクラス名検索は「文字列が存在する」ことしか示せず、DOM への適用は確認できない。ただしデプロイ到達確認（バージョンマーカーや特定コードの配信確認）としてのバンドル検査はこの制限の対象外
- **デプロイ到達確認でのバンドル検査手順**（Vite 等のコード分割がある場合）: エントリポイント（`index-*.js`）のみを検索すると、遅延ロードされたチャンクにしか含まれないマーカーを取りこぼす。以下の手順でチャンクを列挙してから検索すること:
  1. HTML から `<script>` タグの `src` でエントリポイント JS を特定
  2. エントリポイント内の `__vite__mapDeps` 配列（または同等のチャンクマッピング）からチャンクファイル名一覧を取得
  3. エントリポイント + 全チャンクを対象にマーカーを検索
- UI 変更の検証は user-visible behavior を優先する。手法の優先順位: (1) `take_screenshot` で視覚的変化を確認 (2) `evaluate_script` で DOM 状態を確認（要素の存在・テキスト・構造） (3) CSS プロパティの具体的な値が必要な場合のみ `getComputedStyle()` を補助的に使用

mode=local:
- `navigate_page` で対象ページを開く（初期表示用。SPA 内遷移はリンク/ボタンを `click` で操作すること）
- `take_screenshot` で画面キャプチャ
- `wait_for` で要素の出現を待機
- `evaluate_script` で DOM の状態を確認（必要に応じて `getComputedStyle()` で CSS 値を検証）
- `click` で操作を実行し、状態変化を検証

mode=deploy（staging）:
- `navigate_page` で対象ページを開く（初期表示用。SPA 内遷移はリンク/ボタンを `click` で操作すること）
- `take_screenshot` で画面キャプチャ
- `wait_for` で要素の出現を待機
- `evaluate_script` で DOM の状態を確認（必要に応じて `getComputedStyle()` で CSS 値を検証）
- `click` で操作を実行し、状態変化を検証（staging はテスト環境のため操作可）

mode=deploy（本番）:
- `navigate_page` で対象ページを開く
- `take_screenshot` で画面キャプチャ
- `wait_for` で要素の出現を待機
- `evaluate_script` で DOM の状態を確認（読み取りのみ。必要に応じて `getComputedStyle()` で CSS 値を検証）
- **`click` は使用しない**: 操作を伴う検証項目は「手動確認が必要」とマークする

### 6. 結果レポート

結果レポートの冒頭には以下の固定タグ行を必ず1行出力すること（機械判定用）:

```
VERIFY_REPORT: <PR番号> <mode>
```

**タグ行の厳密なフォーマット**（呼び出し側が確実にパースできるよう以下を守ること。`skip の契約` セクションの制約と同じ）:

- **行頭から開始**する（先頭に空白・インデント・装飾文字を置かない）
- **1回のみ出力**する（検証完了ごとに 1 回だけ）
- **`VERIFY_SKIP:` と相互排他**（検証完了時は `VERIFY_SKIP:` を出さない）
- タグ行の本体（`VERIFY_REPORT: <PR番号> <mode>`）の前後に余計な空白を入れない
- 説明文・サンプル・ヘルプ出力中にリテラル `VERIFY_REPORT:` を出さない（どうしても例示する場合は行頭以外に配置する、あるいは fenced にする）

- `<PR番号>` は数値（例: `42`）。PR 番号が省略されていた場合（mode=local で `git diff` 使用時）は `-` を出力する
- `<mode>` は `local` または `deploy`

続けて人間向けのレポートを出力する:

```
VERIFY_REPORT: 42 deploy
📊 検証結果 (PR #42, mode=deploy, env=staging):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ [UI] /settings「通知設定」セクション → 表示確認済み
✅ [API] GET /api/notifications → 200 OK
✅ [UI] トグル操作 → 状態変化確認済み
⚠️  [manual] DB マイグレーション → 手動確認が必要
❌ [blocked] /notifications 認証必須 → 手動確認が必要
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
結果: 3/5 自動検証済み, 1 件手動確認, 1 件認証エラー
```

この固定タグは手動呼び出し時も含めて常に出力する（ユーザー向けには人間向けレポートが続くのでノイズにはならず、将来 `--output-format=json` 等を追加する際も上位互換を保てる）。

### 7. 手動検証項目の追跡

`--track=github` の場合、結果レポートに `⚠️ [manual]` または `❌ [blocked]` の項目が 1 件以上あれば GitHub Issue を作成する。`--track=none`（デフォルト）の場合はスキップする。

#### Issue の作成

1. `claude session id` でセッション ID を取得する
2. Issue 本文を `.claude/tmp/verify-issue-body-{session_id}.md`（`{session_id}` は手順 1 で取得した値）に Write ツールで書き出す（シェルメタ文字を避けるため heredoc やリダイレクトは使わない。ファイル名にセッション ID を含めるのは、同一 checkout 上で複数セッションが並行して `/verify --track=github` を実行した際に固定ファイル名が race するのを防ぐため。[rules/pr-body.md](../../../rules/pr-body.md) の命名規約に従う）
3. ラベル `verify/manual` の存在を確認する: `gh label list --search "verify/manual" --json name --jq '.[] | select(.name == "verify/manual") | .name'`
4. Issue を作成する:

```bash
gh issue create \
  --title "verify: PR #{PR番号} 手動検証項目" \
  --label "verify/manual" \
  --body-file .claude/tmp/verify-issue-body-{session_id}.md
```

PR 番号が省略されていた場合（mode=local で `git diff` 使用時）はタイトルを `verify: 手動検証項目 ({ブランチ名})` とする。ラベルが存在しない場合は `--label` を省略する。

Issue 作成に失敗した場合（認可・ネットワーク・API 制限等）はエラーを報告し、手動検証項目のチェックリストをチャットに残す。

#### 重複防止

同一 PR・ブランチの既存 Issue は検索しない（重複を許容する運用）。verify の実行ごとに検証結果が異なるため、各 Issue が独立した記録として有用。

#### Issue 本文のフォーマット

```markdown
## 対象

- **PR**: #{PR番号}
- **モード**: {mode}
- **環境**: {env}
- **セッション**: `{session_id}`

## 手動検証項目

- [ ] {項目1の説明}
- [ ] {項目2の説明}
...

## 自動検証結果（参考）

{手順6の結果レポートをそのまま貼付}
```

PR 番号が省略されていた場合（mode=local で `git diff` 使用時）は PR 行を省略する。

Issue 作成後、URL をユーザーに報告する。

### 8. 失敗時の対応

#### 認証エラー・リダイレクト

以下のように認証エラー／認可エラーと判断できる場合:
- 認証が必要なページにアクセスしてログイン画面にリダイレクトされた（サーバー 302/307 または SPA クライアントルーティングによるリダイレクトを含む）
- HTTP ステータスコード 401 / 403 が返却された
- 認証エラー専用ページ（「権限がありません」「再度ログインしてください」等）が表示された

その場合は次のように対応する:
- その検証項目を `❌ [blocked] 認証必須 → 手動確認が必要` として報告する
- ビルド成果物の JS を grep する等の**代替手段にフォールバックしない**。minified JS の検索は UI 検証の代替にはならない
- **検証対象 URL を別 URL（本番・公開ミラー等）に差し替えない**。認証保護された staging での検証失敗を、本番での検証成功で置き換えて「成功」扱いにしてはならない。代替 URL での検証が必要な場合はユーザーに明示確認してから実施する
- 認証不要なページの検証項目があれば、それらは続行する

#### mode=local
- エラー内容を表示し、修正箇所を提案する（自動修正はしない）

#### mode=deploy
- 失敗内容を詳細に報告（HTTP ステータス、スクリーンショット、エラーメッセージ）
- 次のアクションを提案する:
  - 「revert PR を作成しますか？」
  - 「修正 PR を作成しますか？」
- 自動で revert や修正は行わない

### 9. クリーンアップ（mode=local のみ）

**`--url` 指定時（auto-start skip）**: verify が起動した dev server は無いため停止対象・ポート確認対象なし（外部起動の dev server はユーザー管理のため停止しない）。

**`--url` 未指定時（auto-start）**:

- バックグラウンドで起動した dev サーバープロセスを確実に停止する
- ポート占有が残っていないか確認する

## 環境変数（任意）

プロジェクト直下の `.claude/settings.json` または `.claude/settings.local.json` の `env` でデフォルト設定を指定できる:

```json
{
  "env": {
    "CLAUDE_SKILL_DEPLOY_URL": "https://staging.example.com",
    "CLAUDE_SKILL_PRODUCTION_URL": "https://example.com",
    "CLAUDE_SKILL_DEV_COMMAND": "npm run dev",
    "CLAUDE_SKILL_DEV_PORT": "3000",
    "CLAUDE_SKILL_VERIFY_AUTO": "1",
    "CLAUDE_SKILL_VERIFY_TRACK": "github"
  }
}
```

| 環境変数 | 説明 |
|----------|------|
| `CLAUDE_SKILL_DEPLOY_URL` | mode=deploy 時のデフォルト URL |
| `CLAUDE_SKILL_PRODUCTION_URL` | 本番 URL（staging/本番の判定に使用） |
| `CLAUDE_SKILL_DEV_COMMAND` | mode=local 時の dev サーバー起動コマンド |
| `CLAUDE_SKILL_DEV_PORT` | mode=local 時のポート番号（例: `"3000"`） |
| `CLAUDE_SKILL_VERIFY_AUTO` | `--auto` フラグ付き呼び出し時にのみ参照。`1`（完全一致）なら検証を実行、それ以外は案内のみ表示して終了（手動呼び出し時はガードしない） |
| `CLAUDE_SKILL_VERIFY_TRACK` | `--track` のデフォルト値。`github` または `none`。未定義時は `none` |

## トラブルシューティング

| 問題 | 対処 |
|------|------|
| Chrome DevTools に接続できない | ブラウザが起動しているか、MCP サーバーが有効か確認 |
| dev サーバーが起動しない | `CLAUDE_SKILL_DEV_COMMAND` の設定を確認。手動で起動してから `--url` で指定 |
| デプロイが反映されていない | 待機時間を延長するか、デプロイ完了を確認してから再実行 |
| 検証項目が不正確 | チェックリスト提示時に手動で項目を編集する |
