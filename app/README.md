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

## デプロイ（AWS / CDK）

[docs/design.md §10](docs/design.md) の構成（S3+CloudFront / ECS Fargate internal ALB / VPC Origin）。
**認証（SSO）・bootstrap・teardown まで含む手順は [docs/deploy.md](docs/deploy.md)**。

クイック実行（先に `apps/web/dist` を build して `BucketDeployment` に渡す）:

```bash
npm run build --workspace @diag/web   # apps/web/dist を生成
cd infra && npx aws-cdk deploy        # 要 AWS 認証情報・CDK bootstrap
```

> デモのため SMS・スマートメーター・市場価格・契約・申込はすべて mock。実 API への切替は backend の `EXTERNAL_BASE_URL` を差し替えるだけ（本番境界の seam）。
