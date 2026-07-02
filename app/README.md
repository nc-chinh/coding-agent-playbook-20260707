# ワンタップ実データ診断 MVP

電力データ活用制度のスマートメーター30分値を、**SMS認証 + データ提供同意だけ**で取得し、市場連動プランの料金診断（過去12ヶ月バックテスト）を提示するフルスタック MVP。

- 企画: [one-pager.md](one-pager.md)
- 設計: [docs/design.md](docs/design.md)（本実装はこれに準拠）

## 構成（monorepo / npm workspaces）

```
apps/
  web/    Vite + React + TS の SPA（useReducer 状態機械 + Recharts）
  api/    Hono backend（BFF + 診断エンジン呼び出し + 外部連携アダプタ + 署名トークン）
  mock/   Hono mock サーバ（協会 power-data / SMS / JEPX を擬似 + 決定的サンプルデータ）
packages/
  core/   共有: ドメイン型 + Zod 契約 + 診断エンジン（純TS）+ プラン定数
infra/    AWS CDK（ECS Fargate + internal ALB + S3 + CloudFront）
```

データの流れ: ブラウザ → backend API（診断計算）→ 外部連携アダプタ → mock（or 実 API）。frontend は計算を持たず API を叩く。型は Hono RPC（`hc<AppType>`）で backend → frontend に共有。

## 必要環境

- Node.js **22.12+**（LTS）

## ローカル開発

```bash
npm install

# 3 つ（mock / api / web）をまとめて起動
npm run dev
# → web:  http://localhost:3000
#   api:  http://localhost:8788（Vite が /api を proxy）
#   mock: http://localhost:8787
```

`123456` を SMS 認証コードに入力するとデモが進む（[docs/design.md §7](docs/design.md)）。

### コンテナで動かす（mock + api）

```bash
docker compose up --build      # mock:8787 / api:8788
npm run dev:web                # web は Vite で別途
```

## テスト / 型検査 / ビルド

```bash
npm test           # 診断エンジンの単体テスト（packages/core）
npm run typecheck  # 全 workspace の型検査
npm run build      # web の本番ビルド（apps/web/dist）
```

## 環境変数

api（`apps/api`）が読む実行時設定。ローカル開発はすべて既定のまま動く。本番（`NODE_ENV=production`）では `TOKEN_SECRET` だけは必須で、未設定だと api が起動時に fail-fast する。

| 変数 | 既定 | 説明 | 必須/任意 |
|------|------|------|-----------|
| `TOKEN_SECRET` | dev 用の固定値 | 署名トークン（HMAC/JWT）の鍵。ローカルでは dev 値に fallback するが、`NODE_ENV=production` では必須（未設定なら起動失敗） | 本番のみ必須 |
| `SUBJECT_PEPPER` | `TOKEN_SECRET` の値 | 電話番号を HMAC 化する際の pepper。未設定なら `TOKEN_SECRET` を流用 | 任意 |
| `EXTERNAL_BASE_URL` | `http://localhost:8787`（mock） | 外部連携アダプタの接続先 base URL。本番は実 API に差し替える | 任意 |
| `EXTERNAL_TIMEOUT_MS` | `8000` | 上流呼び出しのアプリ側 deadline（ミリ秒） | 任意 |
| `API_PORT` | `8788` | api の listen ポート | 任意 |
| `NODE_ENV` | （未設定） | `production` で `TOKEN_SECRET` 未設定時の fail-fast を有効化 | 任意 |

## デプロイ（AWS / CDK）

[docs/design.md §10](docs/design.md) の構成（S3+CloudFront / ECS Fargate internal ALB / VPC Origin）。

**リポジトリルートから**実行する（web ビルド → CDK の順で走り、`apps/web/dist` を S3 に同梱する）:

```bash
npm run synth      # web build → CloudFormation テンプレート生成
npm run deploy     # web build → deploy（要 AWS 認証情報・CDK bootstrap）
```

> `cd infra` で直接 `cdk` を叩く場合は、先に `npm run build --workspace @diag/web` で `apps/web/dist` を生成しておくこと（CDK の `BucketDeployment` が synth 時にこのパスを参照するため）。

> デモのため SMS・スマートメーター・市場価格・契約・申込はすべて mock。実 API への切替は backend の `EXTERNAL_BASE_URL` を差し替えるだけ（本番境界の seam）。
