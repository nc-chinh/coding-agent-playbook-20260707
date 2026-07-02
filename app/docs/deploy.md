# デプロイ手順書（AWS / CDK）

この MVP を AWS に deploy する手順。構成（S3+CloudFront / ECS Fargate internal ALB / VPC Origin）は
[design.md §10](design.md) 参照。CDK CLI は **`npx aws-cdk`**（`infra` の devDependency を解決するので追加 install 不要）で叩く。

## 前提

| 必要なもの | 備考 |
|---|---|
| AWS アカウント + deploy 権限 | VPC / ECS / ALB / S3 / CloudFront / IAM / Secrets Manager / ECR を作る |
| Node.js **22.12+** | ルートで `npm install` 済み |
| **Docker 起動中** | CDK が `apps/api`・`apps/mock` の image を build → ECR push するため deploy 中に必須 |
| AWS CLI v2 | SSO ログインに使う |

## 1. 認証（AWS SSO）

```bash
aws configure sso                    # 初回のみ: start URL / region / account / role を選び profile を作る
aws sso login --profile <profile>    # セッションごと（期限切れたら都度）
export AWS_PROFILE=<profile>
export AWS_REGION=ap-northeast-1      # infra/bin/app.ts の既定リージョンも ap-northeast-1
aws sts get-caller-identity          # 通れば認証 OK
```

PowerShell の場合の env 設定:

```powershell
$env:AWS_PROFILE = "<profile>"
$env:AWS_REGION  = "ap-northeast-1"
```

`AWS_PROFILE` を渡せば CDK が STS で account / region を自動解決する（`CDK_DEFAULT_ACCOUNT` を手で設定しなくてよい）。

## 2. bootstrap（account × region に一度だけ）

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx aws-cdk bootstrap aws://$ACCOUNT/$AWS_REGION
```

PowerShell:

```powershell
$ACCOUNT = aws sts get-caller-identity --query Account --output text
npx aws-cdk bootstrap "aws://$ACCOUNT/$env:AWS_REGION"
```

## 3. build → deploy

CDK の `BucketDeployment` が `apps/web/dist` を参照するので、**先に web を build** してから deploy する。

```bash
npm run build --workspace @diag/web   # apps/web/dist を生成
cd infra
npx aws-cdk deploy                    # image build → ECR push → CFn deploy
```

deploy 完了後、出力 `CdnUrl`（`https://<id>.cloudfront.net`）をブラウザで開いて動作確認する。CloudFront の配信反映に数分かかることがある。

## 4. 外部連携先の切替（任意）

既定では backend は内部 mock service を叩く。実 API に向ける場合は deploy 時に上書きする（[stack.ts](../infra/lib/stack.ts) の seam）:

```bash
npx aws-cdk deploy -c externalBaseUrl=https://real-api.example.com
# もしくは env: EXTERNAL_BASE_URL=https://real-api.example.com npx aws-cdk deploy
```

## 5. 差分確認 / 再 deploy

```bash
cd infra && npx aws-cdk diff          # 既存 stack との差分
# コード変更後は 3 の手順（web build → deploy）を再実行すれば更新される
```

## 6. 後片付け（teardown）

**deploy したリソースは常時課金される**（NAT Gateway / ALB × 2 / Fargate task × 3 / CloudFront）。確認が済んだら必ず壊す:

```bash
cd infra
npx aws-cdk destroy
```

S3 site bucket は `autoDeleteObjects` 付きなので destroy で中身ごと消える。

> `destroy` で消えるのはこのアプリ stack だけ。手順 2 の bootstrap stack（`CDKToolkit`）と、その asset 置き場の S3 / ECR は残る（再 deploy 時に再利用するため通常は残してよい）。完全に片付けるなら、**同じ account×region の他 CDK stack で使っていないことを確認**した上で `CDKToolkit` stack と asset bucket / ECR repo を手動削除する。

## トラブルシューティング

- **`Unable to resolve AWS account` / 認証エラー**: `aws sso login` の期限切れ。再ログインして `aws sts get-caller-identity` で確認。
- **deploy 中に Docker のエラー**: Docker daemon が起動しているか確認（image build に必須）。
- **`This stack uses assets, so the toolkit stack must be deployed`**: bootstrap 未実施。手順 2 を実行。
- **`CdnUrl` を開くと 403/404 が出る**: 反映待ちのことが多い。数分置いて再読込。継続するなら `apps/web/dist` を build してから再 deploy。
